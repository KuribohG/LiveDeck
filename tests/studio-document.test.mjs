import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateDeck} from '../web/src/model.js';
import {
  addCommand,
  addTerminal,
  createPage,
  moveItem,
  panelReferences,
  prepareDeckForEditing,
  removePanel,
  removeTab,
  renamePanel,
} from '../web/src/studio-model.js';

const source = JSON.parse(fs.readFileSync(new URL('../web/examples/tabs.livedeck.json', import.meta.url)));

test('studio preparation assigns stable page ids without changing playback fields', () => {
  const legacy = structuredClone(source);
  delete legacy.slides[0].id;
  const deck = prepareDeckForEditing(legacy);
  assert.match(deck.slides[0].id, /^page-/);
  assert.equal(deck.terminals.host.commands[0].command, source.terminals.host.commands[0].command);
  validateDeck(deck);
});

test('opening a slide-only deck does not invent terminal or dashboard panels', () => {
  const deck = prepareDeckForEditing({
    format:'live-deck',
    version:1,
    id:'slides-only',
    title:'Slides only',
    slides:[{type:'slide',title:'Intro',markdown:'Text'}],
  });
  assert.deepEqual(deck.terminals, {});
  assert.deepEqual(deck.dashboards, {});
  assert.match(deck.slides[0].id, /^page-/);
  validateDeck(deck);
});

test('renaming a panel rewrites slides, sequence, bindings and monitor groups atomically', () => {
  const deck = prepareDeckForEditing(source);
  deck.dashboards = {chart:{commands:[], binding:{terminal:'host', tab:'background', params:{}}}};
  deck.monitorGroups = {system:{label:'系统', panels:['chart']}};
  deck.slides[0] = {id:deck.slides[0].id, type:'workspace', title:'观察', panels:['host'], monitorGroups:['system']};
  renamePanel(deck, 'host', 'runner');
  assert.ok(deck.terminals.runner);
  assert.equal(deck.slides[0].panels[0], 'runner');
  assert.equal(deck.sequence[0].panel, 'runner');
  assert.equal(deck.dashboards.chart.binding.terminal, 'runner');
  renamePanel(deck, 'chart', 'metrics');
  assert.deepEqual(deck.monitorGroups.system.panels, ['metrics']);
  validateDeck(deck);
});

test('studio mutations refuse to orphan references or delete a used tab', () => {
  const deck = prepareDeckForEditing(source);
  assert.throws(() => removePanel(deck, 'host'), /仍被/);
  assert.throws(() => removeTab(deck, 'host', 'background'), /仍引用/);
  assert.ok(panelReferences(deck, 'host').length >= 2);
});

test('new pages and commands keep deterministic unique ids', () => {
  const deck = prepareDeckForEditing(source);
  const first = addTerminal(deck);
  const second = addTerminal(deck);
  assert.notEqual(first, second);
  const page = createPage(deck, 'terminal');
  deck.slides.push(page);
  const command = addCommand(deck, first);
  assert.equal(command, 'step-1');
  assert.equal(moveItem(deck.slides, 0, 1), true);
  validateDeck(deck);
});
