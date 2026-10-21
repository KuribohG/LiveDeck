import {validateBinding} from './runtime.js';
import {validateChart} from './chart-model.js';
import {hasTerminalTab} from './tabs.js';

export function validateDeck(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('演示文件必须是 JSON 对象');
  if (input.format !== undefined && input.format !== 'live-deck') throw new Error('format 必须是 live-deck');
  if (input.version !== undefined && input.version !== 1) throw new Error('当前仅支持 Live Deck version 1');
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id)) throw new Error('id 需要 1–80 个字母、数字、下划线或短横线');
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('请填写 title');
  if (input.monitoringRevision !== undefined && (typeof input.monitoringRevision !== 'string' || !input.monitoringRevision.trim())) throw new Error('monitoringRevision 必须是非空字符串');
  if (input.revision !== undefined && (typeof input.revision !== 'string' || !input.revision.trim())) throw new Error('revision 必须是非空字符串');
  if (!Array.isArray(input.slides) || !input.slides.length) throw new Error('slides 需要包含至少一页');
  const terminals = input.terminals === undefined ? {} : input.terminals;
  if (!terminals || typeof terminals !== 'object' || Array.isArray(terminals)) throw new Error('terminals 必须是对象');
  for (const [id, terminal] of Object.entries(terminals)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error(`终端 ID 无效：${id}`);
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) throw new Error(`终端 ${id} 配置无效`);
    if (terminal.cwd !== undefined && typeof terminal.cwd !== 'string') throw new Error(`终端 ${id} 的 cwd 必须是字符串`);
    if (terminal.independentSequence !== undefined && typeof terminal.independentSequence !== 'boolean') throw new Error(`终端 ${id} 的 independentSequence 必须是布尔值`);
    if (terminal.tabs !== undefined) {
      if (!terminal.tabs || typeof terminal.tabs !== 'object' || Array.isArray(terminal.tabs)) throw new Error(`终端 ${id} 的 tabs 必须是对象`);
      for (const [tabId, tab] of Object.entries(terminal.tabs)) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(tabId) || ['__proto__', 'constructor', 'prototype'].includes(tabId)) throw new Error(`终端 tab ID 无效：${tabId}`);
        if (!tab || typeof tab !== 'object' || Array.isArray(tab) || (tab.label !== undefined && (typeof tab.label !== 'string' || !tab.label.trim())) || (tab.cwd !== undefined && typeof tab.cwd !== 'string')) throw new Error(`终端 ${id} 的 tab ${tabId} 配置无效`);
      }
    }
    if (!Array.isArray(terminal.commands)) throw new Error(`终端 ${id} 的 commands 需要是数组`);
    for (const command of terminal.commands) {
      if (!command || typeof command.command !== 'string' || typeof command.title !== 'string') throw new Error(`终端 ${id} 的每条命令需要 title 和 command`);
      if (command.expect !== undefined && typeof command.expect !== 'string') throw new Error(`终端 ${id} 的命令 expect 必须是字符串`);
      if (command.tab !== undefined && !hasTerminalTab(terminal, command.tab)) throw new Error(`终端 ${id} 的命令引用了不存在的 tab`);
    }
  }
  const dashboards = input.dashboards === undefined ? {} : input.dashboards;
  if (!dashboards || typeof dashboards !== 'object' || Array.isArray(dashboards)) throw new Error('dashboards 必须是对象');
  for (const [id, config] of Object.entries(dashboards)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || Object.hasOwn(terminals, id)) throw new Error(`面板 ID 无效或重复：${id}`);
    if (!config || Array.isArray(config) || !Array.isArray(config.commands)) throw new Error(`图表 ${id} 的 commands 需要是数组`);
    if (config.url !== undefined) webUrl(config.url);
    if (config.chart !== undefined) validateChart(config.chart, config.binding);
    if (config.binding !== undefined) validateBinding(config.binding, terminals);
    for (const command of config.commands) {
      if (typeof command?.title !== 'string' || typeof command.command !== 'string') throw new Error(`图表 ${id} 的动作需要 title 和 command（URL）`);
      webUrl(command.command);
      if (command.tab !== undefined) throw new Error('图表动作不能指定终端 tab');
    }
  }
  const panels = {...terminals, ...dashboards};
  const groups = input.monitorGroups || {};
  if (typeof groups !== 'object' || Array.isArray(groups) || input.monitorGroups === null) throw new Error('monitorGroups 必须是对象');
  for (const [id, group] of Object.entries(groups)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error(`监控组 ID 无效：${id}`);
    if (!group || typeof group.label !== 'string' || !Array.isArray(group.panels) || !group.panels.length || new Set(group.panels).size !== group.panels.length) throw new Error(`监控组 ${id} 需要 label 和不重复的 panels`);
    for (const panel of group.panels) if (typeof panel !== 'string' || !Object.hasOwn(dashboards, panel)) throw new Error(`监控组引用了不存在的图表：${panel}`);
  }
  for (const [id, panel] of Object.entries(panels)) {
    if (panel.label !== undefined && typeof panel.label !== 'string') throw new Error(`面板 ${id} 的 label 必须是字符串`);
    const ids = new Set();
    for (const command of panel.commands) if (command.note !== undefined && typeof command.note !== 'string') throw new Error(`面板 ${id} 的命令 note 必须是字符串`);
    for (const command of panel.commands) if (command.id !== undefined) {
      if (typeof command.id !== 'string' || !command.id || ids.has(command.id)) throw new Error(`面板 ${id} 的命令 id 必须是唯一的非空字符串`);
      ids.add(command.id);
    }
  }
  const slideIds = new Set();
  for (const [slideIndex, slide] of input.slides.entries()) {
    if (!slide || !['slide', 'terminal', 'workspace'].includes(slide.type)) throw new Error('页面 type 只能是 slide、terminal 或 workspace');
    if (typeof slide.title !== 'string') throw new Error('每页需要 title');
    if (slide.id !== undefined && (typeof slide.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(slide.id))) throw new Error(`页面 ${slideIndex} 的 id 无效`);
    if (slide.id !== undefined && slideIds.has(slide.id)) throw new Error(`页面 id 重复：${slide.id}（页面 ${slideIndex}）`);
    if (slide.id !== undefined) slideIds.add(slide.id);
    if (slide.speakerNotes !== undefined && typeof slide.speakerNotes !== 'string') throw new Error(`页面 ${slideIndex} 的 speakerNotes 必须是字符串`);
    if (slide.type === 'terminal' && (typeof slide.terminal !== 'string' || !Object.hasOwn(terminals, slide.terminal))) throw new Error(`未定义终端：${slide.terminal}`);
    if (slide.type === 'slide' && slide.markdown !== undefined && typeof slide.markdown !== 'string') throw new Error('markdown 必须是字符串');
    if (slide.kicker !== undefined && typeof slide.kicker !== 'string') throw new Error('kicker 必须是字符串');
    if (slide.type === 'workspace') {
      if (!Array.isArray(slide.panels) || (!slide.panels.length && !slide.monitorGroups?.length) || new Set(slide.panels).size !== slide.panels.length) throw new Error('workspace 的 panels 需要包含不重复的面板 ID');
      for (const id of slide.panels) if (typeof id !== 'string' || !Object.hasOwn(panels, id)) throw new Error(`未定义面板：${id}`);
      if (slide.monitorGroups !== undefined) {
        if (!Array.isArray(slide.monitorGroups) || !slide.monitorGroups.length || new Set(slide.monitorGroups).size !== slide.monitorGroups.length) throw new Error('页面 monitorGroups 需要是不重复的监控组 ID 数组');
        for (const id of slide.monitorGroups) if (typeof id !== 'string' || !Object.hasOwn(groups, id)) throw new Error(`未定义监控组：${id}`);
        if (slide.monitorGroup !== undefined && !slide.monitorGroups.includes(slide.monitorGroup)) throw new Error('monitorGroup 必须出现在本页 monitorGroups 中');
      } else if (slide.monitorGroup !== undefined) throw new Error('monitorGroup 需要配合 monitorGroups 使用');
      if (slide.layout !== undefined && !['columns', 'rows', 'focus'].includes(slide.layout)) throw new Error('layout 只能是 columns、rows 或 focus');
    }
  }
  for (const [id, config] of Object.entries(panels)) for (const command of config.commands) {
    if (command.preview === undefined) continue;
    const preview = command.preview;
    if (!preview || typeof preview.panel !== 'string' || !Object.hasOwn(dashboards, preview.panel)) throw new Error(`面板 ${id} 的 preview 必须引用网页面板`);
    webUrl(preview.url);
    if (!input.slides.some(slide => {
      const ids = slidePanels(slide, input);
      return ids.includes(id) && ids.includes(preview.panel);
    })) throw new Error(`面板 ${id} 的 preview 必须与命令出现在同一页`);
  }
  if (input.sequence !== undefined && !Array.isArray(input.sequence)) throw new Error('sequence 必须是数组');
  for (const step of input.sequence || []) {
    if (step && Object.hasOwn(step, 'group')) {
      if (typeof step.group !== 'string' || !Object.hasOwn(groups, step.group) || Object.hasOwn(step, 'panel') || Object.hasOwn(step, 'command') || Object.hasOwn(step, 'tab') || !input.slides.some(slide => slide.monitorGroups?.includes(step.group))) throw new Error('sequence.group 需要引用具有对应页面的监控组，且不能混用 panel/command/tab');
      continue;
    }
    if (!step || typeof step.panel !== 'string' || !Object.hasOwn(panels, step.panel) || commandIndex(panels[step.panel], step.command) < 0) throw new Error('sequence 引用了不存在的面板或命令');
    if (step.tab !== undefined && (!Object.hasOwn(terminals, step.panel) || !hasTerminalTab(terminals[step.panel], step.tab))) throw new Error('sequence 引用了不存在的终端 tab');
    if (!input.slides.some(slide => slidePanels(slide, input).includes(step.panel))) throw new Error(`sequence 面板没有对应页面：${step.panel}`);
  }
  return structuredClone(input);
}

