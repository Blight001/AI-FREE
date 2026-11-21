'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { ChromiumRuntime } = require('../../../src/app/backend/browser-runtime/chromium-runtime');
const { createChromiumLaunchDiagnostics } = require('../../../src/app/backend/browser-runtime/chromium-process-diagnostics');
const { RUNTIME_STATUS } = require('../../../src/app/backend/browser-runtime/runtime-types');

function createRuntime(status = RUNTIME_STATUS.WAITING_PIPE) {
  const state = { profileId: 'slow-profile', status };
  const store = {
    getState: () => state,
    patchState: (_id, patch) => Object.assign(state, patch),
    transition: (_id, next) => { state.status = next; },
  };
  const runtime = new ChromiumRuntime({ store, stateStore: store, logger: { warn() {} } });
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = 1234;
  const commandClient = new EventEmitter();
  commandClient.lastHello = null;
  const instance = { child, commandClient, profile: { launchTimeoutMs: 3000 } };
  runtime.instances.set('slow-profile', instance);
  return { instance, runtime, state };
}

test('crash notifications contain a synchronous state snapshot', () => {
  const { runtime, state } = createRuntime(RUNTIME_STATUS.READY);
  runtime.windowBridge = { hideHostWindow() {} };
  let notification;
  runtime.once('crashed', (value) => { notification = value; });
  runtime.markCrashed('slow-profile', { code: 'CHROMIUM_WINDOW_LOST' });
  assert.equal(notification.profileId, 'slow-profile');
  assert.equal(notification.status, RUNTIME_STATUS.CRASHED);
  assert.equal(notification.lastError.code, 'CHROMIUM_WINDOW_LOST');
  assert.notEqual(notification, state);
  notification.status = 'changed-by-listener';
  assert.equal(runtime.getState('slow-profile').status, RUNTIME_STATUS.CRASHED);
});

test('state queries are immediate and do not change the stored state', () => {
  const { runtime, state } = createRuntime(RUNTIME_STATUS.HIDDEN);
  const snapshot = runtime.getState('slow-profile');
  assert.equal(snapshot.status, RUNTIME_STATUS.HIDDEN);
  assert.notEqual(snapshot, state);
  snapshot.status = RUNTIME_STATUS.STOPPED;
  assert.equal(state.status, RUNTIME_STATUS.HIDDEN);
});

test('已运行的 Chromium 异常退出记录脱敏诊断且只重启一次', async () => {
  const { instance, runtime } = createRuntime(RUNTIME_STATUS.HIDDEN);
  const errors = [];
  runtime.logger = { error: (_message, details) => errors.push(details) };
  runtime.windowBridge = { hideHostWindow() {} };
  instance.diagnostics = createChromiumLaunchDiagnostics({ logFilePath: 'runtime.log' });
  instance.diagnostics.record('stderr', 'runtime failure token=synthetic-secret');
  const restarts = [];
  runtime.restartNow = async (_id, options) => { restarts.push(options); };
  runtime.bindInstance('slow-profile', instance);
  instance.child.exitCode = 3;
  instance.child.emit('exit', 3, null);
  runtime.markCrashed('slow-profile', { code: 'CHROMIUM_WINDOW_LOST' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].recovery.visible, false);
  assert.equal(errors[0].code, 'CHROMIUM_PROCESS_EXITED');
  assert.equal(errors[0].exitCode, 3);
  assert.equal(errors[0].pid, 1234);
  assert.match(errors[0].stack, /Chromium 运行中意外退出/);
  assert.match(errors[0].diagnostic, /runtime failure/);
  assert.equal(errors[0].logFilePath, 'runtime.log');
  assert.doesNotMatch(JSON.stringify(errors), /synthetic-secret/);
});

