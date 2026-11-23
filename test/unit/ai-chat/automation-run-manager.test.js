'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAutomationRunManager } = require('../../../src/app/backend/services/automation-run-manager');
const { collectSensitiveInputPaths } = require('../../../src/app/backend/services/automation-run-sanitizer');

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

test('run manager cooperatively cancels and refuses to replay an uncertain run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (_request, context) => {
      await new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { errorCode: 'RUN_CANCELLED' })), { once: true });
      });
      return { success: true };
    },
  });
  const first = manager.start({ id: 'card-1', idempotency_key: 'cancel-me' });
  await eventually(() => manager.get(first.id).run, (run) => run.status === 'running');
  assert.equal(manager.cancel(first.id, 'user requested').run.status, 'cancelling');
  await eventually(() => manager.get(first.id).run, (run) => run.status === 'cancelled');
  assert.throws(() => manager.retry(first.id), { code: 'RUN_NOT_RETRYABLE' });
});

test('cancellation stays pending while an uninterruptible operation is in flight', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-noncooperative-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let releaseOperation;
  let markOperationStarted;
  const operationStarted = new Promise((resolve) => { markOperationStarted = resolve; });
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async () => {
      markOperationStarted();
      await new Promise((resolve) => { releaseOperation = resolve; });
      return { success: true, dispatched: true };
    },
  });
  const run = manager.start({ id: 'card-noncooperative' });
  await operationStarted;
  assert.equal(manager.cancel(run.id).run.status, 'cancelling');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.get(run.id).run.status, 'cancelling');
  releaseOperation();
  const completed = await eventually(() => manager.get(run.id).run, (item) => item.status === 'cancelled');
  assert.equal(completed.output, null);
});

test('run records and results redact credentials and do not persist replay inputs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-redaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const password = 'secret-password-7462';
  const writeOnlyValue = 'internal-pin-3928';
  const arrayPin = 'nested-private-pin-8841';
  const sensitiveInputPaths = collectSensitiveInputPaths({ type: 'object', properties: {
    accessPhrase: { type: 'string', writeOnly: true },
    rows: { type: 'array', items: { type: 'object', properties: { pin: { type: 'string', writeOnly: true } } } },
  } });
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (_request, context) => {
      context.onProgress({ stepId: 'one', result: `echo ${password} ${writeOnlyValue} ${arrayPin}` });
      return { success: true, context: { password, accessPhrase: writeOnlyValue, rows: [{ pin: arrayPin }] } };
    },
  });
  const started = manager.start({
    id: 'card-private-inputs', idempotency_key: 'private-run',
    inputs: { password, accessPhrase: writeOnlyValue, rows: [{ pin: arrayPin }] }, sensitiveInputPaths,
  });
  const completed = await eventually(() => manager.get(started.id).run, (run) => run.status === 'succeeded');
  const publicData = JSON.stringify({ completed, steps: manager.steps(started.id).items });
  const persisted = fs.readFileSync(path.join(root, 'automation-runs.json'), 'utf8');
  assert.equal(publicData.includes(password), false);
  assert.equal(publicData.includes(writeOnlyValue), false);
  assert.equal(publicData.includes(arrayPin), false);
  assert.equal(persisted.includes(password), false);
  assert.equal(persisted.includes(writeOnlyValue), false);
  assert.equal(persisted.includes(arrayPin), false);
  assert.equal(JSON.parse(persisted).runs[0].request, undefined);

  const restored = createAutomationRunManager({ dataDir: root, execute: async () => ({ success: true }) });
  assert.equal(restored.get(started.id).run.retryAvailable, false);
  assert.throws(() => restored.retry(started.id), { code: 'RUN_INPUT_UNAVAILABLE' });
  assert.throws(() => restored.start({ id: 'card-private-inputs', idempotency_key: 'private-run', inputs: {} }), {
    code: 'IDEMPOTENCY_KEY_STATE_UNAVAILABLE',
  });
});

