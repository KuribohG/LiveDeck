import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeEvents, EVENT_PREFIX, RunContexts, bindUrl, validateBinding} from '../web/src/runtime.js';
import {validateDeck, DeckStore, Sequence, slidePanels} from '../web/src/model.js';
const storage = () => { const m = new Map(); return {getItem:k=>m.get(k), setItem:(k,v)=>m.set(k,v)}; };
const event = (extra={}) => ({version:1,event:'started',event_id:'e1',run_id:'r1',started_at_ms:1000,at_ms:1000,fields:{instance:'node-a'},...extra});

test('OSC events can be split at any byte, combined with logs, or followed by malformed data', () => {
  const expected = event({fields:{instance:'中文 & node'}});
  const encoded = EVENT_PREFIX + Buffer.from(JSON.stringify(expected)).toString('base64') + '\x07';
  for (let split=0; split<=encoded.length; split++) {
    const got=[], parser=new RuntimeEvents(e=>got.push(e));
    parser.push('normal log\n'+encoded.slice(0,split)); parser.push(encoded.slice(split)+'\nmore output');
    assert.deepEqual(got,[expected]);
  }
  const got=[], parser=new RuntimeEvents(e=>got.push(e));
  parser.push(EVENT_PREFIX+'invalid\x07'+EVENT_PREFIX+'x'.repeat(40000)); parser.push(encoded+encoded);
  assert.equal(got.length,2);
});

test('runs are terminal-scoped; new runs clear old fields; replay and late completion cannot roll back', () => {
  const saved=storage(), deck={id:'runtime'}, runs=new RunContexts(new DeckStore(deck,saved));
  assert.equal(runs.accept('runner',event()),true);
  assert.equal(runs.get('logs'),undefined);
  assert.equal(runs.accept('runner',event()),false);
  runs.accept('runner',event({event:'ready',at_ms:1100,event_id:'e2',fields:{task_id:'42'}}));
  assert.equal(runs.get('runner').status,'ready');
  runs.accept('runner',event({run_id:'r2',started_at_ms:2000,at_ms:2000,event_id:'e3',fields:{instance:'node-b'}}));
  assert.equal(runs.get('runner').fields.task_id,undefined);
  assert.equal(runs.accept('runner',event({event:'finished',at_ms:3000,event_id:'e4'})),false);
  runs.accept('runner',event({run_id:'r2',started_at_ms:2000,at_ms:3100,event_id:'e5',event:'finished',exit_code:1,fields:{}}));
  assert.equal(runs.get('runner').exit_code,1);
  assert.equal(runs.accept('runner',event({run_id:'r2',started_at_ms:2000,at_ms:3200,event_id:'e6',event:'update'})),false);
  assert.deepEqual(new RunContexts(new DeckStore(deck,saved)).get('runner'),runs.get('runner'));
  assert.equal(runs.accept('runner',event({fields:JSON.parse('{"__proto__":"bad"}')})),false);
});

test('URL binding encodes parameters, supports multi-value variables and waits for missing fields', () => {
  const binding={terminal:'runner',params:{'var-host':'instance','var-task':'task_id'},refresh:'10s'};
  const base='https://grafana.example/d-solo/uid/name?panelId=2&var-host=old&orgId=1';
  assert.equal(bindUrl(base,binding,event()).url,null);
  const run=event({fields:{instance:['a & b','节点/1'],task_id:'42?x=1'}});
  const result=new URL(bindUrl(base,binding,run).url);
  assert.deepEqual(result.searchParams.getAll('var-host'),['a & b','节点/1']);
  assert.equal(result.searchParams.get('var-task'),'42?x=1');
  assert.equal(result.searchParams.get('orgId'),'1');
  assert.equal(result.searchParams.get('from'),'0');
  assert.equal(result.searchParams.get('to'),'now');
  assert.equal(result.origin,'https://grafana.example');
  assert.equal(bindUrl(base,{...binding,time:false,params:{},defaults:{}},null).url,new URL(base).href);
  run.fields.monitoring_started_at_ms=100000;
  assert.equal(new URL(bindUrl(base,binding,run).url).searchParams.get('from'),'70000');
});

test('nanosecond ordering prevents same-millisecond replay from replacing newer fields', () => {
  const runs = new RunContexts(new DeckStore({id:'ordering'},storage()));
  const latest=event({event:'update',at_ns:'1000000100',fields:{task_id:'new'}});
  assert.equal(runs.accept('runner',latest),true);
  assert.equal(runs.accept('runner',event({at_ns:'1000000000',event_id:'older',fields:{task_id:'old'}})),false);
  assert.equal(runs.get('runner').fields.task_id,'new');
});

