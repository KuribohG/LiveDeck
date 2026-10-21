import {validateDeck, DeckStore, Sequence, panelConfig, slidePanels, refreshSourceMonitoring} from './model.js';
import {RunbookList} from './runbook.js';
import {PanelWorkspace} from './workspace.js';
import {LiveCharts} from './charts.js';
import {JupyterClient} from './jupyter.js';
import {TerminalPool} from './terminals.js';
import {CodexAdvisor} from './advisor.js';
import {advisorContext} from './advisor-context.js';
import {ConversationView, createReply, applyAdvisorEvent} from './conversation.js';
import {RunContexts} from './runtime.js';
import {MAIN_TAB, terminalTabs, commandTab, restoreTabOrigins, fixedTabDefinitions} from './tabs.js';
import {
  PRODUCT_API_VERSION,
  effectiveRevision,
  inspectState,
  prepareOperation,
  previewOperation,
  validateMetricCatalog,
  validateProduct,
} from './product-api.js';

const $ = id => document.getElementById(id);
const html = text => DOMPurify.sanitize(marked.parse(text || ''));
let deck, store, pool, advisor, workspace, sequence, runbook, runs, conversationView, currentGroup, currentIndex, editingRun, currentTerminal = null, currentSlide = null, toastTimer;
let saveDeckCopy, filling = false, editingTab, conversationPanel = null, adoptingSuggestion = false;
let sourceDeck, metricCatalogData, productApi;

function visiblePanels() { return slidePanels(currentSlide, deck, currentGroup); }
function stepTitle(step) { return step.group ? `监控组 → ${deck.monitorGroups[step.group].label}` : `${panelConfig(deck, step.panel).label || step.panel} → ${panelConfig(deck, step.panel).commands[step.index].title}`; }
function setGroup(group) {
  store.data.monitorGroups ||= {};
  store.data.monitorGroups[currentIndex] = group; store.save(); showSlide(currentIndex);
}
function revealPanel(id) {
  if (!slidePanels(currentSlide, deck).includes(id)) Reveal.slide(deck.slides.findIndex(slide => slidePanels(slide, deck).includes(id)));
  if (!visiblePanels().includes(id)) setGroup(currentSlide.monitorGroups.find(group => deck.monitorGroups[group].panels.includes(id)));
}

function editRun(id) {
  editingRun = workspace.sessionId(id);
  const run = runs.get(editingRun), date = new Date(run?.fields.monitoring_started_at_ms ?? run?.started_at_ms ?? Date.now());
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  $('run-start').value = date.toISOString().slice(0, 19);
  $('run-fields').value = JSON.stringify(run?.fields || {}, null, 2);
  $('run-title').textContent = `运行信息 · ${panelConfig(deck, id).label || id} · ${terminalTabs(panelConfig(deck, id)).find(tab => tab.id === workspace.activeTab(id)).label}`;
  $('run-error').textContent = ''; $('run-dialog').showModal();
}

function toast(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 8000 : 3500);
}

function terminalStatus(key, status, error) {
  workspace?.status(key, status);
  if (!currentTerminal || isDashboard() || key !== workspace?.sessionId(currentTerminal)) return;
  $('connection-dot').className = `status-dot ${status}`;
  $('connection-status').textContent = ({connecting:'连接中', closing:'关闭中', restarting:'重启中', ready:'已连接', closed:'连接已断开', error:'连接失败'})[status];
  $('fill-command').disabled = filling;
  if (error) toast(error, true);
}

function currentConfig() { return panelConfig(deck, currentTerminal); }
function isDashboard(id = currentTerminal) { return Object.hasOwn(deck.dashboards || {}, id); }

function productRejected(error, operation = null) {
  return {
    status:'rejected',
    operationType:operation?.type || null,
    issues:error.issues || [{code:error.code || 'OPERATION_FAILED', message:error.message, path:null}],
  };
}

function commitProductDeck(next, affectedPanels = []) {
  const updated = validateDeck(next), previous = deck;
  deck = updated; store.deck = updated; workspace.deck = updated;
  saveDeckCopy();
  $('deck-title').textContent = deck.title;
  document.title = `${deck.title} · Live Deck`;
  for (const id of affectedPanels) {
    const config = panelConfig(deck, id), state = store.terminal(id);
    if (config?.chart) {
      delete state.configSignature;
      delete state.chartRequest;
      delete state.chartSnapshot;
      const entry = workspace.cards.get(id);
      if (entry) {
        entry.chartKey = null;
        entry.chartData = null;
        entry.chartError = null;
        entry.chartReset = true;
        workspace.refresh(id);
      }
    }
  }
  workspace.update();
  renderSequence();
  if (currentTerminal) renderPlan();
  return previous;
}

