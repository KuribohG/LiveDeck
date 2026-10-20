import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDeck, DeckStore, Sequence, terminalName} from '../web/src/model.js';
import {terminalTabs, terminalSessionId, commandTab, restoreTabOrigins, fixedTabDefinitions} from '../web/src/tabs.js';

const fixture = () => ({id:'tabs-test',title:'tabs',terminals:{host:{tabs:{background:{label:'后台'}},commands:[{id:'serve',title:'serve',command:'echo demo',tab:'background'}]}},dashboards:{chart:{commands:[],binding:{terminal:'host',tab:'background',params:{}}}},slides:[{type:'workspace',title:'test',panels:['host','chart']}],sequence:[{panel:'host',command:'serve'},{panel:'host',command:'serve',tab:'main'}]});
const storage = () => { const m = new Map(); return {getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)}; };

test('legacy sessions keep their names and tabs use independent namespaces', () => {
  assert.equal(terminalSessionId('host','main'),'host');
  assert.equal(terminalName('old-deck',terminalSessionId('host')),terminalName('old-deck','host'));
  assert.notEqual(terminalName('old-deck',terminalSessionId('host','background')),terminalName('old-deck','host'));
  assert.notEqual(terminalSessionId('host','logs'),terminalSessionId('host-logs'));
  assert.deepEqual(terminalTabs({}).map(t=>t.id),['main']);
});

test('each sequence occurrence may override the same command without resetting progress', () => {
  const deck=validateDeck(fixture()), saved=storage(), store=new DeckStore(deck,saved), seq=new Sequence(deck,store);
  const state=store.terminal('host');
  assert.equal(commandTab(deck.terminals.host,state,seq.next),'background');
  seq.advance();
  assert.equal(commandTab(deck.terminals.host,state,seq.next),'main');
  deck.sequence[1].tab='background';
  assert.equal(new Sequence(deck,new DeckStore(deck,saved)).state.cursor,1);
  state.activeTab='background';store.resetProgress();
  assert.equal(state.activeTab,'background');
  assert.equal(deck.sequence[1].tab,'background');
});

test('unknown tabs and invalid tab configuration fail before a command can be routed', () => {
  validateDeck(fixture());
  for (const change of [d=>d.terminals.host.commands[0].tab='missing',d=>d.sequence[0].tab='missing',d=>d.dashboards.chart.binding.tab='missing',d=>d.terminals.host.tabs=[],d=>d.terminals.host.tabs.background=null,d=>d.terminals.host.tabs.background.cwd=2,d=>d.terminals.host.tabs.background.label='',d=>d.terminals.host.tabs=JSON.parse('{"__proto__":{}}'),d=>d.sequence=[{panel:'chart',command:0,tab:'main'}]]) {
    const deck=fixture(); change(deck); assert.throws(()=>validateDeck(deck));
  }
});

test('stored temporary identities survive while source declarations and unknown origins stay fixed', () => {
  const source=fixture(); source.terminals.host.tabs['tab-4']={label:'declared'};
  const saved=structuredClone(source);Object.assign(saved.terminals.host.tabs,{'tab-2':{label:'old manual'},'tab-3':{label:'new manual'},authored:{label:'authored'}});
  const origins=restoreTabOrigins(saved,source,{host:['tab-3','tab-4','missing']});
  assert.deepEqual(origins.temporary.host,['tab-3']);
  assert.deepEqual(origins.fixed.host,['main','background','tab-4','tab-2','authored']);
  assert.deepEqual(restoreTabOrigins(saved,source,{version:2,temporary:{host:['tab-2','tab-3']},fixed:{host:['main','background','tab-4','authored']}}).temporary.host,['tab-2','tab-3']);
  assert.equal(saved.terminals.host.tabs['tab-2'].label,'old manual');
});

test('explicit JSON definitions stay fixed across reload and invalid metadata', () => {
  const source=fixture(),saved=structuredClone(source);saved.terminals.host.tabs['tab-2']={label:'authored'};
  const fixed=fixedTabDefinitions(saved);
  assert.deepEqual(restoreTabOrigins(saved,source,{version:2,fixed,temporary:{host:['tab-2']}}).fixed,fixed);
  assert.deepEqual(restoreTabOrigins(saved,source,{version:2,fixed,temporary:{host:['tab-2']}}).temporary.host,[]);
  assert.deepEqual(restoreTabOrigins(saved,source,{host:'tab-2'}).temporary.host,[]);
  saved.id='different-import';
  assert.deepEqual(restoreTabOrigins(saved,source,null).fixed,fixed);
  assert.deepEqual(restoreTabOrigins(saved,source,{version:2,temporary:{host:['tab-2']},fixed:{}}).temporary.host,['tab-2']);
});
