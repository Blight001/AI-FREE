# 项目验证接口

维护人员和自动化代理统一使用 `scripts/verify-project.js`。它是开发工具，不装入应用、不增加生产 IPC 或浏览器 MCP 权限，也不需要新依赖。标准输出只返回 JSON，进度写到标准错误。

```powershell
npm run check:project -- --list
npm run check:project -- inventory
npm run check:project -- patches
npm run check:project -- full
```

需要直接解析 JSON 时使用 `node scripts/verify-project.js full`，避免 npm 自身的命令横幅。默认不保存报告；需要留档时写到系统临时目录，勿写入仓库：

```powershell
node scripts/verify-project.js full > "$env:TEMP/ai-free-verification-report.json"
```

## 验证范围

| 分组 | 证明的内容 | 副作用与限制 |
|---|---|---|
| `inventory` | 补丁队列无重复、引用文件存在、补丁哈希及影响文件 | 不重放；未启用补丁列为警告，不推测停用原因 |
| `patches` | 在锁定 Chromium 基线上顺序重放完整队列 | 使用独立临时 Git 索引和对象目录，不改真实索引、对象或工作区；不自动获取缺失源码 |
| `source` | prepare:source、guardrails、verify | 更新 `.generated/app`；verify 内部失败后其后续阶段不会运行 |
| `tests` | 单独运行 npm test | 在源码门禁失败时继续验证测试行为；不包含覆盖率门禁 |
| `native` | 构建原生宿主、接口/DPI 测试、真实 Electron 加载 | 更新原生产物；不把空的 embed_smoke 占位测试作为证据 |
| `acceptance` | 现有 test:acceptance 与内核嵌入策略约束 | 可能创建测试窗口，沿用现有验收夹具 |
| `chromium` | 随项目内核的 Phase 3、浏览器对齐、原生工作流和媒体能力声明 | 使用已有隔离 Profile/本地页面；需要桌面环境，不等同于视频解码验收 |
| `packaged` | 已有 win-unpacked 安装资源与完整性检查 | 不重新打包，不证明产物对应当前源码 |
| `interactions` | 独立执行交互验收清单，不因一个场景失败而漏掉其他场景 | 会打开测试窗口；包含 Phase 2 默认两小时 soak；日常使用 `--only` 或流程文件选择范围 |
| `full` | 顺序执行补丁、源码、原生宿主、集成验收、真实内核和已有打包资源检查 | 测试由 verify 调用；源码门禁阻断时可另运行 tests。不构建 Chromium、不执行 build:win、不安装或测试真实公网账户 |

正式发布仍需按 AGENTS.md 执行 `npm run build:win`、`npm run check:packaged-runtime`，并按发布范围进行安装后验收。检查通过只证明该检查覆盖的行为，不能推导整个产品没有缺陷。

## 机器接口与结果语义

```javascript
const { listVerification, runVerification, runVerificationFlow, planVerificationFlow } = require('./scripts/verification/runner');
const catalog = listVerification();
const controller = new AbortController();
const report = await runVerification('chromium', {
  signal: controller.signal,
  onProgress: ({ id, status }) => { /* 更新调用方进度 */ },
});
```

只接受目录中列出的分组，不接受任意命令、可执行文件路径或额外 shell 参数。这个模块可以直接被后续的开发 MCP 适配器调用，验证逻辑不需要复制。当前交付是 CLI/JavaScript 接口，尚未注册为 MCP 服务。

可配置的验证流程、交互步骤格式、当前迁移范围和长期影响见 [交互验证流程](interactive-verification.md)。例如：

```powershell
node scripts/verify-project.js interactions --only native-workflow
node scripts/verify-project.js --flow test/acceptance/flows/project-browser.json
node scripts/verify-project.js --plan test/acceptance/flows/project-browser.json
node scripts/verify-project.js --flow test/acceptance/flows/project-pages.json
```

