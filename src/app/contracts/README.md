# Contracts

跨进程兼容边界的唯一真源，包括 IPC 通道、payload schema 和 `{ok, data/error}` 结果协议。

新增通道前先登记 `ipc-channels.js`，再由 backend 注册器和 preload 的域 API 接入。
