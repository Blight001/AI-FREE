'use strict';

const { performance } = require('node:perf_hooks');
const { checkedActionProperties } = require('./browser-workflow-tool-definition');

const MAX_STEPS = 50;
const MAX_STEP_TIMEOUT_MS = 10000;
const DISPATCH_BUDGET_MS = 60000;
const STEP_TOOLS = ['browser_action', 'browser_wait'];
const NOT_SUPPORTED_BY_BOUND_ACTION = new Set([
  ...Object.keys(checkedActionProperties), 'scope', 'has_text', 'to_ref', 'observation_options',
]);

const PAGE_BATCH_TOOL = {
  name: 'browser_page_batch',
  description: `已知同一网页上后续各步的参数时，用一次调用按顺序执行 1–${MAX_STEPS} 步，无需在步骤之间请求模型。先观察并接管，steps 内使用 browser_action 原始页面动作参数或 browser_wait 条件等待参数（使用 selector 或 url_matches），每步 timeout_ms 不超过 ${MAX_STEP_TIMEOUT_MS}。若需要依据新观察选择下一步，先结束本批并观察；本批不支持切页、上传、后置观察或工作流断言。失败即停止，不回滚、不重试。`,
  input_schema: {
    type: 'object', required: ['steps'], additionalProperties: false,
    properties: {
      steps: {
        type: 'array', minItems: 1, maxItems: MAX_STEPS,
        items: {
          type: 'object', required: ['tool', 'arguments'], additionalProperties: false,
          properties: { tool: { type: 'string', enum: STEP_TOOLS }, arguments: { type: 'object' } },
        },
      },
    },
  },
};

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const SCHEMA_TYPES = {
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  number: Number.isFinite,
  integer: Number.isInteger,
};

function validField(schema, key, value) {
  if (!Object.hasOwn(schema, key) || NOT_SUPPORTED_BY_BOUND_ACTION.has(key)) return false;
  const field = schema[key];
  return SCHEMA_TYPES[field.type]?.(value) && (!field.enum || field.enum.includes(value))
    && (field.minimum === undefined || value >= field.minimum);
}

function validAction(args) {
  return Boolean(args.action) && (!args.surface || args.surface === 'page') && (!args.after || args.after === 'none');
}

function validWait(args) {
  return Boolean(args.selector?.trim() || args.condition === 'url_matches') && args.ms === undefined;
}

function validStep(step, available) {
  if (!isObject(step) || Object.keys(step).length !== 2 || !isObject(step.arguments)) return false;
  const { tool, arguments: args } = step;
  const schema = available.get(tool);
  if (!schema || !STEP_TOOLS.includes(tool)) return false;
  if (Object.entries(args).some(([key, value]) => !validField(schema, key, value))) return false;
  if (args.timeout_ms !== undefined && (args.timeout_ms <= 0 || args.timeout_ms > MAX_STEP_TIMEOUT_MS)) return false;
  return tool === 'browser_action' ? validAction(args) : validWait(args);
}

function batchFailure(errorCode, error) {
  return { success: false, errorCode, error, recoverable: false };
}

function validatePlan(args, connection) {
  const { steps } = args;
  if (Object.keys(args).length !== 1 || !Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) {
    return batchFailure('BROWSER_PAGE_BATCH_INVALID', `请提供 1–${MAX_STEPS} 个页面操作步骤；未执行任何步骤`);
  }
  const available = new Map((connection.tools || []).map(({ name, input_schema }) => [name, input_schema?.properties]));
  const invalidStep = steps.findIndex((step) => !validStep(step, available)) + 1;
  if (!invalidStep) return null;
  return { ...batchFailure('BROWSER_PAGE_BATCH_INVALID', `第 ${invalidStep} 步的工具或参数不支持批处理；未执行任何步骤`),
    invalidStep, requested: steps.length, completed: 0, notAttempted: steps.length };
}

async function executeStep(context, step, dispatch) {
  try {
    return await context.waitForAbort(dispatch(step.arguments, step.tool));
  } catch (_) {
    if (context.signal?.aborted) return batchFailure('BROWSER_PAGE_BATCH_STOPPED', '页面批处理已停止，当前步骤结果未确认');
    return batchFailure('BROWSER_PAGE_BATCH_OUTCOME_UNKNOWN', '未收到当前步骤的回执，请先核对页面');
  }
}

function failedStep(step, result, requested, completed) {
  const outcome = step.tool === 'browser_wait' ? 'condition_unconfirmed'
    : result?.actionExecuted === false ? 'not_executed' : result?.actionExecuted === true ? 'executed' : 'unknown';
  return {
    ...batchFailure(result?.errorCode || 'BROWSER_PAGE_BATCH_STEP_FAILED', result?.error || '步骤未确认成功，请先核对页面'),
    requested, completed, notAttempted: requested - completed - 1,
    failedStep: completed + 1, failedTool: step.tool, failedStepOutcome: outcome,
  };
}

function interruption(context, deadline) {
  if (context.signal?.aborted) return batchFailure('BROWSER_PAGE_BATCH_STOPPED', '批处理已停止');
  if (context.hasInsertedMessages?.()) return batchFailure('BROWSER_PAGE_BATCH_USER_INPUT', '收到新用户消息，未继续执行原计划');
  if (performance.now() >= deadline) return batchFailure('BROWSER_PAGE_BATCH_DEADLINE', '已达到批处理时限');
  return null;
}

async function executePageBatch(context, connection, args, dispatch) {
  const invalid = validatePlan(args, connection);
  if (invalid) return invalid;
  const { steps } = args;
  const requested = steps.length;
  const deadline = performance.now() + DISPATCH_BUDGET_MS;
  for (let completed = 0; completed < requested; completed++) {
    const stopped = interruption(context, deadline);
    if (stopped) return { ...stopped, requested, completed, notAttempted: requested - completed };
    const step = steps[completed];
    const result = await executeStep(context, step, dispatch);
    if (result?.success !== true || result.actionExecuted === false) return failedStep(step, result, requested, completed);
    context.reportBatchProgress?.({ completed: completed + 1, requested });
  }
  return { success: true, requested, completed: requested, notAttempted: 0 };
}

module.exports = { PAGE_BATCH_TOOL, executePageBatch };
