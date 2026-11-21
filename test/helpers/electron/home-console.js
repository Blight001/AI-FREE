const assert = require('node:assert/strict');
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');
const { createIpcRegistry } = require('../../../src/app/backend/ipc/registry');
const { poll, rendererProbe } = require('../flows/electron-controls');

function readLogColors(theme) {
  const root = document.documentElement;
  const originalClass = root.className;
  root.classList.toggle('theme-light', theme === 'light');
  root.classList.toggle('theme-gold', theme === 'gold');
  const surfaceColor = getComputedStyle(document.getElementById('home-console-entries')).backgroundColor;
  const rows = [...document.querySelectorAll('#home-console-entries li')];
  const colors = rows.map((row) => {
    const meta = row.firstElementChild;
    const message = getComputedStyle(row.lastElementChild);
    return {
      level: getComputedStyle(meta.children[1]).color,
      source: meta.children[2] ? getComputedStyle(meta.children[2]).color : '',
      message: message.color,
      tint: message.backgroundColor,
    };
  });
  root.className = originalClass;
  return {
    distinctLevels: new Set(colors.map(({ level }) => level)).size === 3,
    distinctMessages: new Set(colors.map(({ message }) => message)).size === 3,
    distinctTints: new Set(colors.map(({ tint }) => tint)).size === 3
      && colors.every(({ tint }) => tint !== 'rgba(0, 0, 0, 0)' && tint !== surfaceColor),
    consistentSources: Boolean(colors[0]?.source) && colors[0].source === colors[1]?.source
      && Boolean(colors[2]?.source) && colors[0].source !== colors[2].source,
  };
}

function readLogViewport() {
  const list = document.getElementById('home-console-entries');
  return { top: list.scrollTop, atLatest: list.scrollHeight - list.clientHeight - list.scrollTop < 2 };
}

async function checkLogActions(inspect, append) {
  const hasText = (text) => inspect((value) => document.getElementById('home-console-entries').textContent.includes(value), text);
  const toggleFollow = () => inspect(() => document.getElementById('home-console-follow').click());
  assert.equal(await inspect(() => document.querySelector('#home-console-follow:checked') !== null), true);
  append('old log', 80);
  assert.equal(await poll(() => hasText('old log 79'), Boolean), true);
  const initial = await inspect(readLogViewport);
  assert.ok(initial.top > 0 && initial.atLatest);
  await toggleFollow();
  await inspect(() => { document.getElementById('home-console-entries').scrollTop = 42; });
  append('new log', 1);
  assert.equal(await poll(() => hasText('new log 0'), Boolean), true);
  assert.deepEqual(await inspect(readLogViewport), { top: 42, atLatest: false });
  await toggleFollow();
  assert.equal((await inspect(readLogViewport)).atLatest, true);

  await inspect(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { document.documentElement.dataset.copiedFixture = text; },
    } });
    document.getElementById('home-console-copy').click();
  });
  const copied = await inspect(() => document.documentElement.dataset.copiedFixture);
  assert.match(copied, /\[警告\] \[IPC\] <b>diagnostic fixture<\/b>/);
  assert.match(copied, /\[普通\] \[IPC\] new log 0/);
  assert.doesNotMatch(copied, /\[HTTP\]/);

  await inspect(() => document.getElementById('home-console-clear').click());
  assert.equal(await poll(() => inspect(() => document.getElementById('home-console-entries').childElementCount === 0), Boolean), true);
  assert.equal(await inspect(() => document.querySelector('#home-console-copy:disabled') !== null), true);
  append('after clear', 1);
  assert.equal(await poll(() => hasText('after clear 0'), Boolean), true);
  assert.equal(await inspect(() => document.getElementById('home-console-entries').childElementCount), 1);
}

