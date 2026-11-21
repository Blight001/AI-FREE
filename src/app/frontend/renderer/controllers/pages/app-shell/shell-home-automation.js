'use strict';

const AUTOMATION_ACTIVE_RUNS = new Set(['pending', 'running', 'paused']);
const AUTOMATION_RUN_LABELS = Object.freeze({
  pending: '等待执行', running: '执行中', paused: '已暂停', succeeded: '已完成', failed: '失败',
  cancelled: '已停止', timed_out: '超时',
});
const AUTOMATION_SENSITIVE_KEY = /password|passwd|token|cookie|secret|authorization|api.?key|验证码/i;

function automationRedact(value, key = '') {
  if (AUTOMATION_SENSITIVE_KEY.test(key)) return '[已脱敏]';
  if (Array.isArray(value)) return value.map((item) => automationRedact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, automationRedact(item, name)]));
  }
  if (typeof value === 'string') return value.replace(/(Bearer\s+)[^\s]+/gi, '$1[已脱敏]');
  return value;
}

function automationNodeTemplate(type, index) {
  const templates = {
    mcp: { type, tool: 'browser_observe', arguments: { keyword: '' } },
    condition: { type, condition_mode: 'selector_exists', text: '' },
    navigate: { type, url: '' }, click: { type, selector: '' },
    type: { type, selector: '', text: '' }, wait: { type, selector: '', timeout: 10000 }, delay: { type, delayMs: 1000 },
  };
  return { id: `step_${Date.now()}_${index}`, name: `${type} ${index + 1}`, ...templates[type] };
}