function issue(code, message, path, severity = 'error') {
  return {code, message, path, severity};
}

/**
 * Structured validation keeps validateDeck's throwing contract while exposing
 * a machine-readable first error with a JSON Pointer for product clients.
 */
export function validateDeckReport(input) {
  if (Array.isArray(input?.slides)) {
    const seen = new Map();
    for (const [index, slide] of input.slides.entries()) {
      if (typeof slide?.id !== 'string') continue;
      if (seen.has(slide.id)) {
        return {valid:false, issues:[issue('DUPLICATE_SLIDE_ID', `页面 id 重复：${slide.id}`, `/slides/${index}/id`)]};
      }
      seen.set(slide.id, index);
    }
  }
  try {
    validateDeck(input);
    return {valid:true, issues:[]};
  } catch (error) {
    if (/未定义终端/.test(error.message) && Array.isArray(input?.slides)) {
      const index = input.slides.findIndex(slide => slide?.type === 'terminal' && !Object.hasOwn(input.terminals || {}, slide.terminal));
      if (index >= 0) return {valid:false, issues:[issue('TERMINAL_REFERENCE_INVALID', error.message, `/slides/${index}/terminal`)]};
    }
    return {valid:false, issues:[issue('DECK_INVALID', error.message, null)]};
  }
}

