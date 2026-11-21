'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, ipcMain } = require('electron');

const fixture = JSON.parse(process.env.AI_FREE_INTERACTION_FIXTURE || 'null');
const phase = process.argv[2];
assert.ok(fixture && ['initial', 'reopen', 'native'].includes(phase), 'Start via electron-sidebar.test.js');
app.setPath('userData', fixture.userData);
app.setPath('sessionData', fixture.userData);
app.setPath('desktop', fixture.desktop);

const appRoot = path.resolve(__dirname, '../../../../.generated/app/src/app');
const backend = path.join(appRoot, 'backend');
const ai = (file) => require(path.join(backend, 'features/ai-chat', file));
const { createIpcRegistry } = require(path.join(backend, 'ipc/registry'));
const { createAiChatHistoryRepository } = require(path.join(backend, 'lib/ai-chat-history'));
const { registerAiChatIpc } = ai('register-chat-ipc');
const { registerAiHistoryIpc } = ai('register-history-ipc');
const { registerAiSupportIpc } = ai('register-support-ipc');
const { createAiWorkspaceService } = ai('ai-workspace-service');

const CONNECTION = 'interaction-fixture';
const RED_PATH = 'source-red/sample.png';
const ARTIFACT = '.ai-chat-message-artifact';
const APPROVAL = '#ai-chat-upload-confirmation';
const DOWNLOAD_PROMPT = 'Fetch red fixture';
const DOWNLOAD_ANSWER = 'The red fixture is ready.';

function createDoubles() {
  const tab = { title: 'A - Source', url: fixture.urls.a, pageToken: '' };
  const tools = ['browser_tab', 'browser_file'].map((name) => ({ name, description: name,
    input_schema: { type: 'object', properties: { action: { type: 'string' }, path: { type: 'string' } } } }));
  const connection = { id: CONNECTION, name: 'Fixture Chromium', tools };
  const queue = [];
  const outcomes = [];
  const uploads = [];
  let callId = 0;
  let modelRequests = 0;
  let targetLookups = 0;
  let loseUploadResult = false;
  const bridge = {
    listConnections: () => [connection],
    getConnection: (id) => id === CONNECTION ? connection : null,
    async dispatch(id, tool, args, options) {
      assert.equal(id, CONNECTION);
      if (tool === 'browser_tab' && args.action === 'list') {
        targetLookups++;
        return tab.pageToken ? { activeTab: { ...tab } } : { activeTab: { title: tab.title, url: tab.url } };
      }
      assert.equal(tool, 'browser_file');
      if (options.expectedPageToken !== tab.pageToken) {
        return { success: false, actionExecuted: false, errorCode: 'BROWSER_TARGET_CHANGED', error: 'Target document changed' };
      }
      if (args.action === 'download') {
        assert.equal(tab.pageToken, 'a-document');
        const bytes = await fs.readFile(fixture.files.red.path);
        return { success: true, action: 'download', relative_path: RED_PATH, size: bytes.length, sha256: fixture.files.red.sha256 };
      }
      assert.equal(args.action, 'upload');
      assert.equal(options.expectedPageToken, 'b-document');
      assert.deepEqual(args.paths, [fixture.files.red.path]);
      uploads.push({ target: tab.title, path: args.paths[0] });
      if (loseUploadResult) throw new Error('Fixture transport lost the upload result');
      return { success: true, action: 'upload' };
    },
  };
  const model = {
    async sendAIControlMessage(_key, _device, _model, messages, { tools }) {
      // A finished turn also requests a title through the tool-free model path.
      if (!tools.length) return { ok: true, message: { role: 'assistant', content: DOWNLOAD_PROMPT } };
      modelRequests++;
      const last = messages.at(-1);
      if (last?.role === 'tool') outcomes.push(JSON.parse(last.content));
      assert.ok(queue.length, 'Model received an unexpected request or attempted to replay a tool');
      return { ok: true, message: queue.shift() };
    },
  };
  return { tab, bridge, connection, queue, outcomes, uploads, model,
    modelRequests: () => modelRequests,
    targetLookups: () => targetLookups,
    dropResult: () => { loseUploadResult = true; },
    nextAction(action, args, answer) {
      queue.push({ role: 'assistant', content: '', tool_calls: [{ id: `fixture-tool-${++callId}`, type: 'function',
        function: { name: 'browser_file', arguments: JSON.stringify({ action, ...args }) } }] });
      if (answer) queue.push({ role: 'assistant', content: answer });
    },
  };
}

