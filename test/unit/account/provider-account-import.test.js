'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const parser = import('../../../src/app/frontend/renderer/controllers/pages/app-shell/provider-account-import-parser.mjs');

test('parses delivery text and labeled blocks without retaining tokens or alternate passwords', async () => {
  const { parseProviderAccountText } = await parser;
  const text = [
    'Test delivery header',
    ' FIRST@example.test ---- password-one ---- 00000000-0000-0000-0000-000000000000 ---- fixture-extra',
    'https://example.test/help',
    '账号', 'second@example.test', '密码', 'alternate', '邮箱密码', 'password-two',
    '邮箱：third@example.test', '密码：password-three',
    'fourth@example.test----password-four',
  ].join('\r\n');
  assert.deepEqual(parseProviderAccountText(text), {
    accounts: [
      { email: 'first@example.test', password: 'password-one' },
      { email: 'second@example.test', password: 'password-two' },
      { email: 'third@example.test', password: 'password-three' },
      { email: 'fourth@example.test', password: 'password-four' },
    ],
    skipped: 0,
  });
});

test('skips duplicates, placeholders, malformed columns and incomplete labeled accounts', async () => {
  const { parseProviderAccountText } = await parser;
  const text = [
    'case@example.test----first', 'CASE@example.test----second',
    'missing@example.test----X----00000000-0000-0000-0000-000000000000----fixture-extra',
    'invalid@example.test----fixture----unknown-format----fixture-extra',
    '账号：partial@example.test', '密码：alternate', '邮箱密码：',
    '账号：next@example.test', '密码：next-password',
  ].join('\n');
  assert.deepEqual(parseProviderAccountText(text), {
    accounts: [{ email: 'case@example.test', password: 'first' }, { email: 'next@example.test', password: 'next-password' }],
    skipped: 4,
  });
});

test('bounds input length and import count without silently accepting partial credentials', async () => {
  const { parseProviderAccountText, MAX_IMPORT_TEXT, MAX_IMPORT_ACCOUNTS } = await parser;
  assert.throws(() => parseProviderAccountText('x'.repeat(MAX_IMPORT_TEXT + 1)), RangeError);
  const input = Array.from({ length: MAX_IMPORT_ACCOUNTS + 1 }, (_, i) => `${i}@example.test----fixture-only`).join('\n');
  assert.throws(() => parseProviderAccountText(input), RangeError);
});

test('custom category import accepts numeric and named accounts without relaxing mail categories', async () => {
  const { parseProviderAccountText } = await parser;
  const text = '123456789----fixture-one\n账号：Test-User\n密码：fixture-two\nhttps://example.test----fixture-invalid';
  assert.deepEqual(parseProviderAccountText(text, true).accounts, [
    { email: '123456789', password: 'fixture-one' },
    { email: 'Test-User', password: 'fixture-two' },
  ]);
  assert.deepEqual(parseProviderAccountText(text).accounts, []);
});
