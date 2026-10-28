import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const webRoot = path.join(root, 'web');
const results = process.env.LIVE_DECK_TEST_ARTIFACTS || path.resolve(root, '../live-deck-studio-tests-20261021');
fs.mkdirSync(results, {recursive:true});

const mime = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
};
const server = http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const requested = pathname === '/' ? '/studio.html' : pathname;
  if (requested === '/deployment.json') {
    response.writeHead(200, {'content-type':'application/json; charset=utf-8'});
    response.end(JSON.stringify({storageScope:'deck', jupyterBaseUrl:'/'}));
    return;
  }
  const file = path.resolve(webRoot, `.${requested}`);
  if (!file.startsWith(`${webRoot}${path.sep}`)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await fs.promises.readFile(file);
    response.writeHead(200, {'content-type':mime[path.extname(file)] || 'application/octet-stream'});
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const executablePath = process.env.LIVE_DECK_BROWSER_EXECUTABLE;
const browser = await chromium.launch({
  headless:true,
  ...(executablePath ? {executablePath} : {}),
  args:['--no-sandbox','--disable-dev-shm-usage'],
});
const context = await browser.newContext({viewport:{width:1500,height:980}, permissions:['clipboard-read','clipboard-write']});
const page = await context.newPage();
const errors = [], checks = {};
page.on('pageerror', error => errors.push(error.stack || error.message));

try {
  await page.goto(`${base}/studio.html`, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.liveDeckStudio?.deck?.slides?.length > 0, null, {timeout:15000});
  assert.equal(await page.locator('.page-item').count(), await page.evaluate(() => window.liveDeckStudio.deck.slides.length));
  await page.waitForFunction(() => document.querySelector('#preview-loading')?.hidden === true, null, {timeout:15000});
  const preview = page.frameLocator('#player-preview');
  const previewTitle = preview.locator('[data-studio-field="title"]').first();
  await previewTitle.waitFor({state:'visible'});
  const originalTitle = await previewTitle.textContent();
  await previewTitle.click();
  await page.locator('#inline-editor').waitFor({state:'visible'});
  await page.locator('#inline-editor-input').fill('播放器画布原位编辑');
  await page.waitForFunction(() => window.liveDeckStudio.deck.slides[0].title === '播放器画布原位编辑');
  assert.equal(await previewTitle.textContent(), '播放器画布原位编辑');
  assert.equal(await page.locator('[data-pointer="/slides/0/title"]').inputValue(), '播放器画布原位编辑');
  await page.screenshot({path:path.join(results, 'inline-editor.png')});
  await page.locator('#inline-editor-done').click();
  assert.notEqual(originalTitle, '播放器画布原位编辑');
  await previewTitle.click();
  await page.locator('#inline-editor-input').fill('这次修改应当取消');
  await page.locator('#inline-editor-cancel').click();
  await page.waitForFunction(() => window.liveDeckStudio.deck.slides[0].title === '播放器画布原位编辑');
  await page.waitForFunction(() => document.querySelector('#player-preview').contentDocument
    .querySelector('#page-1 [data-studio-field="title"]')?.textContent === '播放器画布原位编辑');
  await preview.locator('#page-1 .slide-markdown').click();
  await page.locator('#inline-editor-input').fill('## 实时 Markdown\n\n修改后立即渲染。');
  await page.waitForFunction(() => window.liveDeckStudio.deck.slides[0].markdown.includes('实时 Markdown'));
  assert.match(await preview.locator('#page-1 .slide-markdown').innerText(), /修改后立即渲染/);
  await page.locator('#inline-editor-done').click();
  await page.locator('.page-item').nth(1).locator('.page-select').click();
  await preview.locator('#workbench').waitFor({state:'visible'});
  assert.equal(await preview.locator('.studio-preview-card').count(), 1);
  await page.locator('.page-item').nth(0).locator('.page-select').click();
  await previewTitle.waitFor({state:'visible'});
  checks.inlineCanvasEdit = true;
  checks.inlineMarkdownEdit = true;
  checks.canvasNavigation = true;
  checks.load = true;

  const pageCount = await page.evaluate(() => window.liveDeckStudio.deck.slides.length);
  await page.locator('#add-page').click();
  await page.waitForFunction(count => window.liveDeckStudio.deck.slides.length === count + 1, pageCount);
  const createdIndex = await page.evaluate(() => window.liveDeckStudio.deck.slides.length - 1);
  const title = page.locator(`[data-pointer="/slides/${createdIndex}/title"]`);
  await title.fill('Studio 创建的新页面');
  await page.waitForFunction(index => window.liveDeckStudio.deck.slides[index].title === 'Studio 创建的新页面', createdIndex);
  assert.match(await page.locator(`[data-pointer="/slides/${createdIndex}/id"]`).inputValue(), /^page-/);
  checks.createPage = true;

  await page.locator('[data-inspector="panels"]').click();
  const panelIds = await page.evaluate(() => Object.keys(window.liveDeckStudio.deck.terminals));
  await page.locator('[data-action="select-panel"]').selectOption(panelIds[1]);
  await page.waitForFunction(id => document.querySelector(`[data-pointer="/terminals/${id}/label"]`) !== null, panelIds[1]);
  const beforeCommands = await page.evaluate(() => {
    const id = Object.keys(window.liveDeckStudio.deck.terminals)[1];
    return {id, count:window.liveDeckStudio.deck.terminals[id].commands.length};
  });
  await page.locator('[data-action="add-command"]').click();
  await page.waitForFunction(({id,count}) => window.liveDeckStudio.deck.terminals[id].commands.length === count + 1, beforeCommands);
  checks.addCommand = true;

  const commandCards = page.locator('.list-card').filter({hasText:'新命令'});
  await commandCards.last().locator('[data-pointer$="/expect"]').fill('看到 hello 输出');
  await page.waitForFunction(({id,count}) => window.liveDeckStudio.deck.terminals[id].commands[count].expect === '看到 hello 输出', beforeCommands);
  checks.editCommand = true;

  await page.locator('#undo').click();
  assert.equal(await page.evaluate(({id,count}) => window.liveDeckStudio.deck.terminals[id].commands[count].expect, beforeCommands), '');
  await page.locator('#redo').click();
  assert.equal(await page.evaluate(({id,count}) => window.liveDeckStudio.deck.terminals[id].commands[count].expect, beforeCommands), '看到 hello 输出');
  checks.undoRedo = true;

  await page.locator('[data-inspector="json"]').click();
  const raw = await page.locator('#json-editor').inputValue();
  const updated = JSON.parse(raw);
  updated.title = 'JSON 模式已应用';
  await page.locator('#json-editor').fill(JSON.stringify(updated, null, 2));
  await page.locator('[data-action="apply-json"]').click();
  await page.waitForFunction(() => window.liveDeckStudio.deck.title === 'JSON 模式已应用');
  checks.rawJson = true;

  await page.locator('[data-inspector="checks"]').click();
  await page.locator('[data-action="run-checks"]').click();
  assert.equal(await page.evaluate(() => window.liveDeckStudio.diagnostics.valid), true);
  checks.preflight = true;

  await page.locator('#save-draft').click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(`${window.liveDeckStudio.storageKey}:studio-draft`)));
  assert.equal(saved.version, 1);
  assert.equal(saved.deck.slides.length, pageCount + 1);
  checks.saveDraft = true;

  const applied = await page.evaluate(() => window.liveDeckStudio.applyToPlayer(false));
  assert.equal(applied.status, 'applied');
  const live = await page.evaluate(() => JSON.parse(localStorage.getItem(window.liveDeckStudio.storageKey)));
  assert.equal(live.slides.length, pageCount + 1);
  checks.apply = true;

  assert.deepEqual(errors, []);
  await page.screenshot({path:path.join(results, 'studio.png'), fullPage:true});
  fs.writeFileSync(path.join(results, 'browser-studio-result.json'), JSON.stringify({passed:true, checks}, null, 2));
  console.log(JSON.stringify({passed:true, checks}));
} catch (error) {
  console.error(error.stack);
  console.error('BROWSER_ERRORS', JSON.stringify(errors));
  await page.screenshot({path:path.join(results, 'failure.png'), fullPage:true});
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