function createAutomationDownload(name, payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${String(name || 'automation').replace(/[\\/:*?"<>|]/g, '_')}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

class HomeAutomationController {
  constructor(panel) {
    this.api = window.aiFree.ai;
    this.panel = panel;
    this.nodes = Object.fromEntries([
      'automation-browser-select', 'automation-status', 'automation-card-list', 'automation-list-count',
      'automation-run-list', 'automation-history-toggle', 'automation-import', 'automation-import-file',
      'automation-trash-toggle',
      'automation-create', 'automation-editor', 'automation-editor-title', 'automation-editor-name',
      'automation-editor-close', 'automation-editor-export', 'automation-editor-save', 'automation-editor-message',
      'automation-canvas', 'automation-node-json', 'automation-node-apply', 'automation-node-delete',
      'automation-connect-mode', 'automation-edge-label', 'automation-canvas-hint', 'automation-start-node',
    ].map((id) => [id, document.getElementById(id)]));
    this.cards = [];
    this.card = null;
    this.cardId = '';
    this.showHistory = false;
    this.showTrash = false;
    this.busy = false;
    this.canvas = window.createAutomationCanvas(this.nodes['automation-canvas'], {
      getEdgeLabel: () => this.nodes['automation-edge-label'].value,
      onSelect: (node) => this.selectNode(node),
      onHint: (text) => { this.nodes['automation-canvas-hint'].textContent = text; },
    });
    this.bindEvents();
  }

  message(text, isError = false) {
    this.nodes['automation-status'].textContent = text;
    this.nodes['automation-status'].dataset.error = String(isError);
  }

  async manage(args) {
    const response = await this.api.manageAutomationCard(args);
    if (!response?.ok) throw new Error(response?.message || '自动化操作失败');
    return response.data;
  }

  selectedConnection() { return this.nodes['automation-browser-select'].value; }

  async loadConnections() {
    const response = await this.api.getBrowserConnections();
    if (!response?.ok) throw new Error(response?.message || '浏览器列表读取失败');
    this.renderConnections(response.connections || []);
  }

  renderConnections(connections) {
    const select = this.nodes['automation-browser-select'];
    const previous = select.value;
    const options = connections.map((item) => ({ id: item.id, name: item.name || item.profileId || item.id }));
    select.replaceChildren(new Option('选择浏览器…', ''), ...options.map((item) => new Option(item.name, item.id)));
    select.value = options.some((item) => item.id === previous) ? previous : (options[0]?.id || '');
  }

  async loadCards() {
    const response = await this.manage({ action: 'list', include_deleted: this.showTrash });
    this.cards = Array.isArray(response.items) ? response.items : [];
    this.renderCards();
  }

  cardActionButton(label, action, id, className = '') {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.dataset.action = action;
    control.dataset.id = id;
    if (className) control.className = className;
    return control;
  }

  renderCards() {
    const list = this.nodes['automation-card-list'];
    this.nodes['automation-list-count'].textContent = `${this.cards.length} 个流程`;
    list.replaceChildren();
    if (!this.cards.length) list.append(this.emptyMessage('还没有自动化流程'));
    this.cards.forEach((card) => list.append(this.renderCard(card)));
  }

  emptyMessage(text) {
    const empty = document.createElement('p');
    empty.className = 'automation-empty';
    empty.textContent = text;
    return empty;
  }

  renderCard(card) {
    const row = document.createElement('article');
    row.className = 'automation-card-row';
    const summary = document.createElement('div');
    summary.className = 'automation-card-summary';
    const title = document.createElement('strong');
    const description = document.createElement('small');
    title.textContent = card.name;
    description.textContent = `${card.website || 'MCP 流程'} · ${card.stepCount} 个节点 · ${card.versionCount || 1} 个版本`;
    summary.append(title, description);
    row.append(summary);
    if (this.showTrash) {
      row.append(this.cardActionButton('恢复', 'restore', card.id), this.cardActionButton('永久删除', 'purge', card.id));
    } else {
      row.append(this.cardActionButton('运行', 'run', card.id, 'automation-primary-action'),
        this.cardActionButton('编辑', 'edit', card.id), this.cardActionButton('版本', 'versions', card.id),
        this.cardActionButton('导出', 'export', card.id), this.cardActionButton('删除', 'delete', card.id));
    }
    return row;
  }

  async loadRuns() {
    const result = await this.manage({ action: 'list_runs', limit: 100 });
    const all = Array.isArray(result.items) ? result.items : [];
    const items = all.filter((run) => this.showHistory || AUTOMATION_ACTIVE_RUNS.has(run.status));
    const list = this.nodes['automation-run-list'];
    list.replaceChildren();
    if (!items.length) list.append(this.emptyMessage(this.showHistory ? '暂无运行记录' : '当前没有运行中的自动化'));
    items.forEach((run) => list.append(this.renderRun(run)));
  }

  renderRun(run) {
    const row = document.createElement('article');
    row.className = `automation-run-row status-${run.status}`;
    const details = document.createElement('details');
    const label = document.createElement('summary');
    label.textContent = '查看后台运行';
    details.append(label, this.renderRunLogs(run.steps || []), this.renderRunOutput(run));
    row.append(this.renderRunHeader(run), this.renderRunSummary(run), details);
    if (run.status === 'running' || run.status === 'pending') row.append(
      this.cardActionButton('暂停', 'pause-run', run.id), this.cardActionButton('停止', 'cancel-run', run.id));
    if (run.status === 'paused') row.append(
      this.cardActionButton('继续', 'resume-run', run.id), this.cardActionButton('单步', 'step-run', run.id),
      this.cardActionButton('停止', 'cancel-run', run.id));
    if (run.status === 'failed' || run.status === 'timed_out') row.append(this.cardActionButton('重试', 'retry-run', run.id));
    return row;
  }

  renderRunHeader(run) {
    const header = document.createElement('header');
    const title = document.createElement('strong');
    const status = document.createElement('span');
    title.textContent = this.cards.find((card) => card.id === run.cardId)?.name || run.cardId;
    status.textContent = AUTOMATION_RUN_LABELS[run.status] || run.status;
    header.append(title, status);
    return header;
  }

  renderRunSummary(run) {
    const detail = document.createElement('p');
    const latest = run.steps?.at(-1);
    const error = run.error?.message ? ` · ${automationRedact(run.error.message)}` : '';
    detail.textContent = `${latest?.name || run.currentStepId || '等待节点'} · ${run.transitionCount || 0} 次转换${error}`;
    return detail;
  }

  renderRunLogs(steps) {
    const log = document.createElement('ol');
    steps.slice(-8).forEach((step) => {
      const item = document.createElement('li');
      const safe = automationRedact(step);
      item.textContent = `${safe.name || safe.stepId || safe.type}: ${safe.phase || (safe.success ? '完成' : '')}${safe.error ? ` · ${safe.error}` : ''}`;
      log.append(item);
    });
    return log;
  }

  renderRunOutput(run) {
    const output = document.createElement('details');
    const label = document.createElement('summary');
    const value = document.createElement('pre');
    label.textContent = '安全输出';
    value.textContent = JSON.stringify(automationRedact(run.output), null, 2) || '暂无输出';
    output.append(label, value);
    return output;
  }

  async refresh() {
    if (this.busy || this.panel.hidden || document.hidden) return;
    try { await this.loadCards(); await this.loadRuns(); }
    catch (error) { this.message(error.message, true); }
  }

  newCard() {
    return {
      name: '新建自动化', website: '', description: '', steps: [automationNodeTemplate('delay', 0)],
      flow: { start: '', edges: [], layout: {} }, limits: { timeoutSeconds: 900, maxTransitions: 120 },
      executionPolicy: { allowedByDefault: true },
    };
  }

  syncStartNodes() {
    const steps = this.card?.steps || [];
    const select = this.nodes['automation-start-node'];
    select.replaceChildren(...steps.map((node, index) => new Option(node.name || node.id || `step ${index + 1}`, node.id || `step_${index + 1}`)));
    select.value = this.card.flow.start || steps[0]?.id || '';
  }

  selectNode(node) {
    const editor = this.nodes['automation-node-json'];
    editor.value = node ? JSON.stringify(node, null, 2) : '';
    editor.disabled = !node;
    this.nodes['automation-node-delete'].disabled = !node;
    this.syncStartNodes();
  }

  openEditor(card, id = '') {
    const editor = this.nodes['automation-editor'];
    if (editor.open) return;
    this.cardId = id;
    this.card = JSON.parse(JSON.stringify(card));
    this.card.flow ||= { start: '', edges: [], layout: {} };
    this.card.flow.start ||= this.card.steps[0]?.id || '';
    this.nodes['automation-editor-name'].value = this.card.name || '';
    this.nodes['automation-editor-title'].textContent = id ? '编辑自动化' : '新建自动化';
    this.nodes['automation-editor-message'].textContent = '';
    this.canvas.setCard(this.card);
    this.syncStartNodes();
    homeDialogs.open(editor);
  }

  async editCard(id) {
    const result = await this.manage({ action: 'get', id });
    this.openEditor(result.item.cardData || result.item, result.item.id);
  }

  addNode(type) {
    const node = automationNodeTemplate(type, this.card.steps.length);
    this.card.steps.push(node);
    if (!this.card.flow.start) this.card.flow.start = node.id;
    this.canvas.setCard(this.card);
    this.syncStartNodes();
    this.canvas.selectNode(node.id);
  }

  async saveEditor() {
    const card = this.card;
    const name = this.nodes['automation-editor-name'].value.trim();
    if (!name) throw new Error('请输入流程名称');
    card.name = name;
    card.flow.start = this.nodes['automation-start-node'].value;
    const result = await this.manage({ action: 'write', id: this.cardId || undefined, cardData: card });
    if (!result.success) throw new Error(result.error || '保存流程失败');
    if (this.card === card) homeDialogs.close(this.nodes['automation-editor']);
    this.message('流程已保存');
    await this.refresh();
  }

  async runCard(id) {
    const connectionId = this.selectedConnection();
    if (!connectionId) throw new Error('先选择一个已连接的浏览器');
    const result = await this.manage({ action: 'start_run', id, connectionId });
    if (!result.run) throw new Error('自动化未能启动');
    this.message('自动化已在后台启动');
    await this.loadRuns();
  }

  async exportCard(id) {
    const result = await this.manage({ action: 'get', id });
    createAutomationDownload(result.item.cardName, result.item.cardData);
  }

  async showVersions(id) {
    const result = await this.manage({ action: 'versions', id });
    const versions = result.items || [];
    this.message(`${versions.length} 个版本：${versions.map((item) => `v${item.versionNumber}`).join('、') || '暂无'}`);
  }

  async handleCardAction(action, id) {
    const handlers = {
      run: () => this.runCard(id), edit: () => this.editCard(id), export: () => this.exportCard(id),
      versions: () => this.showVersions(id), delete: () => this.deleteCard(id),
      restore: async () => { await this.manage({ action: 'restore', id }); await this.refresh(); },
      purge: async () => {
        if (await homeDialogs.confirm('永久删除此自动化流程？该操作不可撤销。')) { await this.manage({ action: 'purge', id }); await this.refresh(); }
      },
    };
    return handlers[action]?.();
  }

  async deleteCard(id) {
    if (!await homeDialogs.confirm('删除此自动化流程？此操作会从列表移除。')) return;
    await this.manage({ action: 'delete', id });
    await this.refresh();
  }

  async importFile(file) {
    const parsed = JSON.parse(await file.text());
    const card = parsed.cardData || parsed;
    if (!Array.isArray(card.steps) || !card.steps.length) throw new Error('JSON 中没有有效的 steps 节点');
    delete card.id;
    this.openEditor(card);
  }

  async handleRunAction(action, id) {
    if (action === 'cancel-run') await this.manage({ action: 'cancel_run', run_id: id, reason: '用户停止' });
    if (action === 'retry-run') await this.manage({ action: 'retry_run', run_id: id });
    if (action === 'pause-run') await this.manage({ action: 'pause_run', run_id: id });
    if (action === 'resume-run') await this.manage({ action: 'resume_run', run_id: id });
    if (action === 'step-run') await this.manage({ action: 'step_run', run_id: id });
    await this.loadRuns();
  }

  applyNode() {
    try {
      const node = JSON.parse(this.nodes['automation-node-json'].value);
      const index = this.card.steps.findIndex((item, stepIndex) => (item.id || `step_${stepIndex + 1}`) === this.canvas.getSelectedId());
      if (index < 0) throw new Error('请先选择画布节点');
      if (node.id !== this.card.steps[index].id) throw new Error('节点 ID 不可在属性编辑器中更改');
      this.card.steps[index] = node;
      this.canvas.render();
      this.syncStartNodes();
      this.nodes['automation-editor-message'].textContent = '节点配置已应用';
    } catch (error) { this.nodes['automation-editor-message'].textContent = error.message; }
  }

  async onCardListClick(event) {
    const control = event.target.closest('[data-action]');
    if (!control || this.busy) return;
    this.busy = true;
    try { await this.handleCardAction(control.dataset.action, control.dataset.id); }
    catch (error) { this.message(error.message, true); }
    finally { this.busy = false; }
  }

  bindCardActions() {
    this.nodes['automation-card-list'].addEventListener('click', (event) => this.onCardListClick(event));
    this.nodes['automation-run-list'].addEventListener('click', (event) => {
      const control = event.target.closest('[data-action]');
      if (control) void this.handleRunAction(control.dataset.action, control.dataset.id).catch((error) => this.message(error.message, true));
    });
  }

  bindEditorActions() {
    this.nodes['automation-editor-close'].addEventListener('click', () => homeDialogs.close(this.nodes['automation-editor']));
    this.nodes['automation-editor-save'].addEventListener('click', () => void this.saveEditor().catch((error) => { this.nodes['automation-editor-message'].textContent = error.message; }));
    this.nodes['automation-editor-export'].addEventListener('click', () => createAutomationDownload(this.card.name, this.card));
    this.nodes['automation-node-apply'].addEventListener('click', () => this.applyNode());
    this.nodes['automation-node-delete'].addEventListener('click', () => this.canvas.removeSelected());
    this.nodes['automation-connect-mode'].addEventListener('click', (event) => this.toggleConnectMode(event));
    this.nodes['automation-start-node'].addEventListener('change', () => { this.card.flow.start = this.nodes['automation-start-node'].value; });
    this.nodes['automation-editor'].querySelectorAll('[data-add-node]').forEach((control) => control.addEventListener('click', () => this.addNode(control.dataset.addNode)));
  }

  toggleConnectMode(event) {
    const active = event.currentTarget.getAttribute('aria-pressed') !== 'true';
    event.currentTarget.setAttribute('aria-pressed', String(active));
    this.canvas.setConnectMode(active);
  }

  bindPageActions() {
    this.nodes['automation-create'].addEventListener('click', () => this.openEditor(this.newCard()));
    this.nodes['automation-import'].addEventListener('click', () => this.nodes['automation-import-file'].click());
    this.nodes['automation-import-file'].addEventListener('change', () => this.onImportChange());
    this.nodes['automation-history-toggle'].addEventListener('click', (event) => this.toggleHistory(event));
    this.nodes['automation-trash-toggle'].addEventListener('click', (event) => {
      this.showTrash = !this.showTrash;
      event.currentTarget.setAttribute('aria-pressed', String(this.showTrash));
      event.currentTarget.textContent = this.showTrash ? '返回流程' : '回收站';
      void this.refresh();
    });
  }

  onImportChange() {
    const input = this.nodes['automation-import-file'];
    const file = input.files?.[0];
    if (file) void this.importFile(file).catch((error) => this.message(error.message, true));
    input.value = '';
  }

  toggleHistory(event) {
    this.showHistory = !this.showHistory;
    event.currentTarget.setAttribute('aria-pressed', String(this.showHistory));
    void this.loadRuns().catch((error) => this.message(error.message, true));
  }

  bindEvents() {
    this.bindCardActions();
    this.bindEditorActions();
    this.bindPageActions();
  }

  start() {
    void Promise.all([this.loadConnections(), this.refresh()]).catch((error) => this.message(error.message, true));
    const interval = setInterval(() => { if (!this.panel.hidden && !document.hidden) void this.refresh(); }, 1800);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !this.panel.hidden) void this.refresh(); });
    return () => clearInterval(interval);
  }
}

function bindHomeAutomation() {
  const panel = document.getElementById('home-automation');
  if (!window.aiFree?.ai || !panel) return () => {};
  const controller = new HomeAutomationController(panel);
  return controller.start();
}

window.AppShellAutomation = Object.freeze({ bind: bindHomeAutomation });
