export const METRIC_IDS = ['fuse-read-rate', 'fuse-read-latency', 'blob-read-throughput', 'blob-read-latency'];
export const PHASE_COLORS = {before:'#73bf69', after:'#ff9830', current:'#73bf69'};
export const PHASE_LABELS = {before:'原版 · before', after:'补丁 · after', current:'本次运行'};
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.():-]{0,199}$/.test(value) && value.toLowerCase() !== 'all';
const stamp = value => Number.isSafeInteger(value) && value >= 0;

export function validateChart(chart, binding) {
  if (!chart || chart.type !== 'timeseries' || !METRIC_IDS.includes(chart.metric)) throw new Error('chart 需要有效的时序指标');
  if (!binding) throw new Error('时序图需要绑定运行终端');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(chart.datasource || '') || !/^hf3fs_[A-Za-z0-9_]+$/.test(chart.database || '')) throw new Error('chart 数据源或数据库无效');
  if (chart.stepSeconds !== undefined && (!Number.isInteger(chart.stepSeconds) || chart.stepSeconds < 2 || chart.stepSeconds > 60)) throw new Error('chart.stepSeconds 需要在 2–60 之间');
  if (chart.comparisonField !== undefined && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(chart.comparisonField)) throw new Error('chart.comparisonField 无效');
  if (chart.colors !== undefined && (!chart.colors || Array.isArray(chart.colors) || Object.entries(chart.colors).some(([key, color]) => !Object.hasOwn(PHASE_COLORS, key) || !/^#[0-9a-fA-F]{6}$/.test(color)))) throw new Error('chart.colors 需要阶段对应的十六进制颜色');
}

export function chartRequest(config, run) {
  const chart = config.chart, fields = run?.fields || {};
  if (!run || !identity(fields.host) || !identity(fields.pod) || !stamp(run.started_at_ms)) throw new Error('等待本次 host / pod 和开始时间');
  let runs;
  if (chart.comparisonField && fields[chart.comparisonField]) {
    try { runs = JSON.parse(fields[chart.comparisonField]); } catch { throw new Error('运行阶段记录无效'); }
    if (!Array.isArray(runs)) throw new Error('运行阶段记录无效');
  }
  if (!runs?.length) runs = [{host:fields.host, pod:fields.pod, from:run.started_at_ms,
    to:run.status === 'finished' ? run.ended_at_ms : 0, phase:'current'}];
  if (!Array.isArray(runs) || runs.length > 2 || runs.some(r => !identity(r.host) || !identity(r.pod) || !stamp(r.from) || !stamp(r.to) || r.to && r.to < r.from || !Object.hasOwn(PHASE_COLORS, r.phase)) || new Set(runs.map(r => r.phase)).size !== runs.length) throw new Error('运行阶段记录无效');
  const current = runs.at(-1);
  if (current.host !== fields.host || current.pod !== fields.pod || current.from !== run.started_at_ms) throw new Error('运行阶段与当前实例不一致');
  if (runs.length === 2 && (runs[0].phase !== 'before' || current.phase !== 'after' || !runs[0].to || runs[0].to > current.from)) throw new Error('before / after 时间顺序无效');
  if (run.status === 'finished' && !stamp(run.ended_at_ms)) throw new Error('等待结束时间');
  return {metric:chart.metric, datasource:chart.datasource, database:chart.database, stepSeconds:chart.stepSeconds || 2,
    from:Math.max(0, runs[0].from - (config.binding.lookbackMs ?? 5000)),
    to:run.status === 'finished' ? run.ended_at_ms : 0,
    runs:runs.map(r => ({host:r.host, pod:r.pod, phase:r.phase, from:r.from, to:r.to}))};
}

export function formatValue(value, unit) {
  if (value === null || !Number.isFinite(value)) return '—';
  let scale = 1, suffix = unit;
  if (unit === 'ns') {
    if (Math.abs(value) >= 1e9) {scale = 1e9; suffix = 's';}
    else if (Math.abs(value) >= 1e6) {scale = 1e6; suffix = 'ms';}
    else if (Math.abs(value) >= 1e3) {scale = 1e3; suffix = 'μs';}
  } else if (unit === 'B/s') {
    for (const [size, label] of [[2**30,'GiB/s'],[2**20,'MiB/s'],[1024,'KiB/s']]) if (Math.abs(value) >= size) {scale = size; suffix = label; break;}
  } else if (unit === 'ops/s' && Math.abs(value) >= 1000) {scale = 1000; suffix = 'kops/s';}
  return `${Number((value / scale).toPrecision(4))} ${suffix}`;
}

export function chartEvidence(data, error) {
  if (!data) return {error:error || null, note:'尚未读取数据'};
  return {metric:data.metric, instance:data.instance, aggregate:data.aggregate, unit:data.unit,
    from:data.from, to:data.to, step_ms:data.step_ms, queried_at_ms:data.queried_at_ms,
    queries:data.queries, source_url:data.source_url, stale:!!error, error:error || null,
    series:data.series.map(s => {
      const valid = s.points.filter(p => p[1] !== null), values = valid.map(p => p[1]);
      return {...s, points:s.points.slice(-24), points_truncated:s.points.length > 24, point_count:s.points.length,
        min:values.length ? Math.min(...values) : null, max:values.length ? Math.max(...values) : null, last:valid.at(-1) || null};
    })};
}
