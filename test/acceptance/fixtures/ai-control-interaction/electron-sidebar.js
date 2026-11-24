'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');

const fixture = JSON.parse(process.env.AI_FREE_INTERACTION_FIXTURE || 'null');
const phase = process.argv[2];
assert.ok(fixture && ['initial', 'reopen', 'continuation', 'scroll', 'pause-thinking', 'native', 'managed', 'native-managed'].includes(phase), 'Start via electron-sidebar.test.js');
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
const ARTIFACT = '.ai-chat-download-card';
const DOWNLOAD_PROMPT = 'Fetch red fixture';
const DOWNLOAD_ANSWER = 'The red fixture is ready.';
const DOWNLOAD_STEP = 'I will fetch the red fixture.';

function createDoubles() {
  const tab = { title: 'A - Source', url: fixture.urls.a, pageToken: '' };
  const tools = ['browser_tab', 'browser_file', 'browser_screenshot'].map((name) => ({ name, description: name,
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
      if (options.expectedPageToken !== tab.pageToken) {
        return { success: false, actionExecuted: false, errorCode: 'BROWSER_TARGET_CHANGED', error: 'Target document changed' };
      }
      if (tool === 'browser_screenshot') {
        const bytes = await fs.readFile(fixture.files.red.path);
        return { success: true, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
      }
      assert.equal(tool, 'browser_file');
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
      const { quotaUsed, ...message } = queue.shift();
      return { ok: true, message, quota_cost_increment: quotaUsed };
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
  const getModels = () => ({ ok: true, quota: { unlimited: true }, models: [
    { id: 'fixture-model', name: 'Fixture model' },
    { id: 'fixture-child-model', name: 'Fixture child model' },
  ] });
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

async function checkDisclosureRotation(ui, selector, open, marker = '.ai-chat-disclosure') {
  await ui.until(() => ui.evaluate((css, expanded, markerSelector) => {
    const icon = document.querySelector(`${css} > ${markerSelector}`);
    if (!icon) return false;
    const transform = getComputedStyle(icon).transform;
    const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
    return Math.abs(matrix.a - (expanded ? 0 : 1)) < 0.01 && Math.abs(matrix.b - (expanded ? 1 : 0)) < 0.01;
  }, selector, open, marker), 'fold icon rotation ' + selector);
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
  await ui.visible(`#ai-chat-downloads ${ARTIFACT}`, 'sample.png');
  assert.ok(await ui.evaluate(() => document.querySelector('#ai-chat-downloads').getBoundingClientRect().bottom
    <= document.querySelector('#ai-chat-form').getBoundingClientRect().top));
  await ui.click(`${ARTIFACT} button`, 'sample.png');
  await ui.until(() => ui.evaluate(() => document.querySelector('#ai-chat-workspace-preview-body img')?.naturalWidth === 96), 'decoded PNG preview');
  await ui.click('#ai-chat-workspace-preview-tools [aria-label="放大图片"]');
  await ui.visible('#ai-chat-workspace-preview-tools', '125%');
  assert.ok(await ui.evaluate(() => document.querySelector('#ai-chat-workspace-preview-body img').clientWidth > 96));
  await ui.click('#ai-chat-workspace-preview-tools [aria-label="恢复适应窗口"]');
  await ui.visible('#ai-chat-workspace-preview-tools', '100%');
  await ui.click('#ai-chat-workspace-preview-close');
  await ui.until(() => history.sessions().some(({ id }) => {
    const session = history.readSession(id);
    return session?.titleGenerated && session.messages.some((message) =>
      message.artifacts?.some((artifact) => artifact.sha256 === fixture.files.red.sha256));
  }), 'persisted title and artifact digest');
  await checkRawToolRotation(ui);
  await checkInlineScreenshot(ui, doubles, history);
}

async function checkInlineScreenshot(ui, doubles, history) {
  doubles.queue.push({ role: 'assistant', tool_calls: [{ id: 'live-screenshot', type: 'function',
    function: { name: 'browser_screenshot', arguments: '{}' } }] });
  doubles.model.streamAIControlMessage = (key, device, model, messages, options) => {
    if (!messages.some((message) => message.ai_free_transient_image)) {
      return doubles.model.sendAIControlMessage(key, device, model, messages, options);
    }
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  await ui.send('Capture the page');
  await ui.until(() => ui.evaluate(() => document.querySelector('.ai-chat-screenshot img')?.naturalWidth === 96), 'automatic screenshot while model is still running');
  await ui.until(() => ui.evaluate(() => {
    const screenshot = document.querySelector('.ai-chat-screenshot[data-tool-call-id="live-screenshot"]');
    const tool = document.querySelector('.ai-chat-tool[data-tool-id="live-screenshot"]');
    return screenshot?.previousElementSibling === tool && screenshot.parentElement === tool?.parentElement;
  }), 'screenshot immediately below its MCP call');
  await ui.click('.ai-chat-screenshot');
  await ui.visible('#ai-chat-workspace-preview-title', '浏览器截图');
  await ui.click('#ai-chat-workspace-preview-close');
  await ui.click('#ai-chat-send[aria-label="停止 AI 输出"]');
  await ui.visible('#ai-chat-send[aria-label="继续 AI 输出"]');
  const savedSession = history.sessions().map((summary) => ({
    ...summary, session: history.readSession(summary.id),
  })).find(({ session }) => session?.messages.some((message) =>
    message.artifacts?.some((artifact) => artifact.toolCallId === 'live-screenshot')));
  assert.ok(savedSession, 'screenshot reference is persisted in chat history');
  const savedArtifact = savedSession.session.messages.flatMap((message) => message.artifacts || [])
    .find((artifact) => artifact.toolCallId === 'live-screenshot');
  assert.equal(savedArtifact.path.startsWith('Chat Screenshots/'), true);
  assert.ok((await fs.stat(path.join(fixture.workspace, savedArtifact.path))).size > 0);
  await ui.click('button[aria-label="新建对话"]');
  await ui.click('#ai-chat-history-trigger');
  await ui.visible('#ai-chat-history-menu button', savedSession.title);
  await ui.click('#ai-chat-history-menu button', savedSession.title);
  await ui.until(() => ui.evaluate(() => {
    const screenshot = document.querySelector('.ai-chat-screenshot[data-tool-call-id="live-screenshot"] img');
    const tool = document.querySelector('.ai-chat-tool[data-tool-id="live-screenshot"]');
    return screenshot?.naturalWidth === 96 && screenshot.parentElement?.previousElementSibling === tool;
  }), 'historical screenshot restored under its MCP call');
  assert.equal(await ui.evaluate((artifactPath) => Array.from(document.querySelectorAll('.ai-chat-download-card'))
    .some((card) => card.textContent.includes(artifactPath)), savedArtifact.path), false);
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
  await ui.visible('.ai-chat-turn-duration', '用时 3 分钟 57 秒');
  assert.equal(await ui.has(`${secondGroup}[open] > summary`), true);
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

async function pauseThinking(ui, doubles) {
  const thinking = '.ai-chat-thinking > summary';
  const activity = '.ai-chat-activity > summary';
  const stop = '#ai-chat-send[aria-label="停止 AI 输出"]';
  const play = '#ai-chat-send[aria-label="继续 AI 输出"]';
  const delta = 'Paused thinking remains visible';
  doubles.model.streamAIControlMessage = (_key, _device, _model, _messages, options, onEvent) => {
    onEvent({ type: 'reasoning_delta', delta });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  await ui.send('Stop while thinking');
  await ui.visible('.ai-chat-thinking-text', delta);
  await ui.setDraft('Keep this inserted message');
  await ui.click('#ai-chat-send[aria-label="插入当前对话"]');
  await ui.visible('.ai-chat-bubble', 'Keep this inserted message');
  await ui.click(stop);
  await ui.visible(play);
  await ui.visible('.ai-chat-turn-duration', '用时');
  assert.equal(await ui.has('.ai-chat-thinking-text', delta), true);
  assert.equal(await ui.has('[data-message-kind="user-bubble"] + [data-message-kind="assistant-turn"] .ai-chat-thinking-text', delta), true);
  await checkDisclosureRotation(ui, activity, true, '.ai-chat-activity-arrow');
  await checkDisclosureRotation(ui, thinking, true, '.ai-chat-thinking-mark');
  await ui.click(thinking);
  await checkDisclosureRotation(ui, thinking, false, '.ai-chat-thinking-mark');
  await ui.click(activity);
  await checkDisclosureRotation(ui, activity, false, '.ai-chat-activity-arrow');
  doubles.model.streamAIControlMessage = () => ({ ok: true, message: { content: 'Completed after pause' } });
  await ui.click(play);
  await ui.visible('.ai-chat-answer', 'Completed after pause');
  await ui.visible('#ai-chat-send[aria-label="发送消息"]');
  assert.equal(await ui.has('.ai-chat-thinking-text', delta), false);
}

async function followCollapsingThinking(ui) {
  await ui.evaluate(() => {
    const list = document.querySelector('#ai-chat-message-list');
    const fixture = document.createElement('div');
    fixture.id = 'scroll-fixture';
    fixture.style.height = '1600px';
    list.append(fixture);
  });
  const isFollowing = () => ui.evaluate(() => {
    const view = document.querySelector('#ai-chat-messages');
    return view.scrollHeight - view.clientHeight - view.scrollTop <= 4;
  });
  await ui.until(isFollowing, 'follow expanded thinking');
  const scroll = await ui.evaluate(async () => {
    const view = document.querySelector('#ai-chat-messages');
    const fixture = document.querySelector('#scroll-fixture');
    const before = view.scrollTop;
    fixture.style.height = '100px';
    const clamped = view.scrollTop;
    fixture.style.height = '1900px';
    return { before, clamped };
  });
  assert.ok(scroll.clamped < scroll.before);
  await ui.until(isFollowing, 'follow final reply after thinking collapses');
  await ui.evaluate(() => { document.querySelector('#ai-chat-messages').scrollTop = 50; });
  await ui.visible('#ai-chat-jump-bottom');
  await ui.evaluate(() => { document.querySelector('#scroll-fixture').style.height = '2200px'; });
  await ui.until(() => ui.evaluate(() => document.querySelector('#ai-chat-messages').scrollTop === 50), 'preserve manual scroll position');
  await ui.click('#ai-chat-jump-bottom');
  await ui.until(isFollowing, 'follow again after jumping to bottom');
  await ui.evaluate(() => { document.querySelector('#scroll-fixture').remove(); });
}

async function reopen(ui, doubles) {
  await ui.visible('button[aria-label="新建对话"]');
  await ui.click('#ai-chat-history-trigger');
  await ui.visible('#ai-chat-history-menu button', DOWNLOAD_PROMPT);
  await checkHistoryLayout(ui);
  await ui.click('#ai-chat-history-menu button', DOWNLOAD_PROMPT);
  await checkFoldedDownloadProcess(ui);
  await ui.visible(ARTIFACT, 'sample.png');
  assert.equal(await ui.evaluate((css) => document.querySelectorAll(css).length, ARTIFACT), 1);
  await ui.click(`${ARTIFACT} button[aria-label^="再次引用"]`);
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
  await ui.click(`${ARTIFACT} button`, 'sample.png');
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
    const delegated = phase === 'native-managed';
    const connection = bridge.listConnections()[0];
    const model = {
      async sendAIControlMessage(_key, _device, _model, messages, { tools }) {
        if (delegated && (!tools.length || tools.some(({ name }) => name === 'chat_session'))) {
          return delegatedModel(messages, { tools }, { connectionId: connection.id, prompt: 'QA DOWNLOAD RED',
            expected: 'The fixture download tool completed. Open the PNG card to verify the image and its source.' });
        }
        const result = await sendCustomAIControlMessage({ enabled: true, baseUrl: fixture.urls.model,
          apiKey: fixture.model.apiKey, model: fixture.model.id }, messages, { tools });
        if (!delegated && !reloaded && result.message?.tool_calls?.[0]?.function?.name === 'browser_control') {
          await manager.reload(profileId, 'chromium');
          reloaded = true;
        }
        return result;
      },
    };
    const wiring = { bridge, connection, model };
    await runSidebar(wiring, delegated ? exerciseNativeDelegation : exerciseRealSidebar);
  } finally {
    await manager.stopAll({ timeoutMs: 5000 });
    host.destroy();
  }
}

async function exerciseNativeDelegation(ui) {
  await ui.send('Ask a child to review');
  await ui.until(() => ui.has('.ai-chat-answer', 'Parent received the child report'), 'native child result', 18000);
  const received = await fs.readFile(path.join(fixture.workspace, 'qa-download-red/sample.png'));
  assert.deepEqual(received, await fs.readFile(fixture.files.red.path));
  await ui.click('#ai-managed-parent-cards button', 'Model delegated');
  await ui.visible('#ai-managed-messages .ai-chat-answer', 'The fixture download tool completed.');
  await ui.visible('#ai-managed-messages .ai-chat-turn-duration, #ai-managed-messages .ai-chat-process', '用时');
  await ui.click('#ai-managed-messages .ai-chat-process > summary');
  await ui.click('#ai-managed-messages .ai-chat-activity > summary');
  await ui.visible('#ai-managed-messages [data-tool-id]');
  await ui.visible(`#ai-managed-downloads ${ARTIFACT}`, 'sample.png');
  await ui.click(`#ai-managed-downloads ${ARTIFACT} button`, 'sample.png');
  await ui.until(() => ui.evaluate(() => document.querySelector('#ai-chat-workspace-preview-body img')?.naturalWidth === 96),
    'child download preview');
  await ui.click('#ai-chat-workspace-preview-close');
  await ui.click('#ai-managed-back');
  await ui.visible('.ai-chat-answer', 'Parent received the child report');
}

function delegatedModel(messages, options, { connectionId = CONNECTION, prompt = 'Review', expected = 'Child report' } = {}) {
  if (!options.tools.length) return { ok: true, message: { content: 'Task review' } };
  if (!options.tools.some(({ name }) => name === 'chat_session')) {
    const names = options.tools.map(({ name }) => name);
    assert.ok(names.includes('browser_file'));
    assert.ok(names.includes('chat_previous_result'));
    assert.ok(!names.includes('manage_card'));
    const receipt = messages.find(({ tool_call_id }) => tool_call_id === 'child-download');
    if (receipt) {
      assert.equal(JSON.parse(receipt.content).relative_path, RED_PATH);
      return { ok: true, message: { content: 'Child report' } };
    }
    return { ok: true, message: { tool_calls: [{ id: 'child-download', type: 'function',
      function: { name: 'browser_file', arguments: JSON.stringify({ action: 'download', url: fixture.urls.red }) } }] } };
  }
  const outcomes = messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
  if (outcomes.length === 3) {
    assert.equal(outcomes[2].data.runs[0].result, expected);
    return { ok: true, message: { content: 'Parent received the child report' } };
  }
  const actions = [
    { action: 'create', request_key: 'delegated-create', model_id: 'fixture-model', title: 'Model delegated' },
    { action: 'send', request_key: 'delegated-send', session_id: outcomes[0]?.data.sessionId, content: prompt, browser_connection: connectionId, wait_ms: 0 },
    { action: 'wait', run_ids: [outcomes[1]?.data.runId] },
  ];
  return { ok: true, message: { tool_calls: [{ id: `child-call-${outcomes.length}`, type: 'function',
    function: { name: 'chat_session', arguments: JSON.stringify(actions[outcomes.length]) } }] } };
}

async function assertChildReadOnly(ui, sessionId, runId) {
  await ui.visible('#ai-managed-model', '模型：Fixture child model');
  assert.equal(await ui.evaluate(() => document.querySelector('#ai-managed-chat')
    .querySelector('form, textarea, input, select, [contenteditable="true"], [aria-haspopup="listbox"]') !== null), false);
  const attempts = [
    { action: 'create', model_id: 'fixture-model', request_key: 'sidebar-create' },
    { action: 'select_model', session_id: sessionId, model_id: 'fixture-model' },
    { action: 'send', session_id: sessionId, request_key: 'sidebar-send', content: 'Direct send' },
    { action: 'insert', run_id: runId, request_key: 'sidebar-insert', content: 'Direct insert' },
    { action: 'stop', run_id: runId },
    { action: 'resume', run_id: runId },
  ];
  for (const args of attempts) {
    const result = await ui.evaluate((request) => window.aiFree.ai.managedChat({ ...request, wait_ms: 0 }), args);
    assert.equal(result.error?.code, 'CHAT_SIDEBAR_READ_ONLY', args.action);
    assert.equal(result.error?.retryable, false, args.action);
  }
}

async function checkPointsDisplay(ui, selector, integer, decimal) {
  await ui.until(() => ui.evaluate((css, display, exact) => {
    const counter = document.querySelector(css);
    const icon = counter?.querySelector('svg');
    return counter?.getClientRects().length && counter.textContent.trim() === display
      && counter.title === `已消耗 ${exact} 积分` && icon?.getBBox().width > 0;
  }, selector, integer, decimal), `${selector} displays ${integer} with a ${decimal}-point tooltip and coin icon`);
}

async function managed(ui, doubles, history, window) {
  const parentPrompt = 'Prepare the parent conversation';
  doubles.queue.push({ content: 'Parent conversation is ready.', quotaUsed: 0.5 });
  await ui.send(parentPrompt);
  await ui.visible('.ai-chat-answer', 'Parent conversation is ready.');
  await checkPointsDisplay(ui, '#ai-chat-quota-used', '1', '0.5');
  const parentId = await ui.evaluate(() => state.currentSession.id);
  await ui.until(() => history.readSession(parentId)?.messages.some(({ content }) => content === parentPrompt), 'saved parent conversation');
  assert.equal(await ui.has('button', '任务'), false, 'the sidebar has no global task entry');
  let resumed = false;
  doubles.model.streamAIControlMessage = (_key, _device, _model, messages, options, onEvent) => {
    if (resumed) {
      assert.ok(messages.some(({ content }) => content === 'Add a brief conclusion'));
      return { ok: true, quota_cost_increment: 0.75, message: { content: 'Final child result' } };
    }
    onEvent({ type: 'reasoning_delta', delta: 'Review the evidence' });
    onEvent({ type: 'content_delta', delta: 'Live **child output**' });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  await ui.setDraft('Keep this parent draft');
  const contents = window.webContents;
  const parent = history.managed.getParentTools({ sender: contents, senderFrame: contents.mainFrame }, { localInteraction: true, parentSessionId: parentId });
  const execute = (args) => parent.execute('chat_session', args);
  const created = await execute({ action: 'create', model_id: 'fixture-model', request_key: 'create', title: 'Review child' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = created.data.sessionId;
  const selected = await execute({ action: 'select_model', session_id: sessionId, model_id: 'fixture-child-model' });
  assert.equal(selected.data.modelId, 'fixture-child-model');
  const sent = await execute({ action: 'send', request_key: 'send', session_id: sessionId, content: 'Review draft', wait_ms: 0 });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await ui.visible('#ai-managed-parent-cards button', 'Review child');
  assert.ok(await ui.evaluate(() => {
    const cards = document.querySelector('#ai-managed-parent-cards').getBoundingClientRect();
    return cards.top >= document.querySelector('#ai-chat-viewport-host').getBoundingClientRect().bottom
      && cards.bottom <= document.querySelector('#ai-chat-form').getBoundingClientRect().top;
  }));
  assert.equal(await ui.has('#ai-managed-chat'), false);
  await ui.click('#ai-managed-parent-cards button');
  await ui.visible('#ai-managed-messages .ai-chat-bubble', 'Review draft');
  await ui.visible('#ai-managed-messages .ai-chat-answer strong', 'child output');
  await ui.visible('#ai-managed-messages .ai-chat-answer-copy', '复制');
  assert.ok(await ui.has('#ai-managed-messages .ai-chat-thinking-text', 'Review the evidence'));
  assert.equal(await ui.evaluate(() => getComputedStyle(document.querySelector('#ai-chat-model-trigger')).visibility), 'hidden');
  const runId = sent.data.runId;
  await assertChildReadOnly(ui, sessionId, runId);
  const inserted = await execute({ action: 'insert', run_id: runId, request_key: 'parent-insert', content: 'Add a brief conclusion' });
  assert.equal(inserted.ok, true);
  await ui.visible('#ai-managed-messages', 'Add a brief conclusion');
  const thinkingSummary = '#ai-managed-messages .ai-chat-thinking > summary';
  await ui.visible(`${thinkingSummary}[aria-expanded="false"]`);
  await ui.click(thinkingSummary);
  assert.equal((await execute({ action: 'stop', run_id: runId })).data.status, 'paused');
  await ui.visible('#ai-managed-status', '已暂停');
  assert.ok(await ui.has(`${thinkingSummary}[aria-expanded="true"]`));
  await ui.visible('#ai-managed-messages .ai-chat-turn-duration', '用时');
  resumed = true;
  assert.equal((await execute({ action: 'resume', run_id: runId })).data.status, 'completed');
  await ui.visible('#ai-managed-messages .ai-chat-answer', 'Final child result');
  const result = await execute({ action: 'wait', run_id: sent.data.runId });
  assert.equal(result.data.result, 'Final child result');
  await checkPointsDisplay(ui, '#ai-managed-quota-used', '1', '0.75');
  await ui.click('#ai-managed-back');
  assert.equal(await ui.evaluate(() => document.querySelector('#ai-chat-input').textContent), 'Keep this parent draft');
  assert.equal(await ui.evaluate(() => document.querySelector('#ai-chat-model').value), 'fixture-model');
  assert.equal(await ui.evaluate(() => document.activeElement?.dataset.managedSessionId), sessionId);
  assert.ok(history.sessions().every((session) => session.id !== sessionId));
  await window.loadFile(path.join(appRoot, 'frontend/sidebar/ai-control.html'));
  await ui.visible('#ai-chat-new-conversation');
  await ui.click('#ai-chat-new-conversation');
  await ui.visible('#ai-chat-history-value', '新对话');
  assert.equal(await ui.has('#ai-managed-parent-cards button'), false, 'a new conversation has no sibling tasks');
  await checkPointsDisplay(ui, '#ai-chat-quota-used', '0', '0.0');
  await ui.click('#ai-chat-history-trigger');
  const parentTitle = history.readSession(parentId).title;
  await ui.visible('#ai-chat-history-menu button', parentTitle);
  await ui.click('#ai-chat-history-menu button', parentTitle);
  await checkPointsDisplay(ui, '#ai-chat-quota-used', '1', '1.25');
  await ui.visible('#ai-managed-parent-cards button', 'Review child');
  await ui.click('#ai-managed-parent-cards button', 'Review child');
  await ui.visible('#ai-managed-messages .ai-chat-answer', 'Final child result');
  assert.ok(await ui.evaluate(() => Array.from(document.querySelectorAll('#ai-managed-messages .ai-chat-thinking-text'))
    .some((element) => element.textContent === 'Review the evidence')));
  await ui.click('#ai-managed-back');
  await ui.click('#ai-chat-new-conversation');
  await ui.visible('#ai-chat-history-value', '新对话');
  assert.equal(await ui.has('#ai-managed-parent-cards button'), false, 'leaving a parent clears its task cards');
  doubles.model.streamAIControlMessage = (_key, _device, _model, messages, options) => delegatedModel(messages, options);
  doubles.tab.pageToken = 'a-document';
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
  if (phase === 'native' || phase === 'native-managed') return native();
  const doubles = createDoubles();
  await runSidebar(doubles, async (ui, history, window) => {
    if (phase === 'initial') await initial(ui, doubles, history);
    else if (phase === 'continuation') await continuation(ui, doubles);
    else if (phase === 'pause-thinking') await pauseThinking(ui, doubles);
    else if (phase === 'scroll') await followCollapsingThinking(ui);
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
