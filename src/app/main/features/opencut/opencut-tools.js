'use strict';

const { createOpenCutHandlers } = require('./opencut-handlers');
const { createOpenCutToolCatalog } = require('./opencut-tool-catalog');

function createOpenCutTools(options = {}) {
  const tools = createOpenCutToolCatalog(createOpenCutHandlers(options));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: tools.map(({ handler: _handler, ...def }) => def),
    has: (name) => byName.has(String(name || '')),
    execute: async (name, args = {}) => {
      const tool = byName.get(String(name || ''));
      if (!tool) throw new Error(`未知的 OpenCut 工具: ${name}`);
      return tool.handler(args && typeof args === 'object' ? args : {});
    },
  };
}

module.exports = { createOpenCutTools };
