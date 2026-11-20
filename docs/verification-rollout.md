# 统一验证架构分阶段推进

采用“统一验证契约＋领域驱动＋独立判定”。本表区分实现、真实行为验证和项目门禁；某一场景通过不能替代其余阶段。最后核对：2026-11-20。

## 阶段与完成条件

| 阶段 | 交付与验收条件 | 当前状态 |
|---|---|---|
| 1：统一契约与执行边界 | 一个领域能力真源；list/plan/run；场景预检与快照；取消不重放写操作；有界证据；资源逆序释放，Electron 退出后清磁盘 | 已实现。验证工具测试与日常源码门禁通过 |
| 2：浏览器领域场景 | 对齐、工作流、remote peer 使用可替换 JSON；保留原断言；直接读回关键副作用；真实内核执行 | 对齐 36 步和工作流 21 步已通过；peer 路径已修复，源码/生成态/新打包态各 4 步通过；2.6.53 重新打包与独立资源检查通过 |
| 3：Electron UI 与运行态 | 主窗口、AI 页、账号页各有明确夹具和领域驱动；动作与 DOM 判定分离；覆盖首次加载、导航、关闭重开和显隐；源码、生成态、打包态分别验证 | 部分落地。首页栏目与个人中心偏好已迁移，源码、生成态、打包态共用场景。browser-settings-ui 保留侧栏、任务栏等其他固定验收 |
| 4：原生生命周期与故障恢复 | 原生窗口、输入、Phase 3、存储和媒体采用各自领域；覆盖失败、取消、进程退出、恢复；记录源码/Host/Chromium/扩展指纹 | 待迁移。保留低层 trusted 输入与协议拒绝检查，不以高层点击代替；Phase 3 品牌断言阻塞尚在 |
| 5：有界探索与 MCP 适配 | 复用领域动作生成有种子、可缩减的状态序列及受约束组合；MCP 仅适配同一 list/plan/run；验证取消、错误和证据兼容 | 待实现。目前只有 CLI/JavaScript 接口，没有注册 MCP 服务，也没有随机测试框架依赖 |

每阶段通过后再扩大范围。保留 `schemaVersion:1` 的既有含义，新增领域能力采取显式扩展；旧普通函数映射 API 保持兼容。业务工作流仍由生产执行器负责，JSON 不增加脚本、循环或未知结果的自动重试。

## 首页业务交互增量

2026-11-20，首页和个人中心偏好迁移至 `home-workspace.json` 和 `account-preferences.json`。首页覆盖栏目、键盘导航、Cookie 编辑框与焦点恢复。个人中心覆盖登录和注册表单切换、设置按钮、关闭方式、开机启动、主进程状态读回、重载恢复。两条场景分别为 18、17 步。监听页面及 preload 使用实际产品代码，偏好写入使用隔离夹具状态。验收还覆盖 AI 表单触发个人中心、侧栏草稿保持和 MCP 配置复制请求。

项目入口为 `node scripts/verify-project.js --flow test/acceptance/flows/project-business-ui.json`。源码及生成态共 5 项通过，打包态另有 5 项通过，包括两条业务流程、页面资源、远程 peer 和准备步骤。两份报告的 cleanupOk 均为 true。

修复测试读取账号会话时落到默认用户数据路径的问题，隔离账号会话、旧数据迁移及存储目录。源码构建测试改用独立临时目录，避免覆盖率或并行验证清理共享生成目录。原有过期结构检查按现行入口更新，业务预期由真实页面验收执行。guardrails 零超限。verify 包含架构检查、全量测试 876 项及覆盖率复跑 876 项，均通过。通用验收通过。2.6.53 重新构建与独立打包资源检查通过，未安装。

原生对齐 36 步和原生工作流 21 步用本轮已构建的 Host 通过。较晚复跑时，开发版 Electron 占用 Host，统一入口的重新编译报 LNK1104，因此两项原生场景改用同一隔离夹具独立执行。日志为 `ai-free-business-native-existing.txt`。

Phase 3 仍在首个导航请求的 Sec-CH-UA HTTP 头与自定义品牌不符处失败。页面读取同一自定义品牌已通过，应独立排查发送时序和内核行为。0052 的补丁上下文和块计数已按前序补丁的实际输出重建。59 个有效补丁在隔离索引中完整重放通过，未重新编译 Chromium。下方较早构建和失败记录保留供追溯。

本机报告位于系统临时目录。`ai-free-business-current-flow.json` 记录源码和生成态，`ai-free-business-packaged.json` 记录打包态，`ai-free-business-verified.txt` 记录代码门禁和覆盖率。`ai-free-business-final-acceptance.txt` 记录通用验收，`ai-free-business-patches-fixed.json` 记录补丁重放。

## 关闭应用后的重新打包复核（早期记录）

2026-11-20：用户关闭应用后，native-build 已成功，原 Host 文件占用解除；接口/DPI 两项测试和 Electron 40 真实加载通过。统一执行器重新执行 prepare、native-build、alignment 36 步和 workflow 21 步，全部通过，报告 `ai-free-rebuilt-host-flows-20261120.json`。

