'use strict';

const { validateProbes, validateChecks, compareChecks } = require('./browser-workflow-checks');
const { refreshTarget, wait } = require('./browser-workflow-target');
const {
  capturePageDiagnostics, diagnosticsFailure, diagnosticsSummary, pageDiagnosticsDelta,
} = require('./browser-workflow-page-diagnostics');

function configuration(args, session) {
  const inherit = args.inherit_config === true;
  const probes = args.probes ?? (inherit ? session.probes : []);
  const checks = [...(args.expect ?? (inherit ? session.expect || [] : []))];
  const identity = args.identity_probe ?? (inherit ? session.identityProbe : '');
  if (identity && !checks.some((check) => check.name === identity && check.op === 'unchanged')) checks.push({ name: identity, op: 'unchanged' });
  for (const validation of [validateProbes(probes), validateChecks(checks)]) {
    if (!validation.valid) throw new Error(validation.error);
  }
  for (const check of checks) {
    if (!probes.some((probe) => probe.name === check.name)) throw new Error(`检查缺少 probe：${check.name}`);
  }
  return { probes, checks, identity };
}

async function cacheLightEvidence(host, connection, before, debug) {
  if (debug) return;
  try {
    const screenshot = await host.runtimeCommand(connection, 'capture-screenshot', { x: 0, y: 0, width: 480, height: 270 });
    if (screenshot.success !== false && screenshot.dataUrl) {
      before.lightEvidence = { dataUrl: screenshot.dataUrl, width: screenshot.width, height: screenshot.height, kind: 'pre_failure_light_cache' };
    }
  } catch (_) { /* Diagnostics must never block an automation step. */ }
}

function promoteLightEvidence(before, failed) {
  if (!failed || before?.dataUrl || !before?.lightEvidence?.dataUrl) return;
  before.dataUrl = before.lightEvidence.dataUrl;
  before.screenshot = { width: before.lightEvidence.width, height: before.lightEvidence.height, kind: before.lightEvidence.kind };
}

async function snapshot(host, connection, probes, debug, options = {}, recordRefs = true) {
  const pageDiagnostics = await capturePageDiagnostics(host, connection);
  const state = await host.runtimeCommand(connection, 'inspect-page-state', { probes });
  if (state.success === false) throw Object.assign(new Error(state.error || '页面状态读取失败'), { errorCode: state.errorCode });
  const observed = await host.browserObserve(connection, {
    ...options, limit: debug ? 300 : 50, mark: false,
    include_accessibility_tree: debug || options.include_accessibility_tree === true,
    include_screenshot: debug || options.include_screenshot === true,
  }, recordRefs);
  if (observed.success === false) throw Object.assign(new Error(observed.error || '页面观察失败'), { errorCode: observed.errorCode });
  return { ...observed, ...state, pageDiagnostics, capturedAt: Date.now() };
}

async function verifyState(host, connection, before, config, deadline, session) {
  let after;
  let difference;
  do {
    after = await host.runtimeCommand(connection, 'inspect-page-state', { probes: config.probes });
    difference = compareChecks(before, after, config.checks);
    if (difference.passed || session.pauseRequested || Date.now() >= deadline) break;
    await wait(Math.min(150, Math.max(0, deadline - Date.now())));
  } while (true);
  return { after, difference };
}

function stabilitySignature(observation) {
  return JSON.stringify({
    url: observation?.url,
    count: observation?.returnedCount ?? observation?.items?.length,
    layout: observation?.layoutChanged,
  });
}

