# AI-FREE MCP 工具清单

实际目录随浏览器连接、软件功能和入口变化。Chromium 已连接且本机账号工具可用时，外部与侧栏各列出最多 16 项（侧栏具备父会话且包含环境配置意图时）。两端的完整对照、差异和验收顺序见 [MCP 双入口一致性审计与计划](mcp-entry-parity.md)。

开发者模式下打开 **首页 → MCP 管理** 可查看当前目录、连接条件、JSON Schema、示例提示词及 JSON-RPC 请求和模拟返回。查看示例不会调用工具、读取会话或展示实际模型 Prompt。AI 对话不再受旧的累计 MCP 调用次数设置限制；停止、超时和单批异常请求保护保留。

## 总览

| 工具组 | 数量 | 可用条件 | 代码真源 |
| --- | ---: | --- | --- |
| 外部软件栏目 | 1 | 软件运行期间始终可用 | [`ai-browser-window-tools.js`](../src/app/backend/services/ai-browser-window-tools.js) |
| 浏览器高级环境 | 1 | 外部常驻，侧栏随环境/指纹/代理等配置意图注入 | [`ai-browser-window-tools.js`](../src/app/backend/services/ai-browser-window-tools.js) |
| AI 子对话 | 1 | 已登录。本机外部 MCP 和 HeySure 沿用各自的会员与授权条件 | [`managed-chat-contract.js`](../src/app/backend/features/ai-chat/managed-chat-contract.js) |
| AI 工作区命令 | 1 | 软件运行期间始终可用 | [`ai-sandbox-file-tools.js`](../src/app/backend/services/ai-sandbox-file-tools.js) |
| 本机账号 | 1 | 本机账号库可用 | [`provider-account-tools.js`](../src/app/backend/features/account/provider-account-tools.js) |
| 浏览器自动化 | 11 | 页面工具需要已握手的内置 Chromium。两个入口均可离线调用 `browser_control overview`、卡片常规读写和运行记录查询 | [`native-browser-tool-definitions.js`](../src/app/backend/services/native-browser-tool-definitions.js) |

内置和外部入口使用下表中的本地工具名。两个入口均提供 `browser_workflow` 和 `browser_page_batch`。连接 HeySure 后，支持注册的设备工具带 `aifree.` 前缀。设备服务以实际外部目录为输入，注册时转换工具名。

| 本地工具名 | 既有 HeySure 名称示例 | 用途 |
| --- | --- | --- |
| `windows_tab` | `aifree.windows+tab` | 查询、显示、新建、编辑和关闭外部软件栏目 |
| `browser_environment` | `aifree.browser+environment` | 按需读取或增量修改栏目的浏览器环境与指纹 |
| `chat_session` | `aifree.chat+session` | 创建子对话、选择模型、发消息、插话、暂停、继续、等待与取结果 |
| `run_command` | `aifree.run+command` | 在 AI-Workspace 工作目录中执行有界命令行 |
| `manage_card` | `aifree.manage+card` | 管理和运行浏览器自动化卡片 |
| `browser_file` | `aifree.browser+file` | 下载文件、上传本地文件，或保存当前页面 Cookie/Storage |
| `browser_media` | `aifree.browser+media` | 发现并下载当前页面的视频、音频和其它媒体素材 |
| `browser_tab` | `aifree.browser+tab` | 查询、切换、导航、刷新标签页和聚焦浏览器 |
| `browser_observe` | `aifree.browser+observe` | 获取页面中可交互或可见的元素 |
| `browser_screenshot` | `aifree.browser+screenshot` | 截取页面可视区或指定坐标区域 |
| `browser_action` | `aifree.browser+action` | 点击、输入、滚动和发送按键 |
| `browser_wait` | `aifree.browser+wait` | 等待元素、文本或 URL 条件成立，或等待指定时间 |
| `browser_control` | `aifree.browser+control` | 浏览器总览以及页面接管、状态检查和释放 |
| `browser_workflow` | `aifree.browser+workflow` | 执行、暂停、恢复及诊断多步自动化流程 |
| `browser_page_batch` | — | 执行参数已知的同页动作与等待 |
| `account_manage` | `aifree.account+manage` | 按栏目管理本机账号，读取脱敏信息，使用账号引用填写 |

### 按引用批量导入账号

用 `account_manage` 的 `categories` 获取目标 `provider`。调用 `action=import` 时传入该栏目 ID 和 `command`，可选 `directory`（工作区相对目录）和 `shell`（`default`、`cmd`、`powershell`）。AI 根据用户指定的数据来源编写本机转换命令。命令沿用 `run_command` 的权限和工作目录规则，标准输出为 UTF-8 JSON 数组，每项恰含字符串 `email`（邮箱或栏目允许的用户名）和 `password`。

通过字段名、计数或合成示例判断格式。凭据在本机转换和账号库之间传递，命令参数只包含转换逻辑和非敏感路径。标准输出和错误输出均不进入工具回执。每批最多 200 条且标准输出最多 64 KiB，超限可分批。导入失败或在写入前取消时整批不写入。账号库一次加密提交，已有账号自动跳过，回执只包含 `imported` 和 `duplicates`。无需额外确认。

## 外部软件栏目工具

