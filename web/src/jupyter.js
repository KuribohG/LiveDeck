export class JupyterClient {
  constructor(baseUrl) { this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`; }
  url(path) { return new URL(this.baseUrl + path, location.origin).href; }
  async request(path, {method = 'GET', body, signal} = {}) {
    const xsrf = document.cookie.split('; ').find(c => c.startsWith('_xsrf='))?.slice(6);
    const headers = {'Content-Type': 'application/json'};
    if (xsrf) headers['X-XSRFToken'] = decodeURIComponent(xsrf);
    const response = await fetch(this.url(path), {
      method, headers, credentials: 'same-origin', signal,
      ...(body !== undefined ? {body: JSON.stringify(body)} : {})
    });
    if (!response.ok) {
      const error = new Error(response.status === 403 || response.status === 401
        ? '请先登录当前 Jupyter，再刷新演示页面' : `Jupyter 请求失败 (${response.status})`);
      error.status = response.status; throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }
}