test('legacy run migration removes replay inputs and redacts every input value', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'automation-runs.json');
  const legacyInput = { accessPhrase: 'legacy-pin-7391', display: 'legacy display value' };
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, runs: [{
    id: 'legacy-run', cardId: 'legacy-card', status: 'failed', request: { inputs: legacyInput },
    output: { context: legacyInput, message: `echo ${legacyInput.accessPhrase}` },
    steps: [{ result: `echo ${legacyInput.display}` }], error: { code: 'OLD_FAILURE', retryable: true },
  }] }));

  const manager = createAutomationRunManager({ dataDir: root, execute: async () => ({ success: true }) });
  const publicRun = JSON.stringify({ run: manager.get('legacy-run').run, steps: manager.steps('legacy-run').items });
  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.equal(publicRun.includes(legacyInput.accessPhrase), false);
  assert.equal(publicRun.includes(legacyInput.display), false);
  assert.equal(persisted.includes(legacyInput.accessPhrase), false);
  assert.equal(persisted.includes(legacyInput.display), false);
  assert.equal(JSON.parse(persisted).runs[0].request, undefined);
  assert.equal(manager.get('legacy-run').run.retryAvailable, false);
  assert.throws(() => manager.retry('legacy-run'), { code: 'RUN_INPUT_UNAVAILABLE' });
});

test('retrying a retryable failed run is idempotent and creates one full new attempt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-retry-idempotent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (request) => request.attempt > 1 ? { success: true } : { success: false, error: 'transient failure', retryable: true },
  });
  const failed = manager.start({ id: 'retry-card' });
  await eventually(() => manager.get(failed.id).run, (run) => run.status === 'failed');
  const retry = manager.retry(failed.id).run;
  const duplicate = manager.retry(failed.id).run;
  assert.equal(duplicate.id, retry.id);
  const completed = await eventually(() => manager.get(retry.id).run, (run) => run.status === 'succeeded');
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

test('run manager pauses at step boundaries and single-step releases only one step', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-step-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dispatched = [];
  let finishFirstStep;
  let markFirstStepStarted;
  const firstStepStarted = new Promise((resolve) => { markFirstStepStarted = resolve; });
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (_request, context) => {
      for (const id of ['one', 'two', 'three']) {
        await context.beforeStep();
        if (id === 'one') {
          markFirstStepStarted();
          await new Promise((resolve) => { finishFirstStep = resolve; });
        }
        dispatched.push(id);
        context.onProgress({ stepId: id, phase: 'succeeded' });
      }
      return { success: true };
    },
  });
  const run = manager.start({ id: 'card-controls' });
  await firstStepStarted;
  manager.pause(run.id);
  finishFirstStep();
  await eventually(() => manager.get(run.id).run, (item) => item.status === 'paused');
  const countAtPause = dispatched.length;
  manager.step(run.id);
  await eventually(() => manager.get(run.id).run, (item) => item.status === 'paused' && dispatched.length > countAtPause);
  assert.equal(dispatched.length, countAtPause + 1);
  manager.resume(run.id);
  const completed = await eventually(() => manager.get(run.id).run, (item) => item.status === 'succeeded');
  assert.equal(completed.steps.length, 3);
});

test('cancelling a paused run releases its boundary gate', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-paused-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let releaseStep;
  let markStepStarted;
  const stepStarted = new Promise((resolve) => { markStepStarted = resolve; });
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (_request, context) => {
      await context.beforeStep();
      markStepStarted();
      await new Promise((resolve) => { releaseStep = resolve; });
      await context.beforeStep();
      return { success: true };
    },
  });
  const run = manager.start({ id: 'card-paused-cancel' });
  await stepStarted;
  manager.pause(run.id);
  releaseStep();
  await eventually(() => manager.get(run.id).run, (item) => item.status === 'paused');
  assert.equal(manager.cancel(run.id).run.status, 'cancelling');
  const cancelled = await eventually(() => manager.get(run.id).run, (item) => item.status === 'cancelled');
  assert.equal(cancelled.finishedAt > 0, true);
});

