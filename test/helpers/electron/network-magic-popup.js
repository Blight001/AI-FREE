'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { dispatchControl, poll, rendererProbe } = require('../flows/electron-controls');

const launcher = '#shell-network-magic-toggle';
const power = '#VPN-switch';
const close = '[data-network-magic-close]';
const systemMode = 'input[value="system"]';
const speedButton = '#vpn-node-retest-all-btn';
const globalMode = 'input[value="global"]';
const names = ['香港 01', 'HK 02', '日本 01', 'JP 02', '自定义节点'];
const initialEntries = [
  { name: names[0], delay: 200 },
  { name: names[1], delay: 201 },
  { name: names[2], delay: null, error: '超时' },
  { name: names[3], delay: null, error: 'fixture error' },
  { name: names[4], delay: null, delayText: '待测速' },
];

function createFixture(controller) {
  let savedMode = 'port';
  let mode = 'port';
  let running = false;
  let enabled = false;
  let selected = names[0];
  let nextStart = null;
  let nextRetest = null;
  let activePopup = null;
  const status = () => ({ ok: true, running, enabled: running && enabled, proxyMode: mode });
  function bind(popup) {
    activePopup = popup;
    const { ipc } = popup.webContents;
    const handlers = {
      'account-get-session': () => ({ authenticated: true }),
      'get-user-credentials': () => ({ ok: true, credentials: { key: 'fixture-key', deviceId: 'fixture-device' } }),
      'get-network-magic-auto-start-enabled': () => ({ ok: true, enabled: false }),
      'set-network-magic-auto-start-enabled': () => ({ ok: true }),
      'get-network-magic-proxy-mode': () => ({ ok: true, mode: savedMode }),
      'set-network-magic-proxy-mode': (_event, payload) => { savedMode = payload.mode; return { ok: true }; },
      'get-clash-config': () => ({ ok: true, content: 'proxies: []' }),
      'save-clash-config': () => ({ ok: true }),
      'get-clash-mini-status': status,
      'get-proxy-traffic-quota': () => ({ ok: true, quota: { used_bytes: 1 } }),
      'start-clash-mini': async (_event, payload) => {
        mode = payload.proxyMode;
        const gate = nextStart;
        nextStart = null;
        enabled = gate ? await gate : true;
        running = enabled;
        if (!enabled) return { ok: false, error: 'fixture start failure' };
        return status();
      },
      'stop-clash-mini': () => {
        running = false;
        popup.webContents.send('clash-mini-status', status());
        return status();
      },
      'get-clash-mini-proxy-options': () => ({ ok: true, groupName: 'Fixture', names, current: selected,
        proxies: initialEntries }),
      'test-min-latency': async (_event, options) => ({ ok: true, entries: options.names
        ? initialEntries.filter((item) => options.names.includes(item.name)) : await nextRetest }),
      'switch-clash-mini-proxy': (_event, payload) => { selected = payload.nodeName; return { ok: true, current: selected }; },
    };
    for (const [channel, handler] of Object.entries(handlers)) ipc.handle(channel, handler);
    ipc.on('toggle-network-magic-panel', (_event, payload) => {
      if (payload.open === true) controller.resize(payload);
      else controller.close();
    });
  }
  function pauseRetest() {
    let release;
    nextRetest = new Promise((resolve) => { release = resolve; });
    return {
      finish: release,
      probe: (entry) => activePopup.webContents.send('clash-mini-latency-progress', {
        groupName: 'Fixture', phase: 'probe', ...entry,
      }),
    };
  }
  return { bind, pauseRetest, savedMode: () => savedMode, pushQuota: () => {
    activePopup.webContents.send('proxy-traffic-quota', { used_bytes: 2 });
  }, pauseStart: () => {
    let release;
    nextStart = new Promise((resolve) => { release = resolve; });
    return release;
  } };
}

function readCompactLayout() {
  const root = document.getElementById('network-magic-sidebar-dialog');
  const visibleControls = [...root.querySelectorAll('button, input')].filter((item) => item.getClientRects().length);
  const toggle = visibleControls[0];
  if (visibleControls.length !== 1 || toggle.id !== 'VPN-switch' || !toggle.querySelector('svg')?.getClientRects().length) return false;
  const bounds = toggle.getBoundingClientRect();
  return root.innerText.trim() === '开启魔法代理' && root.scrollHeight === root.clientHeight
    && Math.abs(bounds.left + bounds.width / 2 - innerWidth / 2) < 2
    && Math.abs(bounds.top + bounds.height / 2 - innerHeight / 2) < 2;
}

