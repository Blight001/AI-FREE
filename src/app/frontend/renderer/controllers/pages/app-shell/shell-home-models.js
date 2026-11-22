'use strict';

const modelTokenFields = {
  contextWindow: 'home-model-context-window',
  maxOutputTokens: 'home-model-max-output',
};

function modelElement(id) { return document.getElementById(id); }

function modelMessage(target, value, error = false) {
  target.textContent = value;
  target.dataset.state = error ? 'error' : 'normal';
}

async function loadHomeModels(state) {
  try {
    const result = await window.aiFree.ai.getCustomApis();
    if (!result?.ok) throw new Error(result?.error || '读取模型配置失败');
    state.models = Array.isArray(result.models) ? result.models : [];
    renderHomeModels(state);
  } catch (error) {
    modelMessage(state.status, error.message || String(error), true);
  }
}

function createModelAction(text, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', action);
  return button;
}

function renderHomeModels(state) {
  state.list.replaceChildren();
  if (!state.models.length) {
    const empty = document.createElement('li');
    empty.className = 'home-model-empty';
    empty.textContent = '尚未添加自定义模型';
    state.list.appendChild(empty);
    modelMessage(state.status, '');
    return;
  }
  state.models.forEach((model) => {
    const row = document.createElement('li');
    row.className = 'home-model-row';
    const summary = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = model.name || model.model;
    const detail = document.createElement('small');
    detail.textContent = `${model.model} · ${model.baseUrl}`;
    summary.append(title, detail);
    const actions = document.createElement('div');
    actions.append(
      createModelAction('编辑', () => state.openDialog(model)),
      createModelAction('删除', () => void deleteHomeModel(state, model)),
    );
    row.append(summary, actions);
    state.list.appendChild(row);
  });
  modelMessage(state.status, `${state.models.length} 个模型`);
}

function updateDiscoveredSelection(state) {
  const selected = Boolean(state.discoveredList.querySelector('input:checked'));
  modelElement('home-model-manual-field').hidden = selected;
  modelElement('home-model-id').required = !selected && !state.editingId;
}

function populateModelIdentity(model) {
  modelElement('home-custom-model-title').textContent = model ? '编辑模型' : '添加模型';
  modelElement('home-model-name').value = model?.name || '';
  modelElement('home-model-base-url').value = model?.baseUrl || '';
  modelElement('home-model-api-key').value = '';
  modelElement('home-model-api-key').placeholder = model?.hasApiKey ? '已保存；留空保持不变' : '可留空，支持无鉴权的本地接口';
  modelElement('home-model-id').value = model?.model || '';
}

function populateModelCapabilities(model) {
  modelElement('home-model-tools').checked = model?.supportsTools !== false;
  modelElement('home-model-images').checked = model?.supportsImageInput === true;
  modelElement('home-model-reasoning').checked = model?.supportsReasoning === true;
  modelElement('home-model-stream-output').checked = model?.streamOutput !== false;
  modelElement('home-model-custom-protocol').checked = model?.customProtocol === true;
}

function syncModelTokenInput(id) {
  const input = modelElement(id);
  const custom = modelElement(`${id}-preset`).value === 'custom';
  input.hidden = !custom;
  input.disabled = !custom;
  input.required = custom;
}

function populateModelTokenLimits(model) {
  for (const [field, id] of Object.entries(modelTokenFields)) {
    const preset = modelElement(`${id}-preset`);
    const value = Number(model?.[field]) > 0 ? String(model[field]) : '';
    preset.value = value;
    if (preset.selectedIndex < 0) preset.value = 'custom';
    modelElement(id).value = preset.value === 'custom' ? value : '';
    syncModelTokenInput(id);
  }
}

function readModelTokenLimit(id) {
  const presetValue = modelElement(`${id}-preset`).value;
  return presetValue === 'custom' ? modelElement(id).value : presetValue;
}

function populateModelDialog(model) {
  populateModelIdentity(model);
  populateModelCapabilities(model);
  populateModelTokenLimits(model);
}

function resetDiscoveredModels(state) {
  state.discovered.hidden = true;
  state.discoveredList.replaceChildren();
  updateDiscoveredSelection(state);
}

function openHomeModelDialog(state, model = null) {
  state.editingId = String(model?.id || '');
  state.form.reset();
  populateModelDialog(model);
  resetDiscoveredModels(state);
  modelMessage(state.dialogStatus, '');
  if (homeDialogs.open(state.dialog)) modelElement('home-model-base-url').focus();
}

async function deleteHomeModel(state, model) {
  if (!await homeDialogs.confirm(`删除模型“${model.name || model.model}”？`)) return;
  try {
    const result = await window.aiFree.ai.deleteCustomApi({ id: model.id });
    if (!result?.ok) throw new Error(result?.error || '删除失败');
    state.models = result.models || [];
    renderHomeModels(state);
  } catch (error) {
    modelMessage(state.status, error.message || String(error), true);
  }
}

function appendDiscoveredModels(state, models) {
  state.discoveredList.replaceChildren();
  models.forEach((model) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = model.id;
    checkbox.addEventListener('change', () => updateDiscoveredSelection(state));
    const text = document.createElement('span');
    text.textContent = model.name === model.id ? model.id : `${model.name} (${model.id})`;
    label.append(checkbox, text);
    state.discoveredList.appendChild(label);
  });
}

