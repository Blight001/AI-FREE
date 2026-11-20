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

test('session phases reject failed results through public operations', async () => {
  for (const command of ['clear-session', 'set-storage', 'navigate', 'set-cookies']) {
    const runtime = new ChromiumRuntime({ logger: { info() {}, warn() {} } });
    runtime.getReadyInstance = () => ({ commandClient: { async send(name) {
      return name === command
        ? { ok: true, result: { success: false, errorCode: 'PHASE_FAILED' } }
        : { ok: true, result: {} };
    } } });
    const operation = command === 'set-cookies'
      ? runtime.setCookies('p', [{ name: 's', value: 'v', url: 'https://example.com/' }])
      : runtime.importSession('p', {
        targetUrl: 'https://example.com/',
        browserStorage: [{ origin: 'https://example.com', localStorage: { fixture: 'value' }, sessionStorage: {} }],
      });
    await assert.rejects(operation, (error) => error.code === 'PHASE_FAILED' && error.command === command);
  }
});
