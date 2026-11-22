# AI 控制侧栏候选版本验收

先使用以下夹具跑通一轮下载、对话预览、重开历史、再次引用和定向上传，再验收故障恢复与窄侧栏操作。将每项结果填入任务书的 U1–U9。[分阶段实施任务书](ai-control-interaction-rollout.md)

## Windows 候选包

以下候选包早于移除「绑定当前页」的改动。验证自动选择浏览器请使用当前源码生成态。原候选包为 `appbuild/AI-FREE Setup 2.6.53 Interaction RC.exe`。构建完成时间为 2026 年 11 月 21 日 13:45（北京时间），安装包 SHA-256 为 `1DBE2C581D1A2662E8606A05D9DB6732D4910620D8DFC381201D6241694EBD4B`。需要区分同版本号的其他构建时，以此摘要为准。

## 启动与隔离

在仓库根目录开启一个独立 PowerShell 窗口，保持前台运行：

```powershell
node test/acceptance/fixtures/ai-control-interaction/server.js
```

终端输出一行 JSON，端口由系统分配并只绑定 `127.0.0.1`。直接打开 `urls.a`、`urls.b`、`urls.c`，保留输出中的主机名。在第二个 PowerShell 窗口粘贴实际 JSON 替换占位符。

```powershell
$fixture = '<实际输出的 JSON>' | ConvertFrom-Json
$fixture.urls | Format-List
Invoke-RestMethod -Uri $fixture.urls.state
```

`root` 是本次专用系统临时目录；`userData` 初始为空，`workspace` 是 `desktop/AI-Workspace`。工作区已预置 `source-red/sample.png`（红色方块）、`source-blue/sample.png`（蓝色条纹）和命令夹具。`files.red`、`files.blue` 分别给出绝对路径、图片路由和 SHA-256。夹具不修改实际桌面、浏览器配置或账号，也不会把这些路径自动赋给正在运行的应用。

使用真实开发态侧栏的自动验收宿主应在 Electron 启动应用前，将 `userData` 和 `sessionData` 都设到夹具的 `userData`，将 `desktop` 设到夹具的 `desktop`，再在该实例中新建无代理、未登录的测试 Profile。不要把真实用户目录传给宿主，也不要让确定性测试连接公网模型；由阶段验收宿主注入本地模型替身或固定工具序列。验证安装候选版时，应在同一台隔离虚拟机或一次性系统账户内运行候选版和本服务，不与日常应用、桌面工作区或浏览器 Profile 共用。仅体验 A/B/C 与 HTTP 行为时，无需启动 AI-FREE。

## 页面与核验

| 入口 | 可见目标与操作 |
| --- | --- |
| `urls.a` | **A - Source**。`#source-red` 与 `#source-blue` 是两张图片；源 URL 不同，末尾文件名都为 `sample.png`，可点击对应 Download，也可观察图片后用 `browser_file download_element`。下载到不同工作区子目录以避免覆盖预置文件。 |
| `urls.b` | **B - Upload target**。`#fixture-file` 是文件控件；文件选中并记账后 `#selection-status` 显示 `selected`。点击 `#fixture-submit` 后才会增加服务端接收次数；正常回执使 `#receipt-status` 显示 `confirmed`。 |
| `urls.c` | **C - Distractor**。控件选择器与 B 相同，但状态完全独立。应当操作 B 时，C 的 `selectionCount` 和 `receivedCount` 都应为 0。 |
| `urls.dropOnce` | 仍是 B，页面显示 `drop-once`。重置后第一次提交先递增 B 的接收次数并记录文件摘要，随后截断回执正文。等待 `#receipt-status` 为 `unknown`，点 `#fixture-read` 或请求 `urls.state`；确认 B 只接收一次且 SHA-256 正确，不要重复提交。 |

读回后查看 `#readback-status`（`verified`）、`#selection-count`、`#received-count`、`#received-name`、`#received-sha256` 与 `#dropped-receipts`。在丢回执用例中，读回不改写原始回执状态；仍显示 `unknown`，以便区分「当时没有回执」和「之后已核验」。故障响应已发出 HTTP 标头，读取 JSON 正文会失败；这避免 Chromium 在收到任何响应之前自动重发 POST。主动重复提交不会被夹具去重，计数会变成 2，便于捕捉错误重放。

用工具验收时，先观察目标并用 `browser_file upload` 填充 `#fixture-file`，等待 `selected`。再单独触发 `#fixture-submit` 并等待站点回执。手工验证夹具时可直接用浏览器的文件选择。`drop-once` 的故障点位于站点的 HTTP 回执正文。

