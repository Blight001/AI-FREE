'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const { applicationLayout, runtimeArgument } = require('../../helpers/flows/app-layout');
const { electronPageFixture } = require('../../helpers/flows/electron-page-fixture');
const { runFlow } = require('../../helpers/flows/runner');
const { emitFlowReport } = require('../../../scripts/verification/flow-reports');

async function main() {
  const args = process.argv.slice(2);
  const layout = applicationLayout(runtimeArgument(args, 'packaged'), {
    appOutDir: process.env.PACKAGED_APP_DIR,
    sidebarPath: process.env.SIDEBAR_HTML_PATH,
  });
  const index = args.indexOf('--scenario');
  const scenario = index < 0 ? require('../flows/application-pages.json')
    : JSON.parse(fs.readFileSync(args[index + 1], 'utf8'));
  const fixture = electronPageFixture(BrowserWindow, layout);
  // The scene owns app lifetime while it closes and recreates its last window.
  const keepAlive = () => {};
  app.on('window-all-closed', keepAlive);
  try {
    const result = await runFlow(scenario, fixture);
    emitFlowReport(result);
    assert.equal(result.ok, true, JSON.stringify(result));
    console.log(`application page checks passed (${layout.runtime})`);
  } finally {
    fixture.close();
    app.off('window-all-closed', keepAlive);
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
