'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function patchInventory(forkRoot) {
  const directory = path.join(forkRoot, 'patches');
  const entries = fs.readFileSync(path.join(directory, 'series'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!entries.length) throw new Error('EMPTY_PATCH_SERIES');
  const seen = new Set();
  const patches = entries.map((name) => {
    if (!/^[\w.-]+\.patch$/.test(name)) throw new Error(`INVALID_PATCH_NAME: ${name}`);
    if (seen.has(name)) throw new Error(`DUPLICATE_PATCH: ${name}`);
    seen.add(name);
    const bytes = fs.readFileSync(path.join(directory, name));
    const text = bytes.toString('utf8');
    const files = [...new Set([
      ...[...text.matchAll(/^diff --git a\/(.*?) b\/.*$/gm)].map((match) => match[1]),
      ...[...text.matchAll(/^\+\+\+ b\/([^\r\n\t]+)/gm)].map((match) => match[1]),
    ])];
    if (!files.length) throw new Error(`EMPTY_PATCH: ${name}`);
    return { name, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), files };
  });
  const inactive = fs.readdirSync(directory).filter((name) => name.endsWith('.patch') && !seen.has(name));
  return { patches, inactive, activeCount: patches.length,
    warnings: inactive.map((name) => `NOT_APPLIED: ${name}; 停用原因需要维护者确认`) };
}

function git(sourceRoot, args, env) {
  return execFileSync('git', ['-C', sourceRoot, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 60000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function replayPatches(forkRoot, inventory) {
  const lock = JSON.parse(fs.readFileSync(path.join(forkRoot, 'version-lock.json'), 'utf8'));
  const sourceRoot = lock.chromium.sourceRoot;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-patch-replay-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index'),
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  // Ignore inherited Git repository overrides; this check owns only its temporary index.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  let current = 'baseline';
  try {
    const sourceObjects = git(sourceRoot, ['rev-parse', '--git-path', 'objects'], env);
    const temporaryObjects = path.join(temporary, 'objects');
    fs.mkdirSync(temporaryObjects);
    env['GIT_OBJECT_DIRECTORY'] = temporaryObjects;
    env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = path.resolve(sourceRoot, sourceObjects).replace(/\\/g, '/');
    const base = git(sourceRoot, ['rev-parse', `${lock.chromium.commit}^{commit}`], env);
    git(sourceRoot, ['read-tree', base], env);
    for (const entry of inventory.patches) {
      current = entry.name;
      const normalized = path.join(temporary, entry.name);
      const text = fs.readFileSync(path.join(forkRoot, 'patches', entry.name), 'utf8');
      fs.writeFileSync(normalized, text.replace(/\r\n/g, '\n'));
      git(sourceRoot, ['apply', '--cached', normalized], env);
    }
    return { ok: true, base, applied: inventory.patches.length,
      scope: 'isolated-index-only; does not prove compiled/runtime parity' };
  } catch (error) {
    return { ok: false, failedAt: current, code: error.code || 'PATCH_REPLAY_FAILED',
      message: String(error.stderr || error.message) };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { patchInventory, replayPatches };
