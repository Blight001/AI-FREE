'use strict';

const { randomUUID } = require('crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createBrowserOverview } = require('./browser-overview-service');
const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require('./native-browser-tool-definitions');
const {
  expiredObservedRefResult, mismatchedObservationResult, observedTarget, processObservationResult,
} = require('./native-browser-observation');
const { waitForBrowserCondition } = require('./native-browser-wait');
const { browserFile, resolvedFileAction } = require('./native-browser-file');
const { PAGE_TOKEN, bindPage, bindingFailure, boundToolFailure, expectedPageToken, runtimeBindingFailure } = require('./native-browser-page-binding');
const { resolveObservedTarget, recoverObservedTarget, rememberObservation } = require('./native-browser-ref-store');
const { browserMedia } = require('./native-browser-media');
const { executeBrowserTab } = require('./native-browser-tabs');
const { BrowserWorkflow } = require('./browser-workflow');
const { createBrowserPointerScheduler } = require('../features/browser/browser-pointer-scheduler');
const { NATIVE_SURFACES } = require('../features/browser/browser-native-pointer');
const { requestsAccessibility, accessibilityUnavailable, attachScreenshot, actionObservation } = require('./native-browser-feedback');

const PRIMARY_POINTER = 'primary';
const APP_INPUT_RESOURCE = 'app-window';

const CONNECTION_PREFIX = 'native:';
const READY_STATUSES = new Set(['ready', 'hidden']);
const FILE_CHOOSER_ACTIONS = new Set(['click', 'double_click']);

function text(value) { return String(value == null ? '' : value).trim(); }

function runtimeTarget(target) {
  const {
    [PAGE_TOKEN]: _pageToken,
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
    testId: _testId,
    elementId: _elementId,
    observedUrl: _observedUrl,
    selectorUnique: _selectorUnique,
    selectorStability: _selectorStability,
    ...input
  } = target;
  return input;
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

function appSurfaceDisallowed(input, options) {
  return input.surface && input.surface !== 'page' && options.allowAppSurface !== true;
}

function appPointerUnavailable() {
  return { success: false, errorCode: 'APP_SURFACE_UNAVAILABLE', error: '目标应用界面当前不可操作。', actionExecuted: false };
}

function isReadOnlyTool(tool, args) {
  const action = text(args.action).toLowerCase();
  if (['browser_observe', 'browser_screenshot', 'browser_wait', 'browser_control', 'browser_workflow'].includes(tool)) return true;
  if (tool === 'browser_media') return action === 'list';
  if (tool === 'browser_tab') return action === 'list';
  if (tool === 'browser_file') return ['info', 'save_session'].includes(action);
    if (tool === 'manage_card') return ['rules', 'list', 'get', 'template'].includes(action);
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
    this.appPointer = options.appPointer;
    this.nativePointer = options.nativePointer;
    this.executeCardTool = options.executeCardTool;
    this.downloadService = options.browserDownloadService;
    this.cardService = options.cardService || null;
    this.workspaceDir = options.workspaceDir;
    this.getBrowserRecords = options.getBrowserRecords;
    this.observeTargets = new Map();
    this.observationHistory = new Map();
    this.takeoverConnections = new Set();
    this.pointerScheduler = createBrowserPointerScheduler();
    this.workflow = new BrowserWorkflow(this);
  }

  listConnections() {
    const states = this.runtime?.listStates?.() || [];
    const connections = states.filter((state) => (
      state?.bridgeConnected === true && READY_STATUSES.has(text(state.status)) && text(state.profileId)
    )).map((state) => publicConnection(state, findTab(this.getTabs, state.profileId)));
    this.workflow.prune(connections);
    const onlineIds = new Set(connections.map(({ id }) => id));
    for (const id of this.takeoverConnections) {
      if (!onlineIds.has(id)) void this.releasePointerSession(id);
    }
    return connections;
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

  async runtimeCommand(connection, command, input = {}, signal = undefined) {
    const token = expectedPageToken(connection);
    const options = token === undefined && !signal ? [] : [{ expectedPageToken: token, ...(signal ? { signal } : {}) }];
    const response = await this.runtime.dispatchAutomationByProcessId(connection.browserProcessId, command, input, ...options);
    const result = response?.result || response || {};
    if (result?.errorCode === 'BROWSER_TAKEOVER_REQUIRED') void this.releasePointerSession(connection.id);
    return result;
  }

  releasePointerSession(connectionId) {
    this.takeoverConnections.delete(connectionId);
    return this.pointerScheduler.release(connectionId);
  }

  browserTab(connection, args) {
    return executeBrowserTab(this, connection, args, normalizeUrl);
  }

  async browserAction(connection, args, signal = undefined) {
    if (args.surface && args.surface !== 'page') return this.clickAppSurface(connection, args, signal);
    if (text(args.action) === 'upload_file') throw new Error('文件上传请使用 browser_file action=upload');
    const blocked = fileUploadRequired(this.resolveObservedTarget(connection, args));
    if (blocked) return blocked;
    return this.workflow.action(connection, args);
  }

  async browserActionRaw(connection, args, signal = undefined) {
    if (args.surface && args.surface !== 'page') return appPointerUnavailable();
    if (args.after && !['none', 'observe'].includes(args.after)) {
      return { success: false, errorCode: 'INVALID_ACTION_FEEDBACK', error: 'after 只支持 none 或 observe' };
    }
    let input = this.resolveObservedTarget(connection, args);
    if (input.observedRefRecoveryCandidate) input = await this.recoverObservedTarget(connection, input);
    const resolved = await this.resolveAccessibleAction(connection, input);
    if (resolved.failure) return resolved.failure;
    input = resolved.input;
    const mismatch = mismatchedObservationResult(input);
    if (mismatch) return mismatch;
    const expired = expiredObservedRefResult(input);
    if (expired) return expired;
    if (text(input.action) === 'upload_file') throw new Error('文件上传请使用 browser_file action=upload');
    const blocked = fileUploadRequired(input);
    if (blocked) return blocked;
    const result = await this.dispatchPointerAction(connection, input, signal);
    const actionResult = input.observedRefRecovered === true
      ? { ...result, refRecovered: true, recoveryStrategy: 'unique-observed-selector' }
      : result;
    return actionObservation(this, connection, actionResult, args);
  }

  async dispatchPointerAction(connection, input, signal = undefined) {
    try {
      return await this.pointerScheduler.run(connection.id, PRIMARY_POINTER, connection.id, () => {
        signal?.throwIfAborted();
        if (!this.takeoverConnections.has(connection.id)) {
          const failure = takeoverRequired('browser_action', input);
          return expectedPageToken(connection) ? { ...failure, actionExecuted: false } : failure;
        }
        return this.runtimeCommand(connection, 'perform-action', runtimeTarget(input), signal);
      });
    } catch (error) {
      if (error.code !== 'BROWSER_POINTER_RELEASED') throw error;
      return { ...takeoverRequired('browser_action', input), actionExecuted: false };
    }
  }

  async resolveAccessibleAction(connection, input) {
    if (text(input.selector) || !text(input.observedRole) || !text(input.observedLabel)) return { input };
    const resolved = await this.runtimeCommand(connection, 'inspect-page-state', {
      target: { role: input.observedRole, name: input.observedLabel, exact: true },
    });
    const target = resolved?.target;
    if (target?.count > 1) return { failure: {
      success: false, errorCode: 'TARGET_AMBIGUOUS', error: '观察到的目标在当前页面有多个匹配项，请使用 scope、nth 或 test_id', candidates: target.candidates || [], actionExecuted: false,
    } };
    if (!target?.found || target.count !== 1) return { input };
    return { input: { ...input, selector: target.selector || input.selector,
      x: target.clickX ?? input.x, y: target.clickY ?? input.y } };
  }

  async browserControl(connection, args) {
    const action = text(args.action || 'status').toLowerCase();
    if (action === 'overview') return this.browserOverview(args);
    if (action === 'release') await this.releasePointerSession(connection.id);
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

  async clickAppSurface(connection, input, callerSignal) {
    const native = NATIVE_SURFACES.has(input.surface);
    if (native ? !this.nativePointer : !this.appPointer) return appPointerUnavailable();
    try {
      return await this.pointerScheduler.run(connection.id, PRIMARY_POINTER, APP_INPUT_RESOURCE, (pointer, signal) => {
        if (!this.takeoverConnections.has(connection.id)) return takeoverRequired('browser_action', input);
        const activeSignal = callerSignal ? AbortSignal.any([callerSignal, signal]) : signal;
        if (activeSignal.aborted) return { ...takeoverRequired('browser_action', input), actionExecuted: false };
        if (native) return this.nativePointer.action(connection.profileId, input, pointer, activeSignal);
        return this.appPointer.click(connection.profileId, input.surface, input.ref, pointer, activeSignal, input);
      });
    } catch (error) {
      if (error.code !== 'BROWSER_POINTER_RELEASED') throw error;
      return { ...takeoverRequired('browser_action', input), actionExecuted: false };
    }
  }

  dispatchBasicTool(connection, tool, input, signal = undefined) {
    if (tool === 'browser_observe') return this.browserObserve(connection, input);
    if (tool === 'browser_screenshot') return this.runtimeCommand(connection, 'capture-screenshot', input);
    if (tool === 'browser_action') return this.browserAction(connection, input, signal);
    if (tool === 'browser_wait') return this.browserWait(connection, input, signal);
    if (tool === 'browser_tab') return this.browserTab(connection, input);
    if (tool === 'browser_file') return this.browserFile(connection, input);
    if (tool === 'browser_media') return browserMedia(this, connection, input);
    if (tool === 'browser_control') return this.browserControl(connection, input);
    if (tool === 'browser_workflow') return this.workflow.control(connection, input);
    return null;
  }

  runtimeTarget(target) { return runtimeTarget(target); }

  resolveObservedTarget(connection, args) { return resolveObservedTarget(this, connection, args); }

  recoverObservedTarget(connection, input) { return recoverObservedTarget(this, connection, input); }

  async browserObserve(connection, input) {
    if (NATIVE_SURFACES.has(input.surface)) {
      return this.nativePointer?.observe(connection.profileId, input.surface) || appPointerUnavailable();
    }
    if (input.surface && input.surface !== 'page') {
      return this.appPointer?.observe(connection.profileId, input.surface) || appPointerUnavailable();
    }
    const result = await this.runtimeCommand(connection, 'observe-page', input);
    if (result?.success === false || result?.ok === false) return result;
    if (requestsAccessibility(input) && !result.accessibilityTree) return accessibilityUnavailable(result);
    const observationId = `obs-${randomUUID()}`;
    const decorated = processObservationResult(result, input, observationId);
    const targets = new Map(decorated.items
      .map((item) => observedTarget(item, observationId, { url: decorated.url })).filter(Boolean));
    for (const target of targets.values()) target[PAGE_TOKEN] = expectedPageToken(connection);
    rememberObservation(this, connection.id, observationId, targets);
    return attachScreenshot(this, connection, decorated, input);
  }

  async browserWait(connection, args, signal = undefined) {
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
        input, selector, condition, signal,
        runtimeCommand: (payload) => this.runtimeCommand(connection, 'perform-action', payload, signal),
      });
    }
    const waitedMs = Math.min(120000, Math.max(0, Number(args.ms) || 1000));
    await delay(waitedMs, undefined, { signal });
    if (expectedPageToken(connection)) {
      const current = await this.runtimeCommand(connection, 'automation-takeover', { action: 'status' }, signal);
      if (current.success === false) return current;
    }
    return { success: true, waitedMs, cardStep: { name: `等待 ${waitedMs}ms`, type: 'wait', timeout: waitedMs } };
  }

  browserFile(connection, args) {
    return browserFile(this, connection, args);
  }

  async dispatch(connectionId, tool, args = {}, options = {}) {
    const connection = this.requireConnection(connectionId);
    const input = args && typeof args === 'object' ? args : {};
    const toolName = normalizeToolName(tool);
    if (options.expectedPageToken !== undefined) return this.dispatchBound(connection, toolName, input, options.expectedPageToken, options.signal);
    if (appSurfaceDisallowed(input, options)) return appPointerUnavailable();
    const blocked = this.workflow.blocked(connection, toolName, input);
    if (blocked) return blocked;
    if (!isReadOnlyTool(toolName, input) && !this.takeoverConnections.has(connection.id)) {
      return takeoverRequired(toolName, input);
    }
    const basicResult = this.dispatchBasicTool(connection, toolName, input, options.signal);
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

  async dispatchBound(connection, tool, input, token, signal = undefined) {
    if (typeof token !== 'string' || !token.trim() || token.length > 256) {
      return bindingFailure('BROWSER_TARGET_REQUIRED', '缺少有效的页面绑定');
    }
    const unsupported = boundToolFailure(tool, input, tool === 'browser_file' && resolvedFileAction(input));
    if (unsupported) return unsupported;
    const blocked = this.workflow.blocked(connection, tool, input);
    if (blocked) return blocked;
    if (!isReadOnlyTool(tool, input) && !this.takeoverConnections.has(connection.id)) {
      return { ...takeoverRequired(tool, input), actionExecuted: false };
    }
    const bound = bindPage(connection, token);
    try {
      // Workflow retries and diagnostics are not part of the bound action contract.
      return await (tool === 'browser_action'
        ? this.browserActionRaw(bound, input, signal) : this.dispatchBasicTool(bound, tool, input, signal));
    } catch (error) {
      return runtimeBindingFailure(error);
    }
  }
}

function createNativeBrowserAutomation(options) { return new NativeBrowserAutomation(options); }

module.exports = { CONNECTION_PREFIX, createNativeBrowserAutomation, normalizeUrl, publicConnection };
