# 浏览器自动化与调试模式

## 2.6.48（含 2.6.47 双模式）

AI 控制页面增加模式、暂停接管、恢复、最近报告、结束流程。模式按浏览器进程保留，重启后默认自动化。

实际视频剪辑页面复测后补齐：默认观察覆盖全页面，不再误选第一个 header；role + name 定位统一折叠按钮文字中的换行和多余空格。自动化失败进入调试，恢复成功后回到先前指定的模式；明确选择调试模式时继续保留调试。

- 自动化：动作前重新读取目标位置；唯一 test id、ID、role + name、文本、selector 依次定位。临时缺失/隐藏/遮挡只在发送动作前重试一次。动作后重新观察。默认会连续观察页面，确认 URL、元素数量和布局稳定后再读取业务探针；单步传 `wait_for_stable:false` 可关闭，超时返回 `PAGE_STABILITY_TIMEOUT` 并进入调试。
- 调试：保留动作前后 URL、页面标题、元素、AX 树、截图、业务探针值、耗时和检查差异。失败转调试。
- `browser_workflow run` 复用现有卡片执行器，最多 50 步；运行预算最多 120 秒，每步业务检查最多 30 秒。正在执行的原生请求在安全边界结束，侧栏停止、HTTP 断连或显式暂停后，流程停在安全边界并释放页面接管。
- 已发送的操作结果未知、或按钮成功但业务检查失败时，不自动重放动作。恢复先重新核验已经执行的步骤；没有检查条件时要求取消并重新建立流程。
- 每个连接最近 20 步诊断，截图总量最多 16 MB，关闭连接时清理。未开启调试时发生的失败无法补拍事前截图；报告如实保留可用信息。

## AI 虚拟鼠标

浏览器启动、运行时握手和只读操作时，AI 虚拟鼠标默认隐藏。`browser_control action=acquire` 接管所选浏览器后，活动标签显示虚拟鼠标与接管边框。切换或新开标签时，接管标识随活动标签转移。刷新、导航和关闭活动标签后，接管保持到 `action=release` 或运行时断开。页面变化后重新观察，再使用当前页面的引用。原生接管状态中的 `pointerVisible` 表示 Chromium 原生光标层的可见状态。

## 文件上传

网页常用透明的 `<input type="file">` 覆盖加号或上传按钮，也可用可点击的 `label` 关联隐藏的文件输入框。使用 `browser_observe` 的 `filter: "file-input"` 查找输入框，再将最新观察得到的 selector/ref 与 AI 工作区文件交给 `browser_file action=upload`；不要先把加号当普通按钮点击。观察和上传共用 Chromium 的命中校验。输入框或其关联标签须可在当前视口命中，文件控件须可用。文件选择仍经过当前页面绑定、工作区文件校验和 Chromium 可信输入。侧栏直接上传工作区文件，支持单个文件及混合批次。`file_selected` 回执表示浏览器处理了文件选择。网页是否接收由页面预览或收件回执验证。

## 侧栏的单轮批处理

两个 MCP 入口均提供 `browser_page_batch`，用于一次提交已经决定的同页操作。一次调用只运行当前批次。其参数使用既有 `browser_action` 页面参数或 `browser_wait` 条件，不提供变量、分支、无限循环或续跑。入口在主进程绑定浏览器连接和文档，批内固定目标。每一步复用原有页面工具的定位、接管、文档校验和输入队列。

速度来自减少模型往返，不来自并行输入或跳过校验。模型只有在需要新证据或新授权时才应在该步骤前收束当前批次。在原生 `tool_calls` 数组只返回一个调用的情况下，也可用一个 `browser_page_batch` 传递整段。已有数组协议仍保留；文件、命令、跨页及持久自动化继续使用各自入口，不应被这个接口隐式纳入。添加新可批处理工具前应明确失败、取消、副作用和结果交付契约。

回执只证明工具步骤的确认情况，不证明网页业务结果；必要时用 `browser_observe` 单独核对。失败或用户插入新指令后中断旧计划，已完成的动作不可回滚，未知结果不可重放。可复用流程、业务断言、诊断和持久运行仍按自动化卡片或 `browser_workflow` 的能力使用。侧栏验收见 [交互验收夹具](ai-control-interaction-acceptance.md)。

## 业务探针与检查

业务字段从当前页面读取，需要按实际页面声明 selector。软件不猜测项目、时间轴或导出数据；未配置检查时返回 `businessVerification.status = not_configured`。

