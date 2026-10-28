import {
  lintDeck,
  refreshSourceMonitoring,
  singleLineCommand,
  validateDeck,
  validateDeckReport,
} from './model.js';
import {effectiveRevision, validateProduct} from './product-api.js';
import {fixedTabDefinitions} from './tabs.js';
import {
  addCommand,
  addDashboard,
  addTerminal,
  createPage,
  moveItem,
  panelEntries,
  prepareDeckForEditing,
  removePanel,
  removeTab,
  renamePanel,
  uniqueId,
} from './studio-model.js';

const $ = id => document.getElementById(id);
const DRAFT_VERSION = 1;
const TYPE_LABELS = {slide:'讲解页', terminal:'终端页', workspace:'分屏页'};
const STORAGE_PREFIX = 'live-deck:studio';
const state = {
  pageIndex: 0,
  panelId: null,
  inspector: 'page',
  history: [],
  future: [],
  diagnostics: null,
  saveTimer: null,
  diagnosticTimer: null,
  toastTimer: null,
  deck: null,
  sourceDeck: null,
  catalog: null,
  storageKey: null,
  temporaryTabsKey: null,
  previewReady: false,
  previewSignature: null,
  previewStructureSignature: null,
  previewDeck: null,
  inlineEdit: null,
};

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
const pointerPart = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const pointer = (...parts) => `/${parts.map(pointerPart).join('/')}`;

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3200);
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeDeck(value) {
  try { return prepareDeckForEditing(value); }
  catch (error) { throw new Error(`文稿结构无法进入 Studio：${error.message}`); }
}

function playerUrl() {
  const url = new URL('./index.html', location.href);
  const deckName = new URLSearchParams(location.search).get('deck');
  if (deckName) url.searchParams.set('deck', deckName);
  url.hash = '#/0';
  return url.href;
}

const PREVIEW_EVENTS = {
  boot:'live-deck-studio:boot',
  ready:'live-deck-studio:ready',
  setDeck:'live-deck-studio:set-deck',
  updateField:'live-deck-studio:update-field',
  goTo:'live-deck-studio:go-to',
  selectField:'live-deck-studio:select-field',
  selectPanel:'live-deck-studio:select-panel',
  error:'live-deck-studio:error',
};

function previewFrame() {
  return $('player-preview');
}

function postPreview(type, payload = {}, {force = false} = {}) {
  const frame = previewFrame();
  if ((!state.previewReady && !force) || !frame?.contentWindow) return false;
  frame.contentWindow.postMessage({type, ...payload}, location.origin);
  return true;
}

function layoutPreviewStage() {
  const container = $('page-preview'), stage = $('preview-stage');
  if (!container || !stage) return;
  const width = Math.max(1, container.clientWidth - 40);
  const height = Math.max(1, container.clientHeight - 40);
  const scale = Math.min(width / 1200, height / 690);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}

function syncPreview({force = false} = {}) {
  if (!state.previewReady) return;
  const signature = JSON.stringify(state.deck);
  const structure = previewStructureSignature(state.deck);
  if (!force && signature === state.previewSignature) {
    postPreview(PREVIEW_EVENTS.goTo, {pageIndex:state.pageIndex});
    return;
  }
  if (!force && state.previewDeck && structure === state.previewStructureSignature) {
    for (const [pageIndex, slide] of state.deck.slides.entries()) {
      const previous = state.previewDeck.slides[pageIndex];
      for (const field of ['kicker', 'title', 'markdown']) {
        if ((slide[field] || '') !== (previous?.[field] || '')) {
          postPreview(PREVIEW_EVENTS.updateField, {pageIndex, field, value:slide[field] || ''});
        }
      }
    }
    postPreview(PREVIEW_EVENTS.goTo, {pageIndex:state.pageIndex});
    state.previewSignature = signature;
    state.previewDeck = jsonClone(state.deck);
    return;
  }
  state.previewSignature = signature;
  state.previewStructureSignature = structure;
  state.previewDeck = jsonClone(state.deck);
  state.previewReady = false;
  $('preview-loading').hidden = false;
  $('preview-loading').textContent = '正在更新播放器画布…';
  postPreview(PREVIEW_EVENTS.setDeck, {deck:jsonClone(state.deck), pageIndex:state.pageIndex}, {force:true});
}

function previewStructureSignature(deck) {
  const structural = jsonClone(deck);
  for (const slide of structural.slides || []) {
    delete slide.kicker;
    delete slide.title;
    delete slide.markdown;
    delete slide.speakerNotes;
  }
  return JSON.stringify(structural);
}

function selectedSlide() {
  return state.deck.slides[state.pageIndex] || state.deck.slides[0];
}

function selectedPanel() {
  return panelEntries(state.deck).find(panel => panel.id === state.panelId) || panelEntries(state.deck)[0] || null;
}

function pageSubtitle(slide) {
  if (slide.type === 'terminal') return slide.terminal || '未选择终端';
  if (slide.type === 'workspace') return (slide.panels || []).join(' · ') || '未选择面板';
  return slide.kicker || 'Markdown';
}

function checkpoint() {
  const current = JSON.stringify(state.deck);
  if (state.history.at(-1) !== current) state.history.push(current);
  if (state.history.length > 60) state.history.shift();
  state.future = [];
  updateHistoryButtons();
}

function restoreSnapshot(serialized) {
  state.deck = safeDeck(JSON.parse(serialized));
  state.pageIndex = Math.min(state.pageIndex, state.deck.slides.length - 1);
  if (!panelEntries(state.deck).some(panel => panel.id === state.panelId)) state.panelId = panelEntries(state.deck)[0]?.id || null;
}

function updateHistoryButtons() {
  $('undo').disabled = !state.history.length;
  $('redo').disabled = !state.future.length;
}

function undo() {
  if (!state.history.length) return;
  state.future.push(JSON.stringify(state.deck));
  restoreSnapshot(state.history.pop());
  changed({renderAll:true, save:true});
}

function redo() {
  if (!state.future.length) return;
  state.history.push(JSON.stringify(state.deck));
  restoreSnapshot(state.future.pop());
  changed({renderAll:true, save:true});
}

function setAtPointer(root, jsonPointer, value, {emptyDelete = false} = {}) {
  const parts = jsonPointer.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (!parts.length) throw new Error('不能替换文稿根节点');
  let target = root;
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, part)) throw new Error(`JSON 路径不存在：${jsonPointer}`);
    target = target[part];
  }
  const key = parts.at(-1);
  if (!target || typeof target !== 'object') throw new Error(`JSON 路径不存在：${jsonPointer}`);
  if (emptyDelete && value === '') delete target[key];
  else target[key] = value;
}

function valueForControl(control) {
  if (control.type === 'checkbox') return control.checked;
  if (control.dataset.valueType === 'number') {
    if (control.value.trim() === '') return '';
    return Number(control.value);
  }
  return control.value;
}

function commandReference(config, index) {
  return config?.commands?.[index]?.id || index;
}

