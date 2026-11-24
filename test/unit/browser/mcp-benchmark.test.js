'use strict';



const test = require('node:test');

const assert = require('node:assert/strict');

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const { openMcpBenchmarkFixture, FIXTURE_FILE } = require('../../../src/app/backend/features/browser/mcp-benchmark-fixture');

const { scoreMcpBenchmark } = require('../../../src/app/backend/features/browser/mcp-benchmark-score');

const { createMcpBenchmarkHistory, MAX_HISTORY, safeModelName } = require('../../../src/app/backend/features/browser/mcp-benchmark-history');

const { createMcpBenchmarkController, PROFILE_ID } = require('../../../src/app/backend/features/browser/mcp-benchmark-controller');



async function postEvent(url, payload) {

  const route = new URL(url);

  return fetch(`${route.origin}${route.pathname.replace(/\/$/, '')}/event`, {

    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),

  });

}



test('local benchmark fixture independently verifies controls, drag order, download and upload', async (t) => {

  const fixture = await openMcpBenchmarkFixture();

  t.after(() => fixture.close());

  const page = await fetch(fixture.url);

  assert.equal(page.status, 200);

  assert.ok((await page.text()).includes(fixture.expectedCpu));

  await postEvent(fixture.url, { event: 'controls', value: 'MCP-OK', checked: true });

  await postEvent(fixture.url, { event: 'sort', order: ['4', '1', '2', '3'] });

  const download = await fetch(new URL('download', fixture.url));

  assert.deepEqual(Buffer.from(await download.arrayBuffer()), FIXTURE_FILE);

  const form = new FormData();

  form.append('file', new Blob([FIXTURE_FILE]), 'mcp-benchmark.txt');

  const upload = await fetch(new URL('upload', fixture.url), { method: 'POST', body: form });

  assert.equal(upload.status, 200);

  assert.match(await upload.text(), /\u901a\u8fc7/);

  assert.deepEqual(fixture.snapshot(), {

    control: { value: 'MCP-OK', checked: true }, order: ['4', '1', '2', '3'], uploaded: true,

  });

});



test('benchmark score is derived from independent fixture state, not model claims alone', () => {

  const snapshot = { control: { value: 'MCP-OK', checked: true }, order: ['4', '1', '2', '3'], uploaded: true };

  assert.equal(scoreMcpBenchmark({ ...snapshot, downloadVerified: true }, '{"readValue":"42.0%"}', '42.0%').score, 100);

  const altered = scoreMcpBenchmark({ ...snapshot, uploaded: false, downloadVerified: true }, '{"readValue":"42.0%"}', '42.0%');

  assert.equal(altered.score, 80);

  assert.equal(altered.results.find((item) => item.id === 'upload').passed, false);

  assert.equal(scoreMcpBenchmark({ ...snapshot, downloadVerified: true }, 'the answer is unknown', '42.0%').score, 80);

});



test('benchmark history is bounded and excludes raw conversation content', (t) => {

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-benchmark-history-'));

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const file = path.join(directory, 'history.json');

  const repository = createMcpBenchmarkHistory(file);

  for (let index = 0; index < MAX_HISTORY + 3; index += 1) {

    repository.append({ id: String(index), createdAt: index, modelId: 'model-v1', modelName: 'GPT',

      status: 'completed', score: 80, results: [{ id: 'table-read', title: '璇诲彇', passed: true, points: 20, evidence: '42.0%' }], secretTranscript: 'must-not-persist' });

  }

  assert.match(safeModelName('Custom API key=secret123'), /redacted/);

  const records = repository.read();

  assert.equal(records.length, MAX_HISTORY);

  assert.equal(records[0].id, '3');
  assert.equal(records[0].sourceHash, '');

  assert.equal(fs.readFileSync(file, 'utf8').includes('must-not-persist'), false);

  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);

});



