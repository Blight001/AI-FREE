# Chromium 运行层接手说明

`src/app/backend/browser-runtime/` 管理独立 Chromium 的进程、嵌入窗口、本地通信和生命周期。Electron 承载主窗口与侧栏；Chromium 渲染网页。`native/browser-host/` 提供 Windows 窗口操作；`native/chromium-fork/` 保存内核版本锁、补丁和构建脚本。

## 从哪里开始阅读

```text
composition/create-core-services.js
  → browser-runtime/index.js：装配、保留既有调用签名
  → features/browser/browser-tab-launcher.js：业务准入、设置解析、有限启动恢复
  → browser-runtime/chromium-runtime.js：操作队列、实例和窗口协调
      → chromium-runtime-launch.js：启动事务、失败回收
      → chromium-launcher.js：可执行文件、参数、预检、spawn
      → chromium-command-client.js：Named Pipe 握手与命令应答
      → chromium-window-bridge.js → native/browser-host：窗口嵌入
      → chromium-runtime-process.js：关闭、重启、延迟退出
```

正式运行只有随包提供的 Chromium。Manager 方法中的旧 `type` 参数仅保留调用兼容性，不参与内核选择。原型握手模式只用于显式开发验证，不能成为正式启动失败后的回退。

## 标识符含义

| 名称 | 含义 | 使用范围 |
|---|---|---|
| `profileId` | 业务浏览器环境 ID；现有应用外层 tab ID 与之对应 | 实例查找、队列、状态与业务事件 |
| `paths.id` / `storageId` | 对业务 ID 规范化后的磁盘目录 ID | Profile 目录、文件锁 |
| `runtimeProfileId` | 沿用存储 ID 的 ASCII 协议标识 | Chromium 启动参数与握手校验 |
| `processId` / `pid` | Chromium 进程 ID | 受管进程校验、原生输入 |
| 自动化 `tab_id` / `index` | Chromium 内网页标签的当前索引 | 内部网页切换；关闭后必须重新列举 |
| `hostHwnd` / `browserHwnd` | 嵌入宿主窗口 / Chromium 子窗口句柄 | Windows 原生窗口桥 |

不要将网页标签索引当作业务 Profile ID；协议事件返回业务层时会映射回业务 `profileId`。

## 配置的保存与应用

1. 业务层解析用户设置、代理和低配模式，调用 `updateProfileConfiguration()`。
2. 运行层把配置修改排入该 Profile 的操作队列，等待已有导航、会话导入等操作结束。
3. `instance.profile` 是下一次启动使用的期望配置；`appliedProfile` 是当前进程启动时生成的脱敏快照。
4. 未要求重启时仅更新期望配置，返回 `restarted: false`。不会把它当成当前进程已经应用。
5. 要求重启时，在同一个队列操作内应用修改并重启。`onlyIfChanged` 避免重复代理切换；先前失败或尚未应用的配置仍可重试。

新配置接口返回 `{ok:true,data:{found,changed,restarted,state}}`。命令和重启失败保留原有异常与错误码；既有 `refreshEnvironmentProfile()` 仍返回状态以兼容调用方。

身份数据由 `browser-environment-identity.js` 解析，页面脚本与原生 UA Client Hints 参数使用同一组字段。品牌列表规范化规则位于纯模块 `shared/browser-identity.js`。

## 状态与持久化

- `RuntimeStateStore` 只保存内存生命周期状态，所有状态写入检查迁移合法性。查询和事件载荷是同步、独立的快照。
- `ProfileRuntimeStore` 负责磁盘路径、旧数据迁移、Profile 元数据和文件锁，不再保存运行状态。
- `chromium-session-importer.js` 处理站点 Cookie、Storage 和导入后的导航。
- `chromium-session-recovery.js` 处理 Chromium 的 SNSS 标签会话、稳定备份和恢复。它与网页登录数据导入是不同职责。

## 资源所有权

| 资源 | 创建与所有者 | 释放条件 |
|---|---|---|
| Profile 文件锁 | Profile 仓库，运行生命周期持有 | 确认进程退出后释放 |
| Named Pipe、宿主窗口 | 启动阶段的 `ChromiumLaunchResources` | 失败、关闭或退出时释放；重复调用幂等 |
| 代理认证桥、环境扩展目录 | 同一个 `ChromiumLaunchResources` | 确认进程退出后释放；超时且结果未知时保留 |
| 进程句柄 | 启动阶段记录，成功后交给运行实例 | 先正常关闭，再按现有策略终止并确认退出 |
| 心跳计时器、父窗口焦点监听 | 运行实例 | 关闭或进程退出时停止、解绑 |

启动成功后，实例持有原来的资源对象；不复制清理状态。启动失败、进程退出和正常关闭使用同一个释放入口。关闭超时必须保留进程与文件锁的关联，迟到退出后再回收剩余资源。

## 页面环境脚本

`src/assets/browser-environment/{navigator,graphics,media}.js` 是浏览器脚本真源，不使用 Node API。构建阶段生成 `runtime-template.js`；运行时将经过规范化、转义的配置填入唯一配置入口，不通过 `Function.toString()` 收集函数依赖。

`browser-environment-assets.js` 集中解析资源路径：源码、`.generated/app` 与打包的 `app.asar` 保持相同的 `src/assets/browser-environment/` 布局。源码直接检查使用同一组资源构造模板；构建与打包态使用生成模板。禁止手工修改生成目录。

## 验证入口

- 定向测试：`node --test "test/unit/browser/*.test.js" "test/unit/browser-runtime/*.test.js"`
- 资源构建：`npm run prepare:source` 与 `node --test test/packaging/assets/source-build.test.js`
- 基础门禁：依次运行 `npm run guardrails`、`npm run verify`
- 生命周期及内核：`npm run test:acceptance`、`npm run accept:chromium-phase3`
- 打包资源布局：`npm run build:win`、`npm run check:packaged-runtime`

重构时优先测试实际行为：状态事件、并发更新、失败后重试、关闭重开、会话恢复和资源回收。不得以匹配私有函数名或函数装配顺序作为行为保障。
