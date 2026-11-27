const { registerHomeConsoleIpc } = require('../features/window/register-home-console-ipc');
const { createMcpBenchmarkController } = require('../features/browser/mcp-benchmark-controller');
const { createMcpDevRestartController } = require('../features/browser/mcp-dev-restart-controller');
const { registerMcpDebugPanelIpc } = require('../features/browser/register-mcp-debug-panel-ipc');
const { registerMcpCatalogIpc } = require('../features/browser/register-mcp-catalog-ipc');
const { createAiSupportService } = require('../features/ai-chat/ai-support-service');
const { registerAiHistoryIpc } = require('../features/ai-chat/register-history-ipc');
const { createAiChatHistoryRepository } = require('../features/ai-chat/history-repository');
const { registerSkillIpc } = require('../features/ai-chat/register-skill-ipc');
const { registerAiSupportIpc } = require('../features/ai-chat/register-support-ipc');
const { registerManagedChatIpc } = require('../features/ai-chat/register-managed-chat-ipc');
const { combineToolSets } = require('./combine-tool-sets');
const { registerAiChatIpc } = require('../features/ai-chat/register-chat-ipc');
const { createAccountService } = require('../features/account/account-service');
const { registerAccountIpc } = require('../features/account/register-account-ipc');
const { createLicenseService } = require('../features/account/license-service');
const { registerLicenseIpc } = require('../features/account/register-license-ipc');
const { createMembershipService } = require('../features/account/membership-service');
const { registerAiServerDeviceIpc } = require('../features/ai-chat/register-ai-server-device-ipc');
const { readWindowCloseBehavior } = require('../features/window/window-close-preference');
const {
  applyStartupSettings,
  readStartupSettings,
  updateStartupSettings,
  withCloseBehaviorStartupSettings,
} = require('../features/window/startup-preference');

function scheduleCoreDirectoryInitialization(deps) {
  setImmediate(() => {
    try {
      const ok = deps.initializeCoreDirectory();
      const method = ok ? 'log' : 'warn';
      deps.logger[method]?.(`[配置] initializeCoreDirectory ${ok ? '执行完成' : '返回 false'}`);
    } catch (error) {
      deps.logger.warn?.('[配置] initializeCoreDirectory 执行异常:', error?.message || error);
    }
  });
}

function scheduleUpdateStorageCleanup(deps) {
  setImmediate(() => {
    try {
      if (typeof deps.cleanupUpdateStorageRoot !== 'function') return;
      const result = deps.cleanupUpdateStorageRoot();
      const method = result?.ok ? 'log' : 'warn';
      deps.logger[method]?.(`[更新] 启动后更新缓存清理${result?.ok ? '完成' : '未完成'}:`, result);
    } catch (error) {
      deps.logger.warn?.('[更新] 启动后更新缓存清理异常:', error?.message || error);
    }
  });
}

function scheduleDeviceIdLog(deps) {
  setImmediate(async () => {
    try {
      deps.logger.log?.('[启动] 设备号:', await deps.computeDeviceId());
    } catch (error) {
      deps.logger.warn?.('[启动] 打印设备号失败:', error?.message || error);
    }
  });
}

function synchronizeAppStartupSettings(deps) {
  if (typeof deps.app?.setLoginItemSettings !== 'function') return;
  const current = readStartupSettings(deps.readStoreConfigSafe, deps.app);
  const aligned = withCloseBehaviorStartupSettings(
    current,
    readWindowCloseBehavior(deps.readStoreConfigSafe),
  );
  const options = { platform: process.platform, execPath: process.execPath };
  const result = current.startMinimized === aligned.startMinimized
    ? applyStartupSettings(deps.app, aligned, options)
    : updateStartupSettings({
      app: deps.app,
      readStoreConfigSafe: deps.readStoreConfigSafe,
      writeStoreConfigSafe: deps.writeStoreConfigSafe,
      payload: aligned,
      options,
    });
  if (!result.ok) deps.logger.warn?.('[启动] 同步开机自启设置失败:', result.error?.message || result.error);
}

function createAndRegisterAccountServices(deps, ipc) {
  const accountService = createAccountService({
    authenticateAccount: deps.authenticateAccount,
    computeDeviceId: deps.computeDeviceId,
    readStoreConfigSafe: deps.readStoreConfigSafe,
    writeStoreConfigSafe: deps.writeStoreConfigSafe,
    licenseCache: deps.licenseCache,
    getGlobalHttpClient: deps.getGlobalHttpClient,
    applyResolvedConfigToStore: deps.applyResolvedConfigToStore,
    refreshAnnouncements: deps.refreshAnnouncements,
    refreshAllowedPlatformsAndNotify: deps.refreshAllowedPlatformsAndNotify,
    sendToSide: deps.sendToSide,
    setRuntimeServerBase: deps.setRuntimeServerBase,
    setRuntimeTcpConfig: deps.setRuntimeTcpConfig,
    stopProxy: deps.stopClashMiniProcess,
    logger: deps.logger,
  });
  registerAccountIpc({ ipc, service: accountService });
  const licenseService = createLicenseService({
    computeDeviceId: deps.computeDeviceId,
    getCurrentPlatformLabel: deps.getCurrentPlatformLabel,
    getGlobalHttpClient: deps.getGlobalHttpClient,
    licenseCache: deps.licenseCache,
    readLicenseRecordsSafe: deps.readLicenseRecordsSafe,
    readStoreConfigSafe: deps.readStoreConfigSafe,
    refreshAllowedPlatformsAndNotify: deps.refreshAllowedPlatformsAndNotify,
    sendToSide: deps.sendToSide,
    writeLicenseRecordsSafe: deps.writeLicenseRecordsSafe,
    writeStoreConfigSafe: deps.writeStoreConfigSafe,
  });
  registerLicenseIpc({ ipc, service: licenseService });
  return accountService;
}

