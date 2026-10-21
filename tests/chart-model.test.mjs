import test from 'node:test';
import assert from 'node:assert/strict';
import {chartRequest, validateChart, chartEvidence, formatValue} from '../web/src/chart-model.js';
const config = {chart:{type:'timeseries',metric:'fuse-read-rate',datasource:'ds',database:'hf3fs_hg',comparisonField:'comparison_runs'},binding:{terminal:'runner'}};
const before = {host:'host',pod:'first',phase:'before',from:10000,to:20000};
const after = {host:'host',pod:'second',phase:'after',from:25000,to:0};
const context = (runs, status='ready') => ({started_at_ms:runs.at(-1).from,status,ended_at_ms:35000,fields:{host:'host',pod:runs.at(-1).pod,comparison_runs:JSON.stringify(runs)}});
test('exact phases retain original times and stable sampling', () => {
  const a = chartRequest(config, context([before], 'finished')), b = chartRequest(config, context([before, after]));
  assert.deepEqual(a.runs[0],b.runs[0]); assert.equal(b.from,5000); assert.equal(b.to,0); assert.equal(a.stepSeconds,b.stepSeconds);
  assert.equal(chartRequest(config,context([before,after],'finished')).to,35000);
});
test('missing identity and malformed comparisons never widen to cluster scope', () => {
  assert.throws(() => chartRequest(config,{}));
  assert.throws(() => chartRequest(config,{...context([before]),fields:{host:'All',pod:'first'}}));
  for (const runs of [[before,{...after,phase:'before'}],[before,{...after,from:19000}], [{...before,to:0},after]]) assert.throws(() => chartRequest(config,context(runs)));
  const c = context([before,after]); c.fields.pod='wrong'; assert.throws(() => chartRequest(config,c));
});
test('chart spec and unit contract', () => {
  validateChart(config.chart,config.binding);
  assert.throws(() => validateChart({...config.chart,metric:'arbitrary-sql'},config.binding));
  assert.throws(() => validateChart({...config.chart,colors:{after:'red'}},config.binding));
  assert.equal(formatValue(2500000,'ns'),'2.5 ms'); assert.equal(formatValue(1048576,'B/s'),'1 MiB/s'); assert.equal(formatValue(null,'ns'),'—');
});
test('AI receives evidence with explicit truncation and stale status', () => {
  const e=chartEvidence({series:[{phase:'before',points:Array.from({length:50},(_,i)=>[i,i])}],unit:'ns'},'offline');
  assert.equal(e.stale,true); assert.equal(e.series[0].points.length,24); assert.equal(e.series[0].max,49); assert.equal(e.series[0].points_truncated,true);
});
