import {JupyterKernelClient} from './kernel.js';
import {terminalSessionId} from './tabs.js';
import {chartRequest, chartEvidence, PHASE_COLORS, PHASE_LABELS, formatValue} from './chart-model.js';

let library;
function echarts() {
  return library ||= new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = new URL('../vendor/echarts.js', import.meta.url);
    script.onload = () => resolve(window.echarts); script.onerror = () => { library = null; reject(new Error('图表组件加载失败，请刷新页面')); };
    document.head.append(script);
  });
}

/** One query kernel for charts, independent of long-running AI requests. */
export class LiveCharts {
  constructor(workspace, client, deployment, deckId) {
    this.workspace = workspace;
    this.kernel = new JupyterKernelClient(client, {key:`live-deck:metrics-kernel:${deckId}`,
      modulePath:deployment.metricsPath || deployment.advisorPath.replace(/advisor\.py$/, 'metrics.py'),
      prefix:'LIVE_DECK_METRICS ', timeout:320000, label:'监控'});
    this.timer = setInterval(() => this.tick(), 500);
    window.addEventListener('pagehide', () => this.dispose(), {once:true});
  }
  dispose() { clearInterval(this.timer); for (const entry of this.workspace.cards.values()) { entry.chartObserver?.disconnect(); entry.chartInstance?.dispose(); } this.kernel.socket?.close(); }
  refresh(id) {
    const w = this.workspace, entry = w.cards.get(id), state = w.store.terminal(id), config = w.deck.dashboards[id];
    if (!entry.chartObserver) {
      entry.chartObserver = new ResizeObserver(() => entry.chartInstance?.resize()); entry.chartObserver.observe(entry.frame);
      const button = document.createElement('button'); button.textContent = '刷新'; button.title = '重新查询当前时间窗';
      button.onclick = () => { entry.nextQuery = 0; this.tick(); }; entry.toolbar.append(button);
      entry.link.textContent = 'Explore ↗'; entry.link.title = '在 Grafana 核对同一查询'; entry.full.hidden = true;
      entry.chartInfo = document.createElement('div'); entry.chartInfo.className = 'chart-info'; entry.viewport.append(entry.chartInfo);
    }
    try {
      if (w.follows(id) || !state.chartRequest) {
        const run = w.runs.get(terminalSessionId(config.binding.terminal, config.binding.tab));
        state.chartRequest = chartRequest(config, run);
      }
      const key = JSON.stringify(state.chartRequest);
      if (entry.chartKey !== key) {
        const previous = entry.chartData;
        entry.chartKey = key; entry.nextQuery = 0; entry.chartError = null;
        entry.chartData = state.chartSnapshot?.key === key ? state.chartSnapshot.data : null;
        if (!entry.chartData && previous) {
          const retained = previous.series.filter(s => state.chartRequest.runs.some(r => r.host === s.host && r.pod === s.pod && r.phase === s.phase && r.from === s.from));
          if (retained.length && previous.queries?.[0]?.datasource.uid === config.chart.datasource) {
            entry.chartData = {...previous, key, series:retained};
            entry.chartError = '运行阶段更新中，暂保留已查询数据';
          }
        }
        if (!entry.chartData) { entry.chartReset = true; entry.chartInstance?.clear(); entry.link.removeAttribute('href'); entry.chartInfo.textContent = ''; delete state.chartSnapshot; }
        else this.render(id, entry.chartData).catch(error => this.failed({id, key}, error.message));
      }
      entry.pending.hidden = !!entry.chartData?.series.some(s => s.points.some(p => p[1] !== null));
      entry.pending.textContent = entry.chartData ? '暂无数据，等待指标入库…' : '正在查询本次运行…';
      entry.status.textContent = w.follows(id) ? (state.chartRequest.to ? '已结束 · 固定时间窗' : '每 5 秒更新') : '已暂停';
    } catch (error) {
      entry.chartKey = null; entry.chartData = null; delete state.chartRequest; delete state.chartSnapshot;
      entry.chartReset = true; entry.chartInstance?.clear(); entry.link.removeAttribute('href'); entry.chartInfo.textContent = '';
      entry.pending.hidden = false; entry.pending.textContent = error.message; entry.status.textContent = '等待运行';
    }
    queueMicrotask(() => this.tick());
  }
  pause(id) {
    const state = this.workspace.store.terminal(id);
    if (state.chartRequest && !state.chartRequest.to) {
      const end = this.workspace.cards.get(id).chartData?.to || Date.now();
      state.chartRequest = {...state.chartRequest, to:end, runs:state.chartRequest.runs.map(r => ({...r, to:r.to || end}))};
    }
  }
  timeRange(id, from, to) {
    const now = Date.now(), parse = value => {
      if (/^\d+$/.test(value)) return Number(value);
      if (value === 'now') return now;
      const m = value.match(/^now-(\d+)([smhd])$/);
      if (!m) throw new Error('时序图时间需要毫秒时间戳、now 或 now-15m 等');
      return now - Number(m[1]) * ({s:1000,m:60000,h:3600000,d:86400000})[m[2]];
    };
    const state = this.workspace.store.terminal(id);
    if (!state.chartRequest) return;
    state.chartRequest = {...state.chartRequest, from:parse(from), to:parse(to)}; state.follow = false; this.refresh(id);
  }
  async tick() {
    if (this.busy || document.hidden) return;
    const w = this.workspace, now = Date.now(), panels = [];
    for (const id of w.visible) {
      const entry = w.cards.get(id), state = w.store.terminal(id);
      if (!entry?.chartKey || !state.chartRequest || now < (entry.nextQuery || 0)) continue;
      panels.push({id, key:entry.chartKey, ...state.chartRequest});
    }
    if (!panels.length) return;
    this.busy = true;
    try {
      await this.kernel.execute({panels}, event => {
        if (event.type === 'error') { for (const p of panels) this.failed(p, event.message); }
        for (const result of event.panels || []) {
          const entry = w.cards.get(result.id);
          if (entry?.chartKey !== result.key) continue;
          if (result.error) { this.failed(result, result.error); continue; }
          const state = w.store.terminal(result.id);
          entry.chartError = null; entry.chartData = result;
          entry.status.textContent = w.follows(result.id) ? (w.store.terminal(result.id).chartRequest.to ? '已结束 · 固定时间窗' : '每 5 秒更新') : '已暂停';
          state.chartSnapshot = {key:result.key, data:result};
          // The time window freezes immediately; allow late ingestion for one minute.
          const end = state.chartRequest.to;
          entry.nextQuery = end && Date.now() - end > 60000 ? Infinity : now + 5000;
          this.render(result.id, result).catch(error => this.failed(result, error.message));
        }
      });
      w.store.save();
    } catch (error) { for (const p of panels) this.failed(p, error.message); }
    finally { this.busy = false; }
  }
  failed(item, message) {
    const entry = this.workspace.cards.get(item.id);
    if (entry?.chartKey !== item.key) return;
    entry.chartError = message; entry.nextQuery = Date.now() + 5000; entry.status.textContent = '查询失败 · 将重试';
    entry.chartInfo.textContent = message + (entry.chartData ? '；保留上次数据' : '');
    if (!entry.chartData) {entry.pending.hidden = false; entry.pending.textContent = message;}
  }
  async render(id, data) {
    const ec = await echarts(), entry = this.workspace.cards.get(id), config = this.workspace.deck.dashboards[id];
    if (entry.chartKey !== data.key) return;
    const first = !entry.chartInstance || entry.chartReset; entry.chartReset = false;
    if (!entry.chartInstance) entry.chartInstance = ec.init(entry.frame, null, {renderer:'canvas'});
    const unit = data.unit;
    const base = first ? {
      backgroundColor:'transparent', animation:false, textStyle:{color:'#cbd5e1'},
      grid:{left:12,right:22,top:35,bottom:44,containLabel:true},
      legend:{top:3,textStyle:{color:'#cbd5e1'}},
      tooltip:{trigger:'axis',confine:true,renderMode:'richText',valueFormatter:value => formatValue(value,unit)},
      xAxis:{type:'time',axisLabel:{color:'#94a3b8',hideOverlap:true},splitLine:{show:false}},
      yAxis:{type:'value',min:0,axisLabel:{color:'#94a3b8',formatter:value => formatValue(value,unit)},splitLine:{lineStyle:{color:'#263244'}}},
      dataZoom:[{type:'inside',filterMode:'none'},{type:'slider',height:16,bottom:5,filterMode:'none',borderColor:'#334155',textStyle:{color:'#94a3b8'}}],
    } : {};
    entry.chartInstance.setOption({...base,
      xAxis:{...base.xAxis,min:data.from,max:Math.max(data.to,data.from+1000)},
      series:data.series.map(s => ({id:s.phase,name:PHASE_LABELS[s.phase],type:'line',data:s.points,
        showSymbol:s.points.filter(p => p[1] !== null).length === 1,symbolSize:5,connectNulls:false,smooth:false,
        lineStyle:{width:2,color:config.chart.colors?.[s.phase] || PHASE_COLORS[s.phase]},
        itemStyle:{color:config.chart.colors?.[s.phase] || PHASE_COLORS[s.phase]}})),
    }, {replaceMerge:['series'],lazyUpdate:false});
    entry.chartInstance.resize(); entry.link.href = data.source_url;
    entry.pending.hidden = data.series.some(s => s.points.some(p => p[1] !== null));
    entry.pending.textContent = entry.nextQuery === Infinity ? '该时间窗暂无数据，可点击刷新重查' : '暂无数据，等待指标入库…';
    entry.chartInfo.textContent = `${data.series.map(s => `${s.phase}: ${s.host} / ${s.pod}`).join(' · ')} · 更新 ${new Date(data.queried_at_ms).toLocaleTimeString()}`;
    entry.chartInfo.title = `${data.metric} / ${data.instance} · ${data.aggregate} · ${data.unit}`;
  }
  context(id) { const e = this.workspace.cards.get(id); return chartEvidence(e?.chartData, e?.chartError); }
}
