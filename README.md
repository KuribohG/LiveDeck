# Live Deck

把技术演示的幻灯片、真实终端、命令提词器、监控图表和可选的 AI 建议放在同一个页面。

源码：[KuribohG/LiveDeck](https://github.com/KuribohG/LiveDeck) · [MIT License](LICENSE) · [English quick start](README.en.md)

## 快速开始

需要 Python 3.11+、Bash，以及运行在 Jupyter Server 1.x 上的 nbclassic 终端。依赖包含 Notebook 6 的经典前端兼容组件。使用 `python -m nbclassic` 启动；旧的 `python -m notebook` 服务忽略终端创建请求中的名称与 cwd，不能用于本播放器。当前终端适配器依赖 `window.terminal`，不保证兼容 Notebook 7 或 JupyterLab 的原生终端页面。

```bash
git clone https://github.com/KuribohG/LiveDeck.git
cd LiveDeck
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python install_local.py --server-url http://127.0.0.1:8888
python -m nbclassic --no-browser --port=8888
```

先打开 Jupyter 启动时给出的带 token 登录链接，再访问：
`http://127.0.0.1:8888/custom/live-deck/index.html`。
不要用普通静态 HTTP 服务替代 Jupyter：真实终端和 AI 需要同源 Jupyter API。

已有兼容 Jupyter 服务时，只需运行安装脚本。反向代理或 JupyterHub 用户应将 `--server-url` 设为浏览器看到的完整 Jupyter 地址（含 `/user/alice/` 等前缀）；可用 `--custom-dir` 指向服务实际使用的 custom 目录。静态文件安装无需重启服务。

AI 是可选功能：在 Jupyter 服务器上安装并登录 Codex CLI，确保 `codex app-server` 可用。默认使用其模型配置，或在安装时指定 `--model MODEL_ID`；`LIVE_DECK_MODEL` 环境变量优先级更高。无需在演示 JSON 或前端写入凭证。未配置 AI 时仍可使用幻灯片、终端和图表。

演示命令以 Jupyter 用户身份运行；“填入终端”不发送回车。向 AI 提问会把所显示的上下文（包括近期终端输出）发送到所配置的模型服务，提问前可点击“查看将发送的面板上下文”。仅在可信的 Jupyter 会话中使用，并保留 Jupyter 登录保护。

仓库内置的默认演示是安装模板，`{{LIVE_DECK_ROOT}}`、`{{LIVE_DECK_WORKSPACES}}` 和 `{{LIVE_DECK_URL}}` 由安装器替换；它们不是 Live Deck v1 通用格式字段。安装后可直接导出完整文稿。`minimal` 与 `tabs` 示例无需路径替换；分屏示例的 `grafana.example.com` 需替换为自己的图表 URL，监控示例自带本地参数预览。

## 编写文稿

格式已整理为 **Live Deck v1**：

- [网页编写规范](web/docs/AUTHORING.md)
- [给其他 AI 的生成提示词](web/docs/AI-PROMPT.md)
- [完整字段与行为契约](web/docs/AUTHORING.md)
- [JSON Schema](web/live-deck.schema.json)
- [最小完整文件](web/examples/minimal.livedeck.json)与[分屏完整文件](web/examples/multi-panel.livedeck.json)

`node scripts/validate-deck.mjs 文稿.livedeck.json` 使用与播放器相同的格式/引用校验，不执行文稿里的命令。

## 使用

上下工具栏默认收起。点击页面顶部边缘“顶部工具”展开编辑、导出、重置和全屏入口；点击底部边缘“底部翻页”展开页码和翻页按钮。两条工具栏独立控制，各自的收起按钮位于对应工具栏与内容区的交界处。翻页保留该选择，重新打开或刷新页面恢复收起状态；不会新增浏览器存储记录。页面获得焦点时仍可用方向键翻页。

终端页顶部只保留一行操作栏：计划定位、可编辑命令、填入终端 / 打开图表、完成本步。“计划”定位下一项候选，“填入终端”发送输入框中的文本，仍需回车执行；“完成本步”只推进计划。上一步、跳过、分屏布局和候选详情位于“更多”菜单，打开菜单不占用终端高度。

- 第 1 页：普通幻灯片。
- 第 2 页：Terminal 1，附带 50 条示例命令和说明；数量可以继续增加。
- 第 3 页：普通幻灯片。
- 第 4 页：复用第 2 页的 Terminal 1，包括 Shell、变量、进程、输出、清单进度和 AI 对话。
- 第 5 页：Terminal 2，使用独立 Shell 和初始工作目录。

点击计划中的命令后可以编辑；“填入终端”只发送文本，回车仍由演示者执行。填入不会清空已有输入；建议在空的 Shell 提示符处使用。该按钮仅支持单行命令；多行代码和交互程序可以直接在终端输入。完成状态由演示者手动标记，不代表程序已成功执行。

右上角“编辑演示”修改 JSON，“导出”保存可复用文件。编辑保存的是当前浏览器中的演示副本；不会默默覆盖服务器的 `web/deck.json`。将导出文件放回 `web/deck.json` 可更换默认演示。同一个演示 ID 和终端 ID 会恢复同一个 Jupyter 终端；需要重建当前 tab 时，点击“重启”；需要为另一份演示创建独立的一组会话时，可更换演示的 `id`。

重新排练时，点击顶部“重置进度”：关闭整份文稿的全部临时 tab，重启全部固定 tab（包括其他页和刷新后尚未连接的会话），清空终端输出与运行信息；随后重置总顺序、候选选中项、完成/跳过标记、命令草稿和搜索，并回到第一页。临时 tab 的名称和计划引用保留，重新打开时创建新 Shell。重置期间禁用重复操作和终端输入；个别失败不会阻止其他 tab 处理，错误会显示并允许重试。文稿、AI 对话、图表设置保留，不自动执行演示命令或清理磁盘文件。

终端页支持直接输入，其他页可用方向键翻页。终端或输入框获得焦点时，点击页面底部边缘“底部翻页”后使用翻页按钮。终端实例只创建一次，切页时不会移除 iframe。终端面板标题栏的“重连”只重新连接当前终端，并重新加载显示；仍存在的 Shell、变量和运行进程会保留，演示进度、其他面板和全屏状态也会保留。连接期间按钮显示“连接中…”，失败或超时后可再次点击。若 Jupyter 服务重启、终端退出或被平台清理，重连会创建同名新 Shell，原 Shell 状态无法恢复。浏览器整页刷新也可以重新连接。两个终端是独立进程，不是容器；同一主机的文件系统仍然共享。

终端、图表和 AI 面板都有“全屏”按钮，占满整个浏览器内容区域，同时保留退出按钮；终端与图表全屏时暂时收起候选池。点击“退出全屏”恢复分屏，原连接和运行进程继续保留。外层页面获得焦点时也可按 Esc 退出；焦点在终端或跨域图表里时，使用面板的退出按钮。顶部全屏按钮另可隐藏浏览器工具栏。

## 多面板与跨面板演示顺序

在播放器右上角打开“分屏示例”。它和原演示使用不同的浏览器编辑副本、演示 ID，不会覆盖原演示。顶部也有“分屏示例”入口。

- `workspace` 页的 `panels` 引用终端或图表 ID。同一 ID 的 Shell、连接、候选池进度和图表 URL 跨页复用。可以放三个真正的终端，也可以将一个位置换成图表。
- 每个面板都有自己的候选池与搜索，默认折叠，点击面板标题栏的“候选”独立展开或收起。选中命令、定位下一步、切换监控组或翻页都不会自动展开候选；手动选择保留到本次页面刷新。候选清单按页显示，不设固定条数上限。页数和总演示步骤也不设固定上限，实际容量取决于浏览器内存和本地存储。每页显示 30 / 40 条只是渲染分页。
- 监控组选择、整组跟随和时间范围控件位于工作区标题行，在当前面板连接状态左边，不再单独占一行。
- `sequence` 明确关联各池的动作。顶部和对应面板高亮下一步；“完成本步”推进计划并选中下一动作，“更多”中的“跳过计划本步”和“计划上一步”可调整顺序。临时选其他候选不会改变总顺序，点击操作栏左侧“计划”返回。标记完成不会发送命令，也不意味着进程已结束或成功。
- 运行命令、日志 `tail -F` 和图表可以同时保持打开。正在运行交互程序的终端需先返回 Shell 提示符，再填入新的 Shell 命令。
- 通过“更多”中的布局选择器切换“并排”“主屏 + 侧屏”“上下”。“候选详情”展开当前池的说明和逐条完成控制。
- Grafana 使用真实网页 iframe，候选动作是看板 / 单 panel 的 URL。建议用 Grafana 的 Share / Embed 单图链接，带 `from=now-15m&to=now&refresh=10s`。示例 HG 看板需要用户自己的 Grafana 浏览器登录，点击“新窗登录 / 打开”登录后刷新图表。若目标站点拒绝 iframe，使用新窗口并排；本工具不修改 Grafana 的认证或响应头。

最小关联示例（加入现有演示 JSON；`runner`、`logs` 定义在 `terminals`，`metrics` 定义在 `dashboards`）：

```json
{
  "slides": [
    {"type": "workspace", "title": "运行与观察", "panels": ["runner", "metrics", "logs"], "layout": "columns"}
  ],
  "sequence": [
    {"panel": "runner", "command": "prepare"},
    {"panel": "logs", "command": "follow"},
    {"panel": "runner", "command": "run"},
    {"panel": "metrics", "command": "recent"}
  ]
}
```

候选项例如 `{"id":"run","title":"启动任务","command":"python3 demo.py"}`。图表候选的 `command` 是完整 HTTP(S) URL。优先使用稳定命令 `id` 建立顺序；也接受从 0 开始的数组下标。编辑关联顺序会重置总进度，重新排序候选而保持 `id` 不变仍能正确解析关联。

## AI

展开下方 AI 面板即可提问。每次请求带上当前面板、选中步骤、附近命令、总演示顺序和同屏各终端的近期输出。当前终端历史在后端最多取 40,000 字符；其他同屏历史共享预算，计划优先提供当前选中位置附近的内容，支持选中第 10,000 条等较后位置。对话仍按面板独立保存。上下文有长度预算，不限制演示文件容量。“查看将发送的面板上下文”可查看浏览器提供的原始上下文（后端还会截取）。Grafana 面板提供 URL，不自动读取跨站图表中的指标值。

分析摘要和回答正文会随模型生成逐步显示，摘要可折叠。摘要是给观众阅读的简短依据说明；如果模型提供公开推理摘要，则显示为“推理摘要”，不会展示内部原始推理。连接中断时保留已收到的内容并显示错误。建议命令在回答完成后出现，“采用”只填入对应面板的编辑框，由演示者决定是否填入终端和执行。

建议操作数量按问题需要决定，可以是零条，不要求凑成三条，也不再截取前五条。每条旁边直接显示名称、用途和预期观察结果；存在前置条件或副作用时由 AI 一并说明。“采用”只取命令或图表链接，不包含旁边的注释。旧对话没有详细注释时，仍会显示原来的建议标题。

AI 面板标题栏的“新对话”会清空当前选中面板的 AI 聊天记录，并保存到当前浏览器；其他面板对话、演示进度、命令草稿和终端状态保留。下一次提问不带旧聊天记录，仍会读取当前终端历史、演示计划和同屏上下文。每次请求使用独立的临时 Codex thread，因此无需重启 Jupyter kernel。回答生成期间该按钮暂不可用，完成或报错后恢复。

AI 通过现有 Jupyter API 按需创建一个专用 Python kernel，在服务器调用 `codex app-server --listen stdio://`，模型读取使用者的 Codex 配置，也可用 `LIVE_DECK_MODEL` 或安装时的 `--model` 覆盖。适配器将增量事件传回浏览器，支持模型公开摘要和结构化回答中的分析摘要。它读取用户现有 Codex 认证与模型配置；凭证不会传到前端。使用 read-only sandbox，关闭已配置的 MCP 服务、Shell 工具、历史记忆和仓库指令加载；终端历史作为数据提供给模型。AI 不直接操作终端。

代码不读取 Bridge 配置、不调用 Bridge API，也不依赖 Bridge 进程存活。AI kernel 的 ID 保存在当前浏览器，可在 Jupyter 的 Running 面板中管理。

## 配置格式

```json
{
  "id": "my-demo",
  "title": "我的演示",
  "terminals": {
    "terminal-1": {
      "label": "Terminal 1",
      "cwd": "/absolute/path/to/demo",
      "commands": [
        {"title": "查看目录", "command": "pwd", "note": "先确认运行位置"}
      ]
    }
  },
  "slides": [
    {"type": "slide", "title": "开始", "markdown": "普通 **Markdown** 内容"},
    {"type": "terminal", "title": "演示", "terminal": "terminal-1"},
    {"type": "slide", "title": "解释结果", "markdown": "讲解内容"},
    {"type": "terminal", "title": "继续", "terminal": "terminal-1"}
  ]
}
```

## 代码结构

```text
web/
  index.html, style.css  页面结构与样式
  deck.json             默认幻灯片和命令清单
  deployment.json       安装时生成的部署信息（不提交）
  src/model.js          配置校验、会话标识、进度状态和跨面板顺序
  src/workspace.js      常驻多面板、图表导航、同屏上下文
  src/runbook.js        候选池分页和搜索
  src/jupyter.js        Jupyter HTTP API
  src/terminals.js      终端实例池、输入和历史
  src/advisor.js        Jupyter kernel 通信
  src/conversation.js   流式对话状态、摘要与正文渲染
  src/app.js            页面与交互编排
  vendor/               固定版本依赖与许可证
backend/
  advisor.py            标准 Codex CLI 适配器
  codex_stream.py       app-server 事件解析与公开文本流
  advisor_schema.json   AI 响应格式
install_local.py        复制静态文件并生成本机示例配置
tests/                  配置、隔离、浏览器与实际 AI 验证
```

无前端构建步骤、无运行时 CDN 请求。依赖固定为 Reveal.js 5.2.1、Marked 15.0.12、DOMPurify 3.2.6，源地址和 SHA256 保存在 `web/vendor/manifest.json`。

安装会复制 `web/` 到 Jupyter 配置目录下的 `custom/live-deck`，生成部署信息，并将示例中的路径占位符替换为本机路径。示例工作目录默认在 `~/.local/share/live-deck/workspaces`，可用 `--workspace-dir` 修改。再次运行会更新此前由 Live Deck 安装的静态文件；未知目录或符号链接会拒绝覆盖。源代码目录需保留，以供 AI 后端与监控示例使用。

## 验证

`npm test` 运行状态隔离与配置测试。`tests/browser-smoke.mjs` 使用当前机器已有的 Playwright / Chromium，对真实 Jupyter 运行完整浏览器检查，包含真实 Shell、跨页共享、终端隔离、AI 读取实际历史、采用建议和刷新后恢复。浏览器测试使用单独的演示 ID，不触碰用户其他终端。截图和结果放在 `artifacts/`。

浏览器测试前使用 `npm ci` 安装开发依赖，设置 `LIVE_DECK_SERVER_INFO` 为当前 Jupyter runtime JSON 文件。可通过 `LIVE_DECK_BROWSER_EXECUTABLE` 指定本机 Chromium，通过 `LIVE_DECK_TEST_BASE_URL` 指定对外 Jupyter 地址。已有 Playwright 安装也可用 `LIVE_DECK_PLAYWRIGHT_PATH` 指向其模块目录；这些设置仅用于测试，不参与应用运行。

此仓库按源码部署，不是 JupyterLab 扩展包。

多面板验证：`node tests/browser-multipanel.mjs` 使用同样的浏览器环境变量，覆盖真实并发输出、日志跟随、跨页连接保留、10,000 条候选搜索、跨面板顺序、跨终端 AI 上下文与刷新恢复。`python3 -m unittest discover -s tests -p "test_*.py"` 验证 AI 上下文预算。

AI 流式与全屏验证：`node tests/browser-ai-stream.mjs` 使用同样的浏览器环境变量，验证真实模型在完成前显示摘要与正文、采用命令不执行、中断保留内容，以及终端、图表和 AI 面板占满浏览器视口且保留原会话。Python 测试还覆盖 app-server 事件解析、增量 JSON 字符串、公开摘要过滤及超时清理。


## 动态运行上下文与监控组

在播放器右上角打开“监控联动示例”。示例左侧运行真实进程，右侧为明确标注的 URL 参数预览；接入真实 Grafana 时替换单图 URL 和变量映射。

已支持运行期间报告主机/任务/时间、多个 Dashboard 单图绑定、监控组与 sequence 关联、暂停跟随、手动参数、统一时间和单图全屏。运行工具在 `backend/run_context.py`；它使用终端事件，不依赖后台 Bridge 服务。详见 [监控编写规范](web/docs/MONITORING.md) 和 [完整示例](web/examples/monitoring.livedeck.json)。

主要模块：`runtime.js` 管理事件、上下文和 URL 绑定，`workspace.js` 管理图表生命周期与布局，`run_context.py` 是供任意启动脚本调用的标准库工具。浏览器离线时只依赖 Jupyter 有限输出回放，不承诺持久事件投递。

验证：`npm test`、`python -m unittest discover -s tests -p "test_*.py"`；`tests/browser-monitoring.mjs` 使用真实 Jupyter 终端和受控跨域图表接收端验证运行中联动、隔离、暂停、切组、放大、时间范围和刷新。设置 `LIVE_DECK_TEST_ARTIFACTS` 可以指定仓库外的测试结果目录。

## 终端 tabs 与填入目标

每个终端面板都有 tab 栏。“＋”新增独立 Shell；双击 tab 名称可重命名。切换 tab、切页或全屏不会移除已有 iframe，也不会结束后台 tab 的进程。“重连”保留当前 tab 的 Shell；“重启”结束旧 Shell 后新建，清空输出、变量和运行信息，保留 tab 名称和计划引用，其他 tab 不受影响。新 tab 默认继承面板的初始 cwd，不继承其他 Shell 的变量、SSH 会话或当前目录。

命令栏左侧选择填入目标。若当前候选对应计划本步，选择保存在该 sequence 步骤；否则保存在该候选命令。点击“填入终端”先显示目标 tab，等待连接就绪、调整显示尺寸，再输入命令并聚焦；不会追加回车。连接期间手动切换 tab 或离开终端页会取消本次填入。

新增 tab、名称与目标设置保存在当前浏览器的文稿副本，并包含在“导出”文件内。重置进度保留 tab 定义和目标设置，但关闭全部临时 tab、重启全部固定 tab。已有文稿无需修改，省略 tab 的命令进入 main（默认名 Tab 1），其终端名称与旧版本相同。

```json
{
  "terminals": {
    "host": {
      "label": "HOST",
      "tabs": {"main": {"label": "前台"}, "background": {"label": "后台"}},
      "commands": [{"id": "serve", "title": "启动服务", "command": "npm run dev", "tab": "background"}]
    }
  },
  "sequence": [{"panel": "host", "command": "serve", "tab": "background"}]
}
```

`terminals.<id>.tabs` 为可选对象；key 使用与终端 ID 相同的规则；每项可指定 label、cwd。main 始终存在。目标优先级为 sequence.tab → command.tab → main；同一命令可在不同计划步骤发到不同 tab。图表动作与监控组步骤不接受 tab。运行信息按 tab 隔离；图表 `binding.tab` 可指定数据来自哪个 tab，省略时跟随 main。AI 面板上下文包含各 tab 的标签、历史及运行信息。此扩展需要支持 tabs 的播放器；旧播放器不能保证将命令发到指定 tab。

### 固定 tab 与临时 tab

PPT JSON 中 `terminals.<id>.tabs` 声明的 tab 都是固定 tab，不提供关闭按钮；默认 main 也是固定 tab。点击“＋”新增的是临时 tab，名称旁显示“×”。临时身份保存在浏览器中，刷新后仍可关闭，不写入 PPT JSON 格式。

关闭临时 tab 时会提示确认，然后结束该 tab 的 Shell 连接并从 tab 栏收起；其他 tab 保持原会话。临时 tab 的名称和已有计划引用保留，可从“重新打开…”恢复；计划再次向它填入时，也会先建立新 Shell。关闭失败会保留 tab，便于重试；关闭期间不会继续填入或重新创建该终端。

“导出”包含当前所有 tab 的定义。将导出文件作为文稿导入或通过 JSON 编辑器保存后，其中声明的 tab 都变为固定 tab。固定与临时身份按浏览器保存的来源记录恢复；已保存为临时的 tab 刷新后仍可关闭。没有临时来源记录的 tab 按固定 tab 处理。

完整命名与引用示例见 [tabs.livedeck.json](web/examples/tabs.livedeck.json)。

终端重启验证：`node tests/browser-terminal-restart.mjs` 使用同样的 Jupyter/Chromium 环境变量，并要求 `LIVE_DECK_TEST_ARTIFACTS` 指向仓库外的结果目录。可用 `LIVE_DECK_TEST_PAGE` 指定播放器入口。测试创建独立文稿和终端，检查旧 Shell 与前台进程退出、重连保留状态、重启隔离、关闭失败、并发点击和翻页/刷新恢复，结束后只删除本次测试终端。
