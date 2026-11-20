'use strict';

const { ChromiumRuntime } = require('../../src/app/backend/browser-runtime/chromium-runtime');

function createConfigurationManager(instances, restart) {
  const runtime = new ChromiumRuntime({ stateStore: { getState: () => ({ status: 'ready' }) } });
  runtime.instances = instances;
  runtime.restartNow = restart;
  return {
    updateProfileConfiguration: runtime.updateProfileConfiguration.bind(runtime),
  };
}

module.exports = { createConfigurationManager };
