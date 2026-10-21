# 给文稿生成 AI 的提示词

复制下面的提示词，补充最后的“演示资料”，并让 AI 读取完整规范与示例。下面的要点也可以在无法访问链接时直接使用。

---

请为我编写 **Live Deck Format v1** 演示文稿。它是一个独立 JSON 格式，由现有播放器展示 reveal.js 普通页和真实 Jupyter 终端/网页分屏。请交付 `主题.livedeck.json`，不要用 PPTX、Notebook 或完整 HTML 代替。

资料：

- 完整规范：https://raw.githubusercontent.com/KuribohG/LiveDeck/main/web/docs/AUTHORING.md
- JSON Schema：https://raw.githubusercontent.com/KuribohG/LiveDeck/main/web/live-deck.schema.json
- 最小完整示例：https://raw.githubusercontent.com/KuribohG/LiveDeck/main/web/examples/minimal.livedeck.json
- 分屏完整示例：https://raw.githubusercontent.com/KuribohG/LiveDeck/main/web/examples/multi-panel.livedeck.json

格式要求：

1. 顶层填写 `"format":"live-deck"`、数字 `"version":1`、`id`、`title`、非空 `slides`。可选 `terminals`、`dashboards`、`monitorGroups`、`sequence`；不需要的字段省略，不写 null。
2. `id` 使用 1–80 位字母/数字/短横线/下划线。终端和图表 ID 在文稿内唯一，禁止 `__proto__`、`constructor`、`prototype`。同一 ID 的终端跨页共享同一个 Shell；不同 ID 是独立 Shell，但共享文件系统。
3. 普通页格式：`{"id":"opening","type":"slide","title":"标题","kicker":"可选页眉","markdown":"Markdown 正文","speakerNotes":"可选演讲者备注"}`。页面 `id` 在文稿内唯一；正文控制在一页可读的篇幅，代码块仅展示。
4. 单终端页格式：`{"id":"runner-page","type":"terminal","title":"标题","terminal":"runner"}`。
5. 分屏页格式：`{"id":"observe-page","type":"workspace","title":"标题","panels":["runner","metrics","logs"],"layout":"columns"}`。`panels` 中的 ID 不能重复，必须已定义。布局可用 `columns`（左右）、`rows`（上下）、`focus`（第一面板左侧主屏，其余右侧堆叠）。
6. `terminals.runner` 格式：`{"label":"主任务","cwd":"真实已有绝对目录","commands":[{"id":"run","title":"启动任务","command":"python3 -u demo.py","note":"观察点与继续条件","expect":"预期看到的真实结果"}]}`。`cwd` 可省略；只影响首次创建，不能创建目录或重新定位已有 Shell。
7. `dashboards.metrics` 格式：`{"label":"指标","url":"真实初始 URL","commands":[{"id":"observe","title":"观察指标","command":"真实完整 HTTP(S) URL","note":"关注哪些指标"}]}`。这里的 `command` 是 URL。优先使用真实 Grafana 单 panel 链接，保留时间范围、实例过滤和刷新参数。不要编造 dashboard UID、panel ID 或指标来源。
8. 每个池可有任意数量候选。给候选稳定、池内唯一的 `id`；候选 `title` 和 `command` 必填，`note`、`expect`、终端 `tab` 可选。命令用单行，长代码另交付脚本。不要包含真正换行、ESC、Ctrl+C 等控制字符。
9. `sequence` 是总演示顺序，例如 `[{"panel":"runner","command":"prepare"},{"panel":"logs","command":"follow"},{"panel":"runner","command":"run"},{"panel":"metrics","command":"observe"}]`。其中 command 引用候选 ID，不是直接写 Shell 命令。允许重复引用，不必把所有排障候选都放进总顺序。
10. 标记完成只推进提示，不自动执行，也不表示进程退出。长任务启动后可以转去日志/Grafana；持续观察日志用独立终端的 `tail -F`。同一个被前台程序占用的终端不能继续当空闲 Shell 使用，要说明何时等待结束或 Ctrl+C。
11. 页序与 sequence 独立，sequence 不绑定某张页面。不要生成 `autoRun`、`dependsOn`、`waitFor`、自定义 JS、AI 模型/认证等未实现字段。AI 助手由播放器提供，文稿不需要配置它。
12. 文稿是标准 JSON，双引号，无注释、尾逗号或省略号。实际演示命令必须来自给定代码/环境；不能用伪造输出代替真实执行。

组织方式：

- 先用普通页说明目标与检查标准，再进入终端操作；复杂阶段交替安排讲解页和分屏页。
- 清楚区分主任务、观察/日志和备用排障的终端。复用同一 Shell 时保持 ID 一致。
- 每个步骤写“要展示什么”和“看到什么才能继续”。并发任务、就绪检查、清理/重置应有明确安排。
- 如缺少执行必需的信息（真实路径、命令参数、服务入口、Grafana URL），明确列出待补项，不编造可运行事实。不要将含占位符的文稿标成已验证完成。
- 如有文件系统访问权限，交付完整 JSON 和必要脚本；可在本机运行：

```bash
node scripts/validate-deck.mjs /absolute/path/to/主题.livedeck.json
```

校验只检查格式和引用，不执行命令。没有本机环境时不要声称已经通过校验或实机排练。

请交付：

1. 完整 `主题.livedeck.json`。
2. 引用的脚本/数据准备方式，以及初始化/重置方式。
3. 简短的导入与排练说明，注明仍待用户补全或验证的项目。

演示资料：

- 主题与受众：[填写]
- 演示时长与希望证明的结论：[填写]
- 实际项目、机器、已有工作目录：[填写]
- 真实命令、代码、服务入口和输入数据：[填写]
- 哪些命令会持续运行，何时停止：[填写]
- Grafana dashboard / panel 的真实链接与指标说明：[填写]
- 页序、分屏和终端共享偏好：[填写]
- 依赖版本、初始化、检查与清理方式：[填写]


## 需要动态监控时

先阅读同目录 `MONITORING.md`。可使用 `dashboards.*.binding`（terminal、params、defaults、time、lookbackMs、refresh、follow）、顶层监控组、页面 monitorGroups / monitorGroup 和 sequence.group。URL 保留真实 Dashboard UID、Panel ID，params 显式映射真实 Grafana 变量名；不要使用 `{{...}}` 字符串模板。

启动工具路径为项目 `backend/run_context.py`。长任务启动后立即发布 started，真正拿到 task_id / instance 后由该任务内的脚本 publish ready / update。不要用“标记完成”或“填入终端”推断程序启动。`run` 只包装子进程，不能让子进程的 cd/export 修改父 Shell。缺少真实图表链接、变量名、指标标签时列出待补项，不能把参数预览当作真实监控。

终端可用 `tabs` 对象定义独立 Shell（main 默认存在）；命令 `tab` 指定默认填入目标，`sequence[].tab` 可按步骤覆盖。播放器会先切 tab，再填入且不回车。图表运行信息可用 `binding.tab` 绑定特定 tab；未指定时仍为 main。

PPT JSON 的 `terminals.<id>.tabs` 中声明的 tab 均为固定 tab，不显示关闭入口；需要演示过程中始终存在的前台、后台终端，应在此显式命名。仅用户在页面点“＋”创建的临时 tab 可关闭。
