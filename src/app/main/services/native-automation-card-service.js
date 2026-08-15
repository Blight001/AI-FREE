'use strict';

const crypto = require('crypto');
const { definitionDigest, normalizedMetadata } = require('./automation-card-store');

const ACTIONS = new Set([
  'rules', 'list', 'get', 'write', 'patch_step', 'insert_step', 'delete_step', 'move_step', 'delete', 'run',
  'validate', 'clone', 'versions', 'get_version', 'set_enabled', 'export',
]);
const STEP_TYPES = new Set([
  'navigate', 'click', 'type', 'wait', 'condition', 'save_cookies',
  'clear_current_page_cache', 'get_credits', 'screenshot', 'mcp', 'delay', 'end',
]);
const RULES = `原生自动化卡片格式：cardData 至少包含 name、website 或首个 navigate，以及非空 steps。
步骤 type 允许 navigate/click/type/wait/condition/save_cookies/clear_current_page_cache/get_credits/screenshot/mcp/delay/end。
click/type/wait 使用 selector；type 可用 variable 与 inputs 覆盖 text；condition 支持 selector_exists/selector_missing/text_exists/text_missing/url_matches，可用 fail_on_false=true 把未满足条件作为卡片失败。
通用 MCP 步骤格式为 {type:"mcp",tool:"已有工具名",arguments:{...}}；arguments 支持 {变量名} 替换，但禁止递归调用 manage_card。
可选 flow={start,nodes,edges}，边 label 使用 next/default/true/false；有 flow 时没有出边的节点即为流程终点。MCP 不允许任意 JavaScript。`;

function text(value) { return String(value == null ? '' : value).trim(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function cardVersionUpdate(previousVersions, digest, cardData) {
  const previous = previousVersions.at(-1);
  if (previous?.digest === digest) return { version: previous, versions: previousVersions };
  const version = {
    id: crypto.randomUUID(), versionNumber: previousVersions.length + 1, digest,
    cardData: clone(cardData), createdAt: Date.now(),
  };
  return { version, versions: [...previousVersions, version] };
}

function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('cardData 必须是对象');
  if (!Array.isArray(card.steps) || !card.steps.length) throw new Error('cardData.steps 必须是非空数组');
  card.steps.forEach((step, index) => {
    const type = text(step?.type).toLowerCase();
    if (!STEP_TYPES.has(type)) throw new Error(`steps[${index}] 的 type 不受原生控制支持: ${type || '(空)'}`);
    if (type === 'condition' && text(step.condition_mode || step.condition).toLowerCase() === 'js') {
      throw new Error('原生自动化卡片禁止 JavaScript 条件');
    }
    if (type === 'mcp') {
      if (!text(step.tool)) throw new Error(`steps[${index}] 的 MCP 步骤缺少 tool`);
      const args = step.arguments ?? step.args ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`steps[${index}].arguments 必须是对象`);
      }
    }
  });
  if (!text(card.website) && !['navigate', 'mcp', 'delay', 'end'].includes(text(card.steps[0]?.type).toLowerCase())) {
    throw new Error('卡片缺少 website 或入口 navigate 步骤');
  }
}

function summarizeListedCard(item) {
  const data = item?.cardData && typeof item.cardData === 'object' ? item.cardData : {};
  return {
    id: item.id,
    name: item.cardName,
    website: text(data.website),
    description: text(data.description).slice(0, 160),
    stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
    updatedAt: item.updatedAt,
    status: item.status,
    riskLevel: item.riskLevel,
    tags: clone(item.tags || []),
    accessScope: item.accessScope,
    latestVersionId: item.latestVersionId,
    versionCount: Array.isArray(item.versions) ? item.versions.length : 0,
  };
}

function resolveCard(state, args) {
  const id = text(args.id);
  const byId = id ? state.items.find((item) => text(item.id) === id) : null;
  if (byId) return byId;
  const name = text(args.card_name);
  const matches = name ? state.items.filter((item) => text(item.cardName) === name) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`存在多个同名卡片「${name}」，请使用 id`);
  throw new Error(`自动化卡片不存在: ${id || name || '(未指定)'}。请先 list 并根据名称、网站或说明筛选后传入 id 或唯一 card_name`);
}

