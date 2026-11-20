const { createAppConsoleBridge } = require('../runtime/app-console');
const { appContext } = require('../runtime/app-context');

function sendToWindow(window, channel, args) {
  const contents = window?.webContents;
  if (!contents || contents.isDestroyed()) return false;
  contents.send(channel, ...args);
  return true;
}

function createUiBridge({
  getMainWindow,
  getSideView,
  getControlPanelWindow,
  getDevConsoleWindow = () => null,
  getNetworkMagicPopupWindow = () => null,
  isDevMode = false,
}) {
  let sideView = null;
  let mainWindow = null;
  let controlPanelWindow = null;

  const appConsoleBridge = createAppConsoleBridge({
    historyLimit: 500,
    getSenders: () => {
      sideView = getSideView();
      controlPanelWindow = typeof getControlPanelWindow === 'function' ? getControlPanelWindow() : null;
      const senders = [];
      if (sideView && sideView.webContents && !sideView.webContents.isDestroyed()) {
        senders.push(sideView.webContents);
      }
      if (controlPanelWindow && controlPanelWindow.webContents && !controlPanelWindow.webContents.isDestroyed()) {
        senders.push(controlPanelWindow.webContents);
      }
      const debugWindow = isDevMode ? getDevConsoleWindow() : null;
      if (debugWindow?.webContents && !debugWindow.webContents.isDestroyed()) senders.push(debugWindow.webContents);
      return senders;
    },
    getDebugSenders: () => {
      sideView = getSideView();
      const senders = [];
      if (isDevMode && sideView?.webContents && !sideView.webContents.isDestroyed()) {
        senders.push(sideView.webContents);
      }
      const debugWindow = isDevMode ? getDevConsoleWindow() : null;
      if (debugWindow?.webContents && !debugWindow.webContents.isDestroyed()) {
        senders.push(debugWindow.webContents);
      }
      return senders;
    },
  });

  appConsoleBridge.install();
  // 供底层网络模块使用，刻意不回退到 console.*，避免调试专用日志泄漏到终端。
  appContext.setDebugConsoleWrite((level, args) => appConsoleBridge.pushDebugOnly(level, args));

// 处理：sendToSide的具体业务逻辑。
  function sendToSide(channel, ...args) {
    try {
      sideView = getSideView();
      mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
      controlPanelWindow = typeof getControlPanelWindow === 'function' ? getControlPanelWindow() : null;
      const sentToSide = sendToWindow(sideView, channel, args);
      const sentToMain = sendToWindow(mainWindow, channel, args);
      const sentToControl = sendToWindow(controlPanelWindow, channel, args);
      const popupWindow = typeof getNetworkMagicPopupWindow === 'function' ? getNetworkMagicPopupWindow() : null;
      const sentToPopup = sendToWindow(popupWindow, channel, args);
      return sentToSide || sentToMain || sentToControl || sentToPopup;
    } catch (_) {
      return false;
    }
  }

  return {
    sendToSide,
    getAppConsoleHistory: () => appConsoleBridge.getHistory(),
    getDebugConsoleHistory: () => appConsoleBridge.getDebugHistory(),
  };
}

module.exports = {
  createUiBridge,
};
