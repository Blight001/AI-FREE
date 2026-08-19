'use strict';

const {
  DEFAULT_OPENCUT_HOST,
  DEFAULT_OPENCUT_PORT,
} = require('./opencut-constants');
const { createEditorStore } = require('./opencut-editor');
const { createOpenCutHost } = require('./opencut-host');
const { createOpenCutTools } = require('./opencut-tools');
const { resolveOpenCutDataDir, resolveOpenCutWebRoot } = require('./opencut-paths');

function createOpenCutService(options = {}) {
  const app = options.app;
  const logger = options.logger || console;
  const workspaceDir = options.workspaceDir || '';
  const dataDir = options.dataDir || resolveOpenCutDataDir(app, options);
  const webRoot = options.webRoot || resolveOpenCutWebRoot(app, options);
  const editor = options.editor || createEditorStore(dataDir, options);
  let tools = options.tools || null;
  const host = options.host || createOpenCutHost({
    host: options.hostName || DEFAULT_OPENCUT_HOST,
    port: options.port || Number(process.env.AI_FREE_OPENCUT_PORT || DEFAULT_OPENCUT_PORT),
    webRoot,
    editor,
    logger,
    workspaceDir,
    getTools: () => tools,
  });
  if (!tools) tools = createOpenCutTools({ editor, host, workspaceDir });

  async function start() {
    try {
      return await host.start();
    } catch (error) {
      logger.warn?.('[OpenCut] 自动启动未完成，工具仍可使用:', error?.message || error);
      return { ...host.status(), ok: false, error: error?.message || String(error) };
    }
  }

  return {
    start,
    stop: () => host.stop(),
    status: () => host.status(),
    createTools: () => tools,
    editor,
    host,
  };
}

module.exports = { createOpenCutService };
