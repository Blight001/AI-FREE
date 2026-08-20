'use strict';

const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const {
  createRemoteBrowserPeerController,
} = require('../../../src/app/main/features/browser/remote-browser-peer-controller');

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==';

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) resolve(value);
      else if (Date.now() >= deadline) reject(new Error('等待远程浏览器 WebRTC peer 超时'));
      else setTimeout(poll, 25);
    };
    poll();
  });
}

async function main() {
  const messages = [];
  const controller = createRemoteBrowserPeerController({
    BrowserWindow,
    onMessage: (message) => messages.push(message),
  });
  try {
    await controller.start('acceptance-remote', [{ urls: 'stun:127.0.0.1:9' }]);
    const offer = await waitFor(() => messages.find((message) => message.event === 'offer'));
    assert.equal(offer.sessionId, 'acceptance-remote');
    assert.match(String(offer.sdp), /^v=0/m);

    await controller.frame('acceptance-remote', PIXEL);
    const ready = await waitFor(() => messages.find((message) => message.event === 'ready'));
    assert.deepEqual({ width: ready.width, height: ready.height }, { width: 1, height: 1 });
    console.log('remote browser WebRTC peer checks passed');
  } finally {
    await controller.stop();
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
