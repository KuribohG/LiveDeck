import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const web = path.resolve(process.env.LIVE_DECK_TEST_WEB_ROOT || path.join(root, 'web'));
const overrides = process.env.LIVE_DECK_TEST_WEB_OVERRIDES;
const output = process.env.LIVE_DECK_TEST_ARTIFACTS;
assert.ok(output, 'Set LIVE_DECK_TEST_ARTIFACTS to a private results directory');
fs.mkdirSync(output, {recursive:true});
const base = 'http://127.0.0.1:18739/custom/live-deck/';
const chart = id => new URL(`https://live-deck-chart.invalid/${id}`).href;
const dashboard = label => ({label, url:chart(label), commands:[]});
const fixture = {
  format:'live-deck', version:1, id:'ai-adoption-regression', title:'采用后保留 AI 对话', terminals:{},
  dashboards:{origin:dashboard('原提问面板'), latency:dashboard('延迟面板'), network:dashboard('网络面板'), remote:dashboard('另一页图表')},
  monitorGroups:{first:{label:'性能', panels:['latency']}, second:{label:'网络', panels:['network']}},
  slides:[
    {type:'workspace', title:'原页面', panels:['origin'], monitorGroups:['first','second']},
    {type:'workspace', title:'另一页', panels:['remote']},
  ],
};
const browser = await chromium.launch({headless:true, executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE,
  args:['--no-sandbox','--disable-dev-shm-usage']});
