'use strict';

const { findProfileIdByProcessId } = require('./runtime-input');

const AUTOMATION_COMMANDS = new Set([
  'observe-page', 'capture-screenshot', 'perform-action', 'download-element',
  'get-session-data', 'list-tabs', 'activate-tab', 'automation-takeover',
]);
const ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'drag', 'upload_file', 'scroll',
  'type', 'insert_text', 'set_selection', 'press_key', 'wait',
]);
const OBSERVE_FILTERS = new Set([
  'interactive', 'media', 'text', 'input', 'form',
  'button', 'link', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox',
  'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'treeitem', 'select', 'clickable',
  'text-input', 'number-input', 'date-time-input', 'file-input', 'color-input',
  'rich-text-input', 'icon-button', 'disclosure',
]);
const WAIT_CONDITIONS = new Set([
  'attached', 'visible', 'hidden', 'text_contains', 'text_changed', 'url_matches',
]);

function automationError(code, message) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function optionalText(value, maxLength = 8192) {
  if (value === undefined || value === null) return '';
  const result = String(value);
  if (result.length > maxLength) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', `文本参数超过 ${maxLength} 字符限制`);
  }
  return result;
}

function optionalTextList(value, maxItems = 32, maxLength = 64) {
  const values = Array.isArray(value) ? value : (isProvided(value) ? [value] : []);
  if (values.length > maxItems) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', `筛选项不能超过 ${maxItems} 个`);
  }
  return [...new Set(values.map((item) => optionalText(item, maxLength).trim().toLowerCase()).filter(Boolean))];
}

function normalizeLegacyObserveFilter(value) {
  const filter = optionalText(value, 64).trim().toLowerCase();
  if (!filter || OBSERVE_FILTERS.has(filter)) return filter;
  throw automationError(
    'INVALID_FILTER',
    `filter=${filter} 不受支持；请使用 kinds、tags、roles、control_types，或受支持的兼容 filter`,
  );
}

function normalizeRegion(value) {
  const region = asObject(value);
  if (!Object.keys(region).length) return {};
  const role = optionalText(region.role, 64).trim().toLowerCase();
  const label = optionalText(region.label, 256).trim();
  if (role || label) return { role, label, match: region.match === 'all' ? 'all' : 'best' };
  const point = normalizedPoint(region.x, region.y, 'region 必须提供有效的非负 x/y');
  const width = boundedInteger(region.width, 0, 1, 1_000_000);
  const height = boundedInteger(region.height, 0, 1, 1_000_000);
  if (!width || !height) throw automationError('AUTOMATION_PAYLOAD_INVALID', 'region 必须提供正数 width/height');
  return { ...point, width, height };
}

function normalizeRegionOptions(source) {
  const mode = optionalText(source.mode || 'elements', 32).toLowerCase();
  if (!['elements', 'overview'].includes(mode)) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', `不支持的观察 mode: ${mode}`);
  }
  const regionMode = optionalText(source.region_mode ?? source.regionMode ?? 'centerInside', 32);
  if (!['centerInside', 'fullyInside', 'intersecting'].includes(regionMode)) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', `不支持的 regionMode: ${regionMode}`);
  }
  return {
    mode,
    includeRegions: source.include_regions === true || source.includeRegions === true || mode === 'overview',
    maxDepth: boundedInteger(source.max_depth ?? source.maxDepth, 2, 1, 6),
    regionRef: optionalText(source.region_ref ?? source.regionRef, 128),
    region: normalizeRegion(source.region),
    regionMode,
    regionPadding: boundedInteger(source.padding, 10, 0, 100),
    includeAncestorContext: boundedInteger(
      source.include_ancestor_context ?? source.includeAncestorContext, 2, 0, 6,
    ),
    includePortals: source.include_portals !== false && source.includePortals !== false,
    expectedRegionLayoutHash: optionalText(
      source.region_layout_hash ?? source.regionLayoutHash, 128,
    ),
  };
}

function isProvided(value) {
  return value !== undefined && value !== null && value !== '';
}

function firstProvided(...values) {
  return values.find(isProvided);
}

function normalizedPoint(xValue, yValue, errorMessage) {
  const x = Number(xValue);
  const y = Number(yValue);
  if (![x, y].every(Number.isFinite) || Math.min(x, y) < 0) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', errorMessage);
  }
  return { x: Math.min(x, 1_000_000), y: Math.min(y, 1_000_000) };
}