function updateCommandIdReferences(panelId, oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const terminal = state.deck.terminals?.[panelId];
  const dashboard = state.deck.dashboards?.[panelId];
  const previous = terminal ? oldId : dashboard ? oldId : null;
  if (!previous) return;
  for (const step of state.deck.sequence || []) {
    if (step.panel === panelId && step.command === previous) step.command = newId;
  }
}

function scheduleDraftSave() {
  clearTimeout(state.saveTimer);
  $('save-status').textContent = '有未保存修改';
  state.saveTimer = setTimeout(() => saveDraft(true), 550);
}

function scheduleDiagnostics() {
  clearTimeout(state.diagnosticTimer);
  state.diagnosticTimer = setTimeout(() => {
    refreshDiagnostics();
    renderStats();
    renderHealth();
    if (state.inspector === 'checks') renderInspector();
  }, 90);
}

function changed({renderAll: fullRender = false, save = true, refreshPreview = true} = {}) {
  if (save) scheduleDraftSave();
  if (fullRender) {
    refreshDiagnostics();
    renderAll();
    return;
  }
  renderPageList();
  renderPreview({sync:refreshPreview});
  if (!refreshPreview) renderInspector();
  renderDocumentMeta();
  renderStats();
  scheduleDiagnostics();
}

function mutate(callback, {renderAll = true} = {}) {
  checkpoint();
  try {
    callback();
    changed({renderAll, save:true});
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

function saveDraft(silent = false) {
  try {
    localStorage.setItem(`${state.storageKey}:studio-draft`, JSON.stringify({
      version:DRAFT_VERSION,
      savedAtMs:Date.now(),
      deck:state.deck,
    }));
    $('save-status').textContent = `草稿已保存 · ${new Date().toLocaleTimeString()}`;
    if (!silent) toast('Studio 草稿已保存；播放器不会自动更新');
    return true;
  } catch (error) {
    $('save-status').textContent = '草稿保存失败';
    toast(`草稿保存失败：${error.message}`, true);
    return false;
  }
}

function additionalPreflight() {
  const warnings = [], infos = [];
  for (const [id, terminal] of Object.entries(state.deck.terminals || {})) {
    const base = pointer('terminals', id);
    if (terminal.cwd && !terminal.cwd.startsWith('/')) warnings.push({
      code:'CWD_NOT_ABSOLUTE', severity:'warning', path:`${base}/cwd`, message:`终端 ${id} 的 cwd 不是绝对路径`,
    });
    let missingIds = 0;
    for (const [index, command] of (terminal.commands || []).entries()) {
      try { singleLineCommand(command.command); }
      catch (error) { warnings.push({code:'COMMAND_NOT_SINGLE_LINE', severity:'warning', path:`${base}/commands/${index}/command`, message:`终端 ${id} 命令 ${index + 1}：${error.message}`}); }
      if (!command.id) missingIds++;
    }
    if (missingIds) infos.push({code:'COMMAND_ID_MISSING', severity:'info', path:`${base}/commands`, message:`终端 ${id} 有 ${missingIds} 条命令没有稳定 id；计划只能按数组下标引用`});
  }
  for (const [id, dashboard] of Object.entries(state.deck.dashboards || {})) {
    if (dashboard.url?.startsWith('http:')) warnings.push({code:'INSECURE_URL', severity:'warning', path:`${dashboardsPath(id)}/url`, message:`网页面板 ${id} 使用 HTTP，建议改为 HTTPS`});
    for (const [index, command] of (dashboard.commands || []).entries()) {
      if (command.command?.startsWith('http:')) warnings.push({code:'INSECURE_URL', severity:'warning', path:`${dashboardsPath(id)}/commands/${index}/command`, message:`图表动作 ${index + 1} 使用 HTTP，建议改为 HTTPS`});
    }
  }
  if (!(state.deck.sequence || []).length) infos.push({code:'SEQUENCE_EMPTY', severity:'info', path:'/sequence', message:'当前是自由演示；加入 sequence 后会显示下一步提示'});
  return {warnings, infos};
}

function dashboardsPath(id) {
  return `/dashboards/${linkEscape(id)}`;
}

function linkEscape(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter(issue => {
    const key = `${issue.code}|${issue.path}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function refreshDiagnostics() {
  const report = validateDeckReport(state.deck);
  let product = null;
  if (report.valid && state.catalog) {
    try { product = validateProduct(state.deck, {catalog:state.catalog, replay:true}); }
    catch (error) { product = {valid:false, issues:[{code:'PRODUCT_VALIDATION_FAILED', message:error.message, path:null}], levels:null}; }
  }
  const extra = additionalPreflight();
  const errors = dedupeIssues([
    ...report.issues,
    ...(product?.issues || []).map(issue => ({...issue, severity:issue.severity || 'error'})),
  ]);
  const warnings = dedupeIssues([...(report.warnings || []), ...extra.warnings]);
  const infos = dedupeIssues(extra.infos);
  state.diagnostics = {
    report,
    product,
    errors,
    warnings,
    infos,
    valid:errors.length === 0 && product?.valid !== false,
  };
  return state.diagnostics;
}

function renderAll() {
  renderDocumentMeta();
  renderPageList();
  renderPreview();
  renderInspector();
  renderStats();
  renderHealth();
  updateHistoryButtons();
  $('raw-player-link').href = playerUrl();
}

function renderDocumentMeta() {
  $('document-title').textContent = state.deck.title || '未命名文稿';
  $('document-revision').textContent = `${state.deck.id || 'no-id'} · ${effectiveRevision(state.deck)}`;
  document.title = `${state.deck.title || 'Live Deck'} · Studio`;
}

function renderPageList() {
  $('page-count').textContent = String(state.deck.slides.length);
  $('page-list').innerHTML = state.deck.slides.map((slide, index) => `
    <li class="page-item ${index === state.pageIndex ? 'active' : ''}">
      <button class="page-select" data-action="select-page" data-index="${index}">
        <span class="page-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="page-copy">
          <strong>${escapeHtml(slide.title || '未命名页面')}</strong>
          <small>${escapeHtml(TYPE_LABELS[slide.type] || slide.type)} · ${escapeHtml(pageSubtitle(slide))}</small>
        </span>
      </button>
      <span class="page-order">
        <button data-action="move-page" data-index="${index}" data-delta="-1" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button data-action="move-page" data-index="${index}" data-delta="1" title="下移" ${index === state.deck.slides.length - 1 ? 'disabled' : ''}>↓</button>
      </span>
    </li>`).join('');
}

function renderPreview({sync = true} = {}) {
  const slide = selectedSlide();
  if (!slide) {
    $('preview-title').textContent = '没有页面';
    return;
  }
  $('preview-title').textContent = `${String(state.pageIndex + 1).padStart(2, '0')} · ${slide.title || '未命名页面'}`;
  layoutPreviewStage();
  if (sync) syncPreview();
}

function inlinePointer(pageIndex, field) {
  return pointer('slides', pageIndex, field);
}

function closeInlineEditor({cancel = false} = {}) {
  const current = state.inlineEdit;
  const editor = $('inline-editor');
  if (!current) { editor.hidden = true; return; }
  if (cancel) {
    setAtPointer(state.deck, inlinePointer(current.pageIndex, current.field), current.original, {emptyDelete:current.original === ''});
    changed({renderAll:false, save:true});
  } else {
    changed({renderAll:false, save:true});
  }
  state.inlineEdit = null;
  editor.hidden = true;
}

function openInlineEditor({pageIndex, field, label}) {
  const slide = state.deck.slides[pageIndex];
  const frame = previewFrame();
  if (!slide || !frame?.contentDocument || !['kicker', 'title', 'markdown'].includes(field)) return;
  if (state.inlineEdit) closeInlineEditor();
  const target = frame.contentDocument.querySelector(`section[data-page-index="${pageIndex}"] [data-studio-field="${field}"]`);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const editor = $('inline-editor'), input = $('inline-editor-input');
  const minHeight = field === 'markdown' ? 230 : 128;
  const width = Math.min(900, Math.max(320, rect.width + 24));
  const height = Math.min(560, Math.max(minHeight, rect.height + 92));
  editor.style.left = `${Math.max(8, Math.min(rect.left - 12, 1200 - width - 8))}px`;
  editor.style.top = `${Math.max(8, Math.min(rect.top - 12, 690 - height - 8))}px`;
  editor.style.width = `${width}px`;
  editor.style.height = `${height}px`;
  $('inline-editor-label').textContent = label || {title:'页面标题', kicker:'页眉 kicker', markdown:'Markdown 正文'}[field];
  input.value = slide[field] || '';
  input.classList.toggle('markdown', field === 'markdown');
  state.inlineEdit = {pageIndex, field, original:slide[field] || ''};
  checkpoint();
  editor.hidden = false;
  requestAnimationFrame(() => input.focus({preventScroll:true}));
}

function editInlineValue() {
  const current = state.inlineEdit;
  if (!current) return;
  const value = $('inline-editor-input').value;
  setAtPointer(state.deck, inlinePointer(current.pageIndex, current.field), value, {emptyDelete:current.field !== 'title'});
  changed({renderAll:false, save:true, refreshPreview:false});
  postPreview(PREVIEW_EVENTS.updateField, {pageIndex:current.pageIndex, field:current.field, value});
  if (state.previewDeck?.slides?.[current.pageIndex]) state.previewDeck.slides[current.pageIndex][current.field] = value;
  state.previewSignature = JSON.stringify(state.deck);
}

function handlePreviewMessage(event) {
  const frame = previewFrame();
  if (!frame || event.source !== frame.contentWindow) return;
  if (event.origin !== location.origin) return;
  const data = event.data || {};
  if (data.type === PREVIEW_EVENTS.boot) {
    state.previewSignature = JSON.stringify(state.deck);
    state.previewStructureSignature = previewStructureSignature(state.deck);
    state.previewDeck = jsonClone(state.deck);
    postPreview(PREVIEW_EVENTS.setDeck, {deck:jsonClone(state.deck), pageIndex:state.pageIndex}, {force:true});
  } else if (data.type === PREVIEW_EVENTS.ready) {
    state.previewReady = true;
    if (JSON.stringify(state.deck) !== state.previewSignature) syncPreview();
    else $('preview-loading').hidden = true;
  } else if (data.type === PREVIEW_EVENTS.selectField) {
    openInlineEditor(data);
  } else if (data.type === PREVIEW_EVENTS.selectPanel) {
    state.panelId = data.panelId;
    state.inspector = 'panels';
    renderInspector();
  } else if (data.type === PREVIEW_EVENTS.error) {
    toast(`预览更新失败：${data.message}`, true);
  }
}

function renderStats() {
  const panels = panelEntries(state.deck);
  const commands = panels.reduce((total, panel) => total + (panel.config.commands?.length || 0), 0);
  $('panel-count').textContent = String(panels.length);
  $('step-count').textContent = `${state.deck.sequence?.length || 0} / ${commands}`;
  $('issue-count').textContent = String(state.diagnostics?.errors.length || 0);
}

function renderHealth() {
  const diagnostics = state.diagnostics || refreshDiagnostics();
  const element = $('health-summary');
  element.className = 'health-summary';
  if (!diagnostics.valid) {
    element.classList.add('error');
    element.textContent = `${diagnostics.errors.length} 个错误 · ${diagnostics.warnings.length} 个警告`;
  } else if (diagnostics.warnings.length) {
    element.classList.add('warn');
    element.textContent = `可播放 · ${diagnostics.warnings.length} 个警告`;
  } else {
    element.classList.add('ok');
    element.textContent = '结构检查通过';
  }
}

function textField(label, fieldPointer, value, {full = false, type = 'text', placeholder = '', emptyDelete = false, hint = ''} = {}) {
  return `
    <label class="field ${full ? 'full' : ''}">
      <span>${escapeHtml(label)}</span>
      <input type="${type}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}"
        data-pointer="${escapeHtml(fieldPointer)}" ${emptyDelete ? 'data-empty-delete="true"' : ''}
        ${type === 'number' ? 'data-value-type="number"' : ''}>
      ${hint ? `<small class="field-help">${escapeHtml(hint)}</small>` : ''}
    </label>`;
}

function textArea(label, fieldPointer, value, {full = true, className = '', placeholder = '', emptyDelete = false} = {}) {
  return `
    <label class="field ${full ? 'full' : ''}">
      <span>${escapeHtml(label)}</span>
      <textarea class="${escapeHtml(className)}" placeholder="${escapeHtml(placeholder)}"
        data-pointer="${escapeHtml(fieldPointer)}" ${emptyDelete ? 'data-empty-delete="true"' : ''}>${escapeHtml(value ?? '')}</textarea>
    </label>`;
}

function selectField(label, fieldPointer, value, options, {full = false, emptyDelete = false} = {}) {
  return `
    <label class="field ${full ? 'full' : ''}">
      <span>${escapeHtml(label)}</span>
      <select data-pointer="${escapeHtml(fieldPointer)}" ${emptyDelete ? 'data-empty-delete="true"' : ''}>
        ${options.map(option => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(value ?? '') ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
    </label>`;
}

function checkboxField(label, fieldPointer, checked) {
  return `
    <label class="checkbox-chip">
      <input type="checkbox" data-pointer="${escapeHtml(fieldPointer)}" ${checked ? 'checked' : ''}>
      ${escapeHtml(label)}
    </label>`;
}

function renderPageInspector() {
  const slide = selectedSlide();
  if (!slide) return '<div class="empty-state">没有页面。</div>';
  const slidesPath = `/slides/${state.pageIndex}`;
  const terminalOptions = Object.entries(state.deck.terminals || {}).map(([id, config]) => ({value:id, label:config.label || id}));
  const panels = panelEntries(state.deck);
  const groups = Object.entries(state.deck.monitorGroups || {});
  return `
    <section class="inspector-section">
      <div class="section-heading"><h3>文稿</h3><small>DOCUMENT</small></div>
      <div class="field-grid">
        ${textField('标题', '/title', state.deck.title)}
        ${textField('文稿 ID', '/id', state.deck.id, {hint:'改变 ID 会切换终端身份和浏览器进度。'})}
        ${textField('revision', '/revision', state.deck.revision, {emptyDelete:true, hint:'独立入口用于区分浏览器编辑副本。'})}
        ${textField('monitoringRevision', '/monitoringRevision', state.deck.monitoringRevision, {emptyDelete:true})}
      </div>
    </section>
    <section class="inspector-section">
      <div class="section-heading"><h3>当前页面</h3><small>${String(state.pageIndex + 1).padStart(2, '0')}</small></div>
      <div class="field-grid">
        <label class="field">
          <span>类型</span>
          <select data-action="change-page-type">
            <option value="slide" ${slide.type === 'slide' ? 'selected' : ''}>讲解页</option>
            <option value="terminal" ${slide.type === 'terminal' ? 'selected' : ''}>终端页</option>
            <option value="workspace" ${slide.type === 'workspace' ? 'selected' : ''}>分屏页</option>
          </select>
        </label>
        ${textField('页面 ID', `${slidesPath}/id`, slide.id, {emptyDelete:true})}
        ${textField('页面标题', `${slidesPath}/title`, slide.title, {full:true})}
        ${textField('页眉 kicker', `${slidesPath}/kicker`, slide.kicker, {full:true, emptyDelete:true})}
      </div>
      ${slide.type === 'slide' ? `
        <div class="field-grid one" style="margin-top:10px">
          ${textArea('Markdown 正文', `${slidesPath}/markdown`, slide.markdown, {className:'markdown-editor', emptyDelete:true})}
        </div>` : ''}
      ${slide.type === 'terminal' ? `
        <div class="field-grid" style="margin-top:10px">
          ${selectField('终端面板', `${slidesPath}/terminal`, slide.terminal, terminalOptions)}
        </div>` : ''}
      ${slide.type === 'workspace' ? `
        <div class="inspector-section" style="margin-top:12px;padding-bottom:0">
          <div class="section-heading"><h3>固定面板</h3><small>${String((slide.panels || []).length)}</small></div>
          <div class="checkbox-list">
            ${panels.map(panel => `<label class="checkbox-chip">
              <input type="checkbox" data-action="toggle-slide-panel" data-panel-id="${escapeHtml(panel.id)}" ${(slide.panels || []).includes(panel.id) ? 'checked' : ''}>
              ${escapeHtml(panel.config.label || panel.id)}
            </label>`).join('')}
          </div>
          <div class="field-grid" style="margin-top:10px">
            ${selectField('布局', `${slidesPath}/layout`, slide.layout || 'columns', [
              {value:'columns', label:'并排'},
              {value:'rows', label:'上下'},
              {value:'focus', label:'主屏 + 侧屏'},
            ], {emptyDelete:true})}
          </div>
          ${groups.length ? `
            <div class="section-heading" style="margin-top:13px"><h3>监控组</h3><small>可选</small></div>
            <div class="checkbox-list">
              ${groups.map(([id, group]) => `<label class="checkbox-chip">
                <input type="checkbox" data-action="toggle-slide-group" data-group-id="${escapeHtml(id)}" ${(slide.monitorGroups || []).includes(id) ? 'checked' : ''}>
                ${escapeHtml(group.label || id)}
              </label>`).join('')}
            </div>` : ''}
        </div>` : ''}
      <div class="field-grid one" style="margin-top:10px">
        ${textArea('演讲者备注', `${slidesPath}/speakerNotes`, slide.speakerNotes, {emptyDelete:true, placeholder:'只给演示者看的提示、时间控制或下一页提醒。'})}
      </div>
      <div class="inline-actions" style="margin-top:10px">
        <button data-action="delete-page" class="danger-button" ${state.deck.slides.length <= 1 ? 'disabled' : ''}>删除本页</button>
      </div>
    </section>`;
}

function tabsFor(config) {
  return [
    {id:'main', label:'Tab 1', config:{}, fixed:true},
    ...Object.entries(config.tabs || {}).map(([id, tab]) => ({id, label:tab.label || id, config:tab, fixed:false})),
  ];
}

function commandEditor(panel, command, index) {
  const base = pointer(panel.kind === 'terminal' ? 'terminals' : 'dashboards', panel.id, 'commands', index);
  const tabs = panel.kind === 'terminal' ? tabsFor(panel.config) : [];
  return `
    <div class="list-card">
      <div class="list-card-head">
        <strong>${String(index + 1).padStart(2, '0')} · ${escapeHtml(command.title || '未命名命令')}</strong>
        <button data-action="move-command" data-index="${index}" data-delta="-1" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button data-action="move-command" data-index="${index}" data-delta="1" ${index === panel.config.commands.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-action="delete-command" data-index="${index}" class="danger-button">×</button>
      </div>
      <div class="list-card-body">
        <div class="field-grid">
          ${textField('标题', `${base}/title`, command.title)}
          ${textField('稳定 ID', `${base}/id`, command.id, {emptyDelete:true})}
          ${textArea(panel.kind === 'terminal' ? '命令' : '动作 URL', `${base}/command`, command.command, {emptyDelete:true})}
          ${textArea('说明', `${base}/note`, command.note, {emptyDelete:true})}
          ${textArea('预期观察', `${base}/expect`, command.expect, {emptyDelete:true})}
          ${panel.kind === 'terminal' ? selectField('默认目标 tab', `${base}/tab`, command.tab || '', [
            {value:'', label:'跟随 main'},
            ...tabs.map(tab => ({value:tab.id, label:tab.label})),
          ], {emptyDelete:true}) : ''}
        </div>
      </div>
    </div>`;
}

function renderPanelInspector() {
  const panels = panelEntries(state.deck);
  const panel = selectedPanel();
  if (!panel) return `<div class="empty-state">还没有面板。</div>`;
  const terminal = panel.kind === 'terminal' ? panel.config : null;
  const dashboard = panel.kind === 'dashboard' ? panel.config : null;
  const base = pointer(panel.kind === 'terminal' ? 'terminals' : 'dashboards', panel.id);
  const tabs = terminal ? tabsFor(terminal) : [];
  const chart = dashboard?.chart;
  const binding = dashboard?.binding;
  return `
    <section class="inspector-section">
      <div class="section-heading"><h3>面板</h3><small>${panels.length} PANELS</small></div>
      <div class="field-grid">
        <label class="field full">
          <span>选择面板</span>
          <select data-action="select-panel">
            ${panels.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === panel.id ? 'selected' : ''}>${escapeHtml(item.config.label || item.id)} · ${item.kind === 'terminal' ? '终端' : '网页'}</option>`).join('')}
          </select>
        </label>
        ${textField('显示名称', `${base}/label`, panel.config.label)}
        <label class="field">
          <span>面板 ID</span>
          <input id="panel-id-input" value="${escapeHtml(panel.id)}">
        </label>
      </div>
      <div class="inline-actions" style="margin-top:9px">
        <button data-action="add-terminal">＋ 终端</button>
        <button data-action="add-dashboard">＋ 网页面板</button>
        <button data-action="rename-panel">重命名 ID</button>
        <button data-action="delete-panel" class="danger-button">删除面板</button>
      </div>
    </section>
    ${terminal ? `
      <section class="inspector-section">
        <div class="section-heading"><h3>终端设置</h3><small>TERMINAL</small></div>
        <div class="field-grid one">
          ${textField('初始工作目录', `${base}/cwd`, terminal.cwd, {emptyDelete:true, placeholder:'/absolute/path'})}
        </div>
        <div class="checkbox-list" style="margin-top:9px">
          ${checkboxField('使用独立演示进度', `${base}/independentSequence`, terminal.independentSequence)}
        </div>
      </section>
      <section class="inspector-section">
        <div class="section-heading"><h3>固定 tabs</h3><button data-action="add-tab" class="toolbar-button">＋ tab</button></div>
        ${tabs.map(tab => `
          <div class="list-card">
            <div class="list-card-head">
              <strong>${escapeHtml(tab.label)} · ${escapeHtml(tab.id)}</strong>
              ${tab.fixed ? '<span class="status-chip">MAIN</span>' : `<button data-action="delete-tab" data-tab-id="${escapeHtml(tab.id)}" class="danger-button">×</button>`}
            </div>
            ${tab.fixed ? '' : `<div class="list-card-body"><div class="field-grid">
              ${textField('名称', `${base}/tabs/${tab.id}/label`, tab.config.label)}
              ${textField('工作目录', `${base}/tabs/${tab.id}/cwd`, tab.config.cwd, {emptyDelete:true})}
            </div></div>`}
          </div>`).join('')}
      </section>` : `
      <section class="inspector-section">
        <div class="section-heading"><h3>网页面板</h3><small>WEB</small></div>
        <div class="field-grid one">
          ${textField('初始 URL', `${base}/url`, dashboard.url, {emptyDelete:true, placeholder:'https://…'})}
        </div>
      </section>
      <section class="inspector-section">
        <div class="section-heading">
          <h3>运行绑定</h3>
          ${binding ? '<button data-action="delete-binding" class="toolbar-button danger-button">移除</button>' : '<button data-action="add-binding" class="toolbar-button">＋ 绑定</button>'}
        </div>
        ${binding ? `<div class="field-grid">
          ${selectField('绑定终端', `${base}/binding/terminal`, binding.terminal, Object.entries(state.deck.terminals || {}).map(([id, config]) => ({value:id, label:config.label || id})))}
          ${selectField('绑定 tab', `${base}/binding/tab`, binding.tab || '', [
            {value:'', label:'main'},
            ...tabsFor(state.deck.terminals?.[binding.terminal] || {}).map(tab => ({value:tab.id, label:tab.label})),
          ], {emptyDelete:true})}
        </div>
        <p class="field-help">参数映射、时间与跟随设置可在 JSON 模式中编辑。</p>` : '<p class="field-help">绑定后，图表可以跟随运行实际上报的 host、pod 和时间。</p>'}
      </section>
      <section class="inspector-section">
        <div class="section-heading">
          <h3>时序图</h3>
          ${chart ? '<button data-action="delete-chart" class="toolbar-button danger-button">移除</button>' : '<button data-action="add-chart" class="toolbar-button">＋ 时序图</button>'}
        </div>
        ${chart ? `<div class="field-grid">
          ${selectField('指标', `${base}/chart/metric`, chart.metric, [
            {value:'fuse-read-rate', label:'FUSE read rate'},
            {value:'fuse-read-latency', label:'FUSE read latency'},
            {value:'blob-read-throughput', label:'Blob Client read throughput'},
            {value:'blob-read-latency', label:'Blob Client read latency'},
          ])}
          ${textField('datasource', `${base}/chart/datasource`, chart.datasource)}
          ${textField('database', `${base}/chart/database`, chart.database)}
          ${textField('采样间隔（秒）', `${base}/chart/stepSeconds`, chart.stepSeconds, {type:'number', emptyDelete:true})}
          ${textField('阶段字段', `${base}/chart/comparisonField`, chart.comparisonField, {emptyDelete:true})}
        </div>` : '<p class="field-help">时序图由 Live Deck 使用固定指标模板查询，不修改 Grafana 看板。</p>'}
      </section>`}
    <section class="inspector-section">
      <div class="section-heading">
        <h3>候选动作</h3>
        <button data-action="add-command" class="toolbar-button">＋ 动作</button>
      </div>
      ${(panel.config.commands || []).map((command, index) => commandEditor(panel, command, index)).join('') || '<div class="empty-state">这个面板还没有候选动作。</div>'}
    </section>`;
}

function renderSequenceInspector() {
  const panels = panelEntries(state.deck);
  const groups = Object.keys(state.deck.monitorGroups || {});
  return `
    <section class="inspector-section">
      <div class="section-heading"><h3>演示计划</h3><small>${String(state.deck.sequence?.length || 0)} STEPS</small></div>
      <div class="inline-actions">
        <button data-action="add-step" ${panels.length ? '' : 'disabled'}>＋ 面板步骤</button>
        <button data-action="add-group-step" ${groups.length ? '' : 'disabled'}>＋ 监控组</button>
      </div>
    </section>
    <section>
      ${(state.deck.sequence || []).map((step, index) => {
        const panel = panels.find(item => item.id === step.panel);
        const commands = panel?.config.commands || [];
        return `
          <div class="sequence-row">
            <span class="sequence-number">${String(index + 1).padStart(2, '0')}</span>
            <div class="list-card">
              <div class="list-card-head">
                <strong>${step.group ? `监控组 · ${escapeHtml(state.deck.monitorGroups?.[step.group]?.label || step.group)}` : `动作 · ${escapeHtml(panel?.config.label || step.panel || '—')}`}</strong>
                <button data-action="move-step" data-index="${index}" data-delta="-1" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button data-action="move-step" data-index="${index}" data-delta="1" ${index === (state.deck.sequence || []).length - 1 ? 'disabled' : ''}>↓</button>
                <button data-action="delete-step" data-index="${index}" class="danger-button">×</button>
              </div>
              <div class="list-card-body">
                <div class="sequence-controls">
                  ${step.group ? `
                    <select data-pointer="/sequence/${index}/group">
                      ${groups.map(group => `<option value="${escapeHtml(group)}" ${group === step.group ? 'selected' : ''}>${escapeHtml(state.deck.monitorGroups[group].label || group)}</option>`).join('')}
                    </select>
                    <span></span><span></span>` : `
                    <select data-action="change-step-panel" data-index="${index}">
                      ${panels.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === step.panel ? 'selected' : ''}>${escapeHtml(item.config.label || item.id)}</option>`).join('')}
                    </select>
                    <select data-pointer="/sequence/${index}/command" data-empty-delete="false">
                      ${commands.map((command, commandIndex) => `<option value="${escapeHtml(commandReference(panel.config, commandIndex))}" ${String(step.command) === String(commandReference(panel.config, commandIndex)) ? 'selected' : ''}>${escapeHtml(command.title || `动作 ${commandIndex + 1}`)}</option>`).join('')}
                    </select>
                    ${panel?.kind === 'terminal' ? `<select data-pointer="/sequence/${index}/tab" data-empty-delete="true">
                      <option value="">默认 main</option>
                      ${tabsFor(panel.config).map(tab => `<option value="${escapeHtml(tab.id)}" ${tab.id === step.tab ? 'selected' : ''}>${escapeHtml(tab.label)}</option>`).join('')}
                    </select>` : '<span></span>'}`}
                  <div class="inline-actions">
                    <button data-action="toggle-step-kind" data-index="${index}">${step.group ? '改为面板步骤' : '改为监控组'}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>`;
      }).join('') || '<div class="empty-state">还没有总演示顺序。仍可在播放器中自由操作。</div>'}
    </section>`;
}

function issueCard(issue) {
  return `<li class="diagnostic ${escapeHtml(issue.severity || 'error')}">
    <strong>${escapeHtml(issue.message)}</strong>
    <code>${escapeHtml(issue.path || '文档根节点')} · ${escapeHtml(issue.code || 'ISSUE')}</code>
  </li>`;
}

function renderChecksInspector() {
  const diagnostics = state.diagnostics || refreshDiagnostics();
  const levels = diagnostics.product?.levels;
  return `
    <section class="inspector-section">
      <div class="section-heading"><h3>放映前检查</h3><button data-action="run-checks" class="toolbar-button">重新检查</button></div>
      ${levels ? `<div class="check-levels">
        <div class="check-level ${levels.static?.ok ? 'ok' : 'error'}"><strong>结构</strong>${levels.static?.ok ? '通过' : '失败'}</div>
        <div class="check-level ${levels.capabilities?.ok ? 'ok' : 'error'}"><strong>能力</strong>${levels.capabilities?.ok ? '通过' : '失败'}</div>
        <div class="check-level ${levels.replay?.ok === true ? 'ok' : levels.replay?.ok === false ? 'error' : ''}"><strong>回放</strong>${levels.replay?.ok === true ? '通过' : levels.replay?.ok === false ? '失败' : '未运行'}</div>
      </div>` : ''}
      <p class="field-help">这里检查结构、跨引用、指标能力和运行事件回放，不会执行文稿中的 Shell 命令。</p>
    </section>
    <section class="inspector-section">
      <div class="section-heading"><h3>错误</h3><small>${diagnostics.errors.length}</small></div>
      <ul class="diagnostic-list">${diagnostics.errors.map(issueCard).join('') || '<li class="empty-state">没有阻塞错误。</li>'}</ul>
    </section>
    <section class="inspector-section">
      <div class="section-heading"><h3>警告</h3><small>${diagnostics.warnings.length}</small></div>
      <ul class="diagnostic-list">${diagnostics.warnings.map(issueCard).join('') || '<li class="empty-state">没有警告。</li>'}</ul>
    </section>
    <section>
      <div class="section-heading"><h3>提示</h3><small>${diagnostics.infos.length}</small></div>
      <ul class="diagnostic-list">${diagnostics.infos.map(issueCard).join('') || '<li class="empty-state">没有额外提示。</li>'}</ul>
    </section>`;
}

function renderInspector() {
  document.querySelectorAll('[data-inspector]').forEach(button => button.classList.toggle('active', button.dataset.inspector === state.inspector));
  if (state.inspector === 'panels') $('inspector-body').innerHTML = renderPanelInspector();
  else if (state.inspector === 'sequence') $('inspector-body').innerHTML = renderSequenceInspector();
  else if (state.inspector === 'json') $('inspector-body').innerHTML = `
    <section>
      <div class="section-heading"><h3>原始 JSON</h3><small>AUTHORITATIVE</small></div>
      <div class="json-toolbar">
        <button data-action="format-json" class="toolbar-button">格式化</button>
        <button data-action="apply-json" class="secondary">应用 JSON</button>
        <button data-action="refresh-json" class="toolbar-button">从当前模型刷新</button>
      </div>
      <textarea id="json-editor" spellcheck="false">${escapeHtml(JSON.stringify(state.deck, null, 2))}</textarea>
    </section>`;
  else if (state.inspector === 'checks') $('inspector-body').innerHTML = renderChecksInspector();
  else $('inspector-body').innerHTML = renderPageInspector();
}

function changePageType(type) {
  const slide = selectedSlide();
  if (!slide || slide.type === type) return;
  mutate(() => {
    const page = {id:slide.id, type, title:slide.title, kicker:slide.kicker, speakerNotes:slide.speakerNotes};
    if (type === 'slide') {
      page.markdown = slide.markdown || '';
    } else if (type === 'terminal') {
      page.terminal = slide.terminal || Object.keys(state.deck.terminals || {})[0];
      if (!page.terminal) throw new Error('当前文稿没有终端面板');
    } else {
      const available = panelEntries(state.deck).map(panel => panel.id);
      page.panels = (slide.panels || []).filter(id => available.includes(id));
      if (!page.panels.length) page.panels = available.slice(0, Math.min(3, available.length));
      if (!page.panels.length) throw new Error('当前文稿没有可用于分屏的面板');
      page.layout = slide.layout || 'columns';
      if (slide.monitorGroups?.length) page.monitorGroups = [...slide.monitorGroups];
    }
    state.deck.slides[state.pageIndex] = page;
  });
}

function applyJsonEditor() {
  const text = $('json-editor')?.value;
  if (text === undefined) return;
  checkpoint();
  try {
    const parsed = JSON.parse(text);
    state.deck = safeDeck(parsed);
    state.pageIndex = Math.min(state.pageIndex, state.deck.slides.length - 1);
    if (!panelEntries(state.deck).some(panel => panel.id === state.panelId)) state.panelId = panelEntries(state.deck)[0]?.id || null;
    changed({renderAll:true, save:true});
    toast('JSON 已应用到 Studio 草稿');
  } catch (error) {
    toast(`JSON 无效：${error.message}`, true);
  }
}

function applyToPlayer(open = true) {
  const diagnostics = refreshDiagnostics();
  renderStats();
  renderHealth();
  if (!diagnostics.valid) {
    state.inspector = 'checks';
    renderInspector();
    toast(`还有 ${diagnostics.errors.length} 个阻塞错误，不能应用到播放器`, true);
    return {status:'rejected', issues:diagnostics.errors};
  }
  try {
    validateDeck(state.deck);
    localStorage.setItem(state.storageKey, JSON.stringify(state.deck));
    localStorage.setItem(state.temporaryTabsKey, JSON.stringify({version:2, temporary:{}, fixed:fixedTabDefinitions(state.deck)}));
    saveDraft(true);
    toast('已应用到当前浏览器播放器');
    if (open) location.href = playerUrl();
    return {status:'applied', revision:effectiveRevision(state.deck)};
  } catch (error) {
    toast(`应用失败：${error.message}`, true);
    return {status:'rejected', issues:error.issues || [{message:error.message, path:null}]};
  }
}

function exportDeck() {
  const blob = new Blob([JSON.stringify(state.deck, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${state.deck.id || 'live-deck'}.livedeck.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('文稿已导出');
}

function reloadPublishedDeck() {
  if (!confirm('丢弃当前 Studio 草稿并重新载入发布文稿？')) return;
  checkpoint();
  state.deck = safeDeck(state.sourceDeck);
  state.pageIndex = 0;
  state.panelId = panelEntries(state.deck)[0]?.id || null;
  changed({renderAll:true, save:true});
  toast('已重新载入发布文稿到 Studio 草稿');
}

async function importDeck(file) {
  checkpoint();
  try {
    const parsed = JSON.parse(await file.text());
    state.deck = safeDeck(parsed);
    state.pageIndex = 0;
    state.panelId = panelEntries(state.deck)[0]?.id || null;
    changed({renderAll:true, save:true});
    toast('文稿已导入 Studio 草稿；尚未应用到播放器');
  } catch (error) {
    toast(`导入失败：${error.message}`, true);
  } finally {
    $('import-deck').value = '';
  }
}

function handleAction(action, element) {
  const slide = selectedSlide();
  const panel = selectedPanel();
  const index = Number(element.dataset.index);
  if (action === 'select-page') {
    if (state.inlineEdit) closeInlineEditor();
    state.pageIndex = index;
    state.inspector = 'page';
    renderAll();
  } else if (action === 'move-page') {
    const target = index + Number(element.dataset.delta);
    mutate(() => {
      if (!moveItem(state.deck.slides, index, Number(element.dataset.delta))) return;
      if (state.pageIndex === index) state.pageIndex = target;
      else if (state.pageIndex === target) state.pageIndex = index;
    });
  } else if (action === 'delete-page') {
    if (state.deck.slides.length <= 1) return;
    mutate(() => {
      state.deck.slides.splice(state.pageIndex, 1);
      state.pageIndex = Math.min(state.pageIndex, state.deck.slides.length - 1);
    });
  } else if (action === 'toggle-slide-panel') {
    mutate(() => {
      const ids = new Set(slide.panels || []);
      const id = element.dataset.panelId;
      if (element.checked) ids.add(id); else ids.delete(id);
      slide.panels = panelEntries(state.deck).map(panel => panel.id).filter(panelId => ids.has(panelId));
    }, {renderAll:false});
  } else if (action === 'toggle-slide-group') {
    mutate(() => {
      const ids = new Set(slide.monitorGroups || []);
      const id = element.dataset.groupId;
      if (element.checked) ids.add(id); else ids.delete(id);
      slide.monitorGroups = Object.keys(state.deck.monitorGroups || {}).filter(groupId => ids.has(groupId));
      if (!slide.monitorGroups.length) delete slide.monitorGroups;
      if (slide.monitorGroup && !ids.has(slide.monitorGroup)) delete slide.monitorGroup;
    }, {renderAll:false});
  } else if (action === 'select-panel') {
    state.panelId = element.value;
    renderInspector();
  } else if (action === 'add-terminal') {
    mutate(() => { state.panelId = addTerminal(state.deck); });
  } else if (action === 'add-dashboard') {
    mutate(() => { state.panelId = addDashboard(state.deck); });
  } else if (action === 'rename-panel') {
    const newId = $('panel-id-input').value.trim();
    mutate(() => {
      renamePanel(state.deck, panel.id, newId);
      state.panelId = newId;
    });
  } else if (action === 'delete-panel') {
    if (!confirm(`删除面板 ${panel.id}？仍有引用时会拒绝。`)) return;
    mutate(() => {
      removePanel(state.deck, panel.id);
      state.panelId = panelEntries(state.deck)[0]?.id || null;
    });
  } else if (action === 'add-command') {
    mutate(() => { addCommand(state.deck, panel.id); });
  } else if (action === 'delete-command') {
    mutate(() => { panel.config.commands.splice(index, 1); });
  } else if (action === 'move-command') {
    mutate(() => { moveItem(panel.config.commands, index, Number(element.dataset.delta)); });
  } else if (action === 'add-tab') {
    mutate(() => {
      panel.config.tabs ||= {};
      const id = uniqueId('tab', Object.keys(panel.config.tabs), 2);
      panel.config.tabs[id] = {label:`Tab ${Object.keys(panel.config.tabs).length + 2}`};
    });
  } else if (action === 'delete-tab') {
    mutate(() => removeTab(state.deck, panel.id, element.dataset.tabId));
  } else if (action === 'add-binding') {
    mutate(() => {
      const terminal = Object.keys(state.deck.terminals || {})[0];
      if (!terminal) throw new Error('绑定运行前需要终端面板');
      panel.config.binding = {terminal, params:{}};
    });
  } else if (action === 'delete-binding') {
    mutate(() => { delete panel.config.binding; });
  } else if (action === 'add-chart') {
    mutate(() => {
      if (!panel.config.binding) throw new Error('时序图需要先绑定运行终端');
      const sample = Object.values(state.deck.dashboards || {}).find(item => item.chart)?.chart;
      panel.config.chart = sample ? jsonClone(sample) : {
        type:'timeseries',
        metric:'fuse-read-rate',
        datasource:'replace-me',
        database:'hf3fs_hg',
        stepSeconds:2,
      };
    });
  } else if (action === 'delete-chart') {
    mutate(() => { delete panel.config.chart; });
  } else if (action === 'add-step') {
    mutate(() => {
      const firstPanel = panelEntries(state.deck).find(item => item.config.commands?.length);
      if (!firstPanel) throw new Error('面板还没有可加入计划的命令');
      state.deck.sequence ||= [];
      state.deck.sequence.push({panel:firstPanel.id, command:commandReference(firstPanel.config, 0)});
    });
  } else if (action === 'add-group-step') {
    mutate(() => {
      const group = Object.keys(state.deck.monitorGroups || {})[0];
      if (!group) throw new Error('文稿没有监控组');
      state.deck.sequence ||= [];
      state.deck.sequence.push({group});
    });
  } else if (action === 'delete-step') {
    mutate(() => { state.deck.sequence.splice(index, 1); });
  } else if (action === 'move-step') {
    mutate(() => { moveItem(state.deck.sequence, index, Number(element.dataset.delta)); });
  } else if (action === 'toggle-step-kind') {
    mutate(() => {
      const step = state.deck.sequence[index];
      if (step.group) {
        const firstPanel = panelEntries(state.deck).find(item => item.config.commands?.length);
        if (!firstPanel) throw new Error('需要至少一个带命令的面板');
        state.deck.sequence[index] = {panel:firstPanel.id, command:commandReference(firstPanel.config, 0)};
      } else {
        const group = Object.keys(state.deck.monitorGroups || {})[0];
        if (!group) throw new Error('文稿没有监控组');
        state.deck.sequence[index] = {group};
      }
    });
  } else if (action === 'format-json') {
    try { $('json-editor').value = JSON.stringify(JSON.parse($('json-editor').value), null, 2); toast('JSON 已格式化'); }
    catch (error) { toast(`JSON 无效：${error.message}`, true); }
  } else if (action === 'apply-json') {
    applyJsonEditor();
  } else if (action === 'refresh-json') {
    renderInspector();
    toast('已从当前模型重新生成 JSON');
  } else if (action === 'run-checks') {
    refreshDiagnostics();
    renderAll();
    toast(state.diagnostics.valid ? '检查通过' : `检查发现 ${state.diagnostics.errors.length} 个阻塞错误`, !state.diagnostics.valid);
  }
}

function handlePointerEdit(event) {
  const control = event.target.closest('[data-pointer]');
  if (!control) return;
  const jsonPointer = control.dataset.pointer;
  const value = valueForControl(control);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    toast('请输入有效数字', true);
    return;
  }
  try {
    const idMatch = jsonPointer.match(/^\/(terminals|dashboards)\/([^/]+)\/commands\/(\d+)\/id$/);
    const oldId = idMatch ? control.defaultValue : null;
    setAtPointer(state.deck, jsonPointer, value, {emptyDelete:control.dataset.emptyDelete === 'true'});
    if (idMatch) updateCommandIdReferences(decodeURIComponent(idMatch[2].replaceAll('~1', '/').replaceAll('~0', '~')), oldId, value);
    changed({renderAll:false, save:true});
  } catch (error) {
    toast(error.message, true);
  }
}

function handleChange(event) {
  const control = event.target;
  if (control.matches('[data-action="select-panel"]')) {
    state.panelId = control.value;
    renderInspector();
    return;
  }
  if (control.matches('[data-action="change-page-type"]')) {
    changePageType(control.value);
    return;
  }
  if (control.matches('[data-action="change-step-panel"]')) {
    const index = Number(control.dataset.index);
    mutate(() => {
      const panel = panelEntries(state.deck).find(item => item.id === control.value);
      if (!panel) return;
      const command = panel.config.commands?.[0];
      state.deck.sequence[index] = {panel:panel.id, command:commandReference(panel.config, 0)};
      if (!command) throw new Error('目标面板还没有命令');
    });
    return;
  }
  handlePointerEdit(event);
}

function bindEvents() {
  window.addEventListener('message', handlePreviewMessage);
  window.addEventListener('resize', layoutPreviewStage);
  document.addEventListener('click', event => {
    const inspectorTab = event.target.closest('[data-inspector]');
    if (inspectorTab) {
      state.inspector = inspectorTab.dataset.inspector;
      renderInspector();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.matches('input, select, textarea')) return;
    handleAction(action.dataset.action, action);
  });
  document.addEventListener('focusin', event => {
    if (event.target.matches('[data-pointer], #panel-id-input')) checkpoint();
  });
  document.addEventListener('input', event => {
    if (event.target.matches('#panel-id-input, #new-page-type')) return;
    if (event.target.matches('[data-pointer]') && event.target.type !== 'checkbox') handlePointerEdit(event);
  });
  document.addEventListener('change', handleChange);

  $('add-page').onclick = () => mutate(() => {
    state.deck.slides.push(createPage(state.deck, $('new-page-type').value));
    state.pageIndex = state.deck.slides.length - 1;
  });
  $('undo').onclick = undo;
  $('redo').onclick = redo;
  $('save-draft').onclick = () => saveDraft(false);
  $('apply-deck').onclick = () => applyToPlayer(true);
  $('reload-source').onclick = reloadPublishedDeck;
  $('export-deck').onclick = exportDeck;
  $('import-deck').onchange = event => event.target.files?.[0] && importDeck(event.target.files[0]);
  $('inline-editor-input').addEventListener('input', editInlineValue);
  $('inline-editor').onsubmit = event => { event.preventDefault(); closeInlineEditor(); };
  $('inline-editor-cancel').onclick = () => closeInlineEditor({cancel:true});
  $('inline-editor-input').addEventListener('keydown', event => {
    const current = state.inlineEdit;
    if (event.key === 'Escape') { event.preventDefault(); closeInlineEditor({cancel:true}); }
    else if ((current?.field !== 'markdown' && event.key === 'Enter' && !event.shiftKey) || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      closeInlineEditor();
    }
  });
}

async function boot() {
  try {
    const deployment = await (await fetch('./deployment.json', {cache:'no-store'})).json();
    try { state.catalog = await (await fetch(new URL('./metric-catalog.json', import.meta.url), {cache:'no-store'})).json(); }
    catch { state.catalog = null; }
    const requested = new URLSearchParams(location.search).get('deck');
    const example = ['multi-panel', 'monitoring'].includes(requested) ? requested : null;
    const source = await (await fetch(example ? `./${example}.json` : './deck.json', {cache:'no-store'})).json();
    state.sourceDeck = structuredClone(source);
    state.storageKey = deployment.storageScope === 'deck'
      ? `live-deck:custom:${source.id}${source.revision ? `:${source.revision}` : ''}`
      : example ? `live-deck:${example}` : 'live-deck:current';
    state.temporaryTabsKey = `${state.storageKey}:temporary-tabs`;
    $('storage-scope').textContent = `${state.storageKey} · ${deployment.storageScope === 'deck' ? '演示入口' : '共享入口'}`;

    let draft = null, live = null;
    try { draft = JSON.parse(localStorage.getItem(`${state.storageKey}:studio-draft`) || 'null'); } catch {}
    try { live = JSON.parse(localStorage.getItem(state.storageKey) || 'null'); } catch {}
    const candidate = draft?.version === DRAFT_VERSION && draft.deck
      ? refreshSourceMonitoring(source, draft.deck)
      : refreshSourceMonitoring(source, live) || source;
    state.deck = safeDeck(candidate);
    state.pageIndex = 0;
    state.panelId = panelEntries(state.deck)[0]?.id || null;
    const previewUrl = new URL('./index.html', location.href);
    previewUrl.searchParams.set('studioPreview', '1');
    if (example) previewUrl.searchParams.set('deck', example);
    refreshDiagnostics();
    bindEvents();
    renderAll();
    $('player-preview').src = previewUrl.href;
    $('save-status').textContent = draft?.savedAtMs
      ? `已载入草稿 · ${new Date(draft.savedAtMs).toLocaleString()}`
      : live ? '已载入播放器中的浏览器副本' : '已载入发布文稿';

    window.liveDeckStudio = {
      get deck() { return state.deck; },
      get diagnostics() { return state.diagnostics || refreshDiagnostics(); },
      get sourceDeck() { return state.sourceDeck; },
      get storageKey() { return state.storageKey; },
      saveDraft,
      applyToPlayer,
      validate() { return refreshDiagnostics(); },
      undo,
      redo,
    };
  } catch (error) {
    console.error(error);
    document.body.innerHTML = `<main style="padding:40px;font-family:system-ui;color:#ffb4b4"><h1>Studio 加载失败</h1><pre>${escapeHtml(error.stack || error.message)}</pre></main>`;
  }
}

boot();
