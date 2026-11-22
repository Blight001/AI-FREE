'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { executeStep, verificationEnv } = require('../../../../scripts/verification/process');
const { startFixture } = require('./server');

async function runSidebarPhases(t, phases) {
  const fixture = await startFixture();
  try {
    const root = path.resolve(__dirname, '../../../..');
    for (const phase of phases) {
      const result = await executeStep({ id: phase, timeoutMs: phase === 'native' ? 35000 : 24000,
        args: [require.resolve('electron/cli.js'), path.join(__dirname, 'electron-sidebar.js'), phase],
      }, { root, signal: t.signal, env: { ...verificationEnv(fixture.root), NO_PROXY: '127.0.0.1', AI_FREE_INTERACTION_FIXTURE: JSON.stringify(fixture) } });
      assert.equal(result.status, 'passed', result.output);
      assert.match(result.output, new RegExp(`SIDEBAR_INTERACTION_PASSED ${phase}`));
    }
  } finally {
    await fixture.close();
  }
}

test('Electron sidebar binds, previews, restores history and uploads JSON and PNG directly', { timeout: 70000 },
  (t) => runSidebarPhases(t, ['initial', 'reopen']));

test('Real Chromium reload invalidates an in-progress operation and the next turn downloads and previews without manual binding', {
  timeout: 45000,
  skip: process.env.AI_FREE_ACCEPT_NATIVE_SIDEBAR !== '1',
}, (t) => runSidebarPhases(t, ['native']));
