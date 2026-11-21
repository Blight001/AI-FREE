'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeChromiumRuntimeManifest } = require('../../../scripts/chromium-runtime-manifest');

function resolveTestResources(candidate) {
  const bundled = path.resolve(__dirname, '../../../resources');
  if (!candidate) return bundled;
  const fixtureRoot = process.env.AI_FREE_FIXTURE_ROOT;
  if (!fixtureRoot || !path.isAbsolute(candidate) || path.basename(candidate) !== 'chrome.dll') {
    throw new Error('DLL comparison requires an absolute chrome.dll path and the fixture runner');
  }
  const isolated = path.join(fixtureRoot, 'candidate-resources');
  const chromium = path.join(isolated, 'chromium');
  fs.cpSync(path.join(bundled, 'chromium'), chromium, { recursive: true });
  fs.copyFileSync(candidate, path.join(chromium, 'chrome.dll'));
  writeChromiumRuntimeManifest(chromium);
  return isolated;
}

module.exports = { resolveTestResources };
