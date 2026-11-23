'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dispatchPluginTool,
  executeToolCalls,
  resolvePluginTarget,
  syncWindowToolControl,
} = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');
const {
  buildChatToolContext,
  shouldIncludeBrowserEnvironment,
  withBrowserRouteParam,
} = require('../../../src/app/backend/features/ai-chat/chat-tool-context');

test('大型浏览器环境 schema 仅在相关用户意图中注入', () => {
  assert.equal(shouldIncludeBrowserEnvironment([{ role: 'user', content: '打开一个新窗口' }]), false);
  assert.equal(shouldIncludeBrowserEnvironment([{ role: 'user', content: '把这个浏览器时区改成 UTC' }]), true);
  const windowTools = {
    tools: [{ name: 'windows_tab' }, { name: 'browser_environment' }],
    has: () => true,
  };
  const regular = buildChatToolContext({
    connections: [], windowTools, initialMessages: [{ role: 'user', content: '创建浏览器' }],
  });
  const environment = buildChatToolContext({
    connections: [], windowTools, initialMessages: [{ role: 'user', content: '修改代理配置' }],
  });
  assert.deepEqual(regular.tools.map((tool) => tool.name), ['windows_tab', 'manage_card']);
  assert.deepEqual(environment.tools.map((tool) => tool.name), ['windows_tab', 'browser_environment', 'manage_card']);
});

test('浏览器工具 schema 暴露可选 change_browser 且保留原必填参数', () => {
  const tool = withBrowserRouteParam({
    name: 'browser_action',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string' } },
      required: ['action'],
    },
  });
  assert.deepEqual(tool.input_schema.required, ['action']);
  assert.equal(tool.input_schema.properties.change_browser.type, 'string');
});

test('AI MCP prompt 按可用工具注入准确的多浏览器路由和页面操作策略', () => {
  const context = buildChatToolContext({
    connections: [
      { id: 'one', name: '工作窗口', tools: [
        { name: 'browser_tab', input_schema: { type: 'object' } },
        { name: 'browser_observe', input_schema: { type: 'object' } },
        { name: 'browser_action', input_schema: { type: 'object' } },
        { name: 'browser_file', input_schema: { type: 'object' } },
      ] },
      { id: 'two', name: '资料窗口', tools: [{ name: 'browser_observe', input_schema: { type: 'object' } }] },
    ],
    controlledConnectionId: 'one',
    initialMessages: [{ role: 'user', content: '继续操作' }],
    windowTools: {
      has: (name) => name === 'windows_tab',
      tools: [{ name: 'windows_tab', input_schema: { type: 'object' } }],
    },
  });
  const prompt = context.modelMessages[0].content;
  assert.match(prompt, /browser_tab、browser_observe、browser_action/);
  assert.match(prompt, /同一时间最多控制一个浏览器/);
  assert.match(prompt, /用户不会在设置中指定目标浏览器/);
  assert.match(prompt, /必须由你根据用户目标自行选择/);
  assert.match(prompt, /必须在下一次浏览器工具调用中传 change_browser/);
  assert.match(prompt, /页面明显变化后重新 observe/);
  assert.match(prompt, /按 browser_file 的工具说明区分保存资源与操作网页下载入口/);
  assert.match(prompt, /上传后核对用户可见的收件结果/);
  assert.match(prompt, /禁止跨浏览器或跨页面复用旧 ref/);
  assert.match(prompt, /history_id 和 tab_id 不能当作 change_browser/);
  assert.match(prompt, /要显示或聚焦已有栏目，调用 windows_tab 的 open/);
  assert.match(prompt, /窗口已打开不等于其 MCP 已连接/);
  assert.match(prompt, /未收到成功结果前不得声称操作完成/);
  assert.equal(context.tools.find((tool) => tool.name === 'browser_tab').input_schema.properties.change_browser.type, 'string');
});

test('自动化卡片目录注入全部卡片并要求 AI 自行筛选', () => {
  const context = buildChatToolContext({
    connections: [{
      id: 'one',
      name: '工作窗口',
      tools: [{ name: 'manage_card', input_schema: { type: 'object' } }],
    }],
    controlledConnectionId: 'one',
    initialMessages: [{ role: 'user', content: '帮我登录微软账号' }],
    automationCards: [
      { id: 'card-login', name: '微软登录', website: 'https://login.live.com', description: '账号登录', stepCount: 4 },
      { id: 'card-shop', name: '下单流程', website: 'https://shop.example', description: '', stepCount: 8 },
    ],
    windowTools: { has: () => false, tools: [] },
  });
  const prompt = context.modelMessages.map((message) => message.content).join('\n');
  assert.match(prompt, /必须由你根据用户目标自行筛选/);
  assert.match(prompt, /card-login/);
  assert.match(prompt, /微软登录/);
  assert.match(prompt, /card-shop/);
  assert.match(prompt, /下单流程/);
  assert.doesNotMatch(prompt, /当前选中的自动化卡片/);
  assert.doesNotMatch(prompt, /不要擅自改用其他卡片/);
});

