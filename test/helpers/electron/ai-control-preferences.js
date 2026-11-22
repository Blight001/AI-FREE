'use strict';

const assert = require('node:assert/strict');
const { poll } = require('../flows/electron-controls');

function historyOrder(ai) {
  return ai(() => [...document.querySelectorAll('#ai-chat-history-menu [data-history-pin-id]')]
    .map((button) => [button.getAttribute('data-history-pin-id'), button.getAttribute('aria-pressed')]));
}

async function checkAiPreferences(ai, reload) {
  const model = () => ai(() => document.querySelector('#ai-chat-model option:checked')?.getAttribute('value'));
  await poll(model, (value) => value === 'first');
  assert.deepEqual(await ai(() => {
    const button = document.getElementById('ai-chat-new-conversation');
    return [button.textContent.trim(), button.title, Boolean(document.getElementById('ai-chat-stream-output')),
      document.getElementById('ai-chat-message-list').textContent.includes('最近聊天')];
  }), ['+', '新建对话', false, false]);
  await poll(() => historyOrder(ai), (rows) => rows.length === 2);
  await ai(() => {
    document.getElementById('ai-chat-model-trigger').click();
    const modelOption = document.querySelector('button[data-value="second"]');
    const pin = document.querySelector('button[data-history-pin-id="older"]');
    if (!(modelOption instanceof HTMLButtonElement) || !(pin instanceof HTMLButtonElement)) throw new Error('Missing AI controls');
    modelOption.click();
    pin.click();
  });
  await poll(() => historyOrder(ai), (rows) => rows[0]?.[0] === 'older' && rows[0][1] === 'true');
  await reload();
  await poll(model, (value) => value === 'second');
  await poll(() => historyOrder(ai), (rows) => rows[0]?.[0] === 'older' && rows[0][1] === 'true');
  assert.equal(await ai(() => {
    const pin = document.querySelector('button[data-history-pin-id="older"]');
    if (!(pin instanceof HTMLButtonElement)) throw new Error('Missing conversation pin');
    pin.click();
    return pin.nextElementSibling?.getAttribute('aria-label');
  }), '重命名对话');
  await poll(() => historyOrder(ai), (rows) => rows[0]?.[0] === 'newer' && rows[1]?.[1] === 'false');
}

function appendContent(ai) {
  return ai(() => {
    const block = document.createElement('div');
    block.style.height = '700px';
    document.getElementById('ai-chat-message-list').appendChild(block);
  });
}

function scrollState(ai) {
  return ai(() => {
    const viewport = document.getElementById('ai-chat-messages');
    return { top: viewport.scrollTop, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      hidden: document.getElementById('ai-chat-jump-bottom').hidden };
  });
}

async function checkAiScroll(ai) {
  await appendContent(ai);
  await poll(() => scrollState(ai), ({ top, hidden }) => top > 0 && hidden);
  await ai(() => { document.getElementById('ai-chat-messages').scrollTop = 12; });
  await poll(() => scrollState(ai), ({ top, hidden }) => top === 12 && !hidden);
  await appendContent(ai);
  await poll(() => scrollState(ai), ({ top, gap, hidden }) => top === 12 && gap > 700 && !hidden);
  await ai(() => document.getElementById('ai-chat-jump-bottom').click());
  const bottom = await poll(() => scrollState(ai), ({ gap, hidden }) => gap <= 4 && hidden);
  await appendContent(ai);
  await poll(() => scrollState(ai), ({ top, gap, hidden }) => top > bottom.top && gap <= 4 && hidden);
}

module.exports = { checkAiPreferences, checkAiScroll };
