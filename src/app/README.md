# 应用目录约定

`src/app` 按运行边界组织，定位问题时先判断代码属于哪个进程，再进入业务域：

```text
src/app/
├─ backend/                 Electron 主进程：窗口、IPC、业务服务、平台 IO
│  ├─ entry/                启动入口
│  ├─ composition/         依赖装配与生命周期组合
│  ├─ features/<domain>/    业务域：account、ai-chat、browser、network、updates…
│  ├─ browser-runtime/      内置 Chromium 运行时
│  ├─ ipc/                  IPC 注册器与适配器
│  ├─ platform/             操作系统能力
│  ├─ runtime/              应用运行时、崩溃与诊断
│  ├─ services/             跨域应用服务与窗口服务
│  ├─ config/               配置和路径解析
│  ├─ lib/                  可复用基础设施
│  └─ utils/                无状态通用工具
├─ frontend/                页面层，只依赖 preload 暴露的窄 API
│  ├─ renderer/             主窗口与浏览器壳控制器、样式
│  ├─ sidebar/              AI 控制、个人中心与侧栏资源
│  └─ views/                主窗口页面 HTML
├─ contracts/               IPC 通道、payload schema、结果协议
└─ shared/                  主进程与页面都可使用的纯逻辑
```

## 定位规则

- 启动、窗口、Chromium、IPC 或系统资源问题，从 `backend/entry`、`backend/composition`、`backend/features` 和 `backend/runtime` 开始。
- 业务域问题进入 `backend/features/<domain>`；不要在 `services` 中新增只属于某个业务域的逻辑。
- 页面问题进入 `frontend/renderer`、`frontend/sidebar` 或 `frontend/views`；页面不得直接引入 Electron。
- 通道和数据兼容问题先看 `contracts`，再追踪对应的 backend registrar 和 frontend preload 调用。
- 跨进程纯函数放入 `shared`，不得在这里引入 Electron、DOM、网络或文件系统。

源码构建会把上述目录原样复制到 `.generated/app/src`；打包入口由 `package.json.main` 指向 `src/app/backend/main.js`。不要直接修改 `.generated` 或 `appbuild`。
