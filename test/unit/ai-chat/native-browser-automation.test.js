'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeBrowserAutomation } = require('../../../src/app/main/services/native-browser-automation');

function fixture() {
  const calls = [];
  const downloads = [];
  let automationHandler = null;
  let listedTabs = {
    success: true, action: 'list', count: 1, activeTabId: '0',
    activeTab: { id: '0', index: 0, active: true, title: '首次页面', url: 'https://first.example/' },
    tabs: [{ id: '0', index: 0, active: true, title: '首次页面', url: 'https://first.example/' }],
  };
  const runtime = {
    listStates: () => [{
      profileId: 'profile-a', pid: 42, status: 'ready', bridgeConnected: true,
      startedAt: 100, lastHeartbeatAt: 200,
    }],
    dispatchAutomationByProcessId: async (...args) => {
      calls.push(['automation', ...args]);
      if (automationHandler) return automationHandler(...args);
      if (args[1] === 'list-tabs') return { result: listedTabs };
      if (args[1] === 'get-session-data') return { result: {
        success: true, url: 'http://127.0.0.1:4173/', cookies: [{ name: 'sid', value: 'test' }],
      } };
      if (args[1] === 'activate-tab') {
        return { result: { id: '1', index: 1, active: true, title: '目标页面', url: args[2].url } };
      }
      if (args[1] === 'automation-takeover') return { result: {
        success: true, action: args[2].action, takeoverActive: args[2].action !== 'release',
      } };
      return { result: { success: true, command: args[1] } };
    },
    focus: async (...args) => calls.push(['focus', ...args]),
    navigate: async (...args) => calls.push(['navigate', ...args]),
    openTabs: async (...args) => calls.push(['openTabs', ...args]),
    reload: async (...args) => calls.push(['reload', ...args]),
    selectFilesByProcessId: async (...args) => calls.push(['files', ...args]),
  };
  const service = createNativeBrowserAutomation({
    browserRuntimeManager: runtime,
    getTabs: () => new Map([['profile-a', {
      id: 'profile-a', fixedTitle: '工作浏览器', runtimeUrl: 'https://example.com/',
    }]]),
    browserDownloadService: {
      execute: async (args, context) => {
        downloads.push({ args, context });
        return { success: true, action: args.action };
      },
      resolveUploadPaths: (paths) => paths,
      downloadElement: async (args, trigger) => ({
        ...(await trigger('C:\\AI-Workspace\\.image.native-download')),
        success: true, action: args.action, absolute_path: 'C:\\AI-Workspace\\image.png',
      }),
    },
  });
  service.takeoverConnections.add('native:profile-a');
  return {
    calls,
    downloads,
    service,
    setAutomationHandler: (handler) => { automationHandler = handler; },
    setListedTabs: (value) => { listedTabs = value; },
  };
}

test('native automation publishes ready managed Chromium as the browser connection', () => {
  const { service } = fixture();
  const connections = service.listConnections();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].id, 'native:profile-a');
  assert.equal(connections[0].name, '工作浏览器');
  assert.equal(connections[0].platform, 'ai-free-chromium-native');
  const tools = service.getConnection(connections[0].id).tools;
  assert.equal(tools.length, 8);
  assert.equal(tools.some((tool) => tool.name === 'browser_file'), true);
  assert.equal(tools.some((tool) => tool.name === 'browser_download'), false);
  assert.equal(
    tools.find((tool) => tool.name === 'browser_action').input_schema.properties.action.enum.includes('upload_file'),
    false,
  );
  const tabProperties = tools.find((tool) => tool.name === 'browser_tab').input_schema.properties;
  assert.equal(tabProperties.id.type, 'string');
  assert.equal(tabProperties.index.type, 'number');
  const actionProperties = tools.find((tool) => tool.name === 'browser_action').input_schema.properties;
  assert.equal(actionProperties.ctrl.type, 'boolean');
  assert.equal(actionProperties.meta.type, 'boolean');
  assert.equal(actionProperties.x.type, 'number');
  assert.equal(actionProperties.y.type, 'number');
  assert.equal(actionProperties.to_x.type, 'number');
  assert.equal(actionProperties.to_y.type, 'number');
  assert.equal(actionProperties.start.type, 'number');
  assert.equal(actionProperties.end.type, 'number');
  assert.equal(actionProperties.repeat.type, 'number');
  assert.equal(actionProperties.action.enum.includes('drag'), true);
  assert.equal(actionProperties.action.enum.includes('insert_text'), true);
  assert.equal(actionProperties.action.enum.includes('set_selection'), true);
  const waitProperties = tools.find((tool) => tool.name === 'browser_wait').input_schema.properties;
  assert.deepEqual(waitProperties.condition.enum, [
    'attached', 'visible', 'hidden', 'text_contains', 'text_changed', 'url_matches',
  ]);
  assert.equal(waitProperties.observation_id.type, 'string');
});