function createProductApi() {
  let undoRecord = null, sequenceNumber = 0;
  const inspect = () => inspectState({
    deck, sourceDeck, store, workspace, sequence, charts:workspace.charts, catalog:metricCatalogData,
    currentSlideIndex:currentIndex ?? Reveal.getIndices().h, currentGroup, currentPanel:currentTerminal,
  });
  const api = {
    version:PRODUCT_API_VERSION,
    catalog:structuredClone(metricCatalogData),
    inspect,
    preview(operation, options = {}) {
      return previewOperation(deck, operation, {
        catalog:metricCatalogData,
        expectedRevision:options.expectedRevision,
      });
    },
    validate(options = {}) {
      try {
        const candidate = options.operation
          ? prepareOperation(deck, options.operation, {catalog:metricCatalogData, expectedRevision:options.expectedRevision}).deck
          : deck;
        return validateProduct(candidate, {
          catalog:metricCatalogData,
          replay:options.replay !== false,
          panel:options.panel,
        });
      } catch (error) {
        return {
          valid:false,
          checkedAtMs:Date.now(),
          effectiveRevision:effectiveRevision(deck),
          levels:{static:{ok:false}, capabilities:{ok:false}, replay:{ok:null, checks:[]}},
          issues:error.issues || [{code:error.code || 'VALIDATION_FAILED', message:error.message, path:null}],
        };
      }
    },
    apply(request = {}) {
      const operation = request.operation || request;
      try {
        const prepared = prepareOperation(deck, operation, {
          catalog:metricCatalogData,
          expectedRevision:request.expectedRevision,
        });
        const validation = validateProduct(prepared.deck, {
          catalog:metricCatalogData,
          replay:true,
          panel:prepared.affectedPanels.find(id => deck.dashboards?.[id]?.chart),
        });
        if (!validation.valid) return {status:'rejected', operationType:operation.type, issues:validation.issues};
        const token = `undo-${Date.now()}-${++sequenceNumber}`;
        if (prepared.runtimeOperation) {
          const state = store.terminal(prepared.runtimeOperation.panel);
          const previous = {panel:prepared.runtimeOperation.panel, draft:state.draft ?? null,
            freeTab:state.freeTab ?? null, preparedTab:state.preparedTab ?? null};
          state.draft = prepared.runtimeOperation.text;
          state.freeTab = prepared.runtimeOperation.tab;
          state.preparedTab = prepared.runtimeOperation.tab;
          store.save();
          if (currentTerminal === prepared.runtimeOperation.panel) renderPlan();
          undoRecord = {token, previousDraft:previous, affectedPanels:prepared.affectedPanels};
        } else {
          const previousDeck = commitProductDeck(prepared.deck, prepared.affectedPanels);
          undoRecord = {token, previousDeck, affectedPanels:prepared.affectedPanels};
        }
        return {
          status:'applied',
          operationType:operation.type,
          affectedPanels:prepared.affectedPanels,
          diff:prepared.diff,
          beforeRevision:prepared.beforeRevision,
          afterRevision:prepared.runtimeOperation ? prepared.beforeRevision : prepared.afterRevision,
          runtimeOperation:prepared.runtimeOperation,
          validation,
          undoToken:token,
        };
      } catch (error) {
        return productRejected(error, operation);
      }
    },
    undo(token) {
      if (!undoRecord || token !== undoRecord.token) return {
        status:'rejected',
        operationType:'undo',
        issues:[{code:'UNDO_NOT_FOUND', message:'没有匹配的、仍可撤销的操作', path:null}],
      };
      const record = undoRecord;
      if (record.previousDeck) commitProductDeck(record.previousDeck, record.affectedPanels);
      else if (record.previousDraft) {
        const {panel} = record.previousDraft;
        const state = store.terminal(panel);
        state.draft = record.previousDraft.draft;
        state.freeTab = record.previousDraft.freeTab;
        state.preparedTab = record.previousDraft.preparedTab;
        store.save();
        if (currentTerminal === panel) renderPlan();
      }
      undoRecord = null;
      return {status:'undone', operationType:'undo', affectedPanels:record.affectedPanels};
    },
  };
  return api;
}

