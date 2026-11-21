# HeySure 自动化卡片：设计与运行机制

本文梳理 HeySure AI 2.0「自动化卡片」的产品模型、编辑面板、流程定义与服务端运行机制，供在 AI-FREE-app 或其它产品中设计类似自动化工作流时参考。描述对象是 `deploy/web` 的工作坊自动化卡片及 `deploy/server` workflow runtime；它与 AI-FREE-app 本地浏览器自动化工作区不是同一套定义/执行器。两者可以借鉴交互与治理思路，但不能默认共用 JSON 或运行时。

## 1. 产品模型

自动化卡片是一个可复用、可授权、可版本化的**声明式流程**，不是任意代码，也不是只保存 UI 坐标的宏。卡片定义描述：

- 输入：JSON Schema 描述调用方需要提供的参数、类型和默认值。
- 节点：MCP 调用、条件、延迟、AI 处理、引用另一张卡片或结束节点。
- 连线：显式定义下一步、错误、条件真/假等跳转目标；可用有界回边表达循环。
- 输出：从输入、运行上下文和已完成步骤结果映射出最终结果。
- 运行限制：总超时、最大转换次数、结果大小等上限。
- 治理信息：名称、描述、标签、风险等级、访问范围、允许使用的 AI 配置、默认设备。
- 工具合同：发布时快照 MCP 工具的设备、schema digest、输入 schema 和 provider 等信息，避免运行依赖不断变化的工具清单。

流程语义是执行合同；画布布局只是编辑器偏好。节点 ID 与边决定运行路径，`editor_layout.positions` 只保存坐标，不决定运行顺序。运行时不根据节点视觉位置猜测顺序。

## 2. 信息架构与用户流程

自动化面板有两个主要视图：

| 视图 | 用途 | 主要操作 |
|---|---|---|
| 卡片 | 查找与管理可运行流程 | 搜索名称/描述/标签、按状态筛选、新建、编辑、复制、导入/导出、运行 |
| 运行记录 | 观察执行与处理故障 | 查看运行状态与步骤、查看 AI 审核记录、取消、重试 |

常见路径：卡片列表 → 新建或打开编辑器 → 配置元数据/设备合同 → 编排节点 → 配置节点 → 保存/发布新版本 → 运行时填参 → 在运行记录跟踪每一步。

“编辑定义”和“启动一次运行”是两个不同动作。运行输入不混入卡片定义；同一版本可接受多次不同输入。运行弹窗可根据 `inputSchema.properties` 生成示例 JSON，并提供可选默认设备覆盖。

## 3. 编辑器面板

编辑器是宽屏优先的模态工作区，支持普通最大宽度和全屏。由上到下分为：

1. **标题栏**：卡片名称/编辑状态、全屏切换、关闭。
2. **反馈区**：校验、保存、加载设备工具等错误/成功提示；错误应指出节点并引导定位。
3. **卡片设置**：名称、描述、标签、访问范围、允许的 AI 成员、风险等级、输入 schema、超时/最大转换数、输出映射等。
4. **流程画布**：节点、分支连线、入口、工具栏和属性检查器；卡片设置与跨设备 MCP 设置从画布浮层打开。
5. **版本区**：历史版本入口，以及历史画布与当前草稿对比。
6. **底栏**：删除/复制/导出，以及舍弃修改、保存新版本/创建卡片。

### 3.1 画布交互

- 通过“添加节点”创建节点，新节点放在当前画布附近并自动选中。
- 单击节点选中，侧边属性检查器编辑配置；不要在节点卡片内部塞入长表单。
- 从输出端口拖到另一节点建立有向边。条件节点有 `true`、`false` 两个端口，错误出口可单独连接。
- 连线可选中和断开；非法目标/边由编辑器和后端校验拒绝。
- 节点可拖动，画布可平移和缩放；支持触控拖动/双指缩放。pointermove 更新用 `requestAnimationFrame` 合并。
- 支持键盘撤销/重做、复制/剪切/粘贴和删除；复制节点生成新 ID，并正确处理入边和入口恢复。草稿历史不等于服务端运行历史。
- 画布位置单独持久化，不创建执行定义版本；定义变化保存为新版本。
- 结束节点是流程语义，不必占据主要画布空间。

