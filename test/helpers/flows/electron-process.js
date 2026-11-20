'use strict';

// The Node parent owns on-disk storage. Electron releases file locks only when
// its process exits, so deleting sessionData in Electron's quit hook is too early.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { interactions } = require('../../../scripts/verification/interactions');
const { executeStep, verificationEnv } = require('../../../scripts/verification/process');
const { flowReportPrefix } = require('../../../scripts/verification/flow-reports');

async function main(args = process.argv.slice(2)) {
  const entry = interactions.find((item) => item.file === args[0] && !item.manual && !item.node);
  if (!entry) throw new Error('UNKNOWN_INTERACTION_ENTRY');
  const root = path.resolve(__dirname, '../../..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-fixture-process-'));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let cleanupOk = true;
  try {
    const env = { ...verificationEnv(temporary), AI_FREE_FIXTURE_ROOT: temporary };
    const result = await executeStep({ id: entry.id, timeoutMs: entry.timeoutMs || 600000,
      args: [require.resolve('electron/cli.js'), path.join(__dirname, 'electron-entry.js'), ...args] },
    { root, env, signal: controller.signal });
    cleanupOk = result.cleanupOk;
    process.stdout.write(result.output + '\n');
    for (const report of result.flowReports) process.stdout.write(flowReportPrefix + JSON.stringify(report) + '\n');
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    if (cleanupOk) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); }
      catch (_) { cleanupOk = false; }
    }
    if (!cleanupOk) {
      console.error('VERIFICATION_CLEANUP_FAILED');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch(() => { console.error('FIXTURE_PROCESS_FAILED'); process.exitCode = 1; });
}

module.exports = { main };