test('browser_file download uses the active page as the trusted relative URL context', async () => {
  const { calls, downloads, service } = fixture();
  await service.dispatch('native:profile-a', 'browser_file', {
    action: 'download', url: '/og.png', page_url: 'http://spoofed.invalid/',
  });
  assert.deepEqual(calls[0], ['automation', 42, 'get-session-data', {}]);
  assert.equal(downloads[0].args.page_url, 'http://127.0.0.1:4173/');
  assert.equal(downloads[0].args.referer, 'http://127.0.0.1:4173/');
  assert.deepEqual(downloads[0].context, { pageUrl: 'http://127.0.0.1:4173/' });
});

test('browser_file download_element resolves an observed image and uses the Chromium download command', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async (_pid, command) => ({ result: command === 'observe-page' ? {
    success: true,
    items: [{ id: 'e2', kind: 'media', tag: 'img', selector: 'img', x: 20, y: 30, width: 400, height: 300 }],
  } : { success: true, resourceUrl: 'https://cdn.example.test/original.webp', tag: 'img' } }));
  await service.dispatch('native:profile-a', 'browser_observe', { filter: 'media' });
  const result = await service.dispatch('native:profile-a', 'browser_file', {
    action: 'download_element', ref: 'e2', filename: 'original.webp',
  });
  assert.equal(result.absolute_path, 'C:\\AI-Workspace\\image.png');
  assert.deepEqual(calls[1], ['automation', 42, 'download-element', {
    action: 'download_element', ref: 'e2', filename: 'original.webp',
    selector: 'img', x: 220, y: 180,
    target_path: 'C:\\AI-Workspace\\.image.native-download',
  }]);
});

test('observe and action dispatch directly to the Chromium runtime bridge', async () => {
  const { calls, service } = fixture();
  const observed = await service.dispatch('native:profile-a', 'browser_observe', { limit: 5 });
  const clicked = await service.dispatch('native:profile-a', 'browser_action', { action: 'click', selector: '#go' });
  assert.equal(observed.command, 'observe-page');
  assert.equal(clicked.command, 'perform-action');
  assert.deepEqual(calls, [
    ['automation', 42, 'observe-page', { limit: 5 }],
    ['automation', 42, 'perform-action', { action: 'click', selector: '#go' }],
  ]);
});

test('browser control explicitly acquires, reports and releases Chromium takeover', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  let takeoverActive = false;
  service.takeoverConnections.delete('native:profile-a');
  setAutomationHandler(async (_pid, command, args) => {
    if (command !== 'automation-takeover') return { result: { success: true } };
    if (args.action === 'acquire') takeoverActive = true;
    if (args.action === 'release') takeoverActive = false;
    return { result: { success: true, action: args.action, takeoverActive } };
  });

  const acquired = await service.dispatch('native:profile-a', 'browser_control', { action: 'acquire' });
  const status = await service.dispatch('native:profile-a', 'browser_control', { action: 'status' });
  const released = await service.dispatch('native:profile-a', 'browser_control', { action: 'release' });
  assert.equal(acquired.takeoverActive, true);
  assert.equal(status.takeoverActive, true);
  assert.equal(released.takeoverActive, false);
  assert.equal(takeoverActive, false);
  assert.deepEqual(calls.map((call) => call[3].action), ['acquire', 'status', 'release']);
});

