'use strict';

const flowReportPrefix = 'VERIFICATION_FLOW_RESULT ';
const statusValues = new Set(['passed', 'failed', 'cancelled']);
const identifier = /^[a-z][a-zA-Z0-9-]{0,79}$/;
const counter = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum;

function summarizeFlow(result) {
  const steps = result.data.steps;
  const assertions = (evidence) => steps.filter((step) => step.status === 'passed' && step.evidence === evidence)
    .reduce((sum, step) => sum + step.assertionCount, 0);
  return {
    schemaVersion: 1, id: result.data.id, status: result.data.status,
    passedSteps: steps.filter((step) => step.status === 'passed').length,
    actionAssertions: assertions('action'), observationAssertions: assertions('observation'),
    oracleAssertions: assertions('oracle'),
    failedStep: steps.find((step) => step.status === 'failed')?.id,
  };
}

function parseFlowReport(line) {
  if (!line.startsWith(flowReportPrefix)) return null;
  try {
    const report = JSON.parse(line.slice(flowReportPrefix.length));
    if (report.schemaVersion !== 1 || !identifier.test(report.id) || !statusValues.has(report.status)) return null;
    if (!counter(report.passedSteps, 200)) return null;
    for (const key of ['actionAssertions', 'observationAssertions', 'oracleAssertions']) {
      if (!counter(report[key], 6400)) return null;
    }
    if (report.failedStep !== undefined && !identifier.test(report.failedStep)) return null;
    // Return only schema fields; never forward arbitrary fixture output.
    return { schemaVersion: 1, id: report.id, status: report.status, passedSteps: report.passedSteps,
      actionAssertions: report.actionAssertions, observationAssertions: report.observationAssertions,
      oracleAssertions: report.oracleAssertions, failedStep: report.failedStep };
  } catch (_) { return null; }
}

function emitFlowReport(result) {
  process.stdout.write(flowReportPrefix + JSON.stringify(summarizeFlow(result)) + '\n');
}

module.exports = { flowReportPrefix, parseFlowReport, emitFlowReport };
