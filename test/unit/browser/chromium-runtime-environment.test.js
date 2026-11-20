'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildChromiumProfileArgs } = require('../../../src/app/backend/browser-runtime/chromium-profile-args');
const { snapshotAppliedChromiumProfile } = require('../../../src/app/backend/browser-runtime/chromium-profile-snapshot');
const {
  prepareChromiumProfileEnvironment,
} = require('../../../src/app/backend/browser-runtime/chromium-runtime-environment');
const { ChromiumLaunchResources } = require('../../../src/app/backend/browser-runtime/chromium-launch-resources');
const { launchChromiumProfile } = require('../../../src/app/backend/browser-runtime/chromium-runtime-launch');

test('launch profile uses an isolated auth bridge and document injector without exposing credentials', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runtime-environment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = {
    paths: { root },
    profile: {
      browserSettingsSnapshot: { proxy: { username: 'private-user', password: 'private-password' } },
      environmentSettings: {
        cpu: 12,
        secChUa: { mode: 'custom', brands: [{ brand: 'Custom', version: '150' }] },
      },
      extensionPaths: [],
      proxyAuthentication: {
        protocol: 'http', host: '127.0.0.1', port: 8123,
        username: 'private-user', password: 'private-password',
      },
      proxyBypassList: '<local>',
      proxyServer: 'http://127.0.0.1:8123',
    },
  };

  context.resources = new ChromiumLaunchResources(context.paths, {}, null);
  t.after(() => context.resources.dispose({ processExited: true }));
  const launchProfile = await prepareChromiumProfileEnvironment(context);
  const args = buildChromiumProfileArgs({}, launchProfile, {});
  const snapshot = snapshotAppliedChromiumProfile(context.profile, args);

  assert.match(launchProfile.proxyServer, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(launchProfile.proxyServer, context.profile.proxyServer);
  assert.ok(args.some((argument) => argument.startsWith('--load-extension=')));
  assert.doesNotMatch(JSON.stringify(args), /private-user|private-password/);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-user|private-password/);
  const script = fs.readFileSync(path.join(context.resources.environmentExtensionDir, 'main.js'), 'utf8');
  assert.match(script, /hardwareConcurrency/);
  assert.match(script, /Custom/);

  await context.resources.dispose({ processExited: true });
  assert.equal(fs.existsSync(context.resources.environmentExtensionDir), false);
});

test('failed profile launch closes the proxy bridge and removes its environment extension', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runtime-launch-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let state = { status: 'starting' };
  let bridgeClosed = false;
  let commandClosed = false;
  let hostDestroyed = false;
  let lockReleased = false;
  const context = {
    profileId: 'failed-environment',
    paths: { root },
    hostHwnd: 'host-window',
    commandClient: { close: async () => { commandClosed = true; } },
    profile: {
      extensionPaths: [],
      environmentSettings: { cpu: 8 },
      proxyAuthentication: {
        protocol: 'http', host: '127.0.0.1', port: 8123,
        username: 'private-user', password: 'private-password',
      },
    },
  };
  context.resources = new ChromiumLaunchResources(context.paths, {
    destroyHostWindow: () => { hostDestroyed = true; },
  }, null);
  context.resources.hostHwnd = context.hostHwnd;
  context.resources.commandClient = context.commandClient;
  t.after(() => context.resources.dispose({ processExited: true }));
  const runtime = {
    logger: null,
    instances: new Map(),
    isProfileRunning: () => false,
    prepareProfileLaunch: () => context,
    createProfileInstance: async (profileContext) => {
      await prepareChromiumProfileEnvironment(profileContext);
      const close = profileContext.resources.proxyAuthBridge.close.bind(profileContext.resources.proxyAuthBridge);
      profileContext.resources.proxyAuthBridge.close = async () => {
        await close();
        bridgeClosed = true;
      };
      throw new Error('simulated launch failure');
    },
    store: { releaseLock: () => { lockReleased = true; } },
    stateStore: {
      getState: () => state,
      releaseLock: () => { lockReleased = true; },
      patchState: (_id, update) => { state = { ...state, ...update }; },
    },
    unbindParentWindowFocus() {},
    windowBridge: { destroyHostWindow: () => { hostDestroyed = true; } },
  };

  await assert.rejects(
    launchChromiumProfile(runtime, { profileId: context.profileId }),
    /simulated launch failure/,
  );

  assert.equal(bridgeClosed, true);
  assert.equal(commandClosed, true);
  assert.equal(hostDestroyed, true);
  assert.equal(lockReleased, true);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith('runtime-environment-')), false);
  assert.equal(state.status, 'crashed');
});