test('all MCP mutations stay read-only before explicit browser takeover', async () => {
  const { calls, service } = fixture();
  service.takeoverConnections.delete('native:profile-a');

  const action = await service.dispatch('native:profile-a', 'browser_action', {
    action: 'click', selector: '#submit',
  });
  const navigation = await service.dispatch('native:profile-a', 'browser_tab', {
    action: 'navigate', url: 'https://example.com/',
  });
  const observed = await service.dispatch('native:profile-a', 'browser_observe', { limit: 5 });

  assert.equal(action.errorCode, 'BROWSER_TAKEOVER_REQUIRED');
  assert.equal(navigation.errorCode, 'BROWSER_TAKEOVER_REQUIRED');
  assert.equal(observed.success, true);
  assert.deepEqual(calls, [['automation', 42, 'observe-page', { limit: 5 }]]);
});

test('observed refs click the validated exposed point instead of re-querying a generic selector', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async (_pid, command) => ({ result: command === 'observe-page' ? {
    success: true,
    items: [{
      id: 'e1', selector: 'button', x: 120, y: 40, width: 80, height: 30,
      clickX: 126, clickY: 46,
    }],
  } : { success: true } }));
  const observed = await service.dispatch('native:profile-a', 'browser_observe', { limit: 5, text_limit: 5000 });
  assert.match(observed.observationId, /^obs-/);
  assert.equal(observed.items[0].observationId, observed.observationId);
  assert.equal(observed.requestedTextLimit, 5000);
  assert.equal(observed.appliedTextLimit, 500);
  assert.equal(observed.limitCapped, true);
  await service.dispatch('native:profile-a', 'browser_action', {
    action: 'click', ref: 'e1', observation_id: observed.observationId,
  });
  assert.deepEqual(calls[1], ['automation', 42, 'perform-action', {
    action: 'click', ref: 'e1', observation_id: observed.observationId,
    selector: 'button', x: 126, y: 46,
  }]);
});

test('observed refs reject an explicitly stale observation snapshot', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async (_pid, command) => ({ result: command === 'observe-page' ? {
    success: true, items: [{ id: 'e1', selector: '#save', x: 1, y: 2, width: 20, height: 10 }],
  } : { success: true } }));
  const observed = await service.dispatch('native:profile-a', 'browser_observe', {});
  const result = await service.dispatch('native:profile-a', 'browser_action', {
    action: 'click', ref: 'e1', observation_id: `${observed.observationId}-stale`,
  });
  assert.equal(result.errorCode, 'OBSERVATION_MISMATCH');
  assert.equal(result.suggestedTool, 'browser_observe');
  assert.equal(calls.filter((call) => call[2] === 'perform-action').length, 0);
});

test('an older observed ref safely recovers through one unique unchanged locator', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  let observations = 0;
  setAutomationHandler(async (_pid, command) => {
    if (command === 'perform-action') return { result: { success: true, action: 'click' } };
    observations += 1;
    if (observations === 2) return { result: {
      success: true, url: 'https://example.test/editor',
      items: [{
        id: 'e2', tag: 'button', role: 'button', label: '取消', selector: '#cancel',
        stableRef: 'node-cancel', selectorUnique: true, selectorStability: 'high',
        x: 10, y: 10, width: 40, height: 20,
      }],
    } };
    return { result: {
      success: true, url: 'https://example.test/editor',
      items: [{
        id: 'e1', tag: 'button', role: 'button', label: '保存', selector: '#save',
        stableRef: 'node-save', selectorUnique: true, selectorStability: 'high',
        x: observations === 1 ? 10 : 50, y: 20, width: 60, height: 30,
      }],
    } };
  });

  const old = await service.dispatch('native:profile-a', 'browser_observe', {});
  await service.dispatch('native:profile-a', 'browser_observe', {});
  const result = await service.dispatch('native:profile-a', 'browser_action', {
    action: 'click', ref: 'e1', observation_id: old.observationId,
  });

  assert.equal(result.success, true);
  assert.equal(result.refRecovered, true);
  assert.equal(result.recoveryStrategy, 'unique-observed-selector');
  assert.equal(observations, 3);
  assert.deepEqual(calls.at(-1), ['automation', 42, 'perform-action', {
    action: 'click', ref: 'e1', observation_id: old.observationId,
    selector: '#save', x: 80, y: 35,
  }]);
});

