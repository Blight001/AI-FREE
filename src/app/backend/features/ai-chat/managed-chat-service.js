'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { AppError, wrapIpcResult } = require('../../../contracts/ipc-result');
const { checkChatAction, chatView, chatTranscript, waitForManagedRun } = require('./managed-chat-contract');

const ACTIVE = new Set(['running', 'stopping']);
const MAX_SESSIONS = 128;
const MAX_RUNS = 32;

function requireChat(condition, code, message) {
  if (!condition) throw new AppError(code, message);
}

function visible(session, scope) {
  return session.account === scope.account && (scope.actor === 'sidebar' || session.actor === scope.actor);
}

function fingerprint(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function readCompletion(outcome, control) {
  const content = outcome.message?.content || control.draft;
  if (!content && !outcome.ok) return '模型请求失败，请检查当前模型和额度。';
  return String(content).slice(0, 131072);
}

class ManagedChatService {
  constructor({ repository, getModels, getAccount, run, onChange = (_sessionId, _parentId, _account) => {} }) {
    this.repository = repository;
    this.getModels = getModels;
    this.getAccount = getAccount;
    this.runModel = run;
    this.onChange = onChange;
    /** @type {any[]} */
    this.sessions = null;
    this.controls = new Map();
    this.execute = wrapIpcResult(this.dispatch.bind(this), { fallbackCode: 'CHAT_OPERATION_FAILED' });
  }

  read() {
    if (!this.sessions) {
      const restored = this.repository.read();
      for (const session of restored) {
        if (!session.runs.some((record) => ACTIVE.has(record.status))) continue;
        for (const record of session.runs.filter((record) => ACTIVE.has(record.status))) {
          record.status = record.checkpoint ? 'paused' : 'needs_review';
        }
        this.repository.save(session);
      }
      this.sessions = restored;
    }
    return this.sessions;
  }

  commit(session) {
    const next = this.read().filter((item) => item.id !== session.id);
    next.push(session);
    this.repository.save(session);
    this.sessions = next;
    this.onChange(session.id, session.parentId, session.account);
  }

  lookup(scope, args) {
    const session = this.read().find((item) => visible(item, scope) && (args.run_id
      ? item.runs.some((record) => record.id === args.run_id) : item.id === args.session_id));
    requireChat(session, 'CHAT_NOT_FOUND', '找不到该子会话或运行');
    const record = args.run_id ? session.runs.find((item) => item.id === args.run_id) : session.runs.at(-1);
    return { session, record };
  }

  update(sessionId, runId, patch) {
    const session = this.read().find((item) => item.id === sessionId);
    const runs = session.runs.map((record) => record.id === runId ? { ...record, ...patch } : record);
    this.commit({ ...session, runs });
  }

  async models() {
    const result = await this.getModels();
    requireChat(result?.ok, 'CHAT_MODELS_UNAVAILABLE', '当前无法读取可用模型');
    return { models: result.models.map(({ id, name }) => ({ id, name })), defaultModelId: result.lastModelId || '' };
  }

  async assertModel(modelId) {
    requireChat((await this.models()).models.some((model) => model.id === modelId), 'CHAT_MODEL_UNAVAILABLE', '所选模型当前不可用');
  }

  previousCreation(scope, args, signature) {
    const prior = this.read().find((item) => item.account === scope.account && item.actor === scope.actor && item.key === args.request_key);
    requireChat(!prior || prior.signature === signature, 'CHAT_REQUEST_CONFLICT', '请求键已用于不同的创建参数');
    return prior;
  }

  async create(scope, args) {
    const signature = fingerprint(args.model_id, args.title);
    const existing = this.previousCreation(scope, args, signature);
    if (existing) return chatView(existing);
    await this.assertModel(args.model_id);
    requireChat(this.getAccount() === scope.account, 'CHAT_ACCOUNT_CHANGED', '登录账号已变更');
    const prior = this.previousCreation(scope, args, signature);
    if (prior) return chatView(prior);
    requireChat(this.read().filter((item) => item.account === scope.account).length < MAX_SESSIONS,
      'CHAT_SESSION_LIMIT', '已达到子会话保存上限');
    const session = { id: randomUUID(), account: scope.account, actor: scope.actor, parentId: scope.parentId || '',
      key: args.request_key, signature, title: args.title || '子对话', modelId: args.model_id, runs: [], createdAt: Date.now() };
    this.commit(session);
    return chatView(session);
  }

  assertCapacity(session) {
    const active = this.read().filter((item) => item.account === session.account && ACTIVE.has(item.runs.at(-1)?.status));
    requireChat(active.length < 4 && (!session.parentId || active.filter((item) => item.parentId === session.parentId).length < 2),
      'CHAT_CAPACITY', '当前子任务已达到并行上限');
  }

  async perform(session, record, control) {
    try {
      const result = await this.runModel({
        session, record, signal: control.controller.signal,
        checkpoint: record.checkpoint,
        inserted: control.inserted,
        saveCheckpoint: (checkpoint) => {
          if (this.getAccount() !== session.account) control.controller.abort();
          const current = this.lookup({ account: session.account, actor: session.actor }, { run_id: record.id }).record;
          this.update(session.id, record.id, { checkpoint: { ...checkpoint, insertedCount: current.inserts.length - control.inserted.length } });
        },
        emit: (event) => {
          if (event.type === 'content_delta') control.draft = (control.draft + String(event.delta ?? event.content ?? '')).slice(0, 131072);
          else if (event.type === 'content_replace') control.draft = String(event.content || '').slice(0, 131072);
          else return;
          this.onChange(session.id, session.parentId, session.account);
        },
      });
      const current = this.lookup({ account: session.account, actor: session.actor }, { run_id: record.id }).record;
      const status = result.stopped ? (current.checkpoint ? 'paused' : 'needs_review')
        : result.ok && !result.recoveredFromToolError ? 'completed' : 'failed';
      this.update(session.id, record.id, { status, result: readCompletion(result, control),
        ...(status === 'completed' && { checkpoint: null }) });
    } catch {
      this.update(session.id, record.id, { status: 'needs_review' });
    } finally {
      this.controls.delete(record.id);
    }
  }

  launch(session, record) {
    const inserted = record.inserts.slice(record.checkpoint?.insertedCount || 0).map(({ content }) => ({ role: 'user', content }));
    const control = { controller: new AbortController(), inserted, draft: '', done: Promise.resolve() };
    this.controls.set(record.id, control);
    const timer = setTimeout(() => control.controller.abort(), 20 * 60_000);
    timer.unref();
    control.done = this.perform(session, record, control).finally(() => clearTimeout(timer));
    // Callers can detach before the runner settles. Keep handling storage failures in that case.
    void control.done.catch(() => {});
  }

  async wait(scope, args, signal) {
    const ids = args.run_ids?.length ? args.run_ids : [args.run_id];
    const snapshot = () => ids.map((id) => {
      const { session, record } = this.lookup(scope, { run_id: id });
      return chatView(session, record, this.controls.get(id)?.draft);
    });
    snapshot();
    const tasks = ids.map((id) => this.controls.get(id)?.done).filter(Boolean);
    if (tasks.length) await waitForManagedRun(Promise.all(tasks), args.wait_ms, signal);
    requireChat(this.getAccount() === scope.account, 'CHAT_ACCOUNT_CHANGED', '登录账号已变更');
    const results = snapshot();
    return args.run_ids?.length ? { runs: results } : results[0];
  }

  async send(scope, args, signal) {
    const { session, record: latest } = this.lookup(scope, args);
    const previous = session.runs.find((item) => item.key === args.request_key);
    if (previous) {
      requireChat(previous.content === args.content, 'CHAT_REQUEST_CONFLICT', '请求键已用于不同的消息');
      return this.wait(scope, { ...args, run_id: previous.id }, signal);
    }
    requireChat(!signal?.aborted, 'CHAT_WAIT_CANCELLED', '调用已断开，消息尚未提交');
    requireChat(!latest || !ACTIVE.has(latest.status) && latest.status !== 'paused', 'CHAT_BUSY', '该子会话有未结束的运行');
    requireChat(session.runs.length < MAX_RUNS, 'CHAT_RUN_LIMIT', '该子会话已达到运行保存上限');
    this.assertCapacity(session);
    const record = { id: randomUUID(), key: args.request_key, content: args.content, modelId: session.modelId,
      status: 'running', result: '', inserts: [], checkpoint: null };
    const updated = { ...session, runs: [...session.runs, record] };
    this.commit(updated);
    this.launch(updated, record);
    return this.wait(scope, { ...args, run_id: record.id }, signal);
  }

  async controlRun(scope, args, signal) {
    const { session, record } = this.lookup(scope, args);
    requireChat(record, 'CHAT_NOT_FOUND', '找不到该运行');
    const control = this.controls.get(record.id);
    if (args.action === 'insert') {
      const prior = record.inserts.find((item) => item.key === args.request_key);
      requireChat(!prior || prior.content === args.content, 'CHAT_REQUEST_CONFLICT', '请求键已用于不同的插话');
      if (prior) return chatView(session, record, control?.draft);
      requireChat(control && record.status === 'running', 'CHAT_NOT_RUNNING', '当前回复已停止');
      requireChat(record.inserts.length < 16, 'CHAT_INSERT_LIMIT', '该轮已达到插话上限');
      this.update(session.id, record.id, { inserts: [...record.inserts, { key: args.request_key, content: args.content }] });
      control.inserted.push({ role: 'user', content: args.content });
    } else if (args.action === 'stop' && record.status === 'running') {
      this.update(session.id, record.id, { status: 'stopping' });
      control?.controller.abort();
    } else if (args.action === 'resume' && record.status !== 'running') {
      requireChat(record.status === 'paused' && record.checkpoint, 'CHAT_RESUME_UNAVAILABLE', '当前运行无法继续');
      requireChat(record === session.runs.at(-1), 'CHAT_RESUME_UNAVAILABLE', '仅可继续子会话最近一轮');
      this.assertCapacity(session);
      this.update(session.id, record.id, { status: 'running' });
      this.launch(session, { ...record, status: 'running' });
    }
    return this.wait(scope, { ...args, run_id: record.id, wait_ms: args.action === 'insert' ? 0 : args.wait_ms }, signal);
  }

  list(scope, args) {
    const sessions = this.read().filter((item) => visible(item, scope)
      && (args.parent_id === undefined || item.parentId === args.parent_id));
    return { sessions: sessions.map((item) => ({ ...chatView(item), result: undefined })) };
  }

  status(scope, args) {
    const { session, record } = this.lookup(scope, args);
    const draft = this.controls.get(record?.id)?.draft;
    const view = chatView(session, record, draft);
    return scope.actor === 'sidebar' ? { ...view, messages: chatTranscript(session, record, draft) } : view;
  }

  async select_model(scope, args) {
    await this.assertModel(args.model_id);
    requireChat(this.getAccount() === scope.account, 'CHAT_ACCOUNT_CHANGED', '登录账号已变更');
    const { session, record } = this.lookup(scope, args);
    requireChat(!ACTIVE.has(record?.status) && record?.status !== 'paused', 'CHAT_BUSY', '运行结束后可切换模型');
    const updated = { ...session, modelId: args.model_id };
    this.commit(updated);
    return chatView(updated);
  }

  dispose() {
    for (const control of this.controls.values()) control.controller.abort();
  }

  dispatch(caller, input, signal = undefined) {
    const args = checkChatAction(input, caller?.actor === 'sidebar');
    const account = this.getAccount();
    requireChat(account && caller?.actor, 'CHAT_SIGN_IN_REQUIRED', '请先登录并授权对话控制');
    const operation = ['insert', 'stop', 'resume'].includes(args.action) ? this.controlRun : this[args.action];
    return operation.call(this, { ...caller, account }, args, signal);
  }
}

function createManagedChatService(options) {
  return new ManagedChatService(options);
}

module.exports = { createManagedChatService };
