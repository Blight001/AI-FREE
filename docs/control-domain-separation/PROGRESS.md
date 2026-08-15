# 浏览器控制与软件控制分离进度

对应基线：[当前契约清点](stage0/current-contract-inventory.md)与[功能矩阵](stage0/feature-matrix.md)。
最后更新：2026-07-25。

状态：`[x]` 已实现并有自动化证据；`[~]` 已开始但尚未达到阶段退出条件；`[ ]` 未开始。

## 当前结论

阶段 0 至阶段 4 已完成。应用默认启动 Home Workspace，Browser 与 Software 使用
独立窗口、状态、preload、AI、Automation 和生命周期；迁移开关及旧混合运行分支已
删除。Browser 与 Software 的公开 contract 均已冻结。阶段 5 的旧数据兼容读取器
清理须等待至少两个稳定版本，不属于本轮实施范围。

## 阶段状态

### 阶段 0：冻结基线和补齐契约

- [x] 当前架构与数据契约。
- [x] Home、Browser、Software 功能矩阵。
- [x] 当前窗口、IPC、存储、AI 工具、自动化卡片与 Cursor Sidecar 装配清点。
- [x] 现有浏览器与软件成功、失败、关闭恢复行为证据映射。
- [x] 旧数据的保留、分类或兼容迁移决定。

### 阶段 1：建立 Workspace 骨架

- [x] Workspace Registry 与 sender 身份识别。
- [x] `WORKSPACE_ACCESS_DENIED` 稳定错误和无副作用越权拒绝。
- [x] Home、Browser、Software 独立窗口 controller。
- [x] 三套 scoped preload；Browser 不含 Software，Software 不含 Browser。
- [x] Home 两个独立打开/聚焦入口。
- [x] Browser/Software 占位窗口沿用主内容区加右侧三栏目布局。
- [x] 新工作区 composition 不装配 Cursor Sidecar。
- [x] 独立创建、聚焦、关闭、重开和互不清理行为测试。
- [x] Workspace 骨架真实 Electron 验收。
- [x] legacy IPC 注册器支持 sender authorizer；新模式按 channel domain 授权。
- [x] 混合 AI/automation 通道从 sender 推导工作域；显式声明不得与 sender 冲突。
- [x] Browser → Software、Software → Browser、renderer 跨域和 Home 依赖门禁。
- [x] 完整旧运行链路验收。
- [x] 阶段 1 退出评审；阶段 4 已删除迁移开关并正式切换三窗口。

### 阶段 2：迁移 Browser Workspace

- [x] Browser Window 独立拥有窗口句柄、side view、标签状态与活动标签。
- [x] Chromium Runtime、Profile、历史、浏览器设置和网络 UI 接入 Browser Window。
- [x] Browser 使用独立 preload 入口且不暴露 Software 能力。
- [x] Browser 侧栏仅保留 AI 控制、自动化和浏览器配置。
- [x] Browser AI 不读取或发布软件目标、`software_ui` 或软件窗口信息。
- [x] Browser AI 历史按工作域过滤，run key 与窗口关闭取消按 Browser 域隔离。
- [x] Browser Automation 使用 Browser 连接、卡片兼容仓库和定向 domain 事件。
- [x] 新 Workspace composition 不装配 Cursor Sidecar；原生输入 phase 3 通过。
- [x] Chromium phase 3、Browser UI、会话、完整 acceptance 和 packaged runtime 通过。
- [x] Browser 稳定 contract 已冻结：
  [browser/CONTRACT.md](browser/CONTRACT.md)。

### 阶段 3：迁移 Software Workspace

- [x] Software Window 独立拥有窗口句柄、side view、标签状态与活动标签。
- [x] 软件目录、外部软件附着、焦点、截图和输入迁入专用 Software TabManager。
- [x] 关闭最后一个软件标签保持空 Software 壳，不创建 Chromium。
- [x] Software 使用独立 preload；不暴露 Browser、网络、Profile 或 Home 能力。
- [x] Software 侧栏仅保留 AI 控制、自动化和软件配置。
- [x] Software AI 只装配 `software_app`、`software_ui` 与 `sandbox_files`。
- [x] Software AI 使用独立 settings、run registry 和历史仓库。
- [x] 旧混合历史仅作兼容读取源；迁移具备 marker、幂等和损坏恢复，旧文件保留。
- [x] Software Automation 使用独立卡片仓库、任务状态、取消表和定向事件。
- [x] Software 窗口关闭仅取消 Software AI/Automation，并成对释放 listener。
- [x] Software composition 不装配 Cursor Sidecar。
- [x] 外部软件嵌入、真实鼠标/键盘、弹窗、窗口跟随、恢复和软件设置 UI 验收通过。
- [x] Software 稳定 contract 已冻结：
  [software/CONTRACT.md](software/CONTRACT.md)。

### 阶段 4：收缩旧 AppShell