function sidebarCardPrompt(requests, automationCards = []) {
  const context = buildChatToolContext({
    localInteraction: true, connections: [{ id: 'fixture', tools: [{ name: 'browser_workflow' }] }],
    initialMessages: requests.map((content) => ({ role: 'user', content })), automationCards,
  });
  return {
    prompt: context.modelMessages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n'),
    description: context.tools.find(({ name }) => name === 'manage_card').description,
  };
}

function assertCardAcceptanceGuide(text) {
  assert.match(text, /对话.{0,16}成功.{0,10}步骤/);
  assert.match(text, /write[^。]*item\.id[^。]*get\b/);
  assert.match(text, /账号菜单|用户菜单/);
  assert.match(text, /fail_on_false\s*[:=]\s*true/);
  assert.match(text, /start_run[^。]*run\.id[^。]*get_run/);
  assert.match(text, /get_run[^。]*终态/);
  assert.match(text, /succeeded/);
  assert.match(text, /结果未知[^。]*(?:不|勿|禁止)[^。]*(?:重放|重试)/);
}

test('空库保存成功步骤并退出复测时，侧栏提示与共享工具都给出可追踪的卡片验收路径', () => {
  const { prompt, description } = sidebarCardPrompt(['手动登录成功了', '把刚才的步骤制成自动化，主动退出再跑测试']);
  assertCardAcceptanceGuide(prompt);
  assertCardAcceptanceGuide(description);
  assert.match(prompt, /没有自动化卡片[^。]*(?:无需|不用|跳过)[^。]*list/);
  assert.match(prompt, /格式[^。]*一次 rules/);
  assert.match(prompt, /browser_workflow run[^。]*临时[^。]*。[^。]*manage_card/);
  assert.match(prompt, /退出[^。]*(?:确认|核对|可见)/);
  assert.doesNotMatch(prompt, /重复操作默认使用[^。]*browser_workflow/);
});

test('已有卡片的后续复测指向保存的卡片，同步执行与后台记录有别', () => {
  const { prompt } = sidebarCardPrompt(['把操作保存为流程', '请退出再跑测试'], [{ id: 'saved', name: '登录' }]);
  assert.match(prompt, /saved/);
  assert.match(prompt, /start_run[^。]*run\.id[^。]*get_run/);
  assert.match(prompt, /同步 run[^。]*list_runs/);
  assert.doesNotMatch(prompt, /重复操作默认使用[^。]*browser_workflow/);
});

test('卡片已打开弹窗而 wait 失败时，复测指引先核对已执行步骤和页面起点', () => {
  const { prompt } = sidebarCardPrompt([
    '运行已保存的登录卡片', '弹窗显示 Continue with email，第二步 wait 参数无效，修好后复测',
  ], [{ id: 'saved', name: '登录' }]);
  assert.match(prompt, /get_run[^。]*run\.steps[^。]*(?:最近|最后)成功步/);
  assert.match(prompt, /已派发[^。]*(?:页面|状态)[^。]*(?:不要|禁止|不可)[^。]*从头/);
  assert.match(prompt, /(?:修正|修复)[^。]*(?:参数|失败原因)/);
  assert.match(prompt, /安全关闭[^。]*临时弹窗[^。]*(?:观察|核对)[^。]*(?:起点|起始状态)[^。]*(?:一次|单次)复测/);
  assert.match(prompt, /副作用未知[^。]*(?:不|禁止)[^。]*重放/);
  assert.doesNotMatch(prompt, /\blist_step_run\b/);
});

test('普通操作保持轻量，一次性页面测试仍使用浏览器工作流', () => {
  const { prompt } = sidebarCardPrompt(['把步骤制成自动化并测试', '只读取当前页面标题']);
  assert.doesNotMatch(prompt, /run\.steps|start_run|fail_on_false|browser_workflow automation/);
  const oneOff = sidebarCardPrompt(['运行一次页面自动化测试']).prompt;
  assert.match(oneOff, /browser_workflow automation/);
  assert.match(oneOff, /probes\/expect/);
  assert.doesNotMatch(oneOff, /run\.steps|fail_on_false/);
});

