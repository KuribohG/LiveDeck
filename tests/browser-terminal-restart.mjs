import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {terminalName} from '../web/src/model.js';

const output = process.env.LIVE_DECK_TEST_ARTIFACTS;
assert.ok(output, 'Set LIVE_DECK_TEST_ARTIFACTS to a private artifact directory');
fs.mkdirSync(output, {recursive:true});
const server = JSON.parse(fs.readFileSync(process.env.LIVE_DECK_SERVER_INFO));
const base = `http://127.0.0.1:${server.port}${server.base_url}`;
const pagePath = process.env.LIVE_DECK_TEST_PAGE || 'custom/live-deck/index.html';
const headers = server.token ? {Authorization:`token ${server.token}`} : {};
const deck = {
  id:`terminal-restart-${Date.now()}`, title:'Terminal lifecycle check',
  terminals:{runner:{label:'Terminal', cwd:output, tabs:{main:{label:'Main'}, other:{label:'Other'}},
    commands:[{id:'probe', title:'Probe', command:'pwd', tab:'main'}]}},
  slides:[{type:'workspace',title:'Terminals',panels:['runner']},{type:'slide',title:'Slide',markdown:'Return keeps sessions'}],
  sequence:[{panel:'runner',command:'probe',tab:'main'}]
};
const browser = await chromium.launch({headless:true, executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE,
  args:['--no-sandbox','--disable-dev-shm-usage']});
