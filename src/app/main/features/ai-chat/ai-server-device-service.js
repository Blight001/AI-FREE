'use strict';

const os = require('os');
const {
  normalizeToolError,
  normalizeToolSchema,
} = require('../../services/automation-tool-contract');
const {
  augmentHeySureBrowserFileTool,
  prepareHeySureBrowserFileArgs,
} = require('./heysure-file-materializer');
const { attachHeySureDownloadedFile } = require('./heysure-file-uploader');
const {
  DEFAULT_HEYSURE_SERVER,
  loadDefaultHeySureServer,
  migrateSavedLoginConfig,
  normalizeLoginConfig,
  normalizeServerUrl,
} = require('./heysure-server-profile');
const REGISTER_INTERVAL_MS = 3000;
const LOGIN_TIMEOUT_MS = 10000;
const MAX_COMPLETED_TASKS = 200;
const REMOTE_CONTROL_CAPABILITY = 'remote_control';
const HEYSURE_AI_DESCRIPTION = '用于连接 AI-FREE，调用其中已启用的软件窗口、浏览器与自动化 MCP 工具';

function defaultSocketFactory(url, options) {
  return require('socket.io-client').io(url, options);
}

function protocolToolName(sourceName) {
  const action = String(sourceName || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '+')
    .replace(/^\++|\++$/g, '');
  return action ? `aifree.${action}` : '';
}

