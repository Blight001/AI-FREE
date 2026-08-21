'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_HEYSURE_SERVER,
  createAiServerDeviceService,
  normalizeLoginConfig,
  normalizeToolCatalog,
} = require('../../../src/app/main/features/ai-chat/ai-server-device-service');

class FakeSocket {
  constructor() {
    this.connected = false;
    this.handlers = new Map();
    this.sent = [];
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  connect() {
    this.connected = true;
    this.serverEmit('connect');
  }

  disconnect() {
    this.connected = false;
  }

  emit(event, payload) {
    this.sent.push({ event, payload });
  }

  serverEmit(event, payload) {
    return this.handlers.get(event)?.(payload);
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loginResponse(token = 'test-token', socketUrl = 'http://socket.example:3000') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, agent_socket_url: socketUrl }),
  };
}

test('AI 服务器登录默认使用 HeySure 地址且校验必填字段', () => {
  assert.equal(DEFAULT_HEYSURE_SERVER, 'http://49.234.181.190:58150');
  assert.equal(normalizeLoginConfig({ account: 'user', password: 'secret' }).server, DEFAULT_HEYSURE_SERVER);
  assert.throws(() => normalizeLoginConfig({ account: '', password: 'secret' }), /请输入账号/);
  assert.throws(() => normalizeLoginConfig({ account: 'user', password: '', server: 'ftp://invalid' }), /HTTP/);
});

test('当前 MCP 工具转换为不占用保留前缀的 aifree 工具目录', () => {
  const catalog = normalizeToolCatalog({ tools: [{
    name: 'browser_tab',
    description: '管理标签页',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
  }] });
  assert.deepEqual(catalog.tools, [{
    name: 'aifree.browser+tab',
    description: '管理标签页',
    input_schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    destructive: false,
  }]);
  assert.equal(catalog.routes.get('aifree.browser+tab'), 'browser_tab');
  assert.equal(catalog.routes.get('aifree.browser_tab'), 'browser_tab');
});

test('aifree 目录保留软件内置 MCP 的完整 schema 和一对一执行路由', () => {
  const internalTools = ['windows_tab', 'run_command', 'browser_observe', 'browser_tab', 'browser_wait']
    .map((name) => ({
      name,
      description: `${name} description`,
      inputSchema: {
        type: 'object', properties: { action: { type: 'string', enum: ['list', 'run'] } }, required: ['action'],
      },
    }));
  const catalog = normalizeToolCatalog({ tools: internalTools });

  assert.deepEqual(
    catalog.tools.map((tool) => tool.name),
    internalTools.map((tool) => `aifree.${tool.name.replaceAll('_', '+')}`),
  );
  for (const source of internalTools) {
    const remote = catalog.tools.find((tool) => tool.name === `aifree.${source.name.replaceAll('_', '+')}`);
    assert.deepEqual(remote.input_schema, source.inputSchema);
    assert.equal(catalog.routes.get(remote.name), source.name);
  }
});

test('HeySure 的 browser_file schema 额外暴露成员工作区 file_ref 输入', () => {
  const catalog = normalizeToolCatalog({ tools: [{
    name: 'browser_file',
    description: '上传文件',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, path: { type: 'string' } },
      required: ['action'],
    },
  }] });
  const schema = catalog.tools[0].input_schema;
  assert.equal(schema.properties.file_ref.pattern, '^file_[a-f0-9]{32}$');
  assert.equal(schema.properties.file_refs.maxItems, 5);
  assert.deepEqual(schema.required, ['action']);
  assert.match(catalog.tools[0].description, /HeySure.*file_ref/);
});

test('登录后注册 custom 设备并将派发任务恰好回一个终态', async () => {
  const socket = new FakeSocket();
  const calls = [];
  const service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse(),
    createSocket: () => socket,
    computeDeviceId: async () => 'machine-123',
    getTools: () => ({ tools: [{
      name: 'browser_action', description: '执行浏览器动作',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    }] }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { done: true };
    },
    remoteControl: {},
  });

  const result = await service.login({
    server: 'http://api.example:3000', account: 'alice', password: 'secret', serviceName: '工作电脑',
  });
  assert.equal(result.ok, true);
  await tick();
  const registration = socket.sent.find((entry) => entry.event === 'device:register')?.payload;
  assert.equal(registration.id, 'ai-free-machine-123');
  assert.equal(registration.deviceType, 'custom');
  assert.equal(registration.platform, 'ai-free-custom-service');
  assert.equal(
    registration.aiDescription,
    '用于连接 AI-FREE，调用其中已启用的软件窗口、浏览器与自动化 MCP 工具',
  );
  assert.equal(registration.catalogProtocolVersion, 2);
  assert.deepEqual(registration.capabilities, ['aifree.browser+action', 'remote_control']);
  assert.equal(registration.toolDefs[0].input_schema.required[0], 'action');

  socket.serverEmit('device:registered', { aiConfigId: 7 });
  await socket.serverEmit('task:dispatch', {
    taskId: 'task-1', tool: 'aifree.browser+action', args: { action: 'click' },
  });
  await tick();
  await socket.serverEmit('task:dispatch', {
    taskId: 'task-1', tool: 'aifree.browser+action', args: { action: 'click' },
  });
  await tick();
  assert.deepEqual(calls, [{ name: 'browser_action', args: { action: 'click' } }]);
  assert.equal(socket.sent.filter((entry) => entry.event === 'task:result').length, 1);
  assert.equal(service.status().registered, true);
  service.stop();
});