async function checkQuotaDoesNotRenderPower(inspect, fixture, label, disabled) {
  await inspect(() => {
    delete document.documentElement.dataset.quotaReceived;
    const api = /** @type {{network: {onProxyTrafficQuota: (callback: () => void) => () => void}}} */ (Reflect.get(window, 'aiFree'));
    const unsubscribe = api.network.onProxyTrafficQuota(() => {
      document.documentElement.dataset.quotaReceived = 'true';
      unsubscribe();
    });
  });
  fixture.pushQuota();
  assert.equal(await poll(() => inspect(() => document.documentElement.dataset.quotaReceived), Boolean), 'true');
  assert.deepEqual(await inspect(() => {
    const button = document.getElementById('VPN-switch');
    return [button.textContent.trim(), button.matches(':disabled'), Boolean(button.querySelector('svg')?.getClientRects().length)];
  }), [label, disabled, true]);
}

function readLayout() {
  const root = document.querySelector('[role="dialog"][aria-label="内置代理"]');
  const toggle = root.querySelector('#VPN-switch');
  const switchIcon = toggle.querySelector('svg').parentElement;
  const glyph = switchIcon.getBoundingClientRect();
  const label = toggle.querySelector('[data-magic-power-label]').getBoundingClientRect();
  const button = root.querySelector('[data-network-magic-close]').getBoundingClientRect();
  const speed = root.querySelector('#vpn-node-retest-all-btn').getBoundingClientRect();
  const pane = root.querySelector('#vpn-node-selector-panel').getBoundingClientRect();
  return {
    largePower: toggle.getBoundingClientRect().height >= 42 && glyph.width >= 24 && glyph.width === glyph.height
      && glyph.right < label.left && getComputedStyle(switchIcon).borderRadius === '50%'
      && toggle.clientWidth >= toggle.scrollWidth,
    powerLabel: toggle.textContent.trim(),
    withoutTitleBar: !root.querySelector('header'),
    aligned: button.left > speed.right && Math.abs(button.top - speed.top) < 3,
    columns: [...root.querySelectorAll('.magic-node-group')].map((group) => {
      const cells = [...group.querySelectorAll('button')].map((node) => node.getBoundingClientRect());
      return [group.getAttribute('aria-label'), cells.length, cells.every((cell) => cell.height <= 29),
        cells.length < 2 || cells[0].top === cells[1].top && cells[0].right < cells[1].left];
    }),
    fits: pane.bottom <= root.getBoundingClientRect().bottom,
  };
}

async function checkModeSwitch(inspect, click, fixture, popup, activateLauncher) {
  const finishSwitch = fixture.pauseStart();
  assert.equal((await click(systemMode)).sent, true);
  try {
    assert.equal(await poll(() => inspect(() => {
      const root = document.getElementById('network-magic-sidebar-dialog');
      return root.dataset.operation?.includes('切换模式')
        && root.querySelector('#vpn-node-selector-panel').getClientRects().length > 0
        && [...root.querySelectorAll('button, input')].every((item) => item.matches(':disabled'))
        && root.querySelector('input[value="port"]:checked') !== null;
    }), Boolean), true);
    await activateLauncher(false);
    assert.equal(popup.isDestroyed(), false);
  } finally { finishSwitch(true); }
  assert.equal(await poll(() => fixture.savedMode(), (mode) => mode === 'system'), 'system');
  assert.equal(popup.isVisible(), false);
  assert.equal(await activateLauncher(true), popup);
  assert.equal(await poll(() => inspect(() => document.querySelector('input[value="system"]:checked:enabled') !== null), Boolean), true);
}

async function checkStart(inspect, click, fixture) {
  const finishStart = fixture.pauseStart();
  assert.equal((await click(power)).sent, true);
  try {
    assert.equal(await poll(() => inspect(() => {
      const root = document.getElementById('network-magic-sidebar-dialog');
      return root.dataset.operation?.includes('开启')
        && [...root.querySelectorAll('button, input')].every((item) => item.matches(':disabled'))
        && root.querySelectorAll('.magic-nodes, .magic-modes').length === 2
        && ![...root.querySelectorAll('.magic-nodes, .magic-modes')].some((item) => item.getClientRects().length);
    }), Boolean), true);
    await checkQuotaDoesNotRenderPower(inspect, fixture, '正在开启…', true);
  } finally { finishStart(true); }
  assert.equal(await poll(() => inspect(() => [...document.querySelectorAll('#vpn-node-selector-grid button:enabled')]
    .filter((button) => button.getClientRects().length).length), (count) => count === names.length), names.length);
}

