'use strict';

const { isWebDebugUrl, isViewportDimension, pointerAction } = require('../../../shared/mcp-mouse-debug');

function debugError(code, message) { return Object.assign(new Error(message), { code }); }

function checked(result, message) {
  if (result && result.success !== false && result.ok !== false) return result;
  throw debugError(result?.errorCode || 'MCP_DEBUG_RUNTIME_FAILED', result?.error || message);
}

function orderedConnections(bridge) {
  const online = new Map(bridge.listConnections().map((item) => [item.profileId, item]));
  return bridge.listBrowserRecords().map((record) => online.get(record.tabId)).filter(Boolean);
}

class McpMouseDebugSession {
  constructor({ fixtureUrl, bridge, runtime }) {
    this.fixtureUrl = fixtureUrl;
    this.bridge = bridge;
    this.runtime = runtime;
    this.active = null;
    this.transition = null;
    this.stopping = null;
    this.generation = 0;
  }

  dispatch(target, tool, args, bound = true) {
    if (this.bridge.getConnection(target.id)?.browserProcessId !== target.browserProcessId) {
      throw debugError('BROWSER_TARGET_CHANGED', '浏览器连接已变化');
    }
    return this.bridge.dispatch(target.id, tool, args, bound ? { expectedPageToken: target.token } : {});
  }

  async getTabs(browser) {
    return checked(await this.dispatch(browser, 'browser_tab', { action: 'list' }, false), '无法读取浏览器标签');
  }

  async bindTarget(browser, mode) {
    const matches = (tab) => mode === 'fixture' ? tab?.url === this.fixtureUrl : isWebDebugUrl(tab?.url);
    const listed = await this.getTabs(browser);
    let tab = listed.activeTab;
    const canActivateFixture = mode === 'fixture' && listed.tabs?.some(matches);
    if (!matches(tab) && !canActivateFixture) return null;
    const status = checked(await this.dispatch(browser, 'browser_control', { action: 'status' }, false), '无法读取接管状态');
    if (status.takeoverActive) throw debugError('MCP_DEBUG_TAKEOVER_BUSY', '该浏览器已被其他操作接管');
    if (!matches(tab)) {
      await this.showFixture(browser);
      tab = (await this.getTabs(browser)).activeTab;
    }
    if (!matches(tab) || !tab.pageToken) throw debugError('MCP_DEBUG_TARGET_UNAVAILABLE', '网页正在加载，请稍后再试');
    return { ...browser, token: tab.pageToken, url: tab.url };
  }

  async findTarget(mode) {
    for (const browser of orderedConnections(this.bridge)) {
      const target = await this.bindTarget(browser, mode);
      if (target) return target;
    }
    throw debugError('MCP_DEBUG_WEB_PAGE_REQUIRED', '请先将 HTTP 或 HTTPS 网页切换到前台，或打开内置测试页');
  }

  async release(target) {
    if (!target || this.bridge.getConnection(target.id)?.browserProcessId !== target.browserProcessId) return;
    checked(await this.dispatch(target, 'browser_control', { action: 'release' }, false), '无法释放调试接管');
  }

  async observe(target, screenshot = false) {
    const observation = checked(await this.dispatch(target, 'browser_observe', {
      mode: 'overview', limit: 1, include_text: false, mark: false, include_screenshot: screenshot,
    }), '无法观察网页');
    if (observation.url !== target.url) throw debugError('BROWSER_TARGET_CHANGED', '网页地址已变化');
    const viewport = observation.viewport;
    if (!viewport || ![viewport.width, viewport.height].every(isViewportDimension)) {
      throw debugError('MCP_DEBUG_VIEWPORT_UNAVAILABLE', '浏览器视口不可用');
    }
    return observation;
  }

  async getFrame(target) {
    const { dataUrl, viewport } = await this.observe(target, true);
    if (!dataUrl?.startsWith('data:image/png;base64,')) throw debugError('MCP_DEBUG_VIEWPORT_UNAVAILABLE', '页面预览不可用');
    return { viewWidth: viewport.width, viewHeight: viewport.height, dataUrl, browserName: target.name, url: target.url };
  }

  async activate(expected, mode) {
    const target = await this.findTarget(mode);
    if (expected !== this.generation) throw debugError('MCP_DEBUG_STOPPED', '调试已停止');
    const receipt = checked(await this.dispatch(target, 'browser_control', { action: 'acquire' }), '无法接管网页');
    if (!receipt.takeoverActive) throw debugError('MCP_DEBUG_TAKEOVER_FAILED', '浏览器未进入接管模式');
    try {
      const frame = await this.getFrame(target);
      if (expected !== this.generation) throw debugError('MCP_DEBUG_STOPPED', '调试已停止');
      this.active = target;
      return frame;
    } catch (error) {
      await this.release(target);
      throw error;
    }
  }

  isBusy() { return Boolean(this.active || this.transition || this.stopping); }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.deactivate().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async deactivate() {
    this.generation += 1;
    const previous = this.active;
    this.active = null;
    const pending = this.transition;
    await this.release(previous);
    if (pending) await pending.catch(() => {});
    return { stopped: true };
  }

  start(mode = 'active') {
    if (!['active', 'fixture'].includes(mode)) throw debugError('MCP_DEBUG_INPUT_INVALID', '调试目标类型无效');
    if (this.transition || this.stopping || this.active) throw debugError('MCP_DEBUG_ALREADY_RUNNING', '鼠标调试已启动');
    this.transition = this.activate(this.generation, mode).finally(() => { this.transition = null; });
    return this.transition;
  }

  async whileActive(run) {
    const target = this.active;
    if (!target) throw debugError('MCP_DEBUG_NOT_RUNNING', '鼠标调试尚未启动');
    try {
      return await run(target);
    } catch (error) {
      if (!['MCP_DEBUG_INPUT_STALE', 'MCP_DEBUG_INPUT_INVALID'].includes(error.code) && this.active === target) {
        await this.stop();
      }
      throw error;
    }
  }

  input(event) {
    return this.whileActive(async (target) => {
      const { viewport } = await this.observe(target);
      const args = pointerAction(event, viewport);
      if (this.active !== target) throw debugError('MCP_DEBUG_STOPPED', '调试已停止');
      const result = checked(await this.dispatch(target, 'browser_action', args), 'MCP 鼠标动作失败');
      if (result.success !== true) throw debugError('MCP_DEBUG_RUNTIME_FAILED', 'MCP 未确认鼠标动作');
      return { dispatched: args.action, tool: 'browser_action' };
    });
  }

  frame() { return this.whileActive((target) => this.getFrame(target)); }

  async showFixture(browser) {
    const reply = await this.runtime.openForegroundTab(browser.profileId, 'chromium', this.fixtureUrl);
    if ((reply?.result || reply)?.url !== this.fixtureUrl) {
      throw debugError('MCP_DEBUG_FIXTURE_NOT_OPEN', '无法打开内置测试页');
    }
  }

  async openFixture() {
    const browser = orderedConnections(this.bridge)[0];
    if (!browser) throw debugError('MCP_DEBUG_BROWSER_OFFLINE', '请先从首页打开一个浏览器');
    await this.showFixture(browser);
    return { opened: true };
  }
}

function createMcpMouseDebugSession(options) { return new McpMouseDebugSession(options); }

module.exports = { createMcpMouseDebugSession };
