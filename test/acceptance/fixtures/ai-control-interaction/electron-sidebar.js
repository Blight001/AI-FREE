'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');

const fixture = JSON.parse(process.env.AI_FREE_INTERACTION_FIXTURE || 'null');
const phase = process.argv[2];
assert.ok(fixture && ['initial', 'reopen', 'continuation', 'native', 'managed'].includes(phase), 'Start via electron-sidebar.test.js');
app.setPath('userData', fixture.userData);
app.setPath('sessionData', fixture.userData);
app.setPath('desktop', fixture.desktop);

const appRoot = process.env.AI_FREE_INTERACTION_APP_ROOT || path.resolve(__dirname, '../../../../.generated/app/src/app');
const backend = path.join(appRoot, 'backend');
const ai = (file) => require(path.join(backend, 'features/ai-chat', file));
const { createIpcRegistry } = require(path.join(backend, 'ipc/registry'));
const { createAiChatHistoryRepository } = require(path.join(backend, 'lib/ai-chat-history'));
const { registerAiChatIpc } = ai('register-chat-ipc');
const { registerManagedChatIpc } = ai('register-managed-chat-ipc');
const { createManagedChatRepository } = require(path.join(backend, 'platform/managed-chat-repository'));
const { registerAiHistoryIpc } = ai('register-history-ipc');
const { registerAiSupportIpc } = ai('register-support-ipc');
const { createAiWorkspaceService } = ai('ai-workspace-service');

const CONNECTION = 'interaction-fixture';
const RED_PATH = 'source-red/sample.png';
const PROFILE_PATH = 'settings-profile.json';
const ARTIFACT = '.ai-chat-message-artifact';
const DOWNLOAD_PROMPT = 'Fetch red fixture';
const DOWNLOAD_ANSWER = 'The red fixture is ready.';
const DOWNLOAD_STEP = 'I will fetch the red fixture.';

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
      assert.equal(args.paths.length, 1);
      assert.ok([fixture.files.red.path, path.join(fixture.workspace, PROFILE_PATH)].includes(args.paths[0]));
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
    nextAction(action, args, answer, stage = '') {
      queue.push({ role: 'assistant', content: stage, tool_calls: [{ id: `fixture-tool-${++callId}`, type: 'function',
        function: { name: 'browser_file', arguments: JSON.stringify({ action, ...args }) } }] });
      if (answer) queue.push({ role: 'assistant', content: answer });
    },
  };
}

