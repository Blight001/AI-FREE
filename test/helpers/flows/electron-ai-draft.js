'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

async function waitFor(read, predicate) {
  let value = await read();
  for (let attempt = 0; attempt < 50 && !predicate(value); attempt++) {
    await delay(20);
    value = await read();
  }
  return value;
}

async function exerciseAiDraft(webContents) {
  const driver = webContents.debugger;
  driver.attach('1.3');
  try {
    await checkDraftInteractions(webContents);
  } finally {
    driver.detach();
  }
}

async function pressKey(driver, key, windowsVirtualKeyCode, modifiers = 0) {
  const params = { key, windowsVirtualKeyCode, modifiers };
  await driver.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  await driver.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

async function checkDraftInteractions(webContents) {
  const evaluate = (fn, ...args) => webContents.executeJavaScript(
    `(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
  );
  const read = () => evaluate(() => {
    const input = /** @type {HTMLElement} */ (document.getElementById('ai-chat-input'));
    const chips = [...input.querySelectorAll('[contenteditable=false][data-path]:not([data-path=""])')];
    const attachments = [...document.querySelectorAll('#ai-chat-attachment-chips .ai-chat-attachment-chip')];
    return { text: input.innerText, chips: chips.map((chip) => chip.textContent),
      attachments: attachments.map((chip) => chip.textContent) };
  });
  async function paste(name) {
    await evaluate((fileName) => {
      const input = document.querySelector('#ai-chat-input');
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(['fixture'], fileName, { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, name);
    const draft = await waitFor(read, ({ chips }) => chips.includes(name));
    assert.ok(draft.chips.includes(name), `Image ${name} did not render as an atomic inline chip`);
  }
  await evaluate(() => {
    const requests = [];
    const pastedTexts = [];
    const largeRequests = [];
    Object.defineProperty(window, 'aiFree', { value: {
      account: { getSession: async () => ({ authenticated: true }) },
      ai: {
        workspaceList: async () => ({ ok: true, files: [] }),
        workspaceImportPasted: async ({ files, text }) => {
          if (typeof text === 'string') {
            pastedTexts.push(text);
            return { ok: true, files: [{ name: 'pasted-text.txt', path: 'tmp/2026-11-26/pasted-text.txt' }] };
          }
          return { ok: true, files: files.map(({ name }) => ({ name, path: `Uploads/${name}` })) };
        },
        getModels: async () => ({ ok: true, models: [{ id: 'fixture-model', custom_api: true }] }),
        chat: async ({ messages, attachmentPaths }) => {
          requests.push(structuredClone(messages.at(-1)));
          if (attachmentPaths?.length) largeRequests.push({
            message: structuredClone(messages.at(-1)), attachmentPaths: [...attachmentPaths],
          });
          return { ok: true, message: { role: 'assistant', content: 'fixture reply' } };
        },
        requests,
        pastedTexts,
        largeRequests,
      },
    } });
    document.getElementById('ai-chat-input').focus();
  });
  await paste('first.png');
  await webContents.insertText(' 对比 ');
  await paste('second.png');
  await pressKey(webContents.debugger, 'Enter', 13, 8);
  const afterEnter = await waitFor(read, ({ text }) => text.includes('\n'));
  assert.match(afterEnter.text, /\n/);
  await webContents.insertText('有什么区别');
  await evaluate(() => {
    const chip = document.querySelector('[data-path="Uploads/second.png"]');
    const range = document.createRange();
    range.setStartAfter(chip);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await pressKey(webContents.debugger, 'Backspace', 8);
  assert.deepEqual((await waitFor(read, ({ chips }) => chips.length === 1)).chips, ['first.png']);
  assert.match((await read()).text, /对比/);
  await pressKey(webContents.debugger, 'z', 90, 2);
  assert.deepEqual((await waitFor(read, ({ chips }) => chips.length === 2)).chips, ['first.png', 'second.png']);
  await webContents.executeJavaScript('loadModels()');
  await evaluate(() => document.getElementById('ai-chat-send').click());
  const payload = await waitFor(() => webContents.executeJavaScript('window.aiFree.ai.requests[0]'), Boolean);
  assert.deepEqual(payload, {
    role: 'user',
    content: '【图片：first.png】 对比 【图片：second.png】\n有什么区别',
    inlineAttachments: [
      { path: 'Uploads/first.png', marker: '【图片：first.png】' },
      { path: 'Uploads/second.png', marker: '【图片：second.png】' },
    ],
  });
  assert.deepEqual((await read()).chips, []);
  await paste('remove.png');
  await webContents.insertText('保留文字');
  await evaluate(() => {
    const input = document.getElementById('ai-chat-input');
    input.focus();
    getSelection().collapse(input, 0);
  });
  await pressKey(webContents.debugger, 'Delete', 46);
  assert.deepEqual(await waitFor(read, ({ chips }) => !chips.length), { text: '保留文字', chips: [], attachments: [] });
  await evaluate(() => {
    const input = document.getElementById('ai-chat-input');
    input.replaceChildren();
    document.querySelectorAll('#ai-chat-attachment-chips button').forEach((button) => /** @type {HTMLButtonElement} */ (button).click());
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const largeText = '长文本内容'.repeat(3000);
  await evaluate((text) => {
    const input = document.getElementById('ai-chat-input');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, largeText);
  const attached = await waitFor(read, (value) => value.attachments.some((chip) => chip.includes('tmp/2026-11-26/pasted-text.txt')));
  assert.equal(attached.text.includes('tmp/2026-11-26/pasted-text.txt'), true);
  assert.equal(await evaluate(() => /** @type {any} */ (window).aiFree.ai.pastedTexts[0].length), largeText.length);
  await evaluate(() => document.getElementById('ai-chat-send').click());
  const largeRequest = await waitFor(() => evaluate(() => /** @type {any} */ (window).aiFree.ai.largeRequests[0]), Boolean);
  assert.deepEqual(largeRequest.attachmentPaths, ['tmp/2026-11-26/pasted-text.txt']);
  assert.match(largeRequest.message.content, /tmp\/2026-11-26\/pasted-text\.txt/);
}

module.exports = { exerciseAiDraft };
