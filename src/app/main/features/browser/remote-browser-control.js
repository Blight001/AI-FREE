'use strict';

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const CAPTURE_INTERVALS = Object.freeze({ smooth: 180, balanced: 300, clear: 500 });
const MAX_TEXT_LENGTH = 64 * 1024;
const INPUT_HANDLERS = Object.freeze({
  down: 'pointerDown',
  up: 'pointerUpInput',
  scroll: 'scrollInput',
  text: 'textInput',
  key: 'keyInput',
});

function text(value) {
  return String(value ?? '').trim();
}

function boundedCoordinate(value, size) {
  const normalized = Math.max(0, Math.min(1, Number(value) || 0));
  return Math.min(Math.max(0, size - 1), Math.round(normalized * size));
}

function runtimeResult(response) {
  return response?.result || response || {};
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeTab(tab, index, activeIdentity) {
  const source = tab && typeof tab === 'object' ? tab : {};
  const numericIndex = Number(source.index);
  const id = Number.isInteger(numericIndex) ? numericIndex : index;
  const sameIdentity = [source.id, source.tabId, source.index]
    .some((value) => text(value) === activeIdentity);
  return {
    id,
    title: text(firstValue(source.title, source.url, '新标签页')),
    url: text(source.url),
    favIconUrl: text(firstValue(source.favIconUrl, source.favicon)),
    active: source.active === true || sameIdentity,
    index: id,
  };
}

function normalizeTabs(result = {}) {
  const source = Array.isArray(result.tabs) ? result.tabs : (Array.isArray(result) ? result : []);
  const activeSource = result.activeTab || result.active || null;
  const activeIdentity = text(firstValue(result.activeTabId, activeSource?.id, activeSource?.index));
  const tabs = source.map((tab, index) => normalizeTab(tab, index, activeIdentity));
  const activeTab = tabs.find((tab) => tab.active);
  return {
    activeTabId: activeTab?.id ?? 0,
    controllable: true,
    tabs,
  };
}

function resolveTarget(runtime, getActiveProfileId) {
  const profileId = text(getActiveProfileId());
  const state = profileId ? runtime?.getState?.(profileId) : null;
  if (!profileId || !state?.pid || state?.bridgeConnected !== true) return null;
  return { profileId, processId: Number(state.pid) };
}

function captureInterval(qualityPreset) {
  return CAPTURE_INTERVALS[text(qualityPreset)] ?? CAPTURE_INTERVALS.balanced;
}

function normalizeAddress(value) {
  const input = text(value);
  if (!input) return 'about:blank';
  if (/^[a-z]+:\/\//i.test(input) || input.startsWith('about:')) return input;
  if (!/\s/.test(input) && /\.[a-z]{2,}$/i.test(input.split('/')[0])) return `https://${input}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(input)}`;
}

async function fetchIceServers(fetchImpl, server, token) {
  try {
    const response = await fetchImpl(`${text(server).replace(/\/+$/, '')}/api/rtc/ice-servers`, {
      headers: { Authorization: `Bearer ${text(token)}` },
    });
    if (!response.ok) return DEFAULT_ICE_SERVERS;
    const payload = await response.json();
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    return Array.isArray(data?.ice_servers) && data.ice_servers.length
      ? data.ice_servers : DEFAULT_ICE_SERVERS;
  } catch (_) {
    return DEFAULT_ICE_SERVERS;
  }
}

class RemoteBrowserControl {
  constructor(options = {}) {
    this.runtime = options.browserRuntimeManager;
    this.getActiveProfileId = options.getActiveProfileId || (() => '');
    this.peer = options.peer;
    this.fetch = options.fetch || globalThis.fetch;
    this.logger = options.logger || console;
    this.sendSignal = options.sendSignal || (() => {});
    this.session = null;
  }

  async start(request = {}, connection = {}) {
    const sessionId = text(request.sessionId);
    if (!sessionId) return false;
    await this.stop('replaced', true);
    const target = resolveTarget(this.runtime, this.getActiveProfileId);
    if (!target) {
      this.sendSignal('rc:error', {
        sessionId, code: 'no_browser', message: 'AI-FREE 当前没有可远程控制的活动浏览器',
      });
      return false;
    }
    const iceServers = await fetchIceServers(this.fetch, connection.server, connection.token);
    const session = {
      sessionId,
      ...target,
      intervalMs: captureInterval(request.qualityPreset),
      stopped: false,
      timer: null,
      frameBusy: false,
      width: 0,
      height: 0,
      pointerDown: null,
      inputTask: Promise.resolve(),
      nextStateAt: 0,
    };
    this.session = session;
    try {
      await this.perform({ action: 'acquire' }, 'automation-takeover');
      await this.peer.start(sessionId, iceServers);
      if (this.session !== session || session.stopped) return false;
      await this.publishBrowserState();
      this.scheduleFrame(0);
      return true;
    } catch (error) {
      this.sendSignal('rc:error', {
        sessionId, code: 'remote_start_failed', message: text(error?.message || '远程浏览器启动失败'),
      });
      await this.stop('start_failed', false);
      return false;
    }
  }

  answer(data = {}) {
    if (!this.isCurrent(data.sessionId)) return Promise.resolve();
    return this.peer.answer(this.session.sessionId, data.sdp);
  }

  ice(data = {}) {
    if (!this.isCurrent(data.sessionId)) return Promise.resolve();
    return this.peer.ice(this.session.sessionId, data.candidate);
  }

  isCurrent(sessionId) {
    return !!this.session && !this.session.stopped && this.session.sessionId === text(sessionId);
  }

  handlePeerMessage(message = {}) {
    if (!this.isCurrent(message.sessionId)) return;
    if (message.event === 'offer') this.sendSignal('rc:offer', { sessionId: message.sessionId, sdp: message.sdp });
    else if (message.event === 'ice') this.sendSignal('rc:ice', { sessionId: message.sessionId, candidate: message.candidate });
    else if (message.event === 'ready') this.handleReady(message);
    else if (message.event === 'stopped') void this.stop('peer_stopped', true);
    else if (message.event === 'control') this.queueControl(message.message);
  }

  handleReady(message) {
    this.session.width = Math.max(1, Number(message.width) || 1);
    this.session.height = Math.max(1, Number(message.height) || 1);
    this.sendSignal('rc:ready', {
      sessionId: this.session.sessionId,
      width: this.session.width,
      height: this.session.height,
      rotation: 0,
    });
  }

  queueControl(message = {}) {
    const session = this.session;
    if (!session) return;
    session.inputTask = session.inputTask
      .then(() => message?.kind === 'browser' ? this.browserCommand(message) : this.dispatchInput(message))
      .catch(() => {});
  }

  scheduleFrame(delay) {
    const session = this.session;
    if (!session || session.stopped) return;
    session.timer = setTimeout(() => void this.captureFrame(), delay);
    session.timer.unref?.();
  }

  async captureFrame() {
    const session = this.session;
    if (!session || session.stopped || session.frameBusy) return;
    session.frameBusy = true;
    try {
      const result = await this.perform({ format: 'png', fullPage: false }, 'capture-screenshot');
      if (this.session !== session || session.stopped) return;
      const dataUrl = text(result?.dataUrl);
      if (dataUrl.startsWith('data:image/')) await this.peer.frame(session.sessionId, dataUrl);
      if (Date.now() >= session.nextStateAt) {
        session.nextStateAt = Date.now() + 1500;
        await this.publishBrowserState();
      }
    } catch (error) {
      this.logger.warn?.('[RemoteBrowser] 采集浏览器画面失败:', error?.message || error);
    } finally {
      session.frameBusy = false;
      if (this.session === session && !session.stopped) this.scheduleFrame(session.intervalMs);
    }
  }

  perform(input, command = 'perform-action') {
    const session = this.session;
    if (!session) return Promise.reject(new Error('远程浏览器会话不存在'));
    return this.runtime.dispatchAutomationByProcessId(session.processId, command, input).then(runtimeResult);
  }

  async dispatchInput(input = {}) {
    const session = this.session;
    if (!session || !session.width || !session.height) return;
    const x = boundedCoordinate(input.x, session.width);
    const y = boundedCoordinate(input.y, session.height);
    const handler = INPUT_HANDLERS[text(input.type)];
    if (handler) await this[handler](input, x, y);
  }

  pointerDown(input, x, y) {
    this.session.pointerDown = { x, y, button: text(input.button || 'left') };
  }

  pointerUpInput(input, x, y) {
    return this.pointerUp(input, x, y);
  }

  scrollInput(input, x, y) {
    return this.perform({
      action: 'scroll', x, y,
      direction: Number(input.dy) < 0 ? 'up' : 'down',
      amount: Math.abs(Number(input.dy) || 400),
    });
  }

  textInput(input) {
    if (!input.text) return undefined;
    return this.perform({ action: 'insert_text', text: String(input.text).slice(0, MAX_TEXT_LENGTH) });
  }

  keyInput(input) {
    if (input.action === 'up' || !input.key) return undefined;
    return this.perform({ action: 'press_key', key: this.keyCombination(input) });
  }

  async pointerUp(input, x, y) {
    const session = this.session;
    const down = session.pointerDown;
    session.pointerDown = null;
    if (down && Math.hypot(down.x - x, down.y - y) > 4) {
      await this.perform({ action: 'drag', x: down.x, y: down.y, to_x: x, to_y: y });
      return;
    }
    const button = text(input.button || down?.button || 'left');
    const action = button === 'right' ? 'right_click' : 'click';
    await this.runtime.dispatchInput(session.profileId, {
      inputType: 'mouse', action, x, y,
      viewportWidth: session.width, viewportHeight: session.height,
    });
  }

  keyCombination(input) {
    const parts = [];
    if (input.ctrl) parts.push('Ctrl');
    if (input.alt) parts.push('Alt');
    if (input.shift) parts.push('Shift');
    if (input.meta) parts.push('Meta');
    parts.push(String(input.key));
    return parts.join('+');
  }

  async browserCommand(command = {}) {
    const action = text(command.action);
    if (action === 'reload') await this.runtime.reload(this.session.profileId, 'chromium');
    else if (action === 'navigate') await this.runtime.navigate(this.session.profileId, 'chromium', normalizeAddress(command.url));
    else if (action === 'new-tab') await this.runtime.openTabs(this.session.profileId, 'chromium', [normalizeAddress(command.url)]);
    else if (action === 'switch-tab') await this.perform({ index: Number(command.index ?? command.tabId) }, 'activate-tab');
    else if (action === 'close-tab') {
      await this.perform({ index: Number(command.index ?? command.tabId) }, 'activate-tab');
      await this.perform({ action: 'press_key', key: 'Ctrl+W' });
    } else if (action === 'back') await this.perform({ action: 'press_key', key: 'Alt+ArrowLeft' });
    else if (action === 'forward') await this.perform({ action: 'press_key', key: 'Alt+ArrowRight' });
    await this.publishBrowserState();
  }

  async publishBrowserState() {
    const session = this.session;
    if (!session || session.stopped) return;
    try {
      const result = await this.perform({}, 'list-tabs');
      await this.peer.browserState(session.sessionId, normalizeTabs(result));
    } catch (_) {}
  }

  async stop(reason = 'operator_stop', notify = false) {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.stopped = true;
    if (session.timer) clearTimeout(session.timer);
    try {
      await this.runtime.dispatchAutomationByProcessId(session.processId, 'automation-takeover', { action: 'release' });
    } catch (_) {}
    try { await this.peer.stop?.(); } catch (_) {}
    if (notify) this.sendSignal('rc:stopped', { sessionId: session.sessionId, reason });
  }

  stopSession(sessionId) {
    if (!this.isCurrent(sessionId)) return Promise.resolve();
    return this.stop('operator_stop', false);
  }
}

function createRemoteBrowserControl(options) {
  return new RemoteBrowserControl(options);
}

module.exports = {
  DEFAULT_ICE_SERVERS,
  RemoteBrowserControl,
  createRemoteBrowserControl,
  fetchIceServers,
  normalizeAddress,
  normalizeTabs,
};
