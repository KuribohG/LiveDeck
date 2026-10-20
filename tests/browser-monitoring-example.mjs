import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {terminalName} from '../web/src/model.js';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const output=process.env.LIVE_DECK_TEST_ARTIFACTS || path.join(root,'artifacts');
fs.mkdirSync(output,{recursive:true});
const server=JSON.parse(fs.readFileSync(process.env.LIVE_DECK_SERVER_INFO));
const base=process.env.LIVE_DECK_TEST_BASE_URL || `http://127.0.0.1:${server.port}${server.base_url}`;
const headers=server.token ? {Authorization:`token ${server.token}`} : {};
const browser=await chromium.launch({headless:true,executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1280,height:800}});
await context.route('**/*',route=>route.continue({headers:{...route.request().headers(),...(new URL(route.request().url()).origin===new URL(base).origin ? headers : {})}}));
const page=await context.newPage(), errors=[], decks=[], checks={};
page.on('pageerror',e=>errors.push(e.message));
// Load the real served examples, changing only IDs to isolate test terminal sessions.
for(const file of ['monitoring.json','deck.json']) await page.route(`**/custom/live-deck/${file}`,async route=>{
  const response=await route.fetch({headers:{...route.request().headers(),...headers}});
  assert.ok(response.ok());const deck=await response.json();deck.id+=`-example-test-${Date.now()}`;decks.push(deck);
  await route.fulfill({json:deck});
});
const type=async (id,text)=>{
  await page.evaluate(id=>window.liveDeck.selectPanel(id),id);
  await page.locator('#command-input').fill(text);await page.locator('#fill-command').click();await page.waitForFunction(()=>!document.getElementById('fill-command').disabled);await page.keyboard.press('Enter');
};
try {
  await page.goto(`${base}custom/live-deck/index.html?deck=monitoring#/1`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.liveDeck?.pool.sessions.get('runner')?.status==='ready',null,{timeout:45000});
  await page.locator('#fill-command').click();await page.waitForFunction(()=>!document.getElementById('fill-command').disabled);await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.liveDeck.runs.get('runner')?.status==='ready',null,{timeout:15000});
  const run=await page.evaluate(()=>window.liveDeck.runs.get('runner'));
  assert.match(run.fields.task_id,/^demo-\d+$/);assert.ok(run.fields.instance);
  await page.waitForFunction(()=>document.querySelector('[data-panel-id="latency"] iframe')?.contentDocument?.querySelector('#fields')?.textContent.includes('demo-'));
  await page.locator('#monitor-group').selectOption('system');
  await page.waitForFunction(()=>document.querySelector('[data-panel-id="network"] iframe')?.contentDocument?.querySelector('#fields')?.textContent.includes('var-host'));
  checks.realProcessAndPreview=true;
  await page.locator('#monitor-group').selectOption('business');
  await page.screenshot({path:path.join(output,'public-example-1280.png')});
  await page.locator('#toggle-ai').click();
  await page.evaluate(()=>{window.liveDeck.advisor.ask=async(ctx,emit)=>{window.capturedContext=ctx;emit({type:'answer',answer:'上下文已捕获用于测试',commands:[]});};});
  await page.locator('#ai-question').fill('当前运行与下一监控组是什么？');await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>window.capturedContext);
  const sent=await page.evaluate(()=>window.capturedContext);
  assert.equal(sent.panels.find(p=>p.id==='runner').run.fields.task_id,run.fields.task_id);
  assert.ok(sent.sequence.upcoming.some(s=>s.group==='business'));checks.aiRequestIncludesRunsAndGroups=true;
  await page.evaluate(()=>window.liveDeck.pool.sessions.get('runner').terminal.socket.send(JSON.stringify(['stdin','\x03'])));
  await page.waitForFunction(()=>window.liveDeck.runs.get('runner').status==='finished');
  assert.equal(await page.evaluate(()=>window.liveDeck.runs.get('runner').exit_code),130);checks.interruptReported=true;
  await page.goto(`${base}custom/live-deck/docs/index.html?doc=monitoring`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#document h1')?.textContent==='运行上下文与多图监控');
  checks.publicDocs=true;
  await page.goto(`${base}custom/live-deck/index.html#/1`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.liveDeck?.pool.sessions.get('terminal-1')?.status==='ready',null,{timeout:45000});
  await type('terminal-1','export MONITORING_REGRESSION=shared_ok; echo CHECK=$MONITORING_REGRESSION');
  await page.waitForFunction(()=>window.liveDeck.pool.history('terminal-1').includes('CHECK=shared_ok'));
  await page.evaluate(()=>{window.terminalBefore=window.liveDeck.pool.sessions.get('terminal-1').terminal;window.liveDeck.goTo(3);});
  assert.equal(await page.evaluate(()=>window.terminalBefore===window.liveDeck.pool.sessions.get('terminal-1').terminal),true);
  await page.evaluate(()=>window.liveDeck.goTo(4));
  await page.waitForFunction(()=>window.liveDeck.pool.sessions.get('terminal-2')?.status==='ready');
  await type('terminal-2','echo OTHER=${MONITORING_REGRESSION-unset}');
  await page.waitForFunction(()=>window.liveDeck.pool.history('terminal-2').includes('OTHER=unset'));checks.legacySharedAndIndependentShells=true;
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'public-example-result.json'),JSON.stringify({passed:true,checks},null,2));
  console.log(JSON.stringify({passed:true,checks}));
} catch(error) {
  console.error(error.stack, errors);await page.screenshot({path:path.join(output,'public-example-failure.png')});process.exitCode=1;
} finally {
  await browser.close();
  for(const deck of decks)for(const id of Object.keys(deck.terminals))await fetch(`http://127.0.0.1:${server.port}${server.base_url}api/terminals/${terminalName(deck.id,id)}`,{method:'DELETE',headers});
}
