'use strict';

const { randomUUID } = require('crypto');
const { createBrowserOverview } = require('./browser-overview-service');
const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require('./native-browser-tool-definitions');
const {
  expiredObservedRefResult, mismatchedObservationResult, observedTarget, processObservationResult,
} = require('./native-browser-observation');
const { waitForBrowserCondition } = require('./native-browser-wait');
const { browserFile, observedRef } = require('./native-browser-file');

const CONNECTION_PREFIX = 'native:';
const READY_STATUSES = new Set(['ready', 'hidden']);
const FILE_CHOOSER_ACTIONS = new Set(['click', 'double_click']);
const OBSERVATION_HISTORY_LIMIT = 3;
const OBSERVATION_HISTORY_TTL_MS = 30000;

function text(value) { return String(value == null ? '' : value).trim(); }

function nonNegativePoint(x, y) {
  const point = { x: Number(x), y: Number(y) };
  if (!Object.values(point).every(Number.isFinite)) return null;
  return Math.min(point.x, point.y) >= 0 ? point : null;
}

function runtimeTarget(target) {
  const {
    observedTag: _observedTag,
    observedInputType: _observedInputType,
    requiresFileUpload: _requiresFileUpload,
    observedRefExpired: _observedRefExpired,
    observedRefRecoveryCandidate: _observedRefRecoveryCandidate,
    observedRefRecoveryError: _observedRefRecoveryError,
    observedRefRecoveryReason: _observedRefRecoveryReason,
    observedRefRecovered: _observedRefRecovered,
    observationId: _observationId,
    stableRef: _stableRef,
    observedRole: _observedRole,
    observedLabel: _observedLabel,
    observedUrl: _observedUrl,
    selectorUnique: _selectorUnique,
    selectorStability: _selectorStability,
    ...input
  } = target;
  return input;
}