- [x] Home Workspace 正式成为默认主窗口。
- [x] 删除迁移开关和 legacy/mixed composition 分支。
- [x] Browser AppShell 固定使用 Browser state、Browser preload 与 Browser side view。
- [x] Software 实例只进入 Software TabManager；Browser 活动标签不接受软件目标。
- [x] `open-external-software` 晚绑定到 Software application contract。
- [x] sender 身份驱动公共 AI/history/settings/support 路由，跨域声明被拒绝。
- [x] Home、Browser、Software window/preload/listener/domain disposer 成对释放。
- [x] 源码态、`.generated/app` 和 Windows packaged runtime 均已验证。

### 阶段 5：兼容清理

- [ ] 至少两个稳定版本后执行。

## 当前验证证据

| 命令 | 结果 |
|---|---|
| `node --test test/unit/workspace/*.test.js test/contract/ipc/workspace-preload-api.test.js` | 通过 |
| `node --test test/unit/external-app/software-*.test.js test/unit/ai-chat/software-history-repository.test.js` | 通过 |
| `node --test test/contract/ipc/channels-registry.test.js test/contract/ipc/preload-domain-api.test.js` | 通过 |
| `npm run guardrails` | 通过；零 ESLint/typecheck/结构债务 |
| `npm run check:workspace-shell` | 通过；Browser/Software 真实标签壳、独立 preload、三栏目 side view |
| `npm run verify` | 通过；533 项测试、覆盖率、架构门禁和源码生成通过 |
| `npm run check:software-settings-ui` | 通过 |
| `npm run check:external-app-embed` | 通过；截图、Sidecar 协议、真实鼠标/键盘、弹窗、跟随和恢复 |
| `npm run check:browser-runtime` | 通过；修复 Profile 刷新丢失 `geoProxyServer` |
| `npm run test:acceptance` | 通过；Workspace、扩展、Chromium、UI、会话、外部软件及旧 Sidecar |
| `npm run accept:chromium-phase3` | 通过；真实输入、会话隔离、异常协议和进程释放 |
| `npm run build:win` / `npm run check:packaged-runtime` | 通过；Windows 包与外部运行资源完整 |
| `node scripts/run-electron.js scripts/check-packaged-sidebar-assets.js` | 通过；ASAR 中侧栏、壳与 logo 可加载 |

## 保留的兼容边界

- 阶段 5 前保留旧 AI 历史兼容读取源；仅迁移可可靠识别为 Software 的会话。
- Browser Automation 继续读取既有浏览器卡片路径，以保持升级兼容。
- 旧 Cursor Sidecar 协议仍保留低层回归验收，但三工作区 composition 均不装配它。
- 以上兼容代码至少经过两个稳定版本并完成升级恢复验证后才可删除。

## 验收修复记录

- Browser Runtime 代理切换曾把 `nextProxyServer` 放入刷新上下文，却未传给 Profile
  解析器；现已恢复 `geoProxyServer`，保证出口地域探测沿目标代理执行。
- 旧 external-app fixture 曾依赖 Windows `MessageBox` 的固定按钮位置；现改为自有明确
  尺寸的 owned modal，继续真实验证截图、系统鼠标点击和关闭行为，不再依赖系统 UI
  版本。新 Workspace 本身不装配 Cursor Sidecar。
- Chromium 异常协议验收断开 Named Pipe 后，`taskkill /T` 在 Windows 上可能未终止
  根进程；现增加精确 PID 的 `ChildProcess.kill('SIGKILL')` 兜底，并以 OS PID 存活
  状态确认退出，phase 3 的 Profile 锁和进程释放恢复稳定。
- 连续 Electron 验收可能遇到 Windows 前台切换超时 `0x80070102`；外部软件输入 fixture
  仅对该明确超时重新聚焦宿主、同步 Sidecar 目标并作有界重试，重复失败仍使验收失败。
- 自有模态 fixture 的确认按钮使用固定大尺寸与基于截图的中心坐标，避免依赖
  Windows `MessageBox` 的版本差异；真实系统鼠标点击仍必须关闭弹窗和测试进程。
- AppShell 构造时会复制依赖，构造后再写入 Workspace bootstrap、sender authorizer 和
  Software composition 不会生效，曾导致默认启动直接进入 Browser 且 Software 错误被
  显示为 `[object Object]`；现改为构造时注入可晚绑定的窄访问器，并补充 Home-only
  启动、Software IPC 装配和结构化错误文案回归测试。
- 外部软件恢复 fixture 只在确认测试窗口已可见后记录原始 placement，避免把应用刚
  启动时的瞬时隐藏状态误当成恢复目标；位置、尺寸、最小化、最大化和可见性断言均保留。
- Software 与 Browser 共用 Runtime Manager 时，外部软件曾沿默认 getter 取到 Browser
  HWND；现由 Software TabManager 显式传入当前 Software Window，真实验收使用隐藏的
  Browser 诱饵窗口证明软件只停靠到 Software，且截图、输入、跟随和恢复行为保持不变。
- Software 壳的工作域切换曾写在被 CSP 禁止的内联脚本中，导致专属模式从未执行；
  现迁到受 CSP 允许的独立 renderer，并在无实例时显示“尚未嵌入软件”及右侧操作引导，
  同时验收 Browser 专属控件已从 Software 主壳移除。