test('HeySure 启动器 profile 压过外部地址和已保存地址，直接启动仍接受显式地址', () => {
  const input = { server: 'https://saved.example', account: 'user', password: 'secret' };
  assert.equal(normalizeLoginConfig(input, {
    HEYSURE_FORCE_SERVER_MODE: 'true',
    HEYSURE_LOCAL_TEST: 'false',
    HEYSURE_SERVER: 'https://inherited.example',
  }).server, 'http://49.234.181.190:58150');
  assert.equal(normalizeLoginConfig(input, {
    HEYSURE_FORCE_SERVER_MODE: 'true',
    HEYSURE_LOCAL_TEST: 'true',
    HEYSURE_SERVER: 'https://inherited.example',
  }).server, 'http://127.0.0.1:3000');
  assert.equal(normalizeLoginConfig(input, {
    HEYSURE_SERVER: 'https://explicit.example/base/',
  }).server, 'https://explicit.example/base');
});

test('HeySure profile 切换重新登录并只向新 socket 注册新 token', async () => {
  const env = {
    HEYSURE_FORCE_SERVER_MODE: 'true',
    HEYSURE_LOCAL_TEST: 'false',
    HEYSURE_SERVER: 'https://inherited.example',
  };
  const requests = [];
  const sockets = [];
  const service = createAiServerDeviceService({
    env,
    hasVipAccess: () => true,
    fetch: async (url) => {
      requests.push(url);
      const local = url.startsWith('http://127.0.0.1:3000/');
      return loginResponse(local ? 'local-token' : 'remote-token', local
        ? 'http://127.0.0.1:3000'
        : 'http://49.234.181.190:58150');
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    getTools: () => ({ tools: [] }),
  });

  await service.login({ server: 'https://saved.example', account: 'alice', password: 'secret' });
  await tick();
  env.HEYSURE_LOCAL_TEST = 'true';
  await service.login({ server: 'https://saved.example', account: 'alice', password: 'secret' });
  await tick();

  assert.deepEqual(requests, [
    'http://49.234.181.190:58150/api/auth/login',
    'http://127.0.0.1:3000/api/auth/login',
  ]);
  assert.equal(sockets[0].connected, false);
  assert.equal(sockets[0].sent.find((entry) => entry.event === 'device:register').payload.token, 'remote-token');
  assert.equal(sockets[1].sent.find((entry) => entry.event === 'device:register').payload.token, 'local-token');
  service.stop();
});

test('注册成功与服务器更新事件都会触发当前服务器更新查询', async () => {
  const socket = new FakeSocket();
  const checks = [];
  const service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse(),
    createSocket: () => socket,
    checkForUpdate: async (server) => checks.push(server),
  });
  await service.login({ server: 'https://heysure.test', account: 'u', password: 'p' });
  socket.serverEmit('device:registered', {});
  socket.serverEmit('device:update-available', {});
  await tick();
  assert.deepEqual(checks, ['https://heysure.test', 'https://heysure.test']);
  service.stop();
});

