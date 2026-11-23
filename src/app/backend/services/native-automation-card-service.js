'use strict';

const crypto = require('crypto');
const { definitionDigest, normalizedMetadata } = require('./automation-card-store');
const cardLifecycle = require('./automation-card-lifecycle');
const { AUTOMATION_CARD_SERVICE_ACTIONS } = require('./automation-card-contract');
const { versionInputSchema } = require('./automation-card-inputs');
const { runCard } = require('./automation-card-execution');
const { isDeepStrictEqual } = require('node:util');
const { videoEditingRegressionCard } = require('./video-editing-regression-card');

const ACTIONS = new Set(AUTOMATION_CARD_SERVICE_ACTIONS);
const STEP_TYPES = new Set([
  'navigate', 'click', 'type', 'wait', 'condition', 'save_cookies',
  'clear_current_page_cache', 'get_credits', 'screenshot', 'mcp', 'delay', 'end',
]);
const RULES = `原生自动化卡片格式：cardData 至少包含 name、website 或首个 navigate，以及非空 steps。
步骤 type 允许 navigate/click/type/wait/condition/save_cookies/clear_current_page_cache/get_credits/screenshot/mcp/delay/end。
patch_step 的 step_index 从 1 开始。修复运行时直接使用 get_run 返回的目标 stepIndex，并用 get 核对当前步骤的 type 和 tool。
原生步骤的字段直接写在 stepPatch 顶层，click/type/wait 使用 selector；type 可用 variable 与 inputs 覆盖 text；condition 支持 selector_exists/selector_missing/text_exists/text_missing/url_matches，可用 fail_on_false=true 把未满足条件作为卡片失败。
通用 MCP 步骤格式为 {type:"mcp",tool:"已有工具名",arguments:{...}}；arguments 支持 {变量名} 替换，但禁止递归调用 manage_card。
可选 flow={start,nodes,edges}，边 label 使用 next/default/true/false；有 flow 时没有出边的节点即为流程终点。MCP 不允许任意 JavaScript。`;

