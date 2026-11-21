'use strict';

const { isHomeSender } = require('../window/home-dev-sender');

function registerAiServerDeviceIpc({ ipc, service, getMainWindow }) {
  const safe = (handler) => async (event, payload = {}) => {
    if (!isHomeSender(event, getMainWindow()?.webContents)) {
      return { ok: false, error: '请在首页模型设置管理 HeySure 服务器' };
    }
    try { return await handler(payload); } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
  ipc.handle('get-ai-server-device-status', safe(() => ({ ok: true, status: service.status() })));
  ipc.handle('login-ai-server-device', safe((payload) => service.login(payload)));
  ipc.handle('logout-ai-server-device', safe(() => service.logout()));
}

module.exports = { registerAiServerDeviceIpc };