每项独立用例开始前，等页面上的操作结束，然后清零并重载 B/C，避免继续使用上次 DOM 中选中的文件：

```powershell
Invoke-RestMethod -Method Post -Uri $fixture.urls.reset -Headers @{ Origin = $fixture.origin }
Invoke-RestMethod -Uri $fixture.urls.state
```

`GET /state` 返回 `{ b, c }`，每端有 `selectionCount`、`receivedCount`、`lastSelected`、`lastReceived`、`droppedReceipts`。最后两份文件记录均为 `{ name, size, sha256 }` 或 `null`；摘要由服务器对请求字节计算，不使用客户端自报值。服务器不落盘保存上传内容。自动化可以直接用 `POST /b/select`、`POST /b/submit`（C 同理），请求体为文件原始字节，带 `X-Fixture-Filename`（URI 编码的 basename）和 `Origin`（描述符的 `origin`）；B 故障提交用 `/b/submit?mode=drop-once`。请求上限为 1 MiB。请求级测试不能替代浏览器中的控件操作。

## 配置本地验收模型

从侧栏的模型菜单选择「添加自定义模型」。输入显示名称 `AI-FREE 本地验收`，API 地址用 `$fixture.urls.model`，API Key 用 `$fixture.model.apiKey`，模型名称用 `$fixture.model.id`。勾选「支持图片输入（image_url）」，保存并选用该模型。测试 Key 是夹具占位值。测试页面和模型服务都在 `127.0.0.1`，若系统启用了 HTTP 代理，应让回环请求直连。首次发送 `QA ATTACH` 前先附加一份测试 PNG，并确认回复中的相对路径和图片名称。

| 侧栏输入 | 执行条件和结果 |
| --- | --- |
| `QA ATTACH` | 使用 `@` 附加恰好一张测试 PNG。回复识别到的文件路径和图案。 |
| `QA DOWNLOAD RED` 或 `QA DOWNLOAD BLUE` | 将 A 设为活动页。观察指定 PNG 并通过浏览器工具下载到 `qa-download-red` 或 `qa-download-blue`。 |
| `QA SELECT B` | 再次引用下载卡或附加恰好一张测试 PNG。让 B 或 `dropOnce` 页保持活动，图片应直接交给文件控件。 |
| `QA OBSERVE B` | 让 B 或 `dropOnce` 页保持活动，只读观察页面显示的回执和计数。可以在点 Readback 后运行。 |
| `QA COMMAND` | 执行延时命令。分别让它自然退出和运行中停止。 |
| `QA COMMAND TIMEOUT` 或 `QA COMMAND TRUNCATE` | 观察超时或截断提示。 |

## 人工验收顺序

1. 在隔离的 Windows 测试账户或虚拟机运行候选版和夹具。将夹具工作区里的 `source-red`、`source-blue`、`command` 复制到该测试账户实际使用的桌面 `AI-Workspace`。在侧栏文件选择器确认能搜到两份 `sample.png`，再按上文配置本地验收模型。在测试账户实际工作区查看命令的 `command/completed.marker`。
2. 创建一个无代理的测试浏览器环境，在同一环境打开 A、B、C。切到夹具要求的活动标签后直接发消息。AI 按本轮任务选择浏览器。多环境验收时在消息中说明目标浏览器或网站。
3. U1–U4 先检验同名选择和移除，再在 A 下载红图，用对话文件卡预览。重开应用后从原历史点「再次引用」。转到 B，发起选择文件并核对 PNG 直接选中。B 显示 `selected` 后，手动点 Submit，随后 Readback。核对 B 的 `receivedCount` 为 1、摘要等于 `files.red.sha256`，C 两个计数均为 0。
4. U5 重新开始一轮 B 上传，选择测试文本文件触发确认，在等待期间切到 C，另测关闭 B 或关闭显式选中的浏览器环境。继续后检查 C 无记录。U6 在测试工作区移动下载的文件，再用蓝图替换下载路径，分别重开对话尝试预览和引用。
5. U7 用下述命令夹具检查输出、退出、截断和停止。U8 先取消一次测试文本文件的上传确认，在 B/C 核对计数，再用 `urls.dropOnce` 完成一次选择和提交。回执显示 `unknown` 后用 Readback 核对 B 的文件摘要和接收次数。浏览器工具回执丢失由下列 Electron 回归注入，也可切到另一个标签验证目标不可读时的处理。
6. U9 缩窄侧栏，展开或收起调用详情，用键盘选择文件并打开旧历史。在普通模式回到首页确认左侧没有「MCP 管理」。逐项记录结果和实际看到的状态。

