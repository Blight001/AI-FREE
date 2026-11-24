'use strict';

const { uncertainOutcome } = require('./automation-execution-outcome');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const { atomicWrite } = require('./automation-card-store');
const { createAutomationRedactor } = require('./automation-run-sanitizer');

const RUNS_FILE_NAME = 'automation-runs.json';
const ACTIVE = new Set(['pending', 'running', 'paused', 'cancelling', 'timing_out']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function now() { return Date.now(); }
const historyMasks = new WeakMap();
const ROUTING_FIELDS = ['id', 'cardId', 'versionId', 'connectionId', 'status', 'currentStepId',
  'transitionCount', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'attempt', 'sourceRunId',
  'idempotencyKey', 'sideEffectsMayHaveOccurred', 'stopRequested'];

function historyMask(run) {
  if (!historyMasks.has(run)) {
    const mask = createAutomationRedactor({ ...run.request, redactAllInputs: true });
    mask.addInputs(run.output?.context);
    historyMasks.set(run, mask);
  }
  return historyMasks.get(run);
}

function retryAllowed(run) {
  return run.status === 'failed' && run.error?.retryable === true && !run.sideEffectsMayHaveOccurred;
}

function historyRun(run, stored) {
  const mask = historyMask(run);
  const metadata = Object.fromEntries(ROUTING_FIELDS.filter((key) => Object.hasOwn(run, key))
    .map((key) => [key, run[key]]));
  const requestUnavailable = stored || !run.request;
  return {
    ...metadata, requestUnavailable,
    ...(!stored && { retryAvailable: !requestUnavailable && retryAllowed(run) }),
    output: mask.redactResult(run.output), steps: (run.steps || []).map(mask.redactStep),
    error: run.error ? { code: run.error.code, retryable: run.error.retryable === true,
      message: mask.redact(run.error.message) } : null,
  };
}
function publicRun(run) { return historyRun(run, false); }
function idempotencyRequest(request) {
  const copy = clone(request);
  delete copy.idempotency_key;
  return copy;
}
function assertIdempotencyMatch(run, request) {
  if (run.requestUnavailable || !run.request) {
    const error = /** @type {Error & {code: string, retryable: boolean}} */ (
      new Error('此幂等键对应的输入已按安全策略清除，请先查询运行结果；如需重跑请重新提交输入并使用新幂等键')
    );
    error.code = 'IDEMPOTENCY_KEY_STATE_UNAVAILABLE';
    error.retryable = false;
    throw error;
  }
  if (isDeepStrictEqual(idempotencyRequest(run.request || {}), idempotencyRequest(request))) return;
  const error = /** @type {Error & {code: string, retryable: boolean}} */ (
    new Error('idempotency_key 已用于不同的自动化运行参数')
  );
  error.code = 'IDEMPOTENCY_KEY_REUSED';
  error.retryable = false;
  throw error;
}
function failureDetails(failure, fallbackCode, message) {
  const uncertain = uncertainOutcome(failure);
  return {
    sideEffectsMayHaveOccurred: uncertain,
    error: { code: String(failure?.errorCode || failure?.code || fallbackCode),
      message: String(message), retryable: failure?.retryable === true && !uncertain },
  };
}

function cancellationMessage(sideEffectsMayHaveOccurred) {
  return sideEffectsMayHaveOccurred ? '运行已取消，已发生的浏览器副作用无法回滚' : '执行前已取消运行';
}

function normalizeRun(source) {
  const run = { ...source };
  if (ACTIVE.has(source.status)) {
    if (source.status === 'cancelling') run.stopRequested = 'cancel';
    if (source.status === 'timing_out') run.stopRequested = 'timeout';
    run.status = 'failed';
    run.finishedAt = now();
    run.sideEffectsMayHaveOccurred = source.status !== 'pending';
    run.error = { code: 'RUN_INTERRUPTED', message: '应用退出导致运行中断，请核验执行结果', retryable: false };
  } else if (source.status === 'cancelled') {
    run.sideEffectsMayHaveOccurred = source.sideEffectsMayHaveOccurred ?? Boolean(source.startedAt);
    run.error = { code: 'RUN_CANCELLED', message: cancellationMessage(run.sideEffectsMayHaveOccurred), retryable: false };
  }
  return historyRun(run, true);
}

class AutomationRunManager {
  constructor(options = {}) {
    this.filePath = path.join(path.resolve(options.dataDir), RUNS_FILE_NAME);
    this.execute = options.execute;
    this.listeners = new Set();
    this.events = [];
    this.publishing = false;
    this.controllers = new Map();
    this.controls = new Map();
    this.runs = this.readRuns();
  }

  persist(next = this.runs) {
    const runs = next.map((run) => historyRun(run, true));
    atomicWrite(this.filePath, { schemaVersion: 2, updatedAt: new Date().toISOString(), runs });
  }

  readRuns() {
    if (!fs.existsSync(this.filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8') || '{}');
    if (Number(parsed.schemaVersion) > 2) throw new Error('运行历史版本高于当前应用，无法恢复');
    if (!Array.isArray(parsed.runs)) throw new Error('运行历史格式无效，无法恢复');
    const restored = parsed.runs.map(normalizeRun);
    if (parsed.schemaVersion !== 2 || !isDeepStrictEqual(JSON.parse(JSON.stringify(restored)), parsed.runs)) {
      this.persist(restored);
    }
    return restored;
  }

  find(id) {
    const run = this.runs.find((item) => item.id === String(id || ''));
    if (!run) throw new Error(`自动化运行不存在: ${id || '(未指定)'}`);
    return run;
  }

  publish(run, event = 'updated') {
    this.persist();
    this.events.push({ event, run: publicRun(run) });
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.events.length) {
        const payload = this.events.shift();
        for (const listener of this.listeners) { try { listener(payload); } catch (_) {} }
      }
    } finally { this.publishing = false; }
  }

  patch(run, values, event) {
    Object.assign(run, values, { updatedAt: now() });
    this.publish(run, event);
  }

  progress(run, step) {
    if (TERMINAL.has(run.status) || ['cancelling', 'timing_out'].includes(run.status)) return;
    run.steps.push(clone(step));
    this.patch(run, {
      currentStepId: String(step.stepId || step.stepIndex || ''),
      transitionCount: Number(step.transitionCount || run.transitionCount || 0),
    }, 'progress');
  }

  finish(run, output) {
    historyMask(run).addInputs(output?.context);
    const failed = output?.success === false || output?.ok === false;
    const status = failed ? 'failed' : 'succeeded';
    const details = failed ? failureDetails(output, 'CARD_STEP_FAILED', output.error || '卡片步骤失败') : { error: null };
    const result = failed ? { ...output, retryable: details.error.retryable } : output;
    this.patch(run, { status, output: result, ...details, finishedAt: now() }, status);
  }

  async perform(run) {
    if (TERMINAL.has(run.status)) return;
    const controller = new AbortController();
    const control = { pauseRequested: false, singleStep: false, release: null };
    this.controllers.set(run.id, controller);
    this.controls.set(run.id, control);
    const timer = this.timeout(run, controller);
    try {
      this.patch(run, { status: 'running', startedAt: now(), error: null }, 'started');
      if (controller.signal.aborted) { this.finishCancelled(run); return; }
      const context = {
        automationRunId: run.id,
        signal: controller.signal,
        addInputs: historyMask(run).addInputs,
        onProgress: (step) => this.progress(run, step),
        beforeStep: () => this.beforeStep(run, control, controller.signal),
      };
      const output = await this.execute(clone(run.request), context);
      this.finishAfterStopRequest(run, output);
    } catch (error) {
      this.finishAfterStopRequest(run, null, error ?? new Error('自动化执行器未返回错误详情'));
    } finally {
      clearTimeout(timer);
      control.release?.();
      this.controllers.delete(run.id);
      this.controls.delete(run.id);
    }
  }

  finishAfterStopRequest(run, output, failure = null) {
    if (run.status === 'cancelling') return this.finishCancelled(run, true);
    if (run.status === 'timing_out') return this.finishTimedOut(run);
    if (TERMINAL.has(run.status)) return;
    if (failure !== null) return this.patch(run, {
      status: 'failed', ...failureDetails(failure, 'AUTOMATION_RUN_FAILED', failure.message || failure), finishedAt: now(),
    }, 'failed');
    this.finish(run, output);
  }

  finishCancelled(run, sideEffectsMayHaveOccurred = false) {
    this.patch(run, {
      status: 'cancelled', sideEffectsMayHaveOccurred, error: {
        code: 'RUN_CANCELLED', message: cancellationMessage(sideEffectsMayHaveOccurred), retryable: false,
      }, finishedAt: now(),
    }, 'cancelled');
  }

  finishTimedOut(run) {
    this.patch(run, {
      status: 'timed_out', sideEffectsMayHaveOccurred: true, error: {
        code: 'RUN_TIMED_OUT', message: '自动化运行超时；当前操作已返回，但页面副作用结果可能未知', retryable: false,
      }, finishedAt: now(),
    }, 'timed_out');
  }

  async beforeStep(run, control, signal) {
    if (!control.pauseRequested || TERMINAL.has(run.status) || ['cancelling', 'timing_out'].includes(run.status)) return;
    const gate = new Promise((resolve) => {
      const release = () => {
        signal.removeEventListener('abort', release);
        if (control.release === release) control.release = null;
        resolve(undefined);
      };
      control.release = release;
      signal.addEventListener('abort', release, { once: true });
    });
    this.patch(run, { status: 'paused' }, 'paused');
    await gate;
    if (TERMINAL.has(run.status) || ['cancelling', 'timing_out'].includes(run.status)) return;
    control.pauseRequested = control.singleStep;
    control.singleStep = false;
    this.patch(run, { status: 'running' }, 'resumed');
  }

  timeout(run, controller) {
    const timeoutMs = Math.max(1, Number(run.request.timeoutMs || 900000));
    return setTimeout(() => {
      if (TERMINAL.has(run.status) || run.status === 'cancelling') return;
      if (run.status !== 'timing_out') this.patch(run, { status: 'timing_out', error: {
        code: 'RUN_TIMED_OUT', message: '自动化运行超时；等待当前操作停止，页面副作用结果可能未知', retryable: false,
      } }, 'timing_out');
      controller.abort();
      this.controls.get(run.id)?.release?.();
    }, timeoutMs);
  }

  start(request = {}) {
    const idempotencyKey = String(request.idempotency_key || '').trim();
    const duplicate = idempotencyKey && this.runs.find((item) => !item.sourceRunId && item.idempotencyKey === idempotencyKey);
    if (duplicate) {
      assertIdempotencyMatch(duplicate, request);
      return publicRun(duplicate);
    }
    return this.createRun(request, idempotencyKey);
  }

  createRun(request, idempotencyKey, source = null) {
    const timestamp = now();
    const run = {
      id: crypto.randomUUID(), cardId: String(request.id || ''), versionId: String(request.version_id || ''),
      connectionId: String(request.connectionId || ''), status: 'pending', currentStepId: '', transitionCount: 0,
      output: null, error: null, steps: [], createdAt: timestamp, updatedAt: timestamp,
      startedAt: null, finishedAt: null, attempt: source ? source.attempt + 1 : 1,
      sourceRunId: source?.id || '', idempotencyKey,
      request: clone(request), requestUnavailable: false,
    };
    this.runs.push(run);
    try { this.publish(run, 'created'); } catch (error) { this.runs.splice(this.runs.indexOf(run), 1); throw error; }
    queueMicrotask(() => void this.perform(run));
    return publicRun(run);
  }

  hasActiveRuns() { return this.runs.some((run) => ACTIVE.has(run.status)); }

  list(query = {}) {
    let items = [...this.runs];
    if (query.card_id) items = items.filter((run) => run.cardId === String(query.card_id));
    if (query.status) items = items.filter((run) => run.status === String(query.status));
    const limit = Math.min(500, Math.max(1, Number(query.limit || 100)));
    return { success: true, items: items.slice(-limit).reverse().map(publicRun) };
  }

  get(id) { return { success: true, run: publicRun(this.find(id)) }; }
  steps(id) {
    const run = this.find(id);
    return { success: true, items: (run.steps || []).map(historyMask(run).redactStep) };
  }

  cancel(id, _reason = '') {
    const run = this.find(id);
    if (TERMINAL.has(run.status)) return { success: true, run: publicRun(run) };
    if (run.status === 'timing_out') return { success: true, run: publicRun(run) };
    if (run.status === 'pending') {
      this.finishCancelled(run);
      return { success: true, run: publicRun(run) };
    }
    if (run.status !== 'cancelling') {
      this.patch(run, { status: 'cancelling', error: {
        code: 'RUN_CANCEL_REQUESTED', message: '已请求取消，等待当前浏览器操作返回', retryable: false,
      } }, 'cancelling');
    }
    this.controllers.get(run.id)?.abort();
    this.controls.get(run.id)?.release?.();
    return { success: true, run: publicRun(run) };
  }

  pause(id) {
    const run = this.find(id);
    if (!['running', 'paused'].includes(run.status)) throw new Error('当前运行状态不能暂停');
    if (run.status === 'paused') return { success: true, run: publicRun(run) };
    const control = this.controls.get(run.id);
    if (!control) throw new Error('运行尚未进入可暂停状态');
    control.pauseRequested = true;
    return { success: true, run: publicRun(run) };
  }

  resume(id) {
    const run = this.find(id);
    if (run.status !== 'paused') throw new Error('运行当前未暂停');
    const control = this.controls.get(run.id);
    if (!control) throw new Error('运行控制器已失效');
    control.singleStep = false;
    control.pauseRequested = false;
    control.release?.();
    return { success: true, run: publicRun(run) };
  }

  step(id) {
    const run = this.find(id);
    if (run.status !== 'paused') throw new Error('单步运行仅可用于已暂停的流程');
    const control = this.controls.get(run.id);
    if (!control) throw new Error('运行控制器已失效');
    control.singleStep = true;
    control.pauseRequested = true;
    control.release?.();
    return { success: true, run: publicRun(run) };
  }

  retry(id) {
    const source = this.find(id);
    if (source.requestUnavailable || !source.request) {
      const error = /** @type {Error & {code: string, retryable: boolean}} */ (
        new Error('此运行的输入未持久化；请用 manage_card action=start_run 重新提供输入')
      );
      error.code = 'RUN_INPUT_UNAVAILABLE';
      error.retryable = false;
      throw error;
    }
    if (!retryAllowed(source)) {
      throw Object.assign(new Error('仅可重试标记为可重试的失败运行；重试会从头执行，可能重复先前副作用'), {
        code: 'RUN_NOT_RETRYABLE', retryable: false,
      });
    }
    const child = this.runs.find((run) => run.sourceRunId === source.id);
    if (child) return { success: true, run: publicRun(child) };
    const attempt = source.attempt + 1;
    const key = `retry:${source.id}:${attempt}`;
    const request = { ...source.request, idempotency_key: key, attempt, sourceRunId: source.id };
    return { success: true, run: this.createRun(request, key, source) };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('运行进度 listener 必须是函数');
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
}

function createAutomationRunManager(options) { return new AutomationRunManager(options); }

module.exports = { RUNS_FILE_NAME, createAutomationRunManager };