顶层结果为 `{ok,data}`；入口参数或执行器故障返回 `{ok:false,error}`。报告含版本、Git 提交与工作区是否有改动、开始/结束时间、每步状态、退出码、耗时、有界脱敏输出和汇总。Node 测试计数及前 40 个失败标题独立保存，不受输出尾部截断影响。`flowReports` 另存场景状态、通过步骤数及动作/观察/独立判定断言数，不保存页面值。所有步骤通过且清理成功才返回 `ok:true` 和进程退出码 0。

自定义流程报告还记录展开后的检查顺序、超时、领域、已声明的 source/generated/packaged 运行态和场景 SHA-256。Git 提交加 dirty 标记不是未提交源码的完整指纹；若要复现一次脏工作区验收，调用方仍需保存对应 diff。

- `passed`：命令退出 0，未发现 Node 测试汇总中的 skipped/todo、失败场景或清理失败标记。
- `incomplete`：命令退出 0，但测试存在 skipped/todo，不能视为完整通过。
- `failed`：命令失败；`blocked`：缺少操作系统/资源前置条件。
- `timed_out` / `cancelled`：超时或中断，执行器终止自己启动的进程树，不自动重试动作。

只识别 Node TAP/spec 标准汇总中的跳过测试；其他工具的覆盖范围仍由其自身检查定义。报告保留最后最多 6000 字符的脱敏输出，完整补丁清单使用 `npm run check:chromium-patches` 查看。

同一仓库使用系统临时目录中的独占锁，防止多个验证器同时构建。Ctrl+C 会取消当前步骤并停止启动后续步骤。临时目录正常、失败和取消退出后清理；无法确认进程释放时报告 `cleanupOk:false` 并停止后续步骤。若验证器被强制结束，需核对锁文件中的 PID 已退出，再删除属于本次运行的锁和临时目录。

同一轮中构建失败会阻断依赖该构建的检查，避免使用旧产物假装验证了本次构建。单独运行 `chromium` 时检查现有随项目资源，不自动重建内核。

纯 Electron 页面与远程 peer 只依赖 prepare；选择这些入口不执行无关的 native-build。原生窗口、输入、浏览器工具场景仍保留原生构建依赖。full 已加入源码/生成态页面、生成态 peer 和已有打包态页面/peer 检查，不包含两小时 Phase 2 soak。project-pages.json 使用同一场景分别核验三种运行态，不重新打包；某一运行态通过不代表其他运行态通过。

测试子进程不继承凭据环境变量及外部 Chromium/原型握手覆盖配置。临时文件根目录独立；具体测试资源和关闭行为仍由现有验收脚本负责。该执行器没有读取真实账号或控制已打开用户浏览器的接口。

交互清单中的 Electron 测试由 `electron-process.js` 的 Node 父进程分配临时根目录，`electron-entry.js` 在加载夹具前隔离 userData/sessionData；父进程等待 Electron 退出、释放文件锁后再删除磁盘目录。截图输出路径和打包资源覆盖环境变量不继承。相关 npm 交互入口已改用同一父进程；直接启动 acceptance 脚本不具有该保证。`accept:codex-browser` 保留命令名，改为统一选择 chromium-alignment 和 native-workflow，自动补齐 prepare/native-build；chromium/full 也明确登记这两个检查。

当前阶段状态、真实验收及既有阻塞见 [分阶段推进清单](verification-rollout.md)。现有报告只有提交、dirty 标记和场景哈希，不能据此宣称当前源码与二进制完全对应。

## 补丁真源

`native/chromium-fork/version-lock.json` 指定基线；`patches/series` 是构建所用补丁及顺序的真源。`overlay/` 未参与当前补丁应用脚本，不能据此认定它与有效队列一致，禁止把修改 overlay 当作已经更新浏览器。其历史用途仍需确认。

重放结果只证明补丁可以应用到锁定基线，不证明外部 checkout、编译 DLL、暂存资源和安装产物全部一致。`0009` 当前没有进入队列；检查会明确报告该事实，启用或删除前必须查明原因。