function selectPanel(id, index) {
  const changed = currentTerminal !== id;
  currentTerminal = id;
  if (!adoptingSuggestion) conversationPanel = id;
  const config = currentConfig(), state = store.terminal(id);
  if (index !== undefined) { state.selected = index; state.draft = config.commands[index]?.command || ''; store.save(); }
  if (changed) $('plan-search').value = '';
  $('session-label').textContent = config.label || id;
  $('fill-command').textContent = isDashboard() ? '打开图表 ↗' : '填入终端 ↗';
  if (isDashboard()) {
    $('connection-status').textContent = '图表面板'; $('connection-dot').className = 'status-dot ready'; $('fill-command').disabled = false;
  } else terminalStatus(workspace.sessionId(id), pool.sessions.get(workspace.sessionId(id))?.status || (workspace.activeTab(id) ? 'connecting' : 'closed'));
  workspace.select(id); renderPlan(); renderConversation();
}

function renderSequence() {
  const next = sequence.next;
  $('sequence-next').textContent = next
    ? `计划 ${sequence.state.cursor + 1} / ${sequence.steps.length} · ${stepTitle(next)}`
    : sequence.steps.length ? '本轮演示顺序已完成 · 仍可自由操作' : '自由演示 · 可在 sequence 中关联各面板的命令';
  $('sequence-next').title = next ? `定位计划：${stepTitle(next)}（不执行命令）` : '可以选择候选命令或自由输入';
  for (const name of ['sequence-skip', 'sequence-complete', 'sequence-next']) $(name).disabled = !next;
  $('sequence-back').disabled = sequence.state.cursor === 0;
  workspace.update();
}

function focusNext() {
  const next = sequence.next; if (!next) return;
  if (next.group) {
    if (!currentSlide.monitorGroups?.includes(next.group)) Reveal.slide(deck.slides.findIndex(slide => slide.monitorGroups?.includes(next.group)));
    setGroup(next.group); return;
  }
  revealPanel(next.panel);
  selectPanel(next.panel, next.index);
  $('plan-search').value = ''; workspace.cards.get(next.panel).search.value = ''; renderPlan();
}

function advanceSequence(skip = false) {
  const next = sequence.next; if (!next) return;
  if (!skip && !next.group) {
    const state = store.terminal(next.panel);
    if (!state.completed.includes(next.index)) state.completed.push(next.index);
  }
  sequence.advance(skip); renderSequence();
  if (sequence.next) focusNext(); else renderPlan();
}

function renderPlan() {
  if (!currentTerminal) return;
  const config = currentConfig(), state = store.terminal(currentTerminal);
  state.selected = Math.min(Math.max(0, state.selected), Math.max(0, config.commands.length - 1));
  $('plan-count').textContent = `${state.completed.filter(n => n < config.commands.length).length} / ${config.commands.length}`;
  runbook.update(config.commands, state, sequence.next?.panel === currentTerminal ? sequence.next.index : -1, $('plan-search').value);
  workspace.update();
  const command = config.commands[state.selected];
  const preview = command?.preview;
  if (preview && workspace.visible.includes(preview.panel) && store.terminal(preview.panel).baseUrl !== preview.url) {
    workspace.navigate(preview.panel, preview.url);
  }
  const target = $('terminal-target'); target.hidden = isDashboard();
  if (!isDashboard()) {
    target.replaceChildren(...terminalTabs(config).map(tab => { const option = document.createElement('option'); option.value = tab.id; option.textContent = tab.label + (workspace.isTabClosed(currentTerminal, tab.id) ? '（已关闭）' : ''); return option; }));
    const preparedTab = terminalTabs(config).some(tab => tab.id === state.preparedTab) ? state.preparedTab : null;
    target.value = preparedTab || (command ? commandTab(config, state, sequence.matches(currentTerminal, state.selected) ? sequence.next : null) : state.freeTab || workspace.activeTab(currentTerminal) || MAIN_TAB);
    target.title = `填入目标：${target.selectedOptions[0]?.textContent || ''}；填入时自动切换 tab`;
  }
  $('step-label').textContent = command ? `${String(state.selected + 1).padStart(2, '0')} · ${command.title}` : '自由输入';
  $('step-note').textContent = command?.note || '可以随时在终端自由操作，再回到计划继续。';
  $('command-input').value = state.draft ?? command?.command ?? '';
  $('command-input').title = `${config.label || currentTerminal} · ${command?.title || '自由输入'}${command?.note ? '\n' + command.note : ''}`;
  $('previous-command').disabled = state.selected === 0;
  $('complete-command').disabled = config.commands.length === 0;
}

function selectCommand(delta, markDone = false) {
  const state = store.terminal(currentTerminal), config = currentConfig();
  if (markDone && sequence.matches(currentTerminal, state.selected)) { advanceSequence(); return; }
  if (markDone && !state.completed.includes(state.selected)) state.completed.push(state.selected);
  delete state.preparedTab;
  state.selected = Math.max(0, Math.min(config.commands.length - 1, state.selected + delta));
  state.draft = config.commands[state.selected]?.command || ''; store.save(); renderPlan();
  $('command-list').querySelector('.selected')?.scrollIntoView({block:'nearest'});
}