function normalizeInputs(args, card) {
  const source = Array.isArray(args.inputs)
    ? Object.fromEntries(args.inputs.map((value, index) => [`var${index + 1}`, value]))
    : { ...(args.inputs || {}) };
  let typeIndex = 0;
  for (const step of card.steps) {
    if (text(step.type).toLowerCase() !== 'type') continue;
    typeIndex += 1;
    const key = text(step.variable) || `var${typeIndex}`;
    if (source[key] === undefined) source[key] = step.text ?? '';
  }
  return source;
}

function substitute(value, inputs) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{([^{}]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(inputs, key) ? String(inputs[key]) : match
  ));
}

function materializeValue(value, inputs) {
  if (typeof value === 'string') return substitute(value, inputs);
  if (Array.isArray(value)) return value.map((item) => materializeValue(item, inputs));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materializeValue(item, inputs)]));
}

function materializeStep(step, inputs) {
  const result = materializeValue(step || {}, inputs);
  if (text(result.type).toLowerCase() === 'type') {
    const variable = text(result.variable);
    if (variable && inputs[variable] !== undefined) result.text = String(inputs[variable]);
  }
  return result;
}

function conditionPassed(step, result) {
  const mode = text(step.condition_mode || step.condition || 'selector_exists').toLowerCase();
  const found = result?.success === true && (Array.isArray(result.items) ? result.items.length > 0 : true);
  return mode.endsWith('_missing') ? !found : found;
}

function nextFlowIndex(card, currentIndex, branch) {
  const current = card.steps[currentIndex] || {};
  const currentId = text(current.id) || `step_${currentIndex + 1}`;
  const edges = Array.isArray(card.flow?.edges) ? card.flow.edges : [];
  const labels = branch === undefined ? ['next', 'default', ''] : [String(branch), 'default', 'next'];
  const edge = edges.find((item) => text(item.from || item.source) === currentId
    && labels.includes(text(item.label || item.branch || 'next').toLowerCase()));
  if (!edge) return -1;
  const target = text(edge.to || edge.target);
  return card.steps.findIndex((step, index) => (text(step.id) || `step_${index + 1}`) === target);
}

function initialStepIndex(card, args) {
  const requested = Number(args.start_step || 0);
  if (requested > 0) return Math.max(0, requested - 1);
  const startId = text(card.flow?.start);
  if (!startId) return 0;
  const found = card.steps.findIndex((step, index) => (text(step.id) || `step_${index + 1}`) === startId);
  return found >= 0 ? found : 0;
}

function cancellationError() {
  const error = /** @type {Error & {errorCode?:string,retryable?:boolean}} */ (new Error('自动化运行已取消'));
  error.errorCode = 'RUN_CANCELLED';
  error.retryable = true;
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError();
}

function waitForRetry(ms, signal) {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const completed = () => { signal?.removeEventListener?.('abort', aborted); resolve(undefined); };
    const timer = setTimeout(completed, Math.max(0, Number(ms) || 0));
    const aborted = () => { clearTimeout(timer); reject(cancellationError()); };
    signal?.addEventListener?.('abort', aborted, { once: true });
  });
}

async function openCardWebsite(card, args, dispatch, execution) {
  if (Number(args.start_step || 0) > 1 || text(card.steps[0]?.type).toLowerCase() === 'navigate') return;
  const url = text(card.website);
  if (!url) return;
  const result = await dispatch('browser_tab', { action: 'replace', url });
  execution.push({ stepIndex: 0, name: '打开卡片网站', type: 'navigate', success: true, result });
}

async function executeCondition(step, dispatch) {
  const mode = text(step.condition_mode || step.condition || 'selector_exists').toLowerCase();
  if (mode === 'url_matches') {
    const listed = await dispatch('browser_tab', { action: 'list' });
    const url = text(listed?.activeTab?.url);
    return { success: url.includes(text(step.url || step.text)), matched: url };
  }
  const observe = await dispatch('browser_observe', {
    keyword: mode.startsWith('text_') ? text(step.text || step.wait_for_text) : '',
    limit: 20, mark: false,
  });
  return { ...observe, success: conditionPassed(step, observe) };
}

