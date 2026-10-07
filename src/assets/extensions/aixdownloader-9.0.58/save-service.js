/* Infinite Canvas save service. Loaded by the AIX service worker with importScripts(). */
(function (root) {
  "use strict";
  const DEFAULT_SERVER = "http://127.0.0.1:58112";
  const MAX_BYTES = 50 * 1024 * 1024;
  const CAPTURE_PREFIX = "ic-save:capture:";
  const RESULT_PREFIX = "ic-save:result:";
  const inflight = new Map();

  const ext = typeof chrome !== "undefined" ? chrome : null;
  const promisify = (fn, ctx, args) => new Promise((resolve, reject) => {
    if (typeof fn !== "function") return reject(new Error("Chrome API unavailable"));
    try { fn.call(ctx, ...(args || []), value => { const err = ext && ext.runtime && ext.runtime.lastError; if (err) reject(new Error(err.message)); else resolve(value); }); }
    catch (error) { reject(error); }
  });
  const storageArea = () => ext && ext.storage && (ext.storage.session || ext.storage.local);
  async function storageGet(key) { const area = storageArea(); if (!area) return {}; return promisify(area.get, area, [key]); }
  async function storageSet(value) { const area = storageArea(); if (!area) return; return promisify(area.set, area, [value]); }
  async function storageRemove(key) { const area = storageArea(); if (!area) return; return promisify(area.remove, area, [key]); }

  function cleanServerUrl(value) { const url = String(value || DEFAULT_SERVER).trim().replace(/\/+$/, ""); return /^https?:\/\//i.test(url) ? url : DEFAULT_SERVER; }
  function normalizeSettings(raw) {
    const old = raw && typeof raw === "object" ? raw : {};
    return { ...old, serverUrl: cleanServerUrl(old.serverUrl || old.aixAssetServer || DEFAULT_SERVER), theme: ["light", "dark", "system"].includes(old.theme) ? old.theme : "system" };
  }
  async function readSettings() {
    const values = await storageGet(["icSaveSettings", "settings", "aixAssetServer"]);
    const old = values.icSaveSettings || values.settings || {};
    return normalizeSettings({ ...old, aixAssetServer: values.aixAssetServer || old.aixAssetServer });
  }
  async function writeSettings(payload) {
    const current = await readSettings();
    const incoming = payload && payload.settings && typeof payload.settings === "object" ? payload.settings : (payload || {});
    const next = normalizeSettings({ ...current, ...incoming, serverUrl: incoming.serverUrl || incoming.server || current.serverUrl });
    await storageSet({ icSaveSettings: next, settings: { ...(current || {}), serverUrl: next.serverUrl, theme: next.theme }, aixAssetServer: next.serverUrl });
    return next;
  }
  function timeoutSignal(ms) { const controller = typeof AbortController !== "undefined" ? new AbortController() : null; const timer = setTimeout(() => controller && controller.abort(), ms); return { signal: controller && controller.signal, done: () => clearTimeout(timer) }; }
  async function request(serverUrl, path, options = {}) {
    const timer = timeoutSignal(options.timeout || 30000);
    try {
      const headers = new Headers(options.headers || {});
      if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      const response = await fetch(`${cleanServerUrl(serverUrl)}${path}`, { ...options, headers, signal: timer.signal });
      const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
      if (!response.ok) throw new Error((data && data.detail) || (data && data.message) || `服务器返回 ${response.status}`);
      return data;
    } catch (error) { if (error && error.name === "AbortError") throw new Error("服务器请求超时"); throw error; }
    finally { timer.done(); }
  }
  function librariesPayload(data) { const value = data && data.library ? data.library : data; return { libraries: Array.isArray(value && value.libraries) ? value.libraries : [], active_library_id: value && value.active_library_id ? value.active_library_id : "" }; }
  function mutable(library) { return library && !library.readonly && library.type !== "workflow"; }
  function targetLibrary(data, mode) {
    const value = librariesPayload(data); const allowedType = mode === "prompt" ? "prompt" : "asset";
    const libraries = value.libraries.filter(item => mutable(item) && (item.type || allowedType) === allowedType);
    return { libraries, active_library_id: value.active_library_id };
  }
  async function initData(mode, settings) {
    const endpoint = mode === "prompt" ? "/api/prompt-libraries" : "/api/asset-library";
    const data = await request(settings.serverUrl, endpoint);
    return { settings, library: targetLibrary(data, mode) };
  }
  async function initAllData(settings) {
    const [assets, prompts] = await Promise.all([
      request(settings.serverUrl, "/api/asset-library"),
      request(settings.serverUrl, "/api/prompt-libraries")
    ]);
    const asset = targetLibrary(assets, "asset"); const prompt = targetLibrary(prompts, "prompt");
    return {
      settings,
      assetLibraries: asset.libraries,
      promptLibraries: prompt.libraries,
      activeAssetLibraryId: asset.active_library_id,
      activePromptLibraryId: prompt.active_library_id,
      // Keep a compact compatibility shape for older bubbles.
      library: { libraries: asset.libraries, active_library_id: asset.active_library_id }
    };
  }
  function captureKey(id) { return `${CAPTURE_PREFIX}${id}`; }
  function resultKey(id) { return `${RESULT_PREFIX}${id}`; }
  function randomId() { return `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`; }
  function mediaType(info) { const type = String(info && (info.mediaType || info.type) || "").toLowerCase(); if (type === "video" || type === "audio") return type; const url = sourceFromInfo(info).split(/[?#]/)[0].toLowerCase(); if (/\.(mp4|webm|mov|m4v|mkv|avi|m3u8|ts)$/.test(url)) return "video"; if (/\.(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(url)) return "audio"; return "image"; }
  function sourceFromInfo(info) { return String(info && (info.srcUrl || info.linkUrl || info.url) || "").trim(); }
  async function saveCapture(info, tab, mode) {
    const capture = { id: randomId(), mode: mode === "prompt" ? "prompt" : "asset", sourceUrl: sourceFromInfo(info), sourceName: String(info && (info.sourceName || info.linkText) || "网页素材").slice(0, 240), mediaType: mediaType(info), selectionText: String(info && info.selectionText || "").slice(0, 20000), pageTitle: String(tab && tab.title || "").slice(0, 500), pageUrl: String(info && info.pageUrl || tab && tab.url || "").slice(0, 2000), tabId: tab && tab.id, frameId: Number.isInteger(info && info.frameId) ? info.frameId : 0, createdAt: Date.now() };
    if (!capture.sourceUrl && mode === "asset") throw new Error("没有可保存的网页素材地址");
    await storageSet({ [captureKey(capture.id)]: capture });
    return capture;
  }
  async function sendToFrame(capture, message) {
    if (!ext || !ext.tabs || capture.tabId == null) throw new Error("当前页面无法打开保存面板");
    const payload = { ...message, capture };
    try { return await promisify(ext.tabs.sendMessage, ext.tabs, [capture.tabId, payload, { frameId: capture.frameId }]); }
    catch (_) {
      if (!ext.scripting || !ext.scripting.executeScript) throw new Error("网页保存面板无法注入当前页面");
      await promisify(ext.scripting.executeScript, ext.scripting, [{ target: { tabId: capture.tabId, frameIds: [capture.frameId] }, files: ["save-bubble-style.js", "save-bubble.js"] }]);
      return promisify(ext.tabs.sendMessage, ext.tabs, [capture.tabId, payload, { frameId: capture.frameId }]);
    }
  }
  async function open(info, tab, mode) { const capture = await saveCapture(info || {}, tab || {}, mode); await sendToFrame(capture, { channel: "ic-save", action: "open" }); return capture; }
  function validSender(sender, capture) {
    if (!capture) return false;
    if (ext && ext.runtime && ext.runtime.id && (!sender || sender.id !== ext.runtime.id)) return false;
    if (!sender || !sender.tab || sender.tab.id !== capture.tabId) return false;
    const frame = sender.frameId == null ? 0 : sender.frameId;
    return frame === (capture.frameId || 0);
  }
  function fail(error) { return { ok: false, error: error && error.message ? error.message : String(error || "保存失败") }; }
  async function captureFor(message, sender) { const values = await storageGet(captureKey(message.captureId)); const capture = values[captureKey(message.captureId)]; if (!validSender(sender, capture)) throw new Error("保存请求来源无效"); return capture; }
  function category(library, id) { const cats = Array.isArray(library && library.categories) ? library.categories : []; return cats.find(item => String(item && item.id) === String(id)); }
  function flattenCategories(library) { const out = []; const walk = list => (list || []).forEach(item => { if (item && item.id && item.type !== "workflow") { out.push(item); walk(item.children); } }); walk(library && library.categories); return out; }
  async function uploadMedia(settings, capture) {
    if (!capture.sourceUrl || !/^(https?:|data:)/i.test(capture.sourceUrl)) throw new Error("网页素材地址不可直接读取");
    const timer = timeoutSignal(45000); let response;
    try { response = await fetch(capture.sourceUrl, { credentials: "include", signal: timer.signal }); }
    catch (error) { if (error && error.name === "AbortError") throw new Error("网页素材读取超时"); throw error; }
    finally { timer.done(); }
    if (!response.ok) throw new Error(`网页素材读取失败（${response.status}）`);
    const length = Number(response.headers.get("content-length") || 0); if (length > MAX_BYTES) throw new Error("素材超过 50 MB 限制");
    const blob = await response.blob(); if (blob.size > MAX_BYTES) throw new Error("素材超过 50 MB 限制");
    const form = new FormData(); form.append("files", blob, capture.sourceName || "网页素材");
    const uploaded = await request(settings.serverUrl, "/api/ai/upload", { method: "POST", body: form });
    const file = uploaded && uploaded.files && uploaded.files[0]; if (!file || !file.url) throw new Error("服务器未返回素材地址"); return file;
  }
  async function downloadCapture(capture) { if (!capture.sourceUrl || !ext || !ext.downloads) return ""; try { await promisify(ext.downloads.download, ext.downloads, [{ url: capture.sourceUrl, filename: capture.sourceName || "网页素材", conflictAction: "uniquify", saveAs: false }]); return ""; } catch (error) { return error.message || "浏览器下载失败"; } }
  async function doSave(message, sender) {
    const capture = await captureFor(message, sender); const key = resultKey(capture.id); const prior = await storageGet(key); if (prior[key]) return prior[key];
    if (inflight.has(capture.id)) return inflight.get(capture.id);
    const task = (async () => {
      const settings = await readSettings(); const payload = message.payload && typeof message.payload === "object" ? { ...message.payload } : { ...message }; const mode = payload.target === "prompt" || payload.target === "asset" ? payload.target : capture.mode;
      if (payload.url && String(payload.url) !== capture.sourceUrl) throw new Error("素材地址与已捕获内容不一致");
      if (mode === "asset") {
        const data = await initData(mode, settings); const library = data.library.libraries.find(item => String(item.id) === String(payload.libraryId)) || null; if (!mutable(library)) throw new Error("请选择可写的图片资产库");
        const cat = category(library, payload.categoryId); if (!cat || !["image", "video", "audio"].includes(cat.type || "image")) throw new Error("请选择有效的媒体类目");
        const file = await uploadMedia(settings, capture); const itemData = await request(settings.serverUrl, "/api/asset-library/items", { method: "POST", body: JSON.stringify({ library_id: library.id, category_id: cat.id, url: file.url, name: String(payload.name || capture.sourceName || "网页素材").trim().slice(0, 240) }) });
        const warning = payload.download ? await downloadCapture(capture) : ""; const result = { item: itemData && itemData.item ? itemData.item : itemData, ...(warning ? { warning } : {}) }; try { await writeSettings({ assetLibraryId: library.id, assetCategoryId: cat.id }); } catch (_) {} await storageSet({ [key]: result }); return result;
      }
      const data = await initData("prompt", settings); const library = data.library.libraries.find(item => String(item.id) === String(payload.libraryId)) || null; if (!mutable(library)) throw new Error("请选择可写的提示词库");
      const positive = String(payload.positive || capture.selectionText || "").trim(); if (!positive) throw new Error("正向提示词不能为空");
      let reference = ""; if (payload.includeReference && capture.mediaType === "image") reference = (await uploadMedia(settings, capture)).url;
      const categories = flattenCategories(library); const categoryId = categories.some(item => String(item.id) === String(payload.categoryId)) ? payload.categoryId : "custom";
      const itemData = await request(settings.serverUrl, "/api/prompt-libraries/items", { method: "POST", body: JSON.stringify({ library_id: library.id, category: categoryId || "custom", name: String(payload.name || capture.sourceName || "网页提示词").trim().slice(0, 240), positive, negative: String(payload.negative || "").trim(), scene: String(payload.scene || "").trim(), reference_image: reference, reference_images: reference ? [reference] : [] }) });
      const warning = payload.download ? await downloadCapture(capture) : ""; const result = { item: itemData && itemData.item ? itemData.item : itemData, ...(warning ? { warning } : {}) }; try { await writeSettings({ promptLibraryId: library.id, promptCategoryId: categoryId }); } catch (_) {} await storageSet({ [key]: result }); return result;
    })();
    inflight.set(capture.id, task); try { return await task; } finally { inflight.delete(capture.id); }
  }
  async function handle(message, sender) {
    try {
      const action = message && message.action; if (!["init", "settings", "save"].includes(action)) throw new Error("未知保存请求");
      const capture = await captureFor(message, sender); const mode = capture.mode;
      if (action === "settings") { const settings = await writeSettings(message.payload || message.settings || {}); return { ok: true, data: await initAllData(settings) }; }
      if (action === "init") { const settings = await readSettings(); return { ok: true, data: await initAllData(settings) }; }
      return { ok: true, data: await doSave(message, sender) };
    } catch (error) { return fail(error); }
  }
  function install() {
    if (!ext || !ext.runtime || !ext.runtime.onMessage || install.done) return; install.done = true;
    ext.runtime.onMessage.addListener((message, sender, sendResponse) => { if (!message || message.channel !== "ic-save") return undefined; handle(message, sender).then(sendResponse); return true; });
  }
  root.icSaveOpen = open; root.icSaveService = { open, handle, request, readSettings, writeSettings, initData, initAllData, normalizeSettings, uploadMedia, validSender };
  install();
  if (typeof module !== "undefined" && module.exports) module.exports = root.icSaveService;
})(typeof globalThis !== "undefined" ? globalThis : this);


