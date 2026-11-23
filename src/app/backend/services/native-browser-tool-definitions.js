'use strict';
const { BROWSER_WORKFLOW_TOOL, checkedActionProperties } = require('./browser-workflow-tool-definition');

const { PAGE_BATCH_TOOL } = require('./browser-page-batch');
const { AUTOMATION_CARD_ACTIONS } = require('./automation-card-contract');

const CARD_SAVE_GUIDANCE = '用户要求保存流程时，复用对话中已成功的步骤，使用稳定定位和凭据引用。仅在格式不明时查一次 rules。用 manage_card write 保存，按返回的 item.id 调用 get 回读步骤和 inputSchema。'
  + '把正向业务信号写入末步断言（如登录后可见的账号菜单，condition 配 fail_on_false=true）。仅表单消失或点击成功不足以验收。'
  + '用户要求复测时，先核对指定起点（如按要求退出并确认登录入口可见），接管后用 start_run 运行该卡片，把 run.id 作为 run_id 交给 get_run 查终态。run.status 为 succeeded 且业务断言通过才算验收成功，必要时用 list_run_steps 核对。同步 run 不产生 list_runs 记录。结果未知先核对运行记录和页面，不重放有副作用的步骤。';

const objectSchema = (properties, required = []) => ({
  type: 'object', properties, ...(required.length ? { required } : {}),
});

