const http = require('http');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { sameBrowserInstance } = require('./automation-card-contract');
const { normalizeAutomationInputs, validateAutomationCardInputs, versionInputSchema } = require('./automation-card-inputs');
const { collectSensitiveInputPaths } = require('./automation-run-sanitizer');
const { CARD_CACHE_FILE_NAME, createCardCacheStore, normalizeCardCacheState } = require('./automation-card-store');
const { createBrowserAutomationExternalGateway } = require('./browser-automation-external-gateway');
const { createAutomationCardMcpRouter } = require('./automation-card-mcp-router');
const { createNativeAutomationCardService } = require('./native-automation-card-service');
const { createAutomationRunManager } = require('./automation-run-manager');
const { createNativeBrowserAutomation } = require('./native-browser-automation');
const { MANAGE_CARD_TOOL_DEFINITION, browserControlDefinition } = require('./native-browser-tool-definitions');
const { dispatchExternalBrowserTool } = require('./external-browser-page-routing');

const DEFAULT_PORT = 18765;

function runTargetMismatch() {
  return Object.assign(new Error('运行绑定的浏览器与当前接管目标不一致，请重新选择原浏览器'), {
    code: 'RUN_TARGET_MISMATCH', retryable: false,
  });
}

class BrowserAutomationBridgeRuntime {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.host = '127.0.0.1';
    this.port = Number(options.port || process.env.AI_FREE_AUTOMATION_BRIDGE_PORT || DEFAULT_PORT);
    this.backgroundExecutionLeases = options.backgroundExecutionLeases || null;
    this.cardCacheStore = createCardCacheStore({ dataDir: options.cardCacheDir });
    this.nativeCardService = createNativeAutomationCardService({
      read: () => this.cardCacheStore.read(), write: (state) => this.cardCacheStore.write(state),
    });
    this.cardMcpRouter = createAutomationCardMcpRouter({
      listConnections: () => this.listConnections(),
      getConnection: (id) => this.getConnection(id),
      dispatch: (...args) => this.dispatch(...args),
    });
    this.nativeAutomation = createNativeBrowserAutomation({
      browserRuntimeManager: options.browserRuntimeManager, browserDownloadService: options.browserDownloadService,
      getTabs: options.getTabs, appPointer: options.appPointer,
      nativePointer: options.nativePointer,
      workspaceDir: options.workspaceDir, getBrowserRecords: options.getBrowserRecords,
      executeManageCard: (connectionId, args, dispatchOptions) => this.manageCard(
        connectionId, args, { ...dispatchOptions, backgroundLeaseHeld: true },
      ),
    });
    // A background run inherits its own live authority, outside JSON requests and history.
    this.scheduledScope = new AsyncLocalStorage();
    this.runScopes = new Map();
    this.runManager = createAutomationRunManager({
      dataDir: this.cardCacheStore.dataDir,
      execute: (request, context) => this.withBackgroundLease(
        () => this.executeCard(request.connectionId, { ...request, action: 'run' },
          { ...context, timeoutMs: request.timeoutMs }, this.scheduledScope.getStore()),
        { timeoutMs: request.timeoutMs },
      ),
    });
    this.runManager.subscribe(({ run }) => {
      if (run.finishedAt && !run.retryAvailable) this.runScopes.delete(run.id);
    });
    this.activeOperations = 0;
    this.server = null;
    this.externalMcpGateway = createBrowserAutomationExternalGateway({
      descriptorPath: options.externalMcpDescriptorPath,
      dispatch: (...args) => dispatchExternalBrowserTool((...request) => this.dispatch(...request), ...args),
      getConnection: (...args) => this.getConnection(...args),
      listConnections: () => this.listConnections(),
      getActiveConnectionId: () => {
        const profileId = String(options.getActiveBrowserProfileId?.() || '').trim();
        return this.listConnections().find((item) => item.profileId === profileId)?.id || '';
      },
      getAccess: options.getExternalMcpAccess,
      logger: this.logger,
      getAutomationTool: () => MANAGE_CARD_TOOL_DEFINITION,
      manageAutomationCard: (args, signal) => this.manageCard('', args, { signal }),
      getOverviewTool: browserControlDefinition,
      getBrowserOverview: (args) => this.nativeAutomation.browserOverview(args),
    });
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${this.host}:${this.port}`);
    if (await this.externalMcpGateway.handle(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, message: '接口不存在' }));
  }

  async start() {
    if (this.server) return { host: this.host, port: this.port };
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve(undefined);
      });
    });
    this.publishExternalMcp();
    this.logger.log?.(`[AutomationBridge] Chromium 原生自动化网关已启动: http://${this.host}:${this.port}`);
    return { host: this.host, port: this.port };
  }

  publishExternalMcp() {
    try {
      this.externalMcpGateway.refreshPublication({ host: this.host, port: this.port });
    } catch (error) {
      this.logger.warn?.('[ExternalMCP] 无法发布 Codex 桥接描述文件:', error?.message || error);
    }
  }

  listConnections() {
    return this.nativeAutomation.listConnections();
  }

  getConnection(id) {
    return this.nativeAutomation.getConnection(id);
  }

  getCardCacheState() {
    return this.cardCacheStore.read();
  }

  setCardCacheState(state = {}) {
    return this.cardCacheStore.write(state);
  }

  selectCard(cardId) {
    const id = String(cardId || '').trim();
    if (!id) throw new Error('缺少要选择的自动化卡片 ID');
    const cached = this.cardCacheStore.read();
    const item = cached.state.items.find((entry) => String(entry?.id || '').trim() === id && !entry.deletedAt);
    if (!item) throw new Error(`自动化卡片不存在或已被删除: ${id}`);
    const state = this.cardCacheStore.write({ ...cached.state, selectedId: id });
    return { state, item };
  }

  async withBackgroundLease(operation, options = {}) {
    const lease = this.backgroundExecutionLeases?.acquire?.({ timeoutMs: options.timeoutMs });
    this.activeOperations += 1;
    try { return await operation(); } finally { this.activeOperations -= 1; lease?.release?.(); }
  }

  manageCard(connectionId, args = {}, options = {}) {
    const input = /** @type {Record<string, any>} */ ({ ...args });
    if (!input.id && input.card_id) input.id = input.card_id;
    const action = String(input.action || '').trim().toLowerCase();
    if (action === 'start_run') return this.startRun(connectionId, input, options);
    const runHandler = this.runAction(action, input, connectionId, options.takeoverGrant);
    if (runHandler) return runHandler();
    if (action === 'run') {
      const execute = () => this.executeCard(connectionId, input, options, { grant: options.takeoverGrant });
      return options.backgroundLeaseHeld ? execute() : this.withBackgroundLease(execute, options);
    }
    return this.nativeCardService.execute(input, { timeoutMs: options.timeoutMs });
  }

  executeCard(connectionId, args, context, scope) {
    const managedChatActor = `card:${context.automationRunId || randomUUID()}`;
    return this.nativeCardService.execute(args, {
      ...context,
      dispatch: (tool, toolArgs) => {
        context.signal?.throwIfAborted();
        if (scope?.grant) this.requireActiveGrant(connectionId, scope.grant);
        return this.cardMcpRouter.execute(connectionId, tool, toolArgs, {
          signal: context.signal, timeoutMs: context.timeoutMs, managedChatActor,
        });
      },
    });
  }

  requireActiveGrant(connectionId, grant) {
    const connection = this.nativeAutomation.requireConnection(connectionId);
    if (!sameBrowserInstance(grant, connection)) throw runTargetMismatch();
    if (this.nativeAutomation.takeoverConnections.get(connectionId) !== grant) {
      throw Object.assign(new Error('原浏览器接管已释放，请重新接管后再执行'), { code: 'BROWSER_TAKEOVER_REQUIRED', retryable: false });
    }
  }

  runAction(action, input, connectionId, grant) {
    const runId = input.run_id || input.id;
    return ({
      list_runs: () => this.runManager.list(input),
      get_run: () => this.runManager.get(runId),
      list_run_steps: () => this.runManager.steps(runId),
      cancel_run: () => this.runManager.cancel(runId, input.reason),
      retry_run: () => this.continueRun('retry', runId, connectionId, grant),
      pause_run: () => this.runManager.pause(runId),
      resume_run: () => this.continueRun('resume', runId, connectionId, grant),
      step_run: () => this.continueRun('step', runId, connectionId, grant),
    })[action];
  }

  scheduleRun(scope, operation) {
    const run = this.scheduledScope.run(scope, operation);
    if (!run.finishedAt && !this.runScopes.has(run.id)) this.runScopes.set(run.id, scope);
    return { success: true, run };
  }

  continueRun(action, runId, connectionId, grant) {
    const run = this.runManager.get(runId).run;
    const scope = this.runScopes.get(runId);
    if (!connectionId || !('connectionId' in run) || run.connectionId !== connectionId) throw runTargetMismatch();
    if (grant) {
      if (scope && !sameBrowserInstance(scope.instance, grant)) throw runTargetMismatch();
      this.requireActiveGrant(connectionId, grant);
    }
    if (action === 'retry') {
      return this.scheduleRun({ ...scope, grant: grant || scope?.grant }, () => this.runManager.retry(runId).run);
    }
    const result = this.runManager[action](runId);
    if (scope && grant) scope.grant = grant;
    return result;
  }

  async startRun(connectionId, args, options) {
    const item = (await this.nativeCardService.execute({ action: 'get', id: args.id, card_name: args.card_name })).item;
    const { version } = await this.nativeCardService.execute({ action: 'get_version', id: item.id, version_id: args.version_id || item.latestVersionId });
    const inputs = normalizeAutomationInputs(args, version.cardData);
    const schema = versionInputSchema(item, version);
    validateAutomationCardInputs(schema, inputs);
    const request = {
      id: item.id, version_id: version.id, inputs, connectionId: connectionId || '',
      ...(args.start_step !== undefined && { start_step: args.start_step }),
      ...(args.idempotency_key !== undefined && { idempotency_key: args.idempotency_key }),
      sensitiveInputPaths: collectSensitiveInputPaths(schema), redactAllInputs: !schema,
      timeoutMs: Math.min(Number(options.timeoutMs || 30 * 60 * 1000), Math.max(1, Number(item.limits?.timeoutSeconds || 900)) * 1000),
    };
    const grant = options.takeoverGrant;
    const instance = grant || (connectionId && this.getConnection(connectionId));
    options.signal?.throwIfAborted();
    if (grant) this.requireActiveGrant(connectionId, grant);
    return this.scheduleRun({ instance, grant }, () => this.runManager.start(request));
  }

  saveBrowserSession(connectionId, args = {}, options = {}) {
    return this.dispatch(connectionId, 'browser_file', {
      ...args,
      action: 'save_session',
    }, options);
  }

  dispatch(connectionId, tool, args = {}, options = {}) {
    return this.withBackgroundLease(
      () => this.nativeAutomation.dispatch(connectionId, tool, args, options),
      options,
    );
  }

  async stop() {
    this.externalMcpGateway.unpublish();
    if (!this.server) return;
    const current = this.server;
    this.server = null;
    await new Promise((resolve) => current.close(() => resolve(undefined)));
  }

  refreshExternalMcpAccess() {
    if (!this.server) return false;
    return this.externalMcpGateway.refreshPublication({ host: this.host, port: this.port });
  }

  getExternalMcpStatus() {
    return this.externalMcpGateway.getStatus({ host: this.host, port: this.port });
  }

  getExternalMcpConnectionInfo() {
    return this.externalMcpGateway.getConnectionInfo();
  }

  configureExternalMcp(context = {}) {
    this.cardMcpRouter.configure(context);
    this.externalMcpGateway.configure(context);
    return this.refreshExternalMcpAccess();
  }

  listExternalMcpTools() {
    return this.externalMcpGateway.listTools();
  }

  listAutomationMcpTools() {
    return this.cardMcpRouter.listTools();
  }

  callExternalMcpTool(name, args = {}, signal = undefined, managedChatActor = undefined) {
    return this.externalMcpGateway.callTool(name, args, signal, managedChatActor);
  }
}