build:win 前两次继续在清理旧 win-unpacked 时遇到 EPERM。对 app.asar 的独占只读打开报文件共享冲突，Windows Restart Manager 的只读查询定位到 WorkBuddy.exe（PID 29288）。用户随后自行关闭 WorkBuddy，文件占用解除；重新执行 build:win 成功，重新生成完整 win-unpacked 与 2.6.53 NSIS 安装包。

新包独立 check:packaged-runtime 通过，原有 navigator.js 缺失已消除。project-pages 的 prepare、三种运行态 peer、三种运行态页面共 7 项检查全部通过，cleanupOk=true。安装包位于 `appbuild/AI-FREE Setup 2.6.53.exe`，286584262 字节，SHA-256 为 `5D6C34693E7B1701BE4589F13B7270B087F04275832A4DCFD9A88866D4A5AD60`；源码与打包态 Host SHA-256 均为 `000AFABA2944815C4AA550DDBD976A8A5396F1277C1F5F2D66F3D207A4BFF89D`。未安装或运行安装后的真实用户会话。

最新构建、独立资源检查、流程报告分别为系统临时目录中的 `ai-free-stage23-rebuild-after-workbuddy-20261120.txt`、`ai-free-stage23-new-package-runtime-20261120.txt`、`ai-free-stage23-new-package-pages-20261120.json`。再次执行通用 test:acceptance 仍在 browser-settings-ui 的 unifiedExtensionWraps/unifiedExtensionCardCapped 布局断言失败，后续存储检查未由该链执行；日志为 `ai-free-stage23-postpackage-acceptance-20261120.txt`。重新打包阻塞已解除，全项目门禁尚未通过。

## 第二、三阶段增量验证

本次改动修复生产 peer 的页面路径，将路径真源放入 backend/config/paths.js。回归测试先在旧实现报 ENOENT，再验证修复；保留显式 viewPath 和关闭重建兼容。未更改 UI DOM、生产 IPC 或业务操作语义。

新增 electron-pages 领域及 applicationLayout、窗口夹具、具名只读探针；原 packaged-sidebar 脚本的 Logo、个人中心、主窗口控件断言移入同一 JSON 场景，增加返回、关闭、重开及独立窗口读回。源码、生成态、已有打包态分别执行，不以 source 通过替代 package 通过。场景只允许页面 ID，不接受 JavaScript 或可执行路径。

纯 UI 与 peer 不再依赖 native-build；原生场景继续保留构建依赖，避免一个原生文件占用扩大为全部交互无法验证。计划报告新增明确 runtime 字段；full 已包含新增运行态检查。

| 检查 | 2026-11-20 增量结果 |
|---|---|
| 最小相关测试及资源/主窗口检查 | 39 项通过，0 失败，0 跳过；覆盖假成功读回、页面错配/意外导航、关闭重开和三种运行态布局 |
| 全量 npm test | 879 项，873 通过、6 失败、0 跳过；失败标题与上阶段相同，cleanupOk=true |
| project-pages 流程 | 新包复验共 7 项通过、0 失败，cleanupOk=true；包括 prepare、源码/生成态/打包态 peer 与页面 |
| 页面独立判定 | 三种运行态各 17 步、9 个动作断言、22 个独立判定断言；覆盖首次加载、三页切换、返回、关闭重开 |
| guardrails / verify | 仍被原有 6 个类型错误及 1 个文件、1 个函数、5 个复杂度超限阻断；本次新增类型问题已修复，没有增加基线或例外；verify 的后续架构/测试/覆盖率链未运行 |
| test:acceptance | 远程 peer 已通过；继续运行到 browser-settings-ui 的扩展卡片换行/宽度既有断言失败，后续存储未由此链运行 |
| build:win | Host 与 WorkBuddy 文件占用解除后通过，已产出包含修复的 2.6.53 安装包 |
| check:packaged-runtime | 新包独立检查通过，资源完整；与页面资源场景分别验证 |
| accept:chromium-phase3 | 已运行，仍在 UA Client Hints 的 AI-FREE Test 品牌断言失败 |

本机系统临时目录中的增量报告：

- `ai-free-verification-stage23-pages-final-20261120.json`：六个运行态检查和依赖、领域、runtime、场景哈希。
- `ai-free-verification-stage23-tests-20261120.json`、`ai-free-stage23-focused-20261120.txt`：全量和聚焦测试。
- `ai-free-stage23-guardrails-final-20261120.txt`、`ai-free-stage23-verify-final-20261120.txt`。
- `ai-free-stage23-acceptance-20261120.txt`、`ai-free-stage23-build-win-20261120.txt`、`ai-free-stage23-packaged-runtime-20261120.txt`、`ai-free-stage23-phase3-20261120.txt`。