test('没有浏览器连接时 prompt 不会诱导 AI 虚构浏览器 MCP', () => {
  const context = buildChatToolContext({
    connections: [],
    initialMessages: [{ role: 'user', content: '打开窗口' }],
    windowTools: {
      has: (name) => name === 'software_window',
      tools: [{ name: 'software_window', input_schema: { type: 'object' } }],
    },
  });
  assert.match(context.modelMessages[0].content, /没有可用的浏览器自动化连接/);
  assert.doesNotMatch(context.modelMessages[0].content, /网页操作应先用 browser_tab/);
});

test('多浏览器工具要求明确路由，名称歧义和未知连接返回可恢复诊断', () => {
  const connections = [{ id: 'a', name: 'same' }, { id: 'b', name: 'same' }];
  const describe = () => 'same(a), same(b)';
  assert.match(resolvePluginTarget({}, connections, describe).error, /change_browser/);
  assert.equal(resolvePluginTarget({}, connections, describe, 'a').connection.id, 'a');
  assert.match(resolvePluginTarget({ change_browser: 'same' }, connections, describe).error, /多个/);
  const missing = resolvePluginTarget({ change_browser: 'missing' }, connections, describe).error;
  assert.match(missing, /在线浏览器/);
  assert.match(missing, /history_id\/tab_id 不能代替 change_browser/);
});

test('插件工具移除路由字段并限制超时，自动化卡片使用十五分钟默认值', async () => {
  const calls = [];
  const base = {
    connections: [{ id: 'browser-1' }],
    browserControl: { connectionId: 'browser-1' },
    findConnectionByRef: (reference) => reference === 'browser-1' ? { id: 'browser-1' } : null,
    describeConnections: () => 'browser-1',
    waitForAbort: (promise) => promise,
    bridge: { dispatch: async (...args) => { calls.push(args); return { success: true }; } },
  };
  await dispatchPluginTool(base, 'open_page', { change_browser: 'browser-1', timeout_seconds: 9999, url: 'https://example.com' });
  assert.deepEqual(calls[0][2], { timeout_seconds: 9999, url: 'https://example.com' });
  assert.equal(calls[0][3].timeoutMs, 1800 * 1000);
  await dispatchPluginTool(base, 'manage_card', { action: 'run' });
  assert.equal(calls[1][3].timeoutMs, 15 * 60 * 1000);
});

test('change_browser 切换唯一控制目标并由后续调用沿用', async () => {
  const calls = [];
  const connections = [{ id: 'one', name: '窗口一' }, { id: 'two', name: '窗口二' }];
  const browserControl = { connectionId: 'one' };
  const context = {
    browserControl,
    connections,
    describeConnections: () => '窗口一(one)、窗口二(two)',
    emit() {},
    findConnectionByRef: (ref) => connections.find((item) => item.id === ref || item.name === ref),
    waitForAbort: (promise) => promise,
    bridge: { dispatch: async (...args) => { calls.push(args); return { success: true }; } },
  };
  await dispatchPluginTool(context, 'browser_observe', { change_browser: '窗口二', keyword: '标题' });
  await dispatchPluginTool(context, 'browser_action', { action: 'click', ref: 'e1' });
  assert.equal(browserControl.connectionId, 'two');
  assert.deepEqual(calls.map((call) => call[0]), ['two', 'two']);
  assert.deepEqual(calls[0][2], { keyword: '标题' });
});

test('窗口 MCP 就绪后刷新同一轮连接与工具目录并切换控制目标', () => {
  const events = [];
  const context = {
    bridge: { getConnection: () => ({ id: 'new-mcp', name: '插件窗口', tools: [
      { name: 'browser_tab', input_schema: { type: 'object', properties: {} } },
    ] }) },
    browserControl: { connectionId: 'old-mcp' },
    connections: [{ id: 'old-mcp', name: '旧窗口' }],
    emit: (event) => events.push(event),
    toolDefinitions: [{ name: 'software_window', input_schema: { type: 'object' } }],
    windowTools: { has: (name) => name === 'software_window' },
  };
  syncWindowToolControl(context, 'software_window', { action: 'open' }, {
    success: true,
    name: '新窗口',
    control_browser_id: 'new-mcp',
    control_browser_name: '新窗口',
  });
  assert.equal(context.browserControl.connectionId, 'new-mcp');
  assert.equal(context.connections.at(-1).name, '新窗口');
  assert.equal(context.toolDefinitions.at(-1).input_schema.properties.change_browser.type, 'string');
  assert.equal(events.at(-1).type, 'browser_control_changed');
});