### 3.2 节点检查器

公共字段包括标题、类型、设为入口、删除。类型特有配置按需出现：

| 类型 | 检查器内容 | 执行语义 |
|---|---|---|
| MCP | 设备、工具、参数、输出变量、超时、重试/退避、结果投影、成功/失败去向 | 对指定设备执行受 schema 约束的工具调用 |
| 条件 | 安全表达式、真/假去向 | 计算布尔表达式，不执行任意代码 |
| 延迟 | 等待秒数、后继节点 | 持久化唤醒时间，到期再推进 |
| AI | Prompt、输出变量、后继节点 | 等待 AI 交互结果后继续或失败 |
| 引用卡片 | 卡片及固定版本、输入映射、结果映射、嵌套限制 | 以受控嵌套帧运行另一张可访问卡片 |
| 结束 | 输出映射 | 生成最终输出并进入成功终态 |

MCP 工具选项来自所选设备上报的工具目录；选择工具后依据 `input_schema` 生成参数模板。复杂 schema 可提供 JSON 编辑，同时给出字段提示。切换设备后刷新合同并重新验证旧工具与参数，不能沿用另一设备的 schema。

### 3.3 设备合同设置

卡片默认设备是默认值/运行覆盖依据，不应覆盖节点显式绑定。每个 MCP 节点可绑定独立设备，支持跨设备流程。保存时只冻结定义实际引用的设备和工具；在线设备全集不等于版本依赖全集。运行弹窗如提供设备覆盖，需说明受影响节点及覆盖优先级。

### 3.4 草稿、保存、版本

- 打开时把服务端定义映射为 UI draft；临时编辑状态留在草稿。
- 保存前做本地快速检查（MCP 设备/工具必选、JSON 可解析）；服务端 compiler 做权威校验。
- 保存创建不可变定义版本，包含递增版本号、definition digest、工具合同、发布者/时间。每个 run 固定 `card_version_id`，后续编辑不改变已启动运行。
- 历史版本预览不隐式写回当前定义；回滚应显式创建新版本。Clone 创建独立卡片及权限边界；Import 必须重新校验，不能信任文件声明的合同、权限或状态。

## 4. 流程定义与校验

定义采用版本化 JSON（当前 workflow Schema v1）。示意：

```json
{
  "schemaVersion": 1,
  "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
  "startStepId": "search",
  "steps": {
    "search": {"type": "mcp", "toolRef": {"namespace": "device", "deviceId": "device-1", "name": "browser.search"}, "arguments": {"query": "${input.query}"}, "saveAs": "search_result", "next": "finish"},
    "finish": {"type": "end"}
  },
  "limits": {"timeoutSeconds": 300, "maxTransitions": 500},
  "output": {"items": "${steps.search_result.result.items}"}
}
```

模板变量使用显式命名空间，如 `${input.query}`、`${steps.search_result.result.items}`、`${run.id}`、`${device.id}`。未完成或不存在的结果路径应报错，不应静默替换为空。表达式采用白名单运算符（比较、exists、contains、startsWith/endsWith、and/or/not 等），禁止 eval/任意脚本。

权威校验至少覆盖：Schema/节点 ID/节点类型；起点、目标边、分支和可达终态；模板路径安全与变量可用性；表达式白名单；输入及工具参数 schema；设备/工具合同 digest；重试、单步和总超时、最大转换、嵌套深度、结果大小；敏感字面值扫描；访问权限和引用卡片权限。

画布负责即时易读的 UX 校验，服务端 compiler 是安全边界。导入、API、AI 管理等所有入口必须走同一权威校验器。

## 5. 端到端运行逻辑

### 5.1 启动

1. 前端收集输入 JSON、幂等键、可选设备覆盖和可选版本。
2. Gateway 校验认证和卡片访问，调用 workflow service。
3. 服务端检查可运行状态、版本归属、访问权限、嵌套卡片权限、设备权限及 `inputSchema`。
4. 按幂等键查已有 run，防止请求重试重复创建。新 run 绑定卡片版本、actor、输入、入口、全局 deadline 和初始变量。
5. 返回 run 快照。前端转到运行记录，读取步骤明细与 AI review，并通过事件/轮询刷新。

