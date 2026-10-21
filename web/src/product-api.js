import {validateDeck, validateDeckReport, DeckStore, panelConfig, slidePanels, commandIndex, singleLineCommand} from './model.js';
import {RunContexts} from './runtime.js';
import {chartRequest, METRIC_IDS} from './chart-model.js';
import {hasTerminalTab, terminalSessionId} from './tabs.js';

export const PRODUCT_API_VERSION = 1;
export const PRODUCT_OPERATIONS = Object.freeze([
  'chart.set',
  'monitor.set',
  'command.update',
  'terminal.prepare',
]);

const CHART_PATCH_FIELDS = new Set(['metric', 'stepSeconds', 'comparisonField', 'colors']);
const COMMAND_PATCH_FIELDS = new Set(['title', 'command', 'note', 'tab']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function productIssue(code, message, path = null) {
  return {code, message, path};
}

function productError(code, message, path = null) {
  const error = new Error(message);
  error.code = code;
  error.issues = [productIssue(code, message, path)];
  return error;
}

function pointerEscape(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function effectiveRevision(value) {
  let hash = 2166136261;
  for (const character of canonical(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `deck-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function deepDiff(before, after, path = '', changes = []) {
  if (Object.is(before, after)) return changes;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index++) {
      const child = `${path}/${index}`;
      if (index >= before.length) changes.push({op:'add', path:child, after:structuredClone(after[index])});
      else if (index >= after.length) changes.push({op:'remove', path:child, before:structuredClone(before[index])});
      else deepDiff(before[index], after[index], child, changes);
    }
    return changes;
  }
  if (object(before) && object(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const child = `${path}/${pointerEscape(key)}`;
      if (!Object.hasOwn(before, key)) changes.push({op:'add', path:child, after:structuredClone(after[key])});
      else if (!Object.hasOwn(after, key)) changes.push({op:'remove', path:child, before:structuredClone(before[key])});
      else deepDiff(before[key], after[key], child, changes);
    }
    return changes;
  }
  changes.push({op:'replace', path, before:structuredClone(before), after:structuredClone(after)});
  return changes;
}

export function validateMetricCatalog(catalog) {
  if (!object(catalog) || catalog.version !== 1 || !object(catalog.metrics)) throw productError('CATALOG_INVALID', '指标目录需要 version 1 和 metrics 对象');
  for (const id of METRIC_IDS) {
    const metric = catalog.metrics[id];
    const path = `/metrics/${pointerEscape(id)}`;
    if (!object(metric)) throw productError('CATALOG_INVALID', `指标目录缺少 ${id}`, path);
    for (const field of ['label', 'description', 'table', 'metric', 'instance', 'aggregate', 'unit', 'scope']) {
      if (typeof metric[field] !== 'string' || !metric[field].trim()) throw productError('CATALOG_INVALID', `指标 ${id} 缺少 ${field}`, `${path}/${field}`);
    }
    if (!Array.isArray(metric.comparisons) || !metric.comparisons.includes('current')) throw productError('CATALOG_INVALID', `指标 ${id} 需要声明 current 比较能力`, `${path}/comparisons`);
    if (!Array.isArray(metric.requiredRunFields) || !metric.requiredRunFields.includes('host') || !metric.requiredRunFields.includes('pod')) throw productError('CATALOG_INVALID', `指标 ${id} 需要 host/pod 运行字段`, `${path}/requiredRunFields`);
  }
  return catalog;
}

export function metricCatalog(catalog) {
  return structuredClone(validateMetricCatalog(catalog));
}

function targetPanel(operation) {
  const target = operation?.target ?? operation?.panel;
  if (typeof target !== 'string' || !target) throw productError('TARGET_REQUIRED', `${operation?.type || '操作'} 需要 target 面板 ID`);
  return target;
}

function mergeChartPatch(operation) {
  const patch = object(operation.patch) ? {...operation.patch} : {};
  if (operation.metricRef !== undefined) patch.metric = operation.metricRef;
  if (operation.metric !== undefined) patch.metric = operation.metric;
  if (operation.stepSeconds !== undefined) patch.stepSeconds = operation.stepSeconds;
  if (operation.comparisonField !== undefined) patch.comparisonField = operation.comparisonField;
  if (operation.colors !== undefined) patch.colors = operation.colors;
  return patch;
}

function applyChartPatch(next, id, patch) {
  const dashboard = next.dashboards?.[id];
  if (!object(dashboard) || !object(dashboard.chart)) throw productError('CHART_REQUIRED', `面板 ${id} 不是 Live Deck 时序图`, `/dashboards/${pointerEscape(id)}/chart`);
  for (const key of Object.keys(patch)) {
    if (!CHART_PATCH_FIELDS.has(key)) throw productError('FIELD_NOT_SUPPORTED', `chart.set 不支持字段 ${key}`, `/patch/${pointerEscape(key)}`);
  }
  if (patch.metric !== undefined) dashboard.chart.metric = patch.metric;
  if (patch.stepSeconds !== undefined) dashboard.chart.stepSeconds = patch.stepSeconds;
  if (patch.comparisonField !== undefined) dashboard.chart.comparisonField = patch.comparisonField;
  if (patch.colors !== undefined) dashboard.chart.colors = {...dashboard.chart.colors, ...patch.colors};
}

function applyMonitorView(dashboard, operation) {
  if (operation.view === undefined) return;
  if (!object(operation.view)) throw productError('VIEW_INVALID', 'monitor.set view 必须是对象', '/view');
  if (operation.view.mode !== undefined && !['current', 'phase-timeline'].includes(operation.view.mode)) throw productError('VIEW_INVALID', 'view.mode 只能是 current 或 phase-timeline', '/view/mode');
  if (operation.view.phases !== undefined && (!Array.isArray(operation.view.phases) || operation.view.phases.length > 2 || operation.view.phases.some(phase => !['current', 'before', 'after'].includes(phase)))) throw productError('VIEW_INVALID', 'view.phases 只能包含 current、before、after', '/view/phases');
  if (operation.view.timeAxis !== undefined && operation.view.timeAxis !== 'wall-clock') throw productError('VIEW_NOT_SUPPORTED', '当前只支持 wall-clock 时间轴', '/view/timeAxis');
  if (operation.view.retainCompleted !== undefined && operation.view.retainCompleted !== true) throw productError('VIEW_NOT_SUPPORTED', '当前产品语义始终保留已完成阶段', '/view/retainCompleted');
  if (operation.view.resetOn !== undefined && operation.view.resetOn !== 'before') throw productError('VIEW_NOT_SUPPORTED', '当前只支持在新 before 开始时重置比较', '/view/resetOn');
  if (operation.view.mode === 'phase-timeline') {
    const phases = operation.view.phases || ['before', 'after'];
    if (phases.length !== 2 || phases[0] !== 'before' || phases[1] !== 'after') throw productError('VIEW_INVALID', 'phase-timeline 需要 before、after 两个阶段', '/view/phases');
    if (!dashboard.binding) throw productError('BINDING_REQUIRED', 'phase-timeline 需要绑定运行终端', '/binding');
    dashboard.chart.comparisonField ||= operation.comparisonField || 'comparison_runs';
  } else if (operation.view.mode === 'current') {
    delete dashboard.chart.comparisonField;
  }
  if (operation.view.colors !== undefined) dashboard.chart.colors = {...dashboard.chart.colors, ...operation.view.colors};
}

function prepareOperationUnsafe(deck, operation, catalog, expectedRevision) {
  if (!object(operation) || !PRODUCT_OPERATIONS.includes(operation.type)) throw productError('OPERATION_INVALID', `操作类型需要是 ${PRODUCT_OPERATIONS.join('、')}`);
  const beforeRevision = effectiveRevision(deck);
  if (expectedRevision && expectedRevision !== beforeRevision) throw productError('REVISION_CONFLICT', `期望版本 ${expectedRevision} 与当前版本 ${beforeRevision} 不一致`, '/expectedRevision');
  const id = targetPanel(operation);
  const next = structuredClone(deck);
  let runtimeOperation = null;
  if (operation.type === 'chart.set') {
    applyChartPatch(next, id, mergeChartPatch(operation));
  } else if (operation.type === 'monitor.set') {
    const dashboard = next.dashboards?.[id];
    if (!object(dashboard) || !object(dashboard.chart)) throw productError('CHART_REQUIRED', `面板 ${id} 不是 Live Deck 时序图`, `/dashboards/${pointerEscape(id)}/chart`);
    applyChartPatch(next, id, mergeChartPatch(operation));
    applyMonitorView(dashboard, operation);
  } else if (operation.type === 'command.update') {
    const terminal = next.terminals?.[id];
    if (!object(terminal)) throw productError('TERMINAL_REQUIRED', `面板 ${id} 不是终端`, `/terminals/${pointerEscape(id)}`);
    const index = commandIndex(terminal, operation.command);
    if (index < 0) throw productError('COMMAND_NOT_FOUND', `终端 ${id} 中找不到命令 ${operation.command}`, `/terminals/${pointerEscape(id)}/commands`);
    if (!object(operation.patch)) throw productError('PATCH_REQUIRED', 'command.update 需要 patch 对象', '/patch');
    for (const key of Object.keys(operation.patch)) if (!COMMAND_PATCH_FIELDS.has(key)) throw productError('FIELD_NOT_SUPPORTED', `command.update 不支持字段 ${key}`, `/patch/${pointerEscape(key)}`);
    Object.assign(terminal.commands[index], structuredClone(operation.patch));
  } else {
    const terminal = next.terminals?.[id];
    if (!object(terminal)) throw productError('TERMINAL_REQUIRED', `面板 ${id} 不是终端`, `/terminals/${pointerEscape(id)}`);
    const tab = operation.tab || 'main';
    if (!hasTerminalTab(terminal, tab)) throw productError('TAB_NOT_FOUND', `终端 ${id} 中找不到 tab ${tab}`, `/terminals/${pointerEscape(id)}/tabs`);
    if (typeof operation.text !== 'string') throw productError('TEXT_REQUIRED', 'terminal.prepare 需要 text', '/text');
    singleLineCommand(operation.text);
    runtimeOperation = {type:'draft.prepare', panel:id, tab, text:operation.text};
  }
  const validated = validateDeck(next);
  const metric = validated.dashboards?.[id]?.chart?.metric;
  if (metric) {
    const definition = catalog?.metrics?.[metric];
    if (!definition) throw productError('METRIC_NOT_FOUND', `指标目录中没有 ${metric}`, `/dashboards/${pointerEscape(id)}/chart/metric`);
    if (validated.dashboards[id].chart.comparisonField && !definition.comparisons?.includes('before-after')) throw productError('COMPARISON_NOT_SUPPORTED', `${definition.label} 不支持 before/after 比较`, `/dashboards/${pointerEscape(id)}/chart/comparisonField`);
  }
  return {
    deck:validated,
    affectedPanels:[id],
    diff:deepDiff(deck, validated),
    beforeRevision,
    afterRevision:effectiveRevision(validated),
    runtimeOperation,
  };
}

export function prepareOperation(deck, operation, {catalog, expectedRevision} = {}) {
  validateMetricCatalog(catalog);
  return prepareOperationUnsafe(deck, operation, catalog, expectedRevision);
}

export function previewOperation(deck, operation, {catalog, expectedRevision} = {}) {
  try {
    const prepared = prepareOperation(deck, operation, {catalog, expectedRevision});
    const validation = validateProduct(prepared.deck, {catalog, replay:false});
    return {
      status:validation.valid ? 'ready' : 'rejected',
      operationType:operation?.type || null,
      affectedPanels:prepared.affectedPanels,
      diff:prepared.diff,
      effectiveRevision:prepared.beforeRevision,
      nextRevision:prepared.afterRevision,
      runtimeOperation:prepared.runtimeOperation,
      issues:validation.issues,
    };
  } catch (error) {
    return {
      status:'rejected',
      operationType:operation?.type || null,
      affectedPanels:[],
      diff:[],
      effectiveRevision:effectiveRevision(deck),
      nextRevision:null,
      runtimeOperation:null,
      issues:error.issues || [productIssue(error.code || 'OPERATION_FAILED', error.message)],
    };
  }
}

function cloneRun(run) {
  if (!run) return null;
  return structuredClone(run);
}

function deriveRunPhases(run, comparisonField) {
  if (!run) return {phases:[], error:null};
  if (comparisonField && run.fields?.[comparisonField]) {
    try {
      const phases = JSON.parse(run.fields[comparisonField]);
      if (!Array.isArray(phases)) return {phases:[], error:'运行阶段记录不是数组'};
      return {
        phases:phases.map(phase => ({
          phase:phase.phase,
          host:phase.host,
          pod:phase.pod,
          from:phase.from,
          to:phase.to || null,
          status:phase.to ? 'complete' : 'open',
        })),
        error:null,
      };
    } catch {
      return {phases:[], error:'运行阶段记录不是有效 JSON'};
    }
  }
  if (typeof run.fields?.host === 'string' && typeof run.fields?.pod === 'string' && Number.isSafeInteger(run.started_at_ms)) {
    return {
      phases:[{
        phase:'current',
        host:run.fields.host,
        pod:run.fields.pod,
        from:run.started_at_ms,
        to:run.status === 'finished' ? run.ended_at_ms || null : null,
        status:run.status === 'finished' ? 'complete' : 'open',
      }],
      error:null,
    };
  }
  return {phases:[], error:null};
}

export function inspectState({deck, sourceDeck, store, workspace, sequence, charts, catalog, currentSlideIndex, currentGroup, currentPanel}) {
  const capturedAtMs = Date.now();
  const slide = deck.slides[currentSlideIndex] || deck.slides[0];
  const visible = slidePanels(slide, deck, currentGroup);
  const runs = store.data.runs || {};
  const missing = [];
  const experiments = new Map();
  const panels = [...new Set([...Object.keys(deck.terminals || {}), ...Object.keys(deck.dashboards || {})])].map(id => {
    const config = panelConfig(deck, id), state = store.terminal(id), dashboard = Object.hasOwn(deck.dashboards || {}, id);
    const runKey = dashboard && config.binding ? terminalSessionId(config.binding.terminal, config.binding.tab) : null;
    const run = runKey ? runs[runKey] : null;
    if (runKey) {
      let experiment = experiments.get(runKey);
      if (!experiment) {
        const derived = deriveRunPhases(run, config.chart?.comparisonField);
        if (derived.error) missing.push(`${config.label || id}：${derived.error}`);
        experiment = {
          id:runKey,
          runKey,
          panels:[],
          runId:run?.run_id || null,
          status:run?.status || 'unknown',
          fields:run?.fields ? structuredClone(run.fields) : {},
          phases:derived.phases,
        };
        experiments.set(runKey, experiment);
      }
      experiment.panels.push(id);
    }
    if (dashboard && config.chart && !run) missing.push(`${config.label || id}：等待运行信息`);
    if (dashboard && config.chart && run) {
      for (const field of ['host', 'pod']) if (typeof run.fields?.[field] !== 'string' || !run.fields[field] || run.fields[field].toLowerCase() === 'all') missing.push(`${config.label || id}：缺少明确的 ${field}`);
    }
    return {
      id,
      kind:dashboard ? 'dashboard' : 'terminal',
      label:config.label || id,
      active:currentPanel === id,
      visible:visible.includes(id),
      activeTab:dashboard ? null : workspace?.activeTab?.(id) || state.activeTab || 'main',
      preparedTab:dashboard ? null : state.preparedTab || null,
      follow:dashboard ? workspace?.follows?.(id) ?? state.follow !== false : null,
      baseUrl:dashboard ? state.baseUrl || config.url || null : null,
      resolvedUrl:dashboard ? state.url || null : null,
      binding:config.binding || null,
      chart:config.chart || null,
      metricDefinition:config.chart?.metric ? cloneRun(catalog?.metrics?.[config.chart.metric]) : null,
      runKey,
      run:cloneRun(run),
      chartRequest:cloneRun(state.chartRequest),
      chartEvidence:charts?.context?.(id) || null,
      conversationCount:state.conversation?.length || 0,
      nextAction:sequence?.next?.panel === id ? {index:sequence.next.index, command:sequence.next.command, tab:sequence.next.tab || null} : null,
    };
  });
  const activeRevision = effectiveRevision(deck), publishedRevision = sourceDeck ? effectiveRevision(sourceDeck) : null;
  return {
    version:PRODUCT_API_VERSION,
    capturedAtMs,
    deck:{
      id:deck.id,
      title:deck.title,
      revision:deck.revision || null,
      monitoringRevision:deck.monitoringRevision || null,
      publishedRevision,
      effectiveRevision:activeRevision,
      configSource:publishedRevision === null ? 'unknown' : publishedRevision === activeRevision ? 'published' : 'browser',
    },
    view:{
      slideIndex:currentSlideIndex,
      slideCount:deck.slides.length,
      slideTitle:slide.title,
      slideType:slide.type,
      monitorGroup:currentGroup || null,
      visiblePanels:visible,
      currentPanel,
    },
    sequence:sequence ? {cursor:sequence.state.cursor, total:sequence.steps.length, next:sequence.next ? {panel:sequence.next.panel, command:sequence.next.command, tab:sequence.next.tab || null} : null} : null,
    runs:Object.fromEntries(Object.entries(runs).map(([key, run]) => [key, cloneRun(run)])),
    experiments:[...experiments.values()],
    panels,
    capabilities:{
      operations:[...PRODUCT_OPERATIONS],
      metricCatalog:metricCatalog(catalog),
      constraints:[
        '只查询运行实际上报的精确 host/pod，缺少时不退回 All',
        'apply 不会执行终端命令，也不会倒退真实运行状态',
        'before/after 曲线保留真实时间轴、停机空档和已完成阶段',
      ],
    },
    missing:[...new Set(missing)],
  };
}

function checkStep(checks, name, callback) {
  try {
    const detail = callback();
    checks.push({name, ok:true, detail:detail ?? null});
  } catch (error) {
    checks.push({name, ok:false, error:error.message});
  }
}

function replayChartLifecycle(deck, catalog, requestedPanel) {
  const candidates = Object.entries(deck.dashboards || {}).filter(([, config]) => config.chart?.type === 'timeseries');
  const entry = requestedPanel ? candidates.find(([id]) => id === requestedPanel) : candidates[0];
  if (!entry) return {ok:true, panel:null, checks:[], note:'当前文稿没有 Live Deck 时序图'};
  const [id, config] = entry;
  if (!config.binding) return {ok:false, panel:id, checks:[{name:'运行绑定', ok:false, error:'时序图需要绑定运行终端'}]};
  const key = terminalSessionId(config.binding.terminal, config.binding.tab);
  const values = new Map();
  const storage = {getItem:name => values.get(name), setItem:(name, value) => values.set(name, value)};
  const store = new DeckStore({id:`product-api-replay-${id}`}, storage);
  const runs = new RunContexts(store);
  const checks = [];
  const base = 1700000000000;
  const host = 'live-deck-replay-host';
  const comparison = config.chart.comparisonField;
  if (comparison) {
    const before = {host, pod:`${id}-before`, phase:'before', from:base, to:base + 1000};
    const after = {host, pod:`${id}-after`, phase:'after', from:base + 2000, to:0};
    checkStep(checks, 'before 事件建立单阶段请求', () => {
      const accepted = runs.accept(key, {version:1,event:'started',event_id:'replay-before-start',run_id:'replay-before',
        started_at_ms:before.from,at_ms:before.from,fields:{host,pod:before.pod,[comparison]:JSON.stringify([before])}});
      if (!accepted) throw new Error('before 事件未被接受');
      const request = chartRequest(config, runs.get(key));
      if (request.runs.length !== 1 || request.runs[0].phase !== 'before') throw new Error('before 请求没有唯一边界');
      return {runs:request.runs.length, phase:request.runs[0].phase};
    });
    runs.accept(key, {version:1,event:'finished',event_id:'replay-before-finish',run_id:'replay-before',
      started_at_ms:before.from,at_ms:before.to,fields:{}});
    checkStep(checks, 'after 事件保留 before 并追加当前阶段', () => {
      const accepted = runs.accept(key, {version:1,event:'started',event_id:'replay-after-start',run_id:'replay-after',
        started_at_ms:after.from,at_ms:after.from,fields:{host,pod:after.pod,[comparison]:JSON.stringify([before,after])}});
      if (!accepted) throw new Error('after 事件未被接受');
      const request = chartRequest(config, runs.get(key));
      if (request.runs.map(run => run.phase).join(',') !== 'before,after') throw new Error('阶段顺序不是 before,after');
      return {runs:request.runs.map(run => run.phase)};
    });
    checkStep(checks, '重复事件不会改变当前运行', () => {
      const accepted = runs.accept(key, {version:1,event:'started',event_id:'replay-after-start',run_id:'replay-after',
        started_at_ms:after.from,at_ms:after.from,fields:{host,pod:after.pod}});
      if (accepted) throw new Error('重复事件被错误接受');
      return {accepted:false};
    });
    checkStep(checks, 'after 结束后冻结真实终点', () => {
      const accepted = runs.accept(key, {version:1,event:'finished',event_id:'replay-after-finish',run_id:'replay-after',
        started_at_ms:after.from,at_ms:base + 3000,exit_code:0,fields:{}});
      if (!accepted) throw new Error('after 结束事件未被接受');
      const request = chartRequest(config, runs.get(key));
      if (request.to !== base + 3000) throw new Error('结束后时间窗没有冻结');
      return {to:request.to};
    });
    checkStep(checks, '结束后的迟到更新不会回滚状态', () => {
      const accepted = runs.accept(key, {version:1,event:'update',event_id:'replay-late',run_id:'replay-after',
        started_at_ms:after.from,at_ms:base + 3001,fields:{host,pod:'late'}});
      if (accepted) throw new Error('迟到事件被错误接受');
      return {accepted:false};
    });
  } else {
    const current = {host,pod:`${id}-current`,from:base,to:0};
    checkStep(checks, '当前运行建立精确实例请求', () => {
      const accepted = runs.accept(key, {version:1,event:'started',event_id:'replay-current-start',run_id:'replay-current',
        started_at_ms:current.from,at_ms:current.from,fields:{host,pod:current.pod}});
      if (!accepted) throw new Error('当前运行事件未被接受');
      const request = chartRequest(config, runs.get(key));
      if (request.runs.length !== 1 || request.runs[0].pod !== current.pod) throw new Error('请求没有绑定唯一实例');
      return {pod:request.runs[0].pod};
    });
    checkStep(checks, '当前运行结束后冻结时间窗', () => {
      const accepted = runs.accept(key, {version:1,event:'finished',event_id:'replay-current-finish',run_id:'replay-current',
        started_at_ms:current.from,at_ms:base + 1000,exit_code:0,fields:{}});
      if (!accepted) throw new Error('结束事件未被接受');
      const request = chartRequest(config, runs.get(key));
      if (request.to !== base + 1000) throw new Error('结束后时间窗没有冻结');
      return {to:request.to};
    });
  }
  const definition = catalog.metrics[config.chart.metric];
  checkStep(checks, '指标口径来自共享目录', () => {
    if (!definition) throw new Error(`目录缺少 ${config.chart.metric}`);
    return {metric:definition.metric, instance:definition.instance, aggregate:definition.aggregate, unit:definition.unit};
  });
  return {ok:checks.every(check => check.ok), panel:id, checks};
}

export function validateProduct(deck, {catalog, operation, replay = true, panel} = {}) {
  const issues = [];
  let candidate = deck;
  try {
    validateMetricCatalog(catalog);
    if (operation) candidate = prepareOperationUnsafe(deck, operation, catalog).deck;
    const report = validateDeckReport(candidate);
    if (!report.valid) {
      issues.push(...report.issues);
    } else {
      candidate = validateDeck(candidate);
    }
  } catch (error) {
    issues.push(...(error.issues || [productIssue(error.code || 'DECK_INVALID', error.message)]));
  }
  if (!issues.length) {
    for (const [id, config] of Object.entries(candidate.dashboards || {})) {
      if (!config.chart) continue;
      const definition = catalog.metrics[config.chart.metric];
      if (!definition) issues.push(productIssue('METRIC_NOT_FOUND', `指标目录中没有 ${config.chart.metric}`, `/dashboards/${pointerEscape(id)}/chart/metric`));
      else if (config.chart.comparisonField && !definition.comparisons.includes('before-after')) issues.push(productIssue('COMPARISON_NOT_SUPPORTED', `${definition.label} 不支持 before/after 比较`, `/dashboards/${pointerEscape(id)}/chart/comparisonField`));
    }
  }
  const replayResult = replay && !issues.length ? replayChartLifecycle(candidate, catalog, panel) : {ok:null, checks:[], panel:panel || null};
  if (replayResult.ok === false) {
    for (const check of replayResult.checks.filter(item => !item.ok)) issues.push(productIssue('REPLAY_FAILED', `${check.name}：${check.error}`, `/dashboards/${pointerEscape(replayResult.panel || '')}`));
  }
  return {
    valid:issues.length === 0,
    checkedAtMs:Date.now(),
    effectiveRevision:effectiveRevision(candidate),
    levels:{
      static:{ok:!issues.some(issue => !['METRIC_NOT_FOUND', 'COMPARISON_NOT_SUPPORTED', 'CHART_REQUIRED', 'REPLAY_FAILED'].includes(issue.code))},
      capabilities:{ok:!issues.some(issue => ['METRIC_NOT_FOUND', 'COMPARISON_NOT_SUPPORTED', 'CHART_REQUIRED'].includes(issue.code))},
      replay:{ok:replayResult.ok, panel:replayResult.panel, checks:replayResult.checks, note:replayResult.note || null},
    },
    issues,
  };
}
