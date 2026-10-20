import {validateBinding} from './runtime.js';
import {hasTerminalTab} from './tabs.js';

export function validateDeck(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('演示文件必须是 JSON 对象');
  if (input.format !== undefined && input.format !== 'live-deck') throw new Error('format 必须是 live-deck');
  if (input.version !== undefined && input.version !== 1) throw new Error('当前仅支持 Live Deck version 1');
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id)) throw new Error('id 需要 1–80 个字母、数字、下划线或短横线');
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('请填写 title');
  if (!Array.isArray(input.slides) || !input.slides.length) throw new Error('slides 需要包含至少一页');
  const terminals = input.terminals === undefined ? {} : input.terminals;
  if (!terminals || typeof terminals !== 'object' || Array.isArray(terminals)) throw new Error('terminals 必须是对象');
  for (const [id, terminal] of Object.entries(terminals)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error(`终端 ID 无效：${id}`);
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) throw new Error(`终端 ${id} 配置无效`);
    if (terminal.cwd !== undefined && typeof terminal.cwd !== 'string') throw new Error(`终端 ${id} 的 cwd 必须是字符串`);
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
      if (command.tab !== undefined && !hasTerminalTab(terminal, command.tab)) throw new Error(`终端 ${id} 的命令引用了不存在的 tab`);
    }
  }
  const dashboards = input.dashboards === undefined ? {} : input.dashboards;
  if (!dashboards || typeof dashboards !== 'object' || Array.isArray(dashboards)) throw new Error('dashboards 必须是对象');
  for (const [id, config] of Object.entries(dashboards)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || Object.hasOwn(terminals, id)) throw new Error(`面板 ID 无效或重复：${id}`);
    if (!config || Array.isArray(config) || !Array.isArray(config.commands)) throw new Error(`图表 ${id} 的 commands 需要是数组`);
    if (config.url !== undefined) webUrl(config.url);
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
  for (const slide of input.slides) {
    if (!slide || !['slide', 'terminal', 'workspace'].includes(slide.type)) throw new Error('页面 type 只能是 slide、terminal 或 workspace');
    if (typeof slide.title !== 'string') throw new Error('每页需要 title');
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
    this.steps = (deck.sequence || []).map(step => ({...step, index:step.group ? -1 : commandIndex(panelConfig(deck, step.panel), step.command)}));
    this.store = store;
    const signature = hash(JSON.stringify((deck.sequence || []).map(({tab, ...step}) => step)));
    if (store.data.sequence?.signature !== signature) store.data.sequence = {signature, cursor:0, completed:[], skipped:[]};
    this.state = store.data.sequence;
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
