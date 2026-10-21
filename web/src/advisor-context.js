import {panelConfig, slidePanels} from './model.js';

// Keep the chat owner separate from the panel currently being operated on.
export function advisorContext({question, deck, store, workspace, pool, sequence, slide, conversationPanel, operationPanel, productState = null}) {
  const id = conversationPanel, config = panelConfig(deck, id), state = store.terminal(id);
  const isDashboard = Object.hasOwn(deck.dashboards || {}, id);
  const panelIds = [...new Set([id, operationPanel, ...workspace.visible].filter(Boolean))];
  const conversation = state.conversation.filter(m => !m.pending);
  const panel_catalog = [
    ...Object.entries(deck.dashboards || {}).map(([id, config]) => ({
      id, kind:'dashboard', label:config.label || id, base_url:config.url, binding:config.binding, chart:config.chart,
      url:store.terminal(id).url || config.url, following:workspace.follows(id),
    })),
    ...Object.entries(deck.terminals || {}).map(([id, config]) => ({id, kind:'terminal', label:config.label || id, cwd:config.cwd})),
  ];
  return {question, deck:{id:deck.id, title:deck.title}, slide:slide.title,
    slide_context:{...slide, panels:slidePanels(slide, deck)}, terminal:id,
    conversation_panel:id, operation_panel:operationPanel, cwd:config.cwd || '', kind:isDashboard ? 'dashboard' : 'terminal',
    current_step:config.commands[state.selected] || {},
    plan:config.commands.slice(Math.max(0, state.selected - 10), state.selected + 31),
    plan_window:{total:config.commands.length, selected:state.selected, start:Math.max(0, state.selected - 10)},
    panels:workspace.context(panelIds), panel_catalog,
    sequence:{total:sequence.steps.length, cursor:sequence.state.cursor,
      upcoming:sequence.steps.slice(sequence.state.cursor, sequence.state.cursor + 12).map(step => step.group
        ? {group:step.group, title:deck.monitorGroups[step.group].label}
        : {panel:step.panel, tab:step.tab, action:panelConfig(deck, step.panel).commands[step.index]})},
    terminal_history:isDashboard ? '' : pool.history(workspace.sessionId(id)),
    conversation:conversation.slice(-16), conversation_total:conversation.length,
    product_state:productState};
}