const allowed = {
  deck:new Set(['$schema', 'format', 'version', 'id', 'title', 'monitoringRevision', 'revision', 'terminals', 'dashboards', 'monitorGroups', 'slides', 'sequence']),
  slide:new Set(['id', 'type', 'title', 'markdown', 'kicker', 'terminal', 'panels', 'monitorGroups', 'monitorGroup', 'layout', 'speakerNotes']),
  terminal:new Set(['label', 'cwd', 'commands', 'tabs', 'independentSequence']),
  tab:new Set(['label', 'cwd']),
  command:new Set(['id', 'title', 'command', 'note', 'tab', 'preview', 'expect']),
  preview:new Set(['panel', 'url']),
  dashboard:new Set(['label', 'url', 'commands', 'binding', 'chart']),
  binding:new Set(['terminal', 'tab', 'params', 'paramSuffixes', 'defaults', 'follow', 'singleInstance', 'freezeOnFinish', 'time', 'lookbackMs', 'refresh']),
  chart:new Set(['type', 'metric', 'datasource', 'database', 'stepSeconds', 'comparisonField', 'colors']),
  group:new Set(['label', 'panels']),
  step:new Set(['panel', 'group', 'command', 'tab']),
};

function unknownObjectFields(value, known, path, warnings) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) if (!known.has(key)) {
    warnings.push(issue('UNKNOWN_FIELD', `未知字段 ${key}；播放器会保留，但请确认拼写`, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, 'warning'));
  }
}

