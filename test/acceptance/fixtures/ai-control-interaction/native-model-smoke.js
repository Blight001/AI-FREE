'use strict';

const assert = require('node:assert/strict');
const { DRAW_CIRCLE } = require('./circle-fixture');
const { EDITOR_PROMPT } = require('./page-batch-fixture');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { startFixture } = require('./server');
const { executeStep, verificationEnv } = require('../../../../scripts/verification/process');

async function runFixture() {
  const fixture = await startFixture();
  try {
    const result = await executeStep({ id: 'native-model-smoke', timeoutMs: 45000,
      args: [require.resolve('electron/cli.js'), __filename],
    }, { root: path.resolve(__dirname, '../../../..'), env: { ...verificationEnv(fixture.root), NO_PROXY: '127.0.0.1',
      AI_FREE_INTERACTION_FIXTURE: JSON.stringify(fixture) } });
    assert.equal(result.status, 'passed', result.output);
    assert.match(result.output, /NATIVE_CIRCLE_SMOKE_PASSED/);
    assert.match(result.output, /NATIVE_PAGE_BATCH_SMOKE_PASSED/);
    assert.match(result.output, /NATIVE_MODEL_SMOKE_PASSED/);
    console.log('NATIVE_CIRCLE_SMOKE_PASSED');
    console.log('NATIVE_PAGE_BATCH_SMOKE_PASSED');
    console.log('NATIVE_MODEL_SMOKE_PASSED');
  } finally {
    await fixture.close();
  }
}

function chatClient(fixture, bridge, browserConnectionId) {
  const { createAiChatService } = require('../../../../src/app/backend/features/ai-chat/ai-chat-service');
  const { CUSTOM_AI_MODEL_ID } = require('../../../../src/app/backend/utils/ai-control-settings');
  const service = createAiChatService({ browserAutomationBridge: bridge, browserWindowUi: { getTabs: () => [] }, aiSandboxDir: fixture.workspace,
    readStoreConfigSafe: () => ({ aiControlSettings: { customApi: { enabled: true, baseUrl: fixture.urls.model,
      apiKey: fixture.model.apiKey, model: fixture.model.id, supportsImageInput: true } } }),
  });
  return async (prompt, options = {}) => {
    const requestId = prompt;
    const event = { sender: { id: 1, isDestroyed: () => false, send() {} } };
    const result = await service.chat(event, { requestId, modelId: CUSTOM_AI_MODEL_ID, stream: false, localInteraction: true,
      messages: [{ role: 'user', content: prompt }], attachmentPaths: options.paths, artifactReferences: options.artifacts,
      browserConnectionId,
    });
    assert.equal(result.ok, true, result.message);
    return { result };
  };
}

async function selectedState(fixture) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await fetch(fixture.urls.state).then((response) => response.json());
    if (state.b.selectionCount > 0) return state;
    await delay(50);
  }
  assert.fail('Native file chooser did not record a selection on B');
}

async function exerciseCandidate(fixture, manager, bridge) {
  const connection = bridge.listConnections()[0];
  const chat = chatClient(fixture, bridge, connection.id);
  const { result: attached } = await chat('QA ATTACH', { paths: ['source-blue/sample.png'] });
  assert.match(attached.message.content, /Blue stripes/);
  const { result: downloaded } = await chat('QA DOWNLOAD RED');
  const observation = JSON.parse(downloaded.messages.find((message) => message.name === 'browser_observe').content);
  assert.equal(observation.url, fixture.urls.a);
  const red = observation.items.find((item) => item.elementId === 'source-red');
  assert.equal(red.selector, '#source-red');
  assert.equal(red.mediaUrl, fixture.origin + fixture.files.red.route);
  const call = downloaded.messages.flatMap((message) => message.tool_calls || [])
    .find((toolCall) => toolCall.function.name === 'browser_file');
  const args = JSON.parse(call.function.arguments);
  assert.equal(args.action, 'download_element');
  assert.equal(args.ref, red.id);
  const artifact = downloaded.message.artifacts?.[0];
  assert.ok(artifact, `${downloaded.message.content} ${JSON.stringify(downloaded.message.tool_events)}`);
  assert.equal(artifact.sha256, fixture.files.red.sha256);
  await manager.importSession(connection.profileId, { targetUrl: fixture.urls.dropOnce });
  const { result: selected } = await chat('QA SELECT B', { paths: [artifact.path], artifacts: [artifact] });
  assert.equal(selected.message.tool_events.some((tool) => tool.result?.uploadVerification === 'file_selected'), true, `${selected.message.content} ${JSON.stringify(selected.message.tool_events)}`);
  const state = await selectedState(fixture);
  assert.equal(state.b.lastSelected.sha256, artifact.sha256);
  assert.equal(state.b.receivedCount, 0);
  assert.equal(state.c.selectionCount, 0);
  const { result: observed } = await chat('QA OBSERVE B');
  assert.match(observed.message.content, /Receipt idle, readback verified, displayed received count 0/, JSON.stringify(observed.messages).slice(-5000));
  const { result: command } = await chat('QA COMMAND TIMEOUT');
  assert.match(command.message.content, /command timed out/);
}

