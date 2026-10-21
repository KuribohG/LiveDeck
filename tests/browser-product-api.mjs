import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {terminalName} from '../web/src/model.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const results = process.env.LIVE_DECK_TEST_ARTIFACTS || path.resolve(root, '../live-deck-product-api-tests-20261021');
fs.mkdirSync(results, {recursive:true});
const server = JSON.parse(fs.readFileSync(process.env.LIVE_DECK_SERVER_INFO));
const base = process.env.LIVE_DECK_TEST_BASE_URL || `http://127.0.0.1:${server.port}${server.base_url}`;
const deck = {
  format:'live-deck',
  version:1,
  id:`product-api-browser-${Date.now()}`,
  title:'产品接口浏览器测试',
  terminals:{
    runner:{
      label:'运行终端',
      commands:[{id:'run',title:'启动',command:'echo example',note:'不会自动执行'}],
    },
  },
  dashboards:{
    latency:{
      label:'延迟',
      commands:[],
      binding:{terminal:'runner',params:{}},
      chart:{type:'timeseries',metric:'fuse-read-latency',datasource:'ds',database:'hf3fs_hg',comparisonField:'comparison_runs'},
    },
  },
  slides:[
    {type:'slide',title:'产品接口',markdown:'浏览器侧状态与结构化修改验证。'},
    {type:'workspace',title:'观察',panels:['runner','latency']},
  ],
  sequence:[{panel:'runner',command:'run'}],
};
const browser = await chromium.launch({headless:true,executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
const context = await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
await context.route('**/*', route => route.continue({headers:{...route.request().headers(),...(new URL(route.request().url()).origin === new URL(base).origin && server.token ? {Authorization:`token ${server.token}`} : {})}}));
await context.route('**/custom/live-deck/monitoring.json', route => route.fulfill({json:deck}));
const page = await context.newPage(), errors = [], checks = {};
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`${base}custom/live-deck/index.html?deck=monitoring#/0`, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.liveDeck?.productApi?.version === 1, null, {timeout:45000});
  const snapshot = await page.evaluate(() => window.liveDeck.productApi.inspect());
  assert.equal(snapshot.deck.id, deck.id);
  assert.equal(snapshot.deck.configSource, 'published');
  assert.equal(snapshot.view.slideIndex, 0);
  assert.ok(snapshot.panels.find(panel => panel.id === 'latency').metricDefinition);
  checks.inspect = true;

  const preview = await page.evaluate(() => window.liveDeck.productApi.preview({
    type:'chart.set',
    target:'latency',
    patch:{metric:'fuse-read-rate',stepSeconds:5},
  }));
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.affectedPanels, ['latency']);
  assert.equal(preview.diff.find(change => change.path.endsWith('/metric')).after, 'fuse-read-rate');
  assert.equal(await page.evaluate(() => window.liveDeck.deck.dashboards.latency.chart.metric), 'fuse-read-latency');
  checks.preview = true;

  const applied = await page.evaluate(revision => window.liveDeck.productApi.apply({
    expectedRevision:revision,
    operation:{type:'chart.set',target:'latency',patch:{metric:'fuse-read-rate',stepSeconds:5}},
  }), snapshot.deck.effectiveRevision);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.validation.valid, true);
  assert.equal(await page.evaluate(() => window.liveDeck.deck.dashboards.latency.chart.metric), 'fuse-read-rate');
  checks.apply = true;

  const undone = await page.evaluate(token => window.liveDeck.productApi.undo(token), applied.undoToken);
  assert.equal(undone.status, 'undone');
  assert.equal(await page.evaluate(() => window.liveDeck.deck.dashboards.latency.chart.metric), 'fuse-read-latency');
  checks.undo = true;

  const draft = await page.evaluate(() => window.liveDeck.productApi.apply({
    operation:{type:'terminal.prepare',target:'runner',tab:'main',text:'fio --name=read --rw=read'},
  }));
  assert.equal(draft.status, 'applied');
  assert.equal(draft.runtimeOperation.type, 'draft.prepare');
  await page.evaluate(() => window.liveDeck.selectPanel('runner'));
  assert.equal(await page.locator('#command-input').inputValue(), 'fio --name=read --rw=read');
  checks.draft = true;

  await page.locator('#toggle-top-toolbar').click();
  await page.locator('#copy-state').click();
  await page.waitForFunction(() => /状态已复制|状态文本/.test(document.getElementById('toast').textContent));
  const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => document.getElementById('context-text').textContent));
  assert.match(copied, /"effectiveRevision"/);
  checks.copyState = true;

  assert.deepEqual(errors, []);
  await page.screenshot({path:path.join(results, 'product-api.png'),fullPage:true});
  fs.writeFileSync(path.join(results, 'browser-result.json'), JSON.stringify({passed:true,checks}, null, 2));
  console.log(JSON.stringify({passed:true,checks}));
} catch (error) {
  console.error(error.stack);
  console.error('BROWSER_ERRORS', JSON.stringify(errors));
  await page.screenshot({path:path.join(results, 'failure.png'),fullPage:true});
  process.exitCode = 1;
} finally {
  await browser.close();
  const headers = server.token ? {Authorization:`token ${server.token}`} : {};
  for (const id of Object.keys(deck.terminals)) await fetch(`http://127.0.0.1:${server.port}${server.base_url}api/terminals/${terminalName(deck.id, id)}`, {method:'DELETE',headers});
}