### 5.2 推进与派发

Connector 的持久 scheduler 周期性补偿和推进：

1. 选取到达 `next_wakeup_at` 的待运行 run，按固定版本定义推进。
2. 条件节点计算真/假边；延迟节点写入唤醒时间；AI 节点建立待处理交互；结束节点计算输出并成功结束。
3. MCP 节点解析模板、校验参数 schema，写入 StepRun 和待派发任务。稳定 task ID 与 claim owner/claimed_at 用于防重和并发回收。
4. 统一 dispatch 把单个工具任务发给已注册设备。设备只执行工具并回传，不负责流程编排或 AI 推理。
5. run 进入 `waiting_device`。结果到达后 reconcile dispatch/step；成功结果经投影和大小限制后保存变量并沿成功边继续；失败按 retry policy 重试、走错误边或终止。
6. 设备离线时进入 `paused_offline` 并有限重试；节点和整流程 deadline 到期则进入超时终态。

### 5.3 状态与失败语义

Run 状态包括 `pending`、`running`、`waiting_device`、`retry_wait`、`paused_offline`、`waiting_ai`、`paused`，终态为 `succeeded`、`failed`、`cancelled`、`timed_out`。StepRun 另有 attempt 和派发状态，不能只靠一个 run 状态表达所有诊断信息。

- 状态转换由事务完成并核对当前状态，迟到设备回包不能复活终态。
- 节点重试由 `maxAttempts` 与 fixed/exponential backoff 控制，仍受 deadline 限制。
- 取消 run 时取消未执行 dispatch 与待处理交互，并标记 step；重复取消幂等。
- 用户“重试”创建独立新 run，明确复用的版本/输入；外部副作用可能已发生，不能假装为安全续跑。
- 错误包含机器可读 `code`、`phase`、`retryable`；UI 显示用户可读摘要。
- 调度器重启依靠持久化状态、deadline、wake-up、dispatch 状态恢复，不依赖进程内队列。
- 并发 scheduler 需要原子 claim/锁版本/租约；按钮禁用不能代替并发控制。

## 6. 运行历史 UI 与数据安全

运行历史提供状态筛选、卡片/设备/时间定位，显示创建时间、耗时、当前节点、转换数、版本、输入摘要、输出或错误。展开后逐 step 显示 attempt、工具、设备、起止/截止时间、投影结果和错误。等待设备、等待 AI、离线暂停、重试等待必须有不同状态表达。

输入和结果做敏感字段脱敏；大结果用引用或受限投影，不塞入列表；禁止记录 Cookie、Authorization、密码、Token。AI review 单独呈现决策状态、风险摘要和过期时间。

## 7. 组件/API/存储职责

- **Card API**：列表/详情/创建/更新/删除/clone/import/export、layout、版本、definition patch、validate。
- **Run API**：启动、列表/详情、步骤、结果引用、取消、重试、AI review/交互。
- **编辑器**：组合设置区、画布、检查器、版本对比；调用 API/composable，不直接拼 HTTP。
- **定义编解码器**：服务端 JSON 与 UI draft 转换、规范化和本地提示，保持纯函数可测。
- **Compiler**：服务端唯一权威校验/规范化，生成 digest 与工具合同快照。
- **Scheduler/Dispatcher**：持久状态推进、claim/租约、设备派发、结果 reconcile、超时和补偿。

建议实体边界为 Card、不可变 CardVersion、单次 Run、StepRun、Interaction/Review、AuditEvent。画布布局单独存，不混入运行语义。

## 8. 对其它应用的迁移建议

### 值得借鉴

- 流程模板化，元数据、定义、权限和运行记录分离。
- 画布表达控制流，检查器编辑细节；边而非坐标决定执行。
- 输入 schema、结果变量、输出映射形成稳定数据合同。
- 不可变版本和固定工具合同；run 固定版本。
- 统一 validator、显式状态机、幂等键、deadline、attempt、取消和重启恢复。
- 将运行诊断、脱敏、审计和结果大小纳入产品设计。

