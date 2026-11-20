# 交互验证流程与迁移边界

目标是把夹具、交互参数和验收断言分开，让新维护者能从一个入口找到测试范围，而不是为每个变体复制脚本。当前已登记交互入口可统一编排；步骤级 JSON 已迁移原生浏览器对齐、原生工作流、远程 peer 、应用页面、首页栏目和个人中心偏好六个场景，覆盖五个领域。其他脚本内部仍有固定序列，不能称为全量迁移完成。阶段状态及验收条件见 [分阶段推进清单](verification-rollout.md)。

## 使用入口

```powershell
# 列出范围、是否支持步骤配置、手动前置条件
node scripts/verify-project.js --list
# 单独验证真实 Chromium 工作流（自动补齐 prepare/native-build）
node scripts/verify-project.js interactions --only native-workflow
# 按文件指定检查顺序，并替换已支持的交互场景
node scripts/verify-project.js --flow test/acceptance/flows/project-browser.json
# 只校验并展开计划，不启动构建或交互进程
node scripts/verify-project.js --plan test/acceptance/flows/project-browser.json
# 页面与远程 peer：分别检查源码、生成态和已有安装包
node scripts/verify-project.js --flow test/acceptance/flows/project-pages.json
# 真实 Electron 首页与个人中心，验证源码与生成态
node scripts/verify-project.js --flow test/acceptance/flows/project-business-ui.json
# 使用重新打包后的 ASAR 运行同一场景
node scripts/verify-project.js interactions --only home-workspace-packaged,account-preferences-packaged
```

`project-browser.json` 是验证流程示例，包含四个检查。`checks[].id` 只能引用清单；`scenario` 相对流程文件目录解析。执行器在启动进程前读取、校验所有场景，补齐依赖，冻结成本轮临时副本；配置错误不会在构建后才被发现。可直接调用 `runVerificationFlow(flow, {baseDirectory, signal, onProgress})`；`planVerificationFlow(flow, {baseDirectory})` 返回检查顺序、超时、领域、独立判定要求及场景 SHA-256，后续 MCP 只需要做协议适配。

没有命令、脚本路径、任意环境变量、eval 或任意 JavaScript 步骤。未知字段、未知驱动、重复 ID、向前引用、不支持的版本都拒绝。流程和场景均用 `schemaVersion:1`；今后扩展必须显式兼容版本，不能悄悄改变旧场景含义。

## 三个明确职责

| 层 | 真源 | 职责 |
|---|---|---|
| 验证编排 | `scripts/verification/catalog.js`、`interactions.js`、`plans.js` | 允许哪些检查、依赖、进程超时、选择范围、状态汇总 |
| 交互场景 | `test/acceptance/flows/*.json` | 步骤顺序、参数、预期失败与业务断言；不持有窗口、进程、端口 |
| 夹具与窄驱动 | `test/acceptance/scripts/`、`test/helpers/flows/` | 创建隔离页面/窗口、调用被测接口、读取证据，并在 finally 释放资源 |

`test/helpers/flows/runner.js` 只顺序调用注入的测试驱动并检查结果，不实现页面定位、业务探针、暂停恢复、分支或重试。页面工作流仍调用应用的 `browser_workflow`，复用它现有的卡片执行器。没有修改生产自动化语义，也没有给应用新增调试接口。

领域能力以 `test/helpers/flows/domains.js` 为唯一真源：声明操作名、action/observation/oracle 类别及独立判定要求。预检和夹具绑定共同使用该契约，缺少/多出驱动或缺少 oracle 步骤时，在执行动作前拒绝。`schema.js` 校验场景和引用图，`assertions.js` 定义断言，`values.js` 处理安全引用与快照，`runner.js` 负责执行。原有普通函数映射调用保持兼容；标注领域的正式场景必须满足领域契约。

`resources.js` 按逆序释放已登记资源，部分初始化失败也会尝试全部释放，重复关闭无副作用。`electron-process.js` 的 Node 父进程拥有磁盘目录；`electron-entry.js` 在加载夹具前设置独立 userData/sessionData，Electron 完全退出后才由父进程删除目录，避免退出钩子过早删除仍被锁定的存储。

场景步骤示例：

```json
{
  "id": "ready",
  "use": "browser_wait",
  "args": {"selector": "#project", "condition": "visible", "timeout_ms": 5000},
  "expect": [{"path": "success", "op": "equals", "value": true}]
}
```

参数及预期值可用 `{"$ref":"input.url"}` 或 `{"$ref":"observed.observationId"}` 引用输入/之前的输出；保留数字、布尔、数组类型，不做字符串模板拼接。驱动不能通过引用修改之前的结果。断言支持 equals/includes/oneOf/exists/truthy，每一步至少一个断言。空断言不等于成功。

