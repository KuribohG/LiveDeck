import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateDeck, DeckStore, Sequence, webUrl} from '../web/src/model.js';
const sample = JSON.parse(fs.readFileSync(new URL('../web/multi-panel.json', import.meta.url)));
const memory = () => {const data = new Map(); return {getItem:key=>data.get(key), setItem:(key,value)=>data.set(key,value)};};

test('long decks have no arbitrary command, page, or sequence count cap', () => {
  const deck = structuredClone(sample);
  deck.terminals.runner.commands = Array.from({length:10000}, (_,i)=>({id:`step-${i}`,title:`Step ${i}`,command:`echo ${i}`}));
  deck.sequence = deck.terminals.runner.commands.map(command=>({panel:'runner',command:command.id}));
  deck.slides = Array.from({length:250},()=>({type:'workspace',title:'Large deck',panels:['runner','logs','metrics']}));
  assert.equal(validateDeck(deck).terminals.runner.commands.length,10000);
});
test('cross-panel sequence advances separately from free selection and persists', () => {
  const deck=validateDeck(sample), storage=memory(), store=new DeckStore(deck,storage), sequence=new Sequence(deck,store);
  assert.equal(sequence.next.panel,'runner');
  store.terminal('logs').selected=2;
  assert.equal(sequence.next.panel,'runner');
  sequence.advance(); assert.equal(sequence.next.panel,'logs');
  sequence.advance(true); assert.equal(sequence.next.panel,'runner');
  const restored=new Sequence(deck,new DeckStore(deck,storage));
  assert.equal(restored.state.cursor,2); assert.deepEqual(restored.state.skipped,[1]);
  restored.back(); assert.equal(restored.next.panel,'logs');
  const changed=structuredClone(deck); changed.sequence.reverse();
  assert.equal(new Sequence(changed,new DeckStore(changed,storage)).state.cursor,0);
});
test('invalid graph references, duplicate panes, and executable URLs are rejected',()=>{
  for (const mutate of [d=>d.sequence[0].command='missing', d=>d.slides[1].panels.push('runner'), d=>d.dashboards.metrics.commands[0].command='javascript:alert(1)', d=>d.dashboards.runner={commands:[]}]) {
    const deck=structuredClone(sample); mutate(deck); assert.throws(()=>validateDeck(deck));
  }
  assert.throws(()=>webUrl('https://user:password@example.org'));
  const changed=structuredClone(sample); changed.terminals.runner.commands.reverse();
  assert.equal(new Sequence(validateDeck(changed),new DeckStore(changed,memory())).next.index,2);
});

test('documented v1 examples load, legacy files remain valid, unsupported versions fail',()=>{
  for(const file of ['minimal.livedeck.json','multi-panel.livedeck.json']) {
    const deck=JSON.parse(fs.readFileSync(new URL(`../web/examples/${file}`,import.meta.url)));
    assert.equal(validateDeck(deck).version,1);
  }
  for(const mutate of [d=>d.version=2,d=>d.format='reveal',d=>d.id=123,d=>d.terminals=null,d=>d.dashboards.metrics.url=123]) {
    const invalid=structuredClone(sample);mutate(invalid);assert.throws(()=>validateDeck(invalid));
  }
  const legacy=structuredClone(sample);delete legacy.version;delete legacy.format;
  assert.equal(validateDeck(legacy).id,sample.id);
});
