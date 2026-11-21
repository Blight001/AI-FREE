'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs } = require('node:util');

function boundedInteger(text, min, max) {
  const number = Number(text);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error('Fixture argument out of range');
  return number;
}

async function main() {
  if (path.basename(__dirname) !== 'command' || path.basename(path.dirname(__dirname)) !== 'AI-Workspace') {
    throw new Error('Run the copy from the fixture AI-Workspace/command directory');
  }
  const { values } = parseArgs({ options: {
    'delay-ms': { type: 'string', default: '6000' },
    'output-bytes': { type: 'string', default: '0' },
    child: { type: 'boolean' },
  } });
  const duration = boundedInteger(values['delay-ms'], 200, 30000);
  const outputBytes = boundedInteger(values['output-bytes'], 0, 256 * 1024);
  if (values.child) {
    await delay(duration);
    await fs.writeFile(path.join(__dirname, 'completed.marker'), 'child completed\n', { flag: 'wx' });
    return;
  }
  console.log('fixture: start');
  const child = spawn(process.execPath, [__filename, '--child', '--delay-ms', String(duration)], {
    windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  console.log(`fixture: child pid=${child.pid}`);
  if (outputBytes) process.stdout.write(`${'x'.repeat(outputBytes)}\n`);
  // Wait for both without letting an early child launch failure reject unhandled.
  const [code] = await Promise.all([completed, delay(100).then(() => console.error('fixture: progress'))]);
  if (code !== 0) throw new Error(`Delayed fixture child failed: ${code}`);
  console.log('fixture: complete');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
