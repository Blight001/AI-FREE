'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { projectRoot, suites, verificationPlan, unmetRequirement, unmetDependency } = require('./catalog');
const { executeStep, verificationEnv } = require('./process');
const { interactions } = require('./interactions');
const { resolvePlan, snapshotScenario } = require('./plans');
const { domainContract } = require('../../test/helpers/flows/domains');

function acquireLease(root) {
  const key = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 20);
  const file = path.join(os.tmpdir(), `ai-free-verification-${key}.lock`);
  try {
    const descriptor = fs.openSync(file, 'wx');
    fs.writeFileSync(descriptor, String(process.pid));
    fs.closeSync(descriptor);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`VERIFICATION_BUSY: ${file}; 检查锁中 PID，确认已退出后再清理`);
    throw error;
  }
  return () => fs.unlinkSync(file);
}

function listVerification() {
  return { ok: true, data: { suites: Object.fromEntries(Object.keys(suites).map((suite) => [suite,
    verificationPlan(suite).map(({ id, description, timeoutMs }) => ({ id, description, timeoutMs })),
  ])), interactions,
  domains: Object.fromEntries([...new Set(interactions.map((entry) => entry.domain).filter(Boolean))]
    .map((id) => [id, domainContract(id)])), limits: [
    'full 不构建 Chromium 或安装包，也不执行安装后账户/公网操作',
    'packaged 只检查已有产物；补丁重放不证明当前二进制与补丁一致',
    '测试跳过标记 incomplete；未覆盖功能不能据此认定通过',
  ] } };
}

function sourceIdentity() {
  const git = (...args) => execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return { commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) };
}

async function executePlannedCheck(entry, results, temporary, options) {
  if (options.signal?.aborted) return { id: entry.id, status: 'cancelled' };
  const reason = unmetDependency(entry, results) || unmetRequirement(entry);
  if (reason) return { id: entry.id, status: 'blocked', reason };
  let command = entry;
  if (entry.scenario) {
    const file = path.join(temporary, `${entry.id}.json`);
    fs.writeFileSync(file, JSON.stringify(entry.scenario));
    command = { ...entry, args: [...entry.args, '--scenario', file] };
  }
  return executeStep(command, {
    root: projectRoot, env: verificationEnv(temporary), signal: options.signal,
  });
}

function cleanupVerification(temporary, report) {
  if (!temporary) return;
  if (report.cleanupOk) {
    try { fs.rmSync(temporary, { recursive: true, force: true }); }
    catch (_) { report.cleanupOk = false; }
  }
  if (!report.cleanupOk) report.retainedTemporaryDirectory = temporary;
}

async function runVerification(suite, options = {}) {
  const plan = verificationPlan(suite, options);
  return executePlan(suite, plan.map(snapshotScenario), options);
}

async function runVerificationFlow(flow, options = {}) {
  const plan = resolvePlan(flow, options.baseDirectory);
  return executePlan(flow.id, plan, options);
}

function describePlan(plan) {
  return plan.map((entry) => ({ id: entry.id, timeoutMs: entry.timeoutMs,
    domain: entry.interaction?.domain,
    runtime: entry.interaction?.runtime,
    oracleRequired: entry.interaction?.domain ? domainContract(entry.interaction.domain).requireOracle : false,
    scenarioHash: entry.scenario ? crypto.createHash('sha256').update(JSON.stringify(entry.scenario)).digest('hex') : undefined,
  }));
}

function planVerificationFlow(flow, options = {}) {
  return { ok: true, data: { schemaVersion: 1, id: flow.id,
    checks: describePlan(resolvePlan(flow, options.baseDirectory)) } };
}

async function executePlan(suite, plan, options) {
  let temporary;
  const results = [];
  const report = { schemaVersion: 1, suite, startedAt: new Date().toISOString(),
    plan: describePlan(plan),
    packageVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version,
    source: sourceIdentity(),
    results, cleanupOk: true };
  const release = acquireLease(projectRoot);
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-verification-'));
    for (const entry of plan) {
      options.onProgress?.({ id: entry.id, status: 'starting' });
      results.push(await executePlannedCheck(entry, results, temporary, options));
      const result = results.at(-1);
      options.onProgress?.({ id: entry.id, status: result.status });
      if (result.cleanupOk === false) {
        report.cleanupOk = false;
        for (const pending of plan.slice(results.length)) {
          results.push({ id: pending.id, status: 'blocked', reason: 'PREVIOUS_PROCESS_CLEANUP_FAILED' });
        }
        break;
      }
    }
  } finally {
    cleanupVerification(temporary, report);
    release();
  }
  const ok = report.cleanupOk && results.every((result) => result.status === 'passed');
  return { ok, data: { ...report, finishedAt: new Date().toISOString(),
    summary: Object.fromEntries([...new Set(results.map((result) => result.status))]
      .map((status) => [status, results.filter((result) => result.status === status).length])),
  } };
}

module.exports = { listVerification, runVerification, runVerificationFlow, planVerificationFlow };