function normalizeActionCoordinates(source, action) {
  const hasX = isProvided(source.x);
  const hasY = isProvided(source.y);
  if (!hasX && !hasY) return {};
  if (!hasX || !hasY) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', '页面坐标必须同时提供有效的非负 x/y');
  }
  const point = normalizedPoint(source.x, source.y, '页面坐标必须同时提供有效的非负 x/y');
  if (action !== 'drag') return point;
  const target = normalizedPoint(
    firstProvided(source.to_x, source.toX, source.end_x, source.endX),
    firstProvided(source.to_y, source.toY, source.end_y, source.endY),
    '拖拽必须提供有效的非负 to_x/to_y 终点坐标',
  );
  return { ...point, toX: target.x, toY: target.y };
}

function normalizeSelection(source) {
  const start = Number(source.start ?? source.selection_start ?? source.selectionStart);
  const end = Number(source.end ?? source.selection_end ?? source.selectionEnd ?? start);
  if (![start, end].every(Number.isFinite) || Math.min(start, end) < 0) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', '文本选区必须提供有效的非负 start/end');
  }
  const requestedDirection = optionalText(
    source.selection_direction ?? source.selectionDirection ?? 'forward', 16,
  ).toLowerCase();
  const selectionDirection = ['forward', 'backward', 'none'].includes(requestedDirection)
    ? requestedDirection : 'forward';
  return {
    start: boundedInteger(start, 0, 0, 1_000_000),
    end: boundedInteger(end, 0, 0, 1_000_000),
    selectionDirection,
  };
}

function normalizeObservePayload(source) {
  return {
    ...normalizeRegionOptions(source),
    limit: boundedInteger(source.limit ?? source.max_items, 200, 1, 1000),
    textLimit: boundedInteger(source.text_limit ?? source.textLimit, 120, 20, 500),
    keyword: optionalText(source.keyword, 512),
    tag: optionalText(source.tag, 64).toLowerCase(),
    tags: optionalTextList(source.tags),
    kinds: optionalTextList(source.kinds ?? source.kind),
    roles: optionalTextList(source.roles ?? source.role),
    controlTypes: optionalTextList(source.control_types ?? source.controlTypes),
    filter: normalizeLegacyObserveFilter(source.filter),
    includeText: source.include_text !== false,
    includeMedia: source.include_media !== false,
    showHighlights: source.mark !== false
      && source.show_highlights !== false
      && source.showHighlights !== false,
    highlightDurationMs: boundedInteger(
      source.highlight_duration_ms ?? source.highlightDurationMs,
      5000, 500, 30000,
    ),
  };
}

function normalizeScreenshotPayload(source) {
  const format = optionalText(source.format || 'png', 16).toLowerCase();
  if (format !== 'png') {
    throw automationError('SCREENSHOT_FORMAT_INVALID', '原生截图当前只支持 PNG');
  }
  return {
    format,
    x: boundedInteger(source.x, 0, 0, 1_000_000),
    y: boundedInteger(source.y, 0, 0, 1_000_000),
    width: boundedInteger(source.width, 0, 0, 1_000_000),
    height: boundedInteger(source.height, 0, 0, 1_000_000),
    selector: optionalText(source.selector, 4096),
    fullPage: source.full_page === true || source.fullPage === true,
  };
}

function normalizeWaitOptions(source, action) {
  if (action !== 'wait') return {};
  const condition = optionalText(source.condition, 32).trim().toLowerCase();
  if (condition && !WAIT_CONDITIONS.has(condition)) {
    throw automationError('AUTOMATION_WAIT_CONDITION_INVALID', `不支持的等待条件: ${condition}`);
  }
  const options = {};
  if (condition) options.condition = condition;
  if (isProvided(source.value ?? source.expected)) {
    options.expectedValue = optionalText(source.value ?? source.expected, 8192);
  }
  if (isProvided(source.initial_value ?? source.initialValue)) {
    options.initialValue = optionalText(source.initial_value ?? source.initialValue, 8192);
  }
  return options;
}

function normalizeActionPayload(source) {
  const action = optionalText(source.action, 32).trim();
  if (!ACTIONS.has(action)) {
    throw automationError('AUTOMATION_ACTION_INVALID', `不支持的原生页面动作: ${action || '<empty>'}`);
  }
  const keyboard = normalizeKeyboardInput(source);
  const coordinates = normalizeActionCoordinates(source, action);
  const selection = action === 'set_selection' ? normalizeSelection(source) : {};
  return {
    action,
    selector: optionalText(source.selector, 4096),
    text: optionalText(source.text ?? source.value, 1024 * 1024),
    ...keyboard,
    ...coordinates,
    ...selection,
    ...(action === 'press_key' ? { repeat: boundedInteger(source.repeat, 1, 1, 100) } : {}),
    ref: optionalText(source.ref, 128),
    direction: optionalText(source.direction || 'down', 16),
    amount: boundedInteger(source.amount ?? source.delta_y, 600, -100000, 100000),
    timeoutMs: boundedInteger(source.timeout_ms ?? source.timeout, 10000, 100, 120000),
    ...normalizeWaitOptions(source, action),
  };
}

