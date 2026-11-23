'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createBrowserAutomationBridge } = require('../../../src/app/backend/services/browser-automation-bridge');
const { createBrowserDownloadService } = require('../../../src/app/backend/services/browser-download-service');
const { dispatchPluginTool } = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVbcAAAAASUVORK5CYII=', 'base64');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function serveMcpFileFixture(url, response) {
  if (url.pathname === '/mcp-reference.png') {
    response.setHeader('Content-Type', 'image/png');
    response.end(PNG);
    return true;
  }
  if (url.pathname === '/mcp-reference-receipt') {
    response.end('ok');
    return true;
  }
  if (url.pathname === '/mcp-session-fixture') {
    response.setHeader('Set-Cookie', 'session_fixture=fixture-cookie; Path=/mcp-session-fixture; HttpOnly');
    response.end(`<!doctype html><title>Session fixture ready</title><script>
      localStorage.setItem('session-fixture', 'fixture-local');
      sessionStorage.setItem('session-fixture', 'fixture-session');
    </script><main>Session fixture</main>`);
    return true;
  }
  if (url.pathname !== '/mcp-reference-composer') return false;
  response.end(`<!doctype html><meta charset="utf-8"><title>Reference composer</title>
    <main style="width:min(100%,360px)">
      <a id="reference" href="/mcp-reference.png" download="reference.png">Reference image</a>
      <p><label for="file" style="display:inline-block;width:36px;height:32px">+</label><input id="file" type="file" hidden></p>
      <button id="send" type="button" aria-label="Send">➤</button>
      <output id="link-state">Waiting for download click</output>
      <output id="upload-state">Waiting for reference</output>
      <output id="receipt">Waiting</output>
    </main>
    <script>
      const fileInput = document.querySelector('#file');
      const output = document.querySelector('#receipt');
      const linkState = document.querySelector('#link-state');
      const uploadState = document.querySelector('#upload-state');
      let downloaded = false;
      document.querySelector('#reference').addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        downloaded = true;
        linkState.textContent = 'Download link activated';
      });
      fileInput.addEventListener('change', () => {
        if (!downloaded) {
          fileInput.value = '';
          uploadState.textContent = 'Download click required';
          return;
        }
        uploadState.textContent = 'Reference accepted: ' + fileInput.files[0].name;
      });
      document.querySelector('#send').addEventListener('click', async (event) => {
        const file = fileInput.files[0];
        if (!file) return;
        const bytes = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        const query = new URLSearchParams({ sha256, name: file.name, trusted: event.isTrusted });
        await fetch('/mcp-reference-receipt?' + query);
        output.textContent = 'Received ' + sha256;
      });
    </script>`);
  return true;
}

function entryTools(manager, workspace) {
  const bridge = createBrowserAutomationBridge({ workspaceDir: workspace, cardCacheDir: workspace,
    browserRuntimeManager: manager, getExternalMcpAccess: () => true,
    browserDownloadService: createBrowserDownloadService({ sandboxDir: workspace }),
  });
  const connections = bridge.listConnections().map(({ id }) => bridge.getConnection(id));
  assert.equal(connections.length, 1);
  const context = { bridge, connections, localInteraction: true, workspaceDir: workspace, browserTargets: new Map(),
    describeConnections: () => 'Reference composer', waitForAbort: async (value) => value };
  return [
    (tool, args) => bridge.callExternalMcpTool(tool, args),
    (tool, args) => dispatchPluginTool(context, tool, args),
  ];
}

async function selectReference(call, filename) {
  const observation = await call('browser_observe', { filter: 'file-input' });
  const input = observation.items.find(({ selector }) => selector === '#file');
  assert.equal(input?.uploadable, true);
  const uploaded = await call('browser_file', { action: 'upload', ref: input.id, path: filename,
    observation_id: observation.observationId });
  assert.equal(uploaded.fileSelected, true, JSON.stringify(uploaded));
  assert.equal(uploaded.uploadVerification, 'file_selected');
}

async function readClickedDownload(workspace) {
  const filename = 'reference.png';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      assert.deepEqual(await fs.readFile(path.join(workspace, filename)), PNG);
      return filename;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  assert.fail('Click did not save reference.png to the workspace');
}