`probes`: `{name, selector, read, attribute?}`，最多 32 项。

- `text`（默认）、`value`、`count`、`visible`、`attribute`、`duration`、`currentTime`。
- `count` 可以返回 0；其他读取要求唯一元素。`visible` 验证渲染可见性；标题文本存在不代表面板已打开。
- attribute 只支持 `aria-*`、`data-testid`、`data-state`、`data-status`、`title`、`value`。
- 密码输入的内容不可读。无法读取返回 available=false，不能当作检查通过。
- duration/currentTime 限制为媒体元素。开放 Shadow DOM 可定位；跨源 iframe、封闭 Shadow DOM 不保证语义探针覆盖，失败需要重新观察并选择可操作目标。

`expect`: `{name, op, value?}`，op 支持 equals/not_equals/contains/increases_by/changes/unchanged/exists。

`identity_probe` 指定项目标识字段，验证单步前后以及同一流程各步骤间项目未切换。

```json
{
  "action": "run",
  "probes": [
    {"name": "project", "selector": "[data-testid=project-name]", "read": "text"},
    {"name": "clips", "selector": "[data-testid=timeline-clip]", "read": "count"}
  ],
  "identity_probe": "project",
  "steps": [{
    "name": "添加素材",
    "tool": "browser_action",
    "arguments": {
      "action": "click",
      "locator": {"test_id": "add-to-timeline"},
      "expect": [{"name": "clips", "op": "increases_by", "value": 1}]
    }
  }]
}
```

这些 selector 是格式示例，调用方必须先观察实际页面。每一步可覆盖 probes/expect/identity_probe；进入项目之前的导航步骤可明确设置 identity_probe 为空。

`browser_workflow report` 加 `include_images:true` 返回标准 MCP 图片内容，文字结果不携带图片 base64。AI 控制侧的最近报告显示状态差异文本。

## 浏览器故障恢复与最后一个标签页

嵌入式 Chromium 的最后一个网页标签关闭后，原窗口会打开一个新标签；该操作不会关闭浏览器栏目、重启内核或重置 Profile。从 AI-FREE 任务栏关闭整个浏览器栏目或退出应用时，浏览器仍正常退出。

检测到浏览器进程异常退出、主窗口失效或桥接心跳超时时，AI-FREE 会在主进程控制台记录脱敏诊断（包括可用的错误栈、退出码、内核输出和诊断文件位置），并自动重启原 Profile，尝试恢复已落盘的标签页，不重放未完成的浏览器操作。开发模式的「调试控制台」也可查看这条记录；更完整的内核输出见应用数据目录下的 `logs/chromium-runtime.log`。重启后 60 秒内再次故障不会循环重启；启动重试失败时也保留错误，供用户手动处理。

构建并部署含 `0067-ai-free-keep-embedded-tab-strip.patch` 的内核后，可用 `npm run accept:chromium-phase3 -- --robustness-only` 验证最后一页补位、进程退出后的重启与主动关闭。

## 验收入口

- `npm run verify` / `npm run guardrails`
- `npm run test:acceptance`
- `npm run accept:codex-browser`：包含目标移动、前后 AX/截图、状态增量、延迟业务恢复不重复、项目切换。
- `npm run accept:chromium-phase3`：原生输入、文件、会话及进程释放回归。
- 安装后通过 AI-FREE 真实 MCP 再运行双模式与操作链。

## 安装后验收（2026-09-16）

- 已打包、安装并重启 2.6.47；安装目录内 app.asar 和 Chromium DLL 的 SHA-256 与本次打包产物一致。
- `npm run verify`：721 项通过、0 失败；复杂度门禁通过。2.6.47 的 `accept:codex-browser` 通过；双模式版本的通用 acceptance 和 Chromium phase3 回归通过。
- 真实视频剪辑页面通过 MCP 完成音频/素材面板切换、导出窗口打开及关闭；检查项目名、导出标题、帧率和时长。加载期间项目发生变化时正确暂停，等待保存状态就绪后流程通过。
- 安装版受控测试页面验证延迟业务更新：失败进入调试，恢复时先检查已执行步骤，点击计数保持 1，随后继续打开导出并恢复自动化模式。
- 调试报告返回前后两张标准 MCP 图片和 AX 数据，文字元数据不重复携带 base64。
- 补丁 0049—0051 在独立 Git 临时目录反向还原至 0048 基线后顺序重放，与实际编译源码一致。
- 已关闭临时验收窗口和本地测试服务；保留“视频剪辑测试”窗口，恢复自动化模式并清空临时业务探针。真实项目未执行素材添加或成片导出，这两项不属于本次真实项目验收结论。

