'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChromiumRuntime } = require('../../../src/app/backend/browser-runtime/chromium-runtime');

function runtimeWith(response) {
  const runtime = new ChromiumRuntime({ logger: { info() {}, warn() {} } });
  runtime.getReadyInstance = () => ({ commandClient: { async send() { return response; } } });
  return runtime;
}

test('session import rejects protocol ok with failed command result', async () => {
  const runtime = runtimeWith({ ok: true, result: { success: false, errorCode: 'BROWSER_TAKEOVER_REQUIRED' } });
  await assert.rejects(
    runtime.importSession('failure-profile', {
      targetUrl: 'https://example.com/',
      cookies: [{ name: 'session', value: 'redacted', url: 'https://example.com/' }],
      navigateAfterImport: false,
    }),
    (error) => error.code === 'BROWSER_TAKEOVER_REQUIRED' && error.command === 'clear-session',
  );
});

test('session import rejects top-level failed set-cookies response', async () => {
  const runtime = new ChromiumRuntime({ logger: { info() {}, warn() {} } });
  let calls = 0;
  runtime.getReadyInstance = () => ({ commandClient: { async send(command) {
    calls += 1;
    if (command === 'set-cookies') return { ok: false, errorCode: 'COOKIE_WRITE_FAILED' };
    return { ok: true, result: {} };
  } } });
  await assert.rejects(
    runtime.importSession('cookie-failure-profile', {
      targetUrl: 'https://example.com/',
      cookies: [{ name: 'session', value: 'redacted', url: 'https://example.com/' }],
      navigateAfterImport: false,
    }),
    (error) => error.code === 'COOKIE_WRITE_FAILED' && error.command === 'set-cookies',
  );
  assert.equal(calls, 2);
});

test('session phases reject failed protocol results individually', async () => {
  for (const [method, command] of [
    ['clearImportedSession', 'clear-session'],
    ['importPreparedStorage', 'set-storage'],
    ['navigateAfterSessionImport', 'navigate'],
    ['setCookiesNow', 'set-cookies'],
  ]) {
    const runtime = runtimeWith({ ok: true, result: { success: false, errorCode: 'PHASE_FAILED' } });
    await assert.rejects(
      method === 'importPreparedStorage'
        ? runtime[method]('p', { send: async () => ({ ok: true, result: { success: false, errorCode: 'PHASE_FAILED' } }) }, {
          browserStorage: [{ origin: 'https://example.com', localStorage: {}, sessionStorage: {} }],
        })
        : method === 'navigateAfterSessionImport'
          ? runtime[method]('p', { send: async () => ({ ok: true, result: { success: false, errorCode: 'PHASE_FAILED' } }) }, 'https://example.com')
          : method === 'setCookiesNow'
            ? runtime[method]('p', [{ name: 's', value: 'v', url: 'https://example.com/' }])
            : runtime[method]('p', { send: async () => ({ ok: true, result: { success: false, errorCode: 'PHASE_FAILED' } }) }),
      (error) => error.code === 'PHASE_FAILED' && error.command === command,
    );
  }
});
