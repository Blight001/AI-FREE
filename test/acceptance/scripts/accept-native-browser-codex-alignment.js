'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { runFlow } = require('../../helpers/flows/runner');
const { nativeBrowserFixture } = require('../../helpers/flows/native-browser-fixture');
const { nativeBrowserDrivers } = require('../../helpers/flows/native-browser-drivers');
const { emitFlowReport } = require('../../../scripts/verification/flow-reports');
const workflow = require('./native-browser-workflow-scenarios');

const args = process.argv.slice(2);
const workflowOnly = args.includes('--workflow-only');
const scenarioIndex = args.indexOf('--scenario');
const scenario = scenarioIndex < 0 ? undefined : JSON.parse(fs.readFileSync(path.resolve(args[scenarioIndex + 1]), 'utf8'));
const chromiumPath = String(process.env.AI_FREE_ACCEPTANCE_CHROMIUM_PATH || '').trim();
if (chromiumPath) {
  process.env.AI_FREE_CHROMIUM_HANDSHAKE = 'prototype';
  process.env.AI_FREE_CHROMIUM_PATH = chromiumPath;
} else {
  delete process.env.AI_FREE_CHROMIUM_HANDSHAKE;
  delete process.env.AI_FREE_CHROMIUM_PATH;
}

const fixture = nativeBrowserFixture(BrowserWindow);

async function main() {
  const { automation, id, origin } = await fixture.start();
  if (workflowOnly) return workflow.run(automation, id, origin, scenario);
  const result = await runFlow(scenario || require('../flows/native-alignment.json'), {
    ...nativeBrowserDrivers(automation, id, origin),
    input: { firstUrl: `${origin}/one`, secondUrl: `${origin}/two`, text: 'Codex' },
    onProgress: ({ id: step, status }) => console.log(`[native-alignment] ${step}: ${status}`),
  });
  emitFlowReport(result);
  assert.equal(result.ok, true, JSON.stringify(result));
}

async function finish(exitCode) {
  const cleanup = await fixture.close();
  if (!cleanup.ok) console.error('VERIFICATION_CLEANUP_FAILED');
  app.exit(cleanup.ok ? exitCode : 1);
}

app.whenReady().then(main).then(() => finish(0)).catch(async (error) => {
  console.error('[native-codex-alignment] FAILED', error.stack || error);
  await finish(1);
});