function createMcpRestartService(deps, app, aiChatService, managedChat, benchmark) {
  if (!deps.isDevMode) return null;
  const restart = createMcpDevRestartController({ app: deps.app, fs: deps.fs, path: require('node:path'),
    isDevMode: true, isBusy: () => aiChatService.hasActiveRuns() || managedChat?.hasActiveRuns() === true
      || Boolean(benchmark?.active) || deps.browserAutomationBridge?.hasActiveOperations?.() === true,
    logger: deps.logger });
  app?.once?.('before-quit', () => restart.dispose());
  return restart;
}

function createAndRegisterAiServices(deps, ipc) {
  const aiSupport = createAiSupportService({
    readStoreConfigSafe: deps.readStoreConfigSafe,
    aiModelConfig: deps.aiModelConfig,
    computeDeviceId: deps.computeDeviceId,
    licenseCache: deps.licenseCache,
    getGlobalHttpClient: deps.getGlobalHttpClient,
    browserAutomationBridge: deps.browserAutomationBridge,
    browserRuntimeManager: deps.browserRuntimeManager,
    getTabs: deps.getTabs,
    getMainWindow: deps.getMainWindow,
    aiSandboxDir: deps.aiSandboxDir,
    dialog: deps.dialog,
    logger: deps.logger,
  });
  registerAiSupportIpc({ ipc, service: aiSupport });
  const disposeSkills = registerSkillIpc(ipc, { ...deps, openDirectory: dir => require('electron').shell.openPath(dir) });
  deps.app?.once('will-quit', disposeSkills);
  const managedChat = deps.managedChatRepository ? registerManagedChatIpc({ ipc, deps, getModels: aiSupport.getModels }) : null;
  if (managedChat) deps.app?.once?.('before-quit', managedChat.dispose);
  const benchmark = deps.isDevMode && deps.app?.getPath ? createMcpBenchmarkController(deps) : null;
  if (benchmark) deps.app.once('before-quit', () => benchmark.dispose());
  const aiChatService = registerAiChatIpc({
    getParentChatTools: managedChat?.getParentTools,
    ...deps,
    benchmark,
    ipc,
    readStoreConfigSafe: deps.readStoreConfigSafe,
    getGlobalHttpClient: deps.getGlobalHttpClient,
    licenseCache: deps.licenseCache,
    logger: deps.logger,
  });
  const mcpDevRestart = createMcpRestartService(deps, deps.app, aiChatService, managedChat, benchmark);
  const getWindowTools = () => combineToolSets(aiChatService.getWindowTools(), managedChat?.getExternalTools());
  deps.browserAutomationBridge?.configureExternalMcp?.({
    getConnections: () => aiSupport.getBrowserConnections().connections,
    getWindowTools,
  });
  registerMcpCatalogIpc(ipc, { ...deps, getWindowTools });
  const disposeMcpDebug = registerMcpDebugPanelIpc(ipc, { ...deps, getWindowTools, benchmark, mcpDevRestart });
  deps.app?.once('will-quit', disposeMcpDebug);
  if (deps.aiServerDeviceService) {
    registerAiServerDeviceIpc({ ipc, service: deps.aiServerDeviceService, getMainWindow: deps.getMainWindow });
  }
  registerAiHistoryIpc({
    ipc,
    historyRepository: createAiChatHistoryRepository(),
    getCredentials: () => deps.readStoreConfigSafe()?.userCredentials || {},
    getSidebar: () => deps.getSideView?.()?.webContents,
  });
}

function createMembership(deps) {
  return createMembershipService({
    applyResolvedConfigToStore: deps.applyResolvedConfigToStore,
    getGlobalHttpClient: deps.getGlobalHttpClient,
    licenseCache: deps.licenseCache,
    logger: deps.logger,
    readStoreConfigSafe: deps.readStoreConfigSafe,
    refreshAllowedPlatformsAndNotify: deps.refreshAllowedPlatformsAndNotify,
    sendToSide: deps.sendToSide,
    writeStoreConfigSafe: deps.writeStoreConfigSafe,
  });
}

function ensureMembershipHttpClient(deps) {
  const current = deps.getGlobalHttpClient?.();
  if (current) return current;
  if (typeof deps.createHttpClient !== 'function') return null;
  const client = deps.createHttpClient({ mainWindow: null });
  deps.setGlobalHttpClient?.(client);
  return deps.getGlobalHttpClient?.() || client;
}

async function restoreMembership(deps) {
  ensureMembershipHttpClient(deps);
  return createMembership(deps).restore();
}

async function bootstrapReadyApp(deps, ipc) {
  registerHomeConsoleIpc(ipc, deps);
  synchronizeAppStartupSettings(deps);
  scheduleCoreDirectoryInitialization(deps);
  scheduleUpdateStorageCleanup(deps);
  scheduleDeviceIdLog(deps);
  const accountService = createAndRegisterAccountServices(deps, ipc);
  createAndRegisterAiServices({ ...deps, accountService }, ipc);
  try {
    await restoreMembership(deps);
    void deps.aiServerDeviceService?.startAutomatically?.().catch((error) => {
      deps.logger.warn?.('[AIServerDevice] 自动登录失败:', error?.message || error);
    });
    await deps.bootstrapMainApp();
  } catch (error) {
    deps.logger.error?.('[启动] 打开主界面失败:', error?.message || error);
  }
}

module.exports = { bootstrapReadyApp, restoreMembership };
