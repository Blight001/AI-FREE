# AI-FREE

[English](README.md) | 简体中文

AI-FREE 是面向 Windows 的浏览器自动化工作台。你可以为不同任务创建独立的 Chromium 环境，在选定环境里手动浏览、运行保存好的流程，或用自然语言让 AI 操作网页。

- **独立浏览器环境**：每个环境使用自己的浏览器进程和 Profile，分别保存 Cookie、登录会话和浏览记录。代理、语言、时区等设置也可以按环境配置。
- **可复用的自动化流程**：在首页「自动化」中，把导航、点击、输入和等待等步骤连成流程。保存后可以选择浏览器环境再次运行、查看运行记录，也可以用 JSON 导入或导出流程。
- **AI 驱动的自动化**：在 AI 侧栏选中已连接的浏览器，用自然语言描述任务。AI 可以先查看当前页面，再根据页面内容执行操作；也可以调用「自动化」中保存的同一套流程。

## 运行架构

```text
Electron 主进程
├─ 应用外壳 / 侧边栏 / 标签管理
├─ 账号、授权、更新与配置
├─ Clash Mini 与网络状态
├─ Browser Automation 本机桥接（127.0.0.1:18765）
└─ Browser Runtime Manager
   ├─ 启动每个 Profile 对应的 AI-FREE Chromium
   ├─ 通过命名管道完成身份握手与命令传输
   └─ 通过 N-API Win32 Host 嵌入、缩放和聚焦浏览器 HWND

AI-FREE Chromium Fork
├─ 独立 Profile 与浏览器进程
├─ 自动加载选定的 MV3 扩展
└─ 承载所有目标网页与浏览器自动化
```

Electron 不再承载业务网页；它只负责控制面和 Chromium 窗口编排。每个浏览器环境的数据保存在独立 Profile 中，生命周期由主进程统一管理。

## 系统与开发环境

运行源码需要：

- Windows 10/11 x64
- Node.js 与 npm，建议使用当前 Node.js LTS
- 完整的 `resources/chromium/` 运行时，入口必须为 `ai-free-browser.exe`
- 已编译的 `native/browser-host/build/Release/browser_host.node`

仅在重新编译原生宿主时还需要 Visual Studio 2022 Build Tools，并安装“使用 C++ 的桌面开发”和 Windows 10/11 SDK。已打包的安装版不需要 Node.js 或 Visual Studio。

## 快速开始

在仓库根目录（`package.json` 所在目录）执行：

```powershell
npm ci
npm start
```

安装依赖后，也可以双击 `v-start.bat` 正常启动。

### 启动命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 正式 Fork 模式：内置 Chromium + 强制命名管道握手 |
| `npm run start:chromium` | 与 `npm start` 相同 |
| `npm run start:dev` | 直接启动 Electron 开发外壳；浏览器页仍使用内置 Chromium |
| `npm run start:electron` | 与 `start:dev` 相同 |
| `npm run start:prototype` | Chromium 接入排障模式，允许 prototype 握手；不得用于发布 |
| `v-debug.bat` | 使用本地服务进行 HTTP 联调，不是日常启动入口 |

`start:dev` 不包含热更新服务器。修改主进程或预加载脚本后需要重启应用；修改内置扩展后需要重建或重新加载对应浏览器环境。

### Electron 下载不完整

如果启动脚本提示缺少 `node_modules/electron/dist` 或 `path.txt`，可在 PowerShell 中执行：

```powershell
Remove-Item -Recurse -Force node_modules\electron -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
```

## 开发配置

根目录的 `platforms-config.json` 是打包和默认运行配置入口。

| 字段 | 作用 |
| --- | --- |
| `accountService` | 账号服务主地址、备用地址与请求超时 |
| `packagedExtensions` | 本次打包要包含的扩展目录名；构建时会校验名称、重复项和目录是否存在 |
| `platforms` | 产品名、App ID 和安装器/窗口图标 |
| `platformConfigs.<name>.targetUrl` | 服务未下发覆盖值时使用的默认目标页 |
| `platformConfigs.<name>.tutorialUrl` | 默认教程地址 |
| `platformConfigs.<name>.allowedPlatforms` | 授权验证允许的平台标签 |
| `platformConfigs.<name>.systemProxyEnabled` | 是否允许应用管理系统代理 |
| `defaultPlatform` | 默认平台配置键 |

服务器在授权响应中可以动态下发目标页、教程、平台标签、羊毛资源、TCP 配置和更新信息；运行时值可能覆盖本地默认配置。

常用开发环境变量：

| 变量 | 作用 |
| --- | --- |
| `AI_FREE_SERVER_MODE=remote|local` | 仅控制既有账号后端地址模式，不决定 HeySure 设备服务器 |
| `SERVER_BASE` | 覆盖服务根地址 |
| `ACCOUNT_SERVICE_URL` | 覆盖账号 HTTP 接口 |
| `HEYSURE_SERVER` | 直接 npm 启动时显式覆盖 HeySure 地址；标准 BAT 会清除此变量 |
| `HEYSURE_LOCAL_TEST=true` | 直接 npm 启动时选择本地 HeySure profile |
| `HEYSURE_FORCE_SERVER_MODE=true` | 强制 profile 高于显式/已保存地址；由标准 BAT 管理 |
| `PLATFORM` | 选择平台配置 |
| `FORCE_HTTP_COMPAT_MODE=1` | 禁用 TCP 通道，使用 HTTP 兼容模式 |
| `DEBUG=1` | 启用调试行为与额外日志 |