const errors=[], apiRequests=[], checks={};
let page;
async function open() {
  const context = await browser.newContext({viewport:{width:1280,height:800}});
  const tab = await context.newPage();
  tab.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.includes('/api/')) { apiRequests.push({method:request.method(), path:url.pathname}); return route.abort(); }
    if (url.origin === 'https://live-deck-chart.invalid') return route.fulfill({contentType:'text/html', body:'<!doctype html><meta charset="utf-8"><p>测试图表</p>'});
    if (!url.href.startsWith(base)) return route.abort();
    const relative = decodeURIComponent(url.pathname.slice(new URL(base).pathname.length));
    if (relative === 'deck.json') return route.fulfill({json:fixture});
    if (relative === 'deployment.json') return route.fulfill({json:{jupyterBaseUrl:'/', advisorPath:'/unused'}});
    const file = overrides && fs.existsSync(path.join(overrides, relative)) ? path.join(overrides, relative) : path.join(web, relative);
    const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json'};
    return route.fulfill({path:file, contentType:types[path.extname(file)] || 'application/octet-stream'});
  });
  await tab.goto(base+'index.html#/0', {waitUntil:'domcontentloaded'});
  await tab.waitForFunction(() => window.liveDeck?.workspace.cards.get('origin'));
  await tab.locator('#toggle-ai').click();
  await tab.evaluate(() => {
    window.requests=[];
    window.liveDeck.store.terminal('latency').conversation=[{id:'target-existing-message',role:'user', text:'TARGET_CHAT_MUST_STAY_SEPARATE'}];
    window.liveDeck.store.save();
    window.liveDeck.advisor.ask=async(context,emit)=>{
      window.requests.push(structuredClone(context));
      if (window.streamNext) {
        window.streamNext=false;
        emit({type:'answer_delta', delta:'正在继续原对话'});
        await new Promise(resolve=>window.finishReply=resolve);
      }
      emit({type:'answer',summary:'原对话的分析摘要',answer:'原面板回答\n\n'+Array.from({length:12},(_,i)=>`段落 ${i}：继续沿着原对话分析。`).join('\n\n'),
        commands:['latency','origin','network','remote'].map(panel=>({title:panel,panel,command:`https://live-deck-chart.invalid/new-${panel}`,note:'只填入链接'}))});
    };
  });
  return tab;
}
async function ask(question='把延迟图换成并发图') {
  await page.locator('#ai-question').fill(question); await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>!document.querySelector('#ask-ai').disabled);
}
function adopt(panel) { return page.locator('.suggestion').filter({has:page.locator('code', {hasText:`/new-${panel}`})}).last().locator('button'); }
async function current() {
  return page.evaluate(()=>({
    focus:document.querySelector('#session-label').textContent,
    chat:document.querySelector('#ai-conversation-label')?.textContent,
    messages:document.querySelector('#ai-messages').textContent,
    fullscreen:document.querySelector('#ai-panel').classList.contains('ai-fullscreen'),
    original:structuredClone(window.liveDeck.store.terminal('origin').conversation),
    target:structuredClone(window.liveDeck.store.terminal('latency').conversation),
    draft:document.querySelector('#command-input').value,
  }));
}
try {
  page = await open();
  await ask();
  await page.locator('.ai-message.assistant .ai-summary summary').click();
  await adopt('latency').scrollIntoViewIfNeeded();
  await page.evaluate(()=>{
    window.originalRow=document.querySelector('.ai-message.assistant');
    window.readingPosition=document.querySelector('#ai-messages').scrollTop;
  });
  const before=await current();
  await adopt('latency').click();
  const adopted=await current();
  assert.equal(adopted.messages,before.messages);
  assert.equal(adopted.chat,'对话：原提问面板');
  assert.equal(adopted.focus,'延迟面板');
  assert.equal(adopted.draft,chart('new-latency'));
  assert.deepEqual(adopted.target,before.target);
  assert.equal(await page.evaluate(()=>document.querySelector('.ai-message.assistant')===window.originalRow),true);
  assert.equal(await page.locator('.ai-message.assistant .ai-summary').getAttribute('open'),'');
  assert.ok(await page.evaluate(()=>Math.abs(document.querySelector('#ai-messages').scrollTop-window.readingPosition)<2));
  assert.equal(await page.locator('[data-panel-id="latency"] iframe').getAttribute('src'),chart('延迟面板'));
  checks.crossPanelKeepsConversationSummaryAndReadingPosition=true;
  checks.adoptionOnlyFillsDraft=true;
  await page.locator('#show-context').click();
  assert.equal(JSON.parse(await page.locator('#context-text').textContent()).conversation_panel,'origin');
  await page.locator('#close-context').click();
  await ask('接着刚才的分析继续');
  const followup=await page.evaluate(()=>window.requests.at(-1));
  assert.equal(followup.terminal,'origin');
  assert.equal(followup.conversation.length,2);
  assert.match(followup.conversation[1].text,/原面板回答/);
  assert.ok(!JSON.stringify(followup.conversation).includes('TARGET_CHAT_MUST_STAY_SEPARATE'));
  checks.followupUsesOriginalConversationAndPanel=true;
  await page.screenshot({path:path.join(output,'adopted-conversation.png')});
  const sameBefore=await current(); await adopt('origin').click();
  assert.equal((await current()).messages,sameBefore.messages);
  checks.samePanelKeepsConversation=true;
  await page.locator('#fullscreen-ai').click();
  await adopt('network').click();
  assert.equal(await page.locator('#monitor-group').inputValue(),'second');
  assert.equal((await current()).fullscreen,true);
  assert.equal((await current()).chat,'对话：原提问面板');
  await adopt('remote').click();
  await page.waitForFunction(()=>window.liveDeck.workspace.visible.includes('remote'));
  assert.equal((await current()).fullscreen,true);
  assert.equal((await current()).chat,'对话：原提问面板');
  assert.equal((await current()).messages,sameBefore.messages);
  await page.screenshot({path:path.join(output,'adopted-cross-slide-fullscreen.png')});
  checks.groupsAndSlidesPreserveFullscreenAndConversation=true;
  await page.locator('#fullscreen-ai').click();
  await page.locator('#new-ai-session').click();
  assert.equal((await current()).original.length,0);
  assert.deepEqual((await current()).target,before.target);
  assert.equal((await current()).chat,'对话：原提问面板');
  checks.newConversationClearsDisplayedChatOnly=true;
  await page.context().close();

  page=await open(); await ask();
  await page.evaluate(()=>window.streamNext=true);
  await page.locator('#ai-question').fill('流式继续原对话');await page.locator('#ask-ai').click();
  await page.waitForFunction(()=>typeof window.finishReply==='function');
  await adopt('latency').click();
  assert.match((await current()).messages,/正在继续原对话/);
  await page.evaluate(()=>window.finishReply());
  await page.waitForFunction(()=>!document.querySelector('#ask-ai').disabled);
  assert.equal((await current()).original.length,4);
  assert.equal((await current()).original.at(-1).pending,false);
  assert.equal((await current()).chat,'对话：原提问面板');
  checks.adoptionDuringStreamingKeepsReply=true;
  await page.locator('[data-panel-id="latency"] .panel-select').click();
  assert.equal((await current()).chat,'对话：延迟面板');
  assert.match((await current()).messages,/TARGET_CHAT_MUST_STAY_SEPARATE/);
  assert.doesNotMatch((await current()).messages,/原面板回答/);
  await page.locator('[data-panel-id="origin"] .panel-select').click();
  assert.match((await current()).messages,/原面板回答/);
  checks.manualSelectionStillSwitchesChats=true;
  const saved=await current();
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.liveDeck);
  assert.deepEqual((await current()).original,saved.original);
  assert.deepEqual((await current()).target,saved.target);
  checks.reloadPreservesSeparateHistories=true;
  assert.deepEqual(errors,[]);assert.deepEqual(apiRequests,[]);
  const result={passed:true,checks,errors,apiRequests};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  console.error(error.stack,errors);process.exitCode=1;
} finally {await browser.close();}