test('restored paused runs are marked interrupted and are not replayed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runs-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let releaseStep;
  let markStepStarted;
  const stepStarted = new Promise((resolve) => { markStepStarted = resolve; });
  const manager = createAutomationRunManager({
    dataDir: root,
    execute: async (_request, context) => {
      await context.beforeStep();
      markStepStarted();
      await new Promise((resolve) => { releaseStep = resolve; });
      await context.beforeStep();
      return { success: true };
    },
  });
  const run = manager.start({ id: 'card-restart' });
  await stepStarted;
  manager.pause(run.id);
  releaseStep();
  await eventually(() => manager.get(run.id).run, (item) => item.status === 'paused');
  const restored = createAutomationRunManager({ dataDir: root, execute: async () => { throw new Error('must not replay'); } });
  assert.equal(restored.get(run.id).run.status, 'failed');
  assert.equal(restored.get(run.id).run.error.code, 'RUN_INTERRUPTED');
  manager.cancel(run.id, 'test cleanup');
});

function testManager(t, execute) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-run-history-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return createAutomationRunManager({ dataDir, execute });
}

test('public projections protect input echoes without altering control data', async (t) => {
  const manager = testManager(t, async (request, context) => {
    context.addInputs([{ fallback: 'default!value' }]);
    context.onProgress({ stepId: 'running', phase: 'succeeded', attempt: 1, result: {
      echo: 'PrerunningPost/x!$/default!value', count: 92817, durationMs: 32,
    } });
    return { success: true, context: request.inputs, detail: 'copied x!$', diagnostic: 'ready' };
  });
  const events = [];
  manager.subscribe((event) => events.push(event));
  const handle = manager.start({ id: 'running', connectionId: 'running', password: 'running',
    inputs: { text: 'x!$', rows: [{ n: 92817 }], flag: true, small: 1 } });
  const done = await eventually(() => manager.get(handle.id).run, (run) => run.finishedAt);
  const steps = manager.steps(handle.id).items;
  for (const record of [done, manager.list().items[0], events.at(-1).run, JSON.parse(fs.readFileSync(manager.filePath)).runs[0]]) {
    assert.equal(record.id, handle.id);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.connectionId, 'running');
    assert.equal(record.cardId, 'running');
    assert.equal(record.currentStepId, 'running');
    assert.equal(record.attempt, 1);
    assert.equal(record.output.success, true);
    assert.equal(record.output.diagnostic, 'ready');
    assert.equal(record.output.detail, 'copied [REDACTED]');
    assert.equal(record.steps[0].result.count, '[REDACTED]');
    assert.equal(record.steps[0].result.durationMs, 32);
    assert.equal(record.steps[0].result.echo, 'Pre[REDACTED]Post/[REDACTED]/[REDACTED]');
    assert.deepEqual(record.steps, steps);
    assert.doesNotMatch(JSON.stringify(record.output), /92817|x!\$/);
  }
  assert.ok(events.some(({ run }) => run.status === 'running'));
  assert.equal(steps[0].attempt, 1);
  assert.equal(steps[0].phase, 'succeeded');
});

test('first stop wins and free text cancellation reasons never enter history', async (t) => {
  for (const first of ['cancel', 'timeout']) {
    let release;
    const manager = testManager(t, () => new Promise((resolve) => { release = resolve; }));
    const events = [];
    manager.subscribe((event) => events.push(event));
    const { id } = manager.start({ id: 'slow', timeoutMs: 40 });
    await eventually(() => release, Boolean);
    if (first === 'timeout') await eventually(() => manager.get(id).run.status, (s) => s === 'timing_out');
    manager.cancel(id, 'free text unrelated to request inputs');
    await new Promise((resolve) => setTimeout(resolve, 55));
    const stopping = manager.get(id).run;
    assert.equal(stopping.finishedAt, null);
    assert.equal(stopping.status, first === 'cancel' ? 'cancelling' : 'timing_out');
    release({ success: true });
    const done = await eventually(() => manager.get(id).run, (r) => r.finishedAt);
    assert.equal(done.status, first === 'cancel' ? 'cancelled' : 'timed_out');
    assert.equal(done.sideEffectsMayHaveOccurred, true);
    assert.doesNotMatch(JSON.stringify(events) + fs.readFileSync(manager.filePath), /free text unrelated/);
  }
});

