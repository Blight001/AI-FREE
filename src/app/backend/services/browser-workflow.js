'use strict';

const { randomUUID } = require('crypto');
const { runCard } = require('./native-automation-card-service');
const { WorkflowDiagnostics } = require('./browser-workflow-diagnostics');
const { performStep, verifyState, configuration } = require('./browser-workflow-step');

const failure = (errorCode, error) => ({ success: false, errorCode, error });
const TOOLS = new Set(['browser_action', 'browser_tab', 'browser_wait']);

class BrowserWorkflow {
  constructor(host) { this.host = host; this.sessions = new Map(); }

  session(connection) {
    let state = this.sessions.get(connection.id);
    if (state?.pid !== connection.browserProcessId) {
      state?.diagnostics.clear();
      state = { pid: connection.browserProcessId, mode: 'automation', preferredMode: 'automation', status: 'idle', probes: [],
        identityProbe: '', diagnostics: new WorkflowDiagnostics(), busy: false, currentStep: 0,
        flowDiagnostics: { pageErrors: 0, failedRequests: 0, consoleErrors: 0, events: [] } };
      this.sessions.set(connection.id, state);
    }
    return state;
  }

  prune(connections) {
    const active = new Set(connections.map((connection) => connection.id));
    for (const [id, state] of this.sessions) {
      if (active.has(id)) continue;
      state.pauseRequested = true; state.diagnostics.clear(); this.sessions.delete(id);
    }
  }

  status(state) {
    return { success: true, mode: state.mode, status: state.status, runId: state.runId,
      currentStep: state.currentStep, failedStep: state.failedStep,
      lastReportId: state.lastReportId, reason: state.reason,
      reportCount: state.diagnostics.list().length,
      flowDiagnostics: { pageErrors: state.flowDiagnostics?.pageErrors || 0, failedRequests: state.flowDiagnostics?.failedRequests || 0,
        consoleErrors: state.flowDiagnostics?.consoleErrors || 0 } };
  }

  blocked(connection, tool, args) {
    const state = this.session(connection);
    if (!state.busy) return null;
    if (['browser_workflow', 'browser_observe', 'browser_screenshot'].includes(tool)) return null;
    if (tool === 'browser_control' && args.action === 'status') return null;
    if (tool === 'browser_tab' && args.action === 'list') return null;
    return failure('WORKFLOW_BUSY', '当前流程正在执行，请先暂停并等待当前步骤结束');
  }

  async action(connection, args) {
    const state = this.session(connection);
    if (state.busy) return failure('WORKFLOW_BUSY', '当前浏览器正在执行流程');
    if (state.steps && state.status === 'paused') return failure('WORKFLOW_PAUSED', '流程已暂停，请接管页面后恢复，或取消流程');
    state.busy = true; state.pauseRequested = false; state.cancelRequested = false; state.deadline = undefined;
    state.status = 'running'; state.steps = null; state.identityAnchor = undefined;
    try {
      const result = await performStep(this.host, connection, state, 'browser_action', args,
        (input) => this.host.browserActionRaw(connection, { ...input, after: 'none' }));
      state.status = result.success ? 'completed' : 'paused';
      return result;
    } catch (error) {
      state.status = 'paused';
      return failure('INVALID_WORKFLOW_CONFIG', error.message);
    } finally {
      state.busy = false;
      if (state.pauseRequested) {
        state.status = state.cancelRequested ? 'cancelled' : 'paused';
        await this.host.browserControl(connection, { action: 'release' }).catch(() => {});
      }
    }
  }

  async control(connection, args) {
    const state = this.session(connection);
    const action = args.action || 'status';
    if (action === 'status') return this.statusWithHistory(state, args);
    if (action === 'report') return { ...this.statusWithHistory(state, args), ...state.diagnostics.get(args.report_id || state.lastReportId, args) };
    if (action === 'pause' || action === 'cancel') return this.pause(connection, state, action);
    if (state.busy) return failure('WORKFLOW_BUSY', '当前步骤尚未结束');
    if (action === 'set_mode') return this.configure(state, args);
    if (action === 'run') return this.start(connection, state, args);
    if (action === 'resume') return this.resume(connection, state);
    return failure('INVALID_WORKFLOW_ACTION', '未知流程操作');
  }

  configure(state, args) {
    if (!['automation', 'debug'].includes(args.mode)) return failure('INVALID_WORKFLOW_MODE', 'mode 必须为 automation 或 debug');
    try { configuration(args, state); } catch (error) { return failure('INVALID_WORKFLOW_CONFIG', error.message); }
    state.mode = args.mode;
    state.preferredMode = args.mode;
    if (args.probes) state.probes = structuredClone(args.probes);
    if (args.expect) state.expect = structuredClone(args.expect);
    if (args.identity_probe !== undefined) state.identityProbe = args.identity_probe;
    return this.status(state);
  }

  statusWithHistory(state, args) {
    const status = this.status(state);
    if (args.include_history === true) status.reports = state.diagnostics.list().map((report) => ({ ...report, id: report.report_id }));
    return status;
  }

  async pause(connection, state, action) {
    state.pauseRequested = true;
    state.cancelRequested = action === 'cancel';
    if (!state.busy) {
      state.status = state.cancelRequested ? 'cancelled' : 'paused';
      await this.host.browserControl(connection, { action: 'release' });
    }
    return { ...this.status(state), pausePending: state.busy };
  }