test('窗口 MCP 就绪不会在工具结果后追加 system 消息', async () => {
  const modelMessages = [];
  await executeToolCalls({
    bridge: { getConnection: () => ({ id: 'new-mcp', name: '新窗口', tools: [] }) },
    browserControl: { connectionId: 'old-mcp' },
    compactToolValue: (value) => value,
    connections: [{ id: 'old-mcp', name: '旧窗口' }],
    describeConnections: () => '旧窗口、新窗口',
    emit() {},
    findConnectionByRef: () => null,
    isStopped: () => false,
    modelMessages,
    round: 0,
    toolCalls: [{ id: 'open', function: { name: 'software_window', arguments: '{"action":"open","name":"新窗口"}' } }],
    toolDefinitions: [],
    toolEvents: [],
    traceEvents: [],
    waitForAbort: (promise) => promise,
    windowTools: {
      has: (name) => name === 'software_window',
      execute: async () => ({
        success: true, name: '新窗口', mcp_connected: true,
        control_browser_id: 'new-mcp', control_browser_name: '新窗口',
      }),
    },
  });
  assert.equal(modelMessages.at(-1).role, 'tool');
});

test('本地窗口工具优先执行，插件失败被序列化为可恢复 tool 消息', async () => {
  const modelMessages = [];
  let pluginCalls = 0;
  const common = {
    compactToolValue: (value) => value,
    connections: [{ id: 'one' }],
    describeConnections: () => 'one',
    emit() {},
    findConnectionByRef: () => null,
    isStopped: () => false,
    modelMessages,
    round: 0,
    toolEvents: [],
    traceEvents: [],
    waitForAbort: (promise) => promise,
    bridge: { dispatch: async () => { pluginCalls += 1; return { success: false, error: 'offline' }; } },
  };
  await executeToolCalls({
    ...common,
    toolCalls: [{ id: 'local', function: { name: 'software_window', arguments: '{"action":"list"}' } }],
    windowTools: { has: () => true, execute: async () => ({ success: true, windows: [] }) },
  });
  assert.equal(pluginCalls, 0);
  const result = await executeToolCalls({
    ...common,
    toolCalls: [{ id: 'remote', function: { name: 'open_page', arguments: '{}' } }],
    windowTools: null,
  });
  assert.equal(result.unresolvedToolFailure, 'offline');
  const payload = JSON.parse(modelMessages.at(-1).content);
  assert.equal(payload.recoverable, true);
  assert.equal(payload.error, 'offline');
});

test('工具参数 JSON 错误时返回格式诊断且不执行工具', async () => {
  const modelMessages = [];
  let executions = 0;
  const result = await executeToolCalls({
    compactToolValue: (value) => value,
    connections: [],
    describeConnections: () => '',
    emit() {},
    findConnectionByRef: () => null,
    isStopped: () => false,
    modelMessages,
    round: 0,
    toolCalls: [{ id: 'bad-json', function: { name: 'software_window', arguments: '{bad}' } }],
    toolEvents: [],
    traceEvents: [],
    waitForAbort: (promise) => promise,
    windowTools: {
      has: () => true,
      execute: async () => { executions += 1; return { success: true }; },
    },
  });
  assert.equal(executions, 0);
  assert.match(result.unresolvedToolFailure, /MCP 调用格式错误/);
  const payload = JSON.parse(modelMessages.at(-1).content);
  assert.equal(payload.errorCode, 'MCP_ARGUMENTS_INVALID');
  assert.equal(payload.phase, 'tool_parse');
});

test('截图结果转为模型可读取的临时 image_url 消息且不把 dataUrl 塞进 tool 文本', async () => {
  const modelMessages = [];
  const toolEvents = [];
  await executeToolCalls({
    compactToolValue: (value) => value,
    connections: [{ id: 'one' }],
    describeConnections: () => 'one',
    emit() {},
    findConnectionByRef: () => ({ id: 'one' }),
    isStopped: () => false,
    modelMessages,
    round: 0,
    toolCalls: [{ id: 'shot', function: { name: 'browser_screenshot', arguments: '{}' } }],
    toolEvents,
    traceEvents: [],
    waitForAbort: (promise) => promise,
    bridge: { dispatch: async () => ({
      success: true,
      dataUrl: 'data:image/png;base64,SCREENSHOT',
      method: 'captureVisibleTab',
    }) },
  });
  assert.equal(modelMessages[0].role, 'tool');
  assert.equal(JSON.parse(modelMessages[0].content).image_attached, true);
  assert.doesNotMatch(modelMessages[0].content, /SCREENSHOT/);
  assert.equal(modelMessages[1].role, 'user');
  assert.equal(modelMessages[1].content[1].type, 'image_url');
  assert.equal(modelMessages[1].content[1].image_url.url, 'data:image/png;base64,SCREENSHOT');
  assert.equal(modelMessages[1].ai_free_transient_image, true);
  assert.equal(toolEvents[0].result.image_attached, true);
  assert.equal(Object.prototype.hasOwnProperty.call(toolEvents[0].result, 'dataUrl'), false);
});
