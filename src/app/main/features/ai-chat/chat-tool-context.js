'use strict';

const { limitAiControlMessages } = require('../../lib/ai-control-message-window');
const {
  findConnectionByReference,
  withBrowserRouteParam,
} = require('../../services/automation-tool-contract');

function createConnectionResolver(connections) {
  const findConnectionByRef = (ref) => {
    const resolved = findConnectionByReference(connections, ref);
    if (resolved.kind === 'found') return resolved.connection;
    if (resolved.kind === 'ambiguous') return { ambiguous: true, ref: resolved.reference };
    return null;
  };
  const describeConnections = () => connections
    .map((item) => `“${String(item.name || 'AI自动化浏览器')}”（change_browser: ${item.id}）`)
    .join('、');
  return { findConnectionByRef, describeConnections };
}

function collectConnectionTools(connections, windowTools) {
  const seenToolNames = new Set();
  const definitions = [];
  for (const item of connections) {
    for (const tool of (Array.isArray(item.tools) ? item.tools : [])) {
      const toolName = String(tool?.name || '');
      if (!toolName || windowTools?.has(toolName) || seenToolNames.has(toolName)) continue;
      seenToolNames.add(toolName);
      definitions.push(withBrowserRouteParam(tool));
    }
  }
  return definitions;
}

const BROWSER_ENVIRONMENT_INTENT = /(?:浏览器|栏目|窗口)?.{0,10}(?:环境|配置|设置|指纹|代理|proxy|user[ -]?agent|\bua\b|语言|时区|定位|分辨率|webrtc|canvas|webgl|字体|cpu|内存|启动参数)/i;

function shouldIncludeBrowserEnvironment(messages = []) {
  const recentUsers = messages.filter((message) => message?.role === 'user').slice(-2);
  return recentUsers.some((message) => BROWSER_ENVIRONMENT_INTENT.test(String(message.content || '')));
}

function selectedWindowTools(windowTools, initialMessages) {
  const tools = Array.isArray(windowTools?.tools) ? windowTools.tools : [];
  if (shouldIncludeBrowserEnvironment(initialMessages)) return tools;
  return tools.filter((tool) => String(tool?.name || '') !== 'browser_environment');
}

function appendDownloadWorkflow(workflow, available) {
  if (!available.has('browser_observe') || !available.has('browser_file')) return;
  workflow.push('用户要求下载页面上可见的图片元素时，先主动调用 browser_observe filter:"media" 获取 ref，再调用 browser_file action=download_element 并传 ref（可选 filename），由当前 Chromium Profile 直接保存 img.currentSrc；不要找下载按钮或用截图代替。普通文件链接则从 item.downloadUrl/downloadLinks[].url 取得真实地址后调用 action=download，下载图片/视频/音频链接时把条目的 category 传给 media_type，使用当前 Chromium 登录态和网络环境；不得根据链接文字猜测地址');
}

function appendOptionalWorkflows(workflow, available) {
  appendDownloadWorkflow(workflow, available);
  if (available.has('run_command')) {
    workflow.push('需要查看或处理 AI-Workspace 文件时使用 run_command；上传文件时把工作区内路径交给 browser_file action=upload；浏览器下载也会自动保存到该工作区');
  }
  if (available.has('manage_card')) {
    workflow.push('自动化卡片必须由你根据用户目标自行筛选：先看系统提供的卡片目录或调用 manage_card action=list，再对匹配的 id 或唯一 card_name 调用 get/run；禁止把工作台 selectedId、第一张卡片或设置项当成用户已指定的任务');
  }
  if (available.has('browser_environment')) {
    workflow.push('仅在用户要求查看或修改浏览器环境、指纹、代理等配置时使用 browser_environment');
  }
}