test('subscribers can synchronously release the published pause gate', async (t) => {
  for (const action of ['resume', 'step', 'cancel']) {
    let ran = 0;
    const manager = testManager(t, async (_, context) => {
      await context.beforeStep();
      if (!context.signal.aborted) ran++;
      return { success: true };
    });
    manager.subscribe(({ event, run }) => {
      if (event === 'started') manager.pause(run.id);
      if (event === 'paused') manager[action](run.id);
    });
    const { id } = manager.start({ id: 'pause-test', timeoutMs: 120 });
    const done = await eventually(() => manager.get(id).run, (r) => r.finishedAt);
    assert.equal(done.status, action === 'cancel' ? 'cancelled' : 'succeeded');
    assert.equal(ran, action === 'cancel' ? 0 : 1);
  }
});

test('only explicitly retryable failures with no reported uncertainty or side effects may replay', async (t) => {
  for (const thrown of [false, true]) {
    for (const flags of [{}, { retryable: false }, { retryable: true, uncertain: true },
      { retryable: true, sideEffects: true }, { retryable: true, sideEffectsMayHaveOccurred: true },
      { retryable: true, actionExecuted: 'unknown' }]) {
      const manager = testManager(t, async () => {
        if (thrown) throw Object.assign(new Error('temporary'), flags);
        return { success: false, error: 'temporary', ...flags };
      });
      const { id } = manager.start({ id: 'guarded' });
      const done = await eventually(() => manager.get(id).run, (r) => r.finishedAt);
      assert.equal(done.status, 'failed');
      assert.equal(done.retryAvailable, false, JSON.stringify(flags));
      assert.equal(done.error.retryable, false);
      assert.throws(() => manager.retry(id), { code: 'RUN_NOT_RETRYABLE' });
    }
  }
});

test('synchronous result mask supports adding derived values before progress and final output', () => {
  const { createAutomationRedactor } = require('../../../src/app/backend/services/automation-run-sanitizer');
  const mask = createAutomationRedactor({ inputs: { rows: [{ entry: 'word' }] }, sensitiveInputPaths: ['inputs.rows[].entry'] });
  assert.equal(mask.redact('prewordpost'), 'pre[REDACTED]post');
  mask.addInputs({ calculated: [41972, '$.!', 'A', true] });
  const output = mask.redactResult({ success: true, context: { arg: 41972, flag: true }, execution: [{
    type: 'mcp', success: true, stepIndex: 1, result: { success: true, detail: 'word$.!A', count: 41972 },
  }] });
  assert.equal(output.success, true);
  assert.equal(output.execution[0].result.success, true);
  assert.deepEqual(output.context, { arg: '[REDACTED]', flag: '[REDACTED]' });
  assert.equal(output.execution[0].result.detail, '[REDACTED][REDACTED][REDACTED]');
  assert.deepEqual(mask.redactResult(output), output);
});

