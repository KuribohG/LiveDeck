export function createReply() {
  return {role:'assistant', text:'', summary:'', summarySource:'', progress:'', status:'正在连接 AI…', pending:true, commands:[]};
}

export function applyAdvisorEvent(reply, event) {
  if (event.type === 'status') reply.status = event.message;
  if (event.type === 'progress') reply.progress = event.text;
  if (event.type === 'reasoning_summary') {
    reply.summary = event.text; reply.summarySource = event.source; reply.status = '正在分析…';
  }
  if (event.type === 'answer_delta') { reply.text += event.delta; reply.status = '正在回答…'; }
  if (event.type === 'answer_replace') { reply.text = event.text; reply.status = '正在回答…'; }
  if (event.type === 'answer') {
    reply.text = event.answer; reply.commands = event.commands || []; reply.pending = false; reply.status = '';
    if (!reply.summary && event.summary) { reply.summary = event.summary; reply.summarySource = 'answer-summary'; }
  }
  if (event.type === 'error') { reply.error = event.message; reply.pending = false; reply.status = ''; }
}

/** Keyed rows keep disclosure state and reading position while text arrives. */
export class ConversationView {
  constructor(root, markdown, labelFor, onAdopt, onSave) {
    Object.assign(this, {root, markdown, labelFor, onAdopt, onSave});
    this.entries = new Map(); this.panel = null;
    this.empty = document.createElement('div'); this.empty.className = 'ai-empty';
    this.empty.textContent = '输入问题，结合当前终端和演示上下文讨论下一步。';
  }
  clear(panel) {
    for (const [id, entry] of this.entries) if (entry.panel === panel) this.entries.delete(id);
  }
  create(message, panel) {
    const row = document.createElement('div'); row.className = `ai-message ${message.role}`;
    const status = document.createElement('div'); status.className = 'ai-stream-status'; status.setAttribute('role','status');
    const details = document.createElement('details'); details.className = 'ai-summary';
    const summaryLabel = document.createElement('summary');
    const summaryText = document.createElement('div'); summaryText.className = 'ai-summary-text';
    details.append(summaryLabel, summaryText);
    summaryLabel.addEventListener('click', () => { message.summaryOpen = !details.open; this.onSave(); });
    const progress = document.createElement('div'); progress.className = 'ai-progress';
    const answer = document.createElement('div'); answer.className = 'ai-answer';
    const error = document.createElement('div'); error.className = 'ai-stream-error'; error.setAttribute('role','alert');
    const suggestions = document.createElement('div');
    row.append(status, details, progress, answer, error, suggestions);
    return {row,status,details,summaryLabel,summaryText,progress,answer,error,suggestions,panel};
  }
  render(messages, panel) {
    const nearBottom = this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < 45;
    const changed = this.panel !== panel; this.panel = panel;
    const rows = [];
    for (const message of messages) {
      message.id ||= crypto.randomUUID();
      let entry = this.entries.get(message.id);
      if (!entry) { entry = this.create(message, panel); this.entries.set(message.id, entry); }
      entry.status.hidden = !message.pending;
      entry.status.textContent = message.status || '正在回答…';
      entry.details.hidden = !message.summary;
      entry.details.open = message.summaryOpen ?? !!message.pending;
      entry.summaryLabel.textContent = (message.summarySource === 'model-summary' ? '推理摘要' : '分析摘要') + (message.pending ? ' · 接收中' : ' · 展开查看');
      entry.summaryText.textContent = message.summary || '';
      entry.progress.textContent = message.progress || ''; entry.progress.hidden = !message.progress;
      entry.error.textContent = message.error || ''; entry.error.hidden = !message.error;
      entry.answer.classList.toggle('streaming', !!message.pending && !!message.text);
      if (entry.text !== message.text) {
        if (message.role === 'user') entry.answer.textContent = message.text;
        else entry.answer.innerHTML = this.markdown(message.text);
        entry.text = message.text;
      }
      const commands = !message.pending && !message.error ? message.commands || [] : [];
      const signature = JSON.stringify(commands);
      if (entry.commandSignature !== signature) {
        entry.commandSignature = signature; entry.suggestions.replaceChildren();
        for (const suggestion of commands) {
          const row = document.createElement('div'); row.className = 'suggestion';
          const body = document.createElement('div'); body.className = 'suggestion-body';
          const code = document.createElement('code'); code.textContent = suggestion.command;
          const info = document.createElement('div'); info.className = 'suggestion-info';
          const title = document.createElement('strong'); title.className = 'suggestion-title'; title.textContent = suggestion.title || '建议操作';
          const note = document.createElement('div'); note.className = 'suggestion-note'; note.textContent = typeof suggestion.note === 'string' ? suggestion.note : ''; note.hidden = !note.textContent;
          info.append(title, note); body.append(code, info);
          const target = suggestion.panel || panel, label = this.labelFor(target);
          const button = document.createElement('button'); button.textContent = label ? `采用 → ${label}` : '目标面板不存在'; button.disabled = !label;
          button.onclick = () => this.onAdopt(target, suggestion);
          row.append(body, button); entry.suggestions.append(row);
        }
      }
      rows.push(entry.row);
    }
    if (!rows.length) rows.push(this.empty);
    if (changed || rows.length !== this.root.children.length || rows.some((row, i) => this.root.children[i] !== row)) this.root.replaceChildren(...rows);
    if (nearBottom || changed) this.root.scrollTop = this.root.scrollHeight;
  }
}