## 2.6.48 检查与调试信息优化（2026-09-16）

- 页面错误采集：记录脚本异常、未处理 Promise、资源加载失败和 HTTP 失败请求；每一步只关联动作前后新增事件，错误会使流程进入调试并返回 `PAGE_RUNTIME_ERRORS`。URL 会去除查询参数和凭据，事件数量有界。
- 流程配置默认独立。只有 `inherit_config: true` 才继承上一次的 probes、expect 和 identity_probe；结果返回 `effective_configuration`，避免取消流程后的隐式继承。
- 自动化模式保留最近一步的轻量截图缓存；失败转调试时会提升为失败前证据。若缓存不可用，报告明确标记 `pre_failure_evidence: unavailable`。
- `browser_workflow report` 默认返回步骤摘要、耗时、实际/预期差异、失败原因和 `report_id`；`include_details: true` 才展开完整前后状态，`include_images: true` 才返回图片，`include_history: true` 才返回历史报告列表。
- `browser_action` 增加 `select_option` 和 `set_checked`，分别按 option value/label 直接选择表单值、直接设置勾选状态并触发 input/change 事件；不再依赖点击、End、Enter 的焦点顺序。
- 2.6.48 已重新编译原生内核、打包安装并通过真实 MCP 验证 `select_option`；`npm run verify` 通过（724 项，0 失败）。

## 对照验收后的修正（2026-09-16）

- 诊断游标现在覆盖步骤之间到达的事件，并按序号去重；流程级计数保留页面异常、console 错误和失败请求，单步报告保留事件明细。
- 报告摘要不会把空检查显示为“全部检查通过”，而是返回 `businessVerification.status = not_configured`；流程汇总与单次动作状态分开。
- `text_contains` / `text_changed` 使用可见文本读取，`value_equals`、`attribute_equals`、`checked`、`count` 使用明确字段，避免把 select 的 value 当成按钮文字。
- `set_checked` 已满足目标状态时返回 `changed=false`，不重复触发 input/change。
- 2.6.48 已重新打包安装；工作流与运行时相关单测 34 项全部通过。剪辑页面的尾部黑屏、版本漂移、画布尺寸和导出交付仍属于产品层问题，未归因于浏览器控制层。

## 本地 Web 回归入口（2026-09-16）

- AI 控制上下文遇到 localhost/127.0.0.1 页面，且用户表达测试、回归、重复操作或验收意图时，优先引导 `browser_control acquire` + `browser_workflow automation`；明确要求单步控制时仍可使用底层工具。
- `manage_card action=template` 提供本地视频剪辑回归模板，包含项目、时间轴、导出三个阶段以及项目、时长、导出状态探针。模板中的 selector/expect 需按实际页面覆盖后运行，不会虚构页面节点。
- 模板默认声明独立测试项目和调用方负责清理，避免复用上一轮项目状态；完整的 20 次双浏览器 parity gate 仍需在同一视口、同一项目初始化和同一素材条件下单独执行。
- 基础 locator 契约已扩展为 `test_id → id → role/name → text → selector`，并支持 `scope`、`nth`、`exact`、`has_text`；观察返回的 role/label 也会重新进入同一解析器，重名保持 ambiguous，不静默选第一个。
- 工作流结果现在同时提供 `located`、`actionExecuted`、`pageChanged`、`status`、`businessVerification`；空检查保持 `not_configured`，不能写成 assertion passed。
- 非关键资源错误（favicon、统计/遥测、非关键图片）现在只进入 warning，不阻断比例设置等业务动作；主资源、业务接口和脚本异常仍会进入失败诊断。
- `set_checked` 返回 `changed` 与 `event_dispatched`；目标状态已满足时为 `false/false`，只有显式 `force_event=true` 才重复派发事件。
- 观察到的 accessibility fallback ref 在动作层会再次按 role/name 解析；过期快照保留 `OBSERVED_REF_EXPIRED` / `OBSERVATION_MISMATCH`，当前页面多匹配时返回 `TARGET_AMBIGUOUS` 和候选信息。原生 locator 增加 scope/nth/exact/has_text 过滤。
- 本阶段安装后回归：原生自动化与工作流相关测试 54 项通过；原生内核已重新编译、打包和安装，MCP 网关 ready。
