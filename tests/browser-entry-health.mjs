import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const results = process.env.LIVE_DECK_TEST_ARTIFACTS || path.resolve(root, '../live-deck-entry-health-20261021');
fs.mkdirSync(results, {recursive:true});
const server = JSON.parse(fs.readFileSync(process.env.LIVE_DECK_SERVER_INFO));
const base = process.env.LIVE_DECK_TEST_BASE_URL || `http://127.0.0.1:${server.port}${server.base_url}`;
const pageUrl = new URL(process.env.LIVE_DECK_TEST_PAGE || `${base}custom/live-deck/index.html`, base).href;
const browser = await chromium.launch({headless:true,executablePath:process.env.LIVE_DECK_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
const context = await browser.newContext({viewport:{width:1440,height:900}});
await context.route('**/*', route => route.continue({headers:{...route.request().headers(),...(new URL(route.request().url()).origin === new URL(base).origin && server.token ? {Authorization:`token ${server.token}`} : {})}}));
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(pageUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.liveDeck?.productApi?.version === 1, null, {timeout:45000});
  const snapshot = await page.evaluate(() => window.liveDeck.productApi.inspect());
  assert.ok(snapshot.deck.id);
  assert.ok(snapshot.deck.title);
  assert.equal(typeof snapshot.deck.effectiveRevision, 'string');
  assert.equal(await page.locator('#copy-state').count(), 1);
  assert.deepEqual(errors, []);
  await page.screenshot({path:path.join(results, 'entry-health.png'),fullPage:true});
  fs.writeFileSync(path.join(results, 'entry-health.json'), JSON.stringify({passed:true,deck:snapshot.deck,view:snapshot.view}, null, 2));
  console.log(JSON.stringify({passed:true,deck:{id:snapshot.deck.id,title:snapshot.deck.title,revision:snapshot.deck.effectiveRevision},view:snapshot.view}));
} catch (error) {
  console.error(error.stack);
  console.error('BROWSER_ERRORS', JSON.stringify(errors));
  await page.screenshot({path:path.join(results, 'failure.png'),fullPage:true});
  process.exitCode = 1;
} finally {
  await browser.close();
}
