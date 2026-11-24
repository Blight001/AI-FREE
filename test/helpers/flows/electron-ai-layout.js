'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

function measureAiLayout() {
  const header = document.querySelector('.ai-chat-header').getBoundingClientRect();
  const input = document.getElementById('ai-chat-input');
  const form = document.getElementById('ai-chat-form').getBoundingClientRect();
  const send = document.getElementById('ai-chat-send').getBoundingClientRect();
  const sendHit = document.elementFromPoint(send.x + send.width / 2, send.y + send.height / 2);
  const quotaIcon = document.querySelector('#ai-chat-quota-used use');
  return {
    viewportHeight: window.innerHeight,
    headerTop: header.top,
    formBottom: form.bottom,
    sendHit: sendHit?.closest('button')?.id,
    inputBottom: input.getBoundingClientRect().bottom,
    quotaIconWidth: quotaIcon instanceof SVGUseElement ? quotaIcon.getBBox().width : 0,
  };
}

async function resizeSidebar(window, width, height) {
  window.setContentSize(width, height);
  const expected = JSON.stringify(window.getContentSize());
  for (let attempt = 0; attempt < 50; attempt++) {
    const viewport = await window.webContents.executeJavaScript('JSON.stringify([innerWidth, innerHeight])');
    if (viewport === expected) return;
    await delay(20);
  }
  assert.fail(`AI sidebar viewport did not resize to ${expected}`);
}

async function checkAiLayout(window) {
  const originalSize = window.getContentSize();
  const contents = window.webContents;
  try {
    for (const [width, height, scale] of [[430, 700, 1.1], [280, 430, 1.2], [524, 900, 1]]) {
      await resizeSidebar(window, width, height);
      const result = await contents.executeJavaScript(
        `window.AiFreeUiScale.apply(${scale}); (${measureAiLayout})()`,
      );
      const details = `viewport ${width}×${height} at ${scale}: ${JSON.stringify(result)}`;
      assert.ok(result.headerTop >= 0 && result.headerTop < 24, `AI header has an unexpected gap. ${details}`);
      assert.ok(result.formBottom <= result.viewportHeight && result.inputBottom < result.viewportHeight,
        `AI composer extends beyond the viewport. ${details}`);
      assert.equal(result.sendHit, 'ai-chat-send', `AI send button is clipped or covered. ${details}`);
      assert.ok(result.quotaIconWidth > 0, 'The quota icon still renders');
    }
  } finally {
    await resizeSidebar(window, ...originalSize);
    await contents.executeJavaScript('window.AiFreeUiScale.apply(window.AiFreeUiScale.read())');
  }
}

module.exports = { checkAiLayout };
