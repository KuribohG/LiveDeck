/** Paginated rendering keeps long runbooks out of the DOM; the data has no count cap. */
export class RunbookList {
  constructor(list, controls, onSelect, pageSize = 40) {
    this.list = list; this.onSelect = onSelect; this.pageSize = pageSize; this.page = 0;
    this.previous = document.createElement('button'); this.previous.textContent = '‹'; this.previous.setAttribute('aria-label', '候选池上一页');
    this.label = document.createElement('span');
    this.next = document.createElement('button'); this.next.textContent = '›'; this.next.setAttribute('aria-label', '候选池下一页');
    controls.append(this.previous, this.label, this.next);
    this.previous.onclick = () => { this.page--; this.list.scrollTop = 0; this.render(); };
    this.next.onclick = () => { this.page++; this.list.scrollTop = 0; this.render(); };
  }
  update(commands, state, nextIndex, search = '') {
    if (this.commands !== commands || this.search !== search) {
      this.commands = commands; this.search = search; this.page = 0;
      const query = search.toLocaleLowerCase();
      this.indices = commands.flatMap((c, i) => `${c.title} ${c.command} ${c.note || ''}`.toLocaleLowerCase().includes(query) ? [i] : []);
    }
    if (this.selected !== state.selected) {
      const position = this.indices.indexOf(state.selected);
      if (position >= 0) this.page = Math.floor(position / this.pageSize);
    }
    const reveal = this.selected !== state.selected || this.nextIndex !== nextIndex;
    this.selected = state.selected; this.completed = new Set(state.completed); this.nextIndex = nextIndex; this.render(reveal);
  }
  render(reveal = false) {
    const pages = Math.max(1, Math.ceil(this.indices.length / this.pageSize));
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    this.previous.disabled = this.page === 0; this.next.disabled = this.page === pages - 1;
    this.label.textContent = `${this.page + 1} / ${pages} 页 · ${this.indices.length} 条`;
    const scrollTop = this.list.scrollTop;
    this.list.replaceChildren();
    for (const index of this.indices.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize)) {
      const command = this.commands[index], item = document.createElement('li');
      item.className = `${index === this.selected ? 'selected' : ''} ${this.completed.has(index) ? 'completed' : ''} ${index === this.nextIndex ? 'next-command' : ''}`;
      item.dataset.index = index; item.tabIndex = 0; item.setAttribute('role', 'button');
      item.title = `${command.title}\n${command.command}`;
      item.setAttribute('aria-label', `${index + 1}. ${command.title}${index === this.nextIndex ? '，全局下一步' : ''}`);
      const number = document.createElement('span'); number.className = 'command-number'; number.textContent = index === this.nextIndex ? '➜' : this.completed.has(index) ? '✓' : String(index + 1);
      const body = document.createElement('div');
      const title = document.createElement('div'); title.className = 'command-item-title'; title.textContent = command.title;
      const code = document.createElement('div'); code.className = 'command-item-code'; code.textContent = command.command;
      body.append(title, code); item.append(number, body);
      item.onclick = () => this.onSelect(index);
      item.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); this.onSelect(index);} };
      this.list.append(item);
    }
    this.list.scrollTop = scrollTop;
    const selected = this.list.querySelector('.selected');
    if (reveal && selected) this.list.scrollTop += selected.getBoundingClientRect().top - this.list.getBoundingClientRect().top;
  }
}
