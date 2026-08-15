# Software Workspace 稳定契约

状态：Stage 3 冻结

生效条件：默认应用启动路径

## 窗口与生命周期

- Home 通过 `workspace-open-software` 创建或聚焦唯一 Software Window。
- 主标签壳和 side view 使用独立 `software-preload.js`，二者均登记为 `software`
  sender。
- Software 拥有自己的 `tabs`、`activeTabId`、窗口、side view 和侧栏可见状态。
- 软件实例只进入 `SoftwareTabManager`，Browser TabManager 不接收 `external-app`。
- 关闭窗口会停止本域 AI run、自动化任务和全部 `external-app` runtime，并释放本域
  runtime listener；不得关闭 Browser Window 或 Chromium。
- 重新打开 Software Window 会重新绑定本域 runtime listener。
- Software composition 永不创建或注入 Cursor Sidecar。

## Preload 与 IPC

Software preload 只公开：

```text
software
softwareAi
softwareAutomation
workspace
```

不得公开 `browser`、`network`、Home 启动入口、Browser Profile/历史或网页 MCP。
页签操作使用 `software-close-tab`、`software-switch-tab`、
`software-reorder-tab`、`software-toggle-sidebar`，状态推送使用
`software-tabs-updated`。软件目录与打开入口仍为
`list-available-software`、`open-external-software`。

AI/Automation 兼容沿用现有通道名，但服务必须由已登记 sender 路由；payload 中的
`workspaceType` 若存在必须等于 `software`。伪造或跨域调用返回
`WORKSPACE_ACCESS_DENIED` 且无副作用。

## AI 与 Automation

- Software AI 的 run registry 使用 `software` domain；stop 和窗口 dispose 只取消
  Software run。
- 工具目录仅包含 `software_app`、`software_ui` 与 `sandbox_files`：
  `software_app` 通过 Software application contract 管理实例，`software_ui` 只操作
  当前明确选择的软件目标。
- 不装配 Browser 窗口工具、Cookie、Profile、历史、网页 MCP 或 Browser
  AutomationBridge。
- Software Automation 使用独立卡片 store、运行取消表和进度路由。runner 强制
  `cardData.domain === "software"`，拒绝 Browser 卡片。
- 进度事件定向发往 Software side view，并包含 `domain`、`taskId`、`cardId` 和
  `targetId`。

## 持久化

- 卡片：`userData/software/automation/automation-cards.json`。
- AI 历史：`userData/software/ai-history/<account-scope>.json`。
- 历史迁移标记：
  `userData/software/ai-history/<account-scope>.migration-v1.json`。
- Software AI 设置：原配置 store 的 `softwareAiControlSettings`；Browser 继续使用
  `aiControlSettings`。
- 旧 `userData/ai-chat-history/` 只作为兼容迁移源。仅迁移带可靠
  `softwareProfileId` 的会话；迁移原子、幂等，目标缺失或损坏时可重试，不删除旧文件。
- HWND/PID 只在当前 Software Window 生命周期内可信，不跨启动持久化。

## 用户可见行为

- 侧栏只显示“AI 控制”“自动化”“软件配置”，且不加载 Browser 配置脚本。
- 打开软件创建 Software 标签；关闭最后一个软件标签保持空状态，不创建 Chromium。
- 外部窗口停靠、尺寸同步、焦点、截图、点击、滚动、拖拽与键盘输入沿用原生
  external-app runtime；不绘制自定义光标。

## 验收命令

```text
npm run check:workspace-shell
npm run check:external-app-embed
npm run check:software-settings-ui
npm run guardrails
npm run verify
npm run test:acceptance
npm run build:win
npm run check:packaged-runtime
```
