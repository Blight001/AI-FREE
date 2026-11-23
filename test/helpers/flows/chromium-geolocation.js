'use strict';

const assert = require('node:assert/strict');
const { on, once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

async function readDevToolsPort(profileDir, signal) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  while (!signal.aborted) {
    try {
      const port = Number((await fs.readFile(file, 'utf8')).split('\n', 1)[0]);
      assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid fixture DevTools port');
      return port;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await sleep(50, undefined, { signal });
    }
  }
  signal.throwIfAborted();
}

async function withFixturePosition(profileDir, pageUrl, runAssertions) {
  const signal = AbortSignal.timeout(5000);
  const port = await readDevToolsPort(profileDir, signal);
  const address = `127.0.0.1:${port}`;
  const response = await fetch(`http://${address}/json/list`, { redirect: 'error', signal });
  assert(response.ok, 'Failed to list fixture DevTools targets');
  const targets = await response.json();
  const tab = targets.find((target) => target.type === 'page' && target.url === pageUrl);
  assert(tab, 'Fixture tab missing from DevTools targets');
  const endpoint = new URL(tab.webSocketDebuggerUrl);
  assert.equal(endpoint.origin, `ws://${address}`);
  assert(endpoint.pathname.startsWith('/devtools/page/'));
  const socket = new WebSocket(endpoint);
  try {
    await once(socket, 'open', { signal });
    const messages = on(socket, 'message', { signal, close: ['close'] });
    socket.send(JSON.stringify({
      id: 1,
      method: 'Emulation.setGeolocationOverride',
      // Distinct from the Profile settings so the browser extension must still apply them.
      params: { latitude: 1, longitude: 2, accuracy: 10 },
    }));
    for await (const [event] of messages) {
      const reply = JSON.parse(event.data);
      if (reply.id !== 1) continue;
      assert.equal(reply.error, undefined, 'Could not set the fixture geolocation position');
      return await runAssertions();
    }
    assert.fail('Fixture DevTools connection closed before the position override was applied');
  } finally {
    socket.close();
  }
}

module.exports = { withFixturePosition };
