(() => {
  const vm = window.AutomationWorkbenchViewModel;
  if (!vm) return;

  const state = {
    cards: [], runs: [], selectedId: '', selectedRunId: '', selectedCard: null,
    options: {}, bound: false, timer: 0,
  };

  function element(id) { return document.getElementById(id); }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function setText(id, value) { const node = element(id); if (node) node.textContent = String(value ?? ''); }
  function fieldValue(id, fallback = '') { return element(id)?.value ?? fallback; }
  function setField(id, value) { const node = element(id); if (node) node.value = String(value ?? ''); }
  function randomId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}:${id}`;
  }

  async function invoke(action, input = {}) {
    const api = window.aiFree?.ai?.manageAutomationCard;
    if (!api) throw new Error('自动化接口不可用');
    const result = await api({ action, ...input });
    if (!result?.ok) throw new Error(result?.error?.message || result?.message || '自动化操作失败');
    return result.data;
  }

  function announce(message) { state.options.setStatus?.(message); }
  function formatTime(value) {
    const timestamp = Number(value || 0);
    if (!timestamp) return '暂无';
    return new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toLocaleString('zh-CN');
  }

  function cardAction(action, cardId, label, tone = '') {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label;
    button.dataset.automationCardAction = action; button.dataset.cardId = cardId;
    if (tone) button.classList.add(`is-${tone}`);
    return button;
  }

  function cardNode(source) {
    const card = vm.normalizeCard(source);
    const summary = vm.cardRunSummary(state.runs, card.id);
    const article = document.createElement('article');
    article.className = 'automation-card-summary';
    article.dataset.cardId = card.id;
    article.setAttribute('aria-current', String(card.id === state.selectedId));
    const heading = document.createElement('div'); heading.className = 'automation-card-summary-heading';
    const title = document.createElement('strong'); title.textContent = card.name;
    const badge = document.createElement('span');
    badge.className = `automation-status-badge is-${vm.statusTone(card.status)}`;
    badge.textContent = vm.statusLabel(card.status);
    heading.append(title, badge);
    const description = document.createElement('p');
    description.textContent = card.description || '暂无说明';
    const tags = document.createElement('div'); tags.className = 'automation-card-tags';
    [...card.tags, card.riskLevel, card.accessScope].filter(Boolean).forEach((value) => {
      const tag = document.createElement('span'); tag.textContent = value; tags.append(tag);
    });
    const stats = document.createElement('small');
    stats.textContent = `${card.stepCount} 步 · 成功率 ${summary.successRate} · 最近运行 ${formatTime(summary.latestAt)}`;
    const actions = document.createElement('div'); actions.className = 'automation-card-summary-actions';
    const runAction = cardAction('run', card.id, '运行', 'primary');
    runAction.disabled = ['deprecated', 'disabled', 'draft'].includes(card.status);
    actions.append(
      cardAction('edit', card.id, '编辑'), runAction,
      cardAction('toggle', card.id, ['deprecated', 'disabled'].includes(card.status) ? '启用' : '停用'),
      cardAction('clone', card.id, '复制'), cardAction('delete', card.id, '删除', 'danger'),
    );
    article.append(heading, description, tags, stats, actions);
    return article;
  }

  function visibleCards() {
    return vm.filterCards(state.cards, fieldValue('automation-card-search'), fieldValue('automation-card-status-filter'));
  }

  function renderCards(cards = state.cards, selectedId = state.selectedId, onSelect = state.options.selectCard) {
    state.cards = Array.isArray(cards) ? cards : [];
    state.selectedId = text(selectedId);
    if (onSelect) state.options.selectCard = onSelect;
    const list = element('automation-card-list');
    if (!list) return false;
    const filtered = visibleCards();
    list.classList.add('is-workflow-list');
    list.replaceChildren(...filtered.map(cardNode));
    if (!filtered.length) {
      const empty = document.createElement('p'); empty.className = 'automation-empty';
      empty.textContent = state.cards.length ? '暂无匹配卡片。' : '暂无卡片，点击“新建”开始。';
      list.append(empty);
    }
    setText('automation-card-count', `${filtered.length} / ${state.cards.length}`);
    return true;
  }

  function metadataFromFields() {
    return {
      status: fieldValue('automation-card-status', 'active'),
      riskLevel: fieldValue('automation-card-risk-level', 'read_only'),
      tags: fieldValue('automation-card-tags'),
      accessScope: fieldValue('automation-card-access-scope', 'owner'),
      inputSchema: fieldValue('automation-card-input-schema', '{}'),
      timeoutSeconds: fieldValue('automation-card-timeout-seconds', '900'),
      maxTransitions: fieldValue('automation-card-max-transitions', '120'),
    };
  }

  function applyMetadata(source) {
    const metadata = vm.editorMetadata(source || {});
    setField('automation-card-status', metadata.status);
    setField('automation-card-risk-level', metadata.riskLevel);
    setField('automation-card-tags', metadata.tags);
    setField('automation-card-access-scope', metadata.accessScope);
    setField('automation-card-input-schema', metadata.inputSchema);
    setField('automation-card-timeout-seconds', metadata.timeoutSeconds);
    setField('automation-card-max-transitions', metadata.maxTransitions);
  }

  function enrichCardDraft(card) {
    return vm.applyEditorMetadata(card, metadataFromFields());
  }

  function cardMetadataPayload() {
    const metadata = metadataFromFields();
    const inputSchema = JSON.parse(metadata.inputSchema || '{}');
    return {
      status: metadata.status, risk_level: metadata.riskLevel,
      tags: text(metadata.tags).split(',').map((tag) => tag.trim()).filter(Boolean),
      access_scope: metadata.accessScope, inputSchema,
      limits: {
        timeoutSeconds: Math.max(1, Number(metadata.timeoutSeconds) || 900),
        maxTransitions: Math.max(1, Number(metadata.maxTransitions) || 120),
      },
    };
  }

  async function refreshVersions(cardId = state.selectedId) {
    const target = element('automation-version-list');
    if (!target || !cardId) return;
    const result = await invoke('versions', { id: cardId });
    const versions = Array.isArray(result?.items) ? result.items : [];
    target.replaceChildren(...versions.map((version) => {
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.versionId = text(version.id);
      button.textContent = `v${version.version_number || version.versionNumber || '?'}`;
      button.title = formatTime(version.published_at || version.created_at || version.createdAt);
      return button;
    }));
    const runVersion = element('automation-run-version');
    if (runVersion?.tagName === 'SELECT') {
      const current = runVersion.value;
      const latest = document.createElement('option'); latest.value = ''; latest.textContent = '最新版本';
      const options = versions.map((version) => {
        const option = document.createElement('option'); option.value = text(version.id);
        option.textContent = `v${version.version_number || version.versionNumber || '?'}`; return option;
      });
      runVersion.replaceChildren(latest, ...options);
      if (options.some((option) => option.value === current)) runVersion.value = current;
    }
  }

  async function showVersion(versionId) {
    if (!versionId || !state.selectedId) return;
    const result = await invoke('get_version', { id: state.selectedId, version_id: versionId });
    const version = result?.version || result;
    const output = element('automation-version-preview');
    if (output) output.textContent = JSON.stringify(version?.definition || version?.cardData || version, null, 2);
  }

  function sampleInput(card) {
    const schema = fieldValue('automation-card-input-schema', vm.editorMetadata(card).inputSchema);
    let properties = {};
    try { properties = JSON.parse(schema)?.properties || {}; } catch (_) {}
    return Object.fromEntries(Object.entries(properties).map(([key, rawConfig]) => {
      const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
      if (config.default !== undefined) return [key, config.default];
      if (config.type === 'boolean') return [key, false];
      if (['number', 'integer'].includes(config.type)) return [key, 0];
      return [key, ''];
    }));
  }

  function openDialog(id) {
    const dialog = element(id);
    if (!dialog) return false;
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else dialog.setAttribute('open', '');
    return true;
  }

  function closeDialog(id) {
    const dialog = element(id);
    if (!dialog) return;
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function openRun(source) {
    const card = vm.normalizeCard(source || state.cards.find((item) => vm.normalizeCard(item).id === state.selectedId));
    state.selectedCard = card;
    setText('automation-run-card-name', card.name);
    setField('automation-run-input', JSON.stringify(sampleInput(card.raw), null, 2));
    syncRunTargets();
    return openDialog('automation-run-dialog');
  }

  function syncRunTargets() {
    const source = element('automation-browser-select');
    const target = element('automation-run-target');
    if (!source || target?.tagName !== 'SELECT') return;
    const selected = source.value;
    const options = Array.from(source.options).map((item) => {
      const option = document.createElement('option');
      option.value = item.value; option.textContent = item.textContent; option.disabled = item.disabled;
      return option;
    });
    target.replaceChildren(...options);
    if (options.some((option) => option.value === selected)) target.value = selected;
  }

  async function startRun() {
    if (!state.selectedCard) return;
    try {
      const saved = await state.options.saveCard?.(false);
      const cardId = text(saved?.id, state.selectedCard.id);
      const input = JSON.parse(fieldValue('automation-run-input', '{}'));
      const result = await invoke('start_run', {
        id: cardId, inputs: input, connectionId: fieldValue('automation-run-target'),
        version_id: fieldValue('automation-run-version'), idempotency_key: randomId('desktop'),
      });
      closeDialog('automation-run-dialog');
      switchTab('runs');
      await refreshRuns();
      await selectRun(result?.run?.id || result?.run?.run_id || result?.id || result?.run_id);
    } catch (error) { announce(error.message); }
  }

  function runNode(source) {
    const run = vm.normalizeRun(source);
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'automation-run-item'; button.dataset.runId = run.id;
    const card = state.cards.map(vm.normalizeCard).find((item) => item.id === run.cardId);
    const title = document.createElement('strong'); title.textContent = card?.name || run.cardId || run.id;
    const badge = document.createElement('span');
    badge.className = `automation-status-badge is-${vm.statusTone(run.status)}`;
    badge.textContent = vm.statusLabel(run.status);
    const detail = document.createElement('small');
    detail.textContent = `${run.currentStepId || '尚未开始'} · ${formatTime(run.createdAt)}`;
    button.append(title, badge, detail); return button;
  }

  function renderRuns() {
    const list = element('automation-run-list');
    if (!list) return;
    list.replaceChildren(...state.runs.map(runNode));
    if (!state.runs.length) {
      const empty = document.createElement('p'); empty.className = 'automation-empty';
      empty.textContent = '暂无运行记录。'; list.append(empty);
    }
  }

  async function refreshRuns() {
    try {
      const result = await invoke('list_runs', { limit: 200 });
      state.runs = (Array.isArray(result?.items) ? result.items : []).map(vm.normalizeRun);
      renderRuns(); renderCards();
      if (state.selectedRunId) await selectRun(state.selectedRunId);
    } catch (error) { announce(error.message); }
  }

  function renderRunDetail(run, steps) {
    setText('automation-run-detail-id', run.id);
    setText('automation-run-detail-status', vm.statusLabel(run.status));
    setText('automation-run-detail-time', `${formatTime(run.startedAt)} · ${Math.round(vm.runDuration(run))} 秒`);
    setText('automation-run-detail-output', run.output ? JSON.stringify(run.output, null, 2) : '暂无输出');
    setText('automation-run-detail-error', run.error ? JSON.stringify(run.error, null, 2) : '');
    const list = element('automation-run-step-list');
    if (list) list.replaceChildren(...steps.map((step) => {
      const row = document.createElement('article'); row.className = 'automation-run-step';
      const title = document.createElement('strong');
      title.textContent = `${step.step_id || step.stepId || step.name || `步骤 ${step.stepIndex || ''}`} · #${step.attempt || 1}`;
      const status = document.createElement('span');
      status.textContent = vm.statusLabel(step.status || (step.success === false ? 'failed' : 'succeeded'));
      const detail = document.createElement('pre');
      detail.textContent = JSON.stringify(step.error || step.result || {}, null, 2);
      row.append(title, status, detail); return row;
    }));
    const cancel = element('automation-run-cancel');
    const retry = element('automation-run-retry');
    if (cancel) cancel.hidden = !vm.ACTIVE_RUN_STATUSES.has(run.status);
    if (retry) retry.hidden = !['failed', 'cancelled', 'timed_out'].includes(run.status);
  }

  async function selectRun(runId) {
    if (!runId) return;
    state.selectedRunId = runId;
    try {
      const [runResult, stepResult] = await Promise.all([
        invoke('get_run', { run_id: runId }), invoke('list_run_steps', { run_id: runId }),
      ]);
      renderRunDetail(vm.normalizeRun(runResult?.run || runResult), Array.isArray(stepResult?.items) ? stepResult.items : []);
    } catch (error) { announce(error.message); }
  }

  async function cardOperation(action, cardId) {
    const card = state.cards.find((item) => vm.normalizeCard(item).id === cardId);
    if (action === 'edit') return state.options.selectCard?.(cardId);
    if (action === 'run') {
      await state.options.selectCard?.(cardId);
      return openRun(card);
    }
    if (action === 'delete' && !window.confirm('确认删除当前自动化卡片？')) return;
    const status = vm.normalizeCard(card).status;
    const payload = action === 'toggle' ? { id: cardId, enabled: ['deprecated', 'disabled'].includes(status) } : { id: cardId };
    const apiAction = action === 'toggle' ? 'set_enabled' : action;
    const result = await invoke(apiAction, payload);
    if (action === 'export') downloadExport(result?.card || result, vm.normalizeCard(card).name);
    announce(action === 'validate' ? '卡片校验通过。' : '操作已完成。');
    await state.options.refresh?.();
  }

  function downloadExport(payload, name) {
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
    link.download = `${name || 'automation-card'}.json`; link.click(); URL.revokeObjectURL(link.href);
  }

  function switchTab(tab) {
    const cards = tab !== 'runs';
    element('automation-cards-panel')?.toggleAttribute('hidden', !cards);
    element('automation-runs-panel')?.toggleAttribute('hidden', cards);
    element('automation-tab-cards')?.setAttribute('aria-selected', String(cards));
    element('automation-tab-runs')?.setAttribute('aria-selected', String(!cards));
    if (!cards) void refreshRuns();
  }

  function bindEvents() {
    element('automation-card-list')?.addEventListener('click', (event) => {
      const action = event.target.closest('[data-automation-card-action]');
      if (action) void cardOperation(action.dataset.automationCardAction, action.dataset.cardId).catch((error) => announce(error.message));
      else {
        const card = event.target.closest('[data-card-id]'); if (card) void state.options.selectCard?.(card.dataset.cardId);
      }
    });
    ['automation-card-search', 'automation-card-status-filter'].forEach((id) => element(id)?.addEventListener('input', () => renderCards()));
    element('automation-tab-cards')?.addEventListener('click', () => switchTab('cards'));
    element('automation-tab-runs')?.addEventListener('click', () => switchTab('runs'));
    element('automation-run-list')?.addEventListener('click', (event) => void selectRun(event.target.closest('[data-run-id]')?.dataset.runId));
    element('automation-version-list')?.addEventListener('click', (event) => void showVersion(event.target.closest('[data-version-id]')?.dataset.versionId));
    element('automation-validate')?.addEventListener('click', () => void cardOperation('validate', state.selectedId));
    element('automation-clone')?.addEventListener('click', () => void cardOperation('clone', state.selectedId));
    element('automation-export-modern')?.addEventListener('click', () => void cardOperation('export', state.selectedId));
    element('automation-run-start')?.addEventListener('click', () => void startRun());
    element('automation-run-close')?.addEventListener('click', () => closeDialog('automation-run-dialog'));
    element('automation-run-cancel')?.addEventListener('click', async () => { await invoke('cancel_run', { run_id: state.selectedRunId }); await refreshRuns(); });
    element('automation-run-retry')?.addEventListener('click', async () => { await invoke('retry_run', { run_id: state.selectedRunId, idempotency_key: randomId('desktop-retry') }); await refreshRuns(); });
  }

  function bind(options = {}) {
    state.options = { ...state.options, ...options };
    if (state.bound) return;
    state.bound = true; bindEvents();
    void refreshRuns();
    state.timer = window.setInterval(() => {
      if (state.runs.some((run) => vm.ACTIVE_RUN_STATUSES.has(run.status))) void refreshRuns();
    }, 2500);
    window.addEventListener('beforeunload', () => window.clearInterval(state.timer), { once: true });
  }

  window.AppShellAutomationWorkbenchUpgrade = Object.freeze({
    applyMetadata, bind, cardMetadataPayload, enrichCardDraft, openRun, refreshRuns, refreshVersions, renderCards,
  });
})();