function renderConversation() {
  if (!conversationPanel) return;
  const label = $('ai-conversation-label');
  if (label) label.textContent = `对话：${panelConfig(deck, conversationPanel).label || conversationPanel}`;
  conversationView.render(store.terminal(conversationPanel).conversation, conversationPanel);
}

function newAIConversation() {
  if (!conversationPanel || advisor.busy) return;
  store.terminal(conversationPanel).conversation = [];
  conversationView.clear(conversationPanel);
  $('ai-question').value = ''; renderConversation(); store.save();
  if ($('ai-content').hidden) $('toggle-ai').click();
  $('ai-question').focus();
  if (!store.saveFailed) toast(`已开启新对话 · ${panelConfig(deck, conversationPanel).label || conversationPanel}`);
}

async function resetProgress() {
  const button = $('reset-progress');
  if (button.disabled) return;
  button.disabled = true; button.textContent = '重置中…'; $('edit-deck').disabled = true;
  try {
    const result = await workspace.resetTerminals();
    store.resetProgress();
    $('plan-search').value = ''; runbook.page = 0;
    for (const entry of workspace.cards.values()) {
      entry.search.value = ''; entry.runbook.page = 0;
    }
    renderSequence(); renderPlan();
    Reveal.slide(0);
    if (result.failures.length) toast(`进度已重置；${result.failures.length} 个终端处理失败，可再次重置重试。${result.failures.join('；')}`, true);
    else if (!store.saveFailed) toast(`进度已重置，已回到第一页；临时 tab 已关闭 ${result.closed} 个，固定 tab 已重启 ${result.restarted} 个`);
  } catch (error) { toast(`重置未完成：${error.message}`, true); }
  finally { button.disabled = false; button.textContent = '重置进度'; $('edit-deck').disabled = false; }
}

function fullscreenAI(open) {
  workspace.zoom(null);
  $('ai-panel').classList.toggle('ai-fullscreen', open);
  $('fullscreen-ai').textContent = open ? '退出全屏' : '全屏';
  $('fullscreen-ai').setAttribute('aria-label', `${open ? '退出全屏' : '全屏'}现场 AI 助手`);
  $('toggle-ai').disabled = open;
  if (open) { $('ai-content').hidden = false; $('toggle-ai').setAttribute('aria-expanded','true'); $('ai-chevron').textContent = '−'; }
  requestAnimationFrame(() => pool.resize());
}

async function askAI(event) {
  event.preventDefault();
  const question = $('ai-question').value.trim();
  if (!question || !conversationPanel || advisor.busy) return;
  const id = conversationPanel, state = store.terminal(id);
  const context = advisorContext({question, deck, store, workspace, pool, sequence, slide:currentSlide,
    conversationPanel:id, operationPanel:currentTerminal, productState:productApi?.inspect() || null});
  const reply = createReply();
  state.conversation.push({role:'user', text:question}, reply);
  $('ai-question').value = ''; $('ask-ai').disabled = true; $('new-ai-session').disabled = true;
  $('new-ai-session').title = '请等待当前回答结束后开启新对话'; renderConversation();
  let paintTimer = null, lastSave = 0;
  const paint = () => { paintTimer = null; if (conversationPanel === id) renderConversation(); };
  try {
    await advisor.ask(context, event => {
      applyAdvisorEvent(reply, event);
      if (!paintTimer) paintTimer = setTimeout(paint, 60);
      if (Date.now() - lastSave > 1000) { store.save(); lastSave = Date.now(); }
    });
  } catch (error) { applyAdvisorEvent(reply, {type:'error', message:error.message}); }
  finally {
    clearTimeout(paintTimer);
    reply.pending = false; store.save(); $('ask-ai').disabled = false;
    $('new-ai-session').disabled = false;
    $('new-ai-session').title = '清空当前 AI 对话；保留终端历史和演示上下文';
    if (conversationPanel === id) renderConversation();
  }
}