const NATIVE_BROWSER_TOOL_DEFINITIONS = Object.freeze([
  BROWSER_WORKFLOW_TOOL,
  PAGE_BATCH_TOOL,
  {
    name: 'browser_control',
    description: '读取软件完整浏览器态势，或显式管理当前页面自动化接管。overview 无需先选择或打开浏览器，返回全部浏览器记录、当前打开窗口及其标签页、AI-Workspace 目录树；status 查看当前页；acquire 开始接管；release 停止接管。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['overview', 'status', 'acquire', 'release'] },
      workspace_depth: { type: 'number', description: 'overview 的工作区目录深度，默认 4，范围 1-8。' },
      workspace_max_entries: { type: 'number', description: 'overview 最多返回的目录项，默认 500，范围 10-2000。' },
    }),
  },
  {
    name: 'manage_card',
    description: '管理共享自动化卡片。卡片目录、读取、编辑、移入回收站、运行记录查询、暂停和取消可离线调用。purge 永久删除需要在线接管。run/start_run/retry_run/resume_run/step_run 会开始或继续产生副作用的执行，必须先对 change_browser 所选在线窗口调用 browser_control action=acquire；release 后不能继续。使用已有卡片时按目录筛选并 get 查看步骤和 inputSchema，目录已知为空时跳过 list。start_run 独立于当前对话继续，相同幂等键须绑定完全相同参数。retry_run 只允许可重试失败，从头执行可能重复副作用。'
      + CARD_SAVE_GUIDANCE,
    input_schema: objectSchema({
      action: { type: 'string', enum: AUTOMATION_CARD_ACTIONS },
      id: { type: 'string', description: '读取、编辑或运行既有卡片时提供卡片 ID，亦可提供唯一 card_name。' },
      card_id: { type: 'string' }, card_name: { type: 'string' },
      name: { type: 'string' }, cardData: { type: 'object', description: 'write 必填，包含 name 和非空 steps 数组。' },
      inputSchema: { type: 'object', description: 'write 时定义运行输入的对象 schema。' }, metadata: { type: 'object' }, version_id: { type: 'string' },
      step_index: { type: 'integer', minimum: 1, description: '卡片步骤序号，从 1 开始。patch_step 必填。修复运行时直接使用 get_run 中目标步骤的 stepIndex（如 run.steps[].stepIndex），先用 get 核对当前步骤的 type 和 tool。' },
      to_step_index: { type: 'number' }, insert_after: { type: 'number' },
      stepData: { type: 'object' },
      stepPatch: { type: 'object', description: 'patch_step 浅合并到目标步骤。原生 click/wait 等字段放在顶层，例如 {"selector":"#ready","timeout":1000}。只有 type=mcp 使用 arguments，传入目标 tool 的完整参数对象。' },
      replace: { type: 'boolean' },
      inputs: { type: ['object', 'array'], description: '按 manage_card get 返回的 item.inputSchema 提供流程输入。' },
      start_step: { type: 'number' }, timeout_seconds: { type: 'number' }, idempotency_key: { type: 'string' },
      run_id: { type: 'string', description: '查询单次运行、暂停、继续、单步、取消或重试时填 start_run 返回的 run.id。' }, status: { type: 'string' }, limit: { type: 'number' },
      include_deleted: { type: 'boolean' }, enabled: { type: 'boolean' }, reason: { type: 'string' },
      overrides: { type: 'object', description: 'template 可选覆盖 probes/expect 等字段' },
    }, ['action']),
  },
  {
    name: 'browser_file', destructive: true,
    description: '通过 AI 工作区安全下载 URL 或页面图片、把工作区文件上传到网页或 HeySure 服务器，或保存当前浏览器会话。网页要求选择文件时必须使用 upload，并同时提供 AI-Workspace 内的 path/paths 和文件控件 selector/ref；不要先用 browser_action 点击文件控件。upload_to_server 是直接上传 HeySure 并返回 file_ref。download_element 只保存资源字节。用 browser_observe 的 filter=media 或 filter=link 查找目标，再传入 ref 与 observation_id。网页要求点击下载、记录下载步骤或用下载解锁后续操作时，用 browser_action click 激活页面上的下载入口，再用 browser_control overview 对比 AI-Workspace 验证新文件的实际路径和大小。文件控件使用 filter=file-input 查找可执行的 ref。上传返回 file_selected 后，先观察页面的预览或收件回执再提交。绑定页面的操作遇到过期引用或目标变化时需重新观察。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['download', 'download_element', 'upload', 'upload_to_server', 'save_session', 'info'] },
      url: { type: 'string', description: '下载用绝对 URL 或相对于当前页面的 URL' },
      directory: { type: 'string' }, filename: { type: 'string' }, media_type: { type: 'string' },
      overwrite: { type: 'boolean' }, timeout_ms: { type: 'number' }, max_bytes: { type: 'number' },
      transport: { type: 'string', enum: ['auto', 'browser', 'software'], description: 'auto 先尝试 Chromium 原生下载，失败后走带代理的软件下载' },
      use_cookies: { type: 'boolean', description: '软件下载是否附带当前页面匹配 Cookie，默认 true' },
      selector: { type: 'string' },
      ref: { type: 'string', description: 'browser_observe 返回的元素 id；download_element 优先使用' },
      element: { type: 'string', description: 'ref 的别名，兼容按元素引用下载' },
      observation_id: { type: 'string', description: '产生 ref 的 browser_observe 快照 ID' },
      x: { type: 'number', description: 'download_element 的视口 X 坐标；ref 会自动解析为元素暴露点' },
      y: { type: 'number', description: 'download_element 的视口 Y 坐标；ref 会自动解析为元素暴露点' },
      path: { type: 'string', description: 'AI-Workspace 内任意类型的单个文件路径；upload_to_server 必填' },
      paths: { type: 'array', items: { type: 'string' }, description: 'AI-Workspace 内任意类型的多个文件路径' }, mode: { type: 'string' }, page_url: { type: 'string' },
    }, ['action']),
  },
  {
    name: 'browser_tab',
    description: '通过受认证 Chromium Runtime Bridge 管理当前浏览器。先用 list 获取活动标签和 tab_id；switch 切换已有标签；replace 覆盖当前页；navigate 新建并激活标签；close 关闭标签；back/forward 执行历史导航。navigate 默认新标签，传 replace_current/current_tab/same_tab=true 时兼容转换为当前标签覆盖跳转。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['list', 'switch', 'replace', 'navigate', 'close', 'back', 'forward', 'reload'] },
      url: { type: 'string' },
      tab_id: { type: 'number', description: 'list 返回的标签 id（当前标签索引，关闭标签后请重新 list）；switch 必填，close/replace/back/forward 可选。' },
      tabId: { type: 'number', description: 'tab_id 的兼容别名。' },
      id: { type: 'string', description: 'Runtime Bridge 字符串标签 id 的兼容字段。' },
      index: { type: 'number', description: '兼容旧 Runtime 的标签索引。' },
      replace_current: { type: 'boolean' }, current_tab: { type: 'boolean' }, same_tab: { type: 'boolean' },
    }, ['action']),
  },
  {
    name: 'browser_media',
    description: '发现并下载当前页面上的视频、音频和其他媒体素材。先用 action=list 获取带 observation_id 的媒体 ref，再用 action=download、ref 和可选 filename 下载；下载仍受当前页面 Cookie、Referer、代理和 AI-Workspace 安全边界约束。当前版本支持页面媒体元素和可解析直链，暂不负责 HLS/DASH 分片合并或 DRM 内容。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['list', 'download'] },
      ref: { type: 'string', description: 'action=list 返回的媒体 ref' },
      element: { type: 'string', description: 'ref 的兼容别名' },
      filename: { type: 'string' }, directory: { type: 'string' },
      overwrite: { type: 'boolean' }, timeout_ms: { type: 'number' },
      max_bytes: { type: 'number' }, transport: { type: 'string', enum: ['auto', 'browser', 'software'] },
      use_cookies: { type: 'boolean' }, mark: { type: 'boolean' },
      include_text: { type: 'boolean' }, limit: { type: 'number' },
    }, ['action']),
  },
  {
    name: 'browser_observe',
    description: '通过 Chromium 隔离世界观察当前页面，并在浏览器原生 UI 层绘制标记。优先用 kinds、tags、roles、control_types 分维度筛选；兼容 filter 仅接受 schema 中列出的值，无效值会返回 INVALID_FILTER，不能把 HTML 标签误当成 filter。结果包含 observationId、语义、状态、容器关系、定位唯一性和截断诊断；后续操作可携带 observation_id 校验快照。',
    input_schema: objectSchema({
      surface: { type: 'string', enum: ['page', 'shell', 'sidebar', 'chromium', 'chromium_popup', 'dialog'], description: '默认 page。shell/sidebar 返回支持的控件；chromium、chromium_popup、dialog 返回可见控件及其 ref、窗口尺寸和 observationId。' },
      mode: { type: 'string', enum: ['overview', 'elements'], description: 'overview 只返回页面级语义区域；elements 返回元素' },
      include_regions: { type: 'boolean' }, max_depth: { type: 'number' },
      include_accessibility_tree: { type: 'boolean', description: '同时返回 Chromium 完整 AX 树（role/name/state/父子关系/bounds）；旧内核明确报更新要求。' },
      include_screenshot: { type: 'boolean', description: '同时截图，MCP 以图片内容返回，与页面语义一起核对。' },
      region_ref: { type: 'string', description: 'overview 返回的区域 ref；只限制观察结果，不限制后续交互' },
      region: { type: 'object', description: '语义区域 {role,label,match} 或 viewport CSS 像素矩形 {x,y,width,height}' },
      region_mode: { type: 'string', enum: ['centerInside', 'fullyInside', 'intersecting'] },
      padding: { type: 'number' }, include_ancestor_context: { type: 'number' },
      include_portals: { type: 'boolean' }, region_layout_hash: { type: 'string' },
      limit: { type: 'number' }, max_items: { type: 'number' },
      filter: { type: 'string', enum: ['interactive', 'media', 'text', 'input', 'form', 'button', 'link', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'select', 'clickable', 'text-input', 'number-input', 'date-time-input', 'file-input', 'color-input', 'rich-text-input', 'icon-button', 'disclosure'] },
      kinds: { type: 'array', items: { type: 'string', enum: ['interactive', 'media', 'text'] } },
      tags: { type: 'array', items: { type: 'string' } },
      roles: { type: 'array', items: { type: 'string' } },
      control_types: { type: 'array', items: { type: 'string' } },
      tag: { type: 'string', description: '兼容的单个 HTML 标签筛选；新调用优先使用 tags' },
      keyword: { type: 'string' }, include_text: { type: 'boolean' },
      include_media: { type: 'boolean' }, text_limit: { type: 'number' },
      mark: { type: 'boolean' }, highlight_duration_ms: { type: 'number' },
    }),
  },
  {
    name: 'browser_screenshot',
    description: '通过 Chromium RenderWidget Surface 截取当前页面 PNG。',
    input_schema: objectSchema({
      selector: { type: 'string' }, full_page: { type: 'boolean' }, x: { type: 'number' }, y: { type: 'number' },
      width: { type: 'number' }, height: { type: 'number' }, send_to_user: { type: 'boolean' },
    }),
  },
  {
    name: 'browser_action', destructive: true,
    description: '通过 Chromium 原生输入执行点击、拖拽选文、整段输入、光标/选区定位、局部插入、滚动或组合按键。必须先调用 browser_control action=acquire 接管当前浏览器；接管期间活动页面页面显示紫色发光边框，任何来源触发的文件选择器或阻塞式浏览器模态弹窗都会被阻止。ref 只属于最近一次 browser_observe，连续 observe 后必须使用最后一次返回的 ref；accessibilityFallback 元素会自动使用 clickX/clickY，无需 selector。导航或切换标签后应重新观察并使用当前页面的 ref；完成后 AI 可以调用 browser_control action=release 停止接管。文件上传改用 browser_file action=upload 并附带 path/paths 与 selector/ref。',
    input_schema: objectSchema({
      surface: { type: 'string', enum: ['page', 'shell', 'sidebar', 'chromium', 'chromium_popup', 'dialog'], description: '默认 page。shell/sidebar 使用同界面的 ref。chromium、chromium_popup、dialog 仅限内置 AI，必须使用同界面最新的 observation_id，x/y 是窗口左上角起算的物理像素。' },
      action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'insert_text', 'set_selection', 'press_key', 'select_option', 'set_checked'] },
      ...checkedActionProperties,
      scope: { type: 'string' }, nth: { type: 'integer', minimum: 0 }, exact: { type: 'boolean' }, has_text: { type: 'string' },
      after: { type: 'string', enum: ['none', 'observe'], description: '推荐 observe：动作成功后返回新观察和可继续操作的 ref；观察失败不会重做动作。省略保留旧行为。' },
      observation_options: { type: 'object', description: 'after=observe 的观察参数，可含 include_accessibility_tree/include_screenshot/limit/kinds。' },
      selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' },
      value: { type: 'string', description: 'select_option 的 option value；也可使用 label' },
      checked: { type: 'boolean', description: 'set_checked 的目标状态' },
      force_event: { type: 'boolean', description: 'set_checked 即使状态未变化也强制派发事件' },
      observation_id: { type: 'string', description: 'browser_observe 返回的 observationId。与 ref 一起校验引用。纯坐标点击可携带此 ID，要求当前入口最新、未过期且与当前文档一致的观察。' },
      x: { type: 'number', description: '视口起点 X；可覆盖 ref 的默认点击中心' },
      y: { type: 'number', description: '视口起点 Y；可覆盖 ref 的默认点击中心' },
      to_ref: { type: 'string', description: '原生界面拖拽的终点控件，使用同一次观察返回的 ref。' },
      to_x: { type: 'number', description: 'drag 的视口终点 X' },
      to_y: { type: 'number', description: 'drag 的视口终点 Y' },
      start: { type: 'number', description: 'set_selection 的 UTF-16 起始字符位置；start=end 表示光标' },
      end: { type: 'number', description: 'set_selection 的 UTF-16 结束字符位置' },
      selection_direction: { type: 'string', enum: ['forward', 'backward', 'none'] },
      key: { type: 'string', description: '按键名或组合键，例如 Home、Shift+ArrowLeft、Ctrl+A' },
      repeat: { type: 'number', description: 'press_key 重复次数，范围 1-100' },
      ctrl: { type: 'boolean' }, shift: { type: 'boolean' }, alt: { type: 'boolean' }, meta: { type: 'boolean' },
      direction: { type: 'string' }, amount: { type: 'number' }, timeout_ms: { type: 'number' },
    }, ['action']),
  },
  {
    name: 'browser_wait',
    description: '等待固定时长，或等待页面条件成立。支持元素存在/可见/隐藏、文本包含/变化和 URL 变化；满足条件后立即返回，不需要反复 wait-observe。',
    input_schema: objectSchema({
      condition: {
        type: 'string',
        enum: ['attached', 'visible', 'hidden', 'text_contains', 'text_changed', 'value_equals', 'attribute_equals', 'checked', 'count', 'url_matches'],
        description: '省略时兼容为等待 selector/ref 存在；url_matches 不需要 selector/ref',
      },
      selector: { type: 'string' }, ref: { type: 'string' },
      observation_id: { type: 'string', description: 'ref 所属 browser_observe 的 observationId' },
      value: { type: 'string', description: 'text_contains 或 url_matches 的目标内容' },
      attribute: { type: 'string', description: 'attribute_equals 要读取的属性名' },
      initial_value: { type: 'string', description: 'text_changed 的可选初始文本；省略时自动记录首次读取值' },
      ms: { type: 'number' }, timeout_ms: { type: 'number' },
    }),
  },
]);

const CONTROL_TOOL = NATIVE_BROWSER_TOOL_DEFINITIONS.find((tool) => tool.name === 'browser_control');
const MANAGE_CARD_TOOL_DEFINITION = NATIVE_BROWSER_TOOL_DEFINITIONS.find((tool) => tool.name === 'manage_card');

function browserControlDefinition(connected) {
  if (connected) return CONTROL_TOOL;
  return {
    ...CONTROL_TOOL,
    description: '列出软件浏览器记录、打开的窗口和 AI-Workspace。浏览器连接后可管理自动化接管。',
    input_schema: objectSchema({
      ...CONTROL_TOOL.input_schema.properties,
      action: { type: 'string', enum: ['overview'] },
    }, ['action']),
  };
}

module.exports = { CARD_SAVE_GUIDANCE, MANAGE_CARD_TOOL_DEFINITION, NATIVE_BROWSER_TOOL_DEFINITIONS, browserControlDefinition };