function legacyProtocolToolName(sourceName) {
  const action = String(sourceName || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return action ? `aifree.${action}` : '';
}

function normalizeToolCatalog(listed = {}) {
  const tools = [];
  const routes = new Map();
  for (const source of listed.tools || []) {
    const sourceName = String(source?.name || '').trim();
    const name = protocolToolName(sourceName);
    if (!name || routes.has(name)) continue;
    routes.set(name, sourceName);
    // Publish only the canonical `+` spelling, while keeping the previous
    // underscore route executable for tasks already queued during an upgrade.
    const legacyName = legacyProtocolToolName(sourceName);
    if (legacyName && legacyName !== name && !routes.has(legacyName)) routes.set(legacyName, sourceName);
    tools.push(augmentHeySureBrowserFileTool(sourceName, {
      name,
      description: String(source.description || `调用 AI-FREE 的 ${sourceName} MCP 工具`).trim(),
      input_schema: normalizeToolSchema(source),
      destructive: source.destructive === true,
    }));
  }
  return { tools, routes };
}

function catalogSignature(tools) {
  return JSON.stringify(tools);
}

function deviceCapabilities(tools, hasRemoteControl) {
  const capabilities = tools.map((tool) => tool.name);
  if (hasRemoteControl) capabilities.push(REMOTE_CONTROL_CAPABILITY);
  return capabilities;
}

function publicMessage(error, fallback) {
  return String(error?.message || error || fallback || '').trim();
}

function responsePayload(data) {
  return data && typeof data.data === 'object' && !data.access_token ? data.data : data;
}

async function parseLoginResponse(response) {
  let data = {};
  try { data = await response.json(); } catch (_) {}
  data = responsePayload(data || {});
  if (!response.ok) throw new Error(data?.message || data?.detail || `登录失败（HTTP ${response.status}）`);
  if (!data?.access_token) throw new Error('登录响应缺少 access_token');
  return data;
}

function stableServiceId(raw) {
  const normalized = String(raw || os.hostname() || 'device')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return `ai-free-${normalized || 'device'}`;
}

function taskSummary(tool, result) {
  const explicit = result && typeof result === 'object' ? String(result.summary || '').trim() : '';
  return explicit || `AI-FREE 工具 ${tool} 执行完成`;
}

function createInitialState(credentialStore, env) {
  return {
    phase: 'idle', server: loadDefaultHeySureServer(env), account: '', serviceId: '', serviceName: 'AI-FREE',
    connected: false, registered: false, remembered: credentialStore?.has?.() === true,
    aiConfigId: null, toolCount: 0, message: '尚未连接 AI 服务器',
  };
}

class AiServerDeviceService {
  constructor(options = {}) {
    const { env = process.env } = options;
    this.env = env;
    this.fetch = options.fetch || globalThis.fetch;
    this.createSocket = options.createSocket || defaultSocketFactory;
    this.computeDeviceId = options.computeDeviceId || (() => 'device');
    this.getTools = options.getTools || (() => ({ tools: [] }));
    this.callTool = options.callTool || (() => { throw new Error('MCP 执行器尚未就绪'); });
    this.materializeFileRefs = options.materializeFileRefs || null;
    this.uploadWorkspaceFile = options.uploadWorkspaceFile;
    this.remoteControl = options.remoteControl;
    this.credentialStore = options.credentialStore || null;
    this.hasVipAccess = options.hasVipAccess || (() => false);
    this.onStatus = options.onStatus || (() => {});
    this.checkForUpdate = options.checkForUpdate || (async () => {});
    this.logger = options.logger || console;
    this.version = String(options.version || '1.0.0');
    this.socket = null;
    this.credentials = null;
    this.token = '';
    this.socketUrl = '';
    this.serviceId = '';
    this.registered = false;
    this.registerTimer = null;
    this.registering = false;
    this.reauthenticating = false;
    this.routes = new Map();
    this.lastCatalogSignature = '';
    this.inFlightTasks = new Set();
    this.completedTasks = new Map();
    this.state = createInitialState(this.credentialStore, this.env);
  }

  status() {
    return { ...this.state };
  }

  publishStatus(patch = {}) {
    this.state = { ...this.state, ...patch };
    try { this.onStatus(this.status()); } catch (_) {}
  }

  async resolveServiceId() {
    if (this.serviceId) return this.serviceId;
    const explicit = String(this.env.HEYSURE_SERVICE_ID || '').trim();
    const identity = explicit || await this.computeDeviceId();
    this.serviceId = explicit || stableServiceId(identity);
    return this.serviceId;
  }

  async requestLogin(config) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
    try {
      const response = await this.fetch(`${config.server}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: config.account, password: config.password }),
        signal: controller.signal,
      });
      return await parseLoginResponse(response);
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('登录 AI 服务器超时');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  persistCredentials(config, remember) {
    if (!remember || !this.credentialStore) {
      return { remembered: this.credentialStore?.has?.() === true, warning: '' };
    }
    try {
      this.credentialStore.save(config);
      return { remembered: true, warning: '' };
    } catch (error) {
      const warning = publicMessage(error, '无法保存自动登录凭据');
      this.logger.warn?.('[AIServerDevice] 无法保存自动登录凭据:', warning);
      return { remembered: false, warning };
    }
  }

  vipRequiredResult() {
    const message = '连接 HeySure 服务器仅限当前有效会员';
    this.publishStatus({ phase: 'idle', connected: false, registered: false, message });
    return { ok: false, vipRequired: true, error: message, status: this.status() };
  }

  async login(input = {}, options = {}) {
    if (this.hasVipAccess() !== true) return this.vipRequiredResult();
    const config = normalizeLoginConfig(input, this.env);
    this.disconnectSocket();
    this.token = '';
    this.socketUrl = '';
    this.credentials = config;
    this.publishStatus({
      phase: 'authenticating', server: config.server, account: config.account,
      serviceName: config.serviceName, connected: false, registered: false, message: '正在登录 AI 服务器…',
    });
    try {
      const data = await this.requestLogin(config);
      const persistence = this.persistCredentials(config, options.remember !== false);
      this.token = String(data.access_token);
      this.socketUrl = normalizeServerUrl(data.agent_socket_url || config.server);
      await this.resolveServiceId();
      this.publishStatus({
        serviceId: this.serviceId, phase: 'connecting', remembered: persistence.remembered,
        message: '登录成功，正在注册设备…',
      });
      this.connectSocket();
      return { ok: true, warning: persistence.warning, status: this.status() };
    } catch (error) {
      const message = publicMessage(error, '登录 AI 服务器失败');
      this.publishStatus({ phase: 'error', connected: false, registered: false, message });
      return { ok: false, error: message, status: this.status() };
    }
  }

  connectSocket() {
    this.disconnectSocket();
    const socket = this.createSocket(this.socketUrl, {
      reconnection: true,
      reconnectionDelay: 2000,
      autoConnect: false,
    });
    this.socket = socket;
    socket.on('connect', () => this.handleConnect());
    socket.on('disconnect', (reason) => this.handleDisconnect(reason));
    socket.on('connect_error', (error) => this.handleConnectError(error));
    socket.on('device:registered', (data) => this.handleRegistered(data));
    socket.on('device:update-available', () => this.scheduleUpdateCheck());
    socket.on('device:register_rejected', (data) => void this.handleRejected(data));
    socket.on('task:dispatch', (task) => void this.handleTask(task));
    socket.on('rc:start', (data) => void this.handleRemoteStart(data));
    socket.on('rc:answer', (data) => void this.remoteControl?.answer?.(data));
    socket.on('rc:ice', (data) => void this.remoteControl?.ice?.(data));
    socket.on('rc:stop', (data) => void this.remoteControl?.stopSession?.(data?.sessionId));
    socket.connect();
  }

  emitRemoteSignal(event, payload) {
    if (this.socket?.connected) this.socket.emit(event, payload);
  }

  async handleRemoteStart(data = {}) {
    if (!this.remoteControl) {
      this.emitRemoteSignal('rc:error', {
        sessionId: String(data.sessionId || ''),
        code: 'remote_control_unavailable',
        message: 'AI-FREE 远程浏览器控制尚未装配',
      });
      return;
    }
    await this.remoteControl.start(data, {
      server: this.credentials?.server,
      token: this.token,
    });
  }

  handleConnect() {
    this.registered = false;
    this.publishStatus({ phase: 'connecting', connected: true, registered: false, message: '已连接，正在上报 MCP 工具…' });
    void this.refreshRegistration(true);
    this.startRegisterTimer();
  }

  handleDisconnect(reason) {
    this.registered = false;
    this.publishStatus({
      phase: 'disconnected', connected: false, registered: false,
      message: `连接已断开，正在自动重连${reason ? `（${reason}）` : ''}`,
    });
  }

  handleConnectError(error) {
    this.publishStatus({
      phase: 'error', connected: false, registered: false,
      message: publicMessage(error, '连接 AI 服务器失败，正在重试'),
    });
  }

  handleRegistered(data = {}) {
    this.registered = true;
    const aiConfigId = data.aiConfigId ?? null;
    this.publishStatus({
      phase: 'registered', connected: true, registered: true, aiConfigId,
      message: aiConfigId === null
        ? '设备已在线；请到作坊面板分配 AI 并勾选 MCP 权限'
        : '设备已在线并绑定 AI',
    });
    this.scheduleUpdateCheck();
  }

  scheduleUpdateCheck() {
    const server = this.credentials?.server;
    if (!server) return;
    void this.checkForUpdate(server).catch((error) => {
      this.logger.warn?.('[AIServerDevice] 更新检查跳过:', publicMessage(error, '更新检查失败'));
    });
  }

  async handleRejected(data = {}) {
    this.registered = false;
    const reason = String(data.reason || '服务器拒绝注册');
    this.publishStatus({ phase: 'authenticating', registered: false, message: `${reason}，正在重新登录…` });
    if (!this.credentials || this.reauthenticating) return;
    this.reauthenticating = true;
    try {
      const login = await this.requestLogin(this.credentials);
      this.token = String(login.access_token);
      const nextUrl = normalizeServerUrl(login.agent_socket_url || this.credentials.server);
      if (nextUrl !== this.socketUrl) {
        this.socketUrl = nextUrl;
        this.connectSocket();
      } else {
        await this.refreshRegistration(true);
      }
    } catch (error) {
      this.publishStatus({ phase: 'error', message: publicMessage(error, '重新登录失败') });
    } finally {
      this.reauthenticating = false;
    }
  }

  startRegisterTimer() {
    if (this.registerTimer) clearInterval(this.registerTimer);
    this.registerTimer = setInterval(() => void this.refreshRegistration(false), REGISTER_INTERVAL_MS);
    this.registerTimer.unref?.();
  }

  async refreshRegistration(force) {
    if (!this.socket?.connected || this.registering || !this.token) return false;
    this.registering = true;
    try {
      const catalog = normalizeToolCatalog(await this.getTools());
      const signature = catalogSignature(catalog.tools);
      if (!force && this.registered && signature === this.lastCatalogSignature) return false;
      this.routes = catalog.routes;
      this.lastCatalogSignature = signature;
      this.registered = false;
      this.socket.emit('device:register', {
        id: await this.resolveServiceId(),
        name: this.credentials?.serviceName || 'AI-FREE',
        platform: 'ai-free-custom-service',
        deviceType: 'custom',
        token: this.token,
        version: this.version,
        aiDescription: HEYSURE_AI_DESCRIPTION,
        catalogProtocolVersion: 2,
        capabilities: deviceCapabilities(catalog.tools, !!this.remoteControl),
        toolDefs: catalog.tools,
      });
      this.publishStatus({
        phase: 'connecting', connected: true, registered: false,
        toolCount: catalog.tools.length,
        message: `已上报 ${catalog.tools.length} 个 MCP 工具，等待服务器确认…`,
      });
      return true;
    } catch (error) {
      this.publishStatus({ phase: 'error', message: publicMessage(error, '读取 MCP 工具失败') });
      return false;
    } finally {
      this.registering = false;
    }
  }

  rememberCompletedTask(taskId, terminal) {
    this.completedTasks.set(taskId, terminal);
    while (this.completedTasks.size > MAX_COMPLETED_TASKS) {
      this.completedTasks.delete(this.completedTasks.keys().next().value);
    }
  }

  async handleTask(task = {}) {
    const taskId = String(task.taskId || '').trim();
    const socket = this.socket;
    if (!taskId || !socket) return;
    if (this.completedTasks.has(taskId)) return;
    if (this.inFlightTasks.has(taskId)) return;
    this.inFlightTasks.add(taskId);
    const tool = String(task.tool || '').trim();
    try {
      const sourceName = this.routes.get(tool);
      if (!sourceName) throw new Error(`未知或当前不可用的 MCP 工具: ${tool}`);
      const toolArgs = await prepareHeySureBrowserFileArgs({
        sourceName, args: task.args, task,
        materialize: this.materializeFileRefs,
        server: this.credentials?.server,
        token: this.token,
      });
      const localResult = await this.callTool(sourceName, toolArgs);
      const result = await attachHeySureDownloadedFile({
        sourceName, args: task.args, result: localResult,
        upload: this.uploadWorkspaceFile,
        server: this.credentials?.server, token: this.token,
        aiConfigId: task.aiConfigId ?? this.state.aiConfigId,
        sessionId: task.sessionId,
      });
      const payload = {
        taskId, deviceId: this.serviceId, success: true, tool,
        result, summary: taskSummary(tool, result),
      };
      this.rememberCompletedTask(taskId, { event: 'task:result', payload });
      socket.emit('task:result', payload);
    } catch (error) {
      const normalized = normalizeToolError(error, {
        code: 'MCP_TOOL_FAILED',
        message: publicMessage(error, 'MCP 工具执行失败'),
        phase: 'heysure_task',
      });
      const payload = {
        taskId,
        deviceId: this.serviceId,
        error: normalized.message,
        errorCode: normalized.code,
        phase: normalized.phase,
        retryable: normalized.retryable,
      };
      this.rememberCompletedTask(taskId, { event: 'task:error', payload });
      socket.emit('task:error', payload);
    } finally {
      this.inFlightTasks.delete(taskId);
    }
  }

  disconnectSocket() {
    if (this.registerTimer) clearInterval(this.registerTimer);
    this.registerTimer = null;
    const socket = this.socket;
    this.socket = null;
    void this.remoteControl?.stop?.('agent_disconnected', false);
    if (socket) socket.disconnect();
    this.registered = false;
  }

  logout() {
    this.disconnectSocket();
    this.credentials = null;
    this.token = '';
    this.socketUrl = '';
    this.routes.clear();
    this.lastCatalogSignature = '';
    this.completedTasks.clear();
    const forgotten = this.credentialStore?.clear?.() !== false;
    this.publishStatus({
      phase: 'idle', connected: false, registered: false, aiConfigId: null,
      toolCount: 0, remembered: !forgotten, message: forgotten ? '已断开 AI 服务器' : '已断开，但自动登录凭据清除失败',
    });
    return forgotten
      ? { ok: true, status: this.status() }
      : { ok: false, error: '自动登录凭据清除失败', status: this.status() };
  }

  async startFromEnvironment() {
    const account = String(this.env.HEYSURE_ACCOUNT || '').trim();
    const password = String(this.env.HEYSURE_PASSWORD || '');
    if (!account || !password) return { ok: true, skipped: true, status: this.status() };
    return this.login({
      server: this.env.HEYSURE_SERVER,
      account,
      password,
      serviceName: this.env.HEYSURE_SERVICE_NAME || 'AI-FREE',
    }, { remember: false });
  }

  async startAutomatically() {
    if (this.hasVipAccess() !== true) {
      const remembered = this.credentialStore?.has?.() === true;
      this.publishStatus({
        phase: 'idle', connected: false, registered: false, remembered,
        message: remembered ? '已保存 HeySure 登录；当前会员无效，未自动连接' : '尚未连接 AI 服务器',
      });
      return { ok: true, skipped: true, reason: 'vip_required', status: this.status() };
    }
    const environment = await this.startFromEnvironment();
    if (!environment.skipped) return environment;
    const saved = this.credentialStore?.load?.();
    if (!saved) return { ok: true, skipped: true, reason: 'no_credentials', status: this.status() };
    const migrated = migrateSavedLoginConfig(saved, this.env);
    const resolved = normalizeLoginConfig(migrated, this.env);
    const savedServer = String(saved.server || '').trim().replace(/\/+$/, '');
    return this.login(resolved, { remember: migrated !== saved || resolved.server !== savedServer });
  }

  stop() {
    this.disconnectSocket();
    this.credentials = null;
    this.token = '';
    this.socketUrl = '';
    this.routes.clear();
    this.completedTasks.clear();
    return { ok: true };
  }
}

function createAiServerDeviceService(options = {}) {
  return new AiServerDeviceService(options);
}

module.exports = {
  DEFAULT_HEYSURE_SERVER,
  AiServerDeviceService,
  createAiServerDeviceService,
  normalizeLoginConfig,
  normalizeToolCatalog,
  protocolToolName,
};
