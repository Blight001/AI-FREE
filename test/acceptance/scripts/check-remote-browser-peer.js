'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runFlow } = require('../../helpers/flows/runner');
const { bindDomain } = require('../../helpers/flows/domains');
const { emitFlowReport } = require('../../../scripts/verification/flow-reports');
const { applicationLayout, runtimeArgument } = require('../../helpers/flows/app-layout');
const { app, BrowserWindow } = require('electron');

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
  const layout = applicationLayout(runtimeArgument(process.argv.slice(2), 'source'));
  const { createRemoteBrowserPeerController } = require(layout.peerController);
  const messages = [];
  const controller = createRemoteBrowserPeerController({
    BrowserWindow,
    onMessage: (message) => messages.push(message),
  });
  try {
    const index = process.argv.indexOf('--scenario');
    const flow = index < 0 ? require('../flows/remote-browser-peer.json')
      : JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
    const result = await runFlow(flow, bindDomain('remote-peer', {
      start: async ({ session }) => {
        await controller.start(session, [{ urls: 'stun:127.0.0.1:9' }]);
        return { started: true };
      },
      frame: async ({ session }) => { await controller.frame(session, PIXEL); return { sent: true }; },
      waitEvent: async ({ event }) => {
        assert(['offer', 'ready'].includes(event));
        const message = await waitFor(() => messages.find((entry) => entry.event === event));
        return { ...message, validSdp: /^v=0/m.test(String(message.sdp)) };
      },
    }));
    emitFlowReport(result);
    assert.equal(result.ok, true, JSON.stringify(result));
    console.log('remote browser WebRTC peer checks passed');
  } finally {
    await controller.stop();
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
