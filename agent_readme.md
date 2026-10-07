# AI-FREE 浏览器 MCP 快速对接指南

> 本文件面向需要调用当前 AI-FREE 浏览器 MCP 的 AI Agent。工具目录和浏览器连接是运行时动态的，**不要凭记忆虚构工具或参数**。

## 1. 连接入口

在 Codex/插件环境中使用个人插件 **AI-FREE 浏览器控制**。常用桥接工具：

- `mcp__ai_free_browser__ai_free_status`：检查外部 MCP 网关是否就绪。
- `mcp__ai_free_browser__ai_free_list_tools`：读取当前真实工具目录和在线浏览器连接。
- `mcp__ai_free_browser__ai_free_call_tool`：按工具名转发调用，参数放入 `arguments`。

旧的 `software_window_*` 名称仅保留兼容，不应作为首选；窗口管理优先使用 `windows_tab`。

## 2. 标准启动流程

每次新任务按以下顺序执行：

1. 调用 `ai_free_status`。
2. 调用 `ai_free_list_tools`，记录 `connections[].id/name/online` 和实际工具 schema。
3. 没有在线连接时，调用 `windows_tab`：
   - 已有窗口：`{ "action": "open", "history_id": "..." }`
   - 新窗口：`{ "action": "create", "name": "测试窗口", "url": "https://example.com" }`
4. 仅当返回 `success: true`、`mcp_connected: true`、`control_browser_id` 后，才调用页面工具。
5. 页面操作前调用 `browser_control`：`{ "action": "acquire", "browser_id": "<control_browser_id>" }`。
6. 调用 `browser_observe` 获取当前页面结构；只使用本次观察返回的 `ref` 和 `observationId`。
7. 用 `browser_action` 操作，推荐 `after: "observe"` 获取操作后的新快照。
8. 导航、切换标签页或页面明显变化后，重新 `acquire` + `browser_observe`；旧 ref 不得跨页面复用。
9. 任务完成后调用 `browser_control` 的 `release`；临时窗口用 `windows_tab close` 清理。

## 3. 最小调用示例

以下是 `ai_free_call_tool` 的参数形状（实际字段以 `ai_free_list_tools` 返回的 schema 为准）：

```json
{"name":"browser_control","arguments":{"action":"acquire","browser_id":"native:<connection-id>"}}
```

```json
{"name":"browser_observe","arguments":{
  "browser_id":"native:<connection-id>",
  "mode":"elements",
  "include_text":true,
  "include_screenshot":true
}}
```

```json
{"name":"browser_action","arguments":{
  "browser_id":"native:<connection-id>",
  "action":"click",
  "ref":"e15",
  "observation_id":"obs-...",
  "after":"observe"
}}
```

文本输入使用 `action: "type"`（整段输入）或 `action: "insert_text"`（插入/替换选区）；滚动使用 `action: "scroll"`；键盘使用 `action: "press_key"`。

## 4. 窗口、标签和目标路由

- `windows_tab` 的 `history_id`/`tab_id` 只用于窗口管理，**不能**当作 `change_browser`。
- 多窗口时，在页面工具参数中使用 `change_browser` 指定在线连接 ID 或唯一窗口名；同一时间只控制一个浏览器。
- 标签页管理使用目录中真实存在的 `browser_tab`；关闭标签后必须重新 `list`。
- 窗口“已打开”不等于 Runtime Bridge 已连接，必须检查 `mcp_connected` 和 `control_browser_id`。

## 5. 常用观察与等待

- 页面概览：`browser_observe {"mode":"overview"}`，可先获取语义区域。
- 元素筛选：优先使用 `kinds`、`tags`、`roles`、`control_types`；兼容 `filter` 仅使用 schema 允许的值。
- 可访问性树：`include_accessibility_tree: true`；AX 节点 id 只表达树结构，操作仍使用普通 item 的 `ref`。
- 截图：`include_screenshot: true`，或调用 `browser_screenshot`。
- 条件等待：`browser_wait` 支持 `visible`、`hidden`、`text_contains`、`text_changed`、`url_matches` 等。

## 6. 下载、上传和媒体

- 页面图片/视频/音频：先 `browser_observe` 或 `browser_media action=list` 获取 ref，再下载；不要猜测页面未返回的 URL。
- 文件上传/下载/会话保存：使用目录中的 `browser_file`。
- 所有文件路径必须位于 AI-Workspace；不要写入项目根、系统目录或传输 Cookie/API Key。
- Cookie、localStorage 和 sessionStorage 只能通过 `browser_file action=save_session` 保存，结果不得输出敏感内容。

## 7. 错误处理

- `BROWSER_RUNTIME_UPDATE_REQUIRED`：当前 Chromium 内核缺少能力，停止重试并报告；不要静默降级。
- `ACCESSIBILITY_TREE_NOT_READY`：页面结构暂未就绪，可短暂 `browser_wait` 后重新 observe。
- `OBSERVED_REF_EXPIRED` / `OBSERVATION_MISMATCH`：重新 observe，使用最新 ref/observationId。
- 页面工具不可用：重新执行 `ai_free_status` + `ai_free_list_tools`；不要调用目录中不存在的工具。
- 以工具返回的 `success`、`isError`、`pageDiagnostics` 和最终页面状态为准，不以中间点击成功代替业务完成。

## 8. 安全与清理

- 一次只操作一个在线浏览器；切换目标前确认名称/连接 id 唯一。
- 不记录或回显密码、Cookie、Token、API Key、代理凭据。
- 破坏性动作（关闭标签、删除卡片、提交表单、下载/上传）执行前确认目标和当前页面状态。
- 测试结束必须 release 接管，并关闭临时窗口；不得留下孤儿窗口、文件或进程。

## 9. 代码与详细契约

完整工具说明见：

- `docs/mcp.md`
- `docs/codex-browser-alignment.md`
- `src/app/backend/services/ai-browser-window-tools.js`
- `src/app/backend/services/native-browser-tool-definitions.js`

若本文与运行时目录冲突，以运行时行为和 `ai_free_list_tools` 返回的 schema 为准。
