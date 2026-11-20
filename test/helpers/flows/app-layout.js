'use strict';

const path = require('node:path');

function applicationLayout(runtime, options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, '../../..');
  const roots = {
    source: projectRoot,
    generated: path.join(projectRoot, '.generated/app'),
    packaged: path.join(options.appOutDir || path.join(projectRoot, 'appbuild/win-unpacked'), 'resources/app.asar'),
  };
  if (!Object.hasOwn(roots, runtime)) throw new Error('UNKNOWN_APPLICATION_RUNTIME');
  const root = roots[runtime];
  const sidebar = options.sidebarPath || path.join(root, 'src/app/frontend/sidebar/ai-control.html');
  const pages = {
    ai: sidebar,
    shell: path.join(options.sidebarPath ? projectRoot : root, 'src/app/frontend/views/app-shell.html'),
  };
  return Object.freeze({ runtime: options.sidebarPath ? 'override' : runtime, root, pages: Object.freeze(pages),
    peerController: path.join(root, 'src/app/backend/features/browser/remote-browser-peer-controller.js') });
}

function runtimeArgument(args, fallback) {
  const index = args.indexOf('--runtime');
  const runtime = index < 0 ? fallback : args[index + 1];
  if (!['source', 'generated', 'packaged'].includes(runtime)) throw new Error('UNKNOWN_APPLICATION_RUNTIME');
  return runtime;
}

module.exports = { applicationLayout, runtimeArgument };