test('HeySure rc 信令转交远程浏览器并通过原设备 socket 回传', async () => {
  const socket = new FakeSocket();
  const calls = [];
  let service;
  const remoteControl = {
    start: async (data, connection) => calls.push(['start', data, connection]),
    answer: async (data) => calls.push(['answer', data]),
    ice: async (data) => calls.push(['ice', data]),
    stop: async (reason) => calls.push(['stop', reason]),
    stopSession: async (sessionId) => calls.push(['stopSession', sessionId]),
  };
  service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse('remote-token'),
    createSocket: () => socket,
    getTools: () => ({ tools: [] }),
    remoteControl,
  });
  await service.login({ server: 'https://heysure.example', account: 'alice', password: 'secret' });
  await tick();
  calls.length = 0;

  await socket.serverEmit('rc:start', { sessionId: 'rc-1', qualityPreset: 'clear' });
  await socket.serverEmit('rc:answer', { sessionId: 'rc-1', sdp: 'answer' });
  await socket.serverEmit('rc:ice', { sessionId: 'rc-1', candidate: { candidate: 'ice' } });
  await socket.serverEmit('rc:stop', { sessionId: 'rc-1' });
  service.emitRemoteSignal('rc:offer', { sessionId: 'rc-1', sdp: 'offer' });

  assert.deepEqual(calls, [
    ['start', { sessionId: 'rc-1', qualityPreset: 'clear' }, {
      server: 'https://heysure.example', token: 'remote-token',
    }],
    ['answer', { sessionId: 'rc-1', sdp: 'answer' }],
    ['ice', { sessionId: 'rc-1', candidate: { candidate: 'ice' } }],
    ['stopSession', 'rc-1'],
  ]);
  assert.deepEqual(socket.sent.at(-1), {
    event: 'rc:offer', payload: { sessionId: 'rc-1', sdp: 'offer' },
  });
  service.stop();
});

test('HeySure browser_file 任务先物化 file_refs 再以本机 paths 调用 MCP', async () => {
  const socket = new FakeSocket();
  const calls = [];
  const materialized = [];
  const refs = [`file_${'a'.repeat(32)}`, `file_${'b'.repeat(32)}`];
  const service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse(),
    createSocket: () => socket,
    getTools: () => ({ tools: [{
      name: 'browser_file', description: '上传文件',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    }] }),
    materializeFileRefs: async (input) => {
      materialized.push(input);
      return ['C:/AI-Workspace/Incoming/task-refs/1-a.txt', 'C:/AI-Workspace/Incoming/task-refs/2-b.txt'];
    },
    callTool: async (name, args) => { calls.push({ name, args }); return { success: true }; },
  });
  await service.login({ server: 'https://heysure.example', account: 'alice', password: 'secret' });
  await tick();
  await socket.serverEmit('task:dispatch', {
    taskId: 'task-refs', aiConfigId: 19, tool: 'aifree.browser+file',
    args: { action: 'upload', file_refs: refs, selector: 'input[type=file]' },
  });
  await tick();

  assert.deepEqual(materialized[0].refs, refs);
  assert.equal(materialized[0].server, 'https://heysure.example');
  assert.equal(materialized[0].aiConfigId, 19);
  assert.deepEqual(calls, [{
    name: 'browser_file',
    args: {
      action: 'upload', selector: 'input[type=file]',
      paths: ['C:/AI-Workspace/Incoming/task-refs/1-a.txt', 'C:/AI-Workspace/Incoming/task-refs/2-b.txt'],
    },
  }]);
  assert.equal(socket.sent.filter((entry) => entry.event === 'task:result').length, 1);
  service.stop();
});

test('HeySure browser_file 下载完成后上传成员工作区并回传 file_ref', async () => {
  const socket = new FakeSocket();
  const uploads = [];
  const fileRef = `file_${'c'.repeat(32)}`;
  const service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse(),
    createSocket: () => socket,
    getTools: () => ({ tools: [{
      name: 'browser_file', description: '下载文件',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    }] }),
    callTool: async () => ({ success: true, absolute_path: 'C:/AI-Workspace/cat.jpg' }),
    uploadWorkspaceFile: async (input) => {
      uploads.push(input);
      return {
        file_ref: fileRef, workspace_path: 'Uploads/cat.jpg',
        mime_type: 'image/jpeg', can_send_to_user: true,
      };
    },
  });
  await service.login({ server: 'https://heysure.example', account: 'alice', password: 'secret' });
  await tick();

  await socket.serverEmit('task:dispatch', {
    taskId: 'task-download', sessionId: 'chat-9', aiConfigId: 19,
    tool: 'aifree.browser+file', args: { action: 'download_element', ref: 'media-1' },
  });
  await tick();

  assert.equal(uploads[0].aiConfigId, 19);
  assert.equal(uploads[0].sessionId, 'chat-9');
  const terminal = socket.sent.find((entry) => entry.event === 'task:result')?.payload;
  assert.equal(terminal.result.file_ref, fileRef);
  assert.equal(terminal.result.uploaded_to_heysure, true);
  service.stop();
});

