'use strict';

const DEBUG_FIXTURE_PATH = '/__ai-free-mcp-debug/';
const POINTER_TOOLS = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll']);

function isWebDebugUrl(value) {
  const url = URL.parse(typeof value === 'string' ? value : '');
  return !!url && ['http:', 'https:'].includes(url.protocol)
    && !url.username && !url.password;
}

function isViewportDimension(value) { return Number.isInteger(value) && value > 0 && value <= 32768; }

function isNormalizedPoint(x, y) {
  return [x, y].every((value) => Number.isFinite(value) && value >= 0 && value < 1);
}

function invalidInput() {
  return Object.assign(new Error('鼠标调试事件参数无效'), { code: 'MCP_DEBUG_INPUT_INVALID' });
}

function pointerAction(event, viewport) {
  const { action, x, y, viewWidth, viewHeight } = event || {};
  if (!POINTER_TOOLS.has(action) || !isNormalizedPoint(x, y)
      || ![viewWidth, viewHeight].every(isViewportDimension)) throw invalidInput();
  if (viewWidth !== viewport.width || viewHeight !== viewport.height) {
    throw Object.assign(new Error('视口已变化，请等待预览同步'), { code: 'MCP_DEBUG_INPUT_STALE' });
  }
  const args = { action, x: Math.floor(x * viewWidth), y: Math.floor(y * viewHeight), after: 'none' };
  if (action === 'drag') {
    if (!isNormalizedPoint(event.to_x, event.to_y)) throw invalidInput();
    return { ...args, to_x: Math.floor(event.to_x * viewWidth), to_y: Math.floor(event.to_y * viewHeight) };
  }
  if (action === 'scroll') {
    if (!['up', 'down'].includes(event.direction) || !Number.isFinite(event.amount)
        || event.amount < 1 || event.amount > 1200) throw invalidInput();
    return { ...args, direction: event.direction, amount: Math.round(event.amount) };
  }
  return args;
}

module.exports = { DEBUG_FIXTURE_PATH, isWebDebugUrl, isViewportDimension, pointerAction };