失败报告保留步骤 ID、阶段、断言字段/操作和受限错误码，不序列化页面值、图片或异常原文。需要更丰富证据时，由被测系统的脱敏诊断报告提供，不把整页结果复制进测试报告。场景应只包含人工构造数据，不能保存凭据。

进程报告中的 `flowReports` 单独保留场景 ID、状态、通过步骤数和 actionAssertions/observationAssertions/oracleAssertions，不受日志尾部截断影响。场景失败或清理失败即使进程退出 0 也判失败。oracle 分类代表受审查的驱动职责，不能自动证明独立性：浏览器判定绕过动作/工作流成功标记直接读回 runtime，但仍共享内核，底层协议和 trusted 输入验收继续保留。

## 当前覆盖与待迁移部分

`interactions.js` 登记现有全部交互验收脚本；单测会检查 acceptance/scripts 下新增文件必须被归类。普通单元/集成测试中的模拟点击仍由 `tests` 分组运行；不能为了“统一”让 mock 测试依赖真实桌面。

| 入口 | 当前支持 | 下一步拆分依据 |
|---|---|---|
| native-workflow | 21 个 JSON 步骤和独立状态回读；支持自定义场景 | 保持浏览器工具驱动，不复制生产工作流算法 |
| remote-browser-peer / generated / packaged | JSON 的启动、offer、帧、ready；事件读回作为 oracle，finally stop | 源码、生成态与重新构建的 2.6.53 打包态均真实执行通过 |
| chromium-alignment | 36 个 JSON 步骤；导航、AX/PNG、输入、旧引用拒绝、切换/关闭 | 独立读回点击次数、isTrusted、输入值与标签数；保留相邻底层验收 |
| home-workspace / account-preferences | 真实 Electron 页面和 preload，共用源码、生成态和打包态 JSON 场景 | 从 DOM 回读栏目、编辑框焦点及表单状态，从隔离的主进程夹具回读设置写入，并验证重新加载后的显示 |
| browser-settings-ui | 复用首页和个人中心偏好场景，保留其他交互检查 | 其余固定操作继续按业务行为迁移 |
| source-pages / generated-pages / packaged-sidebar | 共用 application-pages.json 的 17 步和 electron-pages 领域；保留原页面断言，增加切换返回、关闭重开及窗口读回 | 当前为不加载业务 preload 的页面资源/结构验收，不能替代真实 IPC、业务表单、侧栏导航与主窗口/侧栏遮挡验收 |
| embed-smoke / chromium-phase2 | 可独立编排；内部仍为原生生命周期序列 | 生命周期状态驱动；Phase 2 默认 500 次切换和两小时 soak |
| chromium-input / chromium-phase3 | 可独立编排；内部仍为底层输入/协议序列 | 使用原生输入、Profile、文件和协议专属驱动，不能全部改成高层点击 |
| session-storage / chromium-media | 可独立编排；内部仍为专属 API 检查 | 存储和能力声明保留专属断言，不冒充用户交互 |
| installed-mcp | 只列出，自动流程不运行 | 需要明确安装入口及独立测试浏览器；不得自动连接日常会话 |

流程化迁移顺序：先浏览器工具场景，再三个 UI 宿主，最后原生输入/生命周期。每个场景迁移前记录原断言及资源所有者，迁移后检查没有丢失失败、恢复或副作用验证。旧脚本在内部改为调用同一场景后才删除固定序列，不同时保留两套业务断言。不能仅将旧脚本包装一层就标记 configurable。

远程 peer 的路径错误已修复：由 backend/config/paths.js 解析 backend/views 下的唯一页面，显式 viewPath 覆盖保持兼容。remote-browser-peer、remote-browser-peer-generated、remote-browser-peer-packaged 使用同一场景，分别加载各运行态的真实 controller；三个运行态均已通过，新包验证独立于源码测试。

electron-pages 只允许 ai/account/shell 页面标识和具名只读 probe，场景不能注入路径或 JavaScript。applicationLayout 集中选择三种资源布局；保留旧脚本显式 SIDEBAR_HTML_PATH/PACKAGED_APP_DIR 覆盖，但前者报告为 override，不能冒称打包态。统一执行器不继承这些覆盖变量。场景持有应用生命周期，最后一个测试窗口关闭后仍可重建，结束时移除 window-all-closed 监听；这只服务测试，不改变产品的退出行为。

## 二阶、三阶影响与约束