function normalizedComparable(value) {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

function recoveryMatches(previous, item) {
  const selectorMatches = text(previous.selector) && text(previous.selector) === text(item.selector);
  const stableRefMatches = text(previous.stableRef) && text(previous.stableRef) === text(item.stableRef);
  if (!selectorMatches && !stableRefMatches) return false;
  if (previous.observedTag && previous.observedTag !== normalizedComparable(item.tag)) return false;
  if (previous.observedRole && previous.observedRole !== normalizedComparable(item.role)) return false;
  const nextLabel = normalizedComparable(item.label || item.ariaLabel || item.placeholder || item.text);
  return !previous.observedLabel || normalizedComparable(previous.observedLabel) === nextLabel;
}

function recoverableLocator(target) {
  return target?.selectorUnique === true
    && ['high', 'medium'].includes(text(target.selectorStability).toLowerCase())
    && !!text(target.selector);
}

function selectorTargetsFileInput(value) {
  const selector = text(value).toLowerCase();
  return /(^|[\s,>+~])input[^,]*\[type\s*=\s*["']?file["']?\s*\]/.test(selector);
}

function fileUploadRequired(input) {
  if (!FILE_CHOOSER_ACTIONS.has(text(input.action).toLowerCase())) return null;
  if (input.requiresFileUpload !== true && !selectorTargetsFileInput(input.selector)) return null;
  return {
    success: false,
    action: text(input.action).toLowerCase(),
    errorCode: 'FILE_UPLOAD_REQUIRED',
    error: '已阻止打开系统文件选择窗口；此操作需要先附带文件。请调用 browser_file action=upload，并提供 AI-Workspace 内的 path 或 paths 以及当前 selector/ref。',
    requiresFile: true,
    suggestedTool: 'browser_file',
    suggestedAction: 'upload',
    selector: text(input.selector),
    ref: text(input.ref),
  };
}

function isReadOnlyTool(tool, args) {
  const action = text(args.action).toLowerCase();
  if (['browser_observe', 'browser_screenshot', 'browser_wait', 'browser_control'].includes(tool)) return true;
  if (tool === 'browser_tab') return action === 'list';
  if (tool === 'browser_file') return ['info', 'save_session'].includes(action);
  if (tool === 'manage_card') return ['rules', 'list', 'get'].includes(action);
  return false;
}

function takeoverRequired(tool, args) {
  return {
    success: false,
    errorCode: 'BROWSER_TAKEOVER_REQUIRED',
    error: '浏览器当前为只读模式。请先调用 browser_control action=acquire 正式接管页面；完成后调用 action=release。',
    requestedTool: tool,
    requestedAction: text(args.action).toLowerCase(),
    takeoverActive: false,
    suggestedTool: 'browser_control',
    suggestedAction: 'acquire',
  };
}

function runtimeUpdateRequired(action) {
  return {
    success: false,
    action,
    errorCode: 'BROWSER_RUNTIME_UPDATE_REQUIRED',
    error: '当前浏览器仍是旧版 Chromium Runtime，不支持正式接管。服务器重启不会更新本地浏览器内核；请重新构建并替换 resources/chromium 后，完全退出并重启 AI-FREE-app。',
    takeoverActive: false,
    readOnly: true,
  };
}

function isOldTakeoverRuntime(value) {
  return text(value?.code || value?.errorCode) === 'COMMAND_NOT_ALLOWED'
    || text(value?.message || value?.error).includes('Runtime Bridge 命令不在白名单');
}

function normalizeToolName(value) {
  return value === 'browser_download' ? 'browser_file' : value;
}

function normalizeUrl(value) {
  const raw = text(value);
  if (!raw) throw new Error('缺少要打开的网址');
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('浏览器导航只支持 HTTP/HTTPS 地址');
  return parsed.href;
}

function tabItems(getTabs) {
  const tabs = typeof getTabs === 'function' ? getTabs() : [];
  return tabs instanceof Map ? Array.from(tabs.values()) : (Array.isArray(tabs) ? tabs : []);
}

function findTab(getTabs, profileId) {
  return tabItems(getTabs).find((tab) => text(tab?.id) === text(profileId)) || null;
}

function publicConnection(state, tab) {
  const profileId = text(state.profileId);
  const name = text(tab?.fixedTitle || tab?.tabTitle || tab?.runtimeTitle || profileId || 'AI-FREE 浏览器');
  return {
    id: `${CONNECTION_PREFIX}${profileId}`,
    instanceId: profileId,
    profileId,
    browserProcessId: Number(state.pid) || 0,
    name,
    platform: 'ai-free-chromium-native',
    version: '1',
    toolCount: NATIVE_BROWSER_TOOL_DEFINITIONS.length,
    capabilities: NATIVE_BROWSER_TOOL_DEFINITIONS.map((tool) => tool.name),
    connectedAt: Number(state.startedAt) || 0,
    lastSeenAt: Number(state.lastHeartbeatAt) || Date.now(),
    online: state.bridgeConnected === true && READY_STATUSES.has(text(state.status)),
  };
}

class NativeBrowserAutomation {
  constructor(options = {}) {
    this.runtime = options.browserRuntimeManager;
    this.getTabs = options.getTabs;
    this.executeCardTool = options.executeCardTool;
    this.downloadService = options.browserDownloadService;
    this.cardService = options.cardService || null;
    this.workspaceDir = options.workspaceDir;
    this.getBrowserRecords = options.getBrowserRecords;
    this.observeTargets = new Map();
    this.observationHistory = new Map();
    this.takeoverConnections = new Set();
  }

  listConnections() {
    const states = this.runtime?.listStates?.() || [];
    return states.filter((state) => (
      state?.bridgeConnected === true && READY_STATUSES.has(text(state.status)) && text(state.profileId)
    )).map((state) => publicConnection(state, findTab(this.getTabs, state.profileId)));
  }

  getConnection(id) {
    const connection = this.listConnections().find((item) => item.id === text(id));
    return connection ? { ...connection, tools: NATIVE_BROWSER_TOOL_DEFINITIONS } : null;
  }

  requireConnection(id) {
    const connection = this.getConnection(id);
    if (connection) return connection;
    const error = /** @type {Error & {errorCode?: string, phase?: string}} */ (
      new Error('所选 AI-FREE Chromium 原生控制连接已离线，请刷新连接列表')
    );
    error.errorCode = 'BROWSER_CONNECTION_NOT_FOUND';
    error.phase = 'native_connection';
    throw error;
  }

  async runtimeCommand(connection, command, input = {}) {
    const response = await this.runtime.dispatchAutomationByProcessId(connection.browserProcessId, command, input);
    const result = response?.result || response || {};
    if (result?.errorCode === 'BROWSER_TAKEOVER_REQUIRED') {
      this.takeoverConnections.delete(connection.id);
    }
    return result;
  }

  async browserTab(connection, args) {
    const action = text(args.action).toLowerCase();
    const profileId = connection.profileId;
    if (action === 'list') return this.runtimeCommand(connection, 'list-tabs');
    if (action === 'switch') {
      const index = Number(args.index ?? args.tab_index ?? args.id ?? args.tab_id);
      const target = {
        url: text(args.url),
        index: Number.isInteger(index) && index >= 0 ? index : -1,
      };
      const switched = target.url || target.index >= 0
        ? await this.runtimeCommand(connection, 'activate-tab', target)
        : (await this.runtimeCommand(connection, 'list-tabs')).activeTab;
      await this.runtime.focus(profileId, 'chromium');
      this.takeoverConnections.delete(connection.id);
      return { success: true, action, ...switched };
    }
    if (action === 'reload') {
      await this.runtime.reload(profileId, 'chromium');
      return { success: true, action, id: profileId };
    }
    const url = normalizeUrl(args.url);
    if (action === 'replace') await this.runtime.navigate(profileId, 'chromium', url);
    else if (action === 'navigate') {
      await this.runtime.openTabs(profileId, 'chromium', [url]);
      await this.runtime.focus(profileId, 'chromium');
      this.takeoverConnections.delete(connection.id);
    }
    else throw new Error(`browser_tab 不支持的原生操作: ${action || '(空)'}`);
    return { success: true, action, id: profileId, url, cardStep: { name: `打开 ${new URL(url).hostname}`, type: 'navigate', url } };
  }

  async browserAction(connection, args) {
    let input = this.resolveObservedTarget(connection, args);
    if (input.observedRefRecoveryCandidate) input = await this.recoverObservedTarget(connection, input);
    const mismatch = mismatchedObservationResult(input);
    if (mismatch) return mismatch;
    const expired = expiredObservedRefResult(input);
    if (expired) return expired;
    if (text(input.action) === 'upload_file') throw new Error('文件上传请使用 browser_file action=upload');
    const blocked = fileUploadRequired(input);
    if (blocked) return blocked;
    const result = await this.runtimeCommand(connection, 'perform-action', runtimeTarget(input));
    return input.observedRefRecovered === true
      ? { ...result, refRecovered: true, recoveryStrategy: 'unique-observed-selector' }
      : result;
  }

  async browserControl(connection, args) {
    const action = text(args.action || 'status').toLowerCase();
    if (action === 'overview') return this.browserOverview(args);
    let result;
    try {
      result = await this.runtimeCommand(connection, 'automation-takeover', { action });
    } catch (error) {
      if (!isOldTakeoverRuntime(error)) throw error;
      this.takeoverConnections.delete(connection.id);
      return runtimeUpdateRequired(action);
    }
    if (isOldTakeoverRuntime(result)) {
      this.takeoverConnections.delete(connection.id);
      return runtimeUpdateRequired(action);
    }
    if (result?.takeoverActive === true) this.takeoverConnections.add(connection.id);
    else this.takeoverConnections.delete(connection.id);
    return result;
  }

  browserOverview(args = {}) {
    const connections = this.listConnections();
    return createBrowserOverview({
      connections,
      records: this.getBrowserRecords?.() || [],
      workspaceDir: this.workspaceDir,
      listTabs: (connection) => this.runtimeCommand(connection, 'list-tabs'),
    }, args);
  }

  dispatchBasicTool(connection, tool, input) {
    if (tool === 'browser_observe') return this.browserObserve(connection, input);
    if (tool === 'browser_screenshot') return this.runtimeCommand(connection, 'capture-screenshot', input);
    if (tool === 'browser_action') return this.browserAction(connection, input);
    if (tool === 'browser_wait') return this.browserWait(connection, input);
    if (tool === 'browser_tab') return this.browserTab(connection, input);
    if (tool === 'browser_file') return this.browserFile(connection, input);
    if (tool === 'browser_control') return this.browserControl(connection, input);
    return null;
  }

  runtimeTarget(target) { return runtimeTarget(target); }

  resolveObservedTarget(connection, args) {
    const ref = observedRef(args);
    const normalized = ref && !text(args.ref) ? { ...args, ref } : args;
    if (text(normalized.selector) || !text(normalized.ref)) return normalized;
    const target = this.observeTargets.get(connection.id)?.get(text(normalized.ref));
    const requestedObservationId = text(normalized.observation_id ?? normalized.observationId);
    if (target && (!requestedObservationId || requestedObservationId === target.observationId)) {
      return this.mergeObservedTarget(target, normalized);
    }
    if (requestedObservationId) {
      const historic = this.findHistoricTarget(connection.id, requestedObservationId, text(normalized.ref));
      if (historic) return { ...normalized, observedRefRecoveryCandidate: historic };
      return { ...normalized, observationMismatch: true };
    }
    return { ...normalized, observedRefExpired: true };
  }

  mergeObservedTarget(target, args) {
    const resolved = { ...target, ...args };
    if (!text(args.selector) && target.selector) resolved.selector = target.selector;
    const explicitPoint = nonNegativePoint(args.x, args.y);
    if (explicitPoint) Object.assign(resolved, explicitPoint);
    else if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      resolved.x = target.x;
      resolved.y = target.y;
    }
    return resolved;
  }

  findHistoricTarget(connectionId, observationId, ref) {
    this.pruneObservationHistory(connectionId);
    return this.observationHistory.get(connectionId)?.find((snapshot) => (
      snapshot.observationId === observationId
    ))?.targets.get(ref) || null;
  }

  pruneObservationHistory(connectionId) {
    const now = Date.now();
    const history = (this.observationHistory.get(connectionId) || [])
      .filter((snapshot) => now - snapshot.createdAt <= OBSERVATION_HISTORY_TTL_MS)
      .slice(-OBSERVATION_HISTORY_LIMIT);
    if (history.length) this.observationHistory.set(connectionId, history);
    else this.observationHistory.delete(connectionId);
  }

  rememberObservation(connectionId, observationId, targets) {
    const history = this.observationHistory.get(connectionId) || [];
    history.push({ observationId, createdAt: Date.now(), targets });
    this.observationHistory.set(connectionId, history.slice(-OBSERVATION_HISTORY_LIMIT));
  }

  async recoverObservedTarget(connection, input) {
    const previous = input.observedRefRecoveryCandidate;
    if (!recoverableLocator(previous)) {
      return {
        ...input, observedRefExpired: true, observedRefRecoveryCandidate: null,
        observedRefRecoveryReason: 'LOCATOR_NOT_STABLE',
        observedRefRecoveryError: '旧 ref 没有唯一且稳定的 selector，无法安全恢复；请重新执行 browser_observe。',
      };
    }
    const current = await this.runtimeCommand(connection, 'observe-page', {
      limit: 1000, includeText: true, includeMedia: true, showHighlights: false,
    });
    if (!previous.observedUrl || !text(current?.url) || text(current.url) !== previous.observedUrl) {
      return {
        ...input, observedRefExpired: true, observedRefRecoveryCandidate: null,
        observedRefRecoveryReason: 'DOCUMENT_CHANGED',
        observedRefRecoveryError: '页面身份无法确认或已发生导航，旧 ref 不再可信；请重新执行 browser_observe。',
      };
    }
    const matches = (Array.isArray(current?.items) ? current.items : [])
      .filter((item) => recoveryMatches(previous, item));
    if (matches.length !== 1 || matches[0].selectorUnique !== true) {
      return {
        ...input, observedRefExpired: true, observedRefRecoveryCandidate: null,
        observedRefRecoveryReason: matches.length > 1 ? 'LOCATOR_AMBIGUOUS' : 'TARGET_CHANGED',
        observedRefRecoveryError: matches.length > 1
          ? '旧 ref 在当前页面匹配到多个元素，已拒绝自动操作；请重新执行 browser_observe。'
          : '旧 ref 对应元素已消失或语义发生变化；请重新执行 browser_observe。',
      };
    }
    const recovered = observedTarget(matches[0], previous.observationId, { url: current.url });
    if (!recovered) return { ...input, observedRefExpired: true, observedRefRecoveryCandidate: null };
    return {
      ...this.mergeObservedTarget(recovered[1], input),
      observedRefRecoveryCandidate: null, observedRefRecovered: true,
    };
  }

  async browserObserve(connection, input) {
    const result = await this.runtimeCommand(connection, 'observe-page', input);
    const observationId = `obs-${randomUUID()}`;
    const decorated = processObservationResult(result, input, observationId);
    const targets = new Map(decorated.items
      .map((item) => observedTarget(item, observationId, { url: decorated.url })).filter(Boolean));
    this.observeTargets.set(connection.id, targets);
    this.rememberObservation(connection.id, observationId, targets);
    return decorated;
  }

  async browserWait(connection, args) {
    let input = this.resolveObservedTarget(connection, args);
    if (input.observedRefRecoveryCandidate) input = await this.recoverObservedTarget(connection, input);
    const mismatch = mismatchedObservationResult(input);
    if (mismatch) return mismatch;
    const expired = expiredObservedRefResult(input);
    if (expired) return expired;
    const selector = text(input.selector);
    const condition = text(input.condition).toLowerCase();
    if (selector || condition === 'url_matches') {
      return waitForBrowserCondition({
        input, selector, condition,
        runtimeCommand: (payload) => this.runtimeCommand(connection, 'perform-action', payload),
      });
    }
    const waitedMs = Math.min(120000, Math.max(0, Number(args.ms) || 1000));
    await new Promise((resolve) => setTimeout(resolve, waitedMs));
    return { success: true, waitedMs, cardStep: { name: `等待 ${waitedMs}ms`, type: 'wait', timeout: waitedMs } };
  }

  browserFile(connection, args) {
    return browserFile(this, connection, args);
  }

  async dispatch(connectionId, tool, args = {}, options = {}) {
    const connection = this.requireConnection(connectionId);
    const input = args && typeof args === 'object' ? args : {};
    const toolName = normalizeToolName(tool);
    if (!isReadOnlyTool(toolName, input) && !this.takeoverConnections.has(connection.id)) {
      return takeoverRequired(toolName, input);
    }
    const basicResult = this.dispatchBasicTool(connection, toolName, input);
    if (basicResult) return basicResult;
    if (toolName === 'manage_card' && this.cardService?.execute) {
      return this.cardService.execute(input, {
        timeoutMs: options.timeoutMs,
        dispatch: (nextTool, nextArgs) => this.executeCardTool
          ? this.executeCardTool(connectionId, nextTool, nextArgs, options)
          : this.dispatch(connectionId, nextTool, nextArgs, options),
      });
    }
    throw new Error(`未知的 Chromium 原生自动化工具: ${text(toolName) || '(空)'}`);
  }
}

function createNativeBrowserAutomation(options) { return new NativeBrowserAutomation(options); }

module.exports = { CONNECTION_PREFIX, createNativeBrowserAutomation, normalizeUrl, publicConnection };
