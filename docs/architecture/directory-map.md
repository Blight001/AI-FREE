# 目录重排说明

以下路径均相对于仓库根目录（`package.json` 所在目录）。源码按运行边界划分：

| 目录 | 运行边界 | 典型内容 |
|---|---|---|
| `src/app/backend` | Electron 主进程 | 启动、窗口、IPC、业务服务、Chromium 与系统 IO |
| `src/app/frontend` | 页面进程 | 主窗口 renderer、右侧 sidebar、HTML 页面入口 |
| `src/app/contracts` | 跨进程契约 | IPC channel、payload schema、结果协议 |
| `src/app/shared` | 纯逻辑共享层 | 文本、版本、配额和布局等无副作用工具 |

旧的 `src/app/main`、`src/app/renderer`、`src/app/sidebar` 和 `src/app/views` 已完成迁移；源码构建、测试、Electron 入口和打包资源引用均使用新路径。`backend/preload.js` 仍与主进程入口同目录，作为本轮迁移的兼容边界，后续单独迁移到 `src/app/preload` 时需同步验证三类窗口的生命周期和 CSP。

推荐定位顺序：先按进程边界查 `backend` 或 `frontend`，再按业务域查 `backend/features/<domain>`，最后沿 `contracts` 查 IPC 调用方和注册方。

`backend/services/` 尚未完全按业务域收敛，里面同时存在窗口/标签服务、跨域桥接和历史模块。目录名不代表这些模块都是通用服务。新逻辑优先放入 `features/<domain>/`；修改既有模块时先确认真实调用方和生命周期，再决定是否迁移，避免复制出第二份实现。

## 常用术语

| 术语 | 本项目中的含义 | 不要与之混淆 |
|---|---|---|
| 浏览器环境（Profile） | 一组独立设置、存储和 Chromium 进程的业务实体，以 `profileId` 标识 | Chromium 网页标签索引 `tab_id` / `index` |
| 应用标签（App Tab） | AI-FREE 窗口顶部管理的浏览器环境入口；当前 ID 与 `profileId` 对应 | Chromium 内部网页标签 |
| Browser Runtime | 主进程管理 Chromium 进程、Profile、命令通信和嵌入窗口的运行层 | Electron renderer 或普通网页运行时 |
| Runtime Bridge | AI-FREE Chromium 与主进程之间的认证本机协议/命名管道 | `BrowserAutomationBridge` 本机 HTTP MCP 服务 |
| Browser Automation Bridge | 主进程中的自动化应用服务，组合浏览器工具、卡片运行和外部 MCP 网关 | Runtime Bridge 传输协议本身 |

主进程启动、浏览器启动和自动化调用的端到端关系见[项目路径图](project-paths.md)。Chromium 子系统的启动事务、标识符、配置应用语义与资源所有权见 [Chromium 运行层接手说明](browser-runtime.md)。