`windows_tab` 不依赖浏览器连接，用于控制 AI-FREE 外部软件栏目的显示与记录。

### `windows_tab`

| `action` | 作用 | 主要参数 |
| --- | --- | --- |
| `list` | 列出全部栏目记录，包括当前未显示的历史栏目 | 无 |
| `open` | 显示、恢复或聚焦已有栏目 | `history_id` 或 `name` |
| `create` | 创建并显示新栏目 | 可选 `name`、`url` |
| `edit` | 编辑栏目名称 | `history_id` 或 `name`；提供 `new_name` |
| `close` | 关闭栏目显示但保留历史记录 | `history_id` 或 `name` |

工具整体标记为破坏性，因为 `create`、`edit` 和 `close` 会改变本地状态；`list` 为只读操作，`open` 只会打开或切换窗口。

### `browser_environment`

`browser_environment` 与常驻的 `windows_tab` 分离，避免普通对话携带整份高级环境 schema。它支持：

- `action=get`：传 `history_id` 或唯一 `name`，返回脱敏后的环境配置。
- `action=update`：传 `history_id` 或唯一 `name` 与 `settings`，按增量语义修改。
- 已打开栏目默认重启 Chromium 立即应用；传 `restart:false` 可只保存。

#### 环境配置

`settings` 使用增量更新语义：只修改本次传入的字段，其他环境配置保持不变。

支持的配置包括：

- 系统和内核：`os`、`browserVersion`、`kernelVersion`。
- 代理：`proxy`，包含模式、协议、主机、端口、用户名、密码和代理 API 地址。
- 页面与身份：`homepage`、`ua`、`secChUa`、`language`、`timezone`、`webrtc`、`geolocation`。
- 设备指纹：`resolution`、`fonts`、`canvas`、`webglImage`、`webglMetadata`、`webgpu`、`audioContext`、`clientRects`、`speechVoices`。
- 硬件与安全：`cpu`、`memory`、`deviceName`、`macAddress`、`doNotTrack`、`sslEnabled`、`portScanProtection`、`hardwareAcceleration`、`launchArgs`。

读取操作返回脱敏配置，其中 Cookie 不返回，代理用户名和密码被替换为 `[REDACTED]`，代理 API 地址和启动参数只标记为已配置。

Cookie 属于登录会话数据，不属于 `browser_environment.settings` 的可编辑字段；应使用 `browser_file` 的 `save_session` 操作在软件本机采集和保存。

## AI 子对话

`chat_session` 使用与侧栏相同的模型目录，所选模型保存到对应子会话。侧栏只在当前父对话下显示其子任务卡片，点击卡片可实时查看消息、状态、模型和用量，返回时恢复父对话草稿和位置。子会话视图为只读，侧栏 IPC 只接受 `models`、`list`、`status`，其余有效动作返回不可重试的 `CHAT_SIDEBAR_READ_ONLY`。委派方的 `chat_session` 工具仍按原权限控制自己的子会话。

1. `{ "action": "models" }` 查询模型 ID。`create` 需要 `model_id` 和 `request_key`，可另外指定 `title`。
2. `send` 需要 `session_id`、`content` 和本次消息的 `request_key`。`select_model` 在会话可编辑时修改本会话的模型。
3. `insert` 需要 `run_id`、`content` 和本次插话的 `request_key`。`stop` 和 `resume` 使用同一个 `run_id`。
4. `status` 接受 `session_id` 或 `run_id`。`wait` 接受 `run_id` 或最多八个 `run_ids`，可一次等待多个子任务。

`send` 和 `wait` 默认最多等待 45 秒。`wait_ms: 0` 立即返回，最长可指定 90 秒。运行仍在进行时返回 `runId` 和 `running`，等待断线后仍可查问同一任务。`sessionId`、`runId` 用于回执展示，请求字段使用 `session_id`、`run_id`。创建、发送和插话可用相同的 `request_key` 与参数重试一次或多次。换用不同参数会返回 `CHAT_REQUEST_CONFLICT`。同一会话一次运行一轮，同一父会话可并发两轮，本机账号最多并发四轮。

子会话由主进程用系统安全存储加密保管。停止与重启恢复保存的模型轮次和工具回执，已完成的步骤直接使用回执。子会话可读取自身此前完成的回复，中断的只读历史查询允许重试。缺少恢复点的中断显示「需核验」。子任务读取自己会话的数据，最深一层。系统加密不可用时会返回明确错误。账户、入口和父会话共同约束可读范围，本机侧栏按当前父会话查询子任务。每个账号最多保管 128 个会话，每个会话最多 32 轮。

内置 AI 从父对话派发浏览器任务时，在 `send` 中填写 `browser_connection`，使用父对话可见的在线连接 ID 或唯一名称。省略此字段时按文本任务运行。该运行绑定一个浏览器实例，同一实例一次运行一个子任务。任务开始前正常接管，结束时释放。在子任务执行期间，父会话应避免操作同一浏览器。本机外部 MCP、HeySure 和卡片维持文本子会话能力。

浏览器子任务使用侧栏的页面操作、观察和文档校验。浏览器实例重启后需重新派发。停止后继续时，已确认的工具回执会保留，待执行的浏览器调用交回模型按当前页面重新规划。已经开始且结果未知的调用会标记为待核验。`completed` 表示模型回复已完成，任务结果以页面状态、业务回执或文件为准。

