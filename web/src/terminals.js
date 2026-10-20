import {terminalName, singleLineCommand, stripTerminalCodes} from './model.js';
import {RuntimeEvents} from './runtime.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class TerminalPool {
  constructor(client, viewport, deckId, onStatus, onEvent = () => {}, onReset = () => {}) {
    this.client = client; this.viewport = viewport; this.deckId = deckId; this.onStatus = onStatus;
    this.sessions = new Map(); this.closing = new Map(); this.restarting = new Map(); this.activeId = null; this.activeIds = new Set();
    this.onEvent = onEvent;
    this.onReset = onReset;
    window.addEventListener('pagehide', () => this.closeObservers());
    new ResizeObserver(() => this.resize()).observe(viewport);
  }
  async activate(id, config, viewport = this.viewport) {
    if (this.closing.has(id) || this.restarting.has(id)) throw this.closingError();
    this.activeId = id;
    this.activeIds.add(id);
    if (!this.sessions.has(id)) this.createSession(id, config, viewport);
    const session = this.sessions.get(id);
    this.onStatus(id, session.status, session.error?.message);
    await session.ready;
    if (this.activeId === id) this.resize();
    return session;
  }
  createSession(id, config, viewport) {
    const frame = document.createElement('iframe');
    frame.className = 'terminal-frame'; frame.title = config.label || id;
    frame.classList.toggle('active', this.activeIds.has(id));
    frame.dataset.terminalId = id;
    const session = {frame, viewport, config, history: '', status: 'connecting', name: terminalName(this.deckId, id)};
    this.sessions.set(id, session);
    viewport.append(frame);
    session.resizeObserver = new ResizeObserver(() => this.resize());
    session.resizeObserver.observe(viewport);
    session.ready = this.start(id, session);
    return session;
  }
  reconnect(id) {
    if (this.closing.has(id) || this.restarting.has(id)) return Promise.reject(this.closingError());
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new Error('终端尚未创建'));
    if (session.status === 'connecting') return session.ready;
    this.stopConnections(session);
    const frame = session.frame.cloneNode(false);
    frame.removeAttribute('src');
    session.frame.replaceWith(frame);
    session.frame = frame;
    session.ready = this.start(id, session);
    return session.ready;
  }
  restart(id, config, viewport = this.viewport) {
    if (this.restarting.has(id)) return this.restarting.get(id);
    if (this.closing.has(id)) return Promise.reject(this.closingError());
    const session = this.sessions.get(id);
    config ||= session?.config;
    viewport = session?.viewport || viewport;
    if (!config) return Promise.reject(new Error('终端尚未创建'));
    // Hold the tab through deletion and creation; a failed DELETE must not create a replacement.
    const restarting = Promise.resolve().then(async () => {
      await this.closeSession(id, true);
      return this.createSession(id, config, viewport).ready;
    }).finally(() => {
      this.restarting.delete(id);
      const current = this.sessions.get(id);
      this.onStatus(id, current?.status || 'closed', current?.error?.message);
    });
    this.restarting.set(id, restarting);
    this.onStatus(id, 'restarting');
    return restarting;
  }
  start(id, session) {
    this.disposed = false;
    session.status = 'connecting'; session.error = null;
    return this.connect(id, session, session.config).then(() => session).catch(error => {
      if (session.closing) throw error;
      this.stopConnections(session);
      session.frame.src = 'about:blank';
      session.status = 'error'; session.error = error; this.onStatus(id, 'error', error.message); throw error;
    });
  }
  closingError() { return Object.assign(new Error('终端正在关闭或重启，请等待完成'), {code:'TERMINAL_CLOSING'}); }
  assertOpen(session) { if (session.closing) throw this.closingError(); }
  close(id) {
    if (this.restarting.has(id)) return Promise.reject(this.closingError());
    if (this.closing.has(id)) return this.closing.get(id);
    const closing = this.closeSession(id).finally(() => this.closing.delete(id));
    this.closing.set(id, closing);
    return closing;
  }
  async closeSession(id, preserveActive = false) {
    const session = this.sessions.get(id);
    if (session) {
      const connecting = session.status === 'connecting';
      session.closing = true; session.status = 'closing'; this.onStatus(id, 'closing');
      if (connecting) this.stopConnections(session);
      // Let any in-flight creation finish before deleting the server terminal.
      await session.ready.catch(() => {});
    }
    try { await this.request(`api/terminals/${session?.name || terminalName(this.deckId, id)}`, {method:'DELETE'}); }
    catch (error) {
      if (error.status !== 404) {
        if (session) {
          session.closing = false; session.error = error;
          session.status = session.terminal?.socket?.readyState === WebSocket.OPEN ? 'ready' : 'error';
          this.onStatus(id, session.status);
        }
        throw error;
      }
    }
    if (session) {
      this.stopConnections(session); session.frame.remove(); session.resizeObserver?.disconnect();
      this.sessions.delete(id);
    }
    if (!preserveActive) {
      this.activeIds.delete(id); if (this.activeId === id) this.activeId = null;
    }
    this.onReset(id); this.onStatus(id, 'closed');
  }
  stopConnections(session) {
    clearTimeout(session.reconnect);
    const observer = session.observer, terminal = session.terminal;
    session.observer = null; session.terminal = null;
    observer?.close(); terminal?.socket?.close();
  }
  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try { return await this.client.request(path, {...options, signal: controller.signal}); }
    catch (error) {
      if (controller.signal.aborted) throw new Error('终端请求超时，请点击面板“重连”重试');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async connect(id, session, config) {
    this.onStatus(id, 'connecting');
    try { await this.request(`api/terminals/${session.name}`); }
    catch (error) {
      this.assertOpen(session);
      if (error.status !== 404) throw error;
      await this.request('api/terminals', {method: 'POST', body: {name: session.name, ...(config.cwd ? {cwd: config.cwd} : {})}});
      this.assertOpen(session);
      session.history = '';
      this.onReset(id);
    }
    this.assertOpen(session);
    await this.observe(id, session);
    this.assertOpen(session);
    session.frame.src = this.client.url(`terminals/${session.name}`);
    for (let i = 0; i < 250; i++) {
      await sleep(100);
      this.assertOpen(session);
      let terminal;
      try { terminal = session.frame.contentWindow.terminal; } catch {}
      if (terminal?.socket?.readyState === WebSocket.OPEN) {
        session.terminal = terminal;
        terminal.socket.addEventListener('message', event => {
          if (session.terminal !== terminal) return;
          try {
            const [type, data] = JSON.parse(event.data);
            if (type === 'stdout') session.history = (session.history + data).slice(-250000);
            if (type === 'disconnect') { session.status = 'closed'; this.onStatus(id, 'closed'); }
          } catch {}
        });
        terminal.socket.addEventListener('close', () => {
          if (session.terminal === terminal) { session.status = 'closed'; this.onStatus(id, 'closed'); }
        });
        const style = session.frame.contentDocument.createElement('style');
        style.textContent = 'html,body{background:#101622!important;color:#dce5f2!important;height:100%;margin:0!important;padding:0!important;overflow:hidden}#header,.header-bar{display:none!important}#site{height:100%!important;overflow:hidden;padding:0!important;margin:0!important}#terminado-container{width:100%!important;max-width:none!important;height:100%!important;padding:14px 16px 8px!important;margin:0!important;box-sizing:border-box;box-shadow:none!important;border:0!important}.xterm-viewport{background:#101622!important}';
        session.frame.contentDocument.head.append(style);
        terminal.term.setOption('theme', {background:'#101622',foreground:'#dce5f2',cursor:'#b7f5ca',selection:'rgba(183,245,202,.22)',black:'#263347',blue:'#86aaff',green:'#b7f5ca',yellow:'#f4d5a1',red:'#fb9f9f',cyan:'#83d6cf'});
        terminal.term.setOption('fontSize', 17);
        terminal.term.setOption('fontFamily', '"JetBrains Mono", "DejaVu Sans Mono", monospace');
        terminal.term.setOption('scrollback', 5000);
        session.status = 'ready'; this.onStatus(id, 'ready'); this.resize(); return;
      }
    }
    throw new Error('终端连接超时，请点击面板“重连”重试');
  }
  async observe(id, session) {
    // Subscribe before the frame loads so replayed metadata is captured as well.
    const url = new URL(this.client.url(`terminals/websocket/${session.name}`));
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url), parser = new RuntimeEvents(event => this.onEvent(id, event));
    session.observer = socket;
    socket.addEventListener('message', message => {
      if (session.observer !== socket) return;
      try { const [type, data] = JSON.parse(message.data); if (type === 'stdout') parser.push(data); } catch {}
    });
    socket.addEventListener('close', () => {
      if (!this.disposed && !session.closing && session.observer === socket) session.reconnect = setTimeout(() => this.observe(id, session).catch(() => {}), 2000);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('运行信息连接超时')); }, 15000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('运行信息连接失败')); }, {once:true});
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('运行信息连接已断开，请点击面板“重连”重试')); }, {once:true});
    });
  }
  closeObservers() {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      clearTimeout(session.reconnect);
      const observer = session.observer; session.observer = null; observer?.close();
    }
  }
  resize() {
    for (const id of this.activeIds) {
      const session = this.sessions.get(id);
      if (!session?.terminal || !session.viewport.offsetWidth) continue;
      const {term, socket} = session.terminal;
      try { term.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['set_size', term.rows, term.cols, session.viewport.clientHeight, session.viewport.clientWidth])); } catch {}
    }
  }
  fill(id, text) {
    if (this.closing.has(id) || this.restarting.has(id)) throw this.closingError();
    const command = singleLineCommand(text);
    const session = this.sessions.get(id);
    if (session?.status !== 'ready' || session.terminal?.socket?.readyState !== WebSocket.OPEN) throw new Error('终端尚未连接，请点击面板“重连”重试');
    session.terminal.socket.send(JSON.stringify(['stdin', command]));
    session.terminal.term.focus();
  }
  history(id) {
    const session = this.sessions.get(id);
    if (!session) return '';
    try {
      const term = session.terminal.term;
      const buffer = term.buffer?.active || term.buffer;
      if (buffer?.getLine) {
        const lines = [];
        for (let i = Math.max(0, buffer.length - 1200); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
        const rendered = lines.join('\n').trim();
        if (rendered) return rendered.slice(-60000);
      }
      const lines = term._core?.buffer?.lines;
      if (lines?.get) {
        const result = [];
        for (let i = Math.max(0, lines.length - 1200); i < lines.length; i++) result.push(lines.get(i)?.translateToString(true) || '');
        const rendered = result.join('\n').trim();
        if (rendered) return rendered.slice(-60000);
      }
    } catch {}
    return stripTerminalCodes(session.history).slice(-60000);
  }
}
