'use strict';

const assert = require('node:assert/strict');
const { ipcMain } = require('electron');
const { dispatchControl, poll, rendererProbe } = require('../flows/electron-controls');

function probeDialog(selector) {
  const dialog = document.querySelector(selector);
  const home = document.getElementById('browser-empty-state');
  const theme = document.getElementById('theme-toggle-btn');
  const panel = dialog.getBoundingClientRect();
  const area = home.getBoundingClientRect();
  const button = theme.getBoundingClientRect();
  return {
    visible: panel.width > 0,
    contained: panel.left >= area.left - 1 && panel.right <= area.right + 1
      && panel.top >= area.top - 1 && panel.bottom <= area.bottom + 1,
    taskbarHit: theme.contains(document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2)),
    taskbarPoint: { x: Math.round(button.x + button.width / 2), y: Math.round(button.y + button.height / 2) },
    homeBlocked: !!document.getElementById('home-personal-tab').closest('[inert]'),
    focused: document.activeElement?.id,
    light: document.documentElement.classList.contains('theme-light'),
  };
}

async function clickHomeBackdrop(contents) {
  const point = await rendererProbe(contents)(() => {
    const layer = document.getElementById('home-dialog-layer');
    const { left, top } = layer.getBoundingClientRect();
    const x = Math.ceil(left) + 4;
    const y = Math.ceil(top) + 4;
    return document.elementFromPoint(x, y) === layer ? { x, y } : null;
  });
  assert.ok(point, 'Expected a blank spot on the home backdrop');
  for (const type of ['mouseDown', 'mouseUp']) {
    contents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  }
}

async function checkBackdropPreservesBrowserDraft(contents, click, read) {
  await click('.browser-history-edit');
  const execute = rendererProbe(contents);
  const draft = '未保存的浏览器名称';
  await execute((value) => {
    const input = /** @type {HTMLInputElement} */ (document.getElementById('browser-record-name'));
    input.value = value;
  }, draft);
  await clickHomeBackdrop(contents);
  const editor = '#browser-settings-dialog';
  assert.equal((await read(editor)).visible, true, 'Backdrop clicks must leave the browser editor open');
  assert.equal(await execute(() => /** @type {HTMLInputElement} */ (document.getElementById('browser-record-name')).value), draft);
  await click('#browser-settings-dialog-close');
  assert.equal((await read(editor)).visible, false);
}

function pressEscape(contents) {
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
}

async function clickTaskbarControl(contents, selector) {
  const point = await rendererProbe(contents)((target) => {
    const control = document.querySelector(target);
    const { x, y, width, height } = control.getBoundingClientRect();
    const center = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
    return control.contains(document.elementFromPoint(center.x, center.y)) ? center : null;
  }, selector);
  assert.ok(point, `Taskbar control is clickable: ${selector}`);
  for (const type of ['mouseDown', 'mouseUp']) {
    contents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  }
}

async function visitBrowserAndReturn(contents, checkWhileAway) {
  const fixture = { id: 'fixture-active-tab', title: 'Fixture browser', runtimeStatus: 'ready' };
  const updateTabs = (activeId) => contents.send('update-tabs', [{ ...fixture, isActive: activeId === fixture.id }]);
  const onSwitchTab = (event, id) => {
    if (event.sender === contents) updateTabs(id);
  };
  const readHome = () => rendererProbe(contents)(() => !document.getElementById('browser-empty-state').hidden);
  ipcMain.on('switch-tab', onSwitchTab);
  try {
    updateTabs(null);
    await clickTaskbarControl(contents, '#tabs-container .tab');
    assert.equal(await poll(readHome, (visible) => !visible), false, 'Browser tab hides the homepage');
    await checkWhileAway?.();
    await clickTaskbarControl(contents, '#home-tab-btn');
    assert.equal(await poll(readHome, Boolean), true, 'The taskbar Home button reveals the homepage');
  } finally {
    ipcMain.off('switch-tab', onSwitchTab);
    contents.send('update-tabs', []);
  }
}

async function checkConfirmationAndReturnHome(contents, click, read) {
  const editor = '#browser-settings-dialog';
  const confirmation = '#home-confirm-dialog';
  const execute = rendererProbe(contents);
  const draft = 'Unsaved browser name';
  await click('.browser-history-edit');
  await execute((name) => {
    (/** @type {HTMLInputElement} */ (document.getElementById('browser-record-name'))).value = name;
  }, draft);
  await click('#delete-browser-record');
  const confirm = await read(confirmation);
  assert.ok(confirm.visible && confirm.contained && confirm.taskbarHit);
  assert.equal((await read(editor)).visible, false);
  pressEscape(contents);
  assert.equal((await poll(() => read(editor), (state) => state.visible)).focused, 'delete-browser-record');

  await click('#delete-browser-record');
  await visitBrowserAndReturn(contents, async () => {
    assert.equal((await read(confirmation)).visible, false);
    pressEscape(contents);
  });
  assert.equal((await read(confirmation)).visible, true, 'Returning Home restores the open confirmation');
  pressEscape(contents);
  assert.ok((await poll(() => read(editor), (state) => state.visible)).visible);
  assert.equal(await execute(() => (/** @type {HTMLInputElement} */ (document.getElementById('browser-record-name'))).value), draft);
  await click('#browser-settings-dialog-close');
  assert.equal((await read(editor)).visible, false);
}

async function checkHomeDialogScope(contents) {
  const execute = rendererProbe(contents);
  const click = (selector) => execute(dispatchControl, selector);
  const read = (selector) => execute(probeDialog, selector);
  for (const [tab, trigger, dialog] of [
    ['accounts', '#provider-microsoft-panel .provider-add-account', '#provider-account-dialog'],
    ['automation', '#automation-create', '#automation-editor'],
    ['browsers', '.browser-history-edit', '#browser-settings-dialog'],
    ['browsers', '#open-default-browser-settings', '#browser-settings-dialog'],
    ['browsers', '.browser-history-sites', '#site-data-dialog'],
  ]) {
    await click(`#home-${tab}-tab`);
    assert.ok((await poll(() => click(trigger), (result) => result.sent)).sent, trigger);
    const state = await poll(() => read(dialog), (result) => result.visible);
    assert.equal(state.visible, true, `${dialog} opened`);
    assert.equal(state.contained, true, `${dialog} fits inside the homepage`);
    assert.equal(state.homeBlocked, true, `${dialog} blocks only homepage interactions`);
    assert.equal(state.taskbarHit, true, `${dialog} leaves the taskbar clickable`);
    for (const type of ['mouseDown', 'mouseUp']) {
      contents.sendInputEvent({ type, ...state.taskbarPoint, button: 'left', clickCount: 1 });
    }
    const toggled = await poll(() => read(dialog), (result) => result.visible && result.light !== state.light);
    assert.ok(toggled.visible && toggled.light !== state.light, `Theme toggles with ${dialog} open`);
    await click('#theme-toggle-btn');
    pressEscape(contents);
    const closed = await poll(() => read(dialog), (result) => !result.visible && !result.homeBlocked);
    assert.ok(!closed.visible && !closed.homeBlocked, `Escape closes ${dialog}`);
  }
  await checkBackdropPreservesBrowserDraft(contents, click, read);
  await checkConfirmationAndReturnHome(contents, click, read);
}

module.exports = { checkHomeDialogScope, clickHomeBackdrop, visitBrowserAndReturn };