function normalizeTabTarget(source) {
  const index = Number(source.index ?? source.tab_index ?? source.id ?? source.tab_id);
  return {
    url: optionalText(source.url, 8192).trim(),
    index: Number.isInteger(index) && index >= 0 ? index : -1,
  };
}

function normalizeDownloadElementPayload(source) {
  const coordinates = normalizeActionCoordinates(source, 'download_element');
  const selector = optionalText(source.selector, 4096);
  if (!selector && !isProvided(coordinates.x)) {
    throw automationError('AUTOMATION_PAYLOAD_INVALID', '元素下载必须提供 selector、ref 解析结果或 x/y 坐标');
  }
  const targetPath = optionalText(source.target_path ?? source.targetPath, 32768).trim();
  if (!targetPath) throw automationError('AUTOMATION_PAYLOAD_INVALID', '元素下载缺少工作区目标路径');
  return {
    selector, ref: optionalText(source.ref, 128), ...coordinates,
    targetPath, timeoutMs: boundedInteger(source.timeout_ms ?? source.timeout, 120000, 1000, 300000),
  };
}

function normalizeKeyboardInput(source) {
  const parts = optionalText(source.key, 64).split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts.length > 1 ? parts.pop() : (parts[0] || '');
  const names = new Set(parts.map((part) => part.toLowerCase()));
  return {
    key,
    ctrl: source.ctrl === true || source.control === true || names.has('ctrl') || names.has('control'),
    shift: source.shift === true || names.has('shift'),
    alt: source.alt === true || names.has('alt') || names.has('option'),
    meta: source.meta === true || names.has('meta') || names.has('cmd') || names.has('command') || names.has('win'),
  };
}

function normalizeRuntimeAutomation(command, source = {}) {
  const name = String(command || '').trim();
  if (!AUTOMATION_COMMANDS.has(name)) {
    throw automationError('AUTOMATION_COMMAND_INVALID', `不支持的 Chromium 自动化命令: ${name || '<empty>'}`);
  }
  const input = asObject(source);
  if (name === 'observe-page') return normalizeObservePayload(input);
  if (name === 'capture-screenshot') return normalizeScreenshotPayload(input);
  if (name === 'perform-action') return normalizeActionPayload(input);
  if (name === 'download-element') return normalizeDownloadElementPayload(input);
  if (name === 'activate-tab') return normalizeTabTarget(input);
  if (name === 'automation-takeover') {
    const action = optionalText(input.action || 'status', 16).toLowerCase();
    if (!['status', 'acquire', 'release'].includes(action)) {
      throw automationError('AUTOMATION_TAKEOVER_ACTION_INVALID', `不支持的接管操作: ${action}`);
    }
    return { action };
  }
  return {};
}

async function dispatchRuntimeAutomation(runtime, profileId, command, source) {
  const payload = normalizeRuntimeAutomation(command, source);
  const timeoutMs = Number('timeoutMs' in payload ? payload.timeoutMs : 10000) || 10000;
  return runtime.enqueueProfileOperation(profileId, () => (
    runtime.getReadyInstance(profileId).commandClient.send(command, payload, {
      timeoutMs: ['perform-action', 'download-element'].includes(command) ? timeoutMs + 2000 : 15000,
    })
  ));
}

async function dispatchRuntimeAutomationByProcessId(runtime, processId, command, source) {
  const profileId = findProfileIdByProcessId(runtime.instances, processId);
  if (profileId) return dispatchRuntimeAutomation(runtime, profileId, command, source);
  throw automationError(
    'CHROMIUM_PROCESS_NOT_MANAGED',
    `Chromium 进程 ${Number(processId || 0) || '<empty>'} 不属于当前受管 Profile`,
  );
}

module.exports = {
  ACTIONS,
  AUTOMATION_COMMANDS,
  dispatchRuntimeAutomation,
  dispatchRuntimeAutomationByProcessId,
  normalizeRuntimeAutomation,
};