function dispatchRequest(step) {
  const type = text(step.type).toLowerCase();
  if (type === 'navigate') return ['browser_tab', { action: 'replace', url: step.url }];
  if (type === 'click' || type === 'type') return ['browser_action', { ...step, action: type }];
  if (type === 'wait') return ['browser_wait', {
    ...step, ms: step.timeout, timeout_ms: step.timeout, selector: step.selector || step.wait_for_element,
  }];
  if (type === 'save_cookies') return ['browser_file', { ...step, action: 'save_session' }];
  if (type === 'screenshot') return ['browser_screenshot', step];
  if (type === 'get_credits') return ['browser_observe', { keyword: step.selector || step.text, limit: 10, mark: false }];
  if (type === 'mcp') return [text(step.tool), step.arguments ?? step.args ?? {}];
  return null;
}

async function executeStep(step, dispatch, context = {}) {
  const type = text(step.type).toLowerCase();
  if (type === 'delay') {
    const delayMs = Number(step.delayMs ?? step.timeout ?? (Number(step.delaySeconds ?? step.seconds ?? 0) * 1000));
    await waitForRetry(delayMs, context.signal);
    return { success: true, delayMs };
  }
  if (type === 'condition') return executeCondition(step, dispatch);
  if (type === 'clear_current_page_cache') throw new Error('当前 Chromium 原生协议尚未开放清理当前站点数据命令');
  const request = dispatchRequest(step);
  if (!request) throw new Error(`未知卡片步骤类型: ${type}`);
  return dispatch(request[0], request[1]);
}

function retryPolicy(step) {
  const source = step.retryPolicy && typeof step.retryPolicy === 'object' ? step.retryPolicy : {};
  return {
    maxAttempts: Math.min(10, Math.max(1, Number(source.maxAttempts || step.max_attempts || 1))),
    delayMs: Math.max(0, Number(source.delaySeconds ?? step.retry_delay ?? 0) * 1000),
    exponential: source.backoff === 'exponential',
  };
}

async function executeStepWithRetry(step, dispatch, context, progressBase) {
  const policy = retryPolicy(step);
  let lastError;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    throwIfCancelled(context.signal);
    context.onProgress?.({ ...progressBase, phase: 'started', attempt });
    try {
      const result = await executeStep(step, dispatch, context);
      const resultError = stepResultError(step, result);
      if (resultError) throw resultError;
      context.onProgress?.({ ...progressBase, phase: 'succeeded', attempt, success: true, result });
      return result;
    } catch (error) {
      lastError = error;
      context.onProgress?.({ ...progressBase, phase: 'failed', attempt, success: false, error: error?.message || String(error) });
      if (attempt >= policy.maxAttempts || error?.errorCode === 'RUN_CANCELLED') throw error;
      const delay = policy.exponential ? policy.delayMs * (2 ** (attempt - 1)) : policy.delayMs;
      await waitForRetry(Math.min(60000, delay), context.signal);
    }
  }
  throw lastError;
}

function failedStepResult(error, index, inputs, execution) {
  return {
    success: false,
    errorCode: error?.errorCode || error?.code || 'CARD_STEP_FAILED',
    error: error?.message || String(error),
    stepIndex: index + 1,
    context: inputs,
    execution,
  };
}

function conditionMustPass(step) {
  return text(step.type).toLowerCase() === 'condition' && step.fail_on_false === true;
}

function toolResultFailed(step, result) {
  if (text(step.type).toLowerCase() === 'condition') return false;
  return result?.success === false || result?.ok === false;
}

function resultErrorMessage(step, result, failedCondition) {
  const reported = text(result?.error || result?.errorReason || result?.message);
  if (reported) return reported;
  if (failedCondition) return `条件未满足: ${text(step.name) || text(step.condition_mode) || 'condition'}`;
  return `步骤执行失败: ${text(step.name) || text(step.type) || 'unknown'}`;
}

function stepResultError(step, result) {
  const failedCondition = conditionMustPass(step) && result?.success !== true;
  const failedTool = toolResultFailed(step, result);
  if (!failedCondition && !failedTool) return null;
  const error = /** @type {Error & {errorCode?: string}} */ (
    new Error(resultErrorMessage(step, result, failedCondition))
  );
  error.errorCode = text(result?.errorCode || result?.code)
    || (failedCondition ? 'CARD_CONDITION_FAILED' : 'CARD_STEP_FAILED');
  return error;
}