test('monitor group and binding references validate; sequence can navigate a group', () => {
  const deck={id:'group-test',title:'test',terminals:{runner:{commands:[]}},dashboards:{cpu:{url:'https://example.org',commands:[],binding:{terminal:'runner',params:{'var-host':'instance'}}}},monitorGroups:{system:{label:'system',panels:['cpu']}},slides:[{type:'workspace',title:'test',panels:['runner'],monitorGroups:['system']}],sequence:[{group:'system'}]};
  assert.deepEqual(slidePanels(validateDeck(deck).slides[0],deck),['runner','cpu']);
  const seq=new Sequence(deck,new DeckStore(deck,storage())); assert.equal(seq.next.group,'system'); seq.advance(); assert.equal(seq.next,undefined);
  for (const mutate of [d=>d.dashboards.cpu.binding.terminal='missing',d=>d.monitorGroups.system.panels=['runner'],d=>d.sequence[0].group='missing',d=>d.sequence[0].panel='cpu',d=>d.slides[0].monitorGroup='missing',d=>d.dashboards.cpu.binding.params.from='instance',d=>d.dashboards.cpu.binding.defaults={instance:null}]) {
    const changed=structuredClone(deck);mutate(changed);assert.throws(()=>validateDeck(changed));
  }
});


test('existing Grafana variables bind exact daemon names from old and new runtime contexts',()=>{
  const binding={terminal:'runner',params:{'var-ClientHost':'host','var-ClientPod':'pod'},paramSuffixes:{'var-ClientPod':['-before','-after']}};
  validateBinding(binding,{runner:{}});
  const run=event({fields:{host:'node',pod:'session & 1'}});
  const result=new URL(bindUrl('https://grafana.example/d-solo/original?var-ClientPod=old',binding,run).url);
  assert.deepEqual(result.searchParams.getAll('var-ClientPod'),['session & 1-before','session & 1-after']);
  assert.equal(result.searchParams.get('var-ClientHost'),'node');assert.equal(result.origin,'https://grafana.example');
  assert.equal(run.fields.pod,'session & 1');assert.equal(bindUrl(result,binding,event()).url,null);
  for(const paramSuffixes of [null,[],{'unmapped':['-before']},{'var-ClientPod':[]},{'var-ClientPod':[1]}]) {
    assert.throws(()=>validateBinding({...binding,paramSuffixes},{runner:{}}));
  }
});

test('single-instance binding waits on missing, All, multiple or pattern targets and freezes a completed run',()=>{
  const binding={terminal:'runner',params:{'var-ClientHost':'host','var-ClientPod':'pod'},singleInstance:true,freezeOnFinish:true,lookbackMs:100};
  const base='https://grafana.example/d/source?var-ClientPod=All';
  for(const fields of [{},{host:'node',pod:'All'},{host:'All',pod:'run-before'},{host:'node',pod:['before','after']},{host:'node',pod:'.*'}]){
    assert.equal(bindUrl(base,binding,event({fields})).url,null);
  }
  const done={...event({fields:{host:'node',pod:'run-before'}}),status:'finished',ended_at_ms:2000};
  const url=new URL(bindUrl(base,binding,done).url);
  assert.deepEqual(url.searchParams.getAll('var-ClientPod'),['run-before']);
  assert.equal(url.searchParams.get('to'),'2000'); assert.equal(url.searchParams.has('refresh'),false);
  for(const option of ['singleInstance','freezeOnFinish'])assert.throws(()=>validateBinding({...binding,[option]:'true'},{runner:{}}));
});

test('a new FUSE phase changes only its tab-bound exact pod and discards the prior time window',()=>{
  const runs=new RunContexts(new DeckStore({id:'phase-test'},storage()));
  const binding={terminal:'runner',tab:'fuse',params:{'var-ClientHost':'host','var-ClientPod':'pod'},singleInstance:true,lookbackMs:100};
  runs.accept('runner',event({fields:{host:'node',pod:'prefix'}}));
  assert.equal(bindUrl('https://grafana.example/d/source',binding,runs.get('runner:fuse')).url,null);
  for(const [phase,stamp] of [['before',1000],['after',2000]]){
    runs.accept('runner:fuse',event({run_id:phase,started_at_ms:stamp,at_ms:stamp,fields:{host:'node',pod:'prefix-'+phase}}));
    const url=new URL(bindUrl('https://grafana.example/d/source',binding,runs.get('runner:fuse')).url);
    assert.deepEqual(url.searchParams.getAll('var-ClientPod'),['prefix-'+phase]);assert.equal(url.searchParams.get('from'),String(stamp-100));
  }
});
