'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { listVerification, runVerification, runVerificationFlow, planVerificationFlow } = require('./verification/runner');
const { safeOutput } = require('./verification/process');

function parseArguments(args) {
  if (args.length === 1) return { suite: args[0] };
  if (args.length === 2 && ['--flow', '--plan'].includes(args[0])) {
    return { mode: args[0], file: args[1] };
  }
  if (args.length === 3 && args[0] === 'interactions' && args[1] === '--only') {
    return { suite: args[0], only: args[2].split(',') };
  }
  throw new Error('Usage: node scripts/verify-project.js <suite>|--list|--flow file.json|--plan file.json; interactions [--only id,id]');
}

async function executeCommand(command, options) {
  if (command.file) {
    const executeFlow = command.mode === '--plan' ? planVerificationFlow : runVerificationFlow;
    const flow = JSON.parse(fs.readFileSync(command.file, 'utf8'));
    return executeFlow(flow, { ...options, baseDirectory: path.dirname(path.resolve(command.file)) });
  }
  return command.suite === '--list' ? listVerification() : runVerification(command.suite, options);
}

async function main(args = process.argv.slice(2)) {
  const command = parseArguments(args);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const options = {
      only: command.only,
      signal: controller.signal,
      onProgress: ({ id, status }) => process.stderr.write(`[verification] ${id}: ${status}\n`),
    };
    const result = await executeCommand(command, options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: {
      code: 'VERIFICATION_FAILED', message: safeOutput(error.message),
    } }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { main };
