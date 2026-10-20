export const MAIN_TAB = 'main';

export function terminalTabs(config) {
  return [{label:'Tab 1', ...config.tabs?.[MAIN_TAB], id:MAIN_TAB},
    ...Object.entries(config.tabs || {}).filter(([id]) => id !== MAIN_TAB).map(([id, tab]) => ({label:id, ...tab, id}))];
}

export function hasTerminalTab(config, tab) {
  return typeof tab === 'string' && (tab === MAIN_TAB || Object.hasOwn(config.tabs || {}, tab));
}

// Preserve the original terminal name for old decks and the first tab.
export function terminalSessionId(panel, tab = MAIN_TAB) {
  return tab === MAIN_TAB ? panel : `${panel}:${tab}`;
}

export function commandTab(config, state, step) {
  return step?.tab ?? config.commands[state.selected]?.tab ?? MAIN_TAB;
}

export function fixedTabDefinitions(deck) {
  return Object.fromEntries(Object.entries(deck.terminals || {}).map(([id, config]) => [id, terminalTabs(config).map(tab => tab.id)]));
}

export function restoreTabOrigins(deck, source, metadata) {
  const oldTemporary = metadata?.version === 2 ? metadata.temporary : metadata;
  const oldFixed = metadata?.version === 2 ? metadata.fixed : null;
  const temporary = {}, fixed = {};
  const includes = (map, id, tab) => Array.isArray(map?.[id]) && map[id].includes(tab);
  for (const [id, config] of Object.entries(deck.terminals || {})) {
    temporary[id] = []; fixed[id] = [];
    for (const {id:tab} of terminalTabs(config)) {
      const sourceConfig = deck.id === source.id && source.terminals?.[id];
      if (tab === MAIN_TAB || Object.hasOwn(sourceConfig?.tabs || {}, tab) || includes(oldFixed, id, tab)) fixed[id].push(tab);
      else if (includes(oldTemporary, id, tab)) temporary[id].push(tab);
      else fixed[id].push(tab);
    }
  }
  return {temporary, fixed};
}
