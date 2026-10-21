import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDeck, DeckStore, Sequence, refreshSourceMonitoring} from '../web/src/model.js';

const storage = () => {const data=new Map();return {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};};
const fixture = () => ({id:'shared-player',title:'shared',revision:'r1',
  terminals:{main:{commands:[{id:'m',title:'main',command:'echo main'}]},other:{independentSequence:true,tabs:{fio:{label:'fio'}},commands:[{id:'o',title:'other',command:'echo other'}]}},
  dashboards:{preview:{url:'https://example.com/old',commands:[]}},
  slides:[{type:'workspace',title:'main',panels:['main','preview']},{type:'workspace',title:'other',panels:['other','preview']}],
  sequence:[{panel:'main',command:'m'},{panel:'other',command:'o'},{panel:'main',command:'m'},{panel:'other',command:'o'}]});

test('independent progress, original sequence indexes and tab choices survive switching and reload',()=>{
  const deck=validateDeck(fixture()),saved=storage(),store=new DeckStore(deck,saved),seq=new Sequence(deck,store);
  seq.advance();assert.equal(seq.next.sourceIndex,2);
  seq.setScope('other');assert.equal(seq.state.cursor,0);assert.equal(seq.next.sourceIndex,1);
  seq.advance();assert.equal(seq.next.sourceIndex,3);
  deck.sequence[seq.next.sourceIndex].tab='fio';
  const restored=new Sequence(deck,new DeckStore(deck,saved));
  assert.equal(restored.state.cursor,1);restored.setScope('other');assert.equal(restored.state.cursor,1);assert.equal(restored.next.tab,'fio');
  const mainState=store.data.sequence,otherState=store.data.panelSequences.other;
  store.resetProgress();assert.equal(mainState.cursor,0);assert.equal(otherState.cursor,0);
  assert.equal(seq.state,otherState);
});

test('optional preview validates its URL, target and same-page relationship',()=>{
  const deck=fixture();deck.terminals.main.commands[0].preview={panel:'preview',url:'https://example.com/code'};
  validateDeck(deck);
  for(const change of [d=>d.terminals.main.commands[0].preview.panel='other',d=>d.terminals.main.commands[0].preview.url='javascript:alert(1)',d=>d.slides[0].panels=['main'],d=>d.terminals.other.independentSequence='yes',d=>d.revision='']) {
    const invalid=structuredClone(deck);change(invalid);assert.throws(()=>validateDeck(invalid));
  }
});


test('published monitoring replaces stale charts while preserving browser commands, tabs and unrelated edits',()=>{
  const source=fixture();source.monitoringRevision='original-3fs';source.terminals.main.commands[0].note='new monitoring';
  const saved=structuredClone(source);delete saved.monitoringRevision;
  saved.title='browser title';saved.dashboards.preview.url='https://example.com/retired';
  saved.terminals.main.tabs={extra:{label:'temporary'}};saved.terminals.main.commands[0].tab='extra';
  saved.terminals.main.commands[0].note='old monitoring';saved.sequence[0].tab='extra';
  saved.terminals.other.commands[0].command='echo browser edit';saved.terminals.other.commands[0].note='keep';
  saved.dashboards.extra={url:'https://example.com/custom',commands:[]};
  const original=structuredClone(saved),updated=refreshSourceMonitoring(source,saved);
  assert.equal(updated.title,'browser title');assert.deepEqual(updated.dashboards.preview,source.dashboards.preview);
  assert.deepEqual(updated.terminals.main.tabs,saved.terminals.main.tabs);assert.deepEqual(updated.sequence,saved.sequence);
  assert.equal(updated.terminals.main.commands[0].tab,'extra');assert.equal(updated.terminals.main.commands[0].note,'new monitoring');
  assert.deepEqual(updated.terminals.other,saved.terminals.other);assert.deepEqual(updated.dashboards.extra,saved.dashboards.extra);
  assert.deepEqual(saved,original);assert.equal(refreshSourceMonitoring(source,updated),updated);
  assert.equal(refreshSourceMonitoring({...source,id:'another'},saved),saved);
  assert.equal(refreshSourceMonitoring({...source,monitoringRevision:undefined},saved),saved);
  validateDeck(updated);
});