页面资源场景使用无业务 preload 的隔离窗口；成功仅证明对应页面资源、原有结构预期及夹具窗口生命周期。不能推导真实应用中的表单保存、登录导航、业务订阅恢复或侧栏遮挡已经通过。下一步需逐段迁移 browser-settings-ui，并保留独立 IPC 读回和真实宿主生命周期；不得把它当前的布局失败通过放宽断言消除。

## 第一、二阶段历史验证

| 检查 | 实际结果 |
|---|---|
| 验证工具相关单测 | 25 通过，0 失败，0 跳过；包含假成功被读回识别、取消、隔离、清理失败、证据截断与计划预检 |
| 全量 npm test | 874 项，868 通过，6 失败，0 跳过。6 个失败标题与本轮扩展前一致 |
| native-build | 较早本轮构建通过；最终复验 LNK1104，正在运行的开发应用 PID 20568 加载该 browser_host.node，未关闭用户应用。统一执行器阻断依赖该失败构建的检查 |
| 原生浏览器最终行为复验 | 使用此前成功构建的现有 Host，经隔离父进程分别运行：alignment 36 步通过（18 动作、21 观察、4 独立判定断言）；workflow 21 步通过（18/8/2）。这不表示最后一次构建成功 |
| guardrails | 失败：既有文件超限 1、函数超限 1、复杂度超限 5、类型错误 6；未放宽零基线 |
| verify | lint 无 error；在既有 6 个类型错误处退出，后续架构/测试/覆盖率阶段未由该命令运行；全量测试另行执行 |
| test:acceptance | 扩展、握手、runtime、observe 部分通过；在 remote peer 的 ERR_FILE_NOT_FOUND 失败，后续 UI 和存储未由此链执行 |
| accept:chromium-phase3 | 失败：UA Client Hints 品牌与 AI-FREE Test 预期不符；进程正常结束，没有清理失败标记 |
| 格式检查 | git diff --check 通过 |

本轮较早独立交互报告还记录 session-storage 通过。上述历史记录中的 packaged-sidebar 旧源码路径、安装资源缺 navigator.js 已在第二、三阶段修复并由新包验证；browser-settings-ui 布局断言、0052 补丁格式错误仍需分别整改，不通过改断言或回退系统浏览器绕过。

全量测试的 6 个失败为账号生命周期元数据、账号缺失/删除稳定结果、新对话空白页、真实 Electron 侧栏主题、个人中心设置布局、无扩展目录的打包兼容。类型错误位于 network-magic-popup-controller.js 与 external-codex-link.js；详情保存在下列本机报告。

本机报告均在系统临时目录，不加入仓库：

- `ai-free-verification-stage12-tests-20261120.json`：全量测试。
- `ai-free-verification-stage12-20261120.json`：此前构建成功及对齐/工作流/peer/存储结果。
- `ai-free-verification-stage12-final-native-20261120.json`：最终构建失败及依赖阻断。
- `ai-free-stage12-final-alignment.txt`、`ai-free-stage12-final-workflow.txt`：最终场景行为复验。
- `ai-free-guardrails-stage12-final-20261120.txt`、`ai-free-verify-stage12-final-20261120.txt`。
- `ai-free-stage12-final-acceptance.txt`、`ai-free-stage12-final-phase3.txt`。

第一、二阶段记录时尚未执行 build:win；第二、三阶段现已完成重新打包，见上方最新复核。仍未重新安装、运行两小时 Phase 2 soak 或安装版真实会话验收。报告包含提交、dirty 标记和场景哈希；本次另记录安装包与 Host 指纹，但未提供完整未提交源码/全部二进制指纹，不能据此证明所有输入完全对应。

## 清理限制

本轮最终各次运行未报告清理失败；全量测试及较早统一交互报告 cleanupOk 为 true。早期旧生命周期实现失败曾保留 `C:\Users\admin\AppData\Local\Temp\ai-free-verification-UIDdxp`，其关联浏览器 PID 76200 已确认退出。自动审批拒绝了该精确目录的删除，仅返回 `blocked by policy`，未提供详细原因；该目录仍保留，没有尝试其他通道绕过拒绝。

2026-11-20 收尾复核：该目录仍包含早期夹具缓存及场景副本，不能标为已清理。第二、三阶段最新测试和页面流程报告均为 cleanupOk=true，未发现携带测试 electron-entry 或隔离 fixture 标识的 Electron 进程。未修改 Codex 全局配置或审批策略以绕过既有拒绝，也未关闭正常运行的用户应用。文件占用与审批拒绝是两个独立问题：前者已由用户关闭应用解除，后者仍阻断上述历史目录删除。

## 维护效果的判断依据

持续记录增加场景需要修改的文件/脚本行数、无业务改动时的偶发失败率、定位耗时、失败/超时后的残留资源数。资源作用域与领域声明仅提供机制，不能自动证明判定独立或安全并行；并行前还需隔离构建产物、桌面焦点和原生 Host。先依据实际维护数据决定是否增加依赖和基础设施。

用法及职责真源见 [项目验证接口](project-verification.md) 和 [交互验证流程](interactive-verification.md)。
