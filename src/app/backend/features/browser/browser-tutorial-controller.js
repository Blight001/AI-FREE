'use strict';

const { normalizeAiFreeBrowserSettings } = require('../../utils/ai-free-browser-settings');
const { DEFAULT_TUTORIAL_URL, TUTORIAL_BROWSER_TITLE, isTutorialBrowserName } = require('./tutorial-browser-identity');

const DEFAULT_BROWSER_TAB_URL = 'chrome://newtab/';
const VIP_SHOP_URL = 'https://wzyp.cn/shop/8Y3DD5YR';
const MINIMUM_BROWSER_TAB_ID = '1';

function text(value) {
  return String(value || '').trim();
}

class BrowserTutorialController {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger || console;
    this.tutorialOperation = Promise.resolve();
    this.minimumBrowserOpeningPromise = null;
  }

  resolveConfiguredTutorialUrl() {
    try { return text(this.deps.licenseCache?.getRuntimeConfig?.()?.tutorialUrl); } catch (_) { return ''; }
  }

  resolveDefaultTabUrl() {
    return DEFAULT_BROWSER_TAB_URL;
  }

  readTutorialHistoryRecord() {
    try {
      const storePath = this.deps.getStorePath?.() || '';
      if (!storePath || !this.deps.fs?.existsSync?.(storePath)) return null;
      const store = JSON.parse(this.deps.fs.readFileSync(storePath, 'utf8') || '{}');
      const records = Array.isArray(store?.browserHistory) ? store.browserHistory : [];
      const matches = records
        .filter((item) => item?.kind === 'tutorial' || isTutorialBrowserName(text(item?.name)))
        .sort((left, right) => Number(right?.lastOpenedAt || 0) - Number(left?.lastOpenedAt || 0));
      const record = matches[0];
      if (!record?.id) return null;
      return { id: text(record.id), profileId: text(record.profileId), url: text(record.url),
        settings: normalizeAiFreeBrowserSettings(record.settings || {}) };
    } catch (_) {
      return null;
    }
  }

  findExistingTutorialTab() {
    return Array.from(this.deps.resolveTabs().values()).find((tab) => (
      tab?.isTutorialTab === true || isTutorialBrowserName(text(tab?.fixedTitle || tab?.runtimeTitle))
    ));
  }

  runTutorialOperation(operation) {
    const result = this.tutorialOperation.then(operation);
    this.tutorialOperation = result.then(() => {}, () => {});
    return result;
  }

  createFocusRestorer(options, focusBrowser) {
    const shouldRestore = !focusBrowser && (options.restoreSideFocus === true || this.deps.isSideViewFocused());
    return () => {
      if (!shouldRestore) return;
      this.deps.restoreSideViewFocus();
      setImmediate(this.deps.restoreSideViewFocus);
    };
  }

  createTutorialTab(destination, history, options) {
    const { targetUrl, guideUrl, previousGuideUrl, focusBrowser } = destination;
    const historyId = text(history?.id);
    const generatedId = historyId
      ? `browser-tab-${historyId.replace(/[^a-z0-9_-]/gi, '_')}`
      : 'browser-tab-tutorial-default';
    return this.deps.addTab(targetUrl, {
      tabId: text(options.tabId) || history?.profileId || generatedId,
      fixedTitle: TUTORIAL_BROWSER_TITLE,
      isTutorialTab: true,
      browserHistoryId: historyId,
      tutorialEntryUrl: previousGuideUrl || guideUrl,
      restoreLastSession: Boolean(history),
      focusBrowser,
      browserSettings: {
        ...(history?.settings || {}),
        region: 'cn',
        locale: 'zh-CN',
        acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
  }

  openTutorialTab(requestedUrl = '', options = {}) {
    return this.runTutorialOperation(() => this.openTutorialDestination(text(requestedUrl), options));
  }

  async selectDestination(tabId, { shop, guideUrl, targetUrl, previousGuideUrl, focusBrowser }) {
    const previousUrl = !shop && previousGuideUrl !== guideUrl ? previousGuideUrl : '';
    const opened = await this.deps.browserRuntimeManager.openForegroundTab(tabId, 'chromium', targetUrl, previousUrl);
    const tab = this.deps.resolveTabs().get(tabId);
    if (!tab) return null;
    if (!shop) tab.requestedUrl = guideUrl;
    tab.runtimeUrl = text(opened?.result?.url) || targetUrl;
    this.deps.switchTab(tabId, { focusBrowser });
    return tabId;
  }

  resolveDestination(requestedUrl, existingTab, history, options) {
    const shop = options.destination === 'shop';
    const previousGuideUrl = text(existingTab?.requestedUrl || history?.url);
    const explicitGuideUrl = shop ? '' : requestedUrl;
    const guideUrl = explicitGuideUrl || this.resolveConfiguredTutorialUrl() || previousGuideUrl || DEFAULT_TUTORIAL_URL;
    return { shop, guideUrl, previousGuideUrl, targetUrl: shop ? VIP_SHOP_URL : guideUrl, focusBrowser: options.focusBrowser === true };
  }

  async openTutorialDestination(requestedUrl, options) {
    const existingTab = this.findExistingTutorialTab();
    const history = existingTab ? null : this.readTutorialHistoryRecord();
    const destination = this.resolveDestination(requestedUrl, existingTab, history, options);
    const { focusBrowser, shop } = destination;
    const restoreFocus = this.createFocusRestorer(options, focusBrowser);
    try {
      const tabId = existingTab?.id || await this.createTutorialTab(destination, history, options);
      if (!tabId) return null;
      if (existingTab || history) return await this.selectDestination(tabId, destination);
      return tabId;
    } catch (error) {
      if (shop) throw error;
      this.logger.warn?.('[教程] 打开教程失败:', error?.code || 'TUTORIAL_OPEN_FAILED');
      return null;
    } finally {
      restoreFocus();
    }
  }

  async ensureMinimumBrowserTab() {
    const tabs = this.deps.resolveTabs();
    if (tabs.size) return text(tabs.keys().next().value);
    if (this.minimumBrowserOpeningPromise) return this.minimumBrowserOpeningPromise;
    this.deps.setActiveTabId?.(null);
    this.minimumBrowserOpeningPromise = this.deps.addTab(DEFAULT_BROWSER_TAB_URL, {
      tabId: MINIMUM_BROWSER_TAB_ID, fixedTitle: '新建窗口', focusBrowser: false,
      showLoadingPage: true, restoreLastSession: false,
    });
    try { return await this.minimumBrowserOpeningPromise; } finally { this.minimumBrowserOpeningPromise = null; }
  }

  toApi() {
    return {
      ensureMinimumBrowserTab: this.ensureMinimumBrowserTab.bind(this),
      openTutorialTab: this.openTutorialTab.bind(this),
      resolveDefaultTabUrl: this.resolveDefaultTabUrl.bind(this),
    };
  }
}

function createBrowserTutorialController(deps = {}) {
  return new BrowserTutorialController(deps).toApi();
}

module.exports = { createBrowserTutorialController };
