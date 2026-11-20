# Native Browser Host

Windows x64 的 Chromium 子窗口宿主，使用 N-API，API 与
`docs/architecture/Chromium-Fork-Win32嵌入实施方案.md` 第 6 节一致。

构建前安装 Visual Studio 2022 Build Tools，并勾选“使用 C++ 的桌面开发”和
Windows 10/11 SDK，然后在仓库根目录（`package.json` 所在目录）执行：

```powershell
npm run build:native-host
npm --prefix native/browser-host test
```

统一入口为 `npm run check:project -- native`，包括构建、接口/DPI 测试和真实 Electron 加载。
`src/` 是源码真源；`build/`、`.obj` 和 `.node` 是编译产物。目录中的 `embed_smoke.test.js`
目前为空占位，不证明真实嵌入成功；真实内核验证使用 `npm run check:project -- chromium`。
检查覆盖范围和结果语义见 [项目验证接口](../../docs/project-verification.md)。

正式运行要求 Chromium Fork 完成命名管道握手。仅做 Phase 0 原版 Chromium
验证时，可以设置 `AI_FREE_CHROMIUM_HANDSHAKE=prototype`，允许按受控子进程 PID
枚举其主窗口。生产包不得设置该变量。