test('benchmark controller delivers one ordinary sidebar chat and appends verified score to its result', async (t) => {

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-benchmark-controller-'));

  const workspace = path.join(directory, 'workspace');

  const userData = path.join(directory, 'user-data');
  const appPath = path.join(directory, 'generated-app');

  fs.mkdirSync(workspace); fs.mkdirSync(userData); fs.mkdirSync(appPath);

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(path.join(appPath, 'build-manifest.json'), JSON.stringify({ sourceHash: 'build-B' }));
  const historyFile = path.join(userData, 'mcp-benchmark-history.json');
  createMcpBenchmarkHistory(historyFile).append({ id: 'prior', createdAt: 1, modelId: 'selected-model',
    modelName: 'Selected model', status: 'completed', score: 80, sourceHash: 'build-A' });
  const tabs = new Map();

  let pageUrl = '';

  const listener = {};

  const sidebar = { isDestroyed: () => false, send(channel, notice) { listener.channel = channel; listener.notice = notice; },

    mainFrame: {}, once() {}, on() {}, off() {} };

  const connection = { id: PROFILE_ID, profileId: PROFILE_ID, name: 'MCP 综合测试', browserProcessId: 81,

    connectedAt: 10, tools: [] };

  let delivered;

  const deps = {

    app: { getPath: () => userData, getAppPath: () => appPath }, fs, aiSandboxDir: workspace,

    getAiModels: () => ({ ok: true, models: [{ id: 'selected-model', name: 'Selected model' }] }),

    getSideView: () => ({ webContents: sidebar }), showBenchmarkSidebar() {},

    browserWindowUi: {

      getTabs: () => tabs,

      addTab: async (url, options) => { pageUrl = url; tabs.set(options.tabId, { id: options.tabId }); return options.tabId; },

      switchTab() {}, closeTab: async (id) => { tabs.delete(id); },

    },

    browserRuntimeManager: { openForegroundTab: async (_id, _type, url) => { pageUrl = url; return { success: true }; } },

    browserAutomationBridge: { listConnections: () => [connection], getConnection: () => connection },


  };

  const controller = createMcpBenchmarkController(deps);

  t.after(controller.dispose);

  const started = controller.start();

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(listener.channel, 'ai-control-benchmark-notice');

  assert.match(listener.notice.content, /MCP 本地基准测试/);
  fs.writeFileSync(path.join(appPath, 'build-manifest.json'), JSON.stringify({ sourceHash: 'build-C' }));

  const fixture = await fetch(pageUrl);

  const expectedCpu = /id="target-cpu">([^<]+)/.exec(await fixture.text())[1];

  await postEvent(pageUrl, { event: 'controls', value: 'MCP-OK', checked: true });

  await postEvent(pageUrl, { event: 'sort', order: ['4', '1', '2', '3'] });

  await fetch(new URL('download', pageUrl));

  const runDirectory = fs.readdirSync(workspace).map((name) => path.join(workspace, name)).find((name) => fs.statSync(name).isDirectory());

  fs.writeFileSync(path.join(runDirectory, 'mcp-benchmark.txt'), FIXTURE_FILE);

  const form = new FormData(); form.append('file', new Blob([FIXTURE_FILE]), 'mcp-benchmark.txt');

  await fetch(new URL('upload', pageUrl), { method: 'POST', body: form });

  const event = { sender: sidebar, senderFrame: sidebar.mainFrame };

  const prompt = listener.notice.content;

  const result = await controller.chat(event, { benchmarkId: listener.notice.id, stream: true, requestId: 'request',

    modelId: 'selected-model', quota: null, messages: [{ role: 'user', content: prompt }] }, {

    stop: async () => ({ ok: true }),

    chat: async (_event, input, grant) => {

      assert.equal(input.modelId, 'selected-model');

      assert.equal(input.messages.length, 1, 'only benchmark prompt enters the model context');

      assert.equal(grant.allowedOrigins[0], new URL(pageUrl).origin);

      assert.equal(grant.workspaceRoot, workspace);

      return { ok: true, messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: `{"readValue":"${expectedCpu}"}` }],

        message: { role: 'assistant', content: `{"readValue":"${expectedCpu}"}`, tool_events: [{ name: 'browser_observe' }] } };

    },

  });

  await started;

  assert.match(result.message.content, /MCP 综合成绩 100\/100/);

  assert.deepEqual(result.message.tool_events, [{ name: 'browser_observe' }]);

  assert.equal(result.messages.at(-1).content, result.message.content);
  assert.match(result.message.content, /上次 sourceHash build-A.*本次 sourceHash build-B/);
  assert.match(result.message.content, /变化 20 分/);
  assert.doesNotMatch(result.message.content, /首次同模型/);
  const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  assert.deepEqual(history.map((record) => record.sourceHash), ['build-A', 'build-B']);

  assert.equal(tabs.has(PROFILE_ID), false);

  assert.equal(fs.readdirSync(workspace).length, 0);

});

