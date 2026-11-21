'use strict';

function safe(handler) {
  return async (_event, payload = {}) => {
    try { return await handler(payload); } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
}

function registerAiSettingsIpc({ ipc, service, onModelsChanged = () => {} }) {
  ipc.handle('get-ai-control-custom-api', safe(() => service.getCustomApi()));
  ipc.handle('set-ai-control-custom-api', safe((payload) => {
    const result = service.setCustomApi(payload);
    if (result.ok) onModelsChanged();
    return result;
  }));
  ipc.handle('ai-control-custom-models-list', safe(() => service.getCustomApis()));
  ipc.handle('ai-control-custom-model-save', safe((payload) => {
    const result = service.saveCustomApi(payload);
    if (result.ok) onModelsChanged();
    return result;
  }));
  ipc.handle('ai-control-custom-model-save-many', safe((payload) => {
    const result = service.saveCustomApis(payload);
    if (result.ok) onModelsChanged();
    return result;
  }));
  ipc.handle('ai-control-custom-model-delete', safe((payload) => {
    const result = service.deleteCustomApi(payload);
    if (result.ok) onModelsChanged();
    return result;
  }));
  ipc.handle('ai-control-custom-model-discover', safe((payload) => service.fetchModels(payload)));
}

module.exports = { registerAiSettingsIpc };
