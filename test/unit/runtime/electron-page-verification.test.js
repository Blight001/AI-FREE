'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { applicationLayout, runtimeArgument } = require('../../helpers/flows/app-layout');
const { electronPageFixture } = require('../../helpers/flows/electron-page-fixture');
const { runFlow, validateFlow } = require('../../helpers/flows/runner');
const { domainContract } = require('../../helpers/flows/domains');
const { verificationPlan } = require('../../../scripts/verification/catalog');

test('page fixture resolves source, generated and packaged layouts without cwd or Electron resources assumptions', () => {
  const projectRoot = path.resolve('fixture-project');
  const roots = [projectRoot, path.join(projectRoot, '.generated/app'),
    path.join(projectRoot, 'appbuild/win-unpacked/resources/app.asar')];
  for (const [index, runtime] of ['source', 'generated', 'packaged'].entries()) {
    const layout = applicationLayout(runtime, { projectRoot });
    assert.equal(layout.pages.ai, path.join(roots[index], 'src/app/frontend/sidebar/ai-control.html'));
    assert.equal(layout.pages.shell, path.join(roots[index], 'src/app/frontend/views/app-shell.html'));
    assert.equal(layout.peerController, path.join(roots[index], 'src/app/backend/features/browser/remote-browser-peer-controller.js'));
  }
  const sidebarPath = path.resolve('explicit-sidebar/ai-control.html');
  const override = applicationLayout('packaged', { projectRoot, sidebarPath });
  assert.equal(override.pages.ai, sidebarPath);
  assert.equal(override.runtime, 'override');
  assert.equal(override.pages.shell, path.join(projectRoot, 'src/app/frontend/views/app-shell.html'));
  assert.equal(runtimeArgument([], 'packaged'), 'packaged');
  assert.throws(() => runtimeArgument(['--runtime'], 'source'), /UNKNOWN_APPLICATION_RUNTIME/);
  assert.throws(() => applicationLayout('external'), /UNKNOWN_APPLICATION_RUNTIME/);
});

function windowFactory() {
  const windows = [];
  class Window {
    constructor() {
      this.destroyed = false;
      this.url = 'about:blank';
      this.reads = 0;
      this.webContents = {
        getURL: () => this.url,
        executeJavaScript: async () => { this.reads++; return { logoCount: 0, logosLoaded: false }; },
      };
      windows.push(this);
    }
    async loadFile(file) { this.url = pathToFileURL(file).href; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  return { Window, windows };
}

test('page action success is checked independently, stops on false evidence and cleans the window', async () => {
  const { Window, windows } = windowFactory();
  const fixture = electronPageFixture(Window, applicationLayout('source'));
  const step = (id, use, args, key, value) => ({ id, use, args,
    expect: [{ path: key, op: 'equals', value }] });
  const scene = { schemaVersion: 1, id: 'false-page-success', domain: 'electron-pages', steps: [
    step('open', 'open', {}, 'opened', true),
    step('load', 'load', { page: 'ai' }, 'loaded', true),
    step('read', 'inspect', { page: 'ai' }, 'logoCount', 1),
    step('later', 'load', { page: 'shell' }, 'loaded', true),
  ] };
  try {
    const result = await runFlow(scene, fixture);
    assert.equal(result.ok, false);
    assert.equal(result.data.steps.at(-1).id, 'read');
    assert.equal(result.data.steps.at(-1).evidence, 'oracle');
    assert.equal(windows[0].reads, 1);
  } finally { fixture.close(); }
  assert.equal(windows[0].destroyed, true);
});

test('page fixture rejects stale page probes and escaped paths, and recreates after idempotent close', async () => {
  const { Window, windows } = windowFactory();
  const fixture = electronPageFixture(Window, applicationLayout('source'));
  const drivers = fixture.drivers;
  try {
    await assert.rejects(drivers.load({ page: '../account' }), /UNKNOWN_APPLICATION_PAGE/);
    await drivers.open();
    await assert.rejects(drivers.open(), /PAGE_WINDOW_ALREADY_OPEN/);
    await drivers.load({ page: 'ai' });
    await assert.rejects(drivers.inspect({ page: 'account' }), /PAGE_PROBE_MISMATCH/);
    windows[0].url = 'https://example.invalid/';
    await assert.rejects(drivers.inspect({ page: 'ai' }), /UNEXPECTED_PAGE_URL/);
    fixture.close();
    fixture.close();
    assert.equal((await drivers.inspectWindow()).open, false);
    await drivers.open();
    assert.equal(windows.length, 2);
    assert.equal(windows[0].destroyed, true);
    assert.equal((await drivers.inspectWindow()).open, true);
  } finally { fixture.close(); }
});

test('all page runtimes share one scene and UI-only selection does not rebuild the native host', () => {
  const plan = verificationPlan('interactions', { only: ['source-pages', 'generated-pages', 'packaged-sidebar'] });
  assert.deepEqual(plan.map((entry) => entry.id), ['prepare', 'source-pages', 'generated-pages', 'packaged-sidebar']);
  assert.equal(new Set(plan.slice(1).map((entry) => entry.interaction.scenario)).size, 1);
  assert.deepEqual(plan.slice(1).map((entry) => entry.interaction.runtime), ['source', 'generated', 'packaged']);
  const contract = domainContract('electron-pages');
  const drivers = Object.fromEntries(Object.keys(contract.operations).map((key) => [key, () => {}]));
  validateFlow(require('../../acceptance/flows/application-pages.json'), drivers, contract);
});
