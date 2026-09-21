'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./automation-card-store');

const RUNS_FILE_NAME = 'automation-runs.json';
const ACTIVE = new Set(['pending', 'running']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function now() { return Date.now(); }
function publicRun(run) { const copy = clone(run); delete copy.request; return copy; }
function errorPayload(error) {
  return {
    code: String(error?.errorCode || error?.code || 'AUTOMATION_RUN_FAILED'),
    message: String(error?.message || error || '自动化运行失败'), retryable: error?.retryable === true,
  };
}
function normalizeRun(source = {}) {
  const interrupted = ACTIVE.has(String(source.status || ''));
  return {
    ...source, status: interrupted ? 'failed' : String(source.status || 'failed'),
    error: interrupted ? { code: 'RUN_INTERRUPTED', message: '应用退出导致运行中断', retryable: true } : source.error,
    finishedAt: interrupted ? now() : (source.finishedAt ?? null),
  };
}

class AutomationRunManager {
  constructor(options = {}) {
    this.filePath = path.join(path.resolve(options.dataDir), RUNS_FILE_NAME);
    this.execute = options.execute;
    this.listeners = new Set();
    this.controllers = new Map();
    this.runs = this.readRuns();
  }

  persist(next = this.runs) {
    atomicWrite(this.filePath, { schemaVersion: 1, updatedAt: new Date().toISOString(), runs: next });
  }

  readRuns() {
    if (!fs.existsSync(this.filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8') || '{}');
    const restored = (Array.isArray(parsed.runs) ? parsed.runs : []).map(normalizeRun);
    if (restored.some((run, index) => run.status !== parsed.runs[index]?.status)) this.persist(restored);
    return restored;
  }

  find(id) {
    const run = this.runs.find((item) => item.id === String(id || ''));
    if (!run) throw new Error(`自动化运行不存在: ${id || '(未指定)'}`);
    return run;
  }

  publish(run, event = 'updated') {
    this.persist();
    const payload = { event, run: publicRun(run) };
    for (const listener of this.listeners) { try { listener(payload); } catch (_) {} }
  }

  patch(run, values, event) {
    Object.assign(run, values, { updatedAt: now() });
    this.publish(run, event);
  }

  progress(run, step) {
    if (run.status === 'cancelled') return;
    run.steps.push(clone(step));
    this.patch(run, {
      currentStepId: String(step.stepId || step.stepIndex || ''),
      transitionCount: Number(step.transitionCount || run.transitionCount || 0),
    }, 'progress');
  }

  finish(run, output) {
    const status = output?.success === false ? 'failed' : 'succeeded';
    const error = status === 'failed'
      ? { code: output.errorCode || 'CARD_STEP_FAILED', message: output.error || '卡片步骤失败', retryable: true }
      : null;
    this.patch(run, { status, output, error, finishedAt: now() }, status);
  }

  async perform(run) {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.patch(run, { status: 'running', startedAt: now(), error: null }, 'started');
    const timer = this.timeout(run, controller);
    try {
      const context = { signal: controller.signal, onProgress: (step) => this.progress(run, step) };
      const output = await this.execute(clone(run.request), context);
      if (!TERMINAL.has(run.status)) this.finish(run, output);
    } catch (error) {
      if (!TERMINAL.has(run.status)) this.patch(run, { status: 'failed', error: errorPayload(error), finishedAt: now() }, 'failed');
    } finally { clearTimeout(timer); this.controllers.delete(run.id); }
  }

  timeout(run, controller) {
    const timeoutMs = Math.max(1, Number(run.request.timeoutMs || 900000));
    return setTimeout(() => {
      if (TERMINAL.has(run.status)) return;
      this.patch(run, { status: 'timed_out', error: {
        code: 'RUN_TIMED_OUT', message: '自动化运行超过总超时限制', retryable: true,
      }, finishedAt: now() }, 'timed_out');
      controller.abort();
    }, timeoutMs);
  }

  start(request = {}) {
    const idempotencyKey = String(request.idempotency_key || '').trim();
    const duplicate = idempotencyKey && this.runs.find((item) => item.idempotencyKey === idempotencyKey);
    if (duplicate) return publicRun(duplicate);
    const timestamp = now();
    const run = {
      id: crypto.randomUUID(), cardId: String(request.id || ''), versionId: String(request.version_id || ''),
      connectionId: String(request.connectionId || ''), status: 'pending', currentStepId: '', transitionCount: 0,
      output: null, error: null, steps: [], createdAt: timestamp, updatedAt: timestamp,
      startedAt: null, finishedAt: null, attempt: Number(request.attempt || 1),
      sourceRunId: String(request.sourceRunId || ''), idempotencyKey, request: clone(request),
    };
    this.runs.push(run); this.publish(run, 'created'); queueMicrotask(() => void this.perform(run));
    return publicRun(run);
  }

  list(query = {}) {
    let items = [...this.runs];
    if (query.card_id) items = items.filter((run) => run.cardId === String(query.card_id));
    if (query.status) items = items.filter((run) => run.status === String(query.status));
    const limit = Math.min(500, Math.max(1, Number(query.limit || 100)));
    return { success: true, items: items.slice(-limit).reverse().map(publicRun) };
  }

  get(id) { return { success: true, run: publicRun(this.find(id)) }; }
  steps(id) { return { success: true, items: clone(this.find(id).steps || []) }; }

  cancel(id, reason = 'cancelled by user') {
    const run = this.find(id);
    if (TERMINAL.has(run.status)) return { success: true, run: publicRun(run) };
    this.controllers.get(run.id)?.abort();
    this.patch(run, { status: 'cancelled', error: {
      code: 'RUN_CANCELLED', message: String(reason), retryable: true,
    }, finishedAt: now() }, 'cancelled');
    return { success: true, run: publicRun(run) };
  }

  retry(id) {
    const source = this.find(id);
    if (!TERMINAL.has(source.status)) throw new Error('运行尚未结束，不能重试');
    return { success: true, run: this.start({
      ...source.request, idempotency_key: `retry:${source.id}:${source.attempt + 1}:${crypto.randomUUID()}`,
      attempt: source.attempt + 1, sourceRunId: source.id,
    }) };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('运行进度 listener 必须是函数');
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
}

function createAutomationRunManager(options) { return new AutomationRunManager(options); }

module.exports = { RUNS_FILE_NAME, createAutomationRunManager };