async function checkHomeConsole(win, layout) {
  const { registerHomeConsoleIpc } = require(path.join(layout.root,
    'src/app/backend/features/window/register-home-console-ipc.js'));
  const inspect = rendererProbe(win.webContents);
  const selectLast = () => {
    document.querySelector('.shell-home-tabs [aria-selected="true"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    return document.activeElement.id;
  };
  const windows = BrowserWindow.getAllWindows().length;
  await win.loadFile(layout.pages.shell, { query: { dev: '0' } });
  const lastVisible = await inspect(() => [...document.querySelectorAll('.shell-home-tabs [role="tab"]')]
    .filter((tab) => tab.getBoundingClientRect().width > 0).at(-1)?.id);
  assert.notEqual(lastVisible, 'home-console-tab');
  assert.equal(await inspect(selectLast), lastVisible);
  let reads = 0;
  const timestamp = '2026-01-01T00:00:00Z';
  let history = [];
  let revision = 0;
  const append = (text, count) => {
    for (let index = 0; index < count; index += 1) {
      history.push({ source: 'IPC', level: 'info', text: `${text} ${index}`, timestamp });
    }
    revision += count;
  };
  const ipc = createIpcRegistry(ipcMain);
  registerHomeConsoleIpc(ipc, {
    isDevMode: true,
    getMainWindow: () => win,
    getConsoleSnapshot: (knownRevision) => {
      reads += 1;
      return { revision, ...(revision !== knownRevision && { history }) };
    },
    clearConsoleHistory: () => {
      history = [];
      return { revision: ++revision, history };
    },
  });
  try {
    await win.loadFile(layout.pages.shell, { query: { dev: '1' } });
    assert.equal(reads, 0);
    assert.equal(await inspect(selectLast), 'home-personal-tab');
    assert.equal(await inspect(() => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      return document.activeElement.id;
    }), 'home-console-tab');
    assert.equal(await inspect(() => {
      const panel = document.getElementById('home-console');
      const bounds = panel.getBoundingClientRect();
      const homeBounds = document.getElementById('browser-empty-state').getBoundingClientRect();
      const railBounds = document.querySelector('.shell-home-rail').getBoundingClientRect();
      return bounds.width > 0 && bounds.left >= railBounds.right && bounds.right <= homeBounds.right
        && document.getElementById('home-browsers').hidden;
    }), true);
    history = [
      { source: 'IPC', level: 'info', text: 'Info fixture' },
      { source: 'IPC', level: 'warn', text: '<b>diagnostic fixture</b>' },
      { source: 'HTTP', level: 'error', text: 'Error fixture' },
    ].map((entry) => ({ ...entry, timestamp }));
    revision += history.length;
    assert.equal(await poll(() => inspect(() => document.getElementById('home-console-entries').textContent
      .includes('<b>diagnostic fixture</b>')), Boolean), true, 'Missing live log');
    for (const theme of ['light', 'dark', 'gold']) {
      assert.deepEqual(await inspect(readLogColors, theme), {
        distinctLevels: true, distinctMessages: true, distinctTints: true, consistentSources: true,
      }, theme);
    }
    assert.equal(await inspect(() => {
      const source = document.getElementById('home-console-source');
      if (!(source instanceof HTMLSelectElement)) return false;
      source.value = 'IPC';
      source.dispatchEvent(new Event('change'));
      return document.getElementById('home-console-entries').childElementCount === 2
        && !document.querySelector('#home-console-entries b');
    }), true);
    await checkLogActions(inspect, append);
    const homeHidden = () => inspect(() => document.getElementById('browser-empty-state').hidden);
    win.webContents.send('update-tabs', [{ id: 'fixture-browser', isActive: true, runtimeStatus: 'ready' }]);
    assert.equal(await poll(homeHidden, Boolean), true);
    const paused = reads;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(reads, paused);
    win.webContents.send('update-tabs', []);
    assert.ok(await poll(() => reads, (count) => count > paused) > paused);
    await inspect(() => document.getElementById('home-personal-tab').click());
    assert.equal(await inspect(() => document.getElementById('home-console').hidden), true);
    assert.equal(BrowserWindow.getAllWindows().length, windows);
  } finally {
    ipc.dispose();
  }
}

module.exports = { checkHomeConsole };
