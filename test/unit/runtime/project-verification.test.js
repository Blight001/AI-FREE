'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { executeStep, verificationEnv, safeOutput } = require('../../../scripts/verification/process');
const { verificationPlan, unmetRequirement, unmetDependency, projectRoot } = require('../../../scripts/verification/catalog');
const { listVerification } = require('../../../scripts/verification/runner');

function isolatedRunner(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-verification-api-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['catalog.js', 'process.js', 'runner.js', 'patches.js', 'interactions.js', 'plans.js', 'flow-reports.js']) {
    const target = path.join(root, 'scripts/verification', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, 'scripts/verification', file), target);
  }
  for (const file of ['scripts/check-chromium-patches.js',
    'test/helpers/flows/runner.js',
    'test/helpers/flows/domains.js',
    'test/helpers/flows/schema.js',
    'test/helpers/flows/values.js',
    'test/helpers/flows/assertions.js',
    'src/app/backend/browser-runtime/chromium-diagnostic-redaction.js']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'native/chromium-fork/patches'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.0.0"}');
  fs.writeFileSync(path.join(root, 'native/chromium-fork/patches/series'), 'fixture.patch\n');
  fs.writeFileSync(path.join(root, 'native/chromium-fork/patches/fixture.patch'),
    '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  return require(path.join(root, 'scripts/verification/runner'));
}

async function runCode(code, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-verification-test-'));
  try {
    return await executeStep({ id: 'fixture', args: ['-e', code], timeoutMs: 5000, ...options }, {
      root, env: verificationEnv(root), signal: options.signal,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('verification distinguishes passed, failed and skipped tests', async () => {
  const passed = await runCode('console.log("fixture passed")');
  assert.equal(passed.status, 'passed');
  assert.match(passed.output, /fixture passed/);
  const failed = await runCode('process.exitCode = 7');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 7);
  const skipped = await runCode('console.log("# skipped 2\\n# todo 1")');
  assert.equal(skipped.status, 'incomplete');
  assert.equal(skipped.skipped, 3);
  const spec = await runCode('console.log("ℹ skipped 1\\nℹ todo 0")');
  assert.equal(spec.status, 'incomplete');
});

test('verification times out and cancels owned processes', async () => {
  const timeout = await runCode('setInterval(() => {}, 1000)', { timeoutMs: 200 });
  assert.equal(timeout.status, 'timed_out');
  assert.equal(timeout.cleanupOk, true);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runCode('setInterval(() => {}, 1000)', { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cleanupOk, true);
});

test('verification retains test counts and failure names when verbose diagnostics exceed the output limit', async () => {
  const result = await runCode('console.log("✖ fixture failure\\nℹ tests 5\\nℹ pass 3\\nℹ fail 2\\n" + "x".repeat(70000)); process.exitCode = 1');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.testSummary, { tests: 5, pass: 3, fail: 2 });
  assert.deepEqual(result.failedTests, ['✖ fixture failure']);
  assert(result.output.length <= 6000);
});

test('fixture cleanup failure cannot be reported as a passed check even with exit zero', async () => {
  const result = await runCode('console.error("VERIFICATION_CLEANUP_FAILED")');
  assert.equal(result.status, 'failed');
  assert.equal(result.cleanupOk, false);
});

test('flow evidence survives output truncation and failed flow overrides exit zero', async () => {
  const flow = { schemaVersion: 1, id: 'independent-readback', status: 'failed', passedSteps: 1,
    actionAssertions: 1, observationAssertions: 0, oracleAssertions: 0, failedStep: 'readback',
    pageValue: 'must-not-be-forwarded' };
  const line = 'VERIFICATION_FLOW_RESULT ' + JSON.stringify(flow);
  const result = await runCode(`console.log(${JSON.stringify(line)}); console.log('x'.repeat(70000));`);
  assert.equal(result.status, 'failed');
  assert.equal(result.flowReports[0].failedStep, 'readback');
  assert.equal(result.flowReports[0].oracleAssertions, 0);
  assert(!JSON.stringify(result.flowReports).includes('must-not-be-forwarded'));
});

test('verification rejects unknown suites and reports missing prerequisites', () => {
  assert.throws(() => verificationPlan('anything; dangerous-command'), /Unknown verification suite/);
  assert.match(unmetRequirement({ windows: true }, projectRoot, 'linux'), /WINDOWS_REQUIRED/);
  assert.match(unmetRequirement({ requiredFiles: ['missing-verification-fixture.node'] }), /MISSING_PREREQUISITE/);
  assert.match(unmetDependency({ after: ['build'] }, [{ id: 'build', status: 'failed' }]), /DEPENDENCY_NOT_PASSED/);
  assert.equal(unmetDependency({ after: ['build'] }, []), '');
  const listed = listVerification();
  assert.equal(listed.ok, true);
  assert(listed.data.suites.full.some((step) => step.id === 'patch-replay'));
});

test('verification does not forward runtime credentials or external Chromium overrides', () => {
  const values = { AI_FREE_ACCEPTANCE_CHROMIUM_PATH: 'external-browser',
    AI_FREE_GOOGLE_API_KEY: 'fixture-api-key', AI_FREE_CHROMIUM_HANDSHAKE: 'prototype' };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const env = verificationEnv(os.tmpdir());
    for (const key of Object.keys(values)) assert.equal(env[key], undefined);
    assert(!safeOutput('value=fixture-api-key').includes('fixture-api-key'));
    assert(!safeOutput('{"token":"fixture-secret"}').includes('fixture-secret'));
    assert(!safeOutput("sessionId: 'fixture-session'").includes('fixture-session'));
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('verification API prevents concurrent runs and releases its lease after cancellation', async (t) => {
  const { runVerification } = isolatedRunner(t);
  const controller = new AbortController();
  controller.abort();
  let competing;
  const cancelled = await runVerification('inventory', {
    signal: controller.signal,
    onProgress: () => {
      competing ||= assert.rejects(runVerification('inventory'), /VERIFICATION_BUSY/);
    },
  });
  await competing;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.data.results[0].status, 'cancelled');
  assert.equal(cancelled.data.cleanupOk, true);
  const next = await runVerification('inventory');
  assert.equal(next.ok, true);
});

test('verification CLI has a JSON-only stdout catalog and rejects commands', () => {
  const cli = path.join(projectRoot, 'scripts/verify-project.js');
  const listed = spawnSync(process.execPath, [cli, '--list'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).ok, true);
  assert.equal(JSON.parse(listed.stdout).data.domains['native-browser'].operations.inspectState, 'oracle');
  const planned = spawnSync(process.execPath, [cli, '--plan', path.join(projectRoot, 'test/acceptance/flows/project-browser.json')],
    { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(planned.status, 0, planned.stdout);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.data.checks[2].id, 'native-workflow');
  assert.equal(plan.data.checks[2].oracleRequired, true);
  assert.match(plan.data.checks[2].scenarioHash, /^[a-f0-9]{64}$/);
  const invalid = spawnSync(process.execPath, [cli, 'arbitrary-command'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
});
