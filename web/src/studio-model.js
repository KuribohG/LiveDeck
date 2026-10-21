const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

export function uniqueId(prefix, used, start = 1) {
  const taken = new Set(used);
  let number = start;
  while (taken.has(`${prefix}-${number}`)) number++;
  return `${prefix}-${number}`;
}

export function panelEntries(deck) {
  return [
    ...Object.entries(deck?.terminals || {}).map(([id, config]) => ({id, kind:'terminal', config})),
    ...Object.entries(deck?.dashboards || {}).map(([id, config]) => ({id, kind:'dashboard', config})),
  ];
}

export function prepareDeckForEditing(input) {
  const deck = structuredClone(input);
  deck.format ||= 'live-deck';
  deck.version ??= 1;
  deck.terminals ||= {};
  deck.dashboards ||= {};
  deck.sequence ||= [];
  deck.slides ||= [];

  if (!deck.slides.length) {
    deck.slides.push(createPage(deck, 'slide'));
  }

  const used = new Set(deck.slides.map(slide => slide?.id).filter(value => typeof value === 'string' && value));
  for (const slide of deck.slides) {
    if (!slide.id) {
      slide.id = uniqueId('page', used);
      used.add(slide.id);
    }
    // Studio keeps a panel list on terminal pages for atomic panel operations;
    // playback still treats terminal type as the authoritative field.
    if (slide.type === 'terminal' && slide.terminal && !Array.isArray(slide.panels)) slide.panels = [slide.terminal];
  }
  return deck;
}

export function addTerminal(deck, requestedId) {
  const used = [...Object.keys(deck.terminals || {}), ...Object.keys(deck.dashboards || {})];
  const id = requestedId || uniqueId('terminal', used);
  if (!ID_PATTERN.test(id) || RESERVED.has(id) || used.includes(id)) throw new Error(`终端 ID 无效或重复：${id}`);
  deck.terminals ||= {};
  deck.terminals[id] = {label:`终端 ${Object.keys(deck.terminals).length + 1}`, commands:[]};
  return id;
}

export function addDashboard(deck, requestedId) {
  const used = [...Object.keys(deck.terminals || {}), ...Object.keys(deck.dashboards || {})];
  const id = requestedId || uniqueId('dashboard', used);
  if (!ID_PATTERN.test(id) || RESERVED.has(id) || used.includes(id)) throw new Error(`面板 ID 无效或重复：${id}`);
  deck.dashboards ||= {};
  deck.dashboards[id] = {label:`网页面板 ${Object.keys(deck.dashboards).length + 1}`, commands:[]};
  return id;
}

export function createPage(deck, type) {
  const used = (deck.slides || []).map(slide => slide.id).filter(Boolean);
  const id = uniqueId('page', used);
  const panels = panelEntries(deck).map(panel => panel.id);
  if (type === 'terminal') {
    const terminal = Object.keys(deck.terminals || {})[0];
    if (!terminal) throw new Error('创建终端页前需要至少一个终端面板');
    return {id, type, title:'终端演示', terminal};
  }
  if (type === 'workspace') {
    if (!panels.length) throw new Error('创建分屏页前需要至少一个面板');
    return {id, type, title:'多面板演示', panels:panels.slice(0, Math.min(3, panels.length)), layout:'columns'};
  }
  return {id, type:'slide', title:'新页面', kicker:'', markdown:'', speakerNotes:''};
}

export function addCommand(deck, panelId) {
  const terminal = deck.terminals?.[panelId];
  const dashboard = deck.dashboards?.[panelId];
  const config = terminal || dashboard;
  if (!config) throw new Error(`找不到面板：${panelId}`);
  config.commands ||= [];
  const used = config.commands.map(command => command.id).filter(Boolean);
  const id = uniqueId(dashboard ? 'view' : 'step', used);
  config.commands.push(dashboard
    ? {id, title:'打开示例链接', command:'https://example.com', note:'', expect:''}
    : {id, title:'新命令', command:'echo hello', note:'', expect:''});
  return id;
}