function wireSidebar({ bridge, model, connection }, window) {
  const ipc = createIpcRegistry(ipcMain, { source: 'ai-control-interaction' });
  const workspace = createAiWorkspaceService({ workspaceDir: fixture.workspace });
  const historyRepository = createAiChatHistoryRepository();
  const getCredentials = () => ({ username: 'fixture-account' });
  ipc.handle('account-get-session', () => ({ authenticated: true }));
  ipc.handle('set-sidebar-width', () => ({ ok: true, width: 430 }));
  const deps = { aiSandboxDir: fixture.workspace, browserAutomationBridge: bridge,
    readStoreConfigSafe: () => ({ userCredentials: { authType: 'account', username: 'fixture-account',
      sessionToken: ['afs', 'fixture-placeholder'].join('_'), deviceId: 'fixture-device', serverBase: fixture.origin } }),
    getGlobalHttpClient: () => model,
    getSideView: () => window,
    managedChatRepository: createManagedChatRepository({ directory: path.join(fixture.userData, 'test-managed-chat'), safeStorage }),
  };
  const getModels = () => ({ ok: true, models: [{ id: 'fixture-model', name: 'Fixture model' }], quota: { unlimited: true } });
  const managed = registerManagedChatIpc({ ipc, deps, getModels });
  registerAiChatIpc({ ...deps, ipc, getParentChatTools: managed?.getParentTools });
  registerAiHistoryIpc({ ipc, historyRepository, getCredentials });
  registerAiSupportIpc({ ipc, service: {
    getModels,
    getBrowserConnections: () => ({ ok: true, connections: [connection] }),
    getAutomationCards: () => ({ ok: true, cards: [] }),
    workspaceList: workspace.list, workspaceRead: workspace.read, broadcastBrowserSelection() {},
  } });
  return { ipc, managed, sessions: () => historyRepository.listSessions(getCredentials()).sessions,
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
  const setDraft = (text) => evaluate((value) => {
    const input = document.querySelector('#ai-chat-input');
    input.textContent = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  return { evaluate, click, until, has, visible, setDraft,
    async send(text) {
      await until(() => evaluate(() => document.querySelector('#ai-chat-send').ariaLabel === '发送消息'),
        'send button ready for a new turn');
      await setDraft(text);
      await click('#ai-chat-send');
    },
  };
}

async function checkDisclosureRotation(ui, selector, open) {
  await ui.until(() => ui.evaluate((css, expanded) => {
    const icon = document.querySelector(css + ' > .ai-chat-disclosure');
    if (!icon) return false;
    const transform = getComputedStyle(icon).transform;
    const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
    return Math.abs(matrix.a - (expanded ? 0 : 1)) < 0.01 && Math.abs(matrix.b - (expanded ? 1 : 0)) < 0.01;
  }, selector, open), 'fold icon rotation ' + selector);
}

async function checkFoldedDownloadProcess(ui) {
  const process = '.ai-chat-process';
  await ui.visible(`${process}:not([open]) > summary`, '用时');
  assert.equal(await ui.has('.ai-chat-step-answer', DOWNLOAD_STEP), false);
  assert.equal(await ui.has('.ai-chat-answer', DOWNLOAD_ANSWER), true);
  await checkDisclosureRotation(ui, '.ai-chat-process > summary', false);
  await ui.click('.ai-chat-process > summary');
  await checkDisclosureRotation(ui, '.ai-chat-process > summary', true);
  await ui.visible(`${process}[open] .ai-chat-step-answer`, DOWNLOAD_STEP);
  const group = '.ai-chat-process .ai-chat-activity:not([hidden]) > summary';
  const tool = '.ai-chat-process .ai-chat-tool > summary';
  await ui.visible(group, '1次工具调用');
  await ui.click(group);
  await checkDisclosureRotation(ui, group, true);
  await ui.click(tool);
  await checkDisclosureRotation(ui, tool, true);
  await ui.click(tool);
  await checkDisclosureRotation(ui, tool, false);
}

async function checkRawToolRotation(ui) {
  const row = '.ai-chat-message:has([data-tool-id="raw-fixture"])';
  await ui.evaluate(() => createAssistantView({
    content: 'Command fixture', durationMs: 1300, toolEvents: [{ id: 'raw-fixture', name: 'run_command', status: 'success' }],
  }).row.dataset.messageKind);
  for (const selector of ['.ai-chat-process', '.ai-chat-activity', '.ai-chat-tool']) {
    await ui.click(row + ' ' + selector + ' > summary');
  }
  const raw = row + ' .ai-chat-tool-raw > summary';
  await checkDisclosureRotation(ui, raw, false);
  await ui.click(raw);
  await checkDisclosureRotation(ui, raw, true);
  await ui.click(raw);
  await checkDisclosureRotation(ui, raw, false);
  await ui.evaluate((selector) => document.querySelector(selector).remove(), row);
}

async function initial(ui, doubles, history) {
  assert.equal(await ui.evaluate(() => Boolean(document.querySelector('#ai-chat-browser, #ai-chat-target'))), false);
  assert.equal(await ui.evaluate(() => Boolean(document.querySelector('#ai-chat-target-bind'))), false);
  assert.equal(doubles.targetLookups(), 0);
  doubles.tab.pageToken = 'a-document';
  doubles.nextAction('download', { url: fixture.origin + fixture.files.red.route }, DOWNLOAD_ANSWER, DOWNLOAD_STEP);
  await ui.send(DOWNLOAD_PROMPT);
  await checkFoldedDownloadProcess(ui);
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
  await checkRawToolRotation(ui);
}

async function continuation(ui, doubles) {
  const stop = '#ai-chat-send[aria-label="停止 AI 输出"]';
  const play = '#ai-chat-send[aria-label="继续 AI 输出"]';
  const send = '#ai-chat-send[aria-label="发送消息"]';
  const firstGroup = '.ai-chat-activity:has([data-tool-id="fixture-tool-1"])';
  const secondGroup = '.ai-chat-activity:has([data-tool-id="fixture-tool-2"])';
  const setClock = (time) => ui.evaluate((value) => { performance.now = () => value; }, time);
  await setClock(0);
  let hold = false;
  doubles.model.streamAIControlMessage = (key, device, model, messages, options, onEvent) => {
    if (!hold) return doubles.model.sendAIControlMessage(key, device, model, messages, options);
    hold = false;
    onEvent({ type: 'content_delta', delta: 'Partial fixture response' });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };

  doubles.tab.pageToken = 'a-document';
  doubles.nextAction('download', { url: fixture.origin + fixture.files.red.route }, DOWNLOAD_ANSWER);
  await ui.send(DOWNLOAD_PROMPT);
  await ui.visible('.ai-chat-answer', DOWNLOAD_ANSWER);
  await ui.click('.ai-chat-process > summary', '用时');
  await ui.visible(`${firstGroup}:not([open]) > summary`);
  await ui.click(`${firstGroup} > summary`);
  await ui.visible(`${firstGroup}[open] .ai-chat-tool > summary`);

  doubles.nextAction('download', { url: fixture.origin + fixture.files.red.route }, null, DOWNLOAD_STEP);
  const dispatch = doubles.bridge.dispatch;
  doubles.bridge.dispatch = async (...args) => {
    const result = await dispatch(...args);
    if (args[2].action === 'download') hold = true;
    return result;
  };
  await ui.send('Download again');
  await ui.visible('.ai-chat-answer', 'Partial fixture response');
  await ui.visible(`${secondGroup}:not([open]) > summary`);
  await ui.click(`${secondGroup} > summary`);
  await setClock(237000);
  await ui.click(stop);
  await ui.visible(play);
  assert.equal(await ui.has('.ai-chat-step-answer', DOWNLOAD_STEP), true);
  await ui.visible('.ai-chat-process > summary', '用时 3 分钟 57 秒');
  await setClock(297000);
  doubles.queue.push({ content: 'Continued from the tool result' });
  const sendModel = doubles.model.sendAIControlMessage;
  doubles.model.sendAIControlMessage = async (...args) => {
    await setClock(301000);
    return sendModel(...args);
  };
  await ui.click(play);
  await ui.visible('.ai-chat-answer', 'Continued from the tool result');
  await ui.visible('.ai-chat-process > summary', '用时 4 分钟 1 秒');
  assert.equal(await ui.has(`${firstGroup}[open] > summary`), true);
  assert.equal(await ui.has('.ai-chat-process[open] .ai-chat-step-answer', DOWNLOAD_STEP), true);
  assert.equal(await ui.has(`${secondGroup}[open] > summary`), true);
  assert.equal(await ui.has('.ai-chat-answer', 'Partial fixture response'), false);
  assert.equal(doubles.outcomes.length, 2);

  hold = true;
  await ui.send('Pause before editing the prompt');
  await ui.visible('.ai-chat-answer', 'Partial fixture response');
  await ui.click(stop);
  await ui.visible(play);
  await ui.setDraft('Follow-up message');
  await ui.visible(send);
  doubles.queue.push({ content: 'Answered the follow-up' });
  await ui.click(send);
  await ui.visible('.ai-chat-answer', 'Answered the follow-up');
  assert.equal(await ui.has('[data-message-kind="user-bubble"]', 'Follow-up message'), true);
}

async function reopen(ui, doubles) {
  await ui.visible('button[aria-label="新建对话"]');
  await ui.click('#ai-chat-history-trigger');
  await ui.visible('#ai-chat-history-menu button', DOWNLOAD_PROMPT);
  await checkHistoryLayout(ui);
  await ui.click('#ai-chat-history-menu button', DOWNLOAD_PROMPT);
  await checkFoldedDownloadProcess(ui);
  await ui.visible(ARTIFACT, RED_PATH);
  assert.equal(await ui.evaluate((css) => document.querySelectorAll(css).length, ARTIFACT), 1);
  await ui.click(`${ARTIFACT} button`, '再次引用');
  await ui.visible('.ai-chat-attachment-chip', 'sample.png');
  assert.equal(doubles.modelRequests(), 0);

  Object.assign(doubles.tab, { title: 'B - Upload target', url: fixture.urls.b, pageToken: 'b-document' });
  const profile = path.join(fixture.workspace, PROFILE_PATH);
  await fs.writeFile(profile, '{"theme":"dark"}');
  assert.equal(await ui.evaluate(() => document.querySelector('[aria-label="上传确认"]')), null);
  doubles.nextAction('upload', { path: PROFILE_PATH, selector: '#fixture-file' }, 'Profile selected.');
  await ui.send('Select the settings profile on B');
  await ui.visible('.ai-chat-answer', 'Profile selected.');
  assert.equal(doubles.outcomes.at(-1).uploadVerification, 'file_selected');
  assert.deepEqual(doubles.uploads, [{ target: doubles.tab.title, path: profile }]);
  doubles.nextAction('upload', { path: RED_PATH, selector: '#fixture-file' }, 'File selection checked.');
  await ui.send('Select the image on B');
  await ui.visible('.ai-chat-answer', 'File selection checked.');
  assert.equal(doubles.outcomes.at(-1).uploadVerification, 'file_selected');
  assert.deepEqual(doubles.uploads.map(({ path: uploaded }) => uploaded), [profile, fixture.files.red.path]);

  doubles.dropResult();
  const priorRequests = doubles.modelRequests();
  doubles.nextAction('upload', { path: RED_PATH, selector: '#fixture-file' });
  await ui.send('Lose the upload response');
  await ui.visible('.ai-chat-answer', '上传结果待核验');
  assert.equal(doubles.uploads.length, 3);
  assert.equal(doubles.modelRequests(), priorRequests + 1);

  await ui.click('#ai-chat-history-trigger');
  await ui.visible('#ai-chat-history-menu button', DOWNLOAD_PROMPT);
  await ui.click('button[aria-label="新建对话"]');
  await ui.visible('#ai-chat-history-value', '新对话');
  assert.equal(await ui.has('#ai-chat-history-menu'), false);
  assert.equal(await ui.has('.ai-chat-answer'), false);
}

async function checkHistoryLayout(ui) {
  const layout = await ui.evaluate((title) => {
    const trigger = document.querySelector('#ai-chat-history-trigger');
    const label = document.querySelector(`label[for="${trigger.id}"]`);
    const menu = document.querySelector('#ai-chat-history-menu');
    const entry = [...menu.querySelectorAll('[aria-selected]')].find((item) => item.innerText.includes(title));
    const time = [...entry.querySelectorAll('span')].find((item) => /^(刚刚|\d+ 分钟前)$/.test(item.textContent));
    const edit = entry.querySelector('button[aria-label="重命名对话"]');
    const create = document.querySelector('button[aria-label="新建对话"]');
    return {
      labelSize: getComputedStyle(label).fontSize,
      maxHeight: getComputedStyle(menu).maxHeight,
      showsCount: /\d+\s*条/.test(entry.innerText),
      timeBesideEdit: time?.getBoundingClientRect().right <= edit.getBoundingClientRect().left
        && Math.abs(time.getBoundingClientRect().top - edit.getBoundingClientRect().top) < 11,
      createBesideHistory: !menu.contains(create) && create.getBoundingClientRect().left >= trigger.getBoundingClientRect().right,
    };
  }, DOWNLOAD_PROMPT);
  assert.deepEqual(layout, {
    labelSize: '18px', maxHeight: '440px', showsCount: false, timeBesideEdit: true, createBesideHistory: true,
  });
}

async function exerciseRealSidebar(ui, history) {
  const prompt = 'QA DOWNLOAD RED';
  await ui.send(prompt);
  try {
    await ui.visible('.ai-chat-answer', 'The fixture sequence stopped.');
  } catch (error) {
    const results = history.sessions().flatMap(({ id }) => (history.readSession(id)?.messages || [])
      .filter(({ role }) => role === 'tool').map(({ name, content }) => {
        const { errorCode, error: message } = JSON.parse(content);
        return { name, errorCode, message };
      }));
    assert.fail(`${error.message}\nFixture tool outcomes: ${JSON.stringify(results)}`);
  }
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

function delegatedModel(messages, options) {
  if (!options.tools.length) return { ok: true, message: { content: 'Task review' } };
  if (!options.tools.some(({ name }) => name === 'chat_session')) {
    assert.deepEqual(options.tools.map(({ name }) => name), ['chat_previous_result']);
    return { ok: true, message: { content: 'Child report' } };
  }
  const outcomes = messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
  if (outcomes.length === 3) {
    assert.equal(outcomes[2].data.runs[0].result, 'Child report');
    return { ok: true, message: { content: 'Parent received the child report' } };
  }
  const actions = [
    { action: 'create', request_key: 'delegated-create', model_id: 'fixture-model', title: 'Model delegated' },
    { action: 'send', request_key: 'delegated-send', session_id: outcomes[0]?.data.sessionId, content: 'Review', wait_ms: 0 },
    { action: 'wait', run_ids: [outcomes[1]?.data.runId] },
  ];
  return { ok: true, message: { tool_calls: [{ id: `child-call-${outcomes.length}`, type: 'function',
    function: { name: 'chat_session', arguments: JSON.stringify(actions[outcomes.length]) } }] } };
}

async function managed(ui, doubles, history, window) {
  let resumed = false;
  doubles.model.streamAIControlMessage = (_key, _device, _model, messages, options, onEvent) => {
    if (resumed) {
      assert.ok(messages.some(({ content }) => content === 'Add a brief conclusion'));
      return { ok: true, message: { content: 'Final child result' } };
    }
    onEvent({ type: 'content_delta', delta: 'Live child output' });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  await ui.setDraft('Keep this parent draft');
  const parentId = await ui.evaluate(() => state.currentSession.id);
  const contents = window.webContents;
  const parent = history.managed.getParentTools({ sender: contents, senderFrame: contents.mainFrame }, { localInteraction: true, parentSessionId: parentId });
  const execute = (args) => parent.execute('chat_session', args);
  const created = await execute({ action: 'create', model_id: 'fixture-model', request_key: 'create', title: 'Review child' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = created.data.sessionId;
  const sent = await execute({ action: 'send', request_key: 'send', session_id: sessionId, content: 'Review draft', wait_ms: 0 });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await ui.visible('#ai-managed-parent-cards button', 'Review child');
  assert.equal(await ui.has('#ai-managed-chat'), false);
  await ui.click('#ai-managed-parent-cards button');
  await ui.visible('#ai-managed-messages', 'Live child output');
  await ui.evaluate(() => { document.querySelector('#ai-managed-input').value = 'Add a brief conclusion'; });
  await ui.click('#ai-managed-send');
  await ui.visible('#ai-managed-messages', 'Add a brief conclusion');
  await ui.click('#ai-managed-stop');
  await ui.visible('#ai-managed-resume');
  resumed = true;
  await ui.click('#ai-managed-resume');
  await ui.visible('#ai-managed-messages', 'Final child result');
  const result = await execute({ action: 'wait', run_id: sent.data.runId });
  assert.equal(result.data.result, 'Final child result');
  await ui.click('#ai-managed-back');
  assert.equal(await ui.evaluate(() => document.querySelector('#ai-chat-input').textContent), 'Keep this parent draft');
  assert.ok(history.sessions().every((session) => session.id !== sessionId));
  await window.loadFile(path.join(appRoot, 'frontend/sidebar/ai-control.html'));
  await ui.click('#ai-managed-tasks');
  await ui.visible('#ai-managed-directory button', 'Review child');
  await ui.click('#ai-managed-directory button', 'Review child');
  await ui.visible('#ai-managed-messages', 'Final child result');
  await ui.click('#ai-managed-back');
  doubles.model.streamAIControlMessage = (_key, _device, _model, messages, options) => delegatedModel(messages, options);
  await ui.send('Ask a child to review');
  await ui.visible('.ai-chat-answer', 'Parent received the child report');
  await ui.visible('#ai-managed-parent-cards button', 'Model delegated');
  await ui.click('.ai-chat-process > summary');
  await ui.click('.ai-chat-process .ai-chat-activity > summary');
  const childTool = '[data-tool-id="child-call-0"] > summary';
  await checkDisclosureRotation(ui, childTool, false);
  await ui.click(childTool);
  await checkDisclosureRotation(ui, childTool, true);
  await ui.click(childTool);
  await checkDisclosureRotation(ui, childTool, false);
}

async function main() {
  if (phase === 'native') return native();
  const doubles = createDoubles();
  await runSidebar(doubles, async (ui, history, window) => {
    if (phase === 'initial') await initial(ui, doubles, history);
    else if (phase === 'continuation') await continuation(ui, doubles);
    else if (phase === 'managed') await managed(ui, doubles, history, window);
    else await reopen(ui, doubles);
    assert.deepEqual(doubles.queue, []);
  });
}

async function runSidebar(wiring, exercise) {
  const window = new BrowserWindow({ width: 430, height: 860, show: false, webPreferences: {
    preload: path.join(backend, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  const history = wireSidebar(wiring, window);
  try {
    await window.loadFile(path.join(appRoot, 'frontend/sidebar/ai-control.html'));
    const ui = driver(window.webContents);
    await ui.until(() => ui.evaluate(() => document.querySelector('#ai-chat-model').value === 'fixture-model'), 'sidebar model');
    await exercise(ui, history, window);
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
