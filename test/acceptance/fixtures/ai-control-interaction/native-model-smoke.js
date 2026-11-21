'use strict';

const assert = require('node:assert/strict');
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
    assert.match(result.output, /NATIVE_MODEL_SMOKE_PASSED/);
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
    let approval = null;
    const event = { sender: { id: 1, isDestroyed: () => false, send(_channel, message) {
      if (message.type !== 'upload_confirmation') return;
      approval = message;
      service.decide(event, { requestId, id: message.id, accepted: true });
    } } };
    const result = await service.chat(event, { requestId, modelId: CUSTOM_AI_MODEL_ID, stream: true, localInteraction: true,
      messages: [{ role: 'user', content: prompt }], attachmentPaths: options.paths, artifactReferences: options.artifacts,
      browserConnectionId,
    });
    assert.equal(result.ok, true, result.message);
    return { result, approval };
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
  const { result: selected, approval } = await chat('QA SELECT B', { paths: [artifact.path], artifacts: [artifact] });
  assert.deepEqual(approval?.files, [artifact.path], `${selected.message.content} ${JSON.stringify(selected.message.tool_events)}`);
  const state = await selectedState(fixture);
  assert.equal(state.b.lastSelected.sha256, artifact.sha256);
  assert.equal(state.b.receivedCount, 0);
  assert.equal(state.c.selectionCount, 0);
  const { result: observed } = await chat('QA OBSERVE B');
  assert.match(observed.message.content, /Receipt idle, readback verified, displayed received count 0/, JSON.stringify(observed.messages).slice(-5000));
  const { result: command } = await chat('QA COMMAND TIMEOUT');
  assert.match(command.message.content, /command timed out/);
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