主进程在本轮第一次识别目标后校验文档身份。同网址刷新会使当前工具序列的旧目标失效。新一轮自动读取活动页。选择上传文件只确认文件控件已接到数据。网站收件用业务回执和夹具的文件摘要核对。

## 命令夹具

需要 `node` 在被测 shell 的 `PATH` 中。命令写标记由延时子进程完成，不依赖任何系统账户或网络。首次直接验证可在第二个 PowerShell 窗口执行：

```powershell
node $fixture.command --delay-ms 6000 --output-bytes 80000
Get-Content -LiteralPath $fixture.commandMarker
```

通过 AI 侧栏验收时，让确定性工具序列调用 `run_command`，工作目录 `command`，命令为 `node delayed-command.js --delay-ms 6000`。开始后会输出 `fixture: start`、子进程 PID，稍后 stderr 输出 `fixture: progress`；成功时子进程创建 `completed.marker`，父进程输出 `fixture: complete`。每次重复前，在前一次运行完全退出后只清除这一标记：

```powershell
if (Test-Path -LiteralPath $fixture.commandMarker) { Remove-Item -LiteralPath $fixture.commandMarker }
```

正常运行用 `timeout_ms: 15000`。超时测试用 `timeout_ms: 1000`。截断测试加 `--output-bytes 80000` 并使用正常超时。停止测试应在 `fixture: complete` 前触发停止，至少等满 6 秒后用 `Test-Path -LiteralPath $fixture.commandMarker` 确认没有晚到的写入，并用 `Get-Process -Id <夹具输出的子进程PID> -ErrorAction SilentlyContinue` 确认该夹具子进程不存在。复测前必须确认上一次已退出，不能以「停止 AI」提示代替这个检查。

## 自动测试

只运行本组 Node 测试，不启动 Electron，也不依赖 `.generated/app`：

```powershell
node --test test/acceptance/fixtures/ai-control-interaction/fixture.test.js
```

仓库已提供 `resources/chromium/ai-free-browser.exe` 时，可直接验证真实 Chromium Fork 的网页行为。测试使用 Playwright 操作三个页面，校验 PNG 解码、B 丢回执后只接收一次、读回匹配摘要以及 C 无操作。

```powershell
node --test test/acceptance/fixtures/ai-control-interaction/browser-smoke.js
```

先生成运行资源，再运行真实 Electron 侧栏测试。

```powershell
npm run prepare:source
node --test test/acceptance/fixtures/ai-control-interaction/electron-sidebar.test.js
```

| 入口 | 覆盖范围 |
| --- | --- |
| `fixture.test.js` | 回环 HTTP、同名 PNG、B/C 独立统计、截断回执、延时命令和临时目录清理。 |
| `browser-smoke.js` | 真实 Chromium Fork 中的 A/B/C DOM、文件选择、站点提交和读回。Playwright 直接操控测试网页。 |
| `native-model-smoke.js` | 自定义 API、真实 Chromium Bridge、普通拖拽、一次调用执行 10 个混合页面步骤并读回草稿、真实素材下载和上传选择，使用夹具模型。 |
| `electron-sidebar.test.js` | 从 `.generated/app` 加载实际侧栏和 preload，使用生产 IPC 注册、聊天服务、工作区预览及磁盘历史仓库。模型返回固定工具序列，浏览器工具由桥接替身返回。 |
| `npm run accept:chromium-phase3 -- --page-binding-only` | 真实内核验证同 URL 重载失效、等待和下载的页面保护、上传点击期间切页，以及工作区原文件被替换后网页仍读取已确认字节。 |
| U1–U9 | 在候选版本上由用户操作，记录实际结果。 |

常规 Electron 夹具覆盖直接发送任务、自动识别页、对话中查看 PNG、关闭并重启 Electron 后通过历史菜单恢复和再次引用、取消文本上传、批准中目标身份变更、PNG 免确认选择以及丢失工具结果后停止重放。页面令牌由桥接替身提供。实际内核是否正确签发、保留和作废令牌，须在具备对应能力的内核上验证。站点处理后丢失 HTTP 回执的场景由 `browser-smoke.js` 实测，Electron 测试中的传输故障由桥接替身注入。

混合批处理验收可在 `urls.editor` 发送 `QA PREVIEW DRAFT`。预期观察并接管后，侧栏用一条 `browser_page_batch` 执行 10 步（点击、表单输入、按键、条件等待），显示 `10/10 步`；最后读回网页上的 `Accepted: First draft!`。刷新后再复测。单笔画圆仍是独立的浏览器输入回归，不是批处理的触发条件。

