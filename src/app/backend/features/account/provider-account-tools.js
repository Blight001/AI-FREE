'use strict';

const { AppError, fail, ok } = require('../../../contracts/ipc-result');
const { fillProviderCredential } = require('./provider-credential-fill');

const fieldText = (maxLength) => ({ type: 'string', maxLength });
const provider = fieldText(64);
const id = fieldText(64);
const accountRef = { provider, id };

const TOOL_NAME = 'account_manage';

function action(description, properties = {}, required = Object.keys(properties)) {
  return { description, properties, required };
}

const actions = {
  categories: action('列出账号栏目和栏目 ID。'),
  list: action('按栏目读取脱敏账号和引用 ID。', { provider }),
  add: action('打开本机新增表单，由用户填写并保存。', { provider }),
  update: action('提供非敏感 note 时更新备注，省略时打开本机表单更换凭据。', { ...accountRef, note: fieldText(2048) }, ['provider', 'id']),
  delete: action('请求本机确认后将账号移入回收站。', accountRef),
  trash: action('读取回收站中脱敏的账号和回收记录 ID。'),
  restore: action('用回收记录 ID 恢复账号。', { id }),
  purge: action('用回收记录 ID 请求本机确认彻底删除。', { id }),
  fill: action('先接管目标 HTTPS 页面，再凭引用填写一个字段。field_id 与 field_name 二选一。', {
    ...accountRef, change_browser: fieldText(256), origin: fieldText(512),
    field: { type: 'string', enum: ['username', 'password'] }, field_id: fieldText(128), field_name: fieldText(128),
  }, ['provider', 'id', 'change_browser', 'origin', 'field']),
};

function describeAction([name, { description, required, properties }]) {
  const optional = Object.keys(properties).filter((key) => !required.includes(key));
  const fields = [];
  if (required.length) fields.push(`必填 ${required.join(', ')}`);
  if (optional.length) fields.push(`其他字段 ${optional.join(', ')}`);
  return `${name}${fields.length ? `（${fields.join('；')}）` : ''}：${description}`;
}

const tools = [{
  name: TOOL_NAME,
  description: ['管理本机账号。读取结果脱敏，凭据通过本机表单或引用使用。', ...Object.entries(actions).map(describeAction)].join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(actions) },
      ...Object.assign({}, ...Object.values(actions).map(({ properties }) => properties)),
    },
    required: ['action'],
    additionalProperties: false,
  },
}];

function matchesField(key, value, field, required) {
  if (typeof value !== 'string' || value.length > (field.maxLength ?? 128)) return false;
  if (field.enum && !field.enum.includes(value)) return false;
  return !required || key === 'note' || value.trim().length > 0;
}

function validateInput(schema, input) {
  const { properties, required } = schema;
  return required.every((key) => Object.hasOwn(input, key)) && Object.entries(input).every(([key, value]) => (
    Object.hasOwn(properties, key) && matchesField(key, value, properties[key], required.includes(key))
  ));
}

function maskLogin(value) {
  const [local, domain] = String(value).split('@');
  const prefix = local.length > 2 ? Array.from(local)[0] : '';
  return `${prefix}•••${domain && domain.length > 2 ? `@${Array.from(domain)[0]}•••` : ''}`;
}

function maskedAccount(account) {
  return { id: account.id, maskedAccount: maskLogin(account.email) };
}

async function removeAccountWithApproval(vault, confirm, { provider, id }, signal) {
  const getAccount = () => vault.list(provider).find((account) => account.id === id);
  const account = getAccount();
  if (!account) throw new AppError('ACCOUNT_NOT_FOUND', '找不到该账号');
  const category = vault.listCategories().find((entry) => entry.id === provider);
  await confirm('删除账号？', `账号 ${account.email}\n栏目 ${category?.name || provider}\n删除后可从回收站恢复。`, '移入回收站', signal);
  signal?.throwIfAborted();
  const current = getAccount();
  if (!current) throw new AppError('ACCOUNT_NOT_FOUND', '找不到该账号');
  if (current.email !== account.email) throw new AppError('ACCOUNT_CHANGED', '该账号已修改，请重新确认删除');
  return vault.remove(provider, id);
}

function createProviderAccountTools({ vault, bridge, runtime, confirm, openEditor, onChanged }) {
  const handlers = {
    categories: () => ({ categories: vault.listCategories() }),
    list: (input) => ({ accounts: vault.list(input.provider).map(maskedAccount) }),
    add: ({ provider }) => {
      if (!vault.listCategories().some(({ id }) => id === provider)) {
        throw new AppError('INVALID_PROVIDER', '找不到该账号栏目');
      }
      return openEditor({ provider });
    },
    update: (input) => {
      if (!Object.hasOwn(input, 'note')) {
        vault.getCredentials(input.provider, input.id);
        return openEditor({ provider: input.provider, id: input.id });
      }
      return changed({ account: maskedAccount(vault.updateNote(input.provider, input.id, input.note)) });
    },
    delete: async (input, signal) => changed({ deleted: await removeAccountWithApproval(vault, confirm, input, signal) }),
    trash: () => ({ accounts: vault.listTrash().map(({ id, email, provider, category, deletedAt }) => ({
      ...maskedAccount({ id, email }), provider, category, deletedAt,
    })) }),
    restore: (input) => changed({ account: maskedAccount(vault.restore(input.id)) }),
    purge: async (input, signal) => {
      const item = vault.getTrash(input.id);
      await confirm('彻底删除回收站中的账号？', `账号 ${item.email}\n栏目 ${item.category}\n删除后无法从回收站恢复。`, '彻底删除', signal);
      signal?.throwIfAborted();
      vault.purge(input.id);
      return changed({ deleted: true });
    },
    fill: (input, signal) => fillProviderCredential({ vault, bridge, runtime }, input, signal),
  };
  function changed(result) {
    onChanged();
    return result;
  }
  return {
    tools,
    has: (name) => name === TOOL_NAME,
    /** @param {Record<string, unknown>} [input] */
    async execute(name, input = {}, options = undefined) {
      if (name !== TOOL_NAME || !input || typeof input !== 'object' || Array.isArray(input)) {
        return fail(new AppError('ACCOUNT_INVALID_INPUT', '账号操作参数无效'));
      }
      const { action: selected, ...args } = input;
      if (typeof selected !== 'string' || !Object.hasOwn(actions, selected) || !validateInput(actions[selected], args)) {
        return fail(new AppError('ACCOUNT_INVALID_INPUT', '账号操作参数无效'));
      }
      try {
        options?.signal?.throwIfAborted();
        return ok(await handlers[selected](args, options?.signal));
      } catch (error) {
        return fail(error instanceof AppError ? error : new AppError('ACCOUNT_OPERATION_FAILED', '账号操作失败，请检查本机账号库与浏览器状态'));
      }
    },
  };
}

module.exports = { createProviderAccountTools };
