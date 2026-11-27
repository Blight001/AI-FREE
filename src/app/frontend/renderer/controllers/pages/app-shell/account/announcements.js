// 首页个人中心公告

let cachedAppVersion = '';

const {
  stripVersionPrefix,
  compareVersions,
} = window.AiFreeVersionUtils;
const ServerMessageUtils = window.AiFreeServerMessageUtils || {};
const getServerMessageText = ServerMessageUtils.getServerMessageText || (() => '');
const getServerMessageType = ServerMessageUtils.getServerMessageType || (() => '');
const getUpdateVersion = ServerMessageUtils.getUpdateVersion || (() => '');
const isShutdownAnnouncement = ServerMessageUtils.isShutdownAnnouncement || (() => false);
const isUpdateLikeMessage = ServerMessageUtils.isUpdateLikeMessage || (() => false);

// 获取/读取/解析：toTextLines的具体业务逻辑。
function toTextLines(value) {
  const lines = [];

  const pushLine = (input) => {
    const text = String(input ?? '').trim();
    if (text) {
      if (text.includes('\n')) {
        text.split(/\r?\n+/).forEach((line) => {
          const item = String(line || '').trim();
          if (item) {
            lines.push(item);
          }
        });
        return;
      }
      lines.push(text);
    }
  };

  const walk = (input) => {
    if (input === null || input === undefined) {
      return;
    }

    if (Array.isArray(input)) {
      input.forEach(walk);
      return;
    }

    if (typeof input === 'object') {
      const preferred = input.text
        || input.message
        || input.content
        || input.title
        || input.name
        || '';

      if (preferred) {
        pushLine(preferred);
        return;
      }

      Object.values(input).forEach(walk);
      return;
    }

    const text = String(input).trim();
    if (!text) {
      return;
    }

    if (text.includes('\n')) {
      text.split(/\r?\n+/).forEach(pushLine);
      return;
    }

    pushLine(text);
  };

  walk(value);
  return lines.filter((line, index) => lines.indexOf(line) === index);
}

// 获取/读取/解析：collectUpdateFeatureLines的具体业务逻辑。
function collectUpdateFeatureLines(payload = {}) {
  const raw = payload.raw && typeof payload.raw === 'object' ? payload.raw : {};
  const featureSources = [
    payload.features,
    payload.feature,
    payload.featureList,
    payload.feature_list,
    payload.functions,
    payload.function,
    payload.functionList,
    payload.function_list,
    payload.highlights,
    payload.highlight,
    payload.releaseNotes,
    payload.release_notes,
    payload.notes,
    payload.updateNotes,
    payload.update_notes,
    raw.features,
    raw.feature,
    raw.featureList,
    raw.feature_list,
    raw.functions,
    raw.function,
    raw.functionList,
    raw.function_list,
    raw.highlights,
    raw.highlight,
    raw.releaseNotes,
    raw.release_notes,
    raw.notes,
    raw.updateNotes,
    raw.update_notes,
  ];

  const lines = [];
  featureSources.forEach((source) => {
    toTextLines(source).forEach((line) => {
      if (!lines.includes(line)) {
        lines.push(line);
      }
    });
  });
  return lines;
}

// 处理：buildAnnouncementHtml的具体业务逻辑。
function buildAnnouncementHtml(payload = {}) {
  const baseText = String(
    payload.content
    || payload.message
    || payload.announcement
    || payload.description
    || payload.detail
    || payload.title
    || ''
  ).trim();
  const baseLines = toTextLines(baseText);
  const featureLines = collectUpdateFeatureLines(payload);
  const htmlParts = [];

  baseLines.forEach((line) => {
    htmlParts.push(`<p>${escapeHtml(line)}</p>`);
  });

  featureLines.forEach((line) => {
    htmlParts.push(`<p>功能：${escapeHtml(line)}</p>`);
  });

  return htmlParts.join('');
}

// 获取/读取/解析：getCurrentAppVersion的具体业务逻辑。
async function getCurrentAppVersion() {
  const domVersion = stripVersionPrefix(safeGetEl('shell-app-version')?.textContent || '');
  if (domVersion) {
    cachedAppVersion = domVersion;
    return domVersion;
  }

  if (cachedAppVersion) {
    return cachedAppVersion;
  }

  if (typeof window.aiFree?.updates?.getAppVersion === 'function') {
    try {
      const resp = await window.aiFree.updates.getAppVersion();
      const version = stripVersionPrefix(resp?.version || '');
      if (version) {
        cachedAppVersion = version;
        return version;
      }
    } catch (e) {
      console.warn('[个人中心] 获取当前版本失败:', e?.message || e);
    }
  }

  return '';
}

// 处理：shouldSkipUpdateAnnouncement的具体业务逻辑。
async function shouldSkipUpdateAnnouncement(payload = {}) {
  const targetVersion = stripVersionPrefix(getUpdateVersion(payload));
  if (!targetVersion) {
    return false;
  }

  const currentVersion = await getCurrentAppVersion();
  if (!currentVersion) {
    return false;
  }

  return compareVersions(currentVersion, targetVersion) >= 0;
}

// 处理：normalizeUpdateAnnouncementPayload的具体业务逻辑。
function normalizeUpdateAnnouncementPayload(messageData = {}) {
  const version = stripVersionPrefix(getUpdateVersion(messageData));
  const content = buildAnnouncementHtml(messageData)
    || `<p>${escapeHtml(String(messageData.content || messageData.message || '发现新版本').trim())}</p>`;

  return {
    ...messageData,
    __htmlContent: true,
    type: 'announcement',
    message_type: 'update',
    announcement_id: String(
      messageData.announcement_id
      || messageData.announcementId
      || messageData.id
      || version
      || ''
    ).trim() || undefined,
    content,
    message: content,
    targetVersion: version || messageData.targetVersion || messageData.version || messageData.latestVersion || messageData.latest_version || '',
  };
}

