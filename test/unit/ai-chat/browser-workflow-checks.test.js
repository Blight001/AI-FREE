'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateProbes, validateChecks, compareChecks } = require('../../../src/app/backend/services/browser-workflow-checks');
const { WorkflowDiagnostics } = require('../../../src/app/backend/services/browser-workflow-diagnostics');

test('workflow checks compare probe values and reject unavailable or unsafe definitions', () => {
  const before = { values: { clipCount: { available: true, value: 2 }, projectName: { available: true, value: 'A' } } };
  const after = { values: { clipCount: { available: true, value: 3 }, projectName: { available: true, value: 'B' } } };
  const result = compareChecks(before, after, [
    { name: 'clipCount', op: 'increases_by', value: 1 },
    { name: 'projectName', op: 'changes' },
  ]);
  assert.equal(result.passed, true);
  assert.equal(validateProbes([{ name: '__proto__', selector: '#x' }]).valid, false);
  assert.equal(validateProbes([{ name: 'x', selector: '#x' }, { name: 'x', selector: '#y' }]).valid, false);
  assert.equal(validateChecks([{ name: 'x', op: 'increases_by', value: '1' }]).valid, false);
  assert.equal(compareChecks(before, {}, [{ name: 'clipCount', op: 'exists' }]).passed, false);
  assert.equal(compareChecks({}, { values: { exportTitle: { available: true, value: 'done' } } }, [{ name: 'exportTitle', op: 'equals', value: 'done' }]).passed, true);
  assert.deepEqual(compareChecks(before, after, []), { status: 'not_configured', checks: [] });
});

test('workflow diagnostics bounds steps, redacts secrets, and separates images', () => {
  const diagnostics = new WorkflowDiagnostics({ maxSteps: 2, maxImageBytes: 100000 });
  const id = diagnostics.record({ metadata: { title: 'test', token: 'hidden' }, action: { text: 'secret' }, before: { dataUrl: 'data:image/png;base64,aGVsbG8=' }, capturedAt: 1 });
  diagnostics.record({ report_id: id, action: { text: 'secret2' }, after: { dataUrl: 'data:image/png;base64,aGVsbG8=' }, capturedAt: 2 });
  diagnostics.record({ report_id: id, capturedAt: 3 });
  const report = diagnostics.get(id, { include_images: true });
  assert.equal(report.steps, undefined, 'default report must stay compact');
  assert.equal(report.last_step.capturedAt, 3);
  assert.equal(report.full_report_available, true);
  const detailed = diagnostics.get(id, { include_details: true });
  assert.equal(detailed.steps.length, 2);
  assert.equal(detailed.metadata.token, undefined);
  assert.equal(detailed.steps.at(-1).action, undefined);
  assert.equal(detailed.steps.at(-1).before?.dataUrl, undefined);
  assert.equal(report.images.length, 2);
  assert.equal(diagnostics.get(id).images, undefined);
  diagnostics.clear(id); assert.equal(diagnostics.get(id), null);
});
