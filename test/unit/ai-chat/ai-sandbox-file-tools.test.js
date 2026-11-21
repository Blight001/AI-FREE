'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const {
  createAiSandboxFileTools,
  executeCommand,
  resolveInside,
} = require('../../../src/app/backend/services/ai-sandbox-file-tools');
const { ProfileRuntimeStore } = require('../../../src/app/backend/browser-runtime/profile-runtime-store');
const { combineToolSets } = require('../../../src/app/backend/services/combine-tool-sets');
const { executeToolCalls } = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-command-stage3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('run_command streams multiple bounded snapshots before exit', async (t) => {
  const root = fixture(t);
  const snapshots = [];
  const command = `"${process.execPath}" -e "console.log('first'); setTimeout(() => { console.error('second'); }, 350); setTimeout(() => { process.stdout.write('x'.repeat(100000)); process.exitCode = 7; }, 800)"`;
  const tools = combineToolSets(createAiSandboxFileTools({ sandboxDir: root }));
  const result = await tools.execute('run_command', { command }, { onProgress: (event) => snapshots.push(event) });
  assert.ok(snapshots.some((event) => event.stdout.includes('first') && !event.stderr));
  assert.ok(snapshots.some((event) => event.stderr.includes('second') && !event.stdout.includes('xxxxx')));
  assert.ok(snapshots.every((event) => Buffer.byteLength(event.stdout) <= 64 * 1024));
  assert.equal(result.state, 'failed');
  assert.equal(result.exit_code, 7);
  assert.equal(result.stdout_truncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 64 * 1024);
  assert.equal(result.stderr.trim(), 'second');
});

test('a pre-aborted command does not start', async (t) => {
  const root = fixture(t);
  const result = await executeCommand(root, { command: 'echo ran>unexpected.txt' }, { signal: AbortSignal.abort() });
  assert.equal(result.state, 'stopped');
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(path.join(root, 'unexpected.txt')), false);
});

test('chat waits for the terminal command event and skips the next tool after Stop', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = fixture(t);
  const controller = new AbortController();
  const events = [];
  const toolEvents = [];
  const toolCall = (id, command) => ({ id, function: { name: 'run_command', arguments: JSON.stringify({ command }) } });
  const result = await executeToolCalls({
    round: 2, toolEvents, traceEvents: [], modelMessages: [],
    windowTools: combineToolSets(createAiSandboxFileTools({ sandboxDir: root })),
    signal: controller.signal,
    compactToolValue: (value) => value,
    isStopped: () => controller.signal.aborted,
    waitForAbort: (promise) => promise,
    emit(event) {
      events.push(event);
      if (event.type === 'tool_progress' && event.tool.progress.stdout.includes('started')) controller.abort();
    },
    toolCalls: [
      toolCall('command-one', `"${process.execPath}" -e "console.log('started'); setTimeout(() => {}, 5000)"`),
      toolCall('command-two', 'echo unexpected>unexpected.txt'),
    ],
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(events.map((event) => event.type), ['tool_start', 'tool_progress', 'tool_progress', 'tool_result']);
  assert.ok(events.every((event) => event.tool.id === 'command-one' && event.round === 2));
  assert.equal(events.at(-2).tool.progress.state, 'stopping');
  assert.equal(events.at(-1).tool.result.state, 'stopped');
  assert.equal(toolEvents[0].result.state, 'stopped');
  assert.equal(toolEvents[0].result.stdout, undefined);
  assert.equal(fs.existsSync(path.join(root, 'unexpected.txt')), false);
});

for (const stopBy of ['abort', 'timeout']) {
  test(`Windows ${stopBy} confirms a detached grandchild has exited before returning`, { skip: process.platform !== 'win32' }, async (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'parent.cjs'), `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['child.cjs'], { detached: true, stdio: 'ignore' });
      child.unref();
    `);
    fs.writeFileSync(path.join(root, 'child.cjs'), `
      const fs = require('node:fs');
      fs.writeFileSync('child.pid', String(process.pid));
      setInterval(() => fs.appendFileSync('heartbeat.txt', 'x'), 30);
    `);
    const controller = new AbortController();
    const snapshots = [];
    const execution = executeCommand(root, {
      command: `"${process.execPath}" parent.cjs`, timeout_ms: stopBy === 'timeout' ? 4500 : 9000,
    }, { signal: controller.signal, onProgress: (event) => {
      snapshots.push(event);
      if (stopBy === 'timeout' && event.state === 'stopping') controller.abort();
    } });
    const heartbeat = path.join(root, 'heartbeat.txt');
    const deadline = Date.now() + 13000;
    while (!fs.existsSync(heartbeat) && Date.now() < deadline) await delay(30);
    if (stopBy === 'abort') controller.abort();
    const result = await execution;
    const pidFile = path.join(root, 'child.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
    if (pid) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      assert.equal(alive, false, 'grandchild was gone before fixture cleanup');
    }
    assert.ok(fs.existsSync(heartbeat), 'grandchild ran before termination');
    assert.equal(result.state, stopBy === 'abort' ? 'stopped' : 'timed_out');
    assert.equal(result.timed_out, stopBy === 'timeout');
    assert.equal(snapshots.filter((event) => event.state === 'stopping').length, 1);
    assert.ok(pid);
    const size = fs.statSync(heartbeat).size;
    await delay(160);
    assert.equal(fs.statSync(heartbeat).size, size);
  });
}

test('PowerShell quoting survives the Windows supervisor and a late abort leaves natural exit intact', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const controller = new AbortController();
  const result = await executeCommand(fixture(t), {
    shell: 'powershell', command: 'Write-Output "two words"; exit 5', timeout_ms: 2500,
  }, { signal: controller.signal });
  controller.abort();
  assert.equal(result.state, 'failed');
  assert.equal(result.exit_code, 5);
  assert.equal(result.stdout.trim(), 'two words');
  assert.equal(result.stderr, '');
});

test('run_command executes in an AI-Workspace subdirectory and returns bounded output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workspace-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs'));
  const tools = createAiSandboxFileTools({ sandboxDir: root });
  const command = process.platform === 'win32'
    ? 'echo hello>result.txt && type result.txt'
    : 'printf hello > result.txt && cat result.txt';

  assert.equal(tools.has('run_command'), true);
  assert.equal(tools.tools[0].name, 'run_command');
  const result = await tools.execute('run_command', { command, directory: 'jobs' });
  assert.equal(result.success, true);
  assert.match(result.stdout, /hello/);
  assert.equal(result.directory, 'jobs');
  assert.equal(fs.readFileSync(path.join(root, 'jobs', 'result.txt'), 'utf8').trim(), 'hello');
  assert.deepEqual(fs.readdirSync(root), ['jobs']);
});

test('run_command rejects working directories outside AI-Workspace', () => {
  assert.throws(() => resolveInside('C:/workspace', '../outside'), /超出 AI 工作区/);
});

test('all Chromium profiles use the shared workspace without nesting it in profile data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-profile-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'AI-Workspace');
  const store = new ProfileRuntimeStore({
    rootDir: path.join(root, 'profiles'),
    downloadsDir: workspace,
  });
  assert.equal(store.getProfilePaths('one').downloads, workspace);
  assert.equal(store.getProfilePaths('two').downloads, workspace);
});
