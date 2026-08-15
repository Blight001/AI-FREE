# 工作域分离当前契约清点

最后核对：2026-07-25。本文只记录迁移前事实；目标权限见实施方案。

## 窗口与生命周期

- ready 后 `app-ready-bootstrap.js` 调用 `appShell.bootstrapMainApp()`。
- `app-shell-main-window.js` 创建一个 `BrowserWindow`，加载 `views/app-shell.html`。
- 同一 controller 创建一个 `WebContentsView`，加载 `sidebar/index.html`。
- 主窗口和 side view 都使用 `main/preload.js`。
- `app.activate` 恢复当前主窗口；无任何 BrowserWindow 时重建 AppShell。
- `window-all-closed` 在非 macOS 调用 `app.quit()`。
- 单例第二实例只恢复当前主窗口或许可证窗口。

## 选择、标签与 runtime

- `app-state.js` 的一个 `tabs` Map 与一个 `activeTabId` 同时表示浏览器和软件目标。
- `tab-manager-runtime.js` 根据 `runtimeType` 管理 Chromium 与 `external-app`。
- 主内容尺寸和统一 side view 宽度由 `app-shell-main-window.js` 共同计算。
- 外部软件目录通过 `list-available-software` 与 `open-external-software` 进入同一 AppShell。

## preload 能力

当前 `window.aiFree` 包含：

```text
ai, automation, account, license, network, browser, content,
software, updates, shell, ui, diagnostics
```

各方法已经固定绑定通道且对象冻结，但所有窗口获得同一能力集合，因此尚未形成工作域安全
边界。

## IPC 基线

`contracts/ipc-channels.js` 当前登记：

| 类型 | 数量 | 主要 domain |
|---|---:|---|
| invoke | 113 | account、ai、automation、browser、license、network、software、ui、updates |
| renderer event | 24 | account、ai、browser、ui |
| push | 51 | account、ai、automation、browser、license、network、ui、updates |

阶段 1 不批量改名；先引入 sender 所属工作域校验。混合 `ai`、`automation`、`ui` 通道在
迁移时必须获得显式 workspace 契约或拆成领域通道。

## AI 工具与停止

- `ai-chat-service.js` 当前组合浏览器窗口工具、软件 UI 工具和外部 MCP 工具。
- `chat-run-registry.js` 管理运行与停止，但 run key 尚未以 browser/software 为前缀。
- `ai-control-chat-event` 当前通过统一 side view 推送。

迁移基线要求保留消息裁剪、流解析、模型、历史和错误行为；只改变工具装配、run 所有者和
事件路由。

## 自动化卡片

- 当前卡片文件位于
  `userData/extensions/browser_automation/automation-cards.json`。
- CRUD/运行/停止使用统一 `automation-card-*` 与
  `ai-control-select-automation-card` 通道。
- 当前 schema 没有强制 `domain`，统一 side view 接收
  `automation-card-progress`。

旧卡片必须保留读取。只有具备可靠类型/步骤能力的卡片才能分类，混合卡片进入兼容区。

## Cursor Sidecar

`create-core-services.js` 当前创建 `cursorSidecarService`，注入 Chromium runtime、
TabManager、tab helpers、lifecycle 和软件 UI 工具。新 Workspace composition 不得复制
此装配；底层源实现与协议单元测试暂时保留。

## 存储与迁移决定

| 数据 | 当前路径 | 决定 |
|---|---|---|
| 账号/授权 | `store/content`、`account_sessions/` | Shared，原路径不变 |
| Chromium Profile | `chromium-profiles/` | Browser，原路径不变 |
| 标签分区 | `Partitions/`、`tab-*` | Browser 迁移时兼容清理 |
| AI 历史 | `ai-chat-history/` | 可靠分类后复制；未知只读 |
| 自动化卡片 | `extensions/browser_automation/` | 兼容读取，按 domain 新写 |
| AppShell 窗口状态 | `app-window-state.json` | 保留；新工作区使用独立文件 |
| AI 凭据 | `ai-server-device-credentials.json` | Shared 安全仓库 |

## 阶段 0 已知缺口

- 尚无三个独立窗口与 scoped preload。
- 尚无 sender 工作域注册和主进程越权拒绝。
- 尚无浏览器/软件独立 AI run、卡片 repository 和事件路由。
- 尚无旧 AI 历史与卡片的领域迁移器。
- 现有 `test:acceptance` 仍包含 Cursor Sidecar 验收；新工作区验收需替换为“不启动
  sidecar 且输入正常”。