// 右侧公告区的更新进度组件是“按需显示”的：
// 1. 收到更新通知时只更新公告文案，不展示进度
// 2. 只有用户确认下载后，主进程发出 app-update-activated，才开始显示进度
// 3. 下载完成后提示用户关闭软件完成更新，关闭后由主进程启动安装器
// 创建/初始化：initAnnouncementListener的具体业务逻辑。
function initAnnouncementListener() {
  bindAnnouncementMailControls();
  if (typeof window.aiFree?.ui?.onServerMessage === 'function') {
    window.aiFree.ui.onServerAnnouncementsReset(() => {
      announcements = [];
      const announcementContent = safeGetEl('announcement-content');
      if (announcementContent) {
        announcementContent.innerHTML = '<p>暂无公告内容</p>';
      }
    });

    // 普通公告只进公告栏，不进入更新弹窗逻辑。
    window.aiFree.ui.onServerMessage((messageData) => {
      const messageType = getServerMessageType(messageData);
      const messageText = getServerMessageText(messageData);

      // 服务器返回的普通公告、成功公告都写入公告栏；
      // 只有停用/更新类公告继续交给其它专门流程处理。
      const shouldShowInAnnouncementList = messageData.type === 'announcement'
        && !isUpdateLikeMessage(messageData)
        && !isShutdownAnnouncement(messageData)
        && !['shutdown', 'update', 'upgrade', 'app_update', 'software_update'].includes(messageType)
        && !messageText.includes('软件暂时无法使用')
        && !messageText.includes('停用');
      if (shouldShowInAnnouncementList) {
        updateAnnouncement(messageData);
      }
    });

    // 更新通知只显示“发现新版本”的文案，不展示进度。
    // 进度显示由 app-update-activated / app-update-progress 单独驱动。
    window.aiFree.updates.onNotice((messageData) => {
      void (async () => {
        try {
          if (await shouldSkipUpdateAnnouncement(messageData || {})) {
            return;
          }
          updateAnnouncement(normalizeUpdateAnnouncementPayload(messageData || {}));
        } catch (e) {
          console.warn('[个人中心] 处理更新公告失败:', e?.message || e);
        }
      })();
    });

  }
}

function storeAnnouncementRecord(announcementId, content, timestamp) {
  const existingIndex = announcements.findIndex((announcement) => announcement.id === announcementId);
  if (existingIndex >= 0) {
    announcements[existingIndex].content = content;
    announcements[existingIndex].timestamp = timestamp;
    return;
  }
  announcements.unshift({ id: announcementId, content, timestamp });
  if (announcements.length > MAX_ANNOUNCEMENTS) announcements = announcements.slice(0, MAX_ANNOUNCEMENTS);
}

function decorateAnnouncementHeader() {
  const announcementIcon = safeGetEl('announcement-icon');
  if (announcementIcon) {
    announcementIcon.textContent = '✉️';
    announcementIcon.style.color = '#409eff';
  }
  const announcementTitle = safeGetEl('announcement-title');
  if (announcementTitle) {
    announcementTitle.textContent = '公告';
    announcementTitle.style.color = '#409eff';
  }
}

function setAnnouncementMailOpen(open) {
  const bar = safeGetEl('announcement-bar');
  const button = safeGetEl('announcement-mail-btn');
  const nextOpen = open === true;
  if (bar) bar.hidden = !nextOpen;
  if (button) button.setAttribute('aria-expanded', String(nextOpen));
  if (nextOpen) {
    const dot = safeGetEl('announcement-mail-dot');
    if (dot) dot.hidden = true;
    const settings = safeGetEl('account-general-settings');
    if (settings?.open) homeDialogs.close(settings);
  }
}

function toggleAnnouncementMail(event) {
  event?.stopPropagation?.();
  const bar = safeGetEl('announcement-bar');
  setAnnouncementMailOpen(bar?.hidden !== false);
}

function markAnnouncementMailUnread() {
  const bar = safeGetEl('announcement-bar');
  const dot = safeGetEl('announcement-mail-dot');
  if (!dot) return;
  dot.hidden = bar?.hidden === false;
}

function bindAnnouncementMailControls() {
  const button = safeGetEl('announcement-mail-btn');
  if (!button || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';
  button.addEventListener('click', toggleAnnouncementMail);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && safeGetEl('announcement-bar')?.getClientRects().length) {
      setAnnouncementMailOpen(false);
    }
  });
}

// 设置/更新/持久化：updateAnnouncement的具体业务逻辑。
function updateAnnouncement(announcementData) {
  try {
    const announcementContent = safeGetEl('announcement-content');
    if (!announcementContent) {
      return;
    }

    const content = announcementData.__htmlContent === true
      ? String(announcementData.content || announcementData.message || '<p>暂无公告内容</p>').trim()
      : (buildAnnouncementHtml(announcementData)
        || `<p>${escapeHtml(String(announcementData.content || announcementData.message || announcementData.announcement || '暂无公告内容').trim())}</p>`);
    const announcementId = announcementData.announcement_id;
    storeAnnouncementRecord(announcementId, content, announcementData.timestamp || Date.now());
    decorateAnnouncementHeader();

    const contentHtml = announcements.map((ann) => String(ann.content || '')).join('');
    announcementContent.innerHTML = contentHtml || '<p>暂无公告内容</p>';
    markAnnouncementMailUnread();
  } catch (e) {
    console.error('[个人中心] 更新公告栏失败:', e);
  }
}