function text(value) { return String(value == null ? '' : value).trim(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function cardVersionUpdate(previousVersions, digest, cardData, inputSchema) {
  const previous = previousVersions.at(-1);
  if (previous?.digest === digest && isDeepStrictEqual(previous.inputSchema, inputSchema)) return { version: previous, versions: previousVersions };
  const version = {
    id: crypto.randomUUID(), versionNumber: previousVersions.length + 1, digest,
    cardData: clone(cardData), inputSchema: clone(inputSchema), createdAt: Date.now(),
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

function patchStepIndex(value, count) {
  const position = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(position) || position < 1 || position > count) {
    throw new Error(`patch_step 的 step_index 必须是 1 到 ${count} 的整数。请核对 get_run 的 stepIndex 和当前卡片步骤`);
  }
  return position - 1;
}

function patchedStep(current, args, index) {
  const patch = args.stepPatch || args.stepData || {};
  const next = args.replace === true ? clone(patch) : { ...current, ...clone(patch) };
  const type = text(next.type).toLowerCase();
  if (type !== 'mcp' && (Object.hasOwn(patch, 'arguments') || Object.hasOwn(patch, 'args'))) {
    throw new Error(`第 ${index + 1} 步为 ${type}。原生步骤参数应写在 stepPatch 顶层，只有 MCP 步骤使用 arguments。请核对 step_index`);
  }
  return next;
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
  const includeDeleted = args.include_deleted === true;
  const byId = id ? state.items.find((item) => text(item.id) === id && (includeDeleted || !item.deletedAt)) : null;
  if (byId) return byId;
  const name = text(args.card_name);
  const matches = name ? state.items.filter((item) => text(item.cardName) === name && (includeDeleted || !item.deletedAt)) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`存在多个同名卡片「${name}」，请使用 id`);
  throw new Error(`自动化卡片不存在: ${id || name || '(未指定)'}。请先 list 并根据名称、网站或说明筛选后传入 id 或唯一 card_name`);
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
    cardLifecycle.assertEditable(existing);
    const id = text(existing?.id) || requestedId || crypto.randomUUID();
    const cardData = clone(args.cardData);
    const digest = definitionDigest(cardData);
    const definitionMetadata = args.cardData?.definition && typeof args.cardData.definition === 'object'
      ? args.cardData.definition : {};
    const metadata = normalizedMetadata({
      ...existing, ...args.cardData, ...definitionMetadata, ...(args.metadata || {}), ...args,
    });
    const previousVersions = (existing?.versions || []).map((v) => (
      v.id === existing.latestVersionId && !v.inputSchema ? { ...v, inputSchema: existing.inputSchema } : v
    ));
    const { version, versions } = cardVersionUpdate(previousVersions, digest, cardData, metadata.inputSchema);
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
    const version = this.resolveVersion(source, args.version_id);
    const cardData = clone(version.cardData);
    cardData.name = text(args.name) || `${text(cardData.name) || source.cardName} 副本`;
    return this.writeCard({ cardData, metadata: { ...source, inputSchema: versionInputSchema(source, version) } });
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
    const index = action === 'patch_step' ? patchStepIndex(args.step_index, card.steps.length)
      : Math.max(0, Number(args.step_index || card.steps.length + 1) - 1);
    if (action === 'insert_step') card.steps.splice(index, 0, clone(args.stepData || {}));
    else if (action === 'delete_step') card.steps.splice(index, 1);
    else if (action === 'move_step') {
      const [step] = card.steps.splice(index, 1);
      card.steps.splice(Math.max(0, Number(args.to_step_index || 1) - 1), 0, step);
    } else {
      card.steps[index] = patchedStep(card.steps[index], args, index);
    }
    return this.writeCard({ id: entry.id, cardData: card });
  }

  deleteCard(args) {
    const state = this.state();
    const entry = resolveCard(state, args);
    const deletedAt = cardLifecycle.softDelete(state, entry);
    this.persist(state);
    return { success: true, deletedId: entry.id, deletedAt, state };
  }

  restoreCard(args) {
    const state = this.state();
    const entry = resolveCard(state, { ...args, include_deleted: true });
    cardLifecycle.restore(entry);
    this.persist(state);
    return { success: true, item: clone(entry), state };
  }

  purgeCard(args) {
    const state = this.state();
    const entry = resolveCard(state, { ...args, include_deleted: true });
    cardLifecycle.purge(state, entry);
    this.persist(state);
    return { success: true, deletedId: entry.id, permanent: true, state };
  }

  directAction(action, args, state) {
    return ({
      list: () => ({ success: true, selectedId: state.selectedId, items: state.items
        .filter((item) => Boolean(item.deletedAt) === (args.include_deleted === true))
        .map(summarizeListedCard) }),
      get: () => ({ success: true, item: clone(resolveCard(state, args)) }),
      write: () => this.writeCard(args), delete: () => this.deleteCard(args),
      clone: () => this.cloneCard(args), set_enabled: () => this.setEnabled(args),
      restore: () => this.restoreCard(args), purge: () => this.purgeCard(args),
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
    if (action === 'template') return { success: true, template: videoEditingRegressionCard(args.overrides || {}) };
    const state = this.state();
    const direct = this.directAction(action, args, state);
    if (direct) return direct();
    if (['patch_step', 'insert_step', 'delete_step', 'move_step'].includes(action)) return this.editStep(args, action);
    const entry = resolveCard(state, args);
    const versionAction = this.versionAction(action, entry, args);
    if (versionAction) return versionAction();
    const version = this.resolveVersion(entry, args.version_id);
    validateCard(version.cardData);
    const inputSchema = versionInputSchema(entry, version);
    return runCard(version.cardData, args, context.dispatch, {
      ...context,
      inputSchema, redactAllInputs: !inputSchema,
      maxTransitions: entry.limits?.maxTransitions,
    });
  }
}

function createNativeAutomationCardService(options) { return new NativeAutomationCardService(options); }

module.exports = { createNativeAutomationCardService, runCard, validateCard };
