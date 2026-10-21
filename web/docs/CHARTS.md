# Live Deck 时序图

`dashboards.<id>.chart` 是 iframe 之外的可选时序图类型；所有文稿共用同一实现。使用 ECharts 5.6.0，固定依赖与许可证随共享播放器部署，无运行时 CDN。

```json
{
  "label": "完整 FUSE read 延迟",
  "chart": {
    "type": "timeseries",
    "metric": "fuse-read-latency",
    "datasource": "your-grafana-datasource-uid",
    "database": "hf3fs_example",
    "stepSeconds": 2,
    "comparisonField": "comparison_runs",
    "colors": {"before": "#73bf69", "after": "#ff9830"}
  },
  "binding": {"terminal": "runner", "tab": "fuse", "params": {}, "lookbackMs": 5000},
  "commands": []
}
```

`binding` 指定来源 tab；`params` 留空，时序图直接读取结构化运行信息。时序图始终精确匹配 host/pod，冻结结束时间并按 5 秒刷新；iframe 的 URL 参数、refresh/time/singleInstance 选项不改变此契约。时序图不接受 URL 导航动作；需要切回网页时，删除 chart 并提供 url。

| metric | 数据 | 聚合 | 原始单位 |
|---|---|---|---|
| fuse-read-rate | fuse.op / read | sum(val) / stepSeconds | ops/s |
| fuse-read-latency | fuse.op.latency / read | sum(mean * count) / nullIf(sum(count), 0) | ns |
| blob-read-throughput | blob_client.data_payload_bytes / batchRead | sum(val) / stepSeconds | B/s |
| blob-read-latency | blob_client.overall_latency / batchRead | avg(mean)，沿用 Blob Client 原图口径 | ns |

后端仅接受这些指标模板，不接受任意 SQL、Grafana URL 或写操作。`datasource` 与 `database` 由文稿指定；凭证从服务端环境或 `~/.grafana.env` 读取，不发送给前端。HTTPS 验证开启，不跟随查询重定向。服务器需具备相应 Grafana 数据源查询权限。

部署：`deployment.metricsPath` 指向共享 `backend/metrics.py`；未配置时从同目录的 advisorPath 推导。首次有效查询自动创建一个独立指标 kernel；刷新页面复用该 kernel。关闭页面停止轮询；kernel 可在 Jupyter Running 中管理，不依赖 Bridge 后台进程。

运行字段：`host`、`pod` 必须是单个精确实例。未指定 comparisonField 时只显示本次运行。指定时，其字段为 JSON 数组，最多两个 `{host,pod,phase,from,to}` 记录，phase 为 before/after，时间为 epoch ms，to=0 表示尚未结束。最后一项必须与当前事件实例及开始时间匹配，前一项必须已结束且不与后一项重叠。空数组或旧运行无比较记录时只显示已知当前实例；不会猜测历史 pod。重跑 before 由运行脚本发新记录重置比较。

图表保留真实时间和固定颜色，不平移时间轴，不跨阶段平均。空值和缺测留空，不补零。固定采样间隔为 2–60 秒，默认 2 秒；每阶段最多约 10000 个采样桶，超限明确报错。改变时间范围或采样间隔会重新聚合，追加第二阶段不会改变第一阶段桶宽。

刷新：仅查询可见图表，每约 5 秒一次，不叠加并发请求。结束立即固定时间窗，最多一分钟继续补查迟到数据，此后停止自动查询，仍可手动刷新。暂停固定当前实例与时间范围；恢复跟随回到最新上报运行。查询失败保留旧数据并显示状态，自动重试。无数据时显示等待；新一轮清除旧实例曲线。页面恢复配置、运行和最后一次查询快照；浏览器存储满时按既有机制提示。

`Explore ↗` 携带本次同一查询和固定时间窗，需用户自己的 Grafana 浏览器登录。AI 上下文携带查询、单位、聚合、更新时间、各阶段 min/max/last 和最多 24 个尾部点；截断和过期均显式标记。它不是完整采样导出。

验证需用真实历史指标对照相同 SQL，另用隔离文稿回放启动、延迟入库、两阶段、暂停、结束、刷新、新一轮。禁止为了 UI 验证执行演示压测、SSH 或清理命令。
