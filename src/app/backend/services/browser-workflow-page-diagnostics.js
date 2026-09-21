'use strict';

function text(value, maximum = 512) {
  return String(value == null ? '' : value).trim().slice(0, maximum);
}

function event(value) {
  if (!value || typeof value !== 'object') return null;
  const sequence = Number(value.sequence);
  const kind = text(value.kind, 64);
  if (!Number.isInteger(sequence) || sequence < 1 || !kind) return null;
  return {
    sequence,
    kind,
    capturedAt: Number.isFinite(Number(value.capturedAt)) ? Number(value.capturedAt) : 0,
    message: text(value.message), url: text(value.url), source: text(value.source),
    status: Number.isInteger(Number(value.status)) ? Number(value.status) : undefined,
  };
}

async function capturePageDiagnostics(host, connection) {
  try {
    const result = await host.runtimeCommand(connection, 'inspect-page-diagnostics', {});
    if (result?.success === false) return { available: false, error: text(result.error || result.errorCode) };
    const cursor = Number(result?.cursor);
    if (!Number.isInteger(cursor) || cursor < 0) return { available: false };
    return { available: true, cursor, events: (Array.isArray(result.events) ? result.events : []).map(event).filter(Boolean) };
  } catch (error) {
    return { available: false, error: text(error?.message || error) };
  }
}

function pageDiagnosticsDelta(before, after) {
  if (!before?.available || !after?.available) return { available: false, events: [] };
  const events = after.events.filter((entry) => entry.sequence > before.cursor);
  const failures = events.filter((entry) => entry.kind === 'page_error' || entry.kind === 'unhandled_rejection' || entry.kind === 'console_error');
  const requests = events.filter((entry) => entry.kind === 'request_failure');
  const warnings = requests.filter((entry) => /(?:favicon|analytics|telemetry|beacon|\.(?:png|jpg|jpeg|gif|svg|ico)(?:$|[?#]))/i.test(entry.url || ''));
  const blockingRequests = requests.filter((entry) => !warnings.includes(entry));
  return { available: true, events, failures, requests: blockingRequests, warnings, hasFailures: failures.length > 0 || blockingRequests.length > 0 };
}

function diagnosticsSummary(delta) {
  if (!delta?.available) return { status: 'unavailable' };
  const consoleErrors = delta.failures.filter((item) => item.kind === 'console_error').length;
  return { status: delta.hasFailures ? 'failures_detected' : 'clear', pageErrors: delta.failures.filter((item) => item.kind !== 'console_error').length,
    ...(consoleErrors ? { consoleErrors } : {}), failedRequests: delta.requests.length,
    ...((delta.warnings?.length) ? { warnings: delta.warnings.length } : {}) };
}

function diagnosticsFailure(delta) {
  const first = [...delta.failures, ...delta.requests][0];
  const label = first?.kind === 'request_failure' ? '请求失败' : '页面脚本异常';
  return Object.assign(new Error(`${label}：${text(first?.message || first?.url || '页面发生新的运行异常', 180)}`), { errorCode: 'PAGE_RUNTIME_ERRORS' });
}

module.exports = { capturePageDiagnostics, diagnosticsFailure, diagnosticsSummary, pageDiagnosticsDelta };