自动化卡片等待实际结果后才继续执行后续步骤。等待到期时回报 `CHAT_CARD_INCOMPLETE`，可使用 `chat_session status` 查询该次运行。HeySure 使用设备现有任务结果事件，断线未送达的内存回执在重新注册后补发。设备重启后可用同一请求键重新关联已保存的会话或运行。

## AI 工作区命令工具

### `run_command`

- 作用：以 `AI-Workspace` 为工作目录执行命令行，可创建、读取、转换和整理其中的文件。
- 参数：必填 `command`；可选 `shell`、`directory` 和 `timeout_ms`。
- `shell`：可用值为 `default`、`cmd`、`powershell`；默认使用当前平台 shell。
- `directory`：只接受 `AI-Workspace` 内的相对目录，拒绝 `..` 或绝对路径逃逸。
- 限制：默认超时 30 秒，最长 120 秒；标准输出和错误输出各最多返回 64 KiB，超出部分标记为截断。
- 隔离说明：进程使用精简环境变量，并把 HOME/USERPROFILE 指向 `AI-Workspace`；这是工作目录隔离，不是虚拟机或 Windows AppContainer 级系统隔离。

## 浏览器自动化工具

`manage_card` 和 `browser_control overview` 可在没有在线浏览器时发现。页面操作使用已握手的内置 Chromium。外部 MCP 仍执行入口的身份和会员校验。

### `manage_card`

- 作用：通过 MCP 直接发现、读取、创建、编辑、校验、导入导出、删除和执行与首页自动化工作区共享的卡片；不另建 MCP 专用流程格式或执行器。
- `action`：必填。卡片动作包括 `rules`、`list`、`get`、`write`、`patch_step`、`insert_step`、`delete_step`、`move_step`、`delete`、`validate`、`clone`、`versions`、`get_version`、`set_enabled`、`export`、`template`、`restore`、`purge`、`run`；运行控制动作包括 `start_run`、`list_runs`、`get_run`、`list_run_steps`、`cancel_run`、`retry_run`、`pause_run`、`resume_run`、`step_run`。输入 schema 与执行器动作清单共享定义。
- 常用定位参数：`id`、`card_name`。
- 编辑参数：`cardData`、`step_index`、`to_step_index`、`insert_after`、`stepData`、`stepPatch`、`replace`、`metadata`、`version_id`、`enabled`。
- 运行参数：`inputs`、`start_step`、`timeout_seconds`、`idempotency_key`、`run_id`。先 `get` 卡片并按 `item.inputSchema` 的 `required`、`type`、`enum` 组织 `inputs`；新写入的版本独立保存 schema。执行指定版本时使用该版本的规则，老数据中缺少快照的历史版本继续兼容。
- 注意：不同 `action` 使用不同参数；`write`、步骤编辑和 `delete` 会修改本地卡片数据。
- 同步与后台运行：短任务可用 `run` 等待最终结果；`start_run` 返回运行对象，将 `run.id` 作为后续调用的 `run_id`，运行独立于当前对话和 MCP 请求继续，之后用 `get_run`/`list_run_steps` 查询，并可暂停、继续或取消。停止 AI 对话或断开发起请求不会自动取消该运行。只有在确认发起结果未知且需要重试同一请求时，才复用相同 `idempotency_key` 与完全相同的参数；同 key 不同参数会以 `IDEMPOTENCY_KEY_REUSED` 拒绝。运行输入仅保留在当前进程内供幂等判断和失败重试，磁盘运行记录不保存原始输入；应用重启后未结束的运行标记为中断，历史记录可查询但不能直接重试，需重新提交输入并使用新幂等键。
- 取消与超时：对正在执行的运行发出取消或超时后，状态先变为 `cancelling`/`timing_out`；系统等待当前浏览器操作返回后才报告终态，并且不会继续下一个流程步骤。已发生的导航、点击或提交等浏览器副作用无法回滚；取消、超时和结果未知的中断不可通过 `retry_run` 重放。
- 脚本限制：MCP 不公开 `external_script`，也不允许 `condition_mode=js`；写入、局部编辑和运行历史卡片时都会拒绝任意页面脚本。
- 失败语义：原生步骤返回 `success=false`/`ok=false` 时卡片立即失败并停止；需要把业务校验作为断言时，在 `condition` 步骤设置 `fail_on_false=true`。
- 卡片的 `website` 指定入口页面。运行时若活动标签的完整 HTTP(S) 地址与它完全相同，执行器保留当前文档并开始第一步。不同查询参数或片段会触发导航。需要重新加载时可显式使用 `browser_tab reload`。首个步骤为 `navigate` 时总是执行该步骤。
- 保存并复测已演示过的操作时，用 `write` 保存并按 ID 回读。确认测试起点后用 `start_run` 运行，按 `run.id` 查终态，并核对正向业务信号，例如登录后可见的账号菜单。同步 `run` 的结果随请求返回，`list_runs` 只展示后台运行。
- 后台运行失败时，从 `get_run` 的 `run.steps` 核对最近成功的步骤。已经派发的点击可能使弹窗保持打开，重新观察并确认起始页面后再复测。`step_index` 和运行记录中的 `stepIndex` 均从 1 开始。原生 `wait` 在步骤顶层填写 `selector`，可省略等待时长。
- 流程终点：存在 `flow` 时严格按连线执行，没有出边的节点就是终点，不会继续落入 `steps` 数组中的后续步骤。
- 通用 MCP 节点：卡片步骤可使用 `{ "type": "mcp", "tool": "已有工具名", "arguments": {...} }`，直接复用运行时当前工具目录；`arguments` 内的字符串支持运行输入变量替换。
- 路由与安全：浏览器 MCP 默认使用工作台选择的窗口，也可在 `arguments.change_browser` 指定其它在线连接。为防止无限递归，卡片内禁止调用 `manage_card`。
- 授权：卡片目录、卡片读写、运行记录查询、暂停和取消不要求浏览器连接或接管。`run`、`start_run`、`retry_run`、`resume_run` 和 `step_run` 会开始或继续执行，必须路由到运行绑定的唯一在线 AI-FREE 浏览器并完成 `browser_control action=acquire`；目标缺失、歧义、离线或与运行绑定不一致时显式失败，不会静默改用系统浏览器或其它外部浏览器。恢复后每次浏览器动作仍独立检查接管状态。
- `delete` 将卡片移入回收站。`purge` 永久删除回收站中的卡片，通过 MCP 调用时需要在线浏览器接管，通过首页调用时需要本机确认。
- 重试语义：`retry_run` 只接受可重试的失败记录，且按稳定幂等键对同一源运行去重。它从头执行整张流程，可能重复之前已完成的副作用；重试前须查看运行详情。成功、取消、超时或结果未知的运行不能通过此动作重放。