### 需按目标重做

- AI-FREE-app 的本地浏览器流程若在桌面执行，应使用合适的 IPC、本地存储和后台执行租约，不照搬 Connector→设备派发。
- 浏览器动作需要页面稳定检查、业务探针、截图/AX 诊断及不确定结果防重放；这些不属于通用 MCP workflow 默认语义。
- 从少量强类型节点开始，不要先开放任意脚本。小流程可先用列表式步骤编辑器，分支/回边复杂后再做自由画布。
- 如果无法确定外部动作是否已生效，恢复时应重新核验或要求重启流程，不自动重放点击/提交。
- 单用户本地工具可先考虑原子文件/SQLite；多设备协作、审计和远程执行再引入中心服务。

## 9. 推荐实施顺序

1. 固定 JSON Schema、节点合同、状态枚举和终态语义，先测试 validator。
2. 做卡片列表和最小步骤编辑器，支持输入、顺序、参数与 dry-run。
3. 增加画布、分支、版本保存和差异对比。
4. 实现持久 run/step、幂等启动、超时、取消、重试和运行详情；验证重启、重复/迟到回调、离线和并发 claim。
5. 增加工具合同冻结、权限、脱敏、审计和导入校验。
6. 最后加入嵌套卡片、AI 节点、暂停/恢复、单步调试；每种控制能力都定义崩溃恢复与副作用策略。

## 10. 源码导航

以下路径相对于仓库根 `HeySure_AI_2.0`：

| 职责 | 路径 |
|---|---|
| 卡片列表/运行历史 | `deploy/web/src/components/workshop/automation/AutomationCardsPanel.vue` |
| 编辑器/草稿/保存 | `deploy/web/src/components/workshop/automation/AutomationEditorModal.vue` |
| 画布/连线/手势 | `deploy/web/src/components/workshop/automation/WorkflowCanvasEditor.vue`、`canvasGraph.ts`、`canvasGestures.ts` |
| 节点检查器 | `deploy/web/src/components/workshop/automation/AutomationStepInspector.vue` |
| 卡片与设备设置 | `deploy/web/src/components/workshop/automation/AutomationEditorSettings.vue` |
| JSON 与 draft 转换 | `deploy/web/src/components/workshop/automation/automationDefinition.ts` |
| HTTP 契约 | `deploy/web/src/api/workflowCards.ts`、`workflowRuns.ts` |
| 数据模型/compiler | `deploy/server/main/api/models/workflow.py`、`api/services/workflows/compiler.py` |
| 卡片合同/运行状态机 | `deploy/server/main/api/services/workflows/card_service.py`、`workflow_contracts.py`、`run_service.py` |
| Scheduler/派发/取消 | `deploy/server/main/connector_runtime/dispatch/workflow_scheduler.py`、`workflow_dispatch.py`、`deploy/server/main/api/services/workflows/workflow_cancellation.py` |
| AI-FREE 本地工作流设计 | `device/AI-FREE-app/docs/automation-workspace.md`、`browser-workflow-modes.md` |

## 11. 设计验收清单

- [ ] 流程顺序由显式边决定，坐标不进入执行语义。
- [ ] UI、导入、API、AI 写入经过同一权威 validator。
- [ ] Run 固定定义版本、输入、actor、deadline 和幂等键。
- [ ] 每个外部副作用有唯一 attempt/dispatch 标识，迟到结果不复活终态。
- [ ] 超时、离线、重试、取消、重启恢复都有明确状态转换。
- [ ] 参数经过 schema 校验，执行前重核权限，合同变更可诊断。
- [ ] 敏感数据默认脱敏，大结果有大小限制/引用存储。
- [ ] 运行历史能解释卡在哪一步、原因和下一次动作时间。
- [ ] 新版本不修改现有 run 绑定的定义。
- [ ] 测试覆盖成功、分支、超时、取消、重试、离线、重复/迟到回调及进程重启。
