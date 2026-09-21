# Frontend

页面和页面控制器按宿主分组：

- `renderer/`：主窗口和浏览器壳。
- `sidebar/`：AI 控制、账号中心和侧栏资源。
- `views/`：页面 HTML 入口。

页面不直接依赖 Electron；跨进程操作统一通过冻结的 `window.aiFree` API。
