import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.LIVE_DECK_PLAYWRIGHT_PATH || 'playwright-core');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
if (!process.env.LIVE_DECK_SERVER_INFO) throw new Error('Set LIVE_DECK_SERVER_INFO to the current Jupyter runtime JSON file.');
const server = JSON.parse(fs.readFileSync(process.env.LIVE_DECK_SERVER_INFO));
const base = process.env.LIVE_DECK_TEST_BASE_URL || `http://127.0.0.1:${server.port}${server.base_url}`;
const browser = await chromium.launch({headless:true, ...(process.env.LIVE_DECK_BROWSER_EXECUTABLE ? {executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE} : {}), args:['--no-sandbox','--disable-dev-shm-usage']});
const context = await browser.newContext({viewport:{width:Number(process.env.LIVE_DECK_TEST_WIDTH || 1440),height:Number(process.env.LIVE_DECK_TEST_HEIGHT || 1000)}, extraHTTPHeaders:server.token ? {Authorization:`token ${server.token}`} : {}});
const page = await context.newPage();
const testDeck = JSON.parse(fs.readFileSync(path.join(root, 'web/deck.json')));
testDeck.id += '-browser-test';
await page.route('**/custom/live-deck/deck.json', route => route.fulfill({json:testDeck}));
const errors = [];
page.on('pageerror', error => {errors.push(error.message); console.log('PAGE_ERROR',error.message);});
const checks = {};
const history = id => page.evaluate(id=>window.liveDeck.pool.history(id),id);
async function command(text) {
  await page.locator('#command-input').fill(text);
  await page.locator('#fill-command').click();
  await page.waitForFunction(value => {
    const id = window.liveDeck.pool.activeId;
    return window.liveDeck.pool.history(id).includes(value);
  }, text);
  // Headless Chromium does not reliably route the parent keyboard event into
  // the embedded terminal iframe. Send the same PTY newline directly while the
  // fill button still exercises the product's visible input path.
  await page.evaluate(() => {
    const id = window.liveDeck.pool.activeId;
    const session = window.liveDeck.pool.sessions.get(id);
    session.terminal.socket.send(JSON.stringify(['stdin', '\r']));
  });
  await page.waitForTimeout(600);
}
try {
  await page.goto(`${base}custom/live-deck/index.html`, {waitUntil:'networkidle'});
  await page.waitForFunction(()=>Boolean(window.liveDeck));
  await page.locator('#toggle-top-toolbar').click();
  await page.locator('#toggle-bottom-toolbar').click();
  assert.equal(await page.locator('#studio-link').getAttribute('href'), './studio.html');
  assert.equal(await page.locator('.present h1').textContent(),'让演示，现场发生。');
  checks.slide1=true; await page.screenshot({path:path.join(root,'artifacts/01-slides.png')});
  await page.locator('#next-slide').click();
  await page.waitForFunction(()=>window.liveDeck.pool.sessions.get('terminal-1')?.status==='ready',null,{timeout:35000});
  await page.evaluate(()=>{window.firstTerminal=window.liveDeck.pool.sessions.get('terminal-1').terminal;});
  await command("export LD_BROWSER_TOKEN=shared_context_8294");
  await command('echo "T1_VALUE=$LD_BROWSER_TOKEN T1_PID=$$"');
  assert.match(await history('terminal-1'),/T1_VALUE=shared_context_8294 T1_PID=\d+/);
  checks.actualShell=true;
  await page.locator('#complete-command').click();
  const selected=await page.evaluate(()=>window.liveDeck.store.terminal('terminal-1').selected);
  await page.screenshot({path:path.join(root,'artifacts/02-terminal1.png')});
  await page.locator('#next-slide').click();
  assert.equal(await page.locator('.present h1').textContent(),'翻过一页，现场还在。');
  assert.equal(await page.evaluate(()=>window.firstTerminal.socket.readyState),1);
  await page.locator('#next-slide').click();
  assert.equal(await page.evaluate(()=>window.firstTerminal===window.liveDeck.pool.sessions.get('terminal-1').terminal),true);
  assert.equal(await page.evaluate(()=>window.liveDeck.store.terminal('terminal-1').selected),selected);
  await command('echo "AFTER_SLIDE=$LD_BROWSER_TOKEN T1_PID=$$"');
  assert.match(await history('terminal-1'),/AFTER_SLIDE=shared_context_8294 T1_PID=\d+/);
  checks.sharedAcrossSlides=true;
  await page.locator('#next-slide').click();
  await page.waitForFunction(()=>window.liveDeck.pool.sessions.get('terminal-2')?.status==='ready',null,{timeout:35000});
  await command('echo "T2_VALUE=${LD_BROWSER_TOKEN-unset} T2_PID=$$"');
  const h1=await history('terminal-1'),h2=await history('terminal-2');
  assert.match(h2,/T2_VALUE=unset T2_PID=\d+/);
  assert.notEqual(h1.match(/T1_PID=(\d+)/)?.[1],h2.match(/T2_PID=(\d+)/)?.[1]);
  checks.independentShells=true;
  await page.screenshot({path:path.join(root,'artifacts/05-terminal2.png')});
  await page.locator('#previous-slide').click();
  await page.locator('#toggle-ai').click();
  await page.locator('#show-context').click();
  assert.match(await page.locator('#context-text').textContent(),/shared_context_8294/);
  await page.locator('#close-context').click();
  checks.historyVisible=true;
  await page.locator('#ai-question').fill('当前终端的 LD_BROWSER_TOKEN 是什么值？请依据终端历史回答，并给一条再次检查它的命令。');
  await page.locator('#ask-ai').click();
  console.log('AI_REQUEST_STARTED');
  await page.waitForFunction(()=>{const c=window.liveDeck.store.terminal('terminal-1').conversation;return c.length>=2&&!c.at(-1).pending;},null,{timeout:195000});
  const reply=await page.evaluate(()=>window.liveDeck.store.terminal('terminal-1').conversation.at(-1));
  console.log('AI_REPLY',JSON.stringify(reply));
  assert.match(reply.text,/已设置|未设置|token/i);
  checks.aiReadsActualHistory=true;
  if(reply.commands?.length){
    await page.locator('.suggestion button').first().click();
    assert.equal(await page.locator('#command-input').inputValue(),reply.commands[0].command);
    checks.adoptSuggestion=true;
  }
  await page.screenshot({path:path.join(root,'artifacts/04-terminal1-ai.png')});
  await page.reload({waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.liveDeck?.pool.sessions.get('terminal-1')?.status==='ready',null,{timeout:35000});
  await page.locator('#toggle-top-toolbar').click();
  await page.locator('#toggle-bottom-toolbar').click();
  await command('echo "AFTER_RELOAD=$LD_BROWSER_TOKEN"');
  assert.match(await history('terminal-1'),/AFTER_RELOAD=shared_context_8294/);
  checks.reloadKeepsShell=true;
  await page.locator('#next-slide').click();
  assert.equal(await page.evaluate(()=>window.liveDeck.store.terminal('terminal-2').conversation.length),0);
  checks.aiConversationIsolation=true;
  const downloadPromise=page.waitForEvent('download');
  await page.locator('#export-deck').click();
  const download=await downloadPromise;
  const exported=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  assert.equal(exported.id,testDeck.id); checks.exportDeck=true;
  await page.locator('#edit-deck').click();
  await page.locator('#deck-editor').fill('{"id":"broken"}');
  await page.locator('#save-deck').click();
  assert.notEqual(await page.locator('#editor-error').textContent(),'');
  const imported=structuredClone(testDeck); imported.title='Browser verified deck';
  await page.locator('#import-deck').setInputFiles({name:'imported.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
  await page.waitForFunction(()=>document.getElementById('deck-editor').value.includes('Browser verified deck'));
  await page.locator('#save-deck').click();
  await page.waitForFunction(()=>window.liveDeck?.deck.title==='Browser verified deck');
  checks.importEditAndReload=true;
  assert.equal(errors.length,0);
  console.log('BROWSER_CHECKS',JSON.stringify(checks));
  fs.writeFileSync(path.join(root,'artifacts/browser-result.json'),JSON.stringify({checks,errors,passed:true},null,2));
} catch(error) {
  console.log('FAILED',error.stack);
  await page.screenshot({path:path.join(root,'artifacts/failure.png')});
  fs.writeFileSync(path.join(root,'artifacts/browser-result.json'),JSON.stringify({checks,errors,passed:false,error:String(error)},null,2));
  process.exitCode=1;
} finally {
  let kernelId;
  try {
    kernelId = await page.evaluate(()=>window.liveDeck && localStorage.getItem(window.liveDeck.advisor.key));
  } catch {}
  await browser.close();
  const {terminalName} = await import('../web/src/model.js');
  const headers = server.token ? {Authorization:`token ${server.token}`} : {};
  for (const id of Object.keys(testDeck.terminals)) {
    const name=terminalName(testDeck.id,id);
    await fetch(`http://127.0.0.1:${server.port}${server.base_url}api/terminals/${name}`, {method:'DELETE',headers});
  }
  if(kernelId) await fetch(`http://127.0.0.1:${server.port}${server.base_url}api/kernels/${kernelId}`, {method:'DELETE',headers});
}
