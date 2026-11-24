'use strict';

(() => {
  const api = window.aiFree.mcpDebug;
  const element = (id) => document.getElementById(id);
  const surface = element('preview');
  const image = element('frame');
  const marker = element('cursor');
  const toggle = element('toggle');
  const openFixture = element('open-fixture');
  const targetMode = element('target-mode');
  const state = { frame: null, running: false, revision: 0, busy: false, gesture: null };
  let timer;
  let sending = false;
  const queue = [];

  function setText(id, text) { element(id).textContent = text; }

  async function stop(message = '鼠标调试已停止') {
    ++state.revision;
    state.running = false;
    state.frame = null;
    cancelGesture();
    queue.length = 0;
    clearTimeout(timer);
    image.hidden = true;
    image.removeAttribute('src');
    marker.hidden = true;
    element('placeholder').hidden = false;
    toggle.textContent = '鼠标控制调试';
    openFixture.disabled = false;
    targetMode.disabled = false;
    setText('status', message);
    const result = await api.stop();
    if (!result.ok) setText('status', result.error.message);
  }

  async function renderFrame(frame, revision) {
    const decoded = new Image();
    decoded.src = frame.dataUrl;
    await decoded.decode();
    if (!state.running || revision !== state.revision) return;
    state.frame = { ...frame, width: decoded.naturalWidth, height: decoded.naturalHeight };
    image.src = frame.dataUrl;
    image.hidden = false;
    element('placeholder').hidden = true;
    setText('browser', frame.browserName || '本地浏览器');
    setText('target-url', frame.url);
    setText('viewport', `${frame.viewWidth} × ${frame.viewHeight}`);
    timer = setTimeout(() => void poll(revision), 100);
  }

  async function poll(revision) {
    try {
      if (!state.running || revision !== state.revision) return;
      const next = await api.frame();
      if (!state.running || revision !== state.revision) return;
      if (next.ok) await renderFrame(next.data, revision);
      else await stop(next.error.message);
    } catch (_) {
      if (revision === state.revision) await stop('预览已断开');
    }
  }

  async function start() {
    const revision = ++state.revision;
    state.running = true;
    targetMode.disabled = true;
    openFixture.disabled = true;
    const result = await api.start(targetMode.value);
    if (!state.running || revision !== state.revision) return;
    if (!result.ok) { await stop(result.error.message); return; }
    toggle.textContent = '停止鼠标调试';
    setText('status', '已接管当前网页');
    await renderFrame(result.data, revision);
  }

  function position(event) {
    const frame = state.frame;
    if (!frame || !state.running) return null;
    const rect = surface.getBoundingClientRect();
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    if (scale <= 0) return null;
    const w = frame.width * scale;
    const h = frame.height * scale;
    const previewX = event.clientX - rect.left;
    const previewY = event.clientY - rect.top;
    const x = (previewX - (rect.width - w) / 2) / w;
    const y = (previewY - (rect.height - h) / 2) / h;
    setText('position', `${Math.round(event.clientX)}, ${Math.round(event.clientY)}`);
    if (x < 0 || x >= 1 || y < 0 || y >= 1) { marker.hidden = true; setText('mapped', '—'); return null; }
    marker.style.left = `${previewX}px`;
    marker.style.top = `${previewY}px`;
    marker.hidden = false;
    const { viewWidth, viewHeight } = frame;
    setText('mapped', `${Math.floor(x * viewWidth)}, ${Math.floor(y * viewHeight)}`);
    return { x, y, viewWidth, viewHeight };
  }

  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length && state.running) {
        const input = queue.shift();
        const revision = state.revision;
        const reply = await api.input(input);
        if (revision !== state.revision) continue;
        if (reply.ok) setText('receipt', `${reply.data.tool} · ${reply.data.dispatched}`);
        else if (reply.error.code === 'MCP_DEBUG_INPUT_STALE') {
          queue.length = 0;
          cancelGesture();
          setText('receipt', '等待视口同步');
        } else { await stop(reply.error.message); }
      }
    } catch (_) {
      await stop('鼠标输入连接已断开');
    } finally { sending = false; }
  }

  function enqueue(input) {
    if (!state.running) return;
    if (queue.length >= 48) { void stop('输入积压，调试已释放'); return; }
    queue.push(input);
    void pump();
  }

  function cancelGesture() {
    const gesture = state.gesture;
    state.gesture = null;
    if (gesture && surface.hasPointerCapture(gesture.id)) surface.releasePointerCapture(gesture.id);
  }

  function pointerDown(event) {
    const point = position(event);
    if (!point || event.pointerType !== 'mouse' || ![0, 2].includes(event.button) || state.gesture) return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    state.gesture = { id: event.pointerId, point, x: event.clientX, y: event.clientY, button: event.button };
  }

  function leavePreview() { marker.hidden = true; }

  function pointerMove(event) {
    if (event.pointerType === 'mouse') position(event);
  }

  function mouseAction(gesture, point, event) {
    const distance = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
    if (distance >= 6) {
      if (gesture.button === 0) enqueue({ ...gesture.point, action: 'drag', to_x: point.x, to_y: point.y });
      return;
    }
    const action = gesture.button === 2 ? 'right_click' : element('double-click').checked ? 'double_click' : 'click';
    enqueue({ ...point, action });
  }

  function pointerUp(event) {
    const gesture = state.gesture;
    if (!gesture || gesture.id !== event.pointerId || gesture.button !== event.button) return;
    const point = position(event);
    cancelGesture();
    if (point) mouseAction(gesture, point, event);
  }

  surface.addEventListener('pointerdown', pointerDown);
  surface.addEventListener('pointermove', pointerMove);
  surface.addEventListener('pointerup', pointerUp);
  surface.addEventListener('pointercancel', cancelGesture);
  surface.addEventListener('lostpointercapture', cancelGesture);
  surface.addEventListener('pointerleave', leavePreview);
  surface.addEventListener('contextmenu', (event) => event.preventDefault());
  surface.addEventListener('wheel', (event) => {
    const point = position(event);
    if (!point) return;
    event.preventDefault();
    if (!event.deltaY) return;
    const factor = [1, 16, point.viewHeight][event.deltaMode] || 1;
    const amount = Math.min(1200, Math.max(1, Math.round(Math.abs(event.deltaY) * factor)));
    enqueue({ ...point, action: 'scroll', direction: event.deltaY < 0 ? 'up' : 'down', amount });
  }, { passive: false });
  openFixture.addEventListener('click', async () => {
    openFixture.disabled = true;
    try {
      const result = await api.openFixture();
      if (result.ok) targetMode.value = 'fixture';
      if (result.ok) targetMode.value = 'fixture';
      setText('status', result.ok ? '测试页已打开，可以启动鼠标调试' : result.error.message);
    } finally { openFixture.disabled = false; }
  });
  toggle.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    toggle.disabled = true;
    try { if (state.running) await stop(); else await start(); }
    catch (_) { await stop('调试连接不可用'); }
    finally { toggle.disabled = false; state.busy = false; }
  });
  window.addEventListener('blur', () => { if (state.running) void stop('面板失焦，已释放接管'); });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.running) void stop();
  });
  void api.catalog().then((result) => {
    if (!result.ok) return;
    const rows = result.data.tools.map((tool) => {
      const row = document.createElement('li');
      row.textContent = tool.name;
      row.title = tool.description || '';
      return row;
    });
    element('tools').replaceChildren(...rows);
  });
  const restartButton = element('restart-app');
  const autoRestart = element('auto-restart');
  let restartPoll;
  async function refreshRestartStatus() {
    try {
      const result = await api.restartStatus();
      if (!result.ok) { setText('restart-status', result.error.message); return; }
      const info = result.data;
      autoRestart.checked = info.autoRestart === true;
      restartButton.disabled = !info.available || !info.pending || info.restarting || Boolean(info.busyReason);
      if (!info.available) setText('restart-status', '当前不是可重启的源码开发构建');
      else if (info.restarting) setText('restart-status', '正在安全关闭并重启应用…');
      else if (info.pending && info.busyReason) setText('restart-status', `检测到新源码（${info.currentHash.slice(0, 12)}），等待空闲：${info.busyReason}`);
      else if (info.pending) setText('restart-status', `检测到新源码（${info.currentHash.slice(0, 12)}），可以重启加载`);
      else setText('restart-status', `源码已是当前构建（${info.appliedHash.slice(0, 12)}）`);
    } catch (_) { setText('restart-status', '无法读取开发重启状态'); }
  }
  autoRestart.addEventListener('change', async () => {
    autoRestart.disabled = true;
    try {
      const result = await api.setAutoRestart(autoRestart.checked);
      if (!result.ok) setText('restart-status', result.error.message);
      else await refreshRestartStatus();
    } finally { autoRestart.disabled = false; }
  });
  restartButton.addEventListener('click', async () => {
    if (!window.confirm('将按正常退出流程关闭并重启 AI-FREE，以加载最新源码。正在执行的操作不会自动重放；重启后请先核对未确认的页面状态。继续吗？')) return;
    restartButton.disabled = true;
    const result = await api.restartApp();
    if (!result.ok) { setText('restart-status', result.error.message); await refreshRestartStatus(); }
    else setText('restart-status', '正在安全关闭并重启应用…');
  });
  void refreshRestartStatus();
  restartPoll = setInterval(() => void refreshRestartStatus(), 1500);
  window.addEventListener('unload', () => clearInterval(restartPoll), { once: true });
})();