function wireSidebar({ bridge, model, connection }) {
  const ipc = createIpcRegistry(ipcMain, { source: 'ai-control-interaction' });
  const workspace = createAiWorkspaceService({ workspaceDir: fixture.workspace });
  const historyRepository = createAiChatHistoryRepository();
  const getCredentials = () => ({ username: 'fixture-account' });
  ipc.handle('account-get-session', () => ({ authenticated: true }));
  ipc.handle('set-sidebar-width', () => ({ ok: true, width: 430 }));
  registerAiChatIpc({ ipc, aiSandboxDir: fixture.workspace, browserAutomationBridge: bridge,
    readStoreConfigSafe: () => ({ userCredentials: { sessionToken: 'fixture-placeholder', deviceId: 'fixture-device' } }),
    getGlobalHttpClient: () => model,
  });
  registerAiHistoryIpc({ ipc, historyRepository, getCredentials });
  registerAiSupportIpc({ ipc, service: {
    getModels: () => ({ ok: true, models: [{ id: 'fixture-model', name: 'Fixture model' }], quota: { unlimited: true } }),
    getBrowserConnections: () => ({ ok: true, connections: [connection] }),
    getAutomationCards: () => ({ ok: true, cards: [] }),
    workspaceList: workspace.list, workspaceRead: workspace.read, broadcastBrowserSelection() {},
  } });
  return { ipc, sessions: () => historyRepository.listSessions(getCredentials()).sessions,
    readSession: (id) => historyRepository.getSession(getCredentials(), id).session };
}

function driver(contents) {
  const evaluate = (code, ...args) => contents.executeJavaScript(`(${code})(...${JSON.stringify(args)})`);
  const click = (selector, text = '') => evaluate((css, label) => {
    const element = Array.from(document.querySelectorAll(css))
      .find((node) => (!label || node.textContent.includes(label)) && node.getClientRects().length);
    if (!element || element.disabled) throw new Error(`Control unavailable: ${css} ${label}`);
    element.click();
  }, selector, text);
  async function until(condition, description, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await delay(25);
    }
    const sidebar = await evaluate(() => document.body.innerText.slice(-1600));
    assert.fail(`Timed out waiting for ${description}\n${sidebar}`);
  }
  const has = (selector, text = '') => evaluate((css, value) => Array.from(document.querySelectorAll(css))
    .some((node) => node.getClientRects().length && node.textContent.includes(value)), selector, text);
  const visible = (selector, text) => until(() => has(selector, text), `${selector} ${text || ''}`);
  return { evaluate, click, until, has, visible,
    async send(text) {
      await until(() => evaluate(() => document.querySelector('#ai-chat-send').ariaLabel === '发送消息'),
        'send button ready for a new turn');
      await evaluate((value) => {
        const input = document.querySelector('#ai-chat-input');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, text);
      await click('#ai-chat-send');
    },
  };
}

