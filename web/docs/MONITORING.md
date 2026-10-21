# 运行上下文与多图监控

这是 Live Deck v1 的可选扩展。普通页、静态 URL 与既有终端文稿继续可用。新增能力包括：运行中发布参数、多 Dashboard 单图联动、监控组、暂停跟随、统一时间和单图全屏。

- [打开可运行的联动示例](../index.html?deck=monitoring#/0)
- [完整示例 JSON](../examples/monitoring.livedeck.json)
- [完整格式规范](AUTHORING.md)

示例左侧运行真实 Python 进程；右侧是明确标注的 **URL 参数预览，不是 Grafana 数据**。用户实际演示时应换成真实的单图链接及变量映射。不要编造 Dashboard UID、Panel ID、指标标签或数据。

## 1. 一张图怎样跟随一个终端

下面是加入文稿 `dashboards` 的片段；示例域名、UID、Panel ID 均为占位，需要替换：

```json
{
  "latency": {
    "label": "P99 延迟",
    "url": "https://grafana.example.com/d-solo/service-uid/service?panelId=7&orgId=1",
    "binding": {
      "terminal": "runner",
      "params": {
        "var-instance": "instance",
        "var-task_id": "task_id"
      },
      "lookbackMs": 30000,
      "refresh": "5s"
    },
    "commands": []
  }
}
```

`params` 左边是 URL 查询参数名，右边是运行上下文里的字段名。譬如另一张图使用 `var-host`，仍然可以映射到相同的 `instance`。Grafana 看板必须实际定义对应变量，其查询必须使用这些变量；添加 URL 参数本身不能创建指标或筛选能力。

| binding 字段 | 规则 |
|---|---|
| `terminal` | 必填，引用已定义的终端 ID。只跟随该终端最近一次明确报告的运行 |
| `params` | 必填，对象，可为空。URL 参数名 → 运行字段名 |
| `paramSuffixes` | 可选，参数名 → 非空字符串数组。每个运行字段值分别追加各后缀，生成多个 URL 参数值 |
| `defaults` | 可选，预先确定的运行字段默认值。此次运行报告的同名字段覆盖默认值 |
| `time` | 可选，默认 `true`，根据本次运行生成 `from`、`to=now` 和 `refresh` |
| `lookbackMs` | 可选，默认 `30000`，时间起点前留出的毫秒数，非负整数 |
| `refresh` | 可选，默认 `5s`，格式如 `5s`、`1m`；实际刷新下限仍取决于 Grafana 配置 |
| `follow` | 可选，默认 `true`；为 `false` 时不随运行事件自动切换，使用者可以点击恢复跟随 |

默认自动时间使用 `monitoring_started_at_ms`，没有该字段时使用启动工具的本地命令开始时间。这个默认时间**不代表远端调度任务已经开始或服务已经就绪**。

当 `time:true` 时，不允许在 `params` 中同时映射 `from`、`to`、`refresh`；需要自行映射这些字段时设置 `time:false`。原链接的其他参数、路径和域名保留不变。值使用 `URLSearchParams` 编码，不做 JavaScript 求值或字符串模板展开。多值变量使用数组，生成重复的 `var-xxx` 参数。

任一必需字段缺失时，面板显示“等待字段”，不会加载一个缺少筛选条件的 URL。新运行清除上次运行的字段，防止旧 task_id 混入新任务。显式 `defaults` 每次运行都会生效，因此不要把只适合某次任务的值作为默认值。

## 2. 启动命令时发布上下文

启动工具在 `backend/run_context.py`，仅依赖 Python 标准库。示例中 `PROJECT` 表示 Live Deck 项目路径，不是播放器自动替换的模板。

```bash
python3 /PROJECT/backend/run_context.py run --set instance=node-a -- python3 -u demo.py
```

- `run` 在启动本地命令时立即报告 `started`，命令仍在运行时就能更新图表；结束后报告 `finished` 和退出码。
- `--` 后的参数直接交给子程序，不经过隐式 Shell 求值。管道、重定向、Shell 内建命令应放在你自己的脚本中，或显式使用 `bash -c '…'`。
- 交互式标准输入、终端输出和 Ctrl+C 继续传给真实程序。工具创建子进程，因此子进程的 `cd` / `export` 不会改变父 Shell；需要保持父 Shell 的命令请直接运行。
- 仅发布显式给出的 `--set key=value`，不会自动采集整个 Shell 环境。
- `started` 表示启动尝试；启动失败也会报告结束和非零退出码。程序未经工具启动时，播放器不会猜测它的生命周期。

启动后才能知道任务 ID 或节点时，在运行中的脚本里执行：

```bash
python3 /PROJECT/backend/run_context.py publish \
  --event ready \
  --set task_id=实际任务ID \
  --set instance=实际实例标签 \
  --monitoring-start-now
```

这段应放在**已由 `run` 启动的子程序内**，例如平台返回任务 ID 并确认任务实际开始后。`publish` 从继承环境中的 `LIVE_DECK_RUN_ID` 和 `LIVE_DECK_RUN_STARTED_MS` 识别当前运行，不需要把 ID 写进演示 JSON。`--monitoring-start-now` 仅在实际启动/就绪时使用；它将监控起点设为此刻。一般参数更新用 `--event update`。

通过 SSH 启动远程任务时，环境变量和控制终端不会自动跨越 SSH：由本地启动脚本读取远端返回的结构化信息，再在本地 `publish`；也可以有意识地转发所需运行标识并将事件送回原 PTY。不要假定任意远端日志都能自动关联。

命令可以自由输入，也可以通过候选池填入。填入、选中、标记步骤完成都不会生成运行事件，更不会自动执行命令。临时运行未接入工具的程序时，可点击终端工具栏的“运行信息”，手动填写字段和监控开始时间；“作为新的运行”清除上次字段。修改信息不执行命令。

## 3. 多 Dashboard 的几张图组成监控组

```json
{
  "monitorGroups": {
    "performance": {"label": "性能", "panels": ["throughput", "latency"]},
    "system": {"label": "主机", "panels": ["network", "cpu"]}
  },
  "slides": [
    {
      "type": "workspace",
      "title": "运行与监控",
      "panels": ["runner"],
      "monitorGroups": ["performance", "system"],
      "monitorGroup": "performance",
      "layout": "focus"
    }
  ],
  "sequence": [
    {"panel": "runner", "command": "run"},
    {"group": "performance"},
    {"group": "system"},
    {"panel": "latency", "command": "observe"}
  ]
}
```

这里的 `runner`、四个图表、`run` 和 `observe` 候选 ID 必须在完整文稿中另行定义。

- 顶层 `monitorGroups` 的每组需要 `label` 和非空、不重复的图表 `panels`，只能引用 `dashboards` 中的 ID。
- 页面 `panels` 是固定保留的面板；再加上当前组的图表，重复 ID 只显示一次。`monitorGroup` 是可选默认组，不填时选第一组。
- 一组内的图可以来自不同 Grafana Dashboard，也可绑定不同来源终端。共用一次运行时，各图的 `binding.terminal` 填相同值即可。
- 当前页面的组选择保存在浏览器内，翻页返回时恢复。组定义不绑定某个页面，同一组可以跨页复用。
- `sequence` 支持 `{ "group": "system" }`。选中该步会切到包含该组的页面并显示该组；仍由演示者手动标记完成。不能在同一步混用 `group` 与 `panel` / `command`。
- 普通图表步骤如果位于当前隐藏的组中，点击操作栏的“计划”会先切换到包含它的组。
- 数量不设人为上限。同屏建议 2–4 张图；尚未展示过的组不会预先加载 iframe。已经加载过的隐藏图表仍保留，可能继续产生 Grafana 查询。

## 4. 现场操作

- **监控组下拉框**：位于工作区标题行、当前面板连接状态左边，整组跟随和时间范围控件也在同一处。切换观察内容时，终端和已创建的 iframe 不重建。
- **全屏 / 退出全屏**：图表或终端占满整个浏览器内容区域，暂时收起候选池，保留退出按钮和原有连接；退出后恢复分屏，不重建 iframe、不重启进程。外层页面获得焦点时也可按 Esc 退出；终端或跨域 Grafana 获得键盘焦点时请点退出按钮。AI 面板也有独立全屏入口。
- **单图“跟随中 / 已暂停”**：控制该图是否采用后续运行参数；暂停不会停止 Grafana 自身的刷新。
- **整组暂停 / 恢复跟随**：作用于当前所有可见且配置了 binding 的图表，包含页面固定图表，不影响隐藏组。
- **时间范围**：给当前可见且已经有 URL 的图表统一设置时间，并暂停参数跟随。固定结束时间会去掉 `refresh`；恢复跟随重新应用运行时间。支持毫秒时间戳、`now`、`now-15m` 等，不修改远端 Dashboard 配置。
- **打开 / 看板**：前者打开当前图表；后者将常规 `/d-solo/` 地址转为完整 `/d/` 看板。非标准分享地址仍以 Grafana 实际页面为准。
- **候选**：终端和图表各有独立的展开 / 收起按钮，默认折叠。步骤定位和高亮不会自动展开候选；手动选择跨页和切组保留，刷新后恢复折叠。打开新的候选 URL 时会恢复该图的 binding，并据当前运行生成新链接。

跨域 iframe 里的手动筛选和时间修改不会反向同步到 Live Deck，也不会自动传播给其他图。需要统一修改时使用 Live Deck 的运行信息与时间范围控件。

## 5. 传输、恢复与状态边界

运行信息通过明确的终端控制序列传送：`ESC ] 777;live-deck;<base64 UTF-8 JSON> BEL`。事件包含 `version:1`、`event`、`run_id`、`started_at_ms`、`at_ms`、`event_id`、`fields`，工具还提供字符串 `at_ns` 以区分同一毫秒内的事件。结束时可带 `exit_code`。接收器支持分块、忽略无效数据；普通日志不会被当作参数或指令。

运行字段支持字符串、有限数值、布尔值和它们的非空数组。`--set` 发布字符串；保留的 `monitoring_started_at_ms` 必须是数值，可通过 `--monitoring-start-now` 生成。运行标识和事件类型由工具管理，不需要作者手写。

- 来源由对应终端的 WebSocket 决定，事件不能指定另一个终端；不同 deck ID 使用不同终端名。
- 脚本和终端都是演示者授权执行的本机程序；此协议用于传递参数，不是安全认证协议。事件无法改变图表的固定域名/路径，也不会执行新命令。
- 修改图表的 `url` 或 `binding` 后，会丢弃该图以前保存的链接和跟随开关，并按新配置重新绑定。
- 浏览器保存已收到的最新运行上下文、链接和跟随状态；刷新后重新订阅终端，并利用 Jupyter 的有限输出回放补齐近期事件。旧运行的迟到结束事件不覆盖新运行。
- **关闭浏览器期间不是持久事件服务**：若重要事件已经超出 Jupyter 回放缓冲区，就无法补回。可再次 `publish` 或手动填写信息。不能将本地保存的“运行中”视为平台任务当前仍存活的证据。
- Jupyter 终端消失后，新建终端会清除旧运行上下文。断线期间、进程被强杀或终端被关闭时，可能收不到结束事件。
- AI 会收到同屏运行信息、当前 URL 与跟随状态，仍然不会读取跨域 Grafana 图表的数值。

图表是否能嵌入取决于 Grafana 登录、Cookie 和响应头策略；本工具不改变这些配置。要区分单次任务，指标本身需要相应任务标签；主机指标仍代表整台主机。

## 6. 实现参考

- [Runme 会话与变量](https://docs.runme.dev/usage/pipes-variables/)：运行上下文跨步骤保存。
- [VS Code Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration#supported-escape-sequences)：显式终端事件与普通输出分离。
- [Grafana Scenes 变量依赖](https://grafana.com/developers/scenes/advanced-variables)：依赖齐全后统一更新。
- [Instruqt 多种面板](https://docs.instruqt.com/tracks/challenges/challenge-tabs)：运行环境与展示布局分离。

本实现独立编写，未引入这些项目的运行时或复制其源码；不依赖 Lark Bridge。


复用已有看板时，应按其实际变量名映射。若运行信息里的 `pod` 是会话前缀，而看板使用精确 pod 筛选，可配置 `"params":{"var-ClientPod":"pod"},"paramSuffixes":{"var-ClientPod":["-before","-after"]}`。例如 `pod="demo-1"` 会生成两个 ClientPod 值 `demo-1-before`、`demo-1-after`，不扩大为 All，也不修改原看板查询。

更新已发布文稿的图表时，可同步修改顶层 `monitoringRevision`。刷新后，从服务器更新同一文稿的图表定义，以及 ID 和命令内容均未改动的候选说明。浏览器保存的文稿标题、命令内容、tab 与步骤目标保留；额外添加的图表保留。聊天和运行进度仍按原文稿 ID 恢复。无需变更 `revision` 或切换浏览器存储键；后续手动改图表会保存，直到再次更新 `monitoringRevision`。

### 单实例 Grafana 面板

监控使用 Grafana 原生 `d-solo` 页面；Grafana 负责查询、单位、绘图、悬浮提示和刷新，播放器只负责布局和运行参数联动。不要在播放器中维护 SVG 绘图或 Python 指标查询模块。

`binding.singleInstance: true` 要求单个明确的 `var-ClientHost` 与 `var-ClientPod`；空值、All、多目标或正则均等待，不打开全集群图。`binding.freezeOnFinish: true` 在进程结束时固定时间终点。绑定到真正运行 FUSE 的 tab，从其 started/ready/finished 事件获取精确 pod；不能拼接多个版本或用 setup 会话前缀代替。

选用已有看板中的原生 panel，核实实际 SQL 确实使用 host/pod 筛选，返回一条曲线。没有适用 panel 时先准备原看板的修改方案，在用户授权范围内补齐；不要新建演示专用 dashboard 或用不同范围的延迟替代。完整 FUSE read 延迟是 `fuse.op.latency / read`，Blob Client 读调用延迟是 `blob_client.overall_latency / batchRead`。

Grafana 的动态 QueryVariable 在新实例尚未进入候选列表时，自动刷新可能把 URL 指定的 host/pod 改成 All；仅检查 iframe 的初始 URL 不足以保证筛选。FUSE 48/49 和 Blob Client 91/66 支持隐藏的 TextVariable `LiveClientHost` / `LiveClientPod`，绑定时同时映射 `var-LiveClientHost` 到 `host`、`var-LiveClientPod` 到 `pod`。SQL 优先精确匹配固定参数；参数为空时沿用原看板的选择器。验证须覆盖候选为空、延迟入库和多次自动刷新，检查实际 SQL 与非空数值列数量；一个 Grafana data frame 可以包含多条曲线。

WB 前后对比沿用同一套参数联动：启动辅助脚本在隔离 session 的 `.live-deck-fuse-runs.json` 记录实际上报的 before/after 身份及起止时间，事件的 `comparison_runs` 是这些记录的 JSON 字符串。FUSE 48/49 的绑定把它传给固定文本变量 `LiveClientRuns`，`monitoring_started_at_ms` 取第一段起点。SQL 按每段的精确 host/pod 和独立时间窗查询，并按 `phase` 分成绿色 before / 橙色 after；不移动时间、不跨阶段求平均。新 before 清空前轮，after 只追加同会话已结束的 before；只有 after 时显示实际观测到的一段。完成后两段一起固定时间，刷新通过运行上下文恢复。默认 `comparison_runs: "[]"` 兼容旧事件，仅显示其明确报告的当前实例。USRBIO 不绑定该参数。

## Live Deck 自身时序图

无需 Grafana 看板的 `chart.type: "timeseries"` 扩展见 [配置与行为契约](CHARTS.md)。
