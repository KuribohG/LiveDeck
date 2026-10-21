import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {METRIC_IDS} from '../web/src/chart-model.js';
import {DeckStore, Sequence, validateDeck} from '../web/src/model.js';
import {
  PRODUCT_API_VERSION,
  PRODUCT_OPERATIONS,
  deepDiff,
  effectiveRevision,
  inspectState,
  prepareOperation,
  previewOperation,
  validateMetricCatalog,
  validateProduct,
} from '../web/src/product-api.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../web/src/metric-catalog.json', import.meta.url)));
const storage = () => {
  const values = new Map();
  return {getItem:key => values.get(key), setItem:(key, value) => values.set(key, value)};
};
const fixture = () => validateDeck({
  format:'live-deck',
  version:1,
  id:'product-api-test',
  title:'Product API',
  revision:'r1',
  terminals:{
    runner:{
      label:'Runner',
      tabs:{fuse:{label:'FUSE'}},
      commands:[{id:'run',title:'启动',command:'echo run',note:'启动一次运行',tab:'fuse'}],
    },
  },
  dashboards:{
    latency:{
      label:'延迟',
      commands:[],
      binding:{terminal:'runner',tab:'fuse',params:{}},
      chart:{type:'timeseries',metric:'fuse-read-latency',datasource:'ds',database:'hf3fs_hg',comparisonField:'comparison_runs'},
    },
  },
  slides:[{type:'workspace',title:'观察',panels:['runner','latency']}],
  sequence:[{panel:'runner',command:'run'}],
});

test('shared metric catalog covers every chart metric and backend contract', () => {
  validateMetricCatalog(catalog);
  assert.deepEqual(Object.keys(catalog.metrics), METRIC_IDS);
  assert.equal(catalog.metrics['fuse-read-latency'].aggregate, 'sum(mean * count) / nullIf(sum(count), 0)');
  assert.equal(catalog.metrics['blob-read-latency'].aggregate, 'avg(mean)');
});

test('state snapshot exposes effective versions, exact runs and chart evidence', () => {
  const deck = fixture(), store = new DeckStore(deck, storage()), sequence = new Sequence(deck, store);
  const run = {run_id:'run-1',started_at_ms:1000,at_ms:1100,status:'ready',fields:{host:'node-a',pod:'pod-a'}};
  store.data.runs = {'runner:fuse':run};
  const snapshot = inspectState({
    deck,
    sourceDeck:structuredClone(deck),
    store,
    sequence,
    catalog,
    charts:{context:id => id === 'latency' ? {metric:'fuse.op.latency',point_count:2} : null},
    workspace:{visible:['runner','latency'],activeTab:() => 'fuse',follows:() => true},
    currentSlideIndex:0,
    currentGroup:null,
    currentPanel:'latency',
  });
  assert.equal(snapshot.version, PRODUCT_API_VERSION);
  assert.equal(snapshot.deck.configSource, 'published');
  assert.equal(snapshot.deck.effectiveRevision, effectiveRevision(deck));
  assert.deepEqual(snapshot.capabilities.operations, PRODUCT_OPERATIONS);
  assert.equal(snapshot.panels.find(panel => panel.id === 'latency').run.run_id, 'run-1');
  assert.equal(snapshot.panels.find(panel => panel.id === 'latency').metricDefinition.unit, 'ns');
  assert.deepEqual(snapshot.panels.find(panel => panel.id === 'latency').chartEvidence, {metric:'fuse.op.latency',point_count:2});
  assert.deepEqual(snapshot.experiments[0].panels, ['latency']);
  assert.equal(snapshot.experiments[0].phases[0].phase, 'current');
  assert.equal(snapshot.experiments[0].phases[0].pod, 'pod-a');
});

test('preview and prepare apply atomic chart, command and draft operations', () => {
  const deck = fixture();
  const preview = previewOperation(deck, {type:'chart.set',target:'latency',patch:{metric:'fuse-read-rate',stepSeconds:5}}, {catalog});
  assert.equal(preview.status, 'ready');
  assert.equal(preview.diff.length, 2);
  assert.equal(deck.dashboards.latency.chart.metric, 'fuse-read-latency');
  assert.deepEqual(preview.diff.find(change => change.path.endsWith('/metric')).after, 'fuse-read-rate');
  const prepared = prepareOperation(deck, {type:'monitor.set',target:'latency',metricRef:'blob-read-latency',view:{mode:'current'}}, {catalog});
  assert.equal(prepared.deck.dashboards.latency.chart.metric, 'blob-read-latency');
  assert.equal(prepared.deck.dashboards.latency.chart.comparisonField, undefined);
  assert.deepEqual(prepared.deck.dashboards.latency.binding, deck.dashboards.latency.binding);
  const command = prepareOperation(deck, {type:'command.update',target:'runner',command:'run',patch:{note:'新说明'}}, {catalog});
  assert.equal(command.deck.terminals.runner.commands[0].note, '新说明');
  const draft = prepareOperation(deck, {type:'terminal.prepare',target:'runner',tab:'fuse',text:'fio --name=test'}, {catalog});
  assert.deepEqual(draft.runtimeOperation, {type:'draft.prepare',panel:'runner',tab:'fuse',text:'fio --name=test'});
  assert.deepEqual(draft.diff, []);
});

test('operation previews reject revision conflicts and unsafe drafts without mutating', () => {
  const deck = fixture();
  const rejected = previewOperation(deck, {type:'chart.set',target:'latency',patch:{metric:'fuse-read-rate'}}, {catalog, expectedRevision:'deck-stale'});
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.issues[0].code, 'REVISION_CONFLICT');
  const unsafe = previewOperation(deck, {type:'terminal.prepare',target:'runner',tab:'fuse',text:'echo ok\nexit'}, {catalog});
  assert.equal(unsafe.status, 'rejected');
  assert.match(unsafe.issues[0].message, /单行命令/);
  assert.equal(deck.dashboards.latency.chart.metric, 'fuse-read-latency');
});

test('product validation runs a deterministic phase lifecycle without executing commands', () => {
  const result = validateProduct(fixture(), {catalog, replay:true, panel:'latency'});
  assert.equal(result.valid, true);
  assert.equal(result.levels.static.ok, true);
  assert.equal(result.levels.capabilities.ok, true);
  assert.equal(result.levels.replay.panel, 'latency');
  assert.equal(result.levels.replay.checks.every(check => check.ok), true);
  assert.deepEqual(result.levels.replay.checks.map(check => check.name), [
    'before 事件建立单阶段请求',
    'after 事件保留 before 并追加当前阶段',
    '重复事件不会改变当前运行',
    'after 结束后冻结真实终点',
    '结束后的迟到更新不会回滚状态',
    '指标口径来自共享目录',
  ]);
});

test('JSON pointer diffs remain precise for nested edits', () => {
  const changes = deepDiff({a:{'b/c':1}, list:[1]}, {a:{'b/c':2}, list:[1,2]});
  assert.deepEqual(changes.map(change => change.path), ['/a/b~1c', '/list/1']);
});