async function initial(ui, doubles, history) {
  assert.equal(await ui.evaluate(() => Boolean(document.querySelector('#ai-chat-browser, #ai-chat-target'))), false);
  assert.equal(await ui.evaluate(() => Boolean(document.querySelector('#ai-chat-target-bind'))), false);
  assert.equal(doubles.targetLookups(), 0);
  doubles.tab.pageToken = 'a-document';
  doubles.nextAction('download', { url: fixture.origin + fixture.files.red.route }, DOWNLOAD_ANSWER);
  await ui.send(DOWNLOAD_PROMPT);
  await ui.visible('.ai-chat-answer', DOWNLOAD_ANSWER);
  assert.equal(doubles.modelRequests(), 2);
  assert.equal(doubles.targetLookups(), 1);
  await ui.visible(ARTIFACT, RED_PATH);
  await ui.click(`${ARTIFACT} button`, '预览');
  await ui.until(() => ui.evaluate(() => document.querySelector('#ai-chat-workspace-preview-body img')?.naturalWidth === 96), 'decoded PNG preview');
  await ui.click('#ai-chat-workspace-preview-close');
  await ui.until(() => history.sessions().some(({ id }) => {
    const session = history.readSession(id);
    return session?.titleGenerated && session.messages.some((message) =>
      message.artifacts?.some((artifact) => artifact.sha256 === fixture.files.red.sha256));
  }), 'persisted title and artifact digest');
}

async function approval(ui, doubles, title, message, answer) {
  doubles.nextAction('upload', { path: RED_PATH, selector: '#fixture-file' }, answer);
  await ui.send(message);
  await ui.visible(APPROVAL, title);
  await ui.visible(APPROVAL, RED_PATH);
}

async function reopen(ui, doubles) {
  await ui.click('#ai-chat-history-trigger');
  await ui.visible('#ai-chat-history-menu button', DOWNLOAD_PROMPT);
  await ui.click('#ai-chat-history-menu button', DOWNLOAD_PROMPT);
  await ui.visible('.ai-chat-answer', DOWNLOAD_ANSWER);
  await ui.visible(ARTIFACT, RED_PATH);
  assert.equal(await ui.evaluate((css) => document.querySelectorAll(css).length, ARTIFACT), 1);
  await ui.click(`${ARTIFACT} button`, '再次引用');
  await ui.visible('.ai-chat-attachment-chip', 'sample.png');
  assert.equal(doubles.modelRequests(), 0);

  Object.assign(doubles.tab, { title: 'B - Upload target', url: fixture.urls.b, pageToken: 'b-document' });
  await approval(ui, doubles, doubles.tab.title, 'Cancel the upload', 'Upload cancelled.');
  assert.equal(doubles.uploads.length, 0);
  await ui.click('#ai-chat-confirmation-cancel');
  await ui.visible('.ai-chat-answer', 'Upload cancelled.');
  assert.equal(doubles.outcomes.at(-1).errorCode, 'UPLOAD_NOT_CONFIRMED');
  assert.equal(doubles.uploads.length, 0);

  await approval(ui, doubles, doubles.tab.title, 'Replace the document during approval', 'Target checked.');
  doubles.tab.pageToken = 'b-replacement-document';
  await ui.click('#ai-chat-confirmation-accept');
  await ui.visible('.ai-chat-answer', 'Target checked.');
  assert.equal(doubles.outcomes.at(-1).errorCode, 'BROWSER_TARGET_CHANGED');
  assert.equal(doubles.uploads.length, 0);

  doubles.tab.pageToken = 'b-document';
  await approval(ui, doubles, doubles.tab.title, 'Select the file on B', 'File selection checked.');
  await ui.click('#ai-chat-confirmation-accept');
  await ui.visible('.ai-chat-answer', 'File selection checked.');
  assert.equal(doubles.outcomes.at(-1).uploadVerification, 'file_selected');
  assert.deepEqual(doubles.uploads, [{ target: doubles.tab.title, path: fixture.files.red.path }]);

  doubles.dropResult();
  const priorRequests = doubles.modelRequests();
  await approval(ui, doubles, doubles.tab.title, 'Lose the upload response');
  await ui.click('#ai-chat-confirmation-accept');
  await ui.visible('.ai-chat-answer', '上传结果待核验');
  assert.equal(doubles.uploads.length, 2);
  assert.equal(doubles.modelRequests(), priorRequests + 1);
}