test('legacy Chromium overview returns inferred regions without leaking flat page items', async () => {
  const { service, setAutomationHandler } = fixture();
  setAutomationHandler(async () => ({ result: {
    success: true, viewport: { width: 1000, height: 700 },
    items: [
      { id: 'e1', kind: 'interactive', tag: 'div', text: '首页 笔记管理 数据看板', x: 0, y: 80, width: 200, height: 620 },
      { id: 'e2', kind: 'text', tag: 'div', text: '笔记标题', x: 260, y: 160, width: 400, height: 40 },
    ],
  } }));

  const result = await service.dispatch('native:profile-a', 'browser_observe', {
    mode: 'overview', include_regions: true, max_depth: 3,
  });

  assert.equal(result.mode, 'overview');
  assert.deepEqual(result.items, []);
  assert.equal(result.returnedCount, 0);
  assert(result.regions.some((region) => region.role === 'navigation'));
  assert(result.regions.some((region) => region.role === 'main'));
  assert.equal(result.regionDetection.source, 'application-item-layout-fallback');
  assert.equal(result.query.appliedLayer, 'application-fallback');
});

test('legacy Chromium rectangle region actually removes out-of-region items', async () => {
  const { service, setAutomationHandler } = fixture();
  setAutomationHandler(async () => ({ result: {
    success: true, viewport: { width: 1000, height: 700 },
    items: [
      { id: 'left', kind: 'interactive', tag: 'div', text: '笔记管理', x: 20, y: 160, width: 160, height: 40 },
      { id: 'top', kind: 'interactive', tag: 'button', text: '发布笔记', x: 24, y: 80, width: 160, height: 40 },
      { id: 'main', kind: 'text', tag: 'div', text: '主内容', x: 300, y: 160, width: 200, height: 40 },
    ],
  } }));

  const result = await service.dispatch('native:profile-a', 'browser_observe', {
    mode: 'elements', region: { x: 0, y: 140, width: 208, height: 648 },
    region_mode: 'centerInside', padding: 8, kinds: ['interactive'],
  });

  assert.deepEqual(result.items.map((item) => item.id), ['left']);
  assert.equal(result.regionApplied, true);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.items[0].insideRegion, true);
  assert.equal(result.query.regionApplied, true);
  assert.deepEqual(result.query.appliedFilters.sort(), ['kinds', 'region']);
  assert.equal(result.query.appliedLayer, 'application-fallback');
});

test('legacy Chromium semantic region resolves overview refs and never falls back globally', async () => {
  const { service, setAutomationHandler } = fixture();
  setAutomationHandler(async () => ({ result: {
    success: true, viewport: { width: 1000, height: 700 },
    items: [
      { id: 'sidebar', kind: 'interactive', tag: 'div', text: '首页 笔记管理 数据看板', x: 0, y: 80, width: 200, height: 620 },
      { id: 'menu', kind: 'interactive', tag: 'div', text: '笔记管理', x: 20, y: 160, width: 160, height: 40 },
      { id: 'main', kind: 'text', tag: 'div', text: '主内容', x: 300, y: 160, width: 200, height: 40 },
    ],
  } }));

  const result = await service.dispatch('native:profile-a', 'browser_observe', {
    mode: 'elements', region: { role: 'navigation', label: '侧边栏', match: 'best' },
  });
  assert.equal(result.success, true);
  assert.equal(result.region.role, 'navigation');
  assert(result.items.every((item) => item.x < 210));
  assert.equal(result.items.find((item) => item.id === 'sidebar').role, 'navigation');
  assert.equal(result.items.find((item) => item.id === 'menu').role, 'menuitem');
  assert.equal(result.items.find((item) => item.id === 'menu').containerRef, result.region.ref);

  const missing = await service.dispatch('native:profile-a', 'browser_observe', {
    mode: 'elements', region: { role: 'dialog', label: '不存在' },
  });
  assert.equal(missing.success, false);
  assert.equal(missing.errorCode, 'REGION_NOT_FOUND');
  assert.deepEqual(missing.items, []);
});