function stepProgress(step, index, count) {
  return {
    stepId: text(step.id) || `step_${index + 1}`, stepIndex: index + 1,
    transitionCount: count + 1, type: step.type, name: text(step.name),
  };
}

function finishAtEnd(step, index, count, execution, context) {
  context.onProgress?.({ ...stepProgress(step, index, count), phase: 'succeeded', success: true });
  execution.push({ stepIndex: index + 1, name: text(step.name), type: 'end', success: true, result: { ended: true } });
  return { ended: true };
}

function nextStepIndex(card, index, step, result) {
  const next = card.flow
    ? nextFlowIndex(card, index, text(step.type) === 'condition' ? result.success : undefined)
    : index + 1;
  return next >= card.steps.length ? -1 : next;
}

async function runOneStep(card, index, count, inputs, execution, dispatch, context) {
  throwIfCancelled(context.signal);
  const step = materializeStep(card.steps[index], inputs);
  if (text(step.type).toLowerCase() === 'end') return finishAtEnd(step, index, count, execution, context);
  try {
    const result = await executeStepWithRetry(step, dispatch, context, stepProgress(step, index, count));
    execution.push({ stepIndex: index + 1, name: text(step.name), type: step.type, success: true, result });
    return { next: nextStepIndex(card, index, step, result) };
  } catch (error) {
    execution.push({ stepIndex: index + 1, name: text(step.name), type: step.type, success: false, error: error?.message || String(error) });
    if (step.optional === true) return { next: index + 1 };
    return { failed: failedStepResult(error, index, inputs, execution) };
  }
}

async function runCard(card, args, dispatch, context = {}) {
  const inputs = normalizeInputs(args, card);
  let index = initialStepIndex(card, args);
  let count = 0;
  const execution = [];
  throwIfCancelled(context.signal);
  await openCardWebsite(card, args, dispatch, execution);
  const maxTransitions = Math.max(1, Number(context.maxTransitions || Math.max(120, card.steps.length * 20)));
  while (index >= 0 && count < maxTransitions) {
    const outcome = await runOneStep(card, index, count, inputs, execution, dispatch, context);
    if (outcome.failed) return outcome.failed;
    if (outcome.ended) break;
    index = outcome.next;
    count += 1;
  }
  if (count >= maxTransitions) throw new Error('自动化卡片流程超过安全步数限制');
  return { success: true, cardName: text(card.name), context: inputs, execution };
}

class NativeAutomationCardService {
  constructor(options = {}) {
    this.read = options.read;
    this.write = options.write;
  }

  state() { return this.read().state; }

  persist(state) { return this.write(state); }

  writeCard(args) {
    validateCard(args.cardData);
    const state = this.state();
    const requestedId = text(args.id || args.cardData.id);
    const existing = requestedId
      ? state.items.find((item) => text(item.id) === requestedId)
      : state.items.find((item) => text(item.cardName) === text(args.cardData.name));
    const id = text(existing?.id) || requestedId || crypto.randomUUID();
    const cardData = clone(args.cardData);
    const digest = definitionDigest(cardData);
    const previousVersions = Array.isArray(existing?.versions) ? existing.versions : [];
    const { version, versions } = cardVersionUpdate(previousVersions, digest, cardData);
    const definitionMetadata = args.cardData?.definition && typeof args.cardData.definition === 'object'
      ? args.cardData.definition : {};
    const metadata = normalizedMetadata({
      ...existing, ...args.cardData, ...definitionMetadata, ...(args.metadata || {}), ...args,
    });
    const entry = {
      ...existing, ...metadata, id, cardName: text(cardData.name) || `automation_${Date.now()}`,
      cardData, latestVersionId: version.id, versions, updatedAt: Date.now(),
    };
    state.items = existing ? state.items.map((item) => item === existing ? entry : item) : [...state.items, entry];
    state.selectedId = id;
    this.persist(state);
    return { success: true, item: entry, state };
  }

