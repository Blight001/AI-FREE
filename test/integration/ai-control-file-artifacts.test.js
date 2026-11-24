'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.handlers = {};
    this.dataset = {};
    this.classList = { toggle() {} };
    this.isConnected = true;
  }

  set innerHTML(_value) { this.replaceChildren(); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, action) { this.handlers[name] = action; }
  click() { this.handlers.click?.({ currentTarget: this }); }
  focus() {}
  querySelector(selector) { return this.children.find((child) => child.className === selector.slice(1)) || null; }
}

function fixture(workspaceRead = () => ({ ok: true, file: {} })) {
  const input = Object.assign(new Element(), { value: '' });
  const chips = new Element();
  const menu = new Element();
  const elements = { 'ai-chat-input': input, 'ai-chat-attachment-chips': chips, 'ai-chat-mention-menu': menu };
  const status = [];
  const context = vm.createContext({
    document: { createElement: () => new Element() }, window: { aiFree: { ai: { workspaceRead } } },
    chatDraftMention: () => ({ query: 'same', range: { start: 0, end: input.value.length } }),
    replaceChatDraftSelection: ({ start, end }, text) => {
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
    },
    el: (id) => elements[id] || null, resizeInput() {}, setStatus: (message) => status.push(message),
    state: {
      currentSession: { id: 'current' }, attachmentPaths: [], chatMentions: [], mcpTools: [],
      workspaceFiles: ['A', 'B'].map((dir) => ({ path: `${dir}/same.png`, name: 'same.png', size: 10 })),
    },
  });
  const controllerDir = path.join(__dirname, '../../src/app/frontend/sidebar/client/app/side/controllers/pages/ai-control');
  for (const name of ['ai-control-files.js', 'ai-control-file-preview.js', 'ai-control-chat-presentation.js']) {
    vm.runInContext(fs.readFileSync(path.join(controllerDir, name), 'utf8'), context);
  }
  const run = (code) => vm.runInContext(code, context);
  context.syncSendState = () => {};
  return { run, context, input, chips, menu, status };
}

test('same-name @ choices show their paths and removal drops the selected file from the request', () => {
  const { input, chips, menu, run } = fixture();
  input.value = '@same';
  run('renderMentionMenu()');
  assert.deepEqual(menu.children.map((choice) => choice.textContent), ['A/same.png · 附加文件', 'B/same.png · 附加文件']);
  menu.children[0].click();
  assert.equal(input.value, '');
  chips.children[0].children[1].click();
  input.value = '@same';
  run('renderMentionMenu()');
  run("handleChatMentionKey({ key: 'ArrowDown', preventDefault() {} })");
  run("handleChatMentionKey({ key: 'Enter', preventDefault() {} })");
  assert.deepEqual(JSON.parse(run("JSON.stringify(takeChatAttachmentContext(''))")), {
    attachmentPaths: ['B/same.png'], mentions: [], artifactReferences: [],
  });
});

test('the compact download strip deduplicates receipts and reattaches only verified work files in the same session', async () => {
  const requests = [];
  const { context, run, chips, status } = fixture((input) => new Promise((resolve) => requests.push({ input, resolve })));
  const artifact = {
    path: 'A/same.png', name: 'same.png', size: 10, sha256: 'a'.repeat(64),
    kind: 'image', toolName: 'browser_file', toolCallId: 'download-1',
  };
  const list = new Element();
  Object.assign(context, { artifact, list });
  run('renderChatDownloads(list, [{ artifacts: [artifact] }], [artifact])');
  assert.equal(list.children.length, 1);
  const button = list.children[0].children[1];
  button.click();
  assert.equal(requests[0].input.artifact, artifact);
  assert.equal(requests[0].input.validateOnly, true);
  assert.equal(chips.children.length, 0);
  requests[0].resolve({ ok: false, message: '文件已更改' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(status, ['文件已更改']);
  assert.equal(chips.children.length, 0);
  button.click();
  requests[1].resolve({ ok: true, file: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(run("JSON.stringify(takeChatAttachmentContext(''))")), {
    attachmentPaths: [artifact.path], artifactReferences: [artifact], mentions: [],
  });
  button.click();
  context.state.currentSession = { id: 'next' };
  requests[2].resolve({ ok: true, file: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chips.children.length, 0);
  run('renderChatDownloads(list, [])');
  assert.equal(list.hidden, true);
  assert.equal(list.children.length, 0);
});