async function exerciseRealSidebar(ui, history) {
  const prompt = 'QA DOWNLOAD RED';
  await ui.send(prompt);
  await ui.visible('.ai-chat-answer', 'The fixture sequence stopped.');
  assert.equal(await ui.has(ARTIFACT), false);
  await ui.until(() => history.sessions().some(({ id }) => history.readSession(id)?.messages.some((message) =>
    message.role === 'tool' && message.name === 'browser_control' && message.content.includes('BROWSER_TARGET_CHANGED'))),
  'persisted target mismatch');

  await ui.send(prompt);
  await ui.until(() => ui.has(ARTIFACT, 'sample.png'), 'native download card', 14000);
  await ui.click(`${ARTIFACT} button`, '预览');
  await ui.until(() => ui.evaluate(() => document.querySelector('#ai-chat-workspace-preview-body img')?.naturalWidth === 96),
    'decoded download preview');
  await ui.until(() => history.sessions().some(({ id }) => history.readSession(id)?.messages.some((message) =>
    message.artifacts?.some((artifact) => artifact.sha256 === fixture.files.red.sha256))), 'persisted download digest');
}

async function native() {
  const { createBrowserRuntimeManager } = require(path.join(backend, 'browser-runtime'));
  const { createNativeBrowserAutomation } = require(path.join(backend, 'services/native-browser-automation'));
  const { createBrowserDownloadService } = require(path.join(backend, 'services/browser-download-service'));
  const { sendCustomAIControlMessage } = require(path.join(backend, 'services/custom-ai-api'));
  const host = new BrowserWindow({ width: 900, height: 650 });
  const manager = createBrowserRuntimeManager({ userDataDir: fixture.userData, sandboxDir: fixture.workspace,
    resourcesPath: path.resolve(__dirname, '../../../../resources'), getParentWindow: () => host, logger: console });
  try {
    const profileId = 'interaction-native-sidebar';
    const runtime = await manager.launchProfile({ profileId, runtimeType: 'chromium', initialUrl: 'about:blank' },
      { x: 0, y: 0, width: 850, height: 590 });
    assert.equal(runtime.status, 'ready');
    await manager.importSession(profileId, { targetUrl: fixture.urls.a });
    const bridge = createNativeBrowserAutomation({ browserRuntimeManager: manager, workspaceDir: fixture.workspace,
      browserDownloadService: createBrowserDownloadService({ sandboxDir: fixture.workspace }) });
    let reloaded = false;
    const model = {
      async sendAIControlMessage(_key, _device, _model, messages, { tools }) {
        const result = await sendCustomAIControlMessage({ enabled: true, baseUrl: fixture.urls.model,
          apiKey: fixture.model.apiKey, model: fixture.model.id }, messages, { tools });
        if (!reloaded && result.message?.tool_calls?.[0]?.function?.name === 'browser_control') {
          await manager.reload(profileId, 'chromium');
          reloaded = true;
        }
        return result;
      },
    };
    const wiring = { bridge, connection: bridge.listConnections()[0], model };
    await runSidebar(wiring, exerciseRealSidebar);
  } finally {
    await manager.stopAll({ timeoutMs: 5000 });
    host.destroy();
  }
}

async function main() {
  if (phase === 'native') return native();
  const doubles = createDoubles();
  await runSidebar(doubles, async (ui, history) => {
    if (phase === 'initial') await initial(ui, doubles, history);
    else await reopen(ui, doubles);
    assert.deepEqual(doubles.queue, []);
  });
}

async function runSidebar(wiring, exercise) {
  const history = wireSidebar(wiring);
  const window = new BrowserWindow({ width: 430, height: 860, show: false, webPreferences: {
    preload: path.join(backend, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  try {
    await window.loadFile(path.join(appRoot, 'frontend/sidebar/ai-control.html'));
    const ui = driver(window.webContents);
    await ui.until(() => ui.evaluate(() => document.querySelector('#ai-chat-model').value === 'fixture-model'), 'sidebar model');
    await exercise(ui, history);
    console.log(`SIDEBAR_INTERACTION_PASSED ${phase}`);
  } finally {
    window.destroy();
    history.ipc.dispose();
  }
}

app.whenReady().then(main).then(() => app.exit(0)).catch((error) => {
  console.error(error);
  app.exit(1);
});
