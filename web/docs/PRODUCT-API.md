# Live Deck 产品接口 v1

该接口面向制作和维护演示的 Agent，也供内嵌 AI 的后续结构化操作使用。接口只在当前浏览器页面内维护状态；它不会执行终端命令、启动实验、修改 Grafana 看板或推进真实运行。

打开任意共享播放器后，可在浏览器控制台访问：

```js
window.liveDeck.productApi
```

## `inspect()`

返回当前真正生效的状态快照，而不是服务器上的默认文稿：

- 已发布文稿与浏览器生效文稿的版本指纹。
- 当前页、监控组、可见面板、当前面板和计划下一步。
- 每个面板的活动 tab、绑定、实际 URL、运行参数和图表查询请求。
- 按运行绑定归并的实验对象，以及从单次运行或比较记录推导出的阶段、精确 host/pod 和起止时间。
- 图表的最近查询证据、数据是否陈旧、错误和点列截断情况。
- 共享指标目录以及当前缺失的 host、pod、运行或数据。

页面顶部“复制状态”按钮调用同一个接口。复制失败时会把完整 JSON 显示在对话框中，便于人工复制。

## `preview(operation, options?)`

在文稿副本上验证结构化修改，不写入浏览器存储。返回：

```json
{
  "status": "ready",
  "operationType": "chart.set",
  "affectedPanels": ["latency"],
  "diff": [
    {
      "op": "replace",
      "path": "/dashboards/latency/chart/metric",
      "before": "fuse-read-latency",
      "after": "fuse-read-rate"
    }
  ],
  "effectiveRevision": "deck-...",
  "nextRevision": "deck-...",
  "issues": []
}
```

修改冲突或校验失败时返回 `status: "rejected"` 和带 `code`、`message`、`path` 的 `issues`。可将 `inspect().deck.effectiveRevision` 作为 `options.expectedRevision`，防止覆盖用户刚做的修改。

## `apply({operation, expectedRevision?})`

原子应用一次修改，并返回差异、最终版本、校验结果和 `undoToken`。浏览器文稿、内存中的共享播放器和图表面板会一起更新。

```js
const api = window.liveDeck.productApi;
const snapshot = api.inspect();
const result = api.apply({
  expectedRevision: snapshot.deck.effectiveRevision,
  operation: {
    type: "chart.set",
    target: "latency",
    patch: {
      metric: "fuse-read-rate",
      stepSeconds: 2
    }
  }
});
```

若 `status` 为 `applied`，可调用 `api.undo(result.undoToken)` 只撤销这次配置修改。撤销不会倒退运行状态、聊天、步骤进度或终端历史。

## `validate(options?)`

执行不运行实验的检查：

1. 文稿和引用静态校验。
2. 指标目录、单位、聚合方式和比较能力校验。
3. 在内存中回放 started、ready、重复、结束、迟到事件以及 before/after 接续，验证图表的精确实例绑定、停机区间、阶段顺序和结束冻结。

```js
api.validate({replay: true, panel: "latency"});
```

传入 `operation` 可先验证待应用修改。结果中的 `levels.replay.checks` 是逐项机器可读结论。

## 支持的操作

### `chart.set`

修改已有 Live Deck 时序图，保留运行绑定和未修改字段。

```json
{
  "type": "chart.set",
  "target": "latency",
  "patch": {
    "metric": "fuse-read-latency",
    "stepSeconds": 2,
    "comparisonField": "comparison_runs",
    "colors": {"before": "#73bf69", "after": "#ff9830"}
  }
}
```

### `monitor.set`

面向指标含义的包装，同时声明当前运行或 before/after 时间线：

```json
{
  "type": "monitor.set",
  "target": "latency",
  "metricRef": "fuse-read-latency",
  "view": {
    "mode": "phase-timeline",
    "phases": ["before", "after"],
    "timeAxis": "wall-clock",
    "retainCompleted": true,
    "resetOn": "before"
  }
}
```

当前产品语义始终保留已完成阶段，并在新 before 开始时建立新一轮比较。`mode: "current"` 可切换回单次运行图。

### `command.update`

修改一个已有命令的标题、命令正文、说明或目标 tab。命令 `id` 不可原地修改，避免悄悄破坏计划引用。

```json
{
  "type": "command.update",
  "target": "runner",
  "command": "run",
  "patch": {"note": "先确认实例，再开始测量"}
}
```

### `terminal.prepare`

只把一条安全单行命令放入编辑框，并选择目标 tab；不会发送回车。

```json
{
  "type": "terminal.prepare",
  "target": "runner",
  "tab": "fuse",
  "text": "fio --name=read --rw=read"
}
```

## 指标目录

[metric-catalog.json](../src/metric-catalog.json) 是前端产品接口与 `backend/metrics.py` 共用的指标口径来源。每项声明：

- 展示名称和含义。
- 查询表、metricName、instance、聚合方式和单位。
- 精确实例作用范围。
- 是否支持单次运行与 before/after。
- 必需的运行字段。

完整 FUSE read 延迟固定使用 `fuse.op.latency` 的 `read` 实例和样本数加权平均，不能替换成 Blob Client 延迟。

## 当前边界

- 第一版只覆盖图表、命令和终端草稿，不修改页面结构、监控组或 sequence。
- 只有最近一次 `apply` 可在当前页面撤销；刷新后需重新预览和应用。
- 回放使用隔离的合成事件，不执行演示命令，也不证明真实工作负载成功。
- `inspect()` 中发现 Grafana 数据已存在时，仍需区分“配置可生成”“查询已返回”“页面已渲染”和“真实实验已验证”。