async function verifyReferenceSubmission(call, requestName, workspace, requests) {
  assert.equal((await call('browser_control', { action: 'acquire' })).success, true);
  const links = await call('browser_observe', { filter: 'link' });
  const link = links.downloadLinks.find(({ selector }) => selector === '#reference');
  assert(link, 'Observation must return the page download link');
  const download = await call('browser_file', { action: 'download_element', ref: link.ref,
    ...(requestName ? { filename: requestName } : {}), observation_id: links.observationId });
  assert.equal(download.success, true, JSON.stringify(download));
  assert.equal(download.file_name, requestName || 'mcp-reference.png');
  assert.equal(download.sha256, sha256(PNG));
  assert.equal(download.pageClickDispatched, false);
  assert.deepEqual(await fs.readFile(path.join(workspace, download.relative_path)), PNG);
  await selectReference(call, download.relative_path);
  const rejected = await call('browser_wait', { condition: 'text_contains', selector: '#upload-state',
    value: 'Download click required', timeout_ms: 3000 });
  assert.equal(rejected.success, true, JSON.stringify(rejected));
  const click = await call('browser_action', { action: 'click', selector: '#reference' });
  assert.equal(click.actionExecuted, true, JSON.stringify(click));
  const filename = await readClickedDownload(workspace);
  await selectReference(call, filename);
  const accepted = await call('browser_wait', { condition: 'text_contains', selector: '#upload-state',
    value: 'Reference accepted: ' + filename, timeout_ms: 3000 });
  assert.equal(accepted.success, true, JSON.stringify(accepted));
  const submitted = await call('browser_action', {
    action: 'click', selector: '#send', after: 'none',
    probes: [{ name: 'receipt', selector: '#receipt', read: 'text' }],
    expect: [{ name: 'receipt', op: 'contains', value: sha256(PNG) }],
  });
  assert.equal(submitted.success, true, JSON.stringify(submitted));
  assert.equal(submitted.status, 'business_verified');
  const receipt = await call('browser_wait', { condition: 'text_contains', selector: '#receipt',
    value: sha256(PNG), timeout_ms: 5000 });
  assert.equal(receipt.success, true, JSON.stringify(receipt));
  const matching = requests.filter(({ path: route }) => route === '/mcp-reference-receipt').slice(-1);
  assert.equal(new URLSearchParams(matching[0]?.query).get('name'), filename);
  assert.equal(matching.length, 1);
  assert.equal(new URLSearchParams(matching[0].query).get('sha256'), sha256(PNG));
  assert.equal(new URLSearchParams(matching[0].query).get('trusted'), 'true');
  await fs.unlink(path.join(workspace, filename));
  const evidence = await call('browser_screenshot', {});
  assert.match(evidence.dataUrl, /^data:image\/png;base64,/);
}

async function acceptMcpFileParity({ manager, profileId, url, workspace, requests }) {
  const [external, sidebar] = entryTools(manager, workspace);
  for (const { call, requestName } of [{ call: external, requestName: 'external-reference.png' }, { call: sidebar }]) {
    await manager.navigate(profileId, 'chromium', url);
    await verifyReferenceSubmission(call, requestName, workspace, requests);
    await call('browser_control', { action: 'release' });
  }
  assert.equal(requests.filter(({ path: route }) => route === '/mcp-reference-receipt').length, 2);
  process.stdout.write('External MCP and sidebar submitted the same downloaded PNG once each.\n');
}

async function acceptMcpSessionParity({ manager, profileId, url, workspace }) {
  await manager.navigate(profileId, 'chromium', url);
  const calls = entryTools(manager, workspace);
  for (const [index, call] of calls.entries()) {
    const ready = await call('browser_wait', { condition: 'attached', selector: 'main', timeout_ms: 3000 });
    assert.equal(ready.success, true, JSON.stringify(ready));
    const filename = 'evalpilot-settings-session.json';
    const result = await call('browser_file', { action: 'save_session', filename, directory: 'session-' + index });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.file_name, filename);
    assert.ok(result.cookie_count >= 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-cookie|fixture-local|fixture-session/);
    const session = JSON.parse(await fs.readFile(path.join(workspace, result.relative_path), 'utf8'));
    assert.equal(session.url, url);
    assert.equal(session.cookies.length, result.cookie_count);
    assert.equal(session.cookies.find((cookie) => cookie.name === 'session_fixture')?.value, 'fixture-cookie');
    assert.equal(session.localStorage['session-fixture'], 'fixture-local');
    assert.equal(session.sessionStorage['session-fixture'], 'fixture-session');
  }
  process.stdout.write('External MCP and sidebar exported the same bound Chromium session locally.\n');
}

module.exports = { acceptMcpFileParity, acceptMcpSessionParity, entryTools, serveMcpFileFixture };
