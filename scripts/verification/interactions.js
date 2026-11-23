'use strict';

// This inventory covers real interactive acceptance entrypoints. Mocked unit and
// integration interactions remain in the ordinary tests suite.
/** @typedef {{id: string, file: string, scope: string, timeoutMs?: number, args?: string[],
 * node?: boolean, manual?: boolean, reason?: string, packaged?: boolean, runtime?: string,
 * configurable?: boolean, scenario?: string, domain?: string}} Interaction */
/** @type {Interaction[]} */
const interactions = [
  { id: 'embed-smoke', file: 'smoke-chromium-embed.js', scope: 'native-window' },
  { id: 'chromium-phase2', file: 'accept-chromium-phase2.js', scope: 'native-window', timeoutMs: 10800000 },
  { id: 'chromium-input', file: 'accept-chromium-input.js', scope: 'native-input' },
  { id: 'chromium-phase3', file: 'accept-chromium-phase3.js', scope: 'native-protocol' },
  { id: 'chromium-alignment', file: 'accept-native-browser-codex-alignment.js', scope: 'browser-tools',
    scenario: 'test/acceptance/flows/native-alignment.json', configurable: true, domain: 'native-browser' },
  { id: 'native-workflow', file: 'accept-native-browser-codex-alignment.js', scope: 'browser-workflow',
    args: ['--workflow-only'], scenario: 'test/acceptance/flows/native-workflow.json', configurable: true, domain: 'native-browser' },
  { id: 'mcp-debug-panel', file: 'accept-native-browser-codex-alignment.js', scope: 'browser-tools',
    args: ['--mcp-debug-panel'] },
  { id: 'browser-settings-ui', file: 'check-browser-settings-ui.js', scope: 'electron-ui' },
  ...['home-workspace', 'account-preferences'].flatMap((domain) =>
    ['source', 'generated', 'packaged'].map((runtime) => ({
    id: `${domain}-${runtime}`, file: 'check-browser-settings-ui.js',
    scope: runtime === 'packaged' ? 'packaged-ui' : 'electron-ui', packaged: runtime === 'packaged',
    args: [domain === 'home-workspace' ? '--home-only' : '--account-only', '--runtime', runtime],
    runtime, configurable: true, scenario: `test/acceptance/flows/${domain}.json`, domain,
  }))),
  { id: 'remote-browser-peer', file: 'check-remote-browser-peer.js', scope: 'electron-ui', runtime: 'source', configurable: true,
    scenario: 'test/acceptance/flows/remote-browser-peer.json', domain: 'remote-peer' },
  { id: 'remote-browser-peer-generated', file: 'check-remote-browser-peer.js', scope: 'electron-ui',
    args: ['--runtime', 'generated'], runtime: 'generated', configurable: true,
    scenario: 'test/acceptance/flows/remote-browser-peer.json', domain: 'remote-peer' },
  { id: 'remote-browser-peer-packaged', file: 'check-remote-browser-peer.js', scope: 'packaged-ui', packaged: true,
    args: ['--runtime', 'packaged'], runtime: 'packaged', configurable: true,
    scenario: 'test/acceptance/flows/remote-browser-peer.json', domain: 'remote-peer' },
  { id: 'source-pages', file: 'check-packaged-sidebar-assets.js', scope: 'electron-ui',
    args: ['--runtime', 'source'], runtime: 'source', configurable: true,
    scenario: 'test/acceptance/flows/application-pages.json', domain: 'electron-pages' },
  { id: 'generated-pages', file: 'check-packaged-sidebar-assets.js', scope: 'electron-ui',
    args: ['--runtime', 'generated'], runtime: 'generated', configurable: true,
    scenario: 'test/acceptance/flows/application-pages.json', domain: 'electron-pages' },
  { id: 'packaged-sidebar', file: 'check-packaged-sidebar-assets.js', scope: 'packaged-ui', packaged: true,
    runtime: 'packaged', configurable: true, scenario: 'test/acceptance/flows/application-pages.json', domain: 'electron-pages' },
  { id: 'session-storage', file: 'check-session-storage.js', scope: 'electron-storage' },
  { id: 'chromium-media', file: 'check-chromium-media.js', scope: 'headless-browser', node: true },
  { id: 'site-data-migration', file: 'check-site-data-migration.js', scope: 'headless-browser', node: true },
  { id: 'installed-mcp', file: 'accept-installed-mcp.js', scope: 'installed-user-session', manual: true,
    reason: '需要明确指定安装入口和独立测试浏览器；自动验证不连接日常用户会话' },
];

const nonInteractive = {
  'check-browser-observe.js': 'static-contract',
  'check-chromium-embedded-policy.js': 'static-contract',
  'check-chromium-handshake.js': 'mock-protocol',
  'check-extension-compat.js': 'mock-extension',
  'check-extension-refresh.js': 'mock-extension',
  'check-native-host-load.js': 'native-load',
  'native-browser-workflow-scenarios.js': 'fixture-and-flow-driver',
  'mcp-debug-panel-scenario.js': 'fixture-and-flow-driver',
  'verify-packaged-runtime.js': 'packaged-layout',
};

function interactionChecks() {
  return interactions.filter((entry) => !entry.manual).map((entry) => ({
    id: entry.id, description: `${entry.scope}: ${entry.file}`,
    args: [...(entry.node ? [`test/acceptance/scripts/${entry.file}`]
      : ['test/helpers/flows/electron-process.js', entry.file]), ...(entry.args || [])],
    timeoutMs: entry.timeoutMs || 600000, windows: true,
    after: ['prepare', ...(needsNativeHost(entry) ? ['native-build'] : [])],
    requiredFiles: ['node_modules/electron/dist/electron.exe',
      ...(entry.packaged ? ['appbuild/win-unpacked/resources/app.asar'] : []),
      ...(needsNativeHost(entry)
        ? ['native/browser-host/build/Release/browser_host.node', 'resources/chromium/ai-free-browser.exe'] : [])],
    interaction: { scope: entry.scope, configurable: Boolean(entry.configurable), scenario: entry.scenario,
      domain: entry.domain, runtime: entry.runtime },
  }));
}

function needsNativeHost(entry) {
  return ['native-window', 'native-input', 'native-protocol', 'browser-tools', 'browser-workflow', 'headless-browser'].includes(entry.scope);
}

module.exports = { interactions, nonInteractive, interactionChecks };