test('健康故障结束未完成的命令，但刚恢复的 Profile 不会循环重启', async () => {
  const { runtime, instance } = createRuntime(RUNTIME_STATUS.READY);
  runtime.windowBridge = { hideHostWindow() {} };
  runtime.restartNow = async () => assert.fail('repeated crash must not restart');
  instance.autoRecoveredAt = Date.now();
  const failures = [];
  instance.commandClient.rejectPending = (error) => failures.push(error);
  runtime.markCrashed('slow-profile', { code: 'CHROMIUM_HEARTBEAT_TIMEOUT', message: '心跳超时' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures[0].code, 'CHROMIUM_HEARTBEAT_TIMEOUT');
  assert.equal(runtime.getState('slow-profile').status, RUNTIME_STATUS.CRASHED);
  assert.equal(runtime.crashRecoveryAttempts.size, 0);
});

test('手动停止取消排队中的自动重启', async () => {
  const { runtime, instance } = createRuntime(RUNTIME_STATUS.READY);
  runtime.store = { releaseLock() {} };
  runtime.windowBridge = { hideHostWindow() {} };
  let restarts = 0;
  runtime.restartNow = async () => { restarts += 1; };
  let releaseOperation;
  const pending = runtime.enqueueProfileOperation('slow-profile', () => new Promise((resolve) => {
    releaseOperation = resolve;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.bindInstance('slow-profile', instance);
  instance.child.exitCode = 1;
  instance.child.emit('exit', 1, null);
  await runtime.stop('slow-profile', { preserveSession: false });
  releaseOperation();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarts, 0);
  assert.equal(runtime.getState('slow-profile').status, RUNTIME_STATUS.STOPPED);
  assert.equal(runtime.crashRecoveryAttempts.size, 0);
});

test('正常关闭 Chromium 不发布崩溃事件', async () => {
  const { runtime, instance } = createRuntime(RUNTIME_STATUS.READY);
  runtime.store = { releaseLock() {} };
  instance.commandClient.send = async (command) => {
    assert.equal(command, 'close-browser');
    instance.child.exitCode = 0;
    instance.child.emit('exit', 0, null);
  };
  runtime.bindInstance('slow-profile', instance);
  const crashes = [];
  runtime.on('crashed', (state) => crashes.push(state));
  await runtime.stop('slow-profile', { preserveSession: false });
  assert.deepEqual(crashes, []);
  assert.equal(runtime.getState('slow-profile').status, RUNTIME_STATUS.STOPPED);
});

test('停止中的 Profile 会立即取消尚在等待的 Chromium 握手', async () => {
  const { instance, runtime, state } = createRuntime();
  state.status = RUNTIME_STATUS.STOPPING;

  await assert.rejects(
    runtime.waitForBrowserWindow('slow-profile', instance),
    (error) => error.code === 'CHROMIUM_LAUNCH_CANCELLED',
  );
});

test('迟到的握手不能把 stopping Profile 重新切换到 attaching', async () => {
  const { instance, runtime, state } = createRuntime(RUNTIME_STATUS.STOPPING);

  await assert.rejects(
    runtime.attachProfileWindow('slow-profile', instance, '4321', {}),
    (error) => error.code === 'CHROMIUM_LAUNCH_CANCELLED',
  );
  assert.equal(state.status, RUNTIME_STATUS.STOPPING);
});

test('仍有存活 Chromium 进程时拒绝覆盖同一 Profile 实例', () => {
  const { runtime } = createRuntime();

  assert.throws(
    () => runtime.prepareProfileLaunch('slow-profile', { profileId: 'slow-profile' }, {}),
    (error) => error.code === 'CHROMIUM_PROFILE_ALREADY_RUNNING',
  );
});

test('Chromium 握手前退出时保留真实退出码和内核诊断', async () => {
  const { instance, runtime } = createRuntime();
  const diagnostics = createChromiumLaunchDiagnostics();
  diagnostics.record('stderr', 'missing dependency');
  instance.diagnostics = diagnostics;
  runtime.bindInstance('slow-profile', instance);

  instance.child.exitCode = -1073741515;
  instance.child.emit('exit', -1073741515, null);

  await assert.rejects(
    runtime.waitForBrowserWindow('slow-profile', instance),
    (error) => error.code === 'CHROMIUM_PROCESS_EXITED'
      && error.message.includes('0xC0000135')
      && error.message.includes('VC++ 运行库')
      && error.message.includes('missing dependency'),
  );
});

test('Chromium hello 事件到达后不再等待 100ms 轮询周期', async () => {
  const { instance, runtime } = createRuntime();
  const waiting = runtime.waitForBrowserWindow('slow-profile', instance);
  instance.commandClient.emit('hello', { browserHwnd: '4321' });

  const result = await Promise.race([
    waiting,
    new Promise((resolve) => setTimeout(() => resolve('poll-timeout'), 50)),
  ]);
  assert.equal(result, '4321');
});