  async start(connection, state, args) {
    if (args.mode) {
      const configured = this.configure(state, args);
      if (!configured.success) return configured;
    }
    if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 50) return failure('INVALID_WORKFLOW_STEPS', 'steps 需要 1-50 步');
    if (state.status === 'paused') return failure('WORKFLOW_PAUSED', '请先恢复或取消已暂停流程');
    for (const step of args.steps) {
      if (!TOOLS.has(step.tool)) return failure('INVALID_WORKFLOW_TOOL', '流程步骤只支持 browser_action/browser_tab/browser_wait');
      try { configuration({ ...args, ...step.arguments }, state); } catch (error) { return failure('INVALID_WORKFLOW_CONFIG', error.message); }
    }
    state.steps = structuredClone(args.steps);
    state.defaults = this.flowDefaults(args, state);
    state.runId = randomUUID(); state.currentStep = 1; state.failedStep = undefined; state.lastStep = null; state.identityAnchor = undefined;
    state.flowDiagnostics = { pageErrors: 0, failedRequests: 0, consoleErrors: 0, events: [] };
    state.pageDiagnosticsCursor = 0;
    state.timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeout_ms) || 120000));
    return this.run(connection, state, 1);
  }

  flowDefaults(args, state) {
    const inherit = args.inherit_config === true;
    return {
      probes: args.probes ?? (inherit ? state.probes : []),
      expect: args.expect ?? (inherit ? state.expect || [] : []),
      identity_probe: args.identity_probe ?? (inherit ? state.identityProbe : ''),
      inherit_config: false,
    };
  }

  async resume(connection, state) {
    if (state.status !== 'paused' || !state.steps) return failure('WORKFLOW_NOT_PAUSED', '没有可恢复的流程');
    const previous = state.lastStep;
    let start = state.failedStep || state.currentStep;
    if (previous && previous.actionExecuted !== false) {
      if (!previous.config.checks.length) return failure('WORKFLOW_OUTCOME_UNKNOWN', '当前步骤已发送，但缺少可核验条件；请取消后重新建立流程');
      const verified = await verifyState(this.host, connection, previous.before, previous.config, Date.now() + 3000, { pauseRequested: false });
      if (!verified.difference.passed) return { ...failure('BUSINESS_STATE_MISMATCH', '接管后状态仍未满足预期'), difference: verified.difference };
      start += 1;
    }
    state.mode = state.preferredMode;
    return this.run(connection, state, start);
  }

  async run(connection, state, start) {
    state.busy = true; state.pauseRequested = false; state.cancelRequested = false;
    state.status = 'running'; state.deadline = Date.now() + state.timeoutMs;
    const card = { name: 'browser_workflow', steps: state.steps.map((step) => ({
      type: 'mcp', name: step.name, tool: step.tool, arguments: step.arguments || {},
    })) };
    try {
      const result = start > card.steps.length ? { success: true } : await runCard(card, { start_step: start },
        (tool, args) => this.runStep(connection, state, tool, args), {
          onProgress: (event) => { state.currentStep = event.stepIndex; },
        });
      state.status = state.cancelRequested ? 'cancelled' : result.success ? 'completed' : 'paused';
      state.failedStep = result.success ? undefined : result.stepIndex;
      state.reason = result.error;
      return { ...result, ...this.status(state), success: result.success && !state.cancelRequested,
        effective_configuration: state.lastStep?.config || configuration(state.defaults, state) };
    } catch (error) {
      state.status = 'paused'; state.reason = error.message;
      return { ...this.status(state), ...failure('WORKFLOW_FAILED', error.message) };
    } finally {
      state.busy = false;
      if (state.cancelRequested) state.status = 'cancelled';
      await this.host.browserControl(connection, { action: 'release' }).catch(() => {});
    }
  }

  async runStep(connection, state, tool, args) {
    if (state.pauseRequested || Date.now() >= state.deadline) {
      state.lastStep = null;
      return failure('WORKFLOW_PAUSED', '流程已暂停或达到运行时限');
    }
    const acquired = await this.host.browserControl(connection, { action: 'acquire' });
    if (acquired.success === false) return acquired;
    const result = await performStep(this.host, connection, state, tool, { ...state.defaults, ...args }, (input) => {
      if (tool === 'browser_action') return this.host.browserActionRaw(connection, { ...input, after: 'none' });
      return this.host.dispatchBasicTool(connection, tool, input);
    });
    const diagnostics = result.pageDiagnostics;
    if (diagnostics?.available) {
      state.flowDiagnostics.pageErrors += diagnostics.pageErrors || 0;
      state.flowDiagnostics.failedRequests += diagnostics.failedRequests || 0;
      state.flowDiagnostics.consoleErrors += diagnostics.consoleErrors || 0;
      const events = (diagnostics.events || []).slice(-32);
      state.flowDiagnostics.events = [...new Map([...state.flowDiagnostics.events, ...events]
        .map((event) => [event.sequence, event])).values()].slice(-128);
      result.flowDiagnostics = { pageErrors: state.flowDiagnostics.pageErrors, failedRequests: state.flowDiagnostics.failedRequests,
        consoleErrors: state.flowDiagnostics.consoleErrors };
    }
    return result;
  }
}

module.exports = { BrowserWorkflow };
