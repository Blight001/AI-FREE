'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAutomationRunManager } = require('../../../src/app/main/services/automation-run-manager');

async function eventually(read, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待运行状态超时');
}

test('run manager deduplicates starts, persists progress and restores completed runs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (_request, context) => {
      context.onProgress({ stepId: 'one', transitionCount: 1, phase: 'succeeded' });
      return { success: true, value: 42 };
    },
  });
  manager.subscribe((event) => events.push(event));
  const first = manager.start({ id: 'card-1', version_id: 'v1', idempotency_key: 'once' });
  const duplicate = manager.start({ id: 'card-1', version_id: 'v1', idempotency_key: 'once' });
  assert.equal(duplicate.id, first.id);
  const completed = await eventually(() => manager.get(first.id).run, (run) => run.status === 'succeeded');
  assert.equal(completed.transitionCount, 1);
  assert.equal(manager.steps(first.id).items[0].stepId, 'one');
  assert.equal(events.some((event) => event.event === 'progress'), true);

  const restored = createAutomationRunManager({ dataDir: root, execute: async () => ({ success: true }) });
  assert.equal(restored.get(first.id).run.output.value, 42);
});

test('run manager cooperatively cancels and creates a distinct retry run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let attempt = 0;
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (_request, context) => {
      attempt += 1;
      if (attempt > 1) return { success: true };
      await new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { errorCode: 'RUN_CANCELLED' })), { once: true });
      });
      return { success: true };
    },
  });
  const first = manager.start({ id: 'card-1', idempotency_key: 'cancel-me' });
  await eventually(() => manager.get(first.id).run, (run) => run.status === 'running');
  assert.equal(manager.cancel(first.id, 'user requested').run.status, 'cancelled');
  const retried = manager.retry(first.id).run;
  assert.notEqual(retried.id, first.id);
  const completed = await eventually(() => manager.get(retried.id).run, (run) => run.status === 'succeeded');
  assert.equal(completed.sourceRunId, first.id);
  assert.equal(completed.attempt, 2);
});

test('run manager enforces the persisted overall timeout', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (_request, context) => new Promise((resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const run = manager.start({ id: 'card-timeout', timeoutMs: 10 });
  const timedOut = await eventually(() => manager.get(run.id).run, (item) => item.status === 'timed_out');
  assert.equal(timedOut.error.code, 'RUN_TIMED_OUT');
});