function readDelays() {
  return [...document.querySelectorAll('#vpn-node-selector-grid .vpn-node-option-meta')].map((meta) => {
    const [r, g, b] = getComputedStyle(meta).color.match(/\d+/g).map(Number);
    const tone = g > r * 1.2 ? 'green' : r > g * 1.5 && r > b * 1.3 ? 'red'
      : r > b * 1.3 && g > b * 1.3 ? 'yellow' : 'neutral';
    return [meta.textContent, tone];
  });
}

async function checkLatency(inspect, click, fixture) {
  const expected = [['200ms', 'green'], ['201ms', 'yellow'], ['超时', 'red'], ['error', 'red'], ['待测速', 'neutral']];
  const matches = (target) => (actual) => JSON.stringify(actual) === JSON.stringify(target);
  assert.deepEqual(await poll(() => inspect(readDelays), matches(expected)), expected);

  const retest = fixture.pauseRetest();
  const results = [{ name: names[0], delay: 201 }, { name: names[1], error: '超时' },
    { name: names[2], delay: 200 }, { name: names[3], error: 'fixture error' }, { name: names[4], delay: 920 }];
  try {
    assert.equal((await click(speedButton)).sent, true);
    const pending = names.map(() => ['测速中...', 'neutral']);
    assert.deepEqual(await poll(() => inspect(readDelays), matches(pending)), pending);
    retest.probe(results[0]);
    retest.probe(results[1]);
    pending.splice(0, 2, ['201ms', 'yellow'], ['超时', 'red']);
    assert.deepEqual(await poll(() => inspect(readDelays), matches(pending)), pending);
  } finally { retest.finish(results); }
  const completed = [['201ms', 'yellow'], ['超时', 'red'], ['200ms', 'green'], ['error', 'red'], ['920ms', 'yellow']];
  assert.deepEqual(await poll(() => inspect(readDelays), matches(completed)), completed);
  assert.equal(await poll(() => inspect(() => document.querySelector('#vpn-node-retest-all-btn:enabled') !== null), Boolean), true);
}

async function checkFailedSwitch(inspect, click, fixture) {
  const fail = fixture.pauseStart();
  assert.equal((await click(globalMode)).sent, true);
  fail(false);
  assert.equal(await poll(() => inspect(() => {
    const button = document.getElementById('VPN-switch');
    return button.getAttribute('aria-pressed') === 'false' && button.matches(':enabled')
      && button.textContent.includes('开启魔法代理') && !document.querySelector('.magic-nodes').getClientRects().length;
  }), Boolean), true);
  assert.equal(fixture.savedMode(), 'system');
}

function bindLauncherFixture(parent, controller, fixture) {
  const { ipc } = parent.webContents;
  const channel = 'toggle-network-magic-panel';
  const onToggle = (_event, payload) => {
    const previous = controller.getWindow();
    controller.toggle(payload);
    const popup = controller.getWindow();
    if (popup && popup !== previous) fixture.bind(popup);
  };
  ipc.on(channel, onToggle);
  return () => ipc.removeListener(channel, onToggle);
}

function readLauncherOpen(selector) {
  return document.querySelector(selector)?.getAttribute('aria-expanded') === 'true';
}