function createMcpContext(tools, connections, resolver, controlledConnectionId) {
  if (!tools.length) return null;
  const availableNames = tools.map((tool) => String(tool?.name || '').trim()).filter(Boolean);
  const toolNames = availableNames.join('、');
  const available = new Set(availableNames);
  const controlled = connections.find((item) => String(item?.id || '') === String(controlledConnectionId || ''));
  const routing = connections.length > 1
    ? `可用连接：${resolver.describeConnections()}。用户不会在设置中指定目标浏览器，必须由你根据用户目标自行选择。默认先控制“${String(controlled?.name || controlled?.id || '未知')}”。AI 同一时间最多控制一个浏览器；要操作其他浏览器，必须在下一次浏览器工具调用中传 change_browser（连接 ID 或唯一名称），切换后后续调用沿用新目标。禁止同时控制多个目标或猜测不存在的连接。`
    : (connections.length === 1
      ? `当前唯一可用浏览器为 ${resolver.describeConnections()}；无需传 change_browser，除非之后出现新的可用连接。用户不会在设置中指定目标浏览器。`
      : '当前没有可用的浏览器自动化连接，不要调用或虚构浏览器工具。需要浏览器时用 windows_tab 打开或创建栏目，等待 mcp_connected=true 后再操作页面。');
  const workflow = [];
  if (available.has('browser_tab')) workflow.push('使用 browser_tab 确认、切换或导航标签页');
  if (available.has('browser_observe') && available.has('browser_action')) {
    workflow.push('网页操作前先用 browser_observe 获取当前状态，再用 browser_action 操作；导航、切换标签页或页面明显变化后重新 observe，禁止跨浏览器或跨页面复用旧 ref');
  } else if (available.has('browser_observe')) workflow.push('用 browser_observe 读取当前页面，不虚构未返回的元素');
  if (available.has('browser_wait')) workflow.push('仅在页面确实需要加载或等待元素时使用 browser_wait');
  appendOptionalWorkflows(workflow, available);
  const browserWorkflow = workflow.length
    ? `${workflow.join('；')}。操作失败时根据错误调整策略，不要原样盲目重试。`
    : '';
  return {
    role: 'system',
    content: `你可以使用这些 AI-FREE MCP 工具：${toolNames}。${routing}${browserWorkflow}`
      + '只调用目录中真实存在的工具并严格遵守参数 schema。windows_tab 仅控制外部软件栏目：其 list 返回的 history_id 和 tab_id 不能当作 change_browser；栏目名称只有同时出现在可用连接列表时才能用于 change_browser。要显示或聚焦已有栏目，调用 windows_tab 的 open，并传 history_id 或唯一名称。'
      + 'browser_tab/browser_observe/browser_action/browser_wait 等浏览器工具只能控制当前目标，切换目标只能使用 change_browser；窗口已打开不等于其 MCP 已连接。'
      + 'windows_tab 的 open/create 会等待目标栏目的 Chromium 原生控制通道；只有返回 success=true、mcp_connected=true 和 control_browser_id 后才算可控，此时目标已自动切换，不要在连接就绪前调用页面工具。'
      + '当用户目标明确且操作安全时直接完成，不要为已知信息反复询问；涉及删除、覆盖、提交、支付或发送等重要动作时，以用户授权范围为准。'
      + '必须根据工具返回值判断下一步，未收到成功结果前不得声称操作完成；完成后用简洁自然语言说明实际结果，不要暴露内部调用格式。',
    ai_free_card_context: true,
  };
}

const AUTOMATION_CARD_CATALOG_LIMIT = 50;

function compactCatalogText(value, max = 80) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function formatAutomationCardCatalog(cards) {
  return cards.map((card) => {
    const parts = [
      `ID ${compactCatalogText(card.id, 80)}`,
      `名称 ${JSON.stringify(compactCatalogText(card.name, 80))}`,
    ];
    if (card.website) parts.push(`网站 ${JSON.stringify(compactCatalogText(card.website, 80))}`);
    if (card.description) parts.push(`说明 ${JSON.stringify(compactCatalogText(card.description, 80))}`);
    parts.push(`${Number(card.stepCount || 0)} 步`);
    return parts.join('，');
  }).join('；');
}

function createCardCatalogContext(cards, connections) {
  if (!connections.length) return null;
  const allCards = Array.isArray(cards) ? cards.filter((card) => card?.id) : [];
  if (!allCards.length) {
    return {
      role: 'system',
      content: '软件卡片库当前没有自动化卡片。需要卡片时通过 manage_card 的 rules/write 新建；不要假装已有可用卡片，也不要等待用户在设置中选择。',
      ai_free_card_context: true,
    };
  }
  const visible = allCards.slice(0, AUTOMATION_CARD_CATALOG_LIMIT);
  const omitted = allCards.length - visible.length;
  const extra = omitted > 0 ? `目录仅列出前 ${visible.length} 张，其余 ${omitted} 张请用 manage_card action=list 继续筛选。` : '';
  return {
    role: 'system',
    content: `软件卡片库现有 ${allCards.length} 张自动化卡片，必须由你根据用户目标自行筛选，不要依赖用户在 AI 控制设置中选择，也不要把工作台 selectedId 当作任务指定卡片。目录：${formatAutomationCardCatalog(visible)}。${extra}需要查看详情或运行时，用 manage_card 的 get/run 并传入匹配到的 id 或唯一 card_name；没有合适卡片时先 list 确认或按 rules 新建。禁止未筛选就默认使用第一张或某张“当前卡片”。`,
    ai_free_card_context: true,
  };
}

function buildChatToolContext(options = {}) {
  const { connections, controlledConnectionId, windowTools, automationCards, initialMessages } = options;
  const resolver = createConnectionResolver(connections);
  const tools = [...selectedWindowTools(windowTools, initialMessages), ...collectConnectionTools(connections, windowTools)];
  const cardContext = createCardCatalogContext(automationCards, connections);
  const mcpContext = createMcpContext(tools, connections, resolver, controlledConnectionId);
  return {
    ...resolver,
    tools,
    modelMessages: limitAiControlMessages([
      ...(mcpContext ? [mcpContext] : []),
      ...(cardContext ? [cardContext] : []),
      ...initialMessages,
    ]),
  };
}

module.exports = {
  AUTOMATION_CARD_CATALOG_LIMIT,
  buildChatToolContext,
  createCardCatalogContext,
  createConnectionResolver,
  createMcpContext,
  formatAutomationCardCatalog,
  selectedWindowTools,
  shouldIncludeBrowserEnvironment,
  withBrowserRouteParam,
};