最短后台调用示例（卡片 ID、连接 ID 和输入值以实际返回为准）

| 顺序 | 工具 | 参数 |
|---|---|---|
| 1 | `manage_card` | `{"action":"list"}` |
| 2 | `manage_card` | `{"action":"get","id":"<卡片 ID>"}`，从 `item.inputSchema` 读取输入约束 |
| 3 | `browser_control` | `{"action":"acquire","change_browser":"<连接 ID>"}` |
| 4 | `manage_card` | `{"action":"start_run","id":"<卡片 ID>","change_browser":"<连接 ID>","inputs":{},"idempotency_key":"<本次请求唯一键>"}`，按第 2 步补齐必填输入 |
| 5 | `manage_card` | `{"action":"get_run","run_id":"<第 4 步返回的 run.id>"}` |

### `browser_file`

侧栏的页面绑定路径当前支持 `download_element`、`upload` 和 `save_session`。同一工具中的软件、会话和设备操作受各入口能力约束，详见 [全工具对照](mcp-entry-parity.md#全工具对照)。

- 作用：`download` 下载 HTTP/HTTPS 文件；`upload` 把 AI 工作区中的本地文件上传到当前页面；`save_session` 保存当前标签页 Cookie、`localStorage` 和 `sessionStorage`；`info` 返回 AI 工作区路径。
- 默认目录：`download` 写入安装目录下的 `AI-Workspace` 根目录；`save_session` 默认写入 `AI-Workspace/sessions`。
- 子目录：`directory` 只接受 AI 工作区内相对路径，例如 `downloads/models`；拒绝绝对路径、`..` 逃逸和指向工作区外的链接目录。
- 下载参数：`url`、`filename`、`media_type`、`transport`、`use_cookies`、`overwrite`、`timeout_ms`、`max_bytes`、`tab_id`、`ref`/`element`、`x`/`y`。媒体下载应将 `browser_observe` 返回的 `category` 传给 `media_type`；`transport` 可取 `auto`、`browser`、`software`。
- 元素下载：`action=download_element` 接受最近一次 `browser_observe` 的 `ref`（也接受 `element` 别名）或视口 `x`/`y`。成功回执中的 `pageClickDispatched: false` 表明工具直接保存了资源。旧 Chromium 若未实现 `download-element`，会回退为对 `mediaUrl`/`downloadUrl` 的软件下载。
- 网页下载流程：站点要求点击下载按钮、记录下载或解锁后续步骤时，用 `browser_action` 的 `click` 点击真实入口。对照点击前后的 `browser_control` `overview` 确认 AI-Workspace 新文件和实际名称。上传后以网页预览或站点收件回执确认成功。`file_selected` 只确认浏览器处理了文件选择。
- 软件下载网络：`action=download` 使用当前 Chromium 的 Cookie、页面 Referer，以及该 Profile 的代理（Clash/网络魔法）。不要绕过代理直连 `assets.grok.com` 等外网 CDN。没有 `url` 但带了 `ref` 或坐标时，按 `download_element` 处理。
- 上传参数：本机调用使用 `path` 或 `paths` 指定 AI 工作区文件；HeySure 远程调用还可使用当前数字成员服务器工作区的 `file_ref` 或 `file_refs`。AI-FREE 会通过 HeySure 创建默认 5 分钟临时链接，下载并校验后物化到本机 `AI-Workspace/Incoming/<task_id>/`。两类参数不能混用。使用 `selector` 或 `ref` 定位页面文件输入控件；多文件可设置 `mode=open-multiple`。
- 上传目标：`action=upload` 把工作区文件放入当前网页文件控件；`action=upload_to_server` 直接把 `path` 指定的 AI 工作区文件上传到 HeySure 成员工作区并返回 `file_ref`，不经过网页。兼容旧调用：`action=download`、`url=file:///...` 且 `save_to_server=true` 时按 `upload_to_server` 处理。
- 会话导出使用当前活动标签，支持 `filename`、`directory` 和 `overwrite`。外部 MCP 与侧栏都要求已加载的 HTTP(S) 页面及支持文档绑定会话导出的 Chromium。目标文档失效时返回 `BROWSER_TARGET_CHANGED`。遇到 `BROWSER_RUNTIME_UPDATE_REQUIRED` 时需要更新内核。工具回执只包含文件元数据和 Cookie 数量。同名文件默认追加编号。需要精确文件名时可指定独立子目录，并以 `file_name` 回填。
- Cookie 规则：`use_cookies` 默认开启，但只发送与目标 URL 域名、路径、Secure 属性和有效期匹配的 Cookie；重定向后会重新匹配，不向其它域泄漏。
- 网络边界：禁止 localhost、`.local`、IPv4/IPv6 私网、链路本地、组播和保留地址。每次重定向都重新解析，并将实际连接固定到已审核 IP，防止 DNS 重绑定。
- 写入规则：先写同目录随机 `.part` 文件，再原子提交；默认不覆盖同名文件。默认大小上限 250 MiB、硬上限 1 GiB。

### `browser_media`

- 作用：把网页视频、音频和其它媒体素材的发现与下载收敛到浏览器底层 MCP。
- `action=list`：观察当前页面的媒体元素，返回短生命周期的 `observation_id` 和媒体 `ref`，以及类型、标签、尺寸和可下载状态；不会凭空猜测页面未观察到的地址。
- `action=download`：必须传 `list` 返回的 `ref`，可附带 `filename`、`directory`、`media_type`、`transport`、`timeout_ms` 和 `max_bytes`；内部复用 `browser_file` 的 Chromium 原生下载、Cookie/Referer、代理和 AI-Workspace 原子写入策略。
- 生命周期：导航、切换标签或页面明显变化后必须重新 `list`；过期引用返回 `OBSERVED_REF_EXPIRED` 或 `OBSERVATION_MISMATCH`，不会跨页面复用。
- 当前范围：支持页面媒体元素和可解析直链；HLS/DASH 分片合并、DRM 和需要站点专用令牌的提取暂不在最小版本内。

### `browser_tab`

- 作用：通过当前受管 Chromium Profile 管理页面导航与焦点。
- `action`：必填，可用值为 `list`、`switch`、`replace`、`navigate`、`reload`、`close`、`back`、`forward`。
- `close`、`back`、`forward` 支持 `index` 别名定位标签页；执行关闭后不要复用原索引，应重新调用 `list` 获取最新 TabStrip 顺序。
- `list` 每次调用都从 Chromium TabStrip 读取全部标签页与当前活动页，不使用窗口首次打开时缓存的网址。
- `replace` 原生覆盖当前页；`navigate` 原生打开新标签、立即激活该标签并把当前受管浏览器打开到前台；`switch` 传入 `url`、`id` 或 `index` 时切换 Chromium 内部标签页，不传目标时仅聚焦当前受管浏览器。

### `browser_observe`

- 作用：读取当前页面中可见的交互元素、文本、媒体和框架信息，为后续操作生成元素引用。
- 推荐流程：先用 `mode=overview` 获取 `regions`，再把其中的 `regionRef` 传给元素观察。区域引用按当前 DOM 重新解析，失效时返回 `REGION_STALE`；区域只缩小观察结果，不限制后续页面交互。
- 区域参数：`region_ref` 是首选；也可用 `region={role,label,match}` 进行语义匹配，或用 viewport CSS 像素矩形 `{x,y,width,height}` 兜底。`region_mode` 默认 `centerInside`，`padding` 默认 10，默认保留两层 `include_ancestor_context`，并通过 `aria-controls`/`aria-owns` 纳入关联 portal。
- 区域响应：返回坐标系、设备像素比、区域当前 bounds、`layoutHash`、`layoutChanged`、祖先上下文和交叠比例。页面布局变化后可把旧 `region_layout_hash` 传回进行校验。
- 旧内核兼容：如果当前 Chromium 尚未包含区域补丁，应用层会根据旧观察结果的坐标真正执行矩形裁剪，并从可见大容器和 viewport 布局生成稳定区域引用。返回的 `query.appliedLayer` 会标明 `chromium-native`、`application-fallback` 或组合执行层；`appliedFilters`、`ignoredFilters` 和 `regionApplied` 用于确认参数没有被静默忽略。语义区域无法解析时返回 `REGION_NOT_FOUND`，区域引用或布局哈希失效时返回 `REGION_STALE`，均不会回退为全页结果。
- 数量参数：`limit`、`max_items`。
- 筛选参数：优先使用 `kinds`、`tags`、`roles`、`control_types` 分维度组合筛选；`filter`、`tag` 保留兼容。无法识别的兼容 `filter` 返回 `INVALID_FILTER`，不再静默返回空结果。
- 框架参数：`frame`、`frame_path`。
- 文本与标记参数：`include_text`、`text_limit`（默认 120，范围 20–500）、`mark`、`highlight_duration_ms`。响应会同时给出 `requestedTextLimit`、`appliedTextLimit`、`limitCapped`、`returnedCount`、`totalMatched` 和 `itemsTruncated`，避免调用方误判参数或传输截断。
- 顶层可点击筛选：交互元素必须在当前视口的至少一个候选点通过 Chromium 命中测试；被遮罩完全覆盖、`pointer-events:none`或禁用的元素不返回。按钮内部的 `span/svg/path` 会归并到最近的按钮或链接。
- 控件语义：保留 `kind=interactive` 的兼容分类，同时返回 `role`、`controlType`、`editable`、`multiline`、`label`、`readOnly`、`required` 以及选中/展开/按下状态。可区分文本、密码、搜索、数字、日期时间、文件和富文本输入，以及按钮、链接、复选/单选、开关、滑块、下拉/列表、标签页和菜单项。`select` 还会返回最多 50 个选项及其选中状态；密码框的当前值不会进入 `text`、`value` 或关键字匹配。
- 语义筛选：`filter` 除原有 `interactive`、`media`、`text` 外，还可传 `input`、`form` 或具体 `role`/`controlType`，例如 `checkbox`、`combobox`、`text-input`。关键字匹配同时覆盖可见文本、`label`、`placeholder` 和 `aria-label`。
- 快照与定位：每次结果返回新的 `observationId`，item 同时返回 `stableRef`、selector 唯一性、推荐 locator、容器归属和关联文本。`browser_action` 可同时传 `observation_id` 与 `ref`；若快照不一致会返回 `OBSERVATION_MISMATCH`，不执行页面操作。
- 图标控件：名称依次来自 ARIA、关联 label、title、SVG title、alt 和受限图标提示；同时返回 `labelSource`、`labelConfidence`。仍无法命名时明确给出 `unresolvedReason`；疑似删除/移除操作返回 `destructiveHint=true`。
- Closed Shadow DOM：隔离世界无法访问的 closed shadowRoot 会由 Chromium Accessibility Tree 补充其中可见、可用的交互控件，并返回 `accessibilityFallback=true` 与真实 `clickX/clickY`；这类 item 不伪造 selector，后续应直接使用其 `ref` 点击。
- AX Tree：传入 `include_accessibility_tree=true`（兼容 `includeAccessibilityTree=true`）可请求分层 `accessibilityTree`。树最多返回 4000 个节点、单个文本最多 512 个字符；节点达到上限时返回 `truncated=true`。密码控件的名称和值会脱敏。AX 节点 `id` 只用于表达树结构，不能当作 `browser_action` 的 `ref`；操作仍须使用普通观察结果中的 item ref/observationId。
- 观察闭环：`browser_observe` 传 `include_screenshot=true`，返回页面结构和截图；`browser_action` 传 `after="observe"` 与可选 `observation_options`，操作完成后返回新的 `observation` 和元素引用。后置观察失败会标记 `needsObservation=true`，不会重放已执行操作。标准 `/mcp/v1` 和软件内置 Codex adapter 将 PNG 转为 MCP `image` 内容；个人插件 ai-free-browser-control 已同步改为标准 MCP 转发，旧接口兼容路径也会转换图片块。
- Fork 原生 Observe 默认在 Chromium UI 层绘制与元素 `id` 对应的边框标签，不写入网页 DOM、不接收鼠标事件；导航、滚动、窗口隐藏或超时后自动清除。最多绘制 120 个标记。
- 路由参数：`tab_id`。
- 下载链接：item 可保留可直接读取的 `downloadUrl`，但顶层 `downloadLinks` 只汇总显式下载或常见文件 URL。普通图片进入 `mediaResources`，不再计入 `downloadLinkCount`。
- 图片识别：可见 `img`（含 `picture/srcset`）、`video`、`audio`、`canvas` 和 CSS `background-image` 统一返回 `kind=media`；即使图片被网页包装成可点击元素，也保留 `interactive=true`，不会再被误报成普通按钮。
- 图片链接：媒体 item 返回 `mediaType`、`mediaUrl`、`mediaUrls`，HTTP(S) 原图候选同时写入 `downloadUrl`；`downloadLinks` 会携带对应 `ref`、`kind`、`mediaType` 和可选 `linkedUrl`，可直接按四张生成图筛选并下载。

### `browser_screenshot`

- 作用：从 Chromium RenderWidget Surface 截图并返回 PNG base64 `dataUrl`。
- 精确截图：可用 `x`、`y`、`width`、`height` 截取当前视口区域；当前原生协议不公开扩展曾提供的分片整页截图。
- 展示与交付：`send_to_user`。截图不申请 `debugger` 权限，也不会显示浏览器调试提示。

### `browser_action`

- 作用：操作网页中的元素或坐标位置。
- `action`：必填，可用值为 `click`、`double_click`、`right_click`、`drag`、`scroll`、`type`、`insert_text`、`set_selection`、`press_key`。
- 元素定位：优先同时传入 `browser_observe` 返回的 `observationId` 与 `ref`。原生连接会保存该元素的视口中心坐标，后续点击直接在该坐标注入鼠标事件，由 Chromium 命中测试选择坐标处最上层元素；selector 用于字符选区和坐标缺失时回退。显式传入的 `x`、`y` 会覆盖 `ref` 默认中心。应用短期保留最近 3 次观察（最长 30 秒）；旧 ref 只有在页面 URL 未变化、selector 唯一且稳定、当前元素的标签/角色/名称一致时才会重新定位，成功响应包含 `refRecovered=true`。导航、歧义或语义变化仍返回 `OBSERVED_REF_EXPIRED`，不会复用旧坐标。
- 根据页面观察取点时，纯坐标点击（`click`、`double_click`、`right_click`）可带上 `observation_id`。显式绑定坐标需要支持文档绑定的内核。应用校验当前入口对该浏览器的最新观察，限 30 秒且必须对应同一份文档。刷新同 URL 也使旧观察失效。快照校验失败返回 `OBSERVATION_MISMATCH` 和 `actionExecuted: false`。文档在校验后切换时，由 Chromium 的页面绑定拒绝操作。观察后发生滚动、缩放或布局变化时，应重新观察并重新取点。
- 点击实现：Runtime Bridge 与 AI-FREE 建立连接后，Chromium Views 层的虚拟指针会默认悬浮在网页视口中央，并在连接期间常驻；`click`、`double_click`、`right_click` 复用该指针完成平滑移动、按下、抬起和点击反馈，点击结束后停留在最后位置。覆盖层不进入页面 DOM、不接收事件，也不移动 Windows 全局鼠标；RenderWidgetHost 正常执行坐标命中测试，不会穿透遮挡元素。断开 Runtime Bridge 或页面销毁时指针会清除。
- 网页虚拟指针采用「01 棱镜」样式：白色箭尖、紫蓝渐变描边和近黑内芯由 Chromium 原生绘制。移动时的拖尾为连续曲线，向后收细，停止移动后淡出；真实鼠标与扩展手型动效不受影响。
- 鼠标选文：`drag` 使用 `x`、`y` 作为起点，`to_x`、`to_y` 作为终点，真实发送移动、按下、拖动和抬起事件；虚拟指针同步显示拖动过程。
- 字符级编辑：`set_selection` 使用 UTF-16 `start`、`end` 精确放置光标或选择 input、textarea、contenteditable 文本；`start=end` 表示光标。`type` 保持整段覆盖，`insert_text` 仅替换当前选区或从光标位置插入。
- 键盘参数：`key` 支持字符键、方向键、Home/End、PageUp/PageDown、Backspace/Delete、Insert、F1–F24，以及 `Ctrl+A`、`Shift+ArrowLeft` 等组合键；也可用 `ctrl`、`shift`、`alt`、`meta` 显式指定修饰键，`repeat` 可重复 1–100 次。
- 滚动参数：`direction`（`up`、`down`、`top`、`bottom`）、`amount`。
- 其他参数：`force`、`tab_id`。

### `browser_wait`

- 作用：等待指定页面条件成立后立即返回，或固定等待一段时间。条件轮询在 Chromium 隔离世界执行，页面导航期间由应用层有界重试。
- 条件：`attached`、`visible`、`hidden`、`text_contains`、`text_changed`、`url_matches`。省略 `condition` 时兼容为等待 `selector/ref` 存在。
- 参数：`condition`、`selector`、`ref`、`observation_id`、`value`、`initial_value`、`timeout_ms`、`ms`、`tab_id`。`text_changed` 省略 `initial_value` 时会自动记录首次读取值；`url_matches` 不需要元素定位参数。
- 旧内核不会被静默兼容：若 Chromium 忽略 `condition`，应用返回 `BROWSER_RUNTIME_UPDATE_REQUIRED`，必须重新构建并替换 `resources/chromium` 后重启。

页面导航、标签页切换或页面状态发生变化后，必须重新 `acquire` 当前控制目标并执行 `browser_observe`；旧的 observation/ref 不跨页面复用。旧内核未实现某项能力时返回 `BROWSER_RUNTIME_UPDATE_REQUIRED`；新内核已支持但 AX 结果尚未就绪时返回可重试的 `ACCESSIBILITY_TREE_NOT_READY`，二者不要混淆。

## 多浏览器路由

AI 对话和 HeySure 设备端都会发现当前所有已连接浏览器的工具，但任一时刻只维护一个“当前控制浏览器”，不允许同时控制多个目标。软件内 AI 按本轮任务选择浏览器。用户可以在消息里指定目标浏览器或网站。

所有浏览器工具都会额外获得一个可选参数：

- `change_browser`：切换当前控制浏览器，可填写连接 ID 或唯一的连接名称；省略时沿用当前控制目标。

连接列表可以包含多个浏览器，但每次页面工具只会派发到一个连接。切换成功后，同一轮任务中的后续调用继续使用新目标，直到再次传入 `change_browser`。旧 `browser_id`、`browser_name` 和 `browser` 参数仅保留执行兼容，不再向 AI 的新工具 Schema 暴露。

用户在 AI-FREE 顶部标签栏切换活动独立浏览器时，外部 MCP 的当前控制目标也会同步切换。若 MCP 通过 `change_browser` 显式选择后台浏览器，该目标会持续到用户再次切换活动独立浏览器，或后续调用再次传入 `change_browser`。

软件内 AI 会按当前实际工具目录动态注入 MCP 使用提示：同一时间最多控制一个浏览器；需要操作其他连接时先通过 `change_browser` 切换；页面导航、标签页切换或页面状态变化后重新执行 `browser_observe`，不跨窗口或跨页面复用旧元素引用，并以工具的实际返回结果判断任务是否完成。

`windows_tab list` 返回的 `history_id`、`tab_id` 和栏目 `name` 属于外部软件栏目管理层。显示或聚焦已有栏目应调用 `windows_tab` 的 `open`；`history_id` 和 `tab_id` 不能用于 `change_browser`，栏目名称只有同时出现在 MCP 连接列表时才能用于切换。栏目显示为已打开不代表其原生 Runtime Bridge 已就绪。

`windows_tab` 的 `open`、`create`、`edit` 和 `close` 返回值包含 `browser_total`、`browser_open_count`、`browser_names`、`open_browser_names` 和 `active_browser`。显示已有栏目或创建新栏目时会请求将它设为控制目标；MCP 连接建立后，AI 控制栏会自动切换到它。关闭当前控制栏目后会回退到仍在线的一个连接。

`open` 和 `create` 使用两阶段完成条件：先完成 Chromium 窗口打开，再等待对应窗口的认证 Runtime Bridge 握手（默认最多等待 20 秒）。只有返回 `success: true`、`mcp_connected: true` 和 `control_browser_id` 才表示该窗口已经可以继续调用 `browser_tab` 等页面工具。超时会返回 `success: false`、`mcp_connected: false`，同时明确说明窗口已经打开但原生控制通道暂未就绪。同一轮对话会在连接就绪后动态补入新连接及其工具定义，无需等待下一次用户消息。

## HeySure 注册与可用性

- HeySure 设备工具注册由 [`ai-server-device-service.js`](../src/app/backend/features/ai-chat/ai-server-device-service.js) 负责，内部名称会转换为 `aifree.<工具名>`。
- 设备同时上报 `remote_control` 能力，并沿用 HeySure 的 `rc:*` WebRTC 协议。手机或其他电脑在网页控制台发起远程控制后，AI-FREE 会采集当前活动 Chromium Profile 的网页画面，通过 P2P 视频轨传输，并把网页端鼠标、滚动、键盘、地址栏和标签操作注入 Chromium Runtime。只有已连接 HeySure 且当前存在活动浏览器时才能建立会话。
- ICE 配置从已登录服务器的 `/api/rtc/ice-servers` 动态读取；读取失败时仅回退到 STUN。跨 NAT 环境要稳定使用，服务器仍需正确配置 TURN，AI-FREE 不保存或写死 TURN 凭据。
- 注册同时上报 AI 用途说明“用于连接 AI-FREE，调用其中已启用的软件窗口、浏览器和自动化 MCP 工具”和 `catalogProtocolVersion=2`，让 HeySure AI 能把该设备与普通浏览器、桌面或 Android 执行器区分开；该说明仅是能力元数据，不是执行指令。
- 外部调用目录由 [`browser-automation-external-gateway.js`](../src/app/backend/services/browser-automation-external-gateway.js) 汇总，并执行会员权限、浏览器路由和敏感参数限制。
- 只有服务器实时校验为有效会员时，软件才会向 HeySure 注册为在线设备并接受调用。
- 浏览器连接建立或断开后，设备会自动刷新工具目录；以实际注册的工具列表为准。
- 本地 AI、本机 MCP 网关和 HeySure adapter 共用
  [`automation-tool-contract.js`](../src/app/backend/services/automation-tool-contract.js)
  中的 Schema、浏览器路由、超时、路由参数清理和错误规范化规则；三端仅保留各自的传输与鉴权适配。
- AI 控制 → 添加自定义模型：使用自有 API 配置和发送对话不要求登录或 VIP，不消耗 AI-FREE 内置模型额度。此规则不改变外部 MCP 或 HeySure 设备的授权要求。
- AI 控制 → 添加自定义模型 → MCP 配置：服务就绪且账号已授权时，可复制本机连接参数。支持 Streamable HTTP 和自定义请求头的客户端使用当前 URL，通过 `POST` 发送 MCP JSON-RPC 2.0，并在 `Authorization: Bearer …` 中提供密钥。配置是通用参数，不是某个客户端可直接导入的配置文件。
- 仅支持 stdio 的本机客户端可使用同一份参数中的 `command`、`args` 和 `env`。原有 Codex 自动配置继续使用此适配器，运行时从本机描述文件读取当前密钥，配置文件不包含密钥。
- 网关只监听 `127.0.0.1`，云端执行器不能直连。不支持 MCP 的客户端也不能仅凭地址和密钥接入。HTTP 密钥只应粘贴到受信客户端的配置中；重启应用或授权状态变化后遇到 `401`，请重新复制。外部调用继续受现有 VIP 授权和浏览器 MCP 敏感参数限制。
- 旧 `software_window`、`sandbox_files` 和 `browser_download` 名称只在执行层保留兼容，不再出现在公开工具目录；新调用分别使用 `windows_tab`、`run_command` 和 `browser_file`。