async function focusLauncher(parent, inspect) {
  const bounds = parent.getContentBounds();
  const zoom = parent.webContents.getZoomFactor();
  const center = await inspect((selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, launcher);
  const getCursor = screen.getCursorScreenPoint;
  screen.getCursorScreenPoint = () => ({ x: bounds.x + center.x * zoom, y: bounds.y + center.y * zoom });
  try {
    parent.focus();
    assert.equal(await poll(() => parent.isFocused(), Boolean), true);
    // Observe the native focus change before delivering the renderer click.
    await new Promise(setImmediate);
  } finally { screen.getCursorScreenPoint = getCursor; }
}

async function checkNetworkMagicPopup(parent, layout) {
  const { createNetworkMagicPopupController } = require(path.join(layout.root, 'src/app/backend/features/network/network-magic-popup-controller.js'));
  const controller = createNetworkMagicPopupController({ ui: {
    getMainWindow: () => parent,
    sendToSide: (...args) => parent.webContents.send(...args),
  } });
  const fixture = createFixture(controller);
  const unbind = bindLauncherFixture(parent, controller, fixture);
  const inspectParent = rendererProbe(parent.webContents);
  const wasVisible = parent.isVisible();
  const activateLauncher = async (open) => {
    if (!open) {
      const popup = controller.getWindow();
      assert.equal(await poll(() => popup.isFocused(), Boolean), true);
      await focusLauncher(parent, inspectParent);
      assert.equal(popup.isFocused(), false);
      assert.equal(popup.isVisible(), true, 'focus transfer must not consume the launcher click');
    }
    assert.equal((await inspectParent(dispatchControl, launcher)).sent, true);
    const isSettled = async () => Boolean(controller.getWindow()?.isVisible()) === open
      && await inspectParent(readLauncherOpen, launcher) === open;
    assert.equal(await poll(isSettled, Boolean), true, `launcher expanded=${open}`);
    return controller.getWindow();
  };
  try {
    if (!wasVisible) parent.show();
    const popup = await activateLauncher(true);
    const inspect = rendererProbe(popup.webContents);
    const click = (selector) => inspect(dispatchControl, selector);
    assert.equal(await poll(() => inspect(() => document.querySelector('#VPN-switch:enabled') !== null), Boolean), true);
    assert.equal(popup.getBounds().width, 212);
    assert.equal(await inspect(readCompactLayout), true);
    await checkQuotaDoesNotRenderPower(inspect, fixture, '开启魔法代理', false);
    await checkStart(inspect, click, fixture);
    await checkQuotaDoesNotRenderPower(inspect, fixture, '关闭魔法代理', false);
    assert.deepEqual(await inspect(readLayout), { largePower: true, powerLabel: '关闭魔法代理', withoutTitleBar: true, aligned: true, fits: true,
      columns: [['香港', 2, true, true], ['日本', 2, true, true], ['其他节点', 1, true, true]] });
    await checkLatency(inspect, click, fixture);
    await checkModeSwitch(inspect, click, fixture, popup, activateLauncher);
    const node = '#vpn-node-selector-grid button[data-node-name="HK 02"]';
    assert.equal((await click(node)).sent, true);
    assert.equal(await poll(() => inspect((selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'true', node), Boolean), true);
    assert.equal((await click(power)).sent, true);
    assert.equal(await poll(() => inspect(readCompactLayout), Boolean), true);
    assert.equal(popup.getBounds().width, 212);
    await checkStart(inspect, click, fixture);
    assert.equal((await click(close)).sent, true);
    assert.equal(await poll(() => popup.isDestroyed(), Boolean), true);
    const reopened = await activateLauncher(true);
    const inspectReopened = rendererProbe(reopened.webContents);
    assert.notEqual(reopened, popup);
    assert.equal(await poll(() => inspectReopened(() => document.querySelector('input[value="system"]:checked:enabled') !== null), Boolean), true);
    await checkFailedSwitch(inspectReopened, (selector) => inspectReopened(dispatchControl, selector), fixture);
    assert.equal(await poll(() => inspectReopened(readCompactLayout), Boolean), true);
    await checkOutsideFocus(reopened);
    assert.equal(await poll(() => inspectParent(readLauncherOpen, launcher), (open) => !open), false);
  } finally {
    controller.close();
    unbind();
    if (!wasVisible) parent.hide();
  }
}

async function checkOutsideFocus(popup) {
  const outside = new BrowserWindow({ show: false, width: 240, height: 180 });
  try {
    assert.equal(await poll(() => !popup.isDestroyed() && popup.isFocused(), Boolean), true);
    outside.show();
    outside.focus();
    assert.equal(await poll(() => !popup.isVisible(), Boolean), true);
    assert.equal(popup.isDestroyed(), false);
  } finally { outside.destroy(); }
}

async function checkNetworkMagicLauncher(win) {
  const inspect = rendererProbe(win.webContents);
  const readButton = () => {
    const button = document.querySelector('#shell-network-magic-toggle');
    const wand = button.querySelector('.network-magic-wand-icon');
    return [button.getAttribute('title'), getComputedStyle(button).backgroundImage.startsWith('linear-gradient'),
      wand.getAnimations({ subtree: true }).length > 0];
  };
  const sendStatus = (status) => win.webContents.send('clash-mini-status', { ok: true, ...status });
  const idle = ['内置代理', false, false];
  try {
    assert.deepEqual(await inspect(readButton), idle);
    sendStatus({ running: true, enabled: false });
    assert.deepEqual(await inspect(readButton), idle);
    sendStatus({ running: true, enabled: true });
    assert.deepEqual(await poll(() => inspect(readButton), (state) => state[2]), ['内置代理已开启', true, true]);
  } finally { sendStatus({ running: false, enabled: false }); }
  assert.deepEqual(await poll(() => inspect(readButton), (state) => !state[2]), idle);
}

module.exports = { checkNetworkMagicPopup, checkNetworkMagicLauncher };
