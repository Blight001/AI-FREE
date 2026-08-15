# 工作域分离迁移基线

最后核对：2026-07-25。状态：阶段 0 基线。编号描述公开行为，不绑定私有函数名。

## Home Workspace

| 编号 | 当前入口/行为 | 成功基线 | 失败与恢复基线 | 现有证据 | 迁移策略 |
|---|---|---|---|---|---|
| HOME-START-01 | 应用启动 | 完成账号/授权恢复后创建混合 AppShell | 后台初始化失败可诊断，窗口仍可重建 | `app-shell-window-state.test.js`、Electron acceptance | 阶段 1 改为只创建 Home |
| HOME-ACTIVATE-01 | `app.activate` | 已有主窗口则显示/聚焦；无窗口则重建 | 不重复创建窗口 | `app-lifecycle` 行为、acceptance | 目标只恢复 Home |
| HOME-ACCOUNT-01 | 账号中心、登录/登出 | 账号与授权状态可读取和更新 | 服务失败安全降级，不伪造成功 | account unit/integration tests | Home 保留完整账号操作 |
| HOME-UPDATE-01 | 公告与更新 | 版本比较、下载和状态事件可用 | 下载/校验失败可重试且释放锁 | update unit tests、packaged runtime | 保留为 Shared Service |
| HOME-OPEN-01 | 浏览器/软件入口 | 当前入口在混合侧栏中创建混合标签 | 创建失败移除占位并保持原活动目标 | browser/external-app lifecycle tests | 阶段 1 新增两个独立入口 |

## Browser Workspace

| 编号 | 当前入口/行为 | 成功基线 | 失败与恢复基线 | 现有证据 | 数据策略 |
|---|---|---|---|---|---|
| BWS-WIN-01 | Chromium 标签创建/聚焦/关闭 | HWND 附着后可切换、缩放、关闭 | 启动失败移除占位；关闭中启动可取消 | `browser-window-lifecycle.test.js` | Profile/历史原路径 |
| BWS-TAB-01 | 标签切换、重排、重命名 | `update-tabs` 推送当前状态 | 关闭最后标签创建普通空白标签 | browser integration tests | 拆出 browserSelection |
| BWS-PROFILE-01 | Profile 与历史 | 创建、打开、重命名、删除与缓存可用 | 损坏/删除失败可恢复 | browser history/profile tests | `chromium-profiles/` 不迁移 |
| BWS-NET-01 | 浏览器网络与 Clash | opt-in 浏览器应用代理、切换节点 | 失败不破坏其它浏览器，退出停止进程 | network tests | Browser 专属选择状态 |
| BWS-AI-01 | AI 对话与网页工具 | 可调用 Chromium Runtime/MCP 工具 | 无连接、超限、停止均有稳定行为 | AI/chat/browser automation tests | 迁移后只注入浏览器工具 |
| BWS-AUTO-01 | 浏览器卡片 CRUD/运行/停止 | 卡片缓存、进度和工具调用可用 | 非法步骤/失败释放运行状态 | browser automation tests | 新卡片写入 `domain: browser` |
| BWS-SIDE-01 | 统一右侧侧栏 | AI、自动化、浏览器配置可用 | 侧栏加载失败可诊断 | browser settings UI acceptance | 迁移后不加载软件设置 |
| BWS-INPUT-01 | 点击、拖拽、滚动、键盘 | Runtime 输入与坐标换算可用 | 非法/超限输入拒绝 | Chromium phase 3 | 保留输入，移除视觉光标 |

## Software Workspace

| 编号 | 当前入口/行为 | 成功基线 | 失败与恢复基线 | 现有证据 | 数据策略 |
|---|---|---|---|---|---|
| SWS-WIN-01 | 软件目录与窗口打开 | allowlisted software 创建 `external-app` runtime | 启动/附着失败不遗留混合标签 | `external-app-tab-lifecycle.test.js` | 拆出 softwareSelection |
| SWS-EMBED-01 | 外部软件承载 | HWND 附着、尺寸同步和焦点可用 | 目标销毁后关闭对应实例 | external-app embed acceptance | HWND/PID 不跨启动信任 |
| SWS-INPUT-01 | 截图、点击、拖拽与键盘 | native 输入和坐标换算可用 | 无目标/越界操作明确失败 | external-app runtime/tool tests | 不启动 Cursor Sidecar |
| SWS-AI-01 | 软件 UI 工具参与 AI | 可观察并操作当前软件窗口 | 视觉失败和危险操作保留诊断 | software UI unit tests | 迁移后不注入浏览器工具 |
| SWS-AUTO-01 | 当前统一卡片入口 | 软件能力可通过混合卡片表达 | 混合卡片无法可靠拆分时不猜测 | automation tests | 新卡片写入 `domain: software` |
| SWS-SIDE-01 | 统一右侧侧栏 | AI、自动化、软件配置可用 | 配置失败不改变浏览器状态 | software settings UI acceptance | 迁移后不加载浏览器配置 |
| SWS-CLOSE-01 | 关闭软件标签/应用退出 | 关闭对应 runtime 并释放附着 | 不重复关闭，不影响其它标签 | external-app lifecycle tests | 目标只清理 Software 域 |

## 跨域隔离验收

| 编号 | 目标行为 | 阶段 1 退出证据 |
|---|---|---|
| ISO-WIN-01 | Home、Browser、Software 可独立创建、聚焦、关闭和重开 | workspace controller 行为测试 |
| ISO-WIN-02 | 关闭一个工作域不改变另一个的窗口、选择和任务 | 双工作域生命周期测试 |
| ISO-IPC-01 | 未注册或越权 sender 返回 `WORKSPACE_ACCESS_DENIED` | sender guard 单元/契约测试 |
| ISO-PRELOAD-01 | 三个 preload 只暴露本域能力 | preload VM 契约测试 |
| ISO-STATE-01 | 不再用单一 activeTab 表达浏览器和软件目标 | 状态所有权测试 |
| ISO-CURSOR-01 | 新工作区不装配 Cursor Sidecar，实际输入仍可用 | 无 sidecar 行为验收 + 输入验收 |