test('accessibility fallback refs use observed coordinates and stale refs fail with recovery guidance', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async (_pid, command) => ({ result: command === 'observe-page' ? {
    items: [{
      id: 'e-fallback', kind: 'interactive', tag: 'unknown', accessibilityFallback: true,
      clickX: 245.5, clickY: 118.25, text: '正文编辑器',
    }],
  } : { success: true } }));
  await service.dispatch('native:profile-a', 'browser_observe', { limit: 10 });

  await service.dispatch('native:profile-a', 'browser_action', { action: 'click', ref: 'e-fallback' });
  assert.deepEqual(calls.at(-1), [
    'automation', 42, 'perform-action',
    { action: 'click', ref: 'e-fallback', x: 245.5, y: 118.25 },
  ]);

  const expired = await service.dispatch(
    'native:profile-a', 'browser_action', { action: 'click', ref: 'e-before-latest-observe' },
  );
  assert.equal(expired.errorCode, 'OBSERVED_REF_EXPIRED');
  assert.equal(expired.suggestedTool, 'browser_observe');
  assert.match(expired.error, /最近一次 browser_observe/);
});

test('observed file inputs are blocked before Chromium can open a system chooser', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async (_pid, command) => ({ result: command === 'observe-page' ? {
    success: true,
    items: [{
      id: 'e-file', tag: 'input', inputType: 'file', requiresFileUpload: true,
      selector: 'input[name="attachment"]', x: 20, y: 30, width: 120, height: 30,
    }],
  } : { success: true } }));

  await service.dispatch('native:profile-a', 'browser_observe', { limit: 20 });
  const result = await service.dispatch('native:profile-a', 'browser_action', {
    action: 'click', ref: 'e-file',
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'FILE_UPLOAD_REQUIRED');
  assert.equal(result.requiresFile, true);
  assert.equal(result.suggestedTool, 'browser_file');
  assert.match(result.error, /path 或 paths/);
  assert.equal(calls.filter((call) => call[2] === 'perform-action').length, 0);
});

test('explicit file input selectors are blocked without a prior observation', async () => {
  const { calls, service } = fixture();
  const result = await service.dispatch('native:profile-a', 'browser_action', {
    action: 'click', selector: 'form input.accepted[type="file"]',
  });

  assert.equal(result.errorCode, 'FILE_UPLOAD_REQUIRED');
  assert.equal(result.suggestedAction, 'upload');
  assert.deepEqual(calls, []);
});

test('explicit text coordinates override an observed ref center while retaining its selector', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async (_pid, command) => ({ result: command === 'observe-page' ? {
    success: true,
    items: [{
      id: 'e1', selector: 'textarea', x: 120, y: 40, width: 300, height: 80,
      clickX: 126, clickY: 46,
    }],
  } : { success: true } }));
  await service.dispatch('native:profile-a', 'browser_observe', { limit: 5 });
  await service.dispatch('native:profile-a', 'browser_action', {
    action: 'click', ref: 'e1', x: 260, y: 75,
  });
  assert.deepEqual(calls[1], ['automation', 42, 'perform-action', {
    action: 'click', ref: 'e1', selector: 'textarea', x: 260, y: 75,
  }]);
});

test('native tab and session operations do not enqueue extension tasks', async () => {
  const { calls, service } = fixture();
  await service.dispatch('native:profile-a', 'browser_tab', { action: 'replace', url: 'example.org' });
  await service.dispatch('native:profile-a', 'browser_file', { action: 'save_session' });
  assert.deepEqual(calls[0], ['navigate', 'profile-a', 'chromium', 'https://example.org/']);
  assert.deepEqual(calls[1], ['automation', 42, 'get-session-data', {}]);
});

