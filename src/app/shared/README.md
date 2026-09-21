# Shared

放置主进程和页面都能使用的纯逻辑。禁止依赖 Electron、DOM、网络和文件系统；需要 IO 的代码必须留在 backend 的 platform/repository 层。
