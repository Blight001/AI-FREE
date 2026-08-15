'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CARD_CACHE_FILE_NAME,
  createBrowserAutomationBridge,
  createCardCacheStore,
} = require('../../src/app/main/services/browser-automation-bridge');
test('automation cards persist in the software data directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-card-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const firstBrowser = createCardCacheStore({ dataDir: root });
  assert.equal(firstBrowser.read().exists, false);

  const saved = firstBrowser.write({
    items: [{
      id: 'shared-card',
      cardName: '共享卡片',
      cardData: { name: '共享卡片', steps: [{ type: 'navigate', url: 'https://example.com' }] },
      savedAt: '2026-07-16T00:00:00.000Z',
    }],
    selectedId: 'shared-card',
  });
  assert.equal(saved.selectedId, 'shared-card');
  assert.equal(fs.existsSync(path.join(root, CARD_CACHE_FILE_NAME)), true);

  // A new software process reads the same durable card file.
  const newlyInjectedBrowser = createCardCacheStore({ dataDir: root });
  const reloaded = newlyInjectedBrowser.read();
  assert.equal(reloaded.exists, true);
  assert.equal(reloaded.state.items.length, 1);
  assert.equal(reloaded.state.items[0].cardData.name, '共享卡片');
});

test('an explicitly emptied shared card library stays present', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-card-cache-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = createCardCacheStore({ dataDir: root });
  store.write({ items: [], selectedId: 'stale-card' });

  const reloaded = store.read();
  assert.equal(reloaded.exists, true);
  assert.deepEqual(reloaded.state, { items: [], selectedId: '' });
});

test('AI control can select a shared automation card', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-card-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  createCardCacheStore({ dataDir: root }).write({
    items: [
      { id: 'first', cardName: '卡片一', cardData: { name: '卡片一', steps: [] } },
      { id: 'second', cardName: '卡片二', cardData: { name: '卡片二', steps: [] } },
    ],
    selectedId: 'first',
  });
  const bridge = createBrowserAutomationBridge({ cardCacheDir: root, logger: { log() {} } });
  const selected = bridge.selectCard('second');

  assert.equal(selected.item.cardName, '卡片二');
  assert.equal(bridge.getCardCacheState().state.selectedId, 'second');
  assert.throws(() => bridge.selectCard('missing'), /不存在或已被删除/);
});

test('running an automation card holds and releases a background execution lease', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-card-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createCardCacheStore({ dataDir: root }).write({
    items: [{
      id: 'run',
      cardName: '运行',
      cardData: { name: '运行', steps: [{ type: 'navigate', url: 'https://example.test' }] },
    }],
    selectedId: 'run',
  });
  const events = [];
  const bridge = createBrowserAutomationBridge({
    cardCacheDir: root,
    logger: { log() {} },
    backgroundExecutionLeases: {
      acquire() {
        events.push('acquire');
        return { release: () => events.push('release') };
      },
    },
  });

  await bridge.manageCard('', { action: 'run', card_id: 'run' });

  assert.deepEqual(events, ['acquire', 'release']);
});

async function waitForRun(bridge, runId, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = bridge.manageCard('', { action: 'get_run', run_id: runId });
    if (result.run.status === expected) return result.run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待运行进入 ${expected} 超时`);
}

test('bridge routes persistent asynchronous runs with idempotency, progress, cancellation and retry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-card-async-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = createBrowserAutomationBridge({ cardCacheDir: root, logger: { log() {} } });
  const written = await bridge.manageCard('', {
    action: 'write',
    cardData: { name: '异步运行', steps: [{ id: 'pause', type: 'delay', delayMs: 40 }, { id: 'done', type: 'end' }] },
  });
  const progress = [];
  const unsubscribe = bridge.onRunProgress((event) => progress.push(event));
  t.after(unsubscribe);

  const first = await bridge.manageCard('', {
    action: 'start_run', id: written.item.id, idempotency_key: 'one-click', inputs: {},
  });
  const duplicate = await bridge.manageCard('', {
    action: 'start_run', id: written.item.id, idempotency_key: 'one-click', inputs: {},
  });
  assert.equal(duplicate.run.id, first.run.id);
  await waitForRun(bridge, first.run.id, 'running');
  assert.equal(bridge.manageCard('', { action: 'cancel_run', run_id: first.run.id }).run.status, 'cancelled');
  const retried = bridge.manageCard('', { action: 'retry_run', run_id: first.run.id }).run;
  const completed = await waitForRun(bridge, retried.id, 'succeeded');
  assert.equal(completed.sourceRunId, first.run.id);
  assert.equal(bridge.manageCard('', { action: 'list_run_steps', run_id: retried.id }).items.length >= 2, true);
  assert.equal(bridge.manageCard('', { action: 'list_runs', card_id: written.item.id }).items.length, 2);
  assert.equal(fs.existsSync(bridge.runsFilePath), true);
  assert.equal(progress.some((event) => event.event === 'progress'), true);
});
