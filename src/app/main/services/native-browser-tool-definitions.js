'use strict';

const objectSchema = (properties, required = []) => ({
  type: 'object', properties, ...(required.length ? { required } : {}),
});

const NATIVE_BROWSER_TOOL_DEFINITIONS = Object.freeze([
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
    description: '管理并运行原生 Chromium 自动化卡片。用户不会在 AI 控制设置中指定卡片，必须先根据系统卡片目录或 action=list 自行按名称/网站/说明筛选，再对匹配的 id 或唯一 card_name 调用 get/run。rules/list/get 可在只读模式使用；写入或 run 前必须先调用 browser_control action=acquire 接管当前活动页面，完成后允许 AI 调用 action=release 停止接管。切换或新开标签页后需要重新接管。支持 rules/list/get/write/patch_step/insert_step/delete_step/move_step/delete/run。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['rules', 'list', 'get', 'write', 'patch_step', 'insert_step', 'delete_step', 'move_step', 'delete', 'run'] },
      id: { type: 'string' }, card_name: { type: 'string' }, cardData: { type: 'object' },
      step_index: { type: 'number' }, to_step_index: { type: 'number' }, insert_after: { type: 'number' },
      stepData: { type: 'object' }, stepPatch: { type: 'object' }, replace: { type: 'boolean' },
      inputs: { type: 'object' }, start_step: { type: 'number' }, timeout_seconds: { type: 'number' },
    }, ['action']),
  },
  {
    name: 'browser_file', destructive: true,
    description: '通过 AI 工作区安全下载 URL 或页面图片、把工作区文件上传到网页或 HeySure 服务器，或保存当前浏览器会话。网页要求选择文件时必须使用 upload，并同时提供 AI-Workspace 内的 path/paths 和文件控件 selector/ref；不要先用 browser_action 点击文件控件。upload_to_server 是直接上传 HeySure 并返回 file_ref。download_element 接受 browser_observe 返回的 ref/element，或 x/y 坐标；旧内核或不支持的图片节点会自动回退为带当前页面 Cookie 和浏览器代理的 URL 下载。download 走同一代理，避免 assets.grok.com 等 CDN 直连超时。',
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
      x: { type: 'number', description: 'download_element 的视口 X 坐标；ref 会自动解析为元素暴露点' },
      y: { type: 'number', description: 'download_element 的视口 Y 坐标；ref 会自动解析为元素暴露点' },
      path: { type: 'string', description: 'AI-Workspace 内任意类型的单个文件路径；upload_to_server 必填' },
      paths: { type: 'array', items: { type: 'string' }, description: 'AI-Workspace 内任意类型的多个文件路径' }, mode: { type: 'string' }, page_url: { type: 'string' },
    }, ['action']),
  },
  {
    name: 'browser_tab',
    description: '通过受认证 Chromium Runtime Bridge 管理当前浏览器。replace 覆盖当前页；navigate 新建标签页、立即激活并把浏览器打开到前台。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['list', 'switch', 'replace', 'navigate', 'reload'] },
      url: { type: 'string' }, id: { type: 'string' }, index: { type: 'number' },
    }, ['action']),
  },
  {
    name: 'browser_observe',
    description: '通过 Chromium 隔离世界观察当前页面，并在浏览器原生 UI 层绘制标记。优先用 kinds、tags、roles、control_types 分维度筛选；兼容 filter 仅接受 schema 中列出的值，无效值会返回 INVALID_FILTER，不能把 HTML 标签误当成 filter。结果包含 observationId、语义、状态、容器关系、定位唯一性和截断诊断；后续操作可携带 observation_id 校验快照。',
    input_schema: objectSchema({
      mode: { type: 'string', enum: ['overview', 'elements'], description: 'overview 只返回页面级语义区域；elements 返回元素' },
      include_regions: { type: 'boolean' }, max_depth: { type: 'number' },
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
    description: '通过 Chromium 原生输入执行点击、拖拽选文、整段输入、光标/选区定位、局部插入、滚动或组合按键。必须先调用 browser_control action=acquire 接管当前活动页面；接管期间页面显示紫色发光边框，任何来源触发的文件选择器或阻塞式浏览器模态弹窗都会被阻止。ref 只属于最近一次 browser_observe，连续 observe 后必须使用最后一次返回的 ref；accessibilityFallback 元素会自动使用 clickX/clickY，无需 selector。切换或新开标签页后需要重新接管；完成后 AI 可以调用 browser_control action=release 停止接管。文件上传改用 browser_file action=upload 并附带 path/paths 与 selector/ref。',
    input_schema: objectSchema({
      action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'insert_text', 'set_selection', 'press_key'] },
      selector: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' },
      observation_id: { type: 'string', description: 'browser_observe 返回的 observationId；与 ref 一起使用可拒绝过期快照' },
      x: { type: 'number', description: '视口起点 X；可覆盖 ref 的默认点击中心' },
      y: { type: 'number', description: '视口起点 Y；可覆盖 ref 的默认点击中心' },
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
        enum: ['attached', 'visible', 'hidden', 'text_contains', 'text_changed', 'url_matches'],
        description: '省略时兼容为等待 selector/ref 存在；url_matches 不需要 selector/ref',
      },
      selector: { type: 'string' }, ref: { type: 'string' },
      observation_id: { type: 'string', description: 'ref 所属 browser_observe 的 observationId' },
      value: { type: 'string', description: 'text_contains 或 url_matches 的目标内容' },
      initial_value: { type: 'string', description: 'text_changed 的可选初始文本；省略时自动记录首次读取值' },
      ms: { type: 'number' }, timeout_ms: { type: 'number' },
    }),
  },
]);

module.exports = { NATIVE_BROWSER_TOOL_DEFINITIONS };
