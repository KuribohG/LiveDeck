import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {terminalName} from '../web/src/model.js';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const output=path.resolve(root,'../live-deck-ai-streaming-20261019');fs.mkdirSync(output,{recursive:true});
const server=JSON.parse(fs.readFileSync(process.env.LIVE_DECK_SERVER_INFO));
const base=process.env.LIVE_DECK_TEST_BASE_URL || `http://127.0.0.1:${server.port}${server.base_url}`;
const headers=server.token ? {Authorization:`token ${server.token}`} : {};
const browser=await chromium.launch({headless:true,executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1280,height:800}});
await context.route('**/*',route=>route.continue({headers:{...route.request().headers(),...(new URL(route.request().url()).origin===new URL(base).origin ? headers : {})}}));
const page=await context.newPage(),checks={},errors=[];let deck,kernel;
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/custom/live-deck/monitoring.json',async route=>{
  const response=await route.fetch({headers:{...route.request().headers(),...headers}});
  deck=await response.json();deck.id+=`-ai-stream-${Date.now()}`;await route.fulfill({json:deck});
});
async function viewport(selector){const box=await page.locator(selector).boundingBox();assert.ok(Math.abs(box.x)<1&&Math.abs(box.y)<1&&Math.abs(box.width-1280)<1&&Math.abs(box.height-800)<1,JSON.stringify(box));}
try {
  await page.goto(`${base}custom/live-deck/index.html?deck=monitoring#/1`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.liveDeck?.pool.sessions.get('runner')?.status==='ready',null,{timeout:45000});
  await page.locator('#command-input').fill('echo STREAM_VISIBLE_7319');await page.locator('#fill-command').click();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.liveDeck.pool.history('runner').includes('STREAM_VISIBLE_7319'));
  await page.evaluate(()=>{window.frameBefore=window.liveDeck.pool.sessions.get('runner').frame;window.shellBefore=window.liveDeck.pool.sessions.get('runner').terminal;});
  await page.locator('[data-panel-id="runner"] .panel-zoom').click();await viewport('[data-panel-id="runner"]');
  const inner=await page.locator('[data-panel-id="runner"] .panel-viewport').boundingBox();assert.ok(inner.height>740);
  await page.keyboard.press('ArrowRight');assert.match(await page.locator('#slide-counter').textContent(),/02/);
  await page.screenshot({path:path.join(output,'terminal-fullscreen.png')});
  await page.locator('[data-panel-id="runner"] .panel-zoom').click();
  assert.ok((await page.locator('[data-panel-id="runner"]').boundingBox()).height<650);
  assert.equal(await page.evaluate(()=>window.frameBefore===window.liveDeck.pool.sessions.get('runner').frame&&window.shellBefore===window.liveDeck.pool.sessions.get('runner').terminal),true);
  checks.terminalViewportFullscreenPreservesSession=true;
  await page.evaluate(()=>{window.chartBefore=window.liveDeck.workspace.cards.get('latency').frame;});
  await page.locator('[data-panel-id="latency"] .panel-zoom').click();await viewport('[data-panel-id="latency"]');
  await page.locator('[data-panel-id="latency"] .panel-zoom').click();
  assert.equal(await page.evaluate(()=>window.chartBefore===window.liveDeck.workspace.cards.get('latency').frame),true);checks.chartViewportFullscreenPreservesFrame=true;
  await page.locator('#fullscreen-ai').click();await viewport('#ai-panel');
  await page.evaluate(()=>{
    const ask=window.liveDeck.advisor.ask.bind(window.liveDeck.advisor);window.streamEvents=[];window.uiSamples=[];
    window.liveDeck.advisor.ask=(ctx,onEvent)=>ask(ctx,e=>{window.streamEvents.push({type:e.type,source:e.source,size:(e.delta||e.text||e.answer||'').length,at:performance.now()});onEvent(e);});
    window.sampleTimer=setInterval(()=>{const r=window.liveDeck.store.terminal('runner').conversation.at(-1);if(r?.pending){const item=document.querySelector('.ai-message.assistant:last-child');window.uiSamples.push({summary:item?.querySelector('.ai-summary-text')?.textContent.length||0,answer:item?.querySelector('.ai-answer')?.textContent.length||0});}},15);
  });
  await page.locator('#ai-question').fill('从终端输出确认标识 STREAM_VISIBLE_7319，解释已知证据与局限，用三小段回答，并建议一条打印该标识的命令。不要执行。');
  await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>window.liveDeck.store.terminal('runner').conversation.at(-1)?.pending===false,null,{timeout:195000});
  await page.waitForFunction(()=>!document.querySelector('.ai-message.assistant:last-child .ai-stream-status')?.textContent || document.querySelector('.ai-message.assistant:last-child .ai-stream-status')?.hidden);
  const result=await page.evaluate(()=>{clearInterval(window.sampleTimer);return {reply:window.liveDeck.store.terminal('runner').conversation.at(-1),events:window.streamEvents,samples:window.uiSamples};});
  assert.ok(!result.reply.error,result.reply.error);assert.match(result.reply.text,/STREAM_VISIBLE_7319/);assert.ok(result.reply.summary);
  const deltas=result.events.filter(e=>e.type==='answer_delta');assert.ok(deltas.length>2,JSON.stringify(result.events));
  assert.ok(deltas[0].at<result.events.find(e=>e.type==='answer').at);
  assert.ok(result.samples.some(s=>s.summary>0));assert.ok(result.samples.some(s=>s.answer>0));
  assert.ok(!result.reply.text.trim().startsWith('{'));checks.realModelStreamsIntoBrowser=true;
  checks.summarySource=result.reply.summarySource;
  const before=await page.evaluate(()=>window.liveDeck.pool.history('runner'));
  await page.locator('.ai-message.assistant .suggestion button').last().click();
  assert.equal(await page.evaluate(()=>window.liveDeck.pool.history('runner')),before);checks.adoptOnlyFillsComposer=true;
  await page.locator('.ai-message.assistant .ai-summary summary').last().click();
  await page.screenshot({path:path.join(output,'ai-fullscreen.png')});
  await page.locator('#fullscreen-ai').click();
  assert.ok((await page.locator('#ai-panel').boundingBox()).height<400);checks.aiViewportFullscreen=true;
  await page.evaluate(()=>{
    window.liveDeck.advisor.ask=async(ctx,emit)=>{
      emit({type:'reasoning_summary',text:'公开摘要 <script>window.bad=1</script>',source:'answer-summary'});
      emit({type:'answer_delta',delta:'已收到的部分回答'});
      await new Promise(resolve=>setTimeout(resolve,180));
      throw new Error('测试连接中断');
    };
  });
  await page.locator('#ai-question').fill('测试中断保留');await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>window.liveDeck.store.terminal('runner').conversation.at(-1)?.error==='测试连接中断');
  const partial=await page.evaluate(()=>window.liveDeck.store.terminal('runner').conversation.at(-1));
  assert.equal(partial.text,'已收到的部分回答');assert.ok(partial.summary);assert.equal(await page.evaluate(()=>window.bad),undefined);checks.interruptionPreservesPartialOutput=true;
  kernel=await page.evaluate(()=>localStorage.getItem(window.liveDeck.advisor.key));
  await page.screenshot({path:path.join(output,'streaming-workspace.png')});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'browser-result.json'),JSON.stringify({passed:true,checks,events:result.events,uiSamples:result.samples.filter(s=>s.summary||s.answer)},null,2));
  console.log(JSON.stringify({passed:true,checks}));
}catch(error){console.error(error.stack,errors);await page.screenshot({path:path.join(output,'browser-failure.png')});process.exitCode=1;}
finally{
  kernel ||= await page.evaluate(()=>window.liveDeck&&localStorage.getItem(window.liveDeck.advisor.key)).catch(()=>null);
  await browser.close();
  if(deck)for(const id of Object.keys(deck.terminals))await fetch(`http://127.0.0.1:${server.port}${server.base_url}api/terminals/${terminalName(deck.id,id)}`,{method:'DELETE',headers});
  if(kernel)await fetch(`http://127.0.0.1:${server.port}${server.base_url}api/kernels/${kernel}`,{method:'DELETE',headers});
}