test('browser_tab navigate opens a new Chromium tab and brings it to the foreground', async () => {
  const { calls, service } = fixture();
  const result = await service.dispatch('native:profile-a', 'browser_tab', {
    action: 'navigate', url: 'https://example.org/new',
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    ['openTabs', 'profile-a', 'chromium', ['https://example.org/new']],
    ['focus', 'profile-a', 'chromium'],
  ]);
});

test('browser_tab list reads the live Chromium tab strip on every call', async () => {
  const { calls, service, setListedTabs } = fixture();
  const first = await service.dispatch('native:profile-a', 'browser_tab', { action: 'list' });
  setListedTabs({
    success: true, action: 'list', count: 2, activeTabId: '1',
    activeTab: { id: '1', index: 1, active: true, title: '当前页面', url: 'https://current.example/' },
    tabs: [
      { id: '0', index: 0, active: false, title: '首次页面', url: 'https://first.example/' },
      { id: '1', index: 1, active: true, title: '当前页面', url: 'https://current.example/' },
    ],
  });
  const current = await service.dispatch('native:profile-a', 'browser_tab', { action: 'list' });
  assert.equal(first.activeTab.url, 'https://first.example/');
  assert.equal(current.activeTab.url, 'https://current.example/');
  assert.equal(current.count, 2);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ['automation', 42, 'list-tabs'],
    ['automation', 42, 'list-tabs'],
  ]);
});

test('browser_tab switch activates the matching Chromium tab instead of only focusing the window', async () => {
  const { calls, service } = fixture();
  const url = 'http://127.0.0.1:4173/exam-assets/meeting-brief.html';
  const switched = await service.dispatch('native:profile-a', 'browser_tab', { action: 'switch', url });
  assert.deepEqual(switched, {
    success: true, action: 'switch', id: '1', index: 1, active: true, title: '目标页面', url,
  });
  assert.deepEqual(calls, [
    ['automation', 42, 'activate-tab', { url, index: -1 }],
    ['focus', 'profile-a', 'chromium'],
  ]);
});

test('browser_control explains that an old Chromium runtime must be rebuilt instead of reporting permission denial', async () => {
  const { service, setAutomationHandler } = fixture();
  setAutomationHandler(async () => {
    const error = new Error('Runtime Bridge 命令不在白名单');
    error.code = 'COMMAND_NOT_ALLOWED';
    throw error;
  });

  const result = await service.dispatch('native:profile-a', 'browser_control', { action: 'acquire' });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'BROWSER_RUNTIME_UPDATE_REQUIRED');
  assert.equal(result.takeoverActive, false);
  assert.equal(result.readOnly, true);
  assert.match(result.error, /服务器重启不会更新本地浏览器内核/);
});

test('browser_file owns uploads and browser_action rejects the removed upload action', async () => {
  const { calls, service } = fixture();
  const uploaded = await service.dispatch('native:profile-a', 'browser_file', {
    action: 'upload', path: 'C:/workspace/report.txt', selector: 'input[type=file]', page_url: 'https://example.com/',
  });
  assert.equal(uploaded.action, 'upload');
  assert.equal(calls[0][0], 'files');
  assert.equal(calls[1][2], 'perform-action');
  await assert.rejects(
    service.dispatch('native:profile-a', 'browser_action', { action: 'upload_file', path: 'report.txt' }),
    /browser_file action=upload/,
  );
});

test('browser_file exposes an AI workspace file for direct HeySure upload without a webpage', async () => {
  const { calls, service } = fixture();
  const result = await service.dispatch('native:profile-a', 'browser_file', {
    action: 'upload_to_server', path: 'C:/workspace/report.txt',
  });
  assert.equal(result.action, 'upload_to_server');
  assert.equal(result.absolute_path, 'C:/workspace/report.txt');
  assert.equal(result.local_workspace_file, true);
  assert.deepEqual(calls, []);
});

