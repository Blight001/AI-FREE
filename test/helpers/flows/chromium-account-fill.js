'use strict';

const assert = require('node:assert/strict');
const { X509Certificate, createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { safeStorage } = require('electron');
const { createNativeBrowserAutomation } = require('../../../src/app/backend/services/native-browser-automation');
const { ProviderAccountVault } = require('../../../src/app/backend/features/account/provider-account-vault');
const { createProviderAccountTools } = require('../../../src/app/backend/features/account/provider-account-tools');

const username = 'fixture@example.test';
const password = 'fill-fixture-value';
const fixtureHtml = `<!doctype html><title>waiting</title>
  <input id="login" type="email" autocomplete="off">
  <input id="focused" autofocus><input name="duplicate" type="password">
  <input name="duplicate" type="password"><input id="secret" type="password">
  <script>
    addEventListener('input', () => {
      const validLogin = document.querySelector('#login').value === ${JSON.stringify(username)};
      const validPassword = document.querySelector('#secret').value === ${JSON.stringify(password)};
      const untouched = !document.querySelector('#focused').value &&
        [...document.querySelectorAll('[name=duplicate]')].every(field => !field.value);
      document.title = [validLogin, validPassword, untouched].join(',');
    });
  </script>`;

async function startHttps(directory) {
  const key = fs.readFileSync(path.join(directory, 'key.pem'));
  const cert = fs.readFileSync(path.join(directory, 'cert.pem'));
  const publicKey = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
  const fingerprint = createHash('sha256').update(publicKey).digest('base64');
  const server = https.createServer({ key, cert }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'connection': 'close' });
    response.end(fixtureHtml);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, fingerprint, origin: `https://127.0.0.1:${address.port}` };
}

async function assertFailure(result, code) {
  const response = await result;
  assert.equal(response.ok, false);
  if (response.ok === false) assert.equal(response.error.code, code);
}

async function waitForLoginPage(bridge, id, origin) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const { activeTab } = await bridge.dispatch(id, 'browser_tab', { action: 'list' });
    if (activeTab?.title === 'waiting' && activeTab.url === `${origin}/` && activeTab.pageToken) return;
    if (attempt === 79) assert.fail(`HTTPS fixture did not load: ${activeTab?.url} ${activeTab?.title} (bound: ${Boolean(activeTab?.pageToken)})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function acceptAccountFill({ manager, runtimeRoot, certificateDirectory, plainOrigin, stopAndAssertReleased }) {
  const { server, fingerprint, origin } = await startHttps(certificateDirectory);
  const profileId = 'phase3_account_fill';
  try {
    const state = await manager.launchProfile({
      profileId, runtimeType: 'chromium', initialUrl: origin, launchTimeoutMs: 30000,
      extraArgs: [`--ignore-certificate-errors-spki-list=${fingerprint}`],
    }, { x: 0, y: 41, width: 1180, height: 719 });
    const bridge = createNativeBrowserAutomation({ browserRuntimeManager: manager });
    const id = `native:${profileId}`;
    const navigate = (url) => bridge.dispatch(id, 'browser_tab', { action: 'navigate', url });
    await waitForLoginPage(bridge, id, origin);
    assert.equal((await bridge.dispatch(id, 'browser_control', { action: 'acquire' })).success, true);
    const vault = new ProviderAccountVault({ fs, path, safeStorage, filePath: path.join(runtimeRoot, 'fixture-vault.json') });
    const record = vault.save({ provider: 'google', email: username, password });
    let navigateBeforeFill = false;
    const runtime = {
      async dispatchAutomationByProcessId(...args) {
        if (navigateBeforeFill) await navigate(plainOrigin);
        return manager.dispatchAutomationByProcessId(...args);
      },
    };
    const { execute } = createProviderAccountTools({
      vault, bridge, runtime, confirm: () => assert.fail('fill must not request confirmation'),
      openEditor: () => {}, onChanged: () => {},
    });
    const input = { provider: 'google', id: record.id, change_browser: id, origin };
    const fill = (field, locator) => execute('account_manage', { action: 'fill', ...input, field, ...locator });
    await assertFailure(fill('password', { field_name: 'missing' }), 'ACCOUNT_FILL_FAILED');
    await assertFailure(fill('password', { field_name: 'duplicate' }), 'ACCOUNT_FILL_FAILED');
    await assertFailure(fill('password', { field_id: 'login' }), 'ACCOUNT_FILL_FAILED');
    assert.deepEqual(await fill('username', { field_id: 'login' }), { ok: true, data: { filled: true } });
    assert.deepEqual(await fill('password', { field_id: 'secret' }), { ok: true, data: { filled: true } });
    const { activeTab } = await bridge.dispatch(id, 'browser_tab', { action: 'list' });
    assert.equal(activeTab.title, 'true,true,true');
    navigateBeforeFill = true;
    await assertFailure(fill('password', { field_id: 'secret' }), 'ACCOUNT_TARGET_CHANGED');
    await assertFailure(fill('password', { field_id: 'secret' }), 'ACCOUNT_TARGET_MISMATCH');
    await stopAndAssertReleased(profileId, state.pid);
    console.log('[account-fill] HTTPS, isolated input, wrong field, missing field, duplicate field and navigation checks passed');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { acceptAccountFill };
