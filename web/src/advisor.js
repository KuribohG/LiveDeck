import {JupyterKernelClient} from './kernel.js';

export class CodexAdvisor extends JupyterKernelClient {
  constructor(client, deployment, deckId) {
    super(client, {key:`live-deck:kernel:${deckId}`, modulePath:deployment.advisorPath});
    this.deployment = deployment;
  }
  async ask(context, onEvent) {
    onEvent({type:'status', message:'正在连接 Codex · DeepSeek Flash'});
    return this.execute(context, onEvent);
  }
}
