'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const commandClient = fs.readFileSync(
  path.join(root, 'src/app/backend/browser-runtime/chromium-command-client.js'), 'utf8',
);
const runtimeAutomation = fs.readFileSync(
  path.join(root, 'src/app/backend/browser-runtime/runtime-automation.js'), 'utf8',
);
const nativeAutomation = fs.readFileSync(
  path.join(root, 'src/app/backend/services/native-browser-automation.js'), 'utf8',
);
const observePatch = fs.readFileSync(
  path.join(root, 'native/chromium-fork/patches/0020-ai-free-page-automation.patch'), 'utf8',
);
const structuredPatch = fs.readFileSync(
  path.join(root, 'native/chromium-fork/patches/0041-ai-free-observe-structured-semantics.patch'), 'utf8',
);
const regionPatch = fs.readFileSync(
  path.join(root, 'native/chromium-fork/patches/0042-ai-free-observe-semantic-regions.patch'), 'utf8',
);

assert(commandClient.includes("'observe-page'"));
const { normalizeRuntimeAutomation } = require(path.join(root, 'src/app/backend/browser-runtime/runtime-automation'));
assert.equal(normalizeRuntimeAutomation('observe-page', { limit: 12 }).limit, 12);
assert(runtimeAutomation.includes("'inspect-page-state'"));
assert(nativeAutomation.includes("runtimeCommand(connection, 'observe-page'"));
assert(observePatch.includes('observe-page'));
assert(observePatch.includes('perform-action'));
assert(structuredPatch.includes('selectorMatchCount'));
assert(structuredPatch.includes('INVALID_FILTER'));
assert(regionPatch.includes("mode:'overview'"));
assert(regionPatch.includes('REGION_STALE'));
assert(!fs.existsSync(path.join(root, 'src/assets/extensions/browser_automation')));

console.log('native Chromium browser observe checks passed');