  resolveVersion(entry, versionId) {
    if (!versionId) return entry.versions.find((version) => version.id === entry.latestVersionId) || entry.versions.at(-1);
    const version = entry.versions.find((item) => item.id === text(versionId));
    if (!version) throw new Error(`自动化卡片版本不存在: ${versionId}`);
    return version;
  }

  validateEntry(entry, versionId) {
    const version = this.resolveVersion(entry, versionId);
    validateCard(version.cardData);
    const warnings = [];
    if (!text(version.cardData.description)) warnings.push('卡片缺少说明');
    return { success: true, valid: true, digest: version.digest || definitionDigest(version.cardData), warnings };
  }

  cloneCard(args) {
    const state = this.state();
    const source = resolveCard(state, args);
    const cardData = clone(this.resolveVersion(source, args.version_id).cardData);
    cardData.name = text(args.name) || `${text(cardData.name) || source.cardName} 副本`;
    return this.writeCard({ cardData, metadata: source });
  }

  setEnabled(args) {
    const state = this.state();
    const entry = resolveCard(state, args);
    entry.status = args.enabled === false ? 'deprecated' : 'active';
    entry.updatedAt = Date.now();
    this.persist(state);
    return { success: true, item: clone(entry), state };
  }

  editStep(args, action) {
    const state = this.state();
    const entry = resolveCard(state, args);
    const card = clone(entry.cardData);
    const index = Math.max(0, Number(args.step_index || card.steps.length + 1) - 1);
    if (action === 'insert_step') card.steps.splice(index, 0, clone(args.stepData || {}));
    else if (action === 'delete_step') card.steps.splice(index, 1);
    else if (action === 'move_step') {
      const [step] = card.steps.splice(index, 1);
      card.steps.splice(Math.max(0, Number(args.to_step_index || 1) - 1), 0, step);
    } else {
      const patch = args.stepPatch || args.stepData || {};
      card.steps[index] = args.replace === true ? clone(patch) : { ...card.steps[index], ...clone(patch) };
    }
    return this.writeCard({ id: entry.id, cardData: card });
  }

  deleteCard(args) {
    const state = this.state();
    const entry = resolveCard(state, args);
    state.items = state.items.filter((item) => item !== entry);
    if (state.selectedId === entry.id) state.selectedId = state.items[0]?.id || '';
    this.persist(state);
    return { success: true, deletedId: entry.id, state };
  }

  directAction(action, args, state) {
    return ({
      list: () => ({ success: true, selectedId: state.selectedId, items: state.items.map(summarizeListedCard) }),
      get: () => ({ success: true, item: clone(resolveCard(state, args)) }),
      write: () => this.writeCard(args), delete: () => this.deleteCard(args),
      clone: () => this.cloneCard(args), set_enabled: () => this.setEnabled(args),
    })[action];
  }

  versionAction(action, entry, args) {
    return ({
      validate: () => this.validateEntry(entry, args.version_id),
      versions: () => ({ success: true, items: clone(entry.versions || []) }),
      get_version: () => ({ success: true, version: clone(this.resolveVersion(entry, args.version_id)) }),
      export: () => ({ success: true, card: clone(entry) }),
    })[action];
  }

  async execute(args = {}, context = {}) {
    const action = text(args.action).toLowerCase();
    if (!ACTIONS.has(action)) throw new Error(`未知的 manage_card action: ${action || '(空)'}`);
    if (action === 'rules') return { success: true, rules: RULES, stepTypes: Array.from(STEP_TYPES) };
    const state = this.state();
    const direct = this.directAction(action, args, state);
    if (direct) return direct();
    if (['patch_step', 'insert_step', 'delete_step', 'move_step'].includes(action)) return this.editStep(args, action);
    const entry = resolveCard(state, args);
    const versionAction = this.versionAction(action, entry, args);
    if (versionAction) return versionAction();
    const version = this.resolveVersion(entry, args.version_id);
    validateCard(version.cardData);
    return runCard(version.cardData, args, context.dispatch, { ...context, maxTransitions: entry.limits?.maxTransitions });
  }
}

function createNativeAutomationCardService(options) { return new NativeAutomationCardService(options); }

module.exports = { createNativeAutomationCardService, runCard, validateCard };
