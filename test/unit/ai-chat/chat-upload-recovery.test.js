'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runChatConversation } = require('../../../src/app/backend/features/ai-chat/chat-conversation-runner');

function toolCall(id, name, args) {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

function uploadTurn(t, { observe, upload }) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-chat-upload-recovery-'));
  const file = path.join(workspaceDir, 'test-file.txt');
  t.after(() => {
    fs.unlinkSync(file);
    fs.rmdirSync(workspaceDir);
  });
  fs.writeFileSync(file, 'test file');
  const connection = { id: 'native:target', name: 'Target' };
  const pageToken = 'bound-page';
  const controller = new AbortController();
  const toolCalls = [
    toolCall('upload', 'browser_file', { action: 'upload', path: 'test-file.txt', selector: 'input[type=file]' }),
    toolCall('click', 'browser_action', { action: 'click', x: 10, y: 20 }),
  ];
  const dispatches = [];
  let modelCalls = 0;
  const request = {
    localInteraction: true, workspaceDir, connections: [connection],
    run: { controller, insertedMessages: [] },
    emit() {},
    bridge: {
      getConnection: () => connection,
      async dispatch(connectionId, tool, args, options) {
        dispatches.push({ connectionId, tool, args, options });
        if (tool === 'browser_tab') return { activeTab: { pageToken } };
        if (tool === 'browser_file') return upload();
        if (tool === 'browser_observe') return observe();
        return { success: true };
      },
    },
    toolContext: {
      tools: toolCalls.map((call) => ({ name: call.function.name })),
      modelMessages: [{ role: 'user', content: 'Upload the file' }],
      describeConnections: () => connection.name,
      findConnectionByRef: () => connection,
    },
    httpClient: {
      async sendAIControlMessage() {
        modelCalls += 1;
        return { ok: true, message: modelCalls === 1 ? { tool_calls: toolCalls } : { content: 'Finished' } };
      },
    },
  };
  return { request, dispatches, modelCalls: () => modelCalls };
}

function checkNoReplay(turn) {
  assert.deepEqual(turn.dispatches.map((call) => call.tool), ['browser_tab', 'browser_tab', 'browser_file', 'browser_observe']);
  const [, , upload, observed] = turn.dispatches;
  assert.equal(observed.connectionId, upload.connectionId);
  assert.equal(observed.options.expectedPageToken, upload.options.expectedPageToken);
  assert.equal(observed.options.allowAppSurface, false);
  assert.equal(observed.args.mark, false);
  assert.equal(observed.args.include_screenshot, false);
  assert.equal(turn.modelCalls(), 1);
}

test('a lost upload response reads the bound page once and reports only its upload status', async (t) => {
  const turn = uploadTurn(t, {
    upload() { throw new Error('private transport error'); },
    observe: () => ({ success: true, title: 'private page title', url: 'https://example.test/?private=token', items: [
      { role: 'status', text: 'Upload complete', selector: '#private-locator' },
      { role: 'status', text: 'Unrelated private text' },
    ] }),
  });
  const result = await runChatConversation(turn.request);
  checkNoReplay(turn);
  assert.match(result.message.content, /页面显示.*上传完成/);
  assert.match(result.message.content, /确认.*本次文件.*不要重复上传/);
  const upload = result.message.tool_events.find((event) => event.id === 'upload');
  assert.equal(upload.result.errorCode, 'UPLOAD_OUTCOME_UNVERIFIED');
  assert.equal(upload.result.recoverable, false);
  assert.doesNotMatch(JSON.stringify(result), /private|Unrelated/);
});

for (const [name, observe] of [
  ['a changed page', () => ({ success: false, errorCode: 'BROWSER_TARGET_CHANGED' })],
  ['a failed read', () => { throw new Error('private observation error'); }],
  ['only file selection', () => ({ success: true, items: [
    { role: 'status', ariaLabel: 'Upload status', text: 'File selected' },
    { role: 'status', text: 'Backup complete' },
  ] })],
]) {
  test(`an unverified upload asks the user to check when observation finds ${name}`, async (t) => {
    const turn = uploadTurn(t, { upload: () => ({ success: false, errorCode: 'UPLOAD_OUTCOME_UNVERIFIED' }), observe });
    const result = await runChatConversation(turn.request);
    checkNoReplay(turn);
    assert.match(result.message.content, /请.*目标页面.*检查.*是否收到文件/);
    assert.match(result.message.content, /不要重复上传/);
    assert.doesNotMatch(JSON.stringify(result), /private|File selected|Backup complete/);
  });
}

test('a verified file selection does not read a receipt or end the turn early', async (t) => {
  const turn = uploadTurn(t, { upload: () => ({ success: true }), observe: () => assert.fail('unexpected recovery read') });
  const result = await runChatConversation(turn.request);
  assert.deepEqual(turn.dispatches.map((call) => call.tool), ['browser_tab', 'browser_tab', 'browser_file', 'browser_action']);
  assert.equal(turn.modelCalls(), 2);
  assert.equal(result.message.tool_events.find((event) => event.id === 'upload').result.uploadVerification, 'file_selected');
});
