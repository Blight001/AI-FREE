const homeConsoleTime = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', hour12: false });
const homeConsoleLevel = { info: '普通', warn: '警告', error: '错误' };

function homeConsoleSourceHue(source) {
  let hash = 0;
  for (const char of source) hash = (Math.imul(hash, 31) + char.codePointAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function homeConsoleLevelKey(level) {
  return Object.hasOwn(homeConsoleLevel, level) ? level : 'info';
}

function formatHomeConsoleTime(timestamp) {
  return homeConsoleTime.format(new Date(timestamp));
}

function createHomeConsoleEntry(entry) {
  const row = document.createElement('li');
  const meta = document.createElement('div');
  const time = document.createElement('time');
  const level = document.createElement('strong');
  const source = document.createElement('span');
  const text = document.createElement('div');
  row.dataset.level = homeConsoleLevelKey(entry.level);
  time.dateTime = entry.timestamp;
  time.textContent = formatHomeConsoleTime(entry.timestamp);
  level.className = 'home-console-level';
  level.textContent = homeConsoleLevel[row.dataset.level];
  source.className = 'home-console-source-tag';
  source.style.setProperty('--source-hue', String(homeConsoleSourceHue(entry.source)));
  source.textContent = entry.source;
  meta.append(time, level, source);
  text.className = 'home-console-message';
  text.textContent = entry.text;
  row.append(meta, text);
  return row;
}

function bindHomeConsoleActions(getEntries, canClear, clearHistory) {
  const copy = document.getElementById('home-console-copy');
  const clear = document.getElementById('home-console-clear');
  const notice = document.getElementById('home-console-notice');
  let clearing = false;
  const sync = () => {
    copy.disabled = clearing || !getEntries().length;
    clear.disabled = clearing || !canClear();
  };
  copy.addEventListener('click', async () => {
    const entries = getEntries();
    const text = entries.map((entry) => {
      const level = homeConsoleLevel[homeConsoleLevelKey(entry.level)];
      return `${formatHomeConsoleTime(entry.timestamp)} [${level}] [${entry.source}] ${entry.text}`;
    }).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      notice.textContent = `已复制 ${entries.length} 条日志`;
    } catch (_) {
      notice.textContent = '无法写入剪贴板，请手动选择并复制日志';
    }
  });
  clear.addEventListener('click', async () => {
    clearing = true;
    sync();
    try {
      await clearHistory();
      notice.textContent = '已清空日志';
    } catch (error) {
      notice.textContent = `清空失败：${error.message}`;
    } finally {
      clearing = false;
      sync();
    }
  });
  return sync;
}

function createHomeConsoleView(clearHistory) {
  const source = document.getElementById('home-console-source');
  const status = document.getElementById('home-console-status');
  const list = document.getElementById('home-console-entries');
  const follow = document.getElementById('home-console-follow');
  let history = [];
  let entries = [];
  const syncActions = bindHomeConsoleActions(() => entries, () => history.length > 0, clearHistory);

  function scrollToLatest() {
    if (follow.checked) list.scrollTop = list.scrollHeight;
  }

  function render() {
    entries = history.filter((entry) => !source.value || entry.source === source.value);
    const previousTop = list.scrollTop;
    list.replaceChildren(...entries.map(createHomeConsoleEntry));
    if (follow.checked) scrollToLatest();
    else list.scrollTop = previousTop;
    showCount();
    syncActions();
  }

  function showCount() {
    const count = entries.length ? `${entries.length} 条日志` : '暂无日志';
    if (status.textContent !== count) status.textContent = count;
  }

  function setHistory(next) {
    history = next;
    const names = [...new Set(history.map((entry) => entry.source))].sort();
    if (source.length !== names.length + 1 || names.some((name, index) => source.options[index + 1].value !== name)) {
      const selected = source.value;
      source.replaceChildren(new Option('全部信息', ''), ...names.map((name) => new Option(name, name)));
      source.value = names.includes(selected) ? selected : '';
    }
    render();
  }

  source.addEventListener('change', render);
  follow.addEventListener('change', scrollToLatest);
  return { setHistory, scrollToLatest, showCount, showError: (error) => {
    status.textContent = `日志读取失败：${error.message}`;
  } };
}

function bindHomeConsole() {
  const home = document.getElementById('browser-empty-state');
  const panel = document.getElementById('home-console');
  const visible = () => !home.hidden && !panel.hidden && !document.hidden;
  const diagnostics = window.aiFree.diagnostics;
  const view = createHomeConsoleView(clearHistory);
  let revision = -1;
  let active = false;
  let pending = false;
  let timer;

  function applySnapshot(result) {
    if (!result.ok) throw new Error(result.error.message);
    if (result.data.revision < revision) return;
    revision = result.data.revision;
    if (result.data.history) view.setHistory(result.data.history);
    else view.showCount();
  }

  async function clearHistory() {
    applySnapshot(await diagnostics.clearConsoleHistory());
  }

  async function refresh() {
    pending = true;
    try {
      const result = await diagnostics.getConsoleHistory(revision);
      if (visible()) applySnapshot(result);
    } catch (error) {
      if (visible()) view.showError(error);
    } finally {
      pending = false;
      if (visible()) timer = setTimeout(refresh, 1000);
    }
  }

  function sync() {
    const next = visible();
    if (next === active) return;
    active = next;
    clearTimeout(timer);
    if (!active) return;
    view.scrollToLatest();
    if (!pending) void refresh();
  }

  document.addEventListener('visibilitychange', sync);
  return sync;
}