test('HeySure browser_file 可将 AI 工作区已有文件直接上传并回传 file_ref', async () => {
  const socket = new FakeSocket();
  const calls = [];
  const uploads = [];
  const fileRef = `file_${'d'.repeat(32)}`;
  const service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse(),
    createSocket: () => socket,
    getTools: () => ({ tools: [{
      name: 'browser_file', description: '传输工作区文件',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    }] }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {
        success: true, action: 'upload_to_server',
        absolute_path: 'C:/AI-Workspace/uploads/grok-video-latest.mp4', local_workspace_file: true,
      };
    },
    uploadWorkspaceFile: async (input) => {
      uploads.push(input);
      return {
        file_ref: fileRef, workspace_path: 'Uploads/grok-video-latest.mp4',
        mime_type: 'video/mp4', can_send_to_user: true,
      };
    },
  });
  await service.login({ server: 'https://heysure.example', account: 'alice', password: 'secret' });
  await tick();

  await socket.serverEmit('task:dispatch', {
    taskId: 'task-upload-existing', sessionId: 'chat-video', aiConfigId: 19,
    tool: 'aifree.browser+file',
    args: { action: 'upload_to_server', path: 'uploads/grok-video-latest.mp4' },
  });
  await tick();

  assert.deepEqual(calls[0], {
    name: 'browser_file', args: { action: 'upload_to_server', path: 'uploads/grok-video-latest.mp4' },
  });
  assert.equal(uploads[0].localPath, 'C:/AI-Workspace/uploads/grok-video-latest.mp4');
  const terminal = socket.sent.find((entry) => entry.event === 'task:result')?.payload;
  assert.equal(terminal.result.file_ref, fileRef);
  assert.equal(terminal.result.uploaded_to_heysure, true);
  service.stop();
});

test('未知工具返回 task:error，注册拒绝后会自动重新登录', async () => {
  const socket = new FakeSocket();
  let loginCount = 0;
  const service = createAiServerDeviceService({
    hasVipAccess: () => true,
    fetch: async () => loginResponse(`token-${++loginCount}`),
    createSocket: () => socket,
    getTools: () => ({ tools: [] }),
  });
  await service.login({ account: 'alice', password: 'secret' });
  await tick();
  await socket.serverEmit('task:dispatch', { taskId: 'task-bad', tool: 'aifree.missing', args: {} });
  await tick();
  assert.match(socket.sent.find((entry) => entry.event === 'task:error').payload.error, /未知或当前不可用/);
  const taskError = socket.sent.find((entry) => entry.event === 'task:error').payload;
  assert.equal(taskError.errorCode, 'MCP_TOOL_FAILED');
  assert.equal(taskError.phase, 'heysure_task');
  assert.equal(taskError.retryable, false);

  await socket.serverEmit('device:register_rejected', { reason: 'token expired' });
  await tick();
  assert.equal(loginCount, 2);
  assert.equal(socket.sent.filter((entry) => entry.event === 'device:register').at(-1).payload.token, 'token-2');
  service.stop();
});

test('首次登录安全记忆凭据，重启后仅会员自动连接，主动断开会清除记忆', async () => {
  let saved = null;
  let clearCount = 0;
  let loginCount = 0;
  const credentialStore = {
    has: () => saved !== null,
    save: (value) => { saved = { ...value }; },
    load: () => (saved ? { ...saved } : null),
    clear: () => { saved = null; clearCount += 1; return true; },
  };
  const createService = (isVip, socket, env) => createAiServerDeviceService({
    env,
    hasVipAccess: () => isVip,
    credentialStore,
    fetch: async () => { loginCount += 1; return loginResponse(`token-${loginCount}`); },
    createSocket: () => socket,
    getTools: () => ({ tools: [] }),
  });

  const first = createService(true, new FakeSocket());
  assert.equal((await first.login({ account: 'alice', password: 'secret' })).ok, true);
  assert.equal(saved.account, 'alice');
  assert.equal(saved.password, 'secret');
  first.stop();
  assert.equal(clearCount, 0);

  const nonMember = createService(false, new FakeSocket());
  const skipped = await nonMember.startAutomatically();
  assert.equal(skipped.reason, 'vip_required');
  assert.equal(loginCount, 1);

  saved.server = 'http://49.234.181.190:3000';
  const restarted = createService(true, new FakeSocket());
  const automatic = await restarted.startAutomatically();
  assert.equal(automatic.ok, true);
  assert.equal(automatic.status.remembered, true);
  assert.equal(saved.server, DEFAULT_HEYSURE_SERVER);
  assert.equal(loginCount, 2);
  restarted.stop();

  saved.server = 'https://saved.example';
  const local = createService(true, new FakeSocket(), {
    HEYSURE_FORCE_SERVER_MODE: 'true', HEYSURE_LOCAL_TEST: 'true', HEYSURE_SERVER: 'https://ignored.example',
  });
  assert.equal((await local.startAutomatically()).ok, true);
  assert.equal(saved.server, 'http://127.0.0.1:3000');
  assert.equal(loginCount, 3);
  assert.equal(local.logout().ok, true);
  assert.equal(saved, null);
  assert.equal(clearCount, 1);
});