设备服务联调：`v-start.bat` 默认强制使用正式 HeySure 地址，加 `--local` 仅切换设备服务，账号后端仍使用正式环境。直接运行 `npm start` 且未指定环境变量时，使用设置里的地址；未填写则使用默认地址。

## 内置扩展

当前 `packagedExtensions` 包含 `aixdownloader-9.0.58`。AI 自动化由主进程 Browser Automation Bridge 提供，并通过认证的 Chromium Runtime Bridge 控制受管浏览器环境；它不作为浏览器扩展打包。
- `remove_watermark`：网页复制与媒体处理相关能力。
- `transform`：网页、输入框、图片、PDF 和视频字幕翻译能力。

打包脚本会根据 `packagedExtensions` 排除未选中的扩展；Clash Mini 作为独立运行资源始终打包。AI 自动化工具由主进程发布，并直接派发到受管 Chromium Profile。

## 构建 Windows 安装包

### 1. 准备 Chromium 运行时

`resources/chromium/` 必须包含完整运行时及 `ai-free-browser.exe`。Fork 的版本锁、补丁和构建流程见 [native/chromium-fork/README.md](native/chromium-fork/README.md)。

### 2. 构建原生浏览器宿主

```powershell
npm run build:native-host
npm --prefix native/browser-host test
```

### 3. 构建并校验安装包

```powershell
npm run build:win
```

该命令会：

1. 校验并筛选要打包的扩展；
2. 生成 `appbuild/win-unpacked/`；
3. 单独同步完整 Chromium 运行时，规避大文件并行复制造成的 Windows 文件占用；
4. 校验 ASAR、原生宿主、Chromium、Clash Mini、图标和扩展资源；
5. 基于已校验目录生成 NSIS x64 安装包。

构建结果位于 `appbuild/`。也可以运行 `build.bat`，但该脚本预设下载代理为 `127.0.0.1:7897`，使用前应确认或修改代理端口。

其他构建命令：

```powershell
npm run build:portable
npm run check:packaged-runtime
```

`build:win` 是当前正式发布的推荐路径；`check:packaged-runtime` 用于复查已经生成的 `appbuild/win-unpacked`。

## 测试与检查

接手时建议先看[项目路径图](docs/architecture/project-paths.md)，再按[目录与进程边界](docs/architecture/directory-map.md)定位代码。Chromium 专项的标识符、配置应用和资源所有权见[Chromium 运行层接手说明](docs/architecture/browser-runtime.md)。

运行完整 Node 测试集（`pretest` 会先准备源码）：

```powershell
npm test
```

常用专项检查：

```powershell
npm run check:browser-runtime
npm run check:browser-settings
npm run check:extension-compat
npm run check:extension-refresh
npm run check:chromium-handshake
npm run check:chromium-embedded-policy
```

涉及真实窗口、输入或会话的 Electron 验收脚本可能会启动应用和 Chromium，请先关闭正在运行的 AI-FREE 实例。

## 项目结构

```text
./                               # 仓库根目录（AI-FREE-app）
├─ docs/                         # 架构、浏览器模式与 MCP 说明
├─ native/
│  ├─ browser-host/              # N-API Win32 Chromium 窗口宿主
│  └─ chromium-fork/             # Chromium 版本锁、补丁与构建脚本
├─ resources/
│  ├─ chromium/                  # 已暂存的 AI-FREE Chromium 运行时
│  ├─ clash-mini/core/           # Mihomo 内核与本地 Geo/规则资源
├─ scripts/                      # 启动、构建、冒烟和验收脚本
├─ src/
│  ├─ app/
│  │  ├─ backend/                # Electron 主进程、IPC、服务与浏览器运行时
│  │  ├─ contracts/              # 跨进程 IPC 契约
│  │  ├─ frontend/               # 主窗口页面、渲染逻辑与侧栏
│  │  └─ shared/                 # 主进程与渲染层共享工具
│  └─ assets/extensions/         # 随应用打包并注入 Chromium 的扩展
├─ test/                         # Node 回归测试
├─ package.json                  # npm 脚本与 Electron Builder 配置
└─ platforms-config.json         # 平台、服务、扩展与产品配置
```

### 关键入口

- `src/app/backend/main.js`：Electron 入口。
- `src/app/backend/bootstrap.js`：主进程装配和应用启动生命周期。
- `src/app/backend/browser-runtime/`：Chromium 启动、握手、Profile 和窗口桥接。
- `src/app/backend/services/tab-manager.js`：浏览器环境与顶部标签生命周期。
- `src/app/backend/services/extension-manager.js`：扩展发现、加载与刷新。
- `src/app/backend/services/browser-automation-bridge.js`：AI 自动化本机桥接。
- `src/app/backend/ipc/`：侧边栏与主进程之间的 IPC。
- `scripts/build-windows.js`：Windows 正式构建、资源同步与校验。

## 相关文档

- [目录与进程边界](docs/architecture/directory-map.md)
- [主进程、浏览器启动与自动化路径图](docs/architecture/project-paths.md)
- [浏览器运行模式](docs/browser-workflow-modes.md)
- [Chromium Fork 构建说明](native/chromium-fork/README.md)
- [原生浏览器宿主说明](native/browser-host/README.md)
- [AI 自动化与 MCP 工具](docs/mcp.md)

## 安全与数据说明

- 本机自动化桥接只监听 `127.0.0.1`，不应暴露到局域网或公网。
- 浏览器 Profile、Cookie、账号记录和自动化卡片可能包含敏感数据，请勿提交到版本库或随意分享。
- Google 浏览器级登录/同步凭据应通过环境变量注入，禁止写入源码、补丁或配置文件。
- 自动化、代理和网页内容处理功能应在符合目标网站条款与当地法律的前提下使用。

## 许可证

ISC
