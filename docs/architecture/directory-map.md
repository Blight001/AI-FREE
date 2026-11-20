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

Chromium 子系统的启动调用链、标识符、配置应用语义与资源所有权见 [Chromium 运行层接手说明](browser-runtime.md)。