test('context-only legacy records and interrupted stop requests migrate on disk once', (t) => {
  const manager = testManager(t, async () => { throw new Error('unexpected replay'); });
  const dataDir = path.dirname(manager.filePath);
  const old = ['cancelling', 'timing_out', 'cancelled'].map((status) => ({
    id: status, cardId: 'running', status, connectionId: 'running', startedAt: 41,
    output: { context: { display: 'running', phrase: 'embedded.+', number: 41 }, ordinary: 'aembedded.+b', elapsed: 82 },
    error: { message: 'legacy unrelated cancellation reason', code: 'RUN_CANCELLED' },
  }));
  fs.writeFileSync(manager.filePath, JSON.stringify({ schemaVersion: 1, runs: old }));
  const reload = () => createAutomationRunManager({ dataDir, execute: () => assert.fail('unexpected replay') });
  const migrated = reload();
  assert.equal(migrated.get('cancelling').run.stopRequested, 'cancel');
  assert.equal(migrated.get('timing_out').run.stopRequested, 'timeout');
  assert.equal(migrated.get('cancelled').run.status, 'cancelled');
  for (const run of migrated.list().items) {
    assert.equal(run.cardId, 'running');
    assert.equal(run.connectionId, 'running');
    assert.equal(run.startedAt, 41);
    assert.equal(run.output.elapsed, 82);
    assert.equal(run.output.ordinary, 'a[REDACTED]b');
    assert.equal(run.retryAvailable, false);
  }
  const disk = fs.readFileSync(manager.filePath, 'utf8');
  assert.doesNotMatch(disk, /legacy unrelated|embedded\.\+/);
  assert.deepEqual(reload().list(), migrated.list());
  assert.equal(fs.readFileSync(manager.filePath, 'utf8'), disk);
});

test('re-entrant cancellation reaches every subscriber in order and skips an unstarted executor', async (t) => {
  let dispatches = 0;
  const manager = testManager(t, async () => { dispatches++; return { success: true }; });
  const events = [];
  manager.subscribe(({ event, run }) => { if (event === 'started') manager.cancel(run.id); });
  manager.subscribe(({ event }) => events.push(event));
  const { id } = manager.start({ id: 'event-order' });
  const done = await eventually(() => manager.get(id).run, (run) => run.finishedAt);
  assert.deepEqual(events, ['created', 'started', 'cancelling', 'cancelled']);
  assert.equal(done.sideEffectsMayHaveOccurred, false);
  assert.equal(dispatches, 0);
});

test('concurrent retry requests share the child even when a caller uses the same key for a normal start', async (t) => {
  let calls = 0;
  const manager = testManager(t, async () => (++calls === 1
    ? { success: false, error: 'busy', retryable: true } : { success: true }));
  const source = manager.start({ id: 'parent' });
  await eventually(() => manager.get(source.id).run, (r) => r.retryAvailable);
  const other = manager.start({ id: 'other', idempotency_key: `retry:${source.id}:2` });
  const children = await Promise.all([0, 1].map(() => Promise.resolve().then(() => manager.retry(source.id).run)));
  assert.equal(children[0].id, children[1].id);
  assert.notEqual(other.id, children[0].id);
  await eventually(() => manager.get(children[0].id).run, (r) => r.finishedAt);
  assert.equal(calls, 3);
  assert.equal(manager.retry(source.id).run.id, children[0].id);
});

test('failed cards report earlier dispatched input and allow whole-card retry only before side effects', async (t) => {
  const { runCard } = require('../../../src/app/backend/services/automation-card-execution');
  const cases = [
    { tool: 'browser_action', receipt: { success: true, actionExecuted: true }, effect: true },
    { tool: 'browser_action', receipt: { success: false, actionExecuted: 'unknown' }, effect: true },
    { tool: 'browser_observe', receipt: { success: true, items: [] }, effect: false },
  ];
  for (const { tool, receipt, effect } of cases) {
    const card = { steps: [
      { type: 'mcp', tool, optional: true },
      { type: 'mcp', tool: 'browser_wait' },
    ] };
    const manager = testManager(t, (request, context) => runCard(card, request, async (name) => (
      name === tool ? receipt : { success: false, errorCode: 'WAIT_TIMEOUT', retryable: true }
    ), context));
    const { id } = manager.start({ id: 'fixture-card' });
    const done = await eventually(() => manager.get(id).run, (run) => run.finishedAt);
    assert.equal(done.error.code, 'WAIT_TIMEOUT');
    assert.equal(done.output.stepIndex, 2);
    assert.equal(done.sideEffectsMayHaveOccurred, effect);
    assert.equal(done.output.sideEffectsMayHaveOccurred, effect);
    assert.equal(done.retryAvailable, !effect);
    if (effect) assert.throws(() => manager.retry(id), { code: 'RUN_NOT_RETRYABLE' });
  }
});
