'use strict';

const path = require('node:path');
const { patchInventory, replayPatches } = require('./verification/patches');
const { safeOutput } = require('./verification/process');

function checkChromiumPatches(replay = false) {
  const forkRoot = path.resolve(__dirname, '../native/chromium-fork');
  const inventory = patchInventory(forkRoot);
  const result = { ...inventory, replay: replay ? replayPatches(forkRoot, inventory) : null };
  if (result.replay?.message) result.replay.message = safeOutput(result.replay.message);
  return { ok: result.replay?.ok !== false, data: result };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--replay')) throw new Error('Usage: node scripts/check-chromium-patches.js [--replay]');
    const result = checkChromiumPatches(args.includes('--replay'));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: {
      code: 'PATCH_CHECK_FAILED', message: safeOutput(error.message),
    } }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { checkChromiumPatches };