批处理只接收同一页面中参数已知的 `browser_action` 和 `browser_wait`（条件等待），每批 1–50 步，单步等待或动作超时参数不超过 10 秒；60 秒后不再发起新步骤，已发出的操作仍需等待结果。需要模型判断新页面、确认敏感操作或处理文件等任务时，在该步前结束本批，再使用原有工具。失败或停止不回滚已完成步骤，不续跑，不重放；同轮剩余调用会标记为未执行。在执行中插入新消息时，等待当前步骤返回，在下一步前中止原计划；想立即停止等待应点击停止。检查 `completed`、`failedStepOutcome` 和 `notAttempted`，对未知结果先读回页面。文档不变也不代表 UI 布局不变：布局会变的步骤应使用稳定选择器和条件等待，不能沿用可能漂移的坐标。

## 候选包验证记录

- `npm run verify` 通过，常规测试和覆盖率复跑各通过 960 项。`npm run guardrails`、`npm run test:acceptance` 和 `npm run check:packaged-runtime` 通过。源码、生成态和最终安装包对应的解包运行态均通过页面入口检查。
- 本地夹具、真实 Chromium 回执丢失测试和 Electron 侧栏测试合计 13 项通过。`node test/acceptance/fixtures/ai-control-interaction/native-model-smoke.js` 在同一内核上连续复测通过。此前一轮素材落盘曾返回 `ENOENT`，原因尚未复现。请保留 U2 下载失败时的工具错误和目标文件名。
- 真实内核页面绑定专项通过。完整 `npm run accept:chromium-phase3` 已通过自定义 UA Client Hints 检查，随后停在定位断言。测试站点未取得预期纬度 `31.23`。此项环境能力仍有回归风险。
- 浏览器可能在网页选中文件后才读取内容。候选版保留已按摘要验证的上传副本直至目标 Chromium 进程退出，每个浏览器累计最多 128 个文件或 1 GiB。文件选择结果未知时只观察原目标页一次。若页面状态无法对应到本次操作，由用户判断，当前轮就此结束。

U1–U9 的结论以用户的实际操作为准。阶段 5 的 Skill 和项目规则支持单独确认。

### 2026 年 11 月 21 日自动选择页面复测

- 真实 Chromium 和本地夹具模型复现观察后同地址刷新。接管阶段返回 `BROWSER_TARGET_CHANGED`，本轮未产生下载卡。下一轮直接发送同一指令，程序自动识别当前页，下载红图并核对产物 SHA-256。
- Electron 侧栏与真实 Chromium 的隔离测试验证了同地址刷新、当前操作停止、新一轮直接下载和对话文件卡 PNG 预览。侧栏历史恢复和再次引用由常规 Electron 夹具验证。侧栏用例等待「发送消息」恢复后才开始新一轮，避免流式收尾时触发「插入当前对话」。

```powershell
npm run prepare:source
$env:AI_FREE_ACCEPT_NATIVE_SIDEBAR = '1'
try { node --test test/acceptance/fixtures/ai-control-interaction/electron-sidebar.test.js }
finally { Remove-Item Env:AI_FREE_ACCEPT_NATIVE_SIDEBAR }
```

- 日常开发实例的外部 MCP 在「次元小镇」活动页成功观察并按元素下载 `dimtown-illustration-165038-acceptance.webp`。工作区读回 199076 字节，解码尺寸 950 × 1773，SHA-256 与工具回执一致。该记录验证的是外部 MCP 下载。

## 清理

后续验收脚本可 `require('./server')`（路径按调用者位置调整）并 `await startFixture()`；优先注册 `t.after(() => fixture.close())`，或在 `finally` 中 `await fixture.close()`。先关闭使用 `userData` 的 Chromium/Electron 进程，再关闭夹具。`close()` 可重复调用，会关闭监听并仅删除本次创建的临时目录。

手工运行时，先结束测试命令、关闭测试标签与测试应用，再对服务的前台终端按 `Ctrl+C`。检查 `Test-Path -LiteralPath $fixture.root` 返回 `False`，再次访问 `urls.state` 应连接失败。强杀进程或断电不会触发清理；如有残留，先关闭仍使用它的测试进程，在文件资源管理器核对描述符中完整的 `root` 确为本次 `ai-free-interaction-*` 临时目录后，仅删除该目录。重置接口不会删除工作区文件，测试中的移动、替换和额外下载须手动恢复，或停止服务后重启领取干净夹具。
