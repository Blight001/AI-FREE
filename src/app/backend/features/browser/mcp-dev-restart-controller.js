'use strict';

function sourceHash(fs, manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return typeof manifest.sourceHash === 'string' ? manifest.sourceHash : '';
  } catch (_) { return ''; }
}

function currentBuildHash(fs, manifestPath, disposed) {
  return manifestPath && !disposed ? sourceHash(fs, manifestPath) : '';
}

function statusFor(fs, manifestPath, appliedHash, currentHash, autoRestart, restarting, busyReason) {
  return { available: Boolean(currentHash && appliedHash), pending: Boolean(currentHash && currentHash !== appliedHash),
    autoRestart, restarting, appliedHash, currentHash, busyReason };
}

function createBusyReasonReader(checks) {
  return () => {
    for (const check of checks) {
      const busy = check?.();
      if (busy) return typeof busy === 'string' ? busy : '当前仍有对话、测试或浏览器接管操作';
    }
    return '';
  };
}

function createMcpDevRestartController({ app, fs, path, isDevMode, isBusy = () => false, logger = console, timers = globalThis }) {
  const manifestPath = isDevMode && app?.getAppPath
    ? path.join(app.getAppPath(), 'build-manifest.json') : '';
  const appliedHash = manifestPath ? sourceHash(fs, manifestPath) : '';
  let autoRestart = false;
  let restarting = false;
  let disposed = false;
  let autoTimer = null;
  const busyChecks = new Set([isBusy]);

  const busyReason = createBusyReasonReader(busyChecks);

  function status() {
    const currentHash = currentBuildHash(fs, manifestPath, disposed);
    return statusFor(fs, manifestPath, appliedHash, currentHash, autoRestart, restarting, busyReason());
  }

  function stopAutoTimer() {
    if (!autoTimer) return;
    timers.clearInterval(autoTimer);
    autoTimer = null;
  }

  async function restartNow() {
    const current = status();
    if (!current.available) throw new Error('仅已生成源码构建的开发版支持安全重启');
    if (!current.pending) throw new Error('没有检测到新的源码构建，请先运行 npm run prepare:source');
    const busy = current.busyReason;
    if (busy) throw Object.assign(new Error(`${busy}。请结束操作并核对页面后重试。`), { code: 'MCP_DEV_RESTART_BUSY' });
    if (restarting) return { scheduled: true };
    if (typeof app.relaunch !== 'function' || typeof app.quit !== 'function') throw new Error('当前 Electron 生命周期不支持应用重启');
    restarting = true;
    try {
      app.relaunch();
      app.quit();
      logger.info?.('[MCP开发重启] 新源码已构建，正在按应用退出流程重启');
      return { scheduled: true };
    } catch (error) {
      restarting = false;
      throw error;
    }
  }

  function checkAutoRestart() {
    const current = status();
    if (disposed || !autoRestart || !current.pending || restarting) { stopAutoTimer(); return; }
    if (current.busyReason) return;
    stopAutoTimer();
    void restartNow().catch((error) => logger.warn?.('[MCP开发重启] 自动重启未执行:', error.message));
  }

  function scheduleAutoRestart() {
    if (!autoRestart || autoTimer || disposed) return;
    autoTimer = timers.setInterval(checkAutoRestart, 1000);
    autoTimer.unref?.();
    checkAutoRestart();
  }

  function onManifestChange() {
    const current = status();
    if (current.pending) scheduleAutoRestart();
  }

  if (manifestPath) fs.watchFile(manifestPath, { interval: 1000, persistent: false }, onManifestChange);

  return {
    addBusyCheck(check) {
      if (typeof check !== 'function') return () => {};
      busyChecks.add(check);
      return () => busyChecks.delete(check);
    },
    getStatus: status,
    restart: restartNow,
    setAutoRestart(value) {
      autoRestart = value === true;
      if (autoRestart && status().pending) scheduleAutoRestart();
      else if (!autoRestart) stopAutoTimer();
      return status();
    },
    dispose() {
      disposed = true;
      stopAutoTimer();
      if (manifestPath) fs.unwatchFile(manifestPath, onManifestChange);
    },
  };
}

module.exports = { createMcpDevRestartController };