/** Non-blocking authoring lint. Unknown fields stay loadable for forward compatibility. */
export function lintDeck(input) {
  const warnings = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return warnings;
  unknownObjectFields(input, allowed.deck, '', warnings);
  for (const [id, terminal] of Object.entries(input.terminals || {})) {
    const base = `/terminals/${id.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    unknownObjectFields(terminal, allowed.terminal, base, warnings);
    for (const [tabId, tab] of Object.entries(terminal?.tabs || {})) unknownObjectFields(tab, allowed.tab, `${base}/tabs/${tabId}`, warnings);
    for (const [index, command] of (terminal?.commands || []).entries()) {
      const commandBase = `${base}/commands/${index}`;
      unknownObjectFields(command, allowed.command, commandBase, warnings);
      unknownObjectFields(command?.preview, allowed.preview, `${commandBase}/preview`, warnings);
    }
  }
  for (const [id, dashboard] of Object.entries(input.dashboards || {})) {
    const base = `/dashboards/${id.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    unknownObjectFields(dashboard, allowed.dashboard, base, warnings);
    unknownObjectFields(dashboard?.binding, allowed.binding, `${base}/binding`, warnings);
    unknownObjectFields(dashboard?.chart, allowed.chart, `${base}/chart`, warnings);
    for (const [index, command] of (dashboard?.commands || []).entries()) {
      const commandBase = `${base}/commands/${index}`;
      unknownObjectFields(command, allowed.command, commandBase, warnings);
      unknownObjectFields(command?.preview, allowed.preview, `${commandBase}/preview`, warnings);
    }
  }
  for (const [id, group] of Object.entries(input.monitorGroups || {})) unknownObjectFields(group, allowed.group, `/monitorGroups/${id}`, warnings);
  for (const [index, slide] of (input.slides || []).entries()) {
    unknownObjectFields(slide, allowed.slide, `/slides/${index}`, warnings);
    if (slide?.id === undefined) warnings.push(issue('SLIDE_ID_MISSING', '页面没有稳定 id；后续按页引用时更容易受插入或排序影响', `/slides/${index}`, 'warning'));
  }
  for (const [index, step] of (input.sequence || []).entries()) unknownObjectFields(step, allowed.step, `/sequence/${index}`, warnings);
  return warnings;
}

export function webUrl(text) {
  if (typeof text !== 'string') throw new Error('图表链接必须是字符串');
  const url = new URL(text);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('图表链接需要不含账号密码的 HTTP(S) URL');
  return url.href;
}

export function slidePanels(slide, deck, group) {
  if (slide.type === 'terminal') return [slide.terminal];
  if (slide.type !== 'workspace') return [];
  const groups = group ? [group] : slide.monitorGroups || [];
  return [...new Set([...slide.panels, ...groups.flatMap(id => deck?.monitorGroups?.[id]?.panels || [])])];
}
export function panelConfig(deck, id) {
  if (Object.hasOwn(deck.terminals || {}, id)) return deck.terminals[id];
  if (Object.hasOwn(deck.dashboards || {}, id)) return deck.dashboards[id];
}
export function commandIndex(config, reference) {
  if (Number.isInteger(reference)) return reference >= 0 && reference < config.commands.length ? reference : -1;
  return typeof reference === 'string' ? config.commands.findIndex(command => command.id === reference) : -1;
}

export class Sequence {
  constructor(deck, store) {
    this.allSteps = (deck.sequence || []).map((step, sourceIndex) => ({...step, sourceIndex, index:step.group ? -1 : commandIndex(panelConfig(deck, step.panel), step.command)}));
    this.independent = new Set(Object.entries(deck.terminals || {}).filter(([, config]) => config.independentSequence).map(([id]) => id));
    this.store = store;
    this.setScope(null);
  }
  setScope(panel) {
    this.steps = this.allSteps.filter(step => panel ? step.panel === panel : !this.independent.has(step.panel));
    const source = this.steps.map(({tab, sourceIndex, index, ...step}) => step);
    const signature = hash(JSON.stringify(source));
    const holder = panel ? (this.store.data.panelSequences ||= {}) : this.store.data;
    const key = panel || 'sequence';
    if (holder[key]?.signature !== signature) holder[key] = {signature, cursor:0, completed:[], skipped:[]};
    this.state = holder[key];
  }
  get next() { return this.steps[this.state.cursor]; }
  matches(panel, index) { return this.next?.panel === panel && this.next?.index === index; }
  advance(skip = false) {
    if (!this.next) return;
    this.state[skip ? 'skipped' : 'completed'].push(this.state.cursor++); this.store.save();
  }
  back() {
    this.state.cursor = Math.max(0, this.state.cursor - 1);
    for (const field of ['completed','skipped']) this.state[field] = this.state[field].filter(n => n < this.state.cursor);
    this.store.save();
  }
}

function hash(text) {
  let n = 2166136261;
  for (const c of text) { n ^= c.codePointAt(0); n = Math.imul(n, 16777619); }
  return (n >>> 0).toString(16);
}

export function terminalName(deckId, terminalId) {
  return `livedeck_${hash(deckId)}_${hash(terminalId)}`;
}

export function singleLineCommand(text) {
  const command = text.trim();
  if (!command) throw new Error('请先选择或输入命令');
  if (/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(command)) throw new Error('填入支持单行命令；多行代码请直接在终端编辑');
  return command;
}

export function stripTerminalCodes(text) {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export class DeckStore {
  constructor(deck, storage = localStorage, onSaveError = () => {}) {
    this.deck = deck; this.storage = storage; this.key = `live-deck:state:${deck.id}`;
    this.onSaveError = onSaveError;
    try { this.data = JSON.parse(storage.getItem(this.key) || '{}'); } catch { this.data = {}; }
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) this.data = {};
    this.data.terminals ||= {};
  }
  terminal(id) {
    if (!Object.hasOwn(this.data.terminals, id)) this.data.terminals[id] = {selected: 0, completed: [], conversation: [], draft: null};
    return this.data.terminals[id];
  }
  resetProgress() {
    // Keep the objects referenced by Sequence and any streaming AI response.
    if (this.data.sequence) Object.assign(this.data.sequence, {cursor: 0, completed: [], skipped: []});
    for (const state of Object.values(this.data.panelSequences || {})) Object.assign(state, {cursor:0, completed:[], skipped:[]});
    for (const state of Object.values(this.data.terminals)) {
      Object.assign(state, {selected: 0, completed: [], draft: null});
    }
    this.save();
  }
  save() {
    try { this.storage.setItem(this.key, JSON.stringify(this.data)); this.saveFailed = false; }
    catch {
      if (!this.saveFailed) this.onSaveError('浏览器存储已满或不可用，当前进度只能保留到页面关闭。请导出演示配置。');
      this.saveFailed = true;
    }
  }
}


// Refresh published monitoring without replacing browser-owned tabs or commands.
export function refreshSourceMonitoring(source, saved) {
  if (!saved) return source;
  if (saved.id !== source.id || !source.monitoringRevision || saved.monitoringRevision === source.monitoringRevision) return saved;
  const updated = structuredClone(saved);
  updated.monitoringRevision = source.monitoringRevision;
  updated.dashboards = {...updated.dashboards, ...structuredClone(source.dashboards || {})};
  for (const [id, config] of Object.entries(source.terminals || {})) {
    const commands = new Map((config.commands || []).filter(command => command.id).map(command => [command.id, command]));
    for (const command of updated.terminals?.[id]?.commands || []) {
      const original = commands.get(command.id);
      if (original && original.command === command.command) command.note = original.note;
    }
  }
  return updated;
}