function showSlide(index) {
  $('command-options').open = false;
  if (!adoptingSuggestion && $('ai-panel').classList.contains('ai-fullscreen')) fullscreenAI(false);
  currentIndex = index;
  currentSlide = deck.slides[index];
  const choices = currentSlide.monitorGroups || [], savedGroup = store.data.monitorGroups?.[index];
  currentGroup = choices.includes(savedGroup) ? savedGroup : currentSlide.monitorGroup || choices[0];
  $('monitor-group').replaceChildren(...choices.map(id => { const option = document.createElement('option'); option.value = id; option.textContent = deck.monitorGroups[id].label; return option; }));
  if (currentGroup) $('monitor-group').value = currentGroup;
  $('monitor-group-label').hidden = !choices.length;
  $('slide-counter').textContent = `${String(index + 1).padStart(2,'0')} / ${String(deck.slides.length).padStart(2,'0')}`;
  [...$('slide-timeline').children].forEach((item, i) => item.classList.toggle('current', i === index));
  $('previous-slide').disabled = index === 0; $('next-slide').disabled = index === deck.slides.length - 1;
  const ids = visiblePanels(), terminalPage = ids.length > 0;
  $('monitor-controls').hidden = !ids.some(id => Object.hasOwn(deck.dashboards || {}, id));
  for (const button of ['pause-monitors','follow-monitors']) $(button).disabled = !ids.some(id => panelConfig(deck, id)?.binding);
  $('workbench').hidden = false;
  $('workbench').classList.toggle('offstage', !terminalPage);
  $('workbench').inert = !terminalPage;
  $('workbench').setAttribute('aria-hidden', String(!terminalPage));
  if (!terminalPage) { currentTerminal = null; return; }
  sequence.setScope(ids.find(id => deck.terminals?.[id]?.independentSequence) || null);
  const target = ids.includes(currentTerminal) ? currentTerminal : ids.includes(sequence.next?.panel) ? sequence.next.panel : ids[0];
  $('terminal-title').textContent = currentSlide.title;
  $('terminal-title').title = currentSlide.title;
  $('terminal-kicker').textContent = `LIVE SESSION / ${String(index + 1).padStart(2, '0')}`;
  $('workbench').classList.toggle('multiple', ids.length > 1);
  $('workbench').classList.remove('show-plan');
  $('workspace-layout').value = currentSlide.layout || 'columns';
  $('workspace-layout').hidden = ids.length < 2;
  $('toggle-plan').hidden = ids.length < 2;
  workspace.show(ids, currentSlide.layout || 'columns', target);
  selectPanel(target); renderSequence();

}

