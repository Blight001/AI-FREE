'use strict';

const { randomUUID } = require('node:crypto');
const forbidden = /^(action|password|token|cookie|cookies|secret|authorization|__proto__|prototype|constructor)$/i;
function safe(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 1024);
  if (Array.isArray(value)) return value.slice(0, 4000).map((item) => safe(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value).slice(0, 128).filter(([key]) => !forbidden.test(key) && key !== 'dataUrl');
  const password = value.inputType === 'password' || value.type === 'password';
  return Object.fromEntries(entries.filter(([key]) => !password || !['value', 'text'].includes(key))
    .map(([key, item]) => [key, safe(item, depth + 1)]));
}
function bounded(value, fallback, max) { return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback; }
function snapshots(entry) {
  return ['before', 'after'].map((label) => ({ label, dataUrl: entry[label]?.dataUrl }))
    .filter((image) => typeof image.dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(image.dataUrl));
}
function snapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { available: false };
  return {
    available: true,
    url: safe(snapshot.url), title: safe(snapshot.title), capturedAt: snapshot.capturedAt,
    values: safe(snapshot.values), itemCount: Array.isArray(snapshot.items) ? snapshot.items.length : undefined,
    accessibilityNodeCount: Array.isArray(snapshot.accessibilityTree?.nodes) ? snapshot.accessibilityTree.nodes.length : undefined,
    screenshot: (typeof snapshot.dataUrl === 'string' || snapshot.screenshot)
      ? safe(snapshot.screenshot || { kind: 'snapshot' }) : undefined,
    snapshotError: safe(snapshot.snapshotError),
  };
}
function stepSummary(step) {
  return {
    capturedAt: step.capturedAt, durationMs: step.durationMs, actionExecuted: step.actionExecuted,
    errorCode: step.errorCode, reason: step.reason, difference: step.businessVerification || (step.metadata?.effective_configuration?.checks?.length ? safe(step.difference) : { status: 'not_configured' }),
    metadata: safe(step.metadata), before: snapshotSummary(step.before), after: snapshotSummary(step.after),
  };
}
class WorkflowDiagnostics {
  constructor({ maxSteps = 20, maxImageBytes = 16 * 1024 * 1024 } = {}) {
    this.maxSteps = Math.max(1, bounded(maxSteps, 20, 20));
    this.maxImageBytes = bounded(maxImageBytes, 16 * 1024 * 1024, 16 * 1024 * 1024);
    this.reports = new Map();
  }
  record(entry) {
    const id = entry.report_id || randomUUID();
    const report = this.reports.get(id) || { report_id: id, metadata: safe(entry.metadata || {}), steps: [], images: [] };
    report.steps.push(safe(entry));
    report.images.push(...snapshots(entry));
    report.steps = report.steps.slice(-this.maxSteps);
    this.reports.set(id, report);
    this.trim();
    return id;
  }
  trim() {
    const reports = () => [...this.reports.values()];
    while (reports().reduce((sum, report) => sum + report.steps.length, 0) > this.maxSteps) {
      this.reports.delete(this.reports.keys().next().value);
    }
    let bytes = reports().reduce((sum, report) => sum + report.images.reduce((size, image) => size + Buffer.byteLength(image.dataUrl), 0), 0);
    for (const report of this.reports.values()) {
      while (report.images.length && bytes > this.maxImageBytes) bytes -= Buffer.byteLength(report.images.shift().dataUrl);
    }
  }
  get(id, { include_images = false, include_details = false } = {}) {
    const report = this.reports.get(id);
    if (!report) return null;
    const last = report.steps.at(-1);
    const summary = {
      report_id: report.report_id, metadata: safe(report.metadata), step_count: report.steps.length,
      last_step: stepSummary(last), full_report_available: true,
    };
    if (include_details) summary.steps = structuredClone(report.steps);
    if (include_images) summary.images = structuredClone(report.images);
    return summary;
  }
  list() { return [...this.reports.values()].map((report) => ({ report_id: report.report_id, steps: report.steps.length, createdAt: report.steps[0]?.capturedAt, last_step: stepSummary(report.steps.at(-1)) })); }
  clear(id) { if (id) this.reports.delete(id); else this.reports.clear(); }
}
module.exports = { WorkflowDiagnostics };
