import {hasTerminalTab} from './tabs.js';

/** Explicit metadata travels alongside PTY output, never as commands to execute. */
export const EVENT_PREFIX = '\x1b]777;live-deck;';
const fieldName = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateFields(fields) {
  if (!object(fields)) throw new Error('运行参数需要是对象');
  for (const [key, value] of Object.entries(fields)) {
    if (!fieldName.test(key) || forbidden.has(key)) throw new Error(`运行参数名无效：${key}`);
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.some(v => !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v))) throw new Error(`运行参数 ${key} 需要是字符串、数值、布尔值或非空数组`);
  }
  return fields;
}
export function validateBinding(binding, terminals) {
  if (!object(binding) || !Object.hasOwn(terminals, binding.terminal)) throw new Error('binding.terminal 必须引用已定义终端');
  if (binding.tab !== undefined && !hasTerminalTab(terminals[binding.terminal], binding.tab)) throw new Error('binding.tab 必须引用该终端已定义的 tab');
  if (!object(binding.params)) throw new Error('binding.params 必须是 URL 参数到运行字段的映射');
  for (const [param, field] of Object.entries(binding.params)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(param) || forbidden.has(param) || typeof field !== 'string' || !fieldName.test(field) || forbidden.has(field)) throw new Error('binding.params 参数映射无效');
    if (binding.time !== false && ['from', 'to', 'refresh'].includes(param)) throw new Error('自动时间开启时不能映射 from、to、refresh');
  }
  if (binding.defaults !== undefined) validateFields(binding.defaults);
  if (binding.follow !== undefined && typeof binding.follow !== 'boolean') throw new Error('binding.follow 必须是布尔值');
  if (binding.time !== undefined && typeof binding.time !== 'boolean') throw new Error('binding.time 必须是布尔值');
  if (binding.lookbackMs !== undefined && (!Number.isSafeInteger(binding.lookbackMs) || binding.lookbackMs < 0)) throw new Error('lookbackMs 必须是非负整数');
  if (binding.refresh !== undefined && !/^\d+[smhd]$/.test(binding.refresh)) throw new Error('refresh 需要如 5s、1m 的间隔');
}

export class RuntimeEvents {
  constructor(onEvent) { this.buffer = ''; this.onEvent = onEvent; }
  push(chunk) {
    this.buffer += chunk;
    while (true) {
      const start = this.buffer.indexOf(EVENT_PREFIX);
      if (start < 0) { this.buffer = this.buffer.slice(-(EVENT_PREFIX.length - 1)); return; }
      this.buffer = this.buffer.slice(start);
      const end = this.buffer.indexOf('\x07', EVENT_PREFIX.length);
      if (end < 0) {
        if (this.buffer.length > 32768) this.buffer = this.buffer.slice(EVENT_PREFIX.length);
        else return;
        continue;
      }
      const encoded = this.buffer.slice(EVENT_PREFIX.length, end);
      this.buffer = this.buffer.slice(end + 1);
      if (encoded.length > 24000) continue;
      try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        this.onEvent(JSON.parse(new TextDecoder().decode(bytes)));
      } catch { /* Malformed or unrelated terminal output is not a metadata event. */ }
    }
  }
}

export class RunContexts {
  constructor(store, onChange = () => {}) {
    this.store = store; this.onChange = onChange;
    if (!object(store.data.runs)) store.data.runs = {};
  }
  get(id) { return this.store.data.runs[id]; }
  clear(id) { delete this.store.data.runs[id]; this.store.save(); this.onChange(id); }
  accept(id, event) {
    if (event?.version !== 1 || !['started', 'ready', 'update', 'finished'].includes(event.event) || typeof event.run_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(event.run_id)) return false;
    for (const key of ['started_at_ms', 'at_ms']) if (!Number.isSafeInteger(event[key]) || event[key] < 0) return false;
    if (typeof event.event_id !== 'string' || event.event_id.length > 100 || event.at_ms < event.started_at_ms) return false;
    if (event.at_ns !== undefined && (typeof event.at_ns !== 'string' || !/^\d{1,24}$/.test(event.at_ns) || BigInt(event.at_ns) / 1000000n !== BigInt(event.at_ms))) return false;
    try { validateFields(event.fields || {}); } catch { return false; }
    const current = this.get(id);
    // Replayed terminal output and late events from a previous run cannot roll back state.
    if (current && event.run_id !== current.run_id && (event.started_at_ms < current.started_at_ms || event.started_at_ms === current.started_at_ms && event.run_id <= current.run_id)) return false;
    const same = current?.run_id === event.run_id;
    if (same && (event.event_id === current.event_id || event.at_ms < current.at_ms || current.status === 'finished')) return false;
    if (same && event.at_ns && current.at_ns && BigInt(event.at_ns) <= BigInt(current.at_ns)) return false;
    const state = same ? {...current, fields:{...current.fields}} : {run_id:event.run_id, started_at_ms:event.started_at_ms, fields:{}, status:'started'};
    Object.assign(state.fields, event.fields || {});
    state.event_id = event.event_id; state.at_ms = event.at_ms;
    if (event.at_ns) state.at_ns = event.at_ns; else delete state.at_ns;
    if (event.event === 'ready' || event.event === 'finished') state.status = event.event;
    if (event.event === 'finished') { state.ended_at_ms = event.at_ms; state.exit_code = Number.isInteger(event.exit_code) ? event.exit_code : null; }
    this.store.data.runs[id] = state; this.onChange(id, state); this.store.save(); return true;
  }
  manual(id, fields, startedAt, newRun = false) {
    validateFields(fields);
    const current = this.get(id), now = Date.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > now) throw new Error('开始时间需要是有效的过去时间');
    const fresh = newRun || !current || current.status === 'finished';
    const event = {version:1, event:fresh ? 'started' : 'update', run_id:fresh ? `manual-${crypto.randomUUID()}` : current.run_id,
      started_at_ms:fresh ? now : current.started_at_ms, at_ms:now, event_id:crypto.randomUUID(), fields:{...fields, monitoring_started_at_ms:startedAt}};
    this.accept(id, event);
  }
}

/** URLSearchParams encodes values; runtime fields cannot change the URL's origin or path. */
export function bindUrl(base, binding, context) {
  const url = new URL(base);
  if (!binding) return {url:url.href, missing:[]};
  const fields = {...binding.defaults, ...context?.fields, ...(context ? {run_id:context.run_id} : {})};
  const missing = [];
  for (const [param, field] of Object.entries(binding.params)) {
    const value = fields[field];
    if (!Object.hasOwn(fields, field) || value === '') { missing.push(field); continue; }
    url.searchParams.delete(param);
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(param, String(item));
  }
  if (binding.time !== false) {
    const start = fields.monitoring_started_at_ms ?? context?.started_at_ms;
    if (!Number.isSafeInteger(start) || start < 0) missing.push('开始时间');
    else {
      url.searchParams.set('from', String(Math.max(0, start - (binding.lookbackMs ?? 30000))));
      url.searchParams.set('to', 'now');
      url.searchParams.set('refresh', binding.refresh || '5s');
    }
  }
  return {url:missing.length ? null : url.href, missing:[...new Set(missing)]};
}
