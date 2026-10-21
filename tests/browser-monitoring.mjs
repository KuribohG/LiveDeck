import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {terminalName} from '../web/src/model.js';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const results=process.env.LIVE_DECK_TEST_ARTIFACTS || path.resolve(root,'../live-deck-monitoring-tests-20261019');
fs.mkdirSync(results,{recursive:true});
const server=JSON.parse(fs.readFileSync(process.env.LIVE_DECK_SERVER_INFO));
const base=process.env.LIVE_DECK_TEST_BASE_URL || `http://127.0.0.1:${server.port}${server.base_url}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.route('**/*',route=>route.continue({headers:{...route.request().headers(),...(new URL(route.request().url()).origin===new URL(base).origin && server.token ? {Authorization:`token ${server.token}`} : {})}}));
const page=await context.newPage(), errors=[], checks={};
page.on('pageerror',e=>errors.push(e.message));
const dashboard=(label,uid,panel,field='instance',terminal='runner')=>({label,url:`https://monitor-test.invalid/d-solo/${uid}/metrics?panelId=${panel}`,binding:{terminal,params:{'var-host':field,'var-task_id':'task_id'},lookbackMs:30000,refresh:'5s'},commands:[{id:'open',title:'查看图表',command:`https://monitor-test.invalid/d-solo/${uid}/metrics?panelId=${panel}`}]});
const deck={format:'live-deck',version:1,id:`monitor-browser-${Date.now()}`,title:'监控联动测试',terminals:{runner:{label:'运行终端',cwd:results,commands:[{id:'run',title:'启动任务',command:'echo example'}]},other:{label:'独立终端',cwd:results,commands:[]}},dashboards:{throughput:dashboard('吞吐量','service',1),latency:dashboard('P99 延迟','service',2),network:dashboard('网卡带宽','host',9),independent:dashboard('独立任务','host',10,'instance','other')},monitorGroups:{performance:{label:'性能',panels:['throughput','latency']},system:{label:'系统',panels:['network','independent']}},slides:[{type:'workspace',title:'边运行边观察',panels:['runner'],monitorGroups:['performance','system'],layout:'focus'},{type:'slide',title:'解释结果',markdown:'任务持续运行'},{type:'workspace',title:'独立运行',panels:['other'],monitorGroups:['system'],layout:'focus'}],sequence:[{panel:'runner',command:'run'},{group:'system'},{panel:'latency',command:'open'}]};
await page.route('**/custom/live-deck/monitoring.json',route=>route.fulfill({json:deck}));
let loads=0;
await context.route('https://monitor-test.invalid/**',route=>{loads++;return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>body{background:#17212e;color:#b7f5ca;font:12px monospace;padding:12px;word-break:break-all}</style><h2>URL 参数测试接收端</h2><p>此页面验证联动，不代表真实 Grafana 数据。</p><pre></pre><script>document.querySelector("pre").textContent=JSON.stringify(Object.fromEntries(new URL(location.href).searchParams),null,2)</script>'});});
const shell=text=>"'"+text.replaceAll("'","'\\''")+"'";
const helper=path.join(root,'backend/run_context.py');
async function type(id,text){await page.evaluate(id=>window.liveDeck.selectPanel(id),id);await page.locator('#command-input').fill(text);await page.locator('#fill-command').click();await page.keyboard.press('Enter');}
async function stop(id){await page.evaluate(id=>window.liveDeck.pool.sessions.get(id).terminal.socket.send(JSON.stringify(['stdin','\x03'])),id);}
// The composer accepts single-line Shell commands; pass Python code via an escaped string.
async function launch(id,instance,task){
  const code=`import subprocess,sys,time,os; subprocess.run([sys.executable,${JSON.stringify(helper)},'publish','--event','ready','--set',${JSON.stringify('task_id='+task)}],check=True); print('ACTUAL_PID='+str(os.getpid()),flush=True); exec('for i in range(90): print("LIVE_TICK_"+str(i),flush=True); time.sleep(1)')`;
  await type(id,`python3 ${shell(helper)} run --set ${shell('instance='+instance)} -- python3 -u -c ${shell(code)}`);
}
const src=id=>page.locator(`[data-panel-id="${id}"] iframe`).getAttribute('src');
try {
  await page.goto(`${base}custom/live-deck/index.html?deck=monitoring#/0`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.liveDeck?.pool.sessions.get('runner')?.status==='ready',null,{timeout:45000});
  assert.equal(await page.locator('.workspace-card.visible').count(),3);
  assert.match(await page.locator('[data-panel-id="throughput"] .chart-pending').textContent(),/task_id/);
  await launch('runner','node & 一','task?42');
  await page.waitForFunction(()=>window.liveDeck.runs.get('runner')?.status==='ready',null,{timeout:12000});
  const first=new URL(await src('throughput'));
  assert.equal(first.searchParams.get('var-host'),'node & 一');assert.equal(first.searchParams.get('var-task_id'),'task?42');
  assert.equal(first.searchParams.get('from'),String((await page.evaluate(()=>window.liveDeck.runs.get('runner').started_at_ms))-30000));
  assert.equal(new URL(await src('latency')).searchParams.get('var-task_id'),'task?42');
  assert.equal(await page.evaluate(()=>window.liveDeck.sequence.state.cursor),0);
  checks.inFlightAndEncoded=true;
  await page.evaluate(()=>{window.runnerIdentity=window.liveDeck.pool.sessions.get('runner').terminal;window.chartIdentity=document.querySelector('[data-panel-id="throughput"] iframe');});
  const loadedBefore=loads;
  await page.locator('[data-panel-id="throughput"] .panel-zoom').click();
  assert.equal(await page.locator('[data-panel-id="throughput"]').evaluate(e=>e.getBoundingClientRect().width>1000),true);
  await page.locator('[data-panel-id="throughput"] .panel-zoom').click();
  assert.equal(loads,loadedBefore);checks.zoomDoesNotReload=true;
  await page.locator('#monitor-group').selectOption('system');
  assert.equal(new URL(await src('network')).searchParams.get('var-task_id'),'task?42');
  assert.equal(await page.locator('[data-panel-id="independent"] .chart-pending').isVisible(),true);
  await page.evaluate(()=>window.liveDeck.goTo(1));
  await page.waitForTimeout(1500);
  await page.evaluate(()=>window.liveDeck.goTo(0));
  assert.equal(await page.evaluate(()=>window.runnerIdentity===window.liveDeck.pool.sessions.get('runner').terminal),true);
  await page.locator('#monitor-group').selectOption('performance');
  assert.equal(await page.evaluate(()=>window.chartIdentity===document.querySelector('[data-panel-id="throughput"] iframe')),true);
  checks.groupsAndSlidesPreserveTerminal=true;
  await page.locator('#pause-monitors').click(); const frozen=await src('throughput');
  await stop('runner');await page.waitForFunction(()=>window.liveDeck.runs.get('runner').status==='finished');
  await launch('runner','node-b','task-next');
  await page.waitForFunction(()=>window.liveDeck.runs.get('runner')?.fields.task_id==='task-next');
  assert.equal(await src('throughput'),frozen);
  await page.locator('#follow-monitors').click();
  assert.equal(new URL(await src('throughput')).searchParams.get('var-host'),'node-b');
  checks.pauseResume=true;
  await page.locator('#monitor-time').click();await page.locator('#monitor-from').fill('1000');await page.locator('#monitor-to').fill('2000');await page.locator('#apply-time').click();
  const historical=new URL(await src('throughput'));assert.equal(historical.searchParams.get('from'),'1000');assert.equal(historical.searchParams.has('refresh'),false);
  await page.locator('#follow-monitors').click();checks.timeRange=true;
  await page.locator('#sequence-complete').click();
  assert.equal(await page.locator('#monitor-group').inputValue(),'system');
  await page.locator('#sequence-complete').click();
  assert.equal(await page.locator('#monitor-group').inputValue(),'performance');
  assert.match(await page.locator('#session-label').textContent(),/P99/);checks.sequenceSelectsGroup=true;
  await page.evaluate(()=>window.liveDeck.goTo(2));
  await page.waitForFunction(()=>window.liveDeck.pool.sessions.get('other')?.status==='ready');
  await launch('other','separate-host','separate-task');
  await page.waitForFunction(()=>window.liveDeck.runs.get('other')?.status==='ready');
  assert.equal(new URL(await src('network')).searchParams.get('var-host'),'node-b');
  assert.equal(new URL(await src('independent')).searchParams.get('var-host'),'separate-host');checks.independentContext=true;
  await page.evaluate(()=>window.liveDeck.goTo(0));
  await page.waitForFunction(()=>['#/0','#/page-1','#/',''].includes(location.hash));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.liveDeck?.pool.sessions.get('runner')?.status==='ready',null,{timeout:45000});
  assert.equal(new URL(await src('throughput')).searchParams.get('var-task_id'),'task-next');
  assert.equal(await page.evaluate(()=>window.liveDeck.runs.get('runner').status),'ready');checks.reloadKeepsBinding=true;
  await page.locator('[data-panel-id="runner"] .edit-run').click();
  await page.locator('#run-fields').fill(JSON.stringify({instance:'manual-host',task_id:'manual-task'}));await page.locator('#save-run').click();
  assert.equal(new URL(await src('throughput')).searchParams.get('var-host'),'manual-host');checks.manualMetadata=true;
  await page.screenshot({path:path.join(results,'monitoring-1440.png')});
  await page.setViewportSize({width:1280,height:800});await page.screenshot({path:path.join(results,'monitoring-1280.png')});
  const sizes=await page.locator('.workspace-card.visible .panel-viewport').evaluateAll(items=>items.map(e=>({w:e.clientWidth,h:e.clientHeight})));
  assert.ok(sizes.every(x=>x.w>250&&x.h>90),JSON.stringify(sizes));checks.layout=true;
  await page.evaluate(()=>{
    const edited=structuredClone(window.liveDeck.deck);
    const url=new URL(edited.dashboards.throughput.url);url.searchParams.set('panelId','99');
    edited.dashboards.throughput.url=url.href;
    localStorage.setItem('live-deck:monitoring',JSON.stringify(edited));
  });
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.liveDeck?.pool.sessions.get('runner')?.status==='ready',null,{timeout:45000});
  assert.equal(new URL(await src('throughput')).searchParams.get('panelId'),'99');
  assert.equal(new URL(await src('throughput')).searchParams.get('var-host'),'manual-host');checks.editedConfigOverridesSavedUrl=true;
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(results,'browser-result.json'),JSON.stringify({passed:true,checks},null,2));
  console.log(JSON.stringify({passed:true,checks}));
} catch(error) {
  console.error(error.stack);console.error('BROWSER_ERRORS',JSON.stringify(errors));
  console.error('STATE',await page.evaluate(()=>window.liveDeck && {runs:window.liveDeck.store.data.runs,sessions:[...window.liveDeck.pool.sessions].map(([id,s])=>({id,status:s.status,error:String(s.error)})),toast:document.getElementById('toast').textContent}));
  await page.screenshot({path:path.join(results,'failure.png')});process.exitCode=1;
} finally {
  await browser.close();
  const headers=server.token ? {Authorization:`token ${server.token}`} : {};
  for (const id of Object.keys(deck.terminals)) await fetch(`http://127.0.0.1:${server.port}${server.base_url}api/terminals/${terminalName(deck.id,id)}`,{method:'DELETE',headers});
}
