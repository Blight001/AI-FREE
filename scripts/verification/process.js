'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const { parseFlowReport } = require('./flow-reports');
const { redactSensitiveText } = require('../../src/app/backend/browser-runtime/chromium-diagnostic-redaction');

function verificationEnv(temporary) {
  const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
  for (const key of Object.keys(env)) {
    if (/^(?:AI_FREE_ACCEPTANCE_|AI_FREE_CHROMIUM_|BROWSER_HOST_BINDING_PATH$|ELECTRON_RUN_AS_NODE$|PACKAGED_APP_DIR$|SIDEBAR_HTML_PATH$)/i.test(key)
      || /^AI_FREE_FIXTURE_/i.test(key)
      || /^AI_FREE_.*CAPTURE/i.test(key)
      || /(?:TOKEN|PASSWORD|SECRET|API_KEY|CLIENT_ID|AUTHORIZATION|COOKIE)/i.test(key)) delete env[key];
  }
  return env;
}

function safeOutput(output) {
  let text = String(output);
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION|COOKIE/i.test(key)) {
      text = text.split(value).join('<redacted>');
    }
  }
  text = text.replace(/^.*["']?(?:cookie|authorization|token|password|api[_-]?key|secret|sessionId|launchToken)["']?\s*[:=].*$/gim,
    '<sensitive diagnostic omitted>');
  text = redactSensitiveText(text, { homeDir: os.homedir().replace(/\\/g, '/'), tempDir: os.tmpdir().replace(/\\/g, '/') });
  return redactSensitiveText(text).slice(-6000);
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return Promise.resolve(true);
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return Promise.resolve(true); }
    catch (error) { return Promise.resolve(error.code === 'ESRCH'); }
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore',
    });
    const timeout = setTimeout(() => { killer.kill(); }, 8000);
    killer.once('error', () => { clearTimeout(timeout); resolve(false); });
    killer.once('exit', (code) => { clearTimeout(timeout); resolve(code === 0 || child.exitCode !== null); });
  });
}

function outputCollector() {
  let tail = '';
  let line = '';
  let skipped = 0;
  let fixtureCleanupOk = true;
  const testSummary = {};
  const failedTests = new Set();
  const flowReports = new Map();
  const record = (entry) => {
    const clean = entry.replace(/\x1b\[[0-9;]*m/g, '');
    if (clean === 'VERIFICATION_CLEANUP_FAILED') fixtureCleanupOk = false;
    const report = parseFlowReport(clean);
    if (report && flowReports.size < 20) flowReports.set(report.id, report);
    const match = clean.match(/^[#ℹ] (tests|pass|fail|cancelled|skipped|todo) (\d+)$/);
    if (match) {
      testSummary[match[1]] = Number(match[2]);
      if (['skipped', 'todo'].includes(match[1])) skipped += Number(match[2]);
    }
    if (/^(?:✖ (?!failing tests:)|not ok \d+ - )/.test(clean) && failedTests.size < 40) {
      failedTests.add(safeOutput(clean).slice(0, 400));
    }
  };
  return {
    append(chunk) {
      const text = chunk.toString();
      tail += text;
      if (tail.length > 65536) tail = tail.slice(-65536).replace(/^[^\n]*\n?/, '');
      const lines = (line + text).split(/\r?\n/);
      line = lines.pop().slice(-4096);
      for (const entry of lines) record(entry);
    },
    result() {
      if (line) { record(line); line = ''; }
      return { output: safeOutput(tail), skipped, testSummary, failedTests: [...failedTests],
        fixtureCleanupOk, flowReports: [...flowReports.values()] };
    },
  };
}

function stepStatus(stopped, code, captured) {
  if (stopped) return stopped;
  if (code !== 0 || !captured.fixtureCleanupOk) return 'failed';
  if (captured.flowReports.some((report) => report.status !== 'passed')) return 'failed';
  return captured.skipped ? 'incomplete' : 'passed';
}

function executeStep(entry, options) {
  return new Promise((resolve) => {
    const collector = outputCollector();
    const started = Date.now();
    const child = spawn(process.execPath, entry.args, {
      cwd: options.root, env: options.env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stopped = '';
    let cleanup = Promise.resolve(true);
    let finished = false;
    let cleanupExpired = false;
    let fallback;
    const finish = async (code, error = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(fallback);
      options.signal?.removeEventListener('abort', cancel);
      const captured = collector.result();
      const cleanupOk = await cleanup && !cleanupExpired && captured.fixtureCleanupOk;
      const status = stepStatus(stopped, code, captured);
      resolve({ id: entry.id, status, pid: child.pid, exitCode: code, durationMs: Date.now() - started,
        ...captured, cleanupOk, error: safeOutput(error) });
    };
    const stop = (status) => {
      if (stopped || finished) return;
      stopped = status;
      cleanup = killTree(child);
      fallback = setTimeout(() => {
        cleanupExpired = true;
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        void finish(null, 'PROCESS_CLEANUP_DEADLINE');
      }, 10000);
    };
    const cancel = () => stop('cancelled');
    const timeout = setTimeout(() => stop('timed_out'), entry.timeoutMs);
    child.stdout.on('data', (chunk) => collector.append(chunk));
    child.stderr.on('data', (chunk) => collector.append(chunk));
    child.once('error', (error) => { void finish(null, error.message); });
    child.once('close', (code) => { void finish(code); });
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
}

module.exports = { executeStep, verificationEnv, safeOutput };
