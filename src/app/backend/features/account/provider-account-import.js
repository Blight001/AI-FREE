'use strict';

const { AppError } = require('../../../contracts/ipc-result');

const MAX_BATCH = 200;

function invalidOutput() {
  return new AppError('ACCOUNT_IMPORT_INVALID_OUTPUT', `转换命令须输出包含 1 至 ${MAX_BATCH} 条 email 和 password 记录的 JSON 数组`);
}

function parseOutput(stdout) {
  let rows;
  try { rows = JSON.parse(stdout.replace(/^\uFEFF/, '')); } catch (_) { throw invalidOutput(); }
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_BATCH) throw invalidOutput();
  return rows.map(readCredentials);
}

function readCredentials(row) {
  if (!row || typeof row !== 'object' || Object.keys(row).length !== 2) throw invalidOutput();
  const { email, password } = row;
  if (typeof email !== 'string' || typeof password !== 'string' || !password || password.length > 1024) {
    throw invalidOutput();
  }
  return { email, password };
}

function checkCanceled(signal) {
  if (signal?.aborted) throw new AppError('ACCOUNT_IMPORT_CANCELED', '账号导入已取消');
}

async function convertAccounts(runCommand, input, signal) {
  let result;
  try { result = await runCommand(input, { signal }); } catch (_) {
    checkCanceled(signal);
    throw new AppError('ACCOUNT_IMPORT_COMMAND_FAILED', '无法运行账号转换命令，请检查工作目录和命令');
  }
  checkCanceled(signal);
  if (!result.success) throw new AppError('ACCOUNT_IMPORT_COMMAND_FAILED', '账号转换命令未成功完成');
  if (result.stdout_truncated) throw new AppError('ACCOUNT_IMPORT_OUTPUT_LIMIT', '转换数据超过输出上限，请分批导入');
  return parseOutput(result.stdout);
}

async function importProviderAccounts(vault, runCommand, { provider, ...command }, signal) {
  if (!runCommand) throw new AppError('ACCOUNT_IMPORT_UNAVAILABLE', '本机账号转换命令不可用');
  checkCanceled(signal);
  if (!vault.listCategories().some(({ id }) => id === provider)) {
    throw new AppError('INVALID_PROVIDER', '找不到该账号栏目');
  }
  const accounts = await convertAccounts(runCommand, command, signal);
  checkCanceled(signal);
  return vault.importCredentials(provider, accounts);
}

module.exports = { importProviderAccounts };