export function panelReferences(deck, panelId) {
  const references = [];
  const terminal = Object.hasOwn(deck.terminals || {}, panelId);
  for (const [index, slide] of (deck.slides || []).entries()) {
    if (slide.type === 'terminal' && slide.terminal === panelId) references.push({kind:'slide-terminal', path:`/slides/${index}/terminal`});
    if (slide.type === 'workspace') {
      for (const [panelIndex, id] of (slide.panels || []).entries()) if (id === panelId) references.push({kind:'slide-panel', path:`/slides/${index}/panels/${panelIndex}`});
    }
  }
  for (const [index, step] of (deck.sequence || []).entries()) if (step.panel === panelId) references.push({kind:'sequence', path:`/sequence/${index}/panel`});
  if (!terminal) {
    for (const [groupId, group] of Object.entries(deck.monitorGroups || {})) {
      for (const [panelIndex, id] of (group.panels || []).entries()) if (id === panelId) references.push({kind:'monitor-group', path:`/monitorGroups/${groupId}/panels/${panelIndex}`});
    }
    for (const [dashboardId, dashboard] of Object.entries(deck.dashboards || {})) {
      for (const [commandIndex, command] of (dashboard.commands || []).entries()) {
        if (command.preview?.panel === panelId) references.push({kind:'preview', path:`/dashboards/${dashboardId}/commands/${commandIndex}/preview/panel`});
      }
    }
  } else {
    for (const [dashboardId, dashboard] of Object.entries(deck.dashboards || {})) {
      if (dashboard.binding?.terminal === panelId) references.push({kind:'binding', path:`/dashboards/${dashboardId}/binding/terminal`});
    }
  }
  return references;
}

export function renamePanel(deck, oldId, newId) {
  if (oldId === newId) return;
  if (!ID_PATTERN.test(newId) || RESERVED.has(newId)) throw new Error(`面板 ID 无效：${newId}`);
  if (Object.hasOwn(deck.terminals || {}, newId) || Object.hasOwn(deck.dashboards || {}, newId)) throw new Error(`面板 ID 已存在：${newId}`);
  const terminal = Object.hasOwn(deck.terminals || {}, oldId);
  const source = terminal ? deck.terminals : deck.dashboards;
  const config = source?.[oldId];
  if (!config) throw new Error(`找不到面板：${oldId}`);
  const moved = {};
  for (const [id, value] of Object.entries(source)) {
    if (id === newId) continue;
    moved[id === oldId ? newId : id] = value;
  }
  if (terminal) deck.terminals = moved; else deck.dashboards = moved;

  for (const slide of deck.slides || []) {
    if (slide.type === 'terminal' && slide.terminal === oldId) slide.terminal = newId;
    if (Array.isArray(slide.panels)) slide.panels = slide.panels.map(id => id === oldId ? newId : id);
  }
  for (const step of deck.sequence || []) if (step.panel === oldId) step.panel = newId;
  if (!terminal) {
    for (const group of Object.values(deck.monitorGroups || {})) group.panels = (group.panels || []).map(id => id === oldId ? newId : id);
    for (const dashboard of Object.values(deck.dashboards || {})) {
      for (const command of dashboard.commands || []) if (command.preview?.panel === oldId) command.preview.panel = newId;
    }
  } else {
    for (const dashboard of Object.values(deck.dashboards || {})) if (dashboard.binding?.terminal === oldId) dashboard.binding.terminal = newId;
  }
}

export function removePanel(deck, panelId) {
  const references = panelReferences(deck, panelId);
  if (references.length) throw new Error(`面板仍被 ${references.length} 处引用，请先解除引用`);
  if (Object.hasOwn(deck.terminals || {}, panelId)) delete deck.terminals[panelId];
  else if (Object.hasOwn(deck.dashboards || {}, panelId)) delete deck.dashboards[panelId];
  else throw new Error(`找不到面板：${panelId}`);
}

export function removeTab(deck, panelId, tabId) {
  if (tabId === 'main') throw new Error('main tab 不可删除');
  const terminal = deck.terminals?.[panelId];
  if (!terminal?.tabs?.[tabId]) throw new Error(`找不到 tab：${tabId}`);
  for (const [index, command] of (terminal.commands || []).entries()) if (command.tab === tabId) throw new Error(`命令 ${index + 1} 仍引用此 tab`);
  for (const [index, step] of (deck.sequence || []).entries()) if (step.panel === panelId && step.tab === tabId) throw new Error(`演示步骤 ${index + 1} 仍引用此 tab`);
  for (const [id, dashboard] of Object.entries(deck.dashboards || {})) if (dashboard.binding?.terminal === panelId && dashboard.binding.tab === tabId) throw new Error(`图表 ${id} 仍引用此 tab`);
  delete terminal.tabs[tabId];
}

export function moveItem(list, index, delta) {
  const target = index + delta;
  if (!Array.isArray(list) || target < 0 || target >= list.length) return false;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
  return true;
}