async function discoverHomeModels(state, button) {
  button.disabled = true;
  const resultNode = modelElement('home-model-discovery-status');
  resultNode.textContent = '正在读取…';
  try {
    const result = await window.aiFree.ai.discoverCustomApiModels({
      baseUrl: modelElement('home-model-base-url').value.trim(),
      apiKey: modelElement('home-model-api-key').value.trim(),
    });
    if (!result?.ok) throw new Error(result?.error || '获取模型列表失败');
    const models = Array.isArray(result.models) ? result.models : [];
    appendDiscoveredModels(state, models);
    state.discovered.hidden = !models.length;
    resultNode.textContent = models.length ? `发现 ${models.length} 个模型` : '接口未返回模型，可手动填写名称';
  } catch (error) {
    resultNode.textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
}

function modelSavePayload(state, model, name) {
  const payload = {
    id: state.editingId || undefined,
    name,
    baseUrl: modelElement('home-model-base-url').value.trim(),
    model,
    supportsTools: modelElement('home-model-tools').checked,
    supportsImageInput: modelElement('home-model-images').checked,
    supportsReasoning: modelElement('home-model-reasoning').checked,
    streamOutput: modelElement('home-model-stream-output').checked,
    customProtocol: modelElement('home-model-custom-protocol').checked,
    contextWindow: readModelTokenLimit(modelTokenFields.contextWindow),
    maxOutputTokens: readModelTokenLimit(modelTokenFields.maxOutputTokens),
  };
  const apiKey = modelElement('home-model-api-key').value.trim();
  if (apiKey || !state.models.find((item) => item.id === state.editingId)?.hasApiKey) payload.apiKey = apiKey;
  return payload;
}

function selectedModelIds(state) {
  const selected = [...state.discoveredList.querySelectorAll('input:checked')].map((item) => item.value);
  return state.editingId ? [modelElement('home-model-id').value.trim()]
    : selected.length ? selected : [modelElement('home-model-id').value.trim()];
}

async function saveHomeModels(state, event) {
  event.preventDefault();
  const ids = selectedModelIds(state);
  if (ids.some((id) => !id)) return modelMessage(state.dialogStatus, '请选择或填写模型名称', true);
  const submit = state.form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const baseName = modelElement('home-model-name').value.trim();
    const models = ids.map((id) => modelSavePayload(state, id, baseName && ids.length > 1 ? `${baseName} · ${id}` : baseName));
    const result = await window.aiFree.ai.saveCustomApis({ models });
    if (!result?.ok) throw new Error(result?.error || '保存模型失败');
    state.models = result.models || state.models;
    renderHomeModels(state);
    homeDialogs.close(state.dialog);
  } catch (error) {
    modelMessage(state.dialogStatus, error.message || String(error), true);
  } finally {
    submit.disabled = false;
  }
}

function openHomeModelSettings(state) {
  if (modelElement('browser-empty-state').hidden) {
    state.pendingOpen = true;
    return;
  }
  modelElement('home-model-settings-tab').click();
  selectModelSettingsSection(state, 'models');
  state.openDialog();
}

function bindModelSettingsSections(state) {
  const tabs = [...document.querySelectorAll('[data-model-settings-section]')];
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => selectModelSettingsSection(state, button.dataset.modelSettingsSection));
    button.addEventListener('keydown', (event) => {
      const count = tabs.length;
      const next = { ArrowLeft: (index + count - 1) % count, ArrowRight: (index + 1) % count, Home: 0, End: count - 1 }[event.key];
      if (!Number.isInteger(next)) return;
      event.preventDefault();
      tabs[next].click();
      tabs[next].focus();
    });
  });
}

function selectModelSettingsSection(state, section) {
  const selected = ['server', 'mcp'].includes(section) ? section : 'models';
  document.querySelectorAll('[data-model-settings-section]').forEach((button) => {
    const active = button.dataset.modelSettingsSection === selected;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-model-settings-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.modelSettingsPanel !== selected;
  });
  state.section = selected;
  state.syncIntegrations(selected);
}

function bindHomeModels() {
  const state = {
    list: modelElement('home-model-list'),
    dialog: modelElement('home-custom-model-dialog'),
    form: modelElement('home-custom-model-form'),
    status: modelElement('home-model-status'),
    dialogStatus: modelElement('home-model-dialog-status'),
    discovered: modelElement('home-model-discovered'),
    discoveredList: modelElement('home-model-discovered-list'),
    models: [],
    editingId: '',
    pendingOpen: false,
    section: 'models',
    syncIntegrations: bindHomeModelIntegrations(),
  };
  state.openDialog = (model) => openHomeModelDialog(state, model);
  modelElement('home-model-add').addEventListener('click', () => state.openDialog());
  modelElement('home-model-discover').addEventListener('click', (event) => void discoverHomeModels(state, event.currentTarget));
  state.form.addEventListener('submit', (event) => void saveHomeModels(state, event));
  for (const id of Object.values(modelTokenFields)) {
    modelElement(`${id}-preset`).addEventListener('change', () => syncModelTokenInput(id));
  }
  document.querySelectorAll('[data-model-dialog-close]').forEach((button) => {
    button.addEventListener('click', () => homeDialogs.close(state.dialog));
  });
  bindModelSettingsSections(state);
  selectModelSettingsSection(state, 'models');
  void loadHomeModels(state);
  return {
    sync() {
      const visible = !modelElement('browser-empty-state').hidden && !modelElement('home-model-settings').hidden;
      if (visible !== state.visible) {
        state.visible = visible;
        state.syncIntegrations(visible ? state.section : null);
      }
      if (!state.pendingOpen || modelElement('browser-empty-state').hidden) return;
      state.pendingOpen = false;
      openHomeModelSettings(state);
    },
    open: () => openHomeModelSettings(state),
  };
}

