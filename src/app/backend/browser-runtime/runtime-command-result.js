'use strict';

function assertRuntimeCommandSuccess(command, response) {
  const result = response?.result;
  const failed = response?.ok === false || response?.success === false
    || result?.ok === false || result?.success === false;
  if (!failed) return response;
  const code = result?.errorCode || response?.errorCode || 'SESSION_IMPORT_COMMAND_FAILED';
  throw Object.assign(new Error(`会话导入阶段 ${command} 失败`), {
    code,
    command,
  });
}

module.exports = { assertRuntimeCommandSuccess };
