import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {terminalName} from '../web/src/model.js';

const output = process.env.LIVE_DECK_TEST_ARTIFACTS;
assert.ok(output, 'Set LIVE_DECK_TEST_ARTIFACTS to a private artifact directory');
fs.mkdirSync(output,{recursive:true});
const server = JSON.parse(fs.readFileSync(process.env.LIVE_DECK_SERVER_INFO));
const base = `http://127.0.0.1:${server.port}${server.base_url}`;
const pagePath = process.env.LIVE_DECK_TEST_PAGE || 'custom/live-deck/index.html';
const headers = server.token ? {Authorization:`token ${server.token}`} : {};
const deck = {
  id:`reset-terminals-${Date.now()}`, title:'Reset terminals check',
  terminals:{
    runner:{label:'Runner',cwd:output,tabs:{main:{label:'Main'},other:{label:'Other'},cold:{label:'Cold'}},commands:[{id:'probe',title:'Probe',command:'pwd'}]},
    hidden:{label:'Hidden',cwd:output,commands:[]}
  },
  slides:[{type:'workspace',title:'Runner',panels:['runner']},{type:'workspace',title:'Hidden',panels:['hidden']}],
  sequence:[{panel:'runner',command:'probe'}]
};
const fixed = ['runner','runner:other','runner:cold','hidden'];
const temporary = ['runner:tab-2','hidden:tab-2'];
const all = [...fixed,...temporary];
const foreignName = terminalName(deck.id+'-unrelated','guard');
const browser = await chromium.launch({headless:true,executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
const context = await browser.newContext({viewport:{width:1440,height:900},extraHTTPHeaders:headers});
const page = await context.newPage(), checks = {}, errors = [], deletes = [];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(request.method()==='DELETE' && request.url().includes('/api/terminals/')) deletes.push(request.url().split('/').at(-1));});
await page.route('**/deck.json',route=>route.fulfill({json:deck}));
let counter=0;
const sessionKey = (id,tab) => tab==='main' ? id : `${id}:${tab}`;
async function ready(key) {
  await page.waitForFunction(key=>window.liveDeck?.pool.sessions.get(key)?.status==='ready' && !window.liveDeck.pool.restarting.has(key),key,{timeout:45000});
}
async function activate(id,tab='main') {
  await page.evaluate(({id,tab})=>window.liveDeck.workspace.activateTab(id,tab),{id,tab});
  await ready(sessionKey(id,tab));
}
async function send(key,text) {
  await ready(key);
  await page.evaluate(({key,text})=>{
    window.liveDeck.pool.fill(key,text);
    window.liveDeck.pool.sessions.get(key).terminal.socket.send(JSON.stringify(['stdin','\r']));
  },{key,text});
}
async function probe(key) {
  const marker=`RESET_PROBE_${++counter}`;
  await send(key,`printf '${marker}=%s|%s|%s\\n' "$$" "${'${RESET_KEEP-unset}'}" "$PWD"`);
  await page.waitForFunction(({key,marker})=>new RegExp(`${marker}=\\d+\\|`).test(window.liveDeck.pool.history(key)),{key,marker});
  const text=await page.evaluate(key=>window.liveDeck.pool.history(key),key);
  const match=text.match(new RegExp(`${marker}=(\\d+)\\|([^|\\n]+)\\|([^\\n]+)`));
  return {pid:Number(match[1]),value:match[2],cwd:match[3].trim()};
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function exited(pid) {
  for(let i=0;i<100&&alive(pid);i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(alive(pid),false,`old process ${pid} must exit`);
}
async function addTemporary(id) {
  await page.locator(`[data-panel-id="${id}"] .terminal-tab-add`).click();
  await page.locator('#terminal-tab-name').fill(id+' scratch');
  await page.locator('#save-terminal-tab').click();
  await ready(id+':tab-2');
}
async function goto(index) {
  await page.evaluate(index=>window.liveDeck.goTo(index),index);
  await page.waitForURL(new RegExp(`#/(?:${index}|page-${index+1}${index===0?'|':''})$`));
}
async function reset() {
  if(await page.locator('body').evaluate(el=>el.classList.contains('top-toolbar-hidden'))) await page.locator('#toggle-top-toolbar').click();
  await page.locator('#reset-progress').click();
  await page.waitForFunction(()=>!document.querySelector('#reset-progress').disabled,{},{timeout:90000});
}
try {
  await page.goto(base+pagePath+'#/0',{waitUntil:'domcontentloaded'}); await ready('runner');
  await activate('runner','other');
  await addTemporary('runner');
  await goto(1); await ready('hidden'); await addTemporary('hidden');
  const old={};
  for(const key of all.filter(key=>key!=='runner:cold')) {
    await send(key,'export RESET_KEEP=old-session; cd /');
    old[key]=await probe(key); assert.ok(alive(old[key].pid));
  }
  await send('runner:tab-2',`python3 -c 'import os,time; print("RESET_CHILD=%s" % os.getpid(),flush=True); time.sleep(300)'`);
  await page.waitForFunction(()=>/RESET_CHILD=\d+/.test(window.liveDeck.pool.history('runner:tab-2')));
  const child=await page.evaluate(()=>Number(window.liveDeck.pool.history('runner:tab-2').match(/RESET_CHILD=(\d+)/)[1]));
  await page.evaluate(async foreignName=>{
    await window.liveDeck.client.request('api/terminals',{method:'POST',body:{name:foreignName}});
    const {store,runs,sequence}=window.liveDeck;
    for(const key of window.liveDeck.pool.sessions.keys()) runs.manual(key,{test:'old'},Date.now());
    sequence.state.cursor=1;sequence.state.completed=[0];
    store.terminal('runner').completed=[0];store.terminal('runner').draft='old draft';
    store.terminal('runner').conversation=[{role:'user',text:'keep conversation'}];store.save();
  },foreignName);
  // Reload without visiting the hidden page: server sessions still need to be reset.
  await goto(0); await page.reload({waitUntil:'domcontentloaded'}); await ready('runner:tab-2');
  assert.deepEqual(await page.evaluate(()=>[...window.liveDeck.pool.sessions.keys()]),['runner:tab-2']);
  checks.oldSessionsPersistWithoutLocalFrames = true;

  const failedNames = new Set(['runner','hidden:tab-2'].map(key=>terminalName(deck.id,key)));
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const intercept=async route=>{
    const request=route.request();
    if(request.method()==='DELETE') {
      await gate;
      if(failedNames.has(request.url().split('/').at(-1))) return route.fulfill({status:503,json:{message:'intentional reset test'}});
    }
    return route.continue();
  };
  await page.route('**/api/terminals/*',intercept);
  await page.locator('#toggle-top-toolbar').click();
  await page.locator('#reset-progress').click();
  await page.waitForFunction(()=>window.liveDeck.workspace.resetting && document.querySelector('#terminal-viewport').inert);
  await page.evaluate(async()=>{
    const {workspace}=window.liveDeck;
    if(workspace.resetTerminals()!==workspace.resetting) throw new Error('reset not deduplicated');
    document.querySelector('#reset-progress').onclick();
    let blocked=false;
    try{await workspace.fill('runner','tab-2','touch unwanted');}catch(error){blocked=error.code==='TERMINAL_CLOSING';}
    if(!blocked)throw new Error('fill allowed during reset');
  });
  release();
  await page.waitForFunction(()=>!document.querySelector('#reset-progress').disabled,{},{timeout:90000});
  await page.unroute('**/api/terminals/*',intercept);
  assert.equal(deletes.length,all.length);
  assert.deepEqual([...deletes].sort(),all.map(key=>terminalName(deck.id,key)).sort());
  assert.match(await page.locator('#toast').textContent(),/2 个终端处理失败/);
  assert.equal(await page.evaluate(()=>window.liveDeck.sequence.state.cursor),0);
  assert.equal(await page.evaluate(()=>window.liveDeck.workspace.isTabClosed('runner','tab-2')),true);
  assert.equal(await page.evaluate(()=>window.liveDeck.workspace.isTabClosed('hidden','tab-2')),false);
  assert.ok(alive(old.runner.pid));assert.ok(alive(old['hidden:tab-2'].pid));
  await exited(old['runner:tab-2'].pid);await exited(child);
  for(const key of ['runner:other','hidden']) await exited(old[key].pid);
  for(const key of ['runner:other','runner:cold','hidden']) {
    const fresh=await probe(key);assert.equal(fresh.value,'unset');assert.equal(fresh.cwd,output);
  }
  checks.hiddenAndUnvisitedFixedTabsRestarted = true;
  checks.temporaryShellAndForegroundProcessExited = true;
  checks.partialFailureIsReportedAndOtherTabsFinish = true;
  checks.noDuplicateResetOrFillWhileBusy = true;

  // Retry also handles the failed fixed tab, which has no local frame yet.
  const beforeRetry=deletes.length;
  await reset();
  assert.equal(deletes.length-beforeRetry,all.length);
  for(const entry of Object.values(old)) await exited(entry.pid);
  for(const key of fixed) {
    const fresh=await probe(key);assert.equal(fresh.value,'unset');assert.equal(fresh.cwd,output);
  }
  assert.deepEqual(await page.evaluate(()=>[...window.liveDeck.pool.sessions.keys()].sort()),[...fixed].sort());
  for(const id of ['runner','hidden']) {
    assert.equal(await page.evaluate(id=>window.liveDeck.workspace.activeTab(id),id),'main');
    assert.equal(await page.evaluate(id=>window.liveDeck.workspace.isTabClosed(id,'tab-2'),id),true);
    assert.equal(await page.locator(`[data-panel-id="${id}"] .terminal-tab[data-tab-id="tab-2"]`).count(),0);
  }
  assert.equal(await page.evaluate(()=>Object.keys(window.liveDeck.store.data.runs).length),0);
  assert.deepEqual(await page.evaluate(()=>window.liveDeck.store.terminal('runner').completed),[]);
  assert.equal(await page.evaluate(()=>window.liveDeck.store.terminal('runner').conversation[0].text),'keep conversation');
  assert.equal(await page.evaluate(()=>Reveal.getIndices().h),0);
  assert.equal(await page.evaluate(()=>document.querySelector('#terminal-viewport').inert),false);
  await page.evaluate(foreignName=>window.liveDeck.client.request('api/terminals/'+foreignName),foreignName);
  checks.retryLeavesOnlyFreshFixedSessions = true;
  checks.progressResetConversationAndUnrelatedTerminalPreserved = true;
  const finalMain=await probe('runner');
  await page.reload({waitUntil:'domcontentloaded'});await ready('runner');
  assert.deepEqual(await probe('runner'),finalMain);
  assert.equal(await page.evaluate(()=>window.liveDeck.workspace.isTabClosed('runner','tab-2')),true);
  checks.reloadRetainsResetResult = true;
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'reset-terminals.png')});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));
  console.log(JSON.stringify({passed:true,checks}));
} catch(error) {
  await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,checks,errors,error:String(error.stack),url:page.url()},null,2));
  console.error(error.stack);process.exitCode=1;
} finally {
  await browser.close();
  for(const name of [...all.map(key=>terminalName(deck.id,key)),foreignName]) {
    const response=await fetch(base+'api/terminals/'+name,{method:'DELETE',headers});
    assert.ok(response.ok||response.status===404,`test cleanup: ${response.status}`);
  }
}