function createBrowserAutomationBridge(options = {}) {
  const runtime = new BrowserAutomationBridgeRuntime(options);
  return {
    configureExternalMcp: (context) => runtime.configureExternalMcp(context),
    callExternalMcpTool: (...args) => runtime.callExternalMcpTool(...args),
    dispatch: (...args) => runtime.dispatch(...args),
    getConnection: (...args) => runtime.getConnection(...args),
    getBrowserOverview: (args) => runtime.nativeAutomation.browserOverview(args),
    getCardCacheState: () => runtime.getCardCacheState(),
    getExternalMcpConnectionInfo: () => runtime.getExternalMcpConnectionInfo(),
    getExternalMcpStatus: () => runtime.getExternalMcpStatus(),
    listConnections: () => runtime.listConnections(),
    listBrowserRecords: () => options?.getBrowserRecords?.() || [],
    listAutomationMcpTools: () => runtime.listAutomationMcpTools(),
    listExternalMcpTools: () => runtime.listExternalMcpTools(),
    manageCard: (...args) => runtime.manageCard(...args),
    onRunProgress: (listener) => runtime.runManager.subscribe(listener),
    saveBrowserSession: (...args) => runtime.saveBrowserSession(...args),
    selectCard: (...args) => runtime.selectCard(...args),
    setCardCacheState: (...args) => runtime.setCardCacheState(...args),
    hasActiveOperations: () => Boolean(runtime.activeOperations || runtime.externalMcpGateway.activeCalls || runtime.runManager.hasActiveRuns()),
    refreshExternalMcpAccess: () => runtime.refreshExternalMcpAccess(),
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    host: runtime.host,
    port: runtime.port,
    cardCacheFilePath: runtime.cardCacheStore.filePath,
    runsFilePath: runtime.runManager.filePath,
  };
}

module.exports = {
  CARD_CACHE_FILE_NAME,
  DEFAULT_PORT,
  createBrowserAutomationBridge,
  createCardCacheStore,
  normalizeCardCacheState,
};
