'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBrowserPointerScheduler } = require('../../../src/app/backend/features/browser/browser-pointer-scheduler');

test('pointers keep separate state and serialize operations that share native focus', async () => {
  const scheduler = createBrowserPointerScheduler();
  const events = [];
  let finishFirst;
  const first = scheduler.run('session-a', 'mouse', 'native', async (pointer) => {
    assert.equal(pointer.position, null);
    pointer.position = { x: 4, y: 7 };
    events.push('a:start');
    await new Promise((resolve) => { finishFirst = resolve; });
    events.push('a:end');
  });
  const second = scheduler.run('session-b', 'mouse', 'native', (pointer) => {
    assert.equal(pointer.position, null);
    events.push('b');
  });
  await Promise.resolve();
  assert.deepEqual(events, ['a:start']);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['a:start', 'a:end', 'b']);
  await scheduler.run('session-a', 'other', 'native', (pointer) => assert.equal(pointer.position, null));
  await scheduler.run('session-a', 'mouse', 'native', (pointer) => assert.deepEqual(pointer.position, { x: 4, y: 7 }));
});

test('releasing a session aborts active work, discards queued work and clears pointer state', async () => {
  const scheduler = createBrowserPointerScheduler();
  const active = scheduler.run('session', 'mouse', 'native', (pointer, signal) => {
    pointer.position = { x: 1, y: 2 };
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  });
  const queued = scheduler.run('session', 'mouse', 'native', () => assert.fail('released action ran'));
  const rejected = assert.rejects(queued, { code: 'BROWSER_POINTER_RELEASED' });
  await Promise.resolve();
  await scheduler.release('session');
  await Promise.all([active, rejected]);
  await scheduler.run('session', 'mouse', 'native', (pointer) => assert.equal(pointer.position, null));
});

test('independent input resources can progress while the native focus is busy', async () => {
  const scheduler = createBrowserPointerScheduler();
  let finish;
  const pending = scheduler.run('session', 'mouse', 'native', () => new Promise((resolve) => { finish = resolve; }));
  try {
    await scheduler.run('session', 'other', 'isolated', () => {});
  } finally {
    finish();
    await pending;
  }
});
