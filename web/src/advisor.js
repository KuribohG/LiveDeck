export class CodexAdvisor {
  constructor(client, deployment, deckId) {
    this.client = client; this.deployment = deployment; this.key = `live-deck:kernel:${deckId}`;
    this.session = crypto.randomUUID(); this.busy = false;
  }
  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    let id = localStorage.getItem(this.key);
    if (id) {
      try { await this.client.request(`api/kernels/${id}`); }
      catch (error) { if (error.status === 404) id = null; else throw error; }
    }
    if (!id) {
      const kernel = await this.client.request('api/kernels', {method: 'POST', body: {name: 'python3'}});
      id = kernel.id; localStorage.setItem(this.key, id);
    }
    this.kernelId = id;
    const url = new URL(this.client.url(`api/kernels/${id}/channels`));
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('session_id', this.session);
    this.socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AI 服务连接超时')), 30000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('AI 服务连接失败')); }, {once: true});
    });
  }
  async ask(context, onEvent) {
    if (this.busy) throw new Error('请等待当前 AI 回答结束');
    this.busy = true;
    try {
      onEvent({type: 'status', message: '正在连接 Codex'});
      await this.connect();
      const id = crypto.randomUUID();
      const request = JSON.stringify(context);
      const code = `import importlib.util, json\n_spec = importlib.util.spec_from_file_location('live_deck_advisor', ${JSON.stringify(this.deployment.advisorPath)})\n_advisor = importlib.util.module_from_spec(_spec)\n_spec.loader.exec_module(_advisor)\n_advisor.answer(json.loads(${JSON.stringify(request)}))`;
      await new Promise((resolve, reject) => {
        let stream = '', gotResult = false;
        const cleanup = () => { clearTimeout(timer); this.socket.removeEventListener('message', listener); this.socket.removeEventListener('close', closed); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('AI 回答超时，请稍后重试')); }, 200000);
        const closed = () => { cleanup(); reject(new Error('AI 连接已断开，请重试')); };
        const listener = event => {
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (message.parent_header?.msg_id !== id) return;
          const content = message.content;
          if (message.msg_type === 'stream') {
            stream += content.text;
            let newline;
            while ((newline = stream.indexOf('\n')) !== -1) {
              const line = stream.slice(0, newline); stream = stream.slice(newline + 1);
              if (!line.startsWith('LIVE_DECK_EVENT ')) continue;
              try {
                const update = JSON.parse(line.slice(16));
                if (['answer', 'error'].includes(update.type)) gotResult = true;
                onEvent(update);
              } catch {}
            }
          }
          if (message.msg_type === 'error') { cleanup(); reject(new Error('AI 服务启动失败：' + content.evalue)); }
          if (message.msg_type === 'status' && content.execution_state === 'idle') {
            cleanup(); gotResult ? resolve() : reject(new Error('AI 未返回结果，请重试'));
          }
        };
        this.socket.addEventListener('message', listener); this.socket.addEventListener('close', closed);
        this.socket.send(JSON.stringify({header: {msg_id: id, username: 'live-deck', session: this.session, msg_type: 'execute_request', version: '5.3', date: new Date().toISOString()}, parent_header: {}, metadata: {}, channel: 'shell', content: {code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: true}, buffers: []}));
      });
    } finally { this.busy = false; }
  }
}