test('browser_file treats file URL download with save_to_server as a compatible direct upload', async () => {
  const { calls, service } = fixture();
  const result = await service.dispatch('native:profile-a', 'browser_file', {
    action: 'download', url: 'file:///C:/workspace/grok-video.mp4', save_to_server: true,
  });
  assert.equal(result.action, 'upload_to_server');
  assert.equal(result.absolute_path, 'C:\\workspace\\grok-video.mp4');
  assert.deepEqual(calls, []);
});

test('browser_wait reacquires the active page after a timed-out document attempt', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  let attempts = 0;
  setAutomationHandler(async (_pid, command) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('旧页面已销毁');
      error.code = 'INPUT_TARGET_UNAVAILABLE';
      throw error;
    }
    return { result: attempts === 2
      ? { success: false, action: 'wait', error: '等待元素超时', errorCode: 'WAIT_TIMEOUT' }
      : { success: true, action: 'wait', found: true } };
  });

  const result = await service.dispatch('native:profile-a', 'browser_wait', {
    selector: '#mail-send-status', timeout_ms: 5000,
  });

  assert.equal(result.success, true);
  assert.equal(attempts, 3);
  assert.equal(calls[0][2], 'perform-action');
  assert.equal(calls[0][3].timeout_ms, 750);
  assert.equal(calls[2][3].selector, '#mail-send-status');
});

test('browser_wait reports selector and total timeout after all attempts expire', async () => {
  const { service, setAutomationHandler } = fixture();
  setAutomationHandler(async () => ({
    result: { success: false, action: 'wait', error: '等待元素超时', errorCode: 'WAIT_TIMEOUT' },
  }));

  const result = await service.dispatch('native:profile-a', 'browser_wait', {
    selector: '#missing', timeout_ms: 100,
  });

  assert.deepEqual(result, {
    success: false,
    action: 'wait',
    error: '等待元素超时: #missing',
    errorCode: 'WAIT_TIMEOUT',
    selector: '#missing',
    timeout_ms: 100,
  });
});

test('browser_wait forwards text conditions and captures the first value for text_changed', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  let attempts = 0;
  setAutomationHandler(async () => {
    attempts += 1;
    return { result: attempts === 1
      ? { success: false, errorCode: 'WAIT_TIMEOUT', currentValue: '处理中' }
      : { success: true, action: 'wait', condition: 'text_changed', currentValue: '处理完成' } };
  });

  const result = await service.dispatch('native:profile-a', 'browser_wait', {
    selector: '.status', condition: 'text_changed', timeout_ms: 5000,
  });

  assert.equal(result.success, true);
  assert.equal(attempts, 2);
  assert.equal(calls[0][3].condition, 'text_changed');
  assert.equal(calls[0][3].initial_value, undefined);
  assert.equal(calls[1][3].initial_value, '处理中');
});

test('browser_wait supports URL conditions without an element selector', async () => {
  const { calls, service, setAutomationHandler } = fixture();
  setAutomationHandler(async () => ({ result: {
    success: true, action: 'wait', condition: 'url_matches',
    currentValue: 'https://example.test/dashboard',
  } }));

  const result = await service.dispatch('native:profile-a', 'browser_wait', {
    condition: 'url_matches', value: '/dashboard', timeout_ms: 1000,
  });

  assert.equal(result.success, true);
  assert.equal(calls[0][2], 'perform-action');
  assert.equal(calls[0][3].value, '/dashboard');
});

test('browser_wait rejects an old runtime that silently ignores conditions', async () => {
  const { service, setAutomationHandler } = fixture();
  setAutomationHandler(async () => ({ result: {
    success: true, action: 'wait', found: true,
  } }));

  const result = await service.dispatch('native:profile-a', 'browser_wait', {
    selector: '#save', condition: 'visible', timeout_ms: 1000,
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'BROWSER_RUNTIME_UPDATE_REQUIRED');
  assert.equal(result.retryable, false);
});
