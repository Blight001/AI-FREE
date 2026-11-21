// 网络诊断只进入开发模式的首页日志缓冲区，不回退到 console.*。
const { appContext } = require('./app-context');

function writeDebugConsoleOnly(level, ...args) {
  try {
    const sink = appContext.getDebugConsoleWrite();
    if (typeof sink !== 'function') return false;
    sink(String(level || 'info'), args);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  writeDebugConsoleOnly,
};
