'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveChromiumResourcesPath } = require('../../src/app/backend/config/paths');

test('staged development app resolves Chromium resources from the project root', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const stagedAppRoot = path.join(projectRoot, '.generated', 'app');
  const resourcesPath = resolveChromiumResourcesPath({
    isPackaged: false,
    getAppPath: () => stagedAppRoot,
  }, {
    workingDirectory: projectRoot,
    moduleDirectory: path.join(stagedAppRoot, 'src', 'app', 'backend', 'config'),
  });

  assert.equal(resourcesPath, path.join(projectRoot, 'resources'));
});

 