const context = await browser.newContext({viewport:{width:1440,height:900},extraHTTPHeaders:headers});
const page = await context.newPage(), checks = {}, errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.url().includes('/api/terminals')) requests.push({method:request.method(),url:request.url()}); });
await page.route('**/deck.json', route => route.fulfill({json:deck}));
const key = tab => tab === 'main' ? 'runner' : `runner:${tab}`;
let probeIndex = 0;
async function activate(tab) {
  await page.evaluate(tab => window.liveDeck.workspace.activateTab('runner',tab),tab);
  await ready(tab);
}
async function ready(tab) {
  await page.waitForFunction(id => {
    const pool = window.liveDeck?.pool;
    return pool?.sessions.get(id)?.status === 'ready' && !pool.restarting.has(id);
  },key(tab),{timeout:45000});
}
async function command(tab,text) {
  await activate(tab);
  await page.evaluate(({id,text}) => {
    window.liveDeck.pool.fill(id,text);
    window.liveDeck.pool.sessions.get(id).terminal.socket.send(JSON.stringify(['stdin','\r']));
  },{id:key(tab),text});
}
async function probe(tab) {
  const marker = `LD_PROBE_${++probeIndex}`;
  await command(tab,`printf '${marker}=%s|%s|%s\\n' "$$" "${'${LD_KEEP-unset}'}" "$PWD"`);
  await page.waitForFunction(({id,marker}) => new RegExp(`${marker}=\\d+\\|`).test(window.liveDeck.pool.history(id)),{id:key(tab),marker});
  const history = await page.evaluate(id => window.liveDeck.pool.history(id),key(tab));
  const match = history.match(new RegExp(`${marker}=(\\d+)\\|([^|\\n]+)\\|([^\\n]+)`));
  return {pid:Number(match[1]),value:match[2],cwd:match[3].trim()};
}
const alive = pid => { try { process.kill(pid,0); return true; } catch(error) { if(error.code === 'ESRCH') return false; throw error; } };
async function exited(pid) {
  for(let i=0;i<100 && alive(pid);i++) await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(alive(pid),false,`old process ${pid} must exit`);
}
const restart = page.locator('[data-panel-id="runner"] .panel-restart');
const reconnect = page.locator('[data-panel-id="runner"] .panel-reconnect');
try {
  await page.goto(base+pagePath+'#/0',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.liveDeck);
  await ready('main');
  assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('bottom-toolbar-hidden')),true);
  assert.equal(await page.locator('.terminal-tab-close').count(),0);
  await command('main','export LD_KEEP=old-main');
  const initial = await probe('main');
  assert.ok(alive(initial.pid));
  await reconnect.click(); await ready('main');
  assert.deepEqual(await probe('main'),initial);
  checks.reconnectPreservesShell = true;
  await command('other','export LD_KEEP=other-kept');
  const other = await probe('other');
  await command('main',`cd /; python3 -c 'import os,time; print("LD_CHILD=%s" % os.getpid(), flush=True); time.sleep(300)'`);
  await page.waitForFunction(()=>/LD_CHILD=\d+/.test(window.liveDeck.pool.history('runner')));
  const child = await page.evaluate(()=>Number(window.liveDeck.pool.history('runner').match(/LD_CHILD=(\d+)/)[1]));
  assert.ok(alive(child));
  await page.evaluate(()=>{
    const {runs,store} = window.liveDeck;
    runs.manual('runner',{test:'old'},Date.now());
    runs.manual('runner:other',{test:'other'},Date.now());
    store.terminal('runner').completed=[0]; store.save();
  });
  const beforeRestartRequests = requests.length;
  await restart.click(); await ready('main');
  await exited(initial.pid); await exited(child);
  assert.equal(await page.evaluate(()=>window.liveDeck.pool.history('runner').includes('LD_CHILD=')),false);
  const fresh = await probe('main');
  assert.notEqual(fresh.pid,initial.pid); assert.equal(fresh.value,'unset'); assert.equal(fresh.cwd,output);
  assert.equal(await page.evaluate(()=>window.liveDeck.runs.get('runner')),undefined);
  assert.equal(await page.evaluate(()=>window.liveDeck.runs.get('runner:other').fields.test),'other');
  assert.deepEqual(await page.evaluate(()=>window.liveDeck.store.terminal('runner').completed),[0]);
  const replacements = requests.slice(beforeRestartRequests).filter(r=>['DELETE','POST'].includes(r.method));
  assert.deepEqual(replacements.map(r=>r.method),['DELETE','POST']);
  assert.deepEqual(await probe('other'),other);
  checks.restartReplacesShellAndForegroundProcess = true;
  checks.clearsOutputVariablesAndRuntimeRestoresCwd = true;
  checks.otherTabAndPlanPreserved = true;

  // A failed deletion must leave the original server session, frame, and variables intact.
  await command('main','export LD_KEEP=delete-failure');
  const failureOriginal = await probe('main'), failedStart = requests.length;
  const terminalUrl = base+`api/terminals/${terminalName(deck.id,'runner')}`;
  const failDelete = route => route.request().method() === 'DELETE'
    ? route.fulfill({status:503,json:{message:'intentional lifecycle test'}}) : route.continue();
  await page.route(terminalUrl,failDelete);
  await restart.click();
  await page.waitForFunction(()=>!window.liveDeck.pool.restarting.has('runner'));
  await page.waitForFunction(()=>!document.querySelector('.panel-restart').disabled);
  assert.equal(requests.slice(failedStart).filter(r=>r.method==='POST').length,0);
  assert.deepEqual(await probe('main'),failureOriginal);
  await page.unroute(terminalUrl,failDelete);
  checks.failedDeleteKeepsOldSessionAndAllowsRetry = true;

  // Hold deletion while changing tabs: no duplicate restart, fill, or close is allowed.
  let releaseDelete;
  const deleteGate = new Promise(resolve=>{releaseDelete=resolve;});
  const holdDelete = async route => { if(route.request().method()==='DELETE') await deleteGate; await route.continue(); };
  await page.route(terminalUrl,holdDelete);
  const raceStart = requests.length;
  await restart.click();
  await page.waitForFunction(()=>window.liveDeck.pool.sessions.get('runner').closing);
  assert.equal(await restart.isDisabled(),true);
  assert.equal(await reconnect.isDisabled(),true);
  await page.evaluate(async()=>{
    const pool = window.liveDeck.pool, pending = pool.restarting.get('runner');
    if(pool.restart('runner') !== pending) throw new Error('restart not deduplicated');
    for(const attempt of [()=>pool.fill('runner','touch unwanted'),()=>pool.close('runner'),()=>pool.reconnect('runner'),()=>window.liveDeck.workspace.activateTab('runner','main')]) {
      let blocked=false;
      try { await attempt(); } catch(error) { if(error.code !== 'TERMINAL_CLOSING') throw error; blocked=true; }
      if(!blocked) throw new Error('operation allowed during restart');
    }
  });
  await activate('other');
  assert.equal(await restart.isEnabled(),true);
  releaseDelete(); await ready('main');
  await page.unroute(terminalUrl,holdDelete);
  assert.equal(await page.evaluate(()=>window.liveDeck.workspace.activeTab('runner')),'other');
  assert.deepEqual(await probe('other'),other);
  assert.equal(await page.locator('iframe.terminal-frame.active').count(),1);
  assert.equal(await page.locator('iframe.terminal-frame.active').getAttribute('data-terminal-id'),'runner:other');
  assert.deepEqual(requests.slice(raceStart).filter(r=>['DELETE','POST'].includes(r.method)).map(r=>r.method),['DELETE','POST']);
  await exited(failureOriginal.pid);
  checks.switchTabAndRepeatedClicksAreIsolated = true;

  await command('main','export LD_KEEP=after-restart');
  const beforeReload = await probe('main');
  await page.evaluate(()=>window.liveDeck.goTo(1));
  await page.waitForURL(/#\/(?:1|page-2)$/);
  await page.evaluate(()=>window.liveDeck.goTo(0));
  await page.waitForURL(/#\/(?:0|page-1)?$/);
  assert.deepEqual(await probe('main'),beforeReload);
  await page.reload({waitUntil:'domcontentloaded'}); await ready('main');
  assert.deepEqual(await probe('main'),beforeReload);
  assert.deepEqual(await probe('other'),other);
  checks.reloadAndSlidesKeepNewSessions = true;
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'terminal-restart.png')});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));
  console.log(JSON.stringify({passed:true,checks}));
} catch(error) {
  await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,checks,errors,error:String(error.stack)},null,2));
  console.error(error.stack); process.exitCode=1;
} finally {
  await browser.close();
  for(const tab of ['main','other']) {
    const response = await fetch(base+`api/terminals/${terminalName(deck.id,key(tab))}`,{method:'DELETE',headers});
    assert.ok(response.ok || response.status === 404,`test terminal cleanup: ${response.status}`);
  }
}
