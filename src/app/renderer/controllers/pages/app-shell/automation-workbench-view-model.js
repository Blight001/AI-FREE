'use strict';

function createAutomationNormalizationTools() {
  function text(value, fallback = '') {
    const normalized = String(value == null ? '' : value).trim();
    return normalized || fallback;
  }
  function list(value) { return Array.isArray(value) ? value : []; }
  function number(value, fallback = 0) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : fallback;
  }
  function timestamp(value) {
    const normalized = number(value);
    if (normalized <= 0) return 0;
    return normalized < 1e12 ? normalized * 1000 : normalized;
  }
  function cardData(card = {}) {
    return card.cardData && typeof card.cardData === 'object' ? card.cardData : card;
  }
  function normalizeCard(card = {}) {
    const data = cardData(card);
    const definition = data.definition && typeof data.definition === 'object' ? data.definition : {};
    const definedSteps = definition.steps;
    const steps = (Array.isArray(definedSteps) || (definedSteps && typeof definedSteps === 'object'))
      ? definedSteps : data.steps;
    return {
      ...card, id: text(card.id, text(data.id)),
      name: text(card.name, text(card.cardName, text(data.name, '未命名卡片'))),
      description: text(card.description, text(data.description)),
      status: text(card.status, text(data.status, data.enabled === false ? 'disabled' : 'active')),
      riskLevel: text(card.risk_level, text(data.riskLevel, text(data.risk_level, 'read_only'))),
      tags: list(card.tags).length ? list(card.tags) : list(data.tags),
      accessScope: text(card.access_scope, text(data.accessScope, text(data.access_scope, 'owner'))),
      stepCount: number(card.stepCount, Array.isArray(steps) ? steps.length : Object.keys(steps || {}).length),
      updatedAt: timestamp(card.updated_at || card.updatedAt || data.updatedAt),
      latestVersionId: text(card.latest_version_id, text(data.latestVersionId)), raw: data,
    };
  }
  function normalizeRun(run = {}) {
    return {
      ...run, id: text(run.id, text(run.run_id)), cardId: text(run.card_id, text(run.cardId)),
      status: text(run.status, 'pending').toLowerCase(),
      currentStepId: text(run.current_step_id, text(run.currentStepId)),
      createdAt: timestamp(run.created_at || run.createdAt),
      startedAt: timestamp(run.started_at || run.startedAt),
      finishedAt: timestamp(run.finished_at || run.finishedAt),
      output: run.output, error: run.error,
    };
  }
  return { list, normalizeCard, normalizeRun, number, text };
}

function createAutomationStatusTools(core) {
  const ACTIVE_RUN_STATUSES = new Set([
    'pending', 'running', 'waiting_device', 'waiting_target', 'waiting_ai',
    'retry_wait', 'paused_offline',
  ]);
  const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
  const labels = Object.freeze({
    active: '可执行', published: '可执行', disabled: '已停用', deprecated: '旧版本',
    draft: '草稿', validated: '已校验', pending: '待执行', running: '执行中',
    waiting_device: '等待设备', waiting_target: '等待目标', waiting_ai: '等待 AI',
    retry_wait: '等待重试', paused_offline: '离线暂停', succeeded: '成功', failed: '失败',
    cancelled: '已取消', timed_out: '超时',
  });
  function statusLabel(status) {
    const value = core.text(status).toLowerCase();
    return labels[value] || value || '未知';
  }
  function statusTone(status) {
    const value = core.text(status).toLowerCase();
    if (['active', 'published', 'succeeded'].includes(value)) return 'success';
    if (['failed', 'cancelled', 'timed_out', 'disabled'].includes(value)) return 'danger';
    if (['waiting_ai', 'retry_wait', 'paused_offline'].includes(value)) return 'warning';
    return 'info';
  }
  function filterCards(cards, query = '', status = '') {
    const needle = core.text(query).toLocaleLowerCase();
    const wantedStatus = core.text(status).toLowerCase();
    return core.list(cards).map(core.normalizeCard).filter((card) => {
      if (wantedStatus && card.status.toLowerCase() !== wantedStatus) return false;
      if (!needle) return true;
      return [card.name, card.description, ...card.tags].join(' ').toLocaleLowerCase().includes(needle);
    });
  }
  function cardRunSummary(runs, cardId) {
    const matching = core.list(runs).map(core.normalizeRun).filter((run) => run.cardId === cardId)
      .sort((left, right) => right.createdAt - left.createdAt);
    const terminal = matching.filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
    const succeeded = terminal.filter((run) => run.status === 'succeeded').length;
    return {
      successRate: terminal.length ? `${Math.round((succeeded / terminal.length) * 100)}%` : '—',
      latestAt: matching[0]?.createdAt || 0, latestStatus: matching[0]?.status || '',
    };
  }
  return { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES, cardRunSummary, filterCards, statusLabel, statusTone };
}

function createAutomationMetadataTools(core) {
  function editorMetadata(source = {}) {
    const card = core.normalizeCard(source);
    const data = card.raw;
    const definition = data.definition && typeof data.definition === 'object' ? data.definition : {};
    const sourceLimits = source.limits && typeof source.limits === 'object' ? source.limits : {};
    const limits = definition.limits && typeof definition.limits === 'object' ? definition.limits : sourceLimits;
    return {
      status: card.status, riskLevel: card.riskLevel, tags: card.tags.join(', '), accessScope: card.accessScope,
      inputSchema: JSON.stringify(source.inputSchema || definition.inputSchema || data.inputSchema || { type: 'object', properties: {} }, null, 2),
      timeoutSeconds: Math.max(1, core.number(limits.timeoutSeconds, core.number(data.timeoutSeconds, 900))),
      maxTransitions: Math.max(1, core.number(limits.maxTransitions, core.number(data.maxTransitions, 120))),
    };
  }
  function applyEditorMetadata(card, metadata = {}) {
    const result = { ...(card || {}) };
    const inputSchema = typeof metadata.inputSchema === 'string'
      ? JSON.parse(metadata.inputSchema || '{}') : metadata.inputSchema;
    result.status = core.text(metadata.status, 'active');
    result.enabled = result.status !== 'disabled';
    result.risk_level = core.text(metadata.riskLevel, 'read_only');
    result.tags = core.text(metadata.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
    result.access_scope = core.text(metadata.accessScope, 'owner');
    result.definition = {
      ...(result.definition || {}), inputSchema,
      limits: {
        ...(result.definition?.limits || {}),
        timeoutSeconds: Math.max(1, core.number(metadata.timeoutSeconds, 900)),
        maxTransitions: Math.max(1, core.number(metadata.maxTransitions, 120)),
      },
    };
    return result;
  }
  function runDuration(run) {
    const normalized = core.normalizeRun(run);
    if (!normalized.startedAt) return 0;
    return Math.max(0, ((normalized.finishedAt || Date.now()) - normalized.startedAt) / 1000);
  }
  return { applyEditorMetadata, editorMetadata, runDuration };
}

(function exposeAutomationWorkbenchViewModel() {
  const core = createAutomationNormalizationTools();
  const api = { ...core, ...createAutomationStatusTools(core), ...createAutomationMetadataTools(core) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AutomationWorkbenchViewModel = Object.freeze(api);
})();
