'use strict';

function combineToolSets(...sets) {
  const available = sets.filter(Boolean);
  return {
    tools: available.flatMap((set) => Array.isArray(set.tools) ? set.tools : []),
    has: (name) => available.some((set) => set.has?.(name)),
    execute: (name, args) => {
      const owner = available.find((set) => set.has?.(name));
      if (!owner) throw new Error(`未知工具: ${name}`);
      return owner.execute(name, args);
    },
  };
}

module.exports = { combineToolSets };