async function waitForStablePage(host, connection, deadline) {
  let previous;
  while (Date.now() < deadline) {
    const current = await host.browserObserve(connection, { limit: 40, mark: false, include_accessibility_tree: false, include_screenshot: false });
    if (current?.success === false) return current;
    const signature = stabilitySignature(current);
    if (current?.returnedCount === undefined && current?.layoutChanged === undefined) return current;
    if (signature === previous && current?.layoutChanged !== true) return current;
    previous = signature;
    await wait(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  return { success: false, errorCode: 'PAGE_STABILITY_TIMEOUT', error: '页面在限定时间内未达到稳定状态' };
}

function errorResult(error, executed) {
  return { success: false, errorCode: error.errorCode || 'WORKFLOW_STEP_FAILED',
    error: error.message, actionExecuted: executed, retryable: false };
}

function classifyDiagnostics(events, available = true) {
  const failures = events.filter((entry) => ['page_error', 'unhandled_rejection', 'console_error'].includes(entry.kind));
  const requests = events.filter((entry) => entry.kind === 'request_failure');
  const warnings = requests.filter((entry) => /(?:favicon|analytics|telemetry|beacon|\.(?:png|jpg|jpeg|gif|svg|ico)(?:$|[?#]))/i.test(entry.url || ''));
  const blockingRequests = requests.filter((entry) => !warnings.includes(entry));
  return { available, events, failures, requests: blockingRequests, warnings, hasFailures: failures.length > 0 || blockingRequests.length > 0 };
}

function remainingDeadline(session, started, args) {
  return Math.min(session.deadline || Infinity,
    started + Math.min(30000, Math.max(0, Number(args.timeout_ms ?? 5000))));
}

function requireIdentity(before, config, session) {
  if (config.identity && before.values?.[config.identity]?.available !== true) throw new Error('当前项目身份不可用，已暂停操作');
  if (!config.identity) return;
  const identity = before.values[config.identity].value;
  if (session.identityAnchor !== undefined && session.identityAnchor !== identity) {
    throw Object.assign(new Error('当前项目已切换，已暂停操作'), { errorCode: 'PROJECT_CHANGED' });
  }
  session.identityAnchor = identity;
}

async function finalSnapshot(host, connection, config, session, after, args) {
  try { return await snapshot(host, connection, config.probes, session.mode === 'debug', args.observation_options); }
  catch (error) { return { ...after, snapshotError: error.message }; }
}

async function prepareStep(host, connection, session, tool, args, config) {
  const resolved = tool === 'browser_action' ? await refreshTarget(host, connection, args) : { input: args };
  // Pre-action diagnostics must not expire the caller's observation before dispatch.
  const before = await snapshot(host, connection, config.probes, session.mode === 'debug', undefined, false);
  await cacheLightEvidence(host, connection, before, session.mode === 'debug');
  requireIdentity(before, config, session);
  if (resolved.failure) return { before, result: resolved.failure, executed: false };
  if (session.pauseRequested) return { before, result: errorResult(new Error('流程已暂停'), false), executed: false };
  return { before, input: resolved.input };
}

async function executeStep(host, connection, session, prepared, config, deadline, invoke, args) {
  if (prepared.result) return prepared;
  /** @type {boolean|string} */
  let executed = 'unknown';
  let result;
  try { result = await invoke(prepared.input); }
  catch (error) { return { ...prepared, result: errorResult(error, executed), executed }; }
  let after;
  let difference;
  executed = result.success === false ? (result.actionExecuted ?? 'unknown') : true;
  if (result.success !== false) {
    if (args.wait_for_stable !== false && Number(args.timeout_ms ?? 5000) > 0) {
      session.status = 'waiting';
      const stable = await waitForStablePage(host, connection, Math.min(deadline, Date.now() + 3000));
      if (stable?.success === false) { session.status = 'running'; return { ...prepared, result: errorResult(Object.assign(new Error(stable.error), { errorCode: stable.errorCode }), executed), executed }; }
      session.status = 'running';
    }
    ({ after, difference } = await verifyState(host, connection, prepared.before, config, deadline, session));
    if (config.checks.length && !difference.passed) result = { ...result, success: false, errorCode: 'BUSINESS_STATE_MISMATCH', error: difference.summary };
  }
  return { ...prepared, result, executed, after, difference };
}

function readStepDiagnostics(session, before, after) {
  let pageDiagnostics = pageDiagnosticsDelta(before?.pageDiagnostics, after?.pageDiagnostics);
  if (before?.pageDiagnostics?.available) {
    const cursor = session.pageDiagnosticsCursor || 0;
    const between = before.pageDiagnostics.events.filter((entry) => entry.sequence > cursor);
    if (between.length) {
      const merged = [...new Map([...between, ...(pageDiagnostics.events || [])].map((entry) => [entry.sequence, entry])).values()]
        .sort((a, b) => a.sequence - b.sequence);
      pageDiagnostics = classifyDiagnostics(merged);
    }
  }
  for (const snapshot of [before, after]) {
    const diagnostics = snapshot?.pageDiagnostics;
    if (diagnostics?.available) session.pageDiagnosticsCursor = Math.max(session.pageDiagnosticsCursor || 0, diagnostics.cursor || 0);
  }
  return pageDiagnostics;
}

function stepStatus(result, executed, diagnostics, config, difference, pageChanged) {
  if (result.success === false) {
    if (executed === 'unknown') return 'unknown';
    return diagnostics.hasFailures ? 'business_failed' : 'pending';
  }
  if (config.checks.length) return difference?.passed ? 'business_verified' : 'business_failed';
  return pageChanged ? 'page_changed' : 'action_dispatched';
}

function stepOutcome({ before, after, result, executed, config, difference, pageDiagnostics, reportId, args, mode }) {
  const located = executed !== false;
  const pageChanged = Boolean(before?.url !== after?.url || JSON.stringify(before?.values || {}) !== JSON.stringify(after?.values || {}));
  const status = stepStatus(result, executed, pageDiagnostics, config, difference, pageChanged);
  return { ...result, retryable: false, actionExecuted: executed, report_id: reportId, mode,
    observationSuccess: !after.snapshotError,
    status, located, pageChanged,
    businessVerification: config.checks.length ? difference : { status: 'not_configured' },
    pageDiagnostics: diagnosticsSummary(pageDiagnostics),
    effective_configuration: config,
    ...(args.after === 'observe' ? { observation: after } : {}) };
}

async function performStep(host, connection, session, tool, args, invoke) {
  const config = configuration(args, session);
  const started = Date.now();
  const deadline = remainingDeadline(session, started, args);
  let before; let after; let result; let difference;
  /** @type {boolean|string} */
  let executed = false;
  try {
    const prepared = await prepareStep(host, connection, session, tool, args, config);
    ({ before, result, executed, after, difference } = await executeStep(host, connection, session, prepared, config, deadline, invoke, args));
  } catch (error) { result = errorResult(error, executed); }
  let failed = result.success === false;
  promoteLightEvidence(before, failed);
  if (failed) session.mode = 'debug';
  after = await finalSnapshot(host, connection, config, session, after, args);
  let pageDiagnostics = readStepDiagnostics(session, before, after);
  if (!failed && pageDiagnostics.hasFailures) {
    failed = true;
    promoteLightEvidence(before, true);
    session.mode = 'debug';
    after = await finalSnapshot(host, connection, config, session, after, args);
    const followUp = pageDiagnosticsDelta(before?.pageDiagnostics, after?.pageDiagnostics);
    const mergedEvents = [...new Map([...(pageDiagnostics.events || []), ...(followUp.events || [])].map((entry) => [entry.sequence, entry])).values()]
      .sort((a, b) => a.sequence - b.sequence);
    pageDiagnostics = classifyDiagnostics(mergedEvents, pageDiagnostics.available || followUp.available);
    result = errorResult(diagnosticsFailure(pageDiagnostics), executed);
  }
  if (pageDiagnostics.available) {
    pageDiagnostics.events = pageDiagnostics.events.map((entry) => ({
      ...entry, runId: session.runId, stepIndex: session.currentStep, tool,
    }));
  }
  const reportId = session.diagnostics.record({
    before, after, difference, actionExecuted: executed, durationMs: Date.now() - started,
    businessVerification: config.checks.length ? difference : { status: 'not_configured' },
    pageDiagnostics,
    metadata: { tool, action: args.action, mode: session.mode, effective_configuration: config,
      pre_failure_evidence: before?.dataUrl ? 'available' : 'unavailable' }, capturedAt: started,
    errorCode: result.errorCode, reason: result.error || result.reason,
  });
  session.lastReportId = reportId;
  session.lastStep = { before, config, actionExecuted: executed, args, tool, result };
  return stepOutcome({ before, after, result, executed, config, difference, pageDiagnostics, reportId, args, mode: session.mode });
}

module.exports = { performStep, verifyState, configuration };