async function exerciseCircle(fixture, manager, bridge, profileId) {
  await manager.importSession(profileId, { targetUrl: fixture.urls.circle });
  const { result } = await chatClient(fixture, bridge, bridge.listConnections()[0].id)(DRAW_CIRCLE);
  const toolMessages = result.messages.filter((message) => message.role === 'tool');
  assert.deepEqual(toolMessages.map((message) => message.name), [
    'browser_tab', 'browser_control', 'browser_observe', 'browser_action', 'browser_action', 'browser_observe',
  ], JSON.stringify(toolMessages.map((message) => ({ tool: message.name, error: JSON.parse(message.content)?.errorCode }))));
  assert.equal(result.message.content, '已画出一个直径 96 的圆。');
  const observation = JSON.parse(toolMessages[2].content);
  assert.equal(observation.image_attached, true, '持久历史保留原始工具结果');
  assert.ok(toolMessages[2].content.length > 12000);
  console.log('NATIVE_CIRCLE_SMOKE_PASSED');
}

async function exercisePageBatch(fixture, manager, bridge, profileId) {
  await manager.importSession(profileId, { targetUrl: fixture.urls.editor });
  const { result } = await chatClient(fixture, bridge, bridge.listConnections()[0].id)(EDITOR_PROMPT);
  const toolMessages = result.messages.filter((message) => message.role === 'tool');
  assert.deepEqual(toolMessages.map(({ name }) => name), [
    'browser_tab', 'browser_control', 'browser_observe', 'browser_page_batch', 'browser_observe',
  ], JSON.stringify(toolMessages.map(({ name, content }) => [name, JSON.parse(content).errorCode])));
  assert.deepEqual(JSON.parse(toolMessages[3].content), { success: true, requested: 10, completed: 10, notAttempted: 0 });
  const editor = JSON.parse(toolMessages[4].content);
  assert.ok(editor.items?.some(({ text }) => text === 'Accepted: First draft!'));
  assert.equal(result.message.content, 'Verified draft preview after ten page steps.');
  console.log('NATIVE_PAGE_BATCH_SMOKE_PASSED');
}

async function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const { createBrowserRuntimeManager } = require('../../../../src/app/backend/browser-runtime');
  const { createNativeBrowserAutomation } = require('../../../../src/app/backend/services/native-browser-automation');
  const { createBrowserDownloadService } = require('../../../../src/app/backend/services/browser-download-service');
  const fixture = JSON.parse(process.env.AI_FREE_INTERACTION_FIXTURE);
  app.setPath('userData', fixture.userData);
  app.setPath('sessionData', fixture.userData);
  await app.whenReady();
  const window = new BrowserWindow({ width: 900, height: 650 });
  const manager = createBrowserRuntimeManager({ userDataDir: fixture.userData, sandboxDir: fixture.workspace,
    resourcesPath: path.resolve(__dirname, '../../../../resources'), getParentWindow: () => window, logger: console });
  const bridge = createNativeBrowserAutomation({ browserRuntimeManager: manager, workspaceDir: fixture.workspace,
    browserDownloadService: createBrowserDownloadService({ sandboxDir: fixture.workspace }) });
  try {
    const profileId = 'interaction-native-model';
    const runtime = await manager.launchProfile({ profileId, runtimeType: 'chromium', initialUrl: 'about:blank' },
      { x: 0, y: 0, width: 850, height: 590 });
    assert.equal(runtime.status, 'ready');
    await exerciseCircle(fixture, manager, bridge, profileId);
    await exercisePageBatch(fixture, manager, bridge, profileId);
    await manager.importSession(profileId, { targetUrl: fixture.urls.a });
    await exerciseCandidate(fixture, manager, bridge);
    console.log('NATIVE_MODEL_SMOKE_PASSED');
  } finally {
    await manager.stopAll({ timeoutMs: 5000 });
  }
  app.exit(0);
}

if (process.versions.electron) {
  electronMain().catch((error) => { console.error(error); require('electron').app.exit(1); });
} else {
  runFixture().catch((error) => { console.error(error); process.exitCode = 1; });
}
