# Backend

Electron 主进程代码。这里负责应用生命周期、窗口、IPC、Chromium、平台资源和业务域服务。

依赖方向：`entry → composition → features → platform/repository`。页面只能通过 preload 和 `contracts` 访问 backend。