async function boot() {
  const [deployment, catalog] = await Promise.all([
    (await fetch('./deployment.json')).json(),
    (await fetch(new URL('./metric-catalog.json', import.meta.url), {cache:'no-store'})).json(),
  ]);
  metricCatalogData = validateMetricCatalog(catalog);
  await Promise.all((deployment.stylesheets || []).map(href => new Promise((resolve, reject) => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
    link.onload = resolve; link.onerror = () => reject(new Error(`无法加载演示样式：${href}`));
    document.head.append(link);
  })));
  const requested = new URLSearchParams(location.search).get('deck');
  const example = ['multi-panel', 'monitoring'].includes(requested) ? requested : null;
  $('studio-link').href = `./studio.html${example ? `?deck=${encodeURIComponent(example)}` : ''}`;
  const defaultDeck = await (await fetch(example ? `./${example}.json` : './deck.json', {cache:'no-store'})).json();
  sourceDeck = structuredClone(defaultDeck);
  const storageKey = deployment.storageScope === 'deck'
    ? `live-deck:custom:${defaultDeck.id}${defaultDeck.revision ? `:${defaultDeck.revision}` : ''}`
    : example ? `live-deck:${example}` : 'live-deck:current';
  const temporaryTabsKey = `${storageKey}:temporary-tabs`;
  let temporaryTabs = {}, fixedTabs = {};
  saveDeckCopy = () => {
    try { localStorage.setItem(storageKey, JSON.stringify(deck)); localStorage.setItem(temporaryTabsKey, JSON.stringify({version:2, temporary:temporaryTabs, fixed:fixedTabs})); }
    catch { toast('浏览器存储不可用，tab 设置暂存于本页，请导出演示保存。', true); }
  };
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch {}
  const refreshed = refreshSourceMonitoring(defaultDeck, saved);
  deck = validateDeck(refreshed); store = new DeckStore(deck, localStorage, message => toast(message, true));
  let tabMetadata;
  try { tabMetadata = saved && JSON.parse(localStorage.getItem(temporaryTabsKey) || 'null'); } catch {}
  ({temporary:temporaryTabs, fixed:fixedTabs} = restoreTabOrigins(deck, defaultDeck, tabMetadata));
  if (saved && refreshed !== saved) saveDeckCopy();
  for (const config of Object.values(store.data.terminals)) {
    for (const message of config.conversation || []) if (message.pending) { message.pending = false; message.error = '上次回答因页面刷新而中断，已保留收到的内容，可以重新提问。'; }
  }
  const base = location.pathname.includes('/custom/') ? location.pathname.split('/custom/')[0] + '/' : deployment.jupyterBaseUrl;
  const client = new JupyterClient(base);
  runs = new RunContexts(store, id => workspace?.runChanged(id));
  pool = new TerminalPool(client, $('terminal-viewport'), deck.id, terminalStatus, (id, event) => runs.accept(id, event), id => runs.clear(id));
  advisor = new CodexAdvisor(client, deployment, deck.id);
  sequence = new Sequence(deck, store);
  const target = document.createElement('select'); target.id = 'terminal-target'; target.setAttribute('aria-label', '填入目标 tab');
  document.querySelector('.action-command').prepend(target);
  const tabDialog = document.createElement('dialog'); tabDialog.id = 'terminal-tab-dialog';
  tabDialog.innerHTML = '<form method="dialog"><div class="dialog-heading"><h2 id="terminal-tab-title">新建临时 tab</h2><button value="cancel" formnovalidate>取消</button></div><label>名称 <input id="terminal-tab-name" maxlength="80" required autocomplete="off"></label><p>临时 tab 可关闭；每个 tab 是独立 Shell，SSH 需分别连接。</p><div class="dialog-actions"><button id="save-terminal-tab" class="primary" value="save">保存</button></div></form>';
  document.body.append(tabDialog);
  const closeDialog = document.createElement('dialog'); closeDialog.id = 'close-terminal-tab-dialog';
  closeDialog.innerHTML = '<form method="dialog"><div class="dialog-heading"><h2 id="close-terminal-tab-title">关闭终端 tab</h2></div><p>关闭会结束此 tab 的 Shell 连接，正在运行的任务可能中断。</p><p>名称和计划引用会保留；重新打开或再次填入时，会创建新的 Shell。</p><p id="close-terminal-tab-error" role="alert"></p><div class="dialog-actions"><button value="cancel">取消</button><button id="confirm-close-terminal-tab" class="terminal-close-confirm" value="close">关闭并结束 Shell</button></div></form>';
  document.body.append(closeDialog);
  let closingTab, closePending = false;
  closeDialog.addEventListener('cancel', event => { if (closePending) event.preventDefault(); });
  closeDialog.querySelector('form').onsubmit = async event => {
    if (event.submitter?.value !== 'close') return;
    event.preventDefault(); if (closePending) return;
    closePending = true; closeDialog.querySelectorAll('button').forEach(button => button.disabled = true);
    const {id, tab} = closingTab;
    try { await workspace.closeTab(id, tab); closeDialog.close(); toast('终端 tab 已关闭；名称和计划引用已保留'); }
    catch (error) { $('close-terminal-tab-error').textContent = `关闭失败：${error.message}。tab 已保留，可以重试。`; }
    finally { closePending = false; closeDialog.querySelectorAll('button').forEach(button => button.disabled = false); }
  };
  tabDialog.querySelector('form').onsubmit = event => {
    if (event.submitter?.value !== 'save') return;
    const label = $('terminal-tab-name').value.trim();
    if (!label) { event.preventDefault(); $('terminal-tab-name').focus(); return; }
    const {id, tab} = editingTab, config = panelConfig(deck, id);
    config.tabs ||= {};
    let next = tab, number = 2;
    if (!next) { while (Object.hasOwn(config.tabs, `tab-${number}`)) number++; next = `tab-${number}`; }
    if (!tab) { temporaryTabs[id] ||= []; temporaryTabs[id].push(next); }
    config.tabs[next] = {...config.tabs[next], label}; saveDeckCopy();
    workspace.activateTab(id, next).catch(error => workspace.report(error)); selectPanel(id);
  };
  workspace = new PanelWorkspace($('terminal-viewport'), deck, pool, store, sequence, selectPanel, message => toast(message, true), runs, editRun, (id, tab) => {
    editingTab = {id, tab};
    $('terminal-tab-title').textContent = tab ? '重命名终端 tab' : '新建临时 tab';
    $('terminal-tab-name').value = tab ? terminalTabs(panelConfig(deck, id)).find(item => item.id === tab).label : '';
    tabDialog.showModal(); $('terminal-tab-name').focus();
  }, (id, tab) => {
    if (!workspace.isTemporaryTab(id, tab)) return;
    closingTab = {id, tab};
    $('close-terminal-tab-title').textContent = `关闭 ${terminalTabs(panelConfig(deck, id)).find(item => item.id === tab).label}？`;
    $('close-terminal-tab-error').textContent = ''; closeDialog.showModal();
  }, temporaryTabs);
  workspace.charts = new LiveCharts(workspace, client, deployment, deck.id);
  runbook = new RunbookList($('command-list'), $('plan-pages'), index => selectPanel(currentTerminal, index));
  conversationView = new ConversationView($('ai-messages'), html, id => {
    const config = panelConfig(deck, id); return config ? config.label || id : null;
  }, (target, suggestion) => {
    // Revealing a suggestion may also change the slide or monitoring group.
    adoptingSuggestion = true;
    try { revealPanel(target); selectPanel(target); }
    finally { adoptingSuggestion = false; }
    const state = store.terminal(target); state.draft = suggestion.command; store.save();
    $('command-input').value = suggestion.command;
    if (!$('ai-panel').classList.contains('ai-fullscreen')) $('command-input').focus({preventScroll:true});
    toast(`已放入 ${panelConfig(deck, target).label || target} 的待执行内容`);
  }, () => store.save());
  $('deck-title').textContent = deck.title; document.title = `${deck.title} · Live Deck`;
  deck.slides.forEach((slide, index) => {
    const section = document.createElement('section'); section.id = `page-${index + 1}`;
    if (slide.type === 'slide') {
      const kicker = document.createElement('div'); kicker.className = 'slide-kicker'; kicker.textContent = slide.kicker || `LIVE DECK / ${String(index + 1).padStart(2, '0')}`;
      const title = document.createElement('h1'); title.textContent = slide.title;
      const content = document.createElement('div'); content.className = 'slide-markdown'; content.innerHTML = html(slide.markdown);
      const decoration = document.createElement('div'); decoration.className = 'slide-decoration';
      section.append(kicker, title, content, decoration);
    }
    $('slides').append(section);
    const button = document.createElement('button'); button.className = slide.type; button.title = `${index + 1} · ${slide.title}`; button.setAttribute('aria-label', `第 ${index + 1} 页：${slide.title}`);
    button.addEventListener('click', () => Reveal.slide(index)); $('slide-timeline').append(button);
  });
  Reveal.on('slidechanged', event => showSlide(event.indexh));
  await Reveal.initialize({controls:false, progress:false, center:false, hash:true, transition:'fade',
    width:1200, height:690, margin:0.025, keyboardCondition: () => !workspace.zoomed && !$('ai-panel').classList.contains('ai-fullscreen') && !$('command-options').open && !document.querySelector('dialog[open]') && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)});
  showSlide(Reveal.getIndices().h);
  productApi = createProductApi();
  window.liveDeck = {
    get deck(){return deck;}, store, pool, advisor, client, workspace, sequence, runs, productApi,
    selectPanel, setGroup, goTo:index => Reveal.slide(index),
  };

  $('sequence-next').onclick = focusNext;
  $('sequence-complete').onclick = () => advanceSequence();
  $('sequence-skip').onclick = () => advanceSequence(true);
  $('sequence-back').onclick = () => { sequence.back(); renderSequence(); focusNext(); };
  $('reset-progress').onclick = resetProgress;
  for (const [edge, label, collapsedText, expandedText] of [
    ['top', '顶部工具栏', '顶部工具 ▾', '收起工具 ▴'],
    ['bottom', '底部翻页栏', '底部翻页 ▴', '收起翻页 ▾'],
  ]) {
    const button = $(`toggle-${edge}-toolbar`);
    button.onclick = () => {
      const hidden = document.body.classList.toggle(`${edge}-toolbar-hidden`);
      button.textContent = hidden ? collapsedText : expandedText;
      button.title = `${hidden ? '展开' : '收起'}${label}`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-expanded', String(!hidden));
      requestAnimationFrame(() => { Reveal.layout(); pool.resize(); });
    };
  }
  $('command-options').addEventListener('click', event => { if (event.target.closest('button')) $('command-options').open = false; });
  document.addEventListener('pointerdown', event => { if (!$('command-options').contains(event.target)) $('command-options').open = false; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('command-options').open) {
      $('command-options').open = false; $('command-options').querySelector('summary').focus(); event.stopPropagation();
    }
  }, true);
  $('workspace-layout').onchange = () => { workspace.show(visiblePanels(), $('workspace-layout').value, currentTerminal); $('command-options').open = false; };
  $('monitor-group').onchange = () => setGroup($('monitor-group').value);
  $('pause-monitors').onclick = () => workspace.followVisible(false);
  $('follow-monitors').onclick = () => workspace.followVisible(true);
  $('monitor-time').onclick = () => $('time-dialog').showModal();
  $('close-time').onclick = () => $('time-dialog').close();
  $('apply-time').onclick = () => { try { workspace.timeVisible($('monitor-from').value.trim(), $('monitor-to').value.trim()); $('time-dialog').close(); } catch (error) { toast(error.message, true); } };
  $('close-run').onclick = () => $('run-dialog').close();
  for (const [button, fresh] of [['save-run', false], ['new-run', true]]) $(button).onclick = () => {
    try { runs.manual(editingRun, JSON.parse($('run-fields').value), new Date($('run-start').value).getTime(), fresh); $('run-dialog').close(); }
    catch (error) { $('run-error').textContent = error.message; }
  };
  $('toggle-plan').onclick = () => { $('workbench').classList.toggle('show-plan'); requestAnimationFrame(() => pool.resize()); };
  $('previous-slide').onclick = () => Reveal.prev(); $('next-slide').onclick = () => Reveal.next();
  $('plan-search').oninput = renderPlan;
  $('command-input').oninput = () => { store.terminal(currentTerminal).draft = $('command-input').value; store.save(); };
  target.onchange = () => {
    const config = currentConfig(), state = store.terminal(currentTerminal);
    delete state.preparedTab;
    if (sequence.matches(currentTerminal, state.selected)) {
      sequence.next.tab = target.value; deck.sequence[sequence.next.sourceIndex].tab = target.value; saveDeckCopy();
    } else if (config.commands[state.selected]) { config.commands[state.selected].tab = target.value; saveDeckCopy(); }
    else { state.freeTab = target.value; store.save(); }
    renderPlan();
  };
  $('fill-command').onclick = async () => {
    if (filling) return;
    const id = currentTerminal, text = $('command-input').value, tab = target.value;
    filling = true; $('fill-command').disabled = true;
    try { if (isDashboard(id)) workspace.navigate(id, text); else await workspace.fill(id, tab, text); }
    catch (error) { workspace.report(error); }
    finally { filling = false; $('fill-command').disabled = false; }
  };
  $('previous-command').onclick = () => selectCommand(-1); $('complete-command').onclick = () => selectCommand(1, true);
  $('toggle-ai').onclick = () => {
    const open = $('ai-content').hidden; $('ai-content').hidden = !open;
    $('toggle-ai').setAttribute('aria-expanded', String(open)); $('ai-chevron').textContent = open ? '−' : '＋';
    requestAnimationFrame(() => pool.resize()); if (open) $('ai-question').focus();
  };
  $('fullscreen-ai').onclick = () => fullscreenAI(!$('ai-panel').classList.contains('ai-fullscreen'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('ai-panel').classList.contains('ai-fullscreen') && !document.querySelector('dialog[open]')) { fullscreenAI(false); event.stopPropagation(); }
  }, true);
  $('ai-form').onsubmit = askAI;
  $('new-ai-session').onclick = newAIConversation;
  $('ai-question').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('ai-form').requestSubmit(); } };
  $('show-context').onclick = () => {
    $('context-title').textContent = '当前面板上下文';
    $('context-text').textContent = JSON.stringify(advisorContext({question:$('ai-question').value.trim(),
      deck, store, workspace, pool, sequence, slide:currentSlide, conversationPanel, operationPanel:currentTerminal,
      productState:productApi?.inspect() || null}), null, 2);
    $('context-dialog').showModal();
  };
  $('copy-state').onclick = async () => {
    const text = JSON.stringify(productApi.inspect(), null, 2);
    try { await navigator.clipboard.writeText(text); toast('当前 Live Deck 状态已复制'); }
    catch {
      $('context-title').textContent = '当前 Live Deck 状态';
      $('context-text').textContent = text;
      $('context-dialog').showModal();
      toast('浏览器未允许自动复制，已打开可复制的状态文本', true);
    }
  };
  $('close-context').onclick = () => $('context-dialog').close();
  $('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch (error) { toast(error.message, true); } };
  $('edit-deck').onclick = () => { $('deck-editor').value = JSON.stringify(deck, null, 2); $('editor-error').textContent = ''; $('editor-dialog').showModal(); };
  $('close-editor').onclick = () => $('editor-dialog').close();
  $('save-deck').onclick = () => {
    try { const updated = validateDeck(JSON.parse($('deck-editor').value)); localStorage.setItem(temporaryTabsKey, JSON.stringify({version:2, temporary:{}, fixed:fixedTabDefinitions(updated)})); localStorage.setItem(storageKey, JSON.stringify(updated)); location.reload(); }
    catch (error) { $('editor-error').textContent = error.message; }
  };
  $('import-deck').onchange = async event => {
    try { $('deck-editor').value = JSON.stringify(validateDeck(JSON.parse(await event.target.files[0].text())), null, 2); $('editor-error').textContent = ''; }
    catch (error) { $('editor-error').textContent = error.message; }
  };
  $('export-deck').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(deck, null, 2)], {type:'application/json'}));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${deck.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

boot().catch(error => { console.error(error); toast(error.message, true); });
