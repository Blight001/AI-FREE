'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMcpDevRestartController } = require('../../../src/app/backend/features/browser/mcp-dev-restart-controller');

function fixture() {
  let hash = 'build-a';
  let watcher;
  let busy = true;
  let relaunches = 0;
  let quits = 0;
  let timerCallback;
  const filePath = require('node:path/win32').join('D:/workspace/.generated/app', 'build-manifest.json');
  const fs = {
    readFileSync(target) {
      assert.equal(target, filePath);
      return JSON.stringify({ sourceHash: hash });
    },
    watchFile(target, options, callback) { assert.equal(target, filePath); watcher = callback; },
    unwatchFile(target, callback) { assert.equal(target, filePath); assert.equal(callback, watcher); },
  };
  const timers = {
    setInterval(callback) { timerCallback = callback; return { unref() {} }; },
    clearInterval() { timerCallback = null; },
    setTimeout(callback) { timerCallback = callback; return { unref() {} }; },
  };
  const app = { getAppPath: () => 'D:/workspace/.generated/app', relaunch: () => { relaunches += 1; },
    quit: () => { quits += 1; } };
  const controller = createMcpDevRestartController({ app, fs, path: require('node:path/win32'), isDevMode: true,
    isBusy: () => busy, timers, logger: { info() {}, warn() {} } });
  return { app, controller, setBusy: (value) => { busy = value; }, setHash: (value) => { hash = value; watcher(); },
    getTimer: () => timerCallback, getRelaunches: () => relaunches, getQuits: () => quits };
}

test('manual dev restart requires a fresh build and an idle app', async () => {
  const f = fixture();
  assert.equal(f.controller.getStatus().pending, false);
  await assert.rejects(f.controller.restart(), /没有检测到新的源码构建/);
  f.setHash('build-b');
  assert.equal(f.controller.getStatus().pending, true);
  await assert.rejects(f.controller.restart(), /当前仍有对话/);
  assert.equal(f.getRelaunches(), 0);
  f.setBusy(false);
  assert.deepEqual(await f.controller.restart(), { scheduled: true });
  assert.equal(f.getRelaunches(), 1);
  assert.equal(f.getQuits(), 1);
  f.controller.dispose();
});

test('opt-in auto restart waits for busy operations to finish', async () => {
  const f = fixture();
  f.setHash('build-b');
  f.controller.setAutoRestart(true);
  f.getTimer()();
  assert.equal(f.getRelaunches(), 0);
  f.setBusy(false);
  f.getTimer()();
  await Promise.resolve();
  assert.equal(f.getRelaunches(), 1);
  assert.equal(f.controller.getStatus().autoRestart, true);
  f.controller.dispose();
});

test('restart is disabled outside dev mode and disposes the manifest watcher', () => {
  let watches = 0;
  let unwatches = 0;
  const fs = { readFileSync() { throw new Error('not available'); }, watchFile() { watches += 1; }, unwatchFile() { unwatches += 1; } };
  const controller = createMcpDevRestartController({ app: { getAppPath: () => 'D:/app' }, fs,
    path: require('node:path/win32'), isDevMode: false });
  assert.equal(controller.getStatus().available, false);
  controller.dispose();
  assert.deepEqual([watches, unwatches], [0, 0]);
});

test('a missing or incomplete manifest never authorizes restart using a stale pending hash', async () => {
  const f = fixture();
  f.setBusy(false);
  f.setHash('build-b');
  f.setHash('');
  assert.equal(f.controller.getStatus().pending, false);
  await assert.rejects(f.controller.restart());
  f.setHash('build-c');
  f.controller.dispose();
  await assert.rejects(f.controller.restart());
  assert.equal(f.getRelaunches(), 0);
});