| 决策 | 直接结果 | 后续影响与约束 |
|---|---|---|
| 复用应用浏览器工具 | 验收走真实用户路径 | 公共执行器错误可能同时影响操作和“成功”判定；保留独立 runtime 状态回读，以及底层协议拒绝/isTrusted 测试 |
| 声明式场景 | 变体无需复制脚本 | 容易演变成第二门编程语言；不加入循环、脚本表达式、隐式配置、自动重试，复杂夹具留在具名驱动 |
| 不自动重放 | 超时后不会重复提交 | 某些瞬态失败会更常显现；只有被测 workflow 的 resume 在业务状态核验后继续，测试执行器本身不猜测动作是否执行 |
| 配置前置校验与依赖展开 | 避免边运行边发现格式问题、使用失败构建的旧产物 | 依赖关系成为维护契约；新入口必须声明依赖，不能靠清单偶然排序 |
| 独占锁、进程串行、隔离存储 | 不抢构建产物、不使用用户 Profile | 速度较慢；未来并行必须先隔离构建目录、桌面焦点和原生 Host，不能直接增加 worker 数。纯 Electron UI 不依赖 native-build，原生场景继续要求构建 |
| 分别执行交互入口 | 一个失败后仍能得到其他模块结果 | 比原 npm && 链覆盖更多，也增加运行时间；日常按 --only/流程选择，发布才执行完整范围 |
| 有界、脱敏报告与场景哈希 | 代理可解析并复查输入版本 | 不能靠报告复原页面秘密；失败详细证据应走现有诊断渠道，保留策略须由调用方明确指定 |
| 保留源/生成/打包态区分 | 不把旧包通过当作新源码通过 | 资源变更仍需 build:win 与 packaged-runtime；流程不会替代发布门禁或自动安装 |

原生工作流迁移发现的旧测试漂移已修正：显式传 probes/identity；报告展开使用 include_details；操作产生新观察后旧引用必须拒绝，重新按稳定 locator 点击；项目身份变化单独关闭页面稳定等待，避免 100ms 同时承担两类断言。延迟动作仍验证只点击一次、片段总数为 2，再恢复后续导出步骤，没有通过降低业务预期消除失败。

## 验证记录与阻塞

当前实际结果、报告位置、未运行范围及清理限制统一记录在 [分阶段推进清单](verification-rollout.md)，避免在多个文档重复维护易漂移的数字。当前不能宣称全项目通过或所有交互步骤已经迁移。

## 跨领域设计选择

以下是依据其他领域的成熟方法作出的本项目设计判断；只借鉴机制，当前不引入这些工具依赖或新服务。

| 参考领域 | 取用的机制 | 在本项目中的取舍 |
|---|---|---|
| Terraform 计划与执行分离 | 先解析/验证/展开，再按确定计划执行 | 已实现配置前置校验、依赖展开、场景快照和哈希；下一步补全未提交源码、DLL/native host、扩展与夹具指纹 |
| Bazel hermeticity | 隔离环境、明确输入身份 | 已隔离交互 Electron 存储和临时目录；生成态/打包态仍应各自成为夹具，不能用源码通过替代 |
| Playwright fixtures | 按依赖创建资源，并按所有权销毁 | 已增加资源作用域和父进程磁盘所有权；安全并行仍需隔离构建、桌面焦点和原生 Host |
| Temporal Activity 幂等约束 | 区分流程协调与可能重复执行的副作用 | 不自动重放未知结果；把按钮提交、导出、文件写入视为需核验的动作，恢复策略由领域执行器负责 |
| Hypothesis stateful testing | 以动作、前置条件和不变量探索序列 | 后续用已存在驱动生成有界操作序列、记录种子、缩减失败序列；不把循环/随机表达式塞进 JSON 场景语言 |
| NIST 组合测试 | 用 t-way 覆盖减少参数全排列 | 后续按有效约束生成页面、运行态、缩放和故障维度组合；关键发布链路仍保留明确全流程，不能把两两覆盖当作完整证明 |

推荐的长期契约由五部分构成：输入身份、资源所有者、动作及前置条件、独立判定器、清理与证据。CLI、CI、未来 MCP 都调用同一验证接口。动作返回 success 只能作为一项证据；至少对关键副作用同时读取业务状态，例如点击一次且新增片段一次。未来状态机模型只保存测试所需的最小状态与不变量，避免复制生产业务实现。

判定收益时记录四类指标：新增场景需要修改的文件/脚本行数、无业务变更时的偶发失败率、失败定位耗时、失败/超时后的残留资源数。先获得基线，再决定是否引入生成式测试依赖或并行基础设施；不能用 JSON 文件数量证明维护成本下降。

参考原始资料（2026-11-20 查阅）：Terraform plan 命令、Bazel Hermeticity、Playwright Fixtures、Temporal Activity Definition、Hypothesis Stateful tests、NIST Combinatorial Testing。在线来源见本轮设计说明的引用。
