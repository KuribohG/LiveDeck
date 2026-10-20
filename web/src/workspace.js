import {panelConfig, webUrl} from './model.js';
import {RunbookList} from './runbook.js';
import {bindUrl} from './runtime.js';
import {MAIN_TAB, terminalTabs, hasTerminalTab, terminalSessionId} from './tabs.js';

/** Cards and their iframes stay mounted, including when a slide is off stage. */
export class PanelWorkspace {
  constructor(root, deck, pool, store, sequence, onSelect, onError, runs, onEditRun, onEditTab, onCloseTab, temporaryTabs = {}) {
    Object.assign(this, {root, deck, pool, store, sequence, onSelect, onError, runs, onEditRun, onEditTab, onCloseTab, temporaryTabs});
    this.cards = new Map(); this.visible = [];
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && this.zoomed) { this.zoom(null); event.stopPropagation(); } }, true);
  }
  create(id, connect = true) {
    const config = panelConfig(this.deck, id), isWeb = Object.hasOwn(this.deck.dashboards || {}, id);
    const card = document.createElement('article'); card.className = 'workspace-card'; card.dataset.panelId = id;
    const toolbar = document.createElement('div'); toolbar.className = 'panel-toolbar';
    const select = document.createElement('button'); select.className = 'panel-select'; select.textContent = config.label || id; select.onclick = () => this.onSelect(id);
    const status = document.createElement('span'); status.className = 'panel-status';
    toolbar.append(select, status);
    const viewport = document.createElement('div'); viewport.className = 'panel-viewport';
    const candidateRegion = document.createElement('div'); candidateRegion.className = 'panel-candidate-region'; candidateRegion.id = `panel-candidates-${id}`; candidateRegion.hidden = true;
    const candidateHeader = document.createElement('div'); candidateHeader.className = 'candidate-header';
    const search = document.createElement('input'); search.placeholder = '搜索本面板候选…'; search.setAttribute('aria-label', `${config.label || id} 候选搜索`);
    const controls = document.createElement('div'); controls.className = 'list-pager'; candidateHeader.append(search, controls);
    const list = document.createElement('ol'); list.className = 'command-list panel-candidates';
    const runbook = new RunbookList(list, controls, index => this.onSelect(id, index), 30);
    search.oninput = () => this.update();
    candidateRegion.append(candidateHeader, list);
    card.append(toolbar, viewport, candidateRegion); this.root.append(card);
    const entry = {card, toolbar, viewport, status, search, runbook, candidateRegion, isWeb}; this.cards.set(id, entry);
    const zoom = document.createElement('button'); zoom.className = 'panel-zoom'; zoom.textContent = '全屏'; zoom.setAttribute('aria-label', `全屏 ${config.label || id}`);
    zoom.onclick = () => this.zoom(this.zoomed === id ? null : id); toolbar.append(zoom); entry.zoom = zoom;
    if (isWeb) {
      card.classList.add('web-card');
      const follow = document.createElement('button'); follow.className = 'panel-follow'; follow.onclick = () => this.setFollow(id, !this.follows(id)); toolbar.append(follow); entry.follow = follow;
      follow.hidden = !config.binding;
      const link = document.createElement('a'); link.className = 'panel-external'; link.textContent = '打开 ↗'; link.title = '在新窗口登录或打开此图表'; link.target = '_blank'; link.rel = 'noopener noreferrer'; toolbar.append(link); entry.link = link;
      const full = document.createElement('a'); full.className = 'panel-full'; full.textContent = '看板 ↗'; full.target = '_blank'; full.rel = 'noopener noreferrer'; toolbar.append(full); entry.full = full;
      const frame = document.createElement('iframe'); frame.className = 'dashboard-frame'; frame.title = config.label || id; frame.referrerPolicy = 'no-referrer'; viewport.append(frame); entry.frame = frame;
      const pending = document.createElement('div'); pending.className = 'chart-pending'; viewport.append(pending); entry.pending = pending;
      const state = this.store.terminal(id);
      const signature = JSON.stringify({url:config.url, binding:config.binding});
      if (state.configSignature !== undefined && state.configSignature !== signature) {
        delete state.url; delete state.baseUrl; delete state.follow;
      }
      state.configSignature = signature;
      if (state.follow === undefined) state.follow = config.binding?.follow !== false;
      if (!state.baseUrl) state.baseUrl = config.url;
      this.refresh(id);
      this.store.save();
    } else {
      const reconnect = document.createElement('button'); reconnect.className = 'panel-reconnect'; reconnect.textContent = '重连';
      reconnect.title = '重新连接终端，保留仍在运行的 Shell；已结束的会话会新建';
      reconnect.setAttribute('aria-label', `重连 ${config.label || id} 当前终端 tab`);
      reconnect.onclick = () => { this.onSelect(id); this.connectTerminal(id, 'reconnect').catch(error => this.report(error)); };
      toolbar.append(reconnect); entry.reconnect = reconnect;
      const restart = document.createElement('button'); restart.className = 'panel-restart'; restart.textContent = '重启';
      restart.title = '结束当前 tab 的旧 Shell 和前台进程，清空输出，按初始目录启动新 Shell';
      restart.setAttribute('aria-label', `重启 ${config.label || id} 当前终端 tab`);
      restart.onclick = () => { this.onSelect(id); this.connectTerminal(id, 'restart').catch(error => this.report(error)); };
      toolbar.append(restart); entry.restart = restart;
      const edit = document.createElement('button'); edit.className = 'edit-run'; edit.textContent = '运行信息'; edit.onclick = () => this.onEditRun(id); toolbar.append(edit); entry.edit = edit;
      const tabbar = document.createElement('div'); tabbar.className = 'terminal-tabbar';
      const tabs = document.createElement('div'); tabs.className = 'terminal-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', `${config.label || id} 终端 tab`);
      const add = document.createElement('button'); add.className = 'terminal-tab-add'; add.textContent = '＋'; add.title = '新建独立终端 tab'; add.setAttribute('aria-label', `新增 ${config.label || id} 终端 tab`); add.onclick = () => this.onEditTab(id);
      const reopen = document.createElement('select'); reopen.className = 'terminal-tab-reopen'; reopen.setAttribute('aria-label', '重新打开已关闭的 tab');
      reopen.onchange = () => { if (reopen.value) { this.activateTab(id, reopen.value).catch(error => this.report(error)); this.onSelect(id); } };
      tabbar.append(tabs, reopen, add); toolbar.after(tabbar); entry.tabs = tabs; entry.reopen = reopen;
      viewport.setAttribute('role', 'tabpanel'); viewport.id = `terminal-panel-${id}`;
      const empty = document.createElement('div'); empty.className = 'terminal-empty'; empty.textContent = '所有终端 tab 已关闭。选择“重新打开”，或点击“＋”新建。'; viewport.append(empty); entry.empty = empty;
      if (connect && this.activeTab(id)) this.activateTab(id, this.activeTab(id)).catch(error => this.report(error));
      else this.renderTabs(id);
      this.runChanged(id);
    }
    const candidates = document.createElement('button'); candidates.className = 'panel-candidates-toggle';
    candidates.textContent = `候选 ${config.commands.length} ▸`;
    candidates.setAttribute('aria-expanded', 'false'); candidates.setAttribute('aria-controls', candidateRegion.id);
    candidates.setAttribute('aria-label', `展开 ${config.label || id} 的候选`);
    candidates.onclick = () => {
      candidateRegion.hidden = !candidateRegion.hidden;
      const open = !candidateRegion.hidden;
      candidates.textContent = `候选 ${config.commands.length} ${open ? '▾' : '▸'}`;
      candidates.setAttribute('aria-expanded', String(open));
      candidates.setAttribute('aria-label', `${open ? '收起' : '展开'} ${config.label || id} 的候选`);
      if (open) runbook.render(true);
      requestAnimationFrame(() => this.pool.resize());
    };
    toolbar.append(candidates);
    return entry;
  }
  report(error) { if (error.code !== 'TERMINAL_CLOSING') this.onError(error.message); }
  isTemporaryTab(id, tab) { return tab !== MAIN_TAB && this.temporaryTabs[id]?.includes(tab) || false; }
  isTabClosed(id, tab) { return this.isTemporaryTab(id, tab) && (this.store.terminal(id).closedTabs?.includes(tab) || false); }
  openTabs(id) { return terminalTabs(panelConfig(this.deck, id)).filter(tab => !this.isTabClosed(id, tab.id)); }
  activeTab(id) {
    const tab = this.store.terminal(id).activeTab;
    return hasTerminalTab(panelConfig(this.deck, id), tab) && !this.isTabClosed(id, tab) ? tab : this.openTabs(id)[0]?.id || null;
  }
  sessionId(id, tab = this.activeTab(id)) { return tab === null ? null : terminalSessionId(id, tab); }
  renderTabs(id) {
    const entry = this.cards.get(id), active = this.activeTab(id);
    entry.tabs.replaceChildren(...this.openTabs(id).map(tab => {
      const item = document.createElement('span'); item.className = 'terminal-tab-item'; item.setAttribute('role', 'presentation');
      const button = document.createElement('button'); button.className = 'terminal-tab'; button.textContent = tab.label;
      button.dataset.tabId = tab.id; button.id = `terminal-tab-${id}-${tab.id}`;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab.id === active)); button.setAttribute('aria-controls', entry.viewport.id);
      button.tabIndex = tab.id === active ? 0 : -1; button.title = `${tab.label} · ${this.isTemporaryTab(id, tab.id) ? '临时 tab' : '文稿固定 tab'} · 双击重命名`;
      const key = this.sessionId(id, tab.id);
      const closing = this.pool.sessions.get(key)?.closing || this.pool.closing.has(key) || this.pool.restarting.has(key);
      button.disabled = !!closing;
      button.onclick = () => { this.activateTab(id, tab.id).catch(error => this.report(error)); this.onSelect(id); };
      button.ondblclick = () => this.onEditTab(id, tab.id);
      button.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const tabs = this.openTabs(id), index = tabs.findIndex(item => item.id === tab.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        this.activateTab(id, tabs[next].id).catch(error => this.report(error)); this.onSelect(id);
        entry.tabs.querySelectorAll('[role="tab"]')[next].focus();
      };
      item.append(button);
      if (this.isTemporaryTab(id, tab.id)) {
        const close = document.createElement('button'); close.className = 'terminal-tab-close'; close.textContent = closing ? '…' : '×'; close.disabled = !!closing;
        close.setAttribute('aria-label', `关闭 ${tab.label} tab`); close.title = `关闭临时 tab ${tab.label} 的终端会话`;
        close.onclick = () => this.onCloseTab(id, tab.id); item.append(close);
      }
      return item;
    }));
    const closed = terminalTabs(panelConfig(this.deck, id)).filter(tab => this.isTabClosed(id, tab.id));
    entry.reopen.replaceChildren(new Option('重新打开…', ''), ...closed.map(tab => new Option(tab.label, tab.id))); entry.reopen.hidden = !closed.length;
    entry.empty.hidden = active !== null;
    if (active) entry.viewport.setAttribute('aria-labelledby', `terminal-tab-${id}-${active}`);
    else entry.viewport.removeAttribute('aria-labelledby');
    entry.edit.disabled = !active;
  }
  syncTerminalVisibility() {
    this.pool.activeIds = new Set(this.visible.filter(id => !this.cards.get(id)?.isWeb).map(id => this.sessionId(id)).filter(Boolean));
    for (const [key, session] of this.pool.sessions) {
      const id = key.split(':')[0], active = key === this.sessionId(id);
      session.frame.classList.toggle('active', active); session.frame.inert = !active || !!session.closing || this.pool.restarting.has(key);
      session.frame.setAttribute('aria-hidden', String(!active));
    }
  }
  activateTab(id, tab) {
    if (this.resetting) return Promise.reject(this.pool.closingError());
    if (!hasTerminalTab(panelConfig(this.deck, id), tab)) return Promise.reject(new Error('目标终端 tab 不存在'));
    if (this.pool.closing.has(this.sessionId(id, tab)) || this.pool.restarting.has(this.sessionId(id, tab))) return Promise.reject(this.pool.closingError());
    const state = this.store.terminal(id); state.closedTabs = (state.closedTabs || []).filter(item => item !== tab);
    state.activeTab = tab; this.store.save(); this.renderTabs(id);
    const ready = this.connectTerminal(id);
    this.syncTerminalVisibility(); this.pool.resize();
    return ready;
  }
  async closeTab(id, tab) {
    if (this.resetting) throw this.pool.closingError();
    if (!this.isTemporaryTab(id, tab)) throw new Error('文稿中定义的固定 tab 不能关闭');
    const state = this.store.terminal(id), index = this.openTabs(id).findIndex(item => item.id === tab);
    try {
      await this.pool.close(this.sessionId(id, tab));
      state.closedTabs = [...new Set([...(state.closedTabs || []), tab])];
      if (state.activeTab === tab || !this.openTabs(id).some(item => item.id === state.activeTab)) {
        state.activeTab = this.openTabs(id)[Math.max(0, index - 1)]?.id || this.openTabs(id)[0]?.id || null;
      }
      this.store.save(); this.renderTabs(id); this.syncTerminalVisibility();
      if (this.activeTab(id)) this.connectTerminal(id).catch(error => this.report(error));
      else { this.cards.get(id).connection = 'closed'; this.runChanged(id); }
      if (this.visible.includes(id)) this.onSelect(id);
    } finally { this.renderTabs(id); this.syncTerminalVisibility(); }
  }
  async fill(id, tab, text) {
    await this.activateTab(id, tab);
    // A manual switch during connection must not send input to a hidden tab.
    if (!this.visible.includes(id) || this.activeTab(id) !== tab || this.root.closest('[inert]')) throw new Error('已切换页面或 tab，本次填入已取消');
    if (this.zoomed && this.zoomed !== id) this.zoom(null);
    this.onSelect(id); this.pool.resize();
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (this.activeTab(id) !== tab || !this.visible.includes(id) || this.root.closest('[inert]')) throw new Error('已切换页面或 tab，本次填入已取消');
    this.pool.fill(this.sessionId(id, tab), text);
  }
  connectTerminal(id, action = 'activate') {
    if (this.resetting) return Promise.reject(this.pool.closingError());
    const entry = this.cards.get(id), config = panelConfig(this.deck, id);
    const tab = this.activeTab(id), key = this.sessionId(id, tab), tabConfig = terminalTabs(config).find(item => item.id === tab);
    const options = {...config, ...tabConfig, label:`${config.label || id} · ${tabConfig.label}`};
    const ready = action === 'restart' ? this.pool.restart(key, options, entry.viewport)
      : action === 'reconnect' && this.pool.sessions.has(key) ? this.pool.reconnect(key) : this.pool.activate(key, options, entry.viewport);
    return ready.then(session => this.configureTerminal(id, tab, session));
  }
  configureTerminal(id, tab, session) {
    session.terminal.term.setOption('fontSize', 14);
    if (session.focusFrame !== session.frame) {
      const select = () => { if (this.activeTab(id) === tab) this.onSelect(id); };
      session.frame.contentWindow.addEventListener('focus', select);
      session.frame.contentDocument.addEventListener('pointerdown', select);
      session.focusFrame = session.frame;
    }
    this.pool.resize();
    return session;
  }
  resetTerminals() {
    if (this.resetting) return this.resetting;
    const wasInert = this.root.inert;
    this.root.inert = true; this.root.setAttribute('aria-busy', 'true');
    this.resetting = Promise.resolve().then(async () => {
      // Finish any earlier close/restart before touching the same named sessions.
      await Promise.allSettled([...this.pool.closing.values(), ...this.pool.restarting.values()]);
      const tasks = Object.entries(this.deck.terminals || {}).flatMap(([id, config]) => {
        const entry = this.cards.get(id) || this.create(id, false);
        return terminalTabs(config).map(tab => ({id, tab, entry, config, temporary:this.isTemporaryTab(id, tab.id)}));
      });
      const results = await Promise.allSettled(tasks.map(async ({id, tab, entry, config, temporary}) => {
        const key = this.sessionId(id, tab.id);
        if (temporary) {
          await this.pool.close(key);
          const state = this.store.terminal(id);
          state.closedTabs = [...new Set([...(state.closedTabs || []), tab.id])];
          this.store.save();
        } else {
          const session = await this.pool.restart(key, {...config, ...tab, label:`${config.label || id} · ${tab.label}`}, entry.viewport);
          this.configureTerminal(id, tab.id, session);
        }
      }));
      const summary = {closed:0, restarted:0, failures:[]};
      results.forEach((result, index) => {
        const task = tasks[index];
        if (result.status === 'fulfilled') summary[task.temporary ? 'closed' : 'restarted']++;
        else summary.failures.push(`${task.config.label || task.id} / ${task.tab.label}：${result.reason.message}`);
      });
      for (const id of Object.keys(this.deck.terminals || {})) this.store.terminal(id).activeTab = MAIN_TAB;
      this.store.save();
      return summary;
    }).finally(() => {
      this.resetting = null;
      this.root.inert = wasInert; this.root.removeAttribute('aria-busy');
      for (const [id, entry] of this.cards) if (!entry.isWeb) {
        entry.connection = this.pool.sessions.get(this.sessionId(id))?.status || 'closed';
        this.renderTabs(id); this.runChanged(id);
      }
      this.syncTerminalVisibility(); this.pool.resize();
    });
    return this.resetting;
  }
  show(ids, layout = 'columns', selected) {
    this.zoom(null);
    this.visible = ids; this.layout = layout;
    for (const entry of this.cards.values()) { entry.card.classList.remove('visible'); entry.card.inert = true; }
    ids.forEach((id, i) => {
      const entry = this.cards.get(id) || this.create(id);
      let x = i / ids.length, y = 0, w = 1 / ids.length, h = 1;
      if (layout === 'rows') {x = 0; y = i / ids.length; w = 1; h = 1 / ids.length;}
      if (layout === 'focus' && ids.length > 1) {
        x = i === 0 ? 0 : .56; y = i === 0 ? 0 : (i - 1) / (ids.length - 1);
        w = i === 0 ? .56 : .44; h = i === 0 ? 1 : 1 / (ids.length - 1);
      }
      Object.assign(entry.card.style, {left:`${x * 100}%`,top:`${y * 100}%`,width:`calc(${w * 100}% - 8px)`,height:`calc(${h * 100}% - 8px)`});
      entry.card.classList.add('visible'); entry.card.inert = false;
    });
    this.root.classList.toggle('multi-panel', ids.length > 1);
    this.syncTerminalVisibility();
    this.select(selected); this.update(); requestAnimationFrame(() => this.pool.resize());
  }
  select(id) {
    for (const [key, entry] of this.cards) entry.card.classList.toggle('selected-panel', key === id);
  }
  update() {
    for (const id of this.visible) {
      const entry = this.cards.get(id), config = panelConfig(this.deck, id);
      const nextIndex = this.sequence.next?.panel === id ? this.sequence.next.index : -1;
      entry.card.classList.toggle('next-panel', nextIndex >= 0);
      entry.runbook.update(config.commands, this.store.terminal(id), nextIndex, entry.search.value);
    }
  }
  status(key, status) {
    if (typeof key !== 'string') return;
    const id = key.split(':')[0];
    const entry = this.cards.get(id);
    if (entry && !entry.isWeb && key === this.sessionId(id)) {
      entry.connection = status;
      this.runChanged(id);
    }
    if (entry && !entry.isWeb) { this.renderTabs(id); this.syncTerminalVisibility(); }
  }
  navigate(id, text) {
    const entry = this.cards.get(id), url = webUrl(text);
    if (!entry?.isWeb) throw new Error('当前面板不是图表面板');
    const state = this.store.terminal(id); state.baseUrl = url;
    if (panelConfig(this.deck, id).binding) state.follow = true;
    else state.url = url;
    this.refresh(id); this.store.save();
  }
  follows(id) { return this.store.terminal(id).follow !== false; }
  setFollow(id, follow) {
    this.store.terminal(id).follow = follow;
    this.refresh(id); this.store.save();
  }
  followVisible(follow) {
    for (const id of this.visible) if (panelConfig(this.deck, id).binding) this.setFollow(id, follow);
  }
  refresh(id) {
    const entry = this.cards.get(id), config = panelConfig(this.deck, id), state = this.store.terminal(id);
    if (!entry?.isWeb) return;
    entry.follow.textContent = this.follows(id) ? '跟随中' : '已暂停';
    entry.follow.setAttribute('aria-pressed', String(this.follows(id)));
    const run = config.binding && this.runs.get(terminalSessionId(config.binding.terminal, config.binding.tab));
    const result = config.binding && (this.follows(id) || !state.url)
      ? (state.baseUrl ? bindUrl(state.baseUrl, config.binding, run) : {missing:['图表链接']})
      : {url:state.url || state.baseUrl, missing:[]};
    entry.status.textContent = config.binding ? (this.follows(id) ? (run?.status === 'finished' ? '运行已结束' : '联动') : '固定目标') : '网页';
    entry.status.title = run ? `运行 ${run.run_id}` : '等待运行信息';
    entry.pending.hidden = !!result.url;
    entry.pending.textContent = `等待 ${config.binding?.terminal || ''}：${result.missing?.join('、') || '图表链接'}`;
    if (result.url) this.load(id, result.url);
    else {
      if (entry.frame.getAttribute('src') && entry.frame.getAttribute('src') !== 'about:blank') entry.frame.src = 'about:blank';
      entry.link.removeAttribute('href'); entry.full.removeAttribute('href');
    }
  }
  load(id, url) {
    const entry = this.cards.get(id), safe = webUrl(url);
    if (entry.frame.getAttribute('src') !== safe) entry.frame.src = safe;
    entry.link.href = safe;
    const full = new URL(safe); full.pathname = full.pathname.replace('/d-solo/', '/d/'); full.searchParams.delete('panelId');
    entry.full.href = full.href;
    this.store.terminal(id).url = safe;
    entry.pending.hidden = true;
  }
  runChanged(key) {
    const id = key.split(':')[0], entry = this.cards.get(id), run = this.runs?.get(this.sessionId(id));
    if (entry && !entry.isWeb) {
      const connection = this.pool.restarting.has(this.sessionId(id)) ? 'restarting' : entry.connection;
      const busy = ['connecting', 'closing', 'restarting'].includes(connection);
      entry.reconnect.disabled = entry.restart.disabled = !this.activeTab(id) || busy;
      entry.reconnect.textContent = connection === 'connecting' ? '连接中…' : '重连';
      entry.restart.textContent = connection === 'restarting' ? '重启中…' : '重启';
      if (!this.activeTab(id)) {
        entry.status.textContent = '未打开'; entry.status.title = '可重新打开已关闭的 tab，或新建终端'; entry.reconnect.disabled = true; entry.edit.disabled = true;
      } else {
        const status = ({started:'运行中',ready:'任务就绪',finished:run?.exit_code === 0 ? '已结束 · 0' : `已结束 · ${run?.exit_code ?? '?'}`})[run?.status];
        entry.status.textContent = connection && connection !== 'ready'
          ? ({connecting:'连接中',closing:'关闭中',restarting:'重启中',closed:'已断开',error:'连接失败'})[connection]
          : status || '● LIVE';
        entry.status.title = connection && connection !== 'ready'
          ? '连接未就绪，可点击“重连”重新连接终端'
          : run ? `上次报告的运行：${run.run_id}。普通命令不会自动报告状态。` : '已连接；普通命令的运行状态未知';
      }
    }
    for (const [panel, item] of this.cards) {
      const binding = panelConfig(this.deck, panel).binding;
      if (item.isWeb && binding && terminalSessionId(binding.terminal, binding.tab) === key && this.follows(panel)) this.refresh(panel);
    }
  }
  timeVisible(from, to) {
    const valid = value => /^(?:\d+|now(?:-\d+[smhdwMy])?)$/.test(value);
    if (!valid(from) || !valid(to)) throw new Error('时间请填毫秒时间戳、now 或 now-15m 等相对时间');
    if (/^\d+$/.test(from) && /^\d+$/.test(to) && Number(from) >= Number(to)) throw new Error('开始时间需要早于结束时间');
    for (const id of this.visible) {
      const entry = this.cards.get(id), state = this.store.terminal(id);
      if (!entry?.isWeb || !state.url) continue;
      const url = new URL(state.url); url.searchParams.set('from', from); url.searchParams.set('to', to);
      if (to !== 'now') url.searchParams.delete('refresh');
      state.follow = false; this.load(id, url.href); this.refresh(id);
    }
    this.store.save();
  }
  zoom(id) {
    this.zoomed = id;
    for (const [key, entry] of this.cards) {
      entry.card.classList.toggle('zoomed', key === id);
      entry.card.classList.toggle('behind-zoom', !!id && key !== id);
      entry.card.inert = !this.visible.includes(key) || !!id && key !== id;
      entry.zoom.textContent = key === id ? '退出全屏' : '全屏';
      entry.zoom.setAttribute('aria-label', `${key === id ? '退出全屏' : '全屏'} ${panelConfig(this.deck, key).label || key}`);
    }
    requestAnimationFrame(() => this.pool.resize());
  }
  context() {
    return this.visible.map(id => {
      const config = panelConfig(this.deck, id), isWeb = this.cards.get(id)?.isWeb;
      const panel = {id, kind:isWeb ? 'dashboard' : 'terminal', label:config.label || id};
      if (isWeb) return {...panel, url:this.store.terminal(id).url, following:this.follows(id), binding:config.binding,
        run:config.binding && this.runs.get(terminalSessionId(config.binding.terminal, config.binding.tab)), note:'只提供链接和运行参数，未读取图表数据'};
      const definitions = terminalTabs(config), budget = Math.max(200, Math.floor(12000 / definitions.length));
      const tabs = definitions.map(tab => ({id:tab.id, label:tab.label,
        history:this.pool.history(this.sessionId(id, tab.id)).slice(-budget), run:this.runs.get(this.sessionId(id, tab.id))}));
      return {...panel, active_tab:this.activeTab(id), run:this.runs.get(this.sessionId(id)), tabs,
        history:tabs.map(tab => `[${tab.label}]\n${tab.history}`).join('\n')};
    });
  }
}
