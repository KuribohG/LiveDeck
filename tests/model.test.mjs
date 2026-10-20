import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateDeck, terminalName, singleLineCommand, stripTerminalCodes, DeckStore} from '../web/src/model.js';

const deck = JSON.parse(fs.readFileSync(new URL('../web/deck.json', import.meta.url)));
test('the five-page deck shares terminal 1 on pages 2 and 4, and isolates terminal 2', () => {
  validateDeck(deck);
  assert.deepEqual(deck.slides.map(s => s.type), ['slide','terminal','slide','terminal','terminal']);
  const names = deck.slides.filter(s => s.type === 'terminal').map(s => terminalName(deck.id, s.terminal));
  assert.equal(names[0], names[1]); assert.notEqual(names[0], names[2]);
  assert.notEqual(names[0], terminalName('another-deck', 'terminal-1'));
  assert.equal(deck.terminals['terminal-1'].commands.length, 50);
});
test('invalid references and prototype-like terminal identifiers are rejected', () => {
  const broken = structuredClone(deck); broken.slides[1].terminal = 'missing';
  assert.throws(() => validateDeck(broken), /未定义终端/);
  const malicious = structuredClone(deck); malicious.terminals.constructor = {commands:[]};
  assert.throws(() => validateDeck(malicious), /ID 无效/);
});
test('fill rejects terminal controls and newlines, and accepts the bundled commands', () => {
  for (const text of ['echo ok\nrm file', 'echo\rbad', '\x03exit', 'echo\u2028bad']) {
    assert.throws(() => singleLineCommand(text));
  }
  for (const config of Object.values(deck.terminals)) for (const entry of config.commands) assert.equal(singleLineCommand(entry.command), entry.command);
});
test('progress, drafts and AI conversations persist per terminal without cross-contamination', () => {
  const values = new Map(), storage = {getItem:k=>values.get(k), setItem:(k,v)=>values.set(k,v)};
  const store = new DeckStore(deck, storage);
  store.terminal('terminal-1').selected = 12;
  store.terminal('terminal-1').conversation.push({role:'user', text:'question for terminal 1'});
  store.terminal('terminal-2').selected = 3;
  store.save();
  const reload = new DeckStore(deck, storage);
  assert.equal(reload.terminal('terminal-1').selected, 12);
  assert.equal(reload.terminal('terminal-2').selected, 3);
  assert.equal(reload.terminal('terminal-2').conversation.length, 0);
});
test('terminal history presented to the advisor drops screen-control sequences', () => {
  assert.equal(stripTerminalCodes('\x1b[32mresult\x1b[0m\r\n'), 'result\n');
  assert.equal(stripTerminalCodes('\x1b]0;title\x07hello'), 'hello');
});
