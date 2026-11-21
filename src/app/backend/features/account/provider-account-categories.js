'use strict';

const { AppError } = require('../../../contracts/ipc-result');
const { randomUUID } = require('node:crypto');

const BUILT_IN = ['Google', 'Microsoft'].map((name) => Object.freeze({ id: name.toLowerCase(), name, custom: false }));
const MAX_CATEGORIES = 100;
const CATEGORY_ID = /^custom-[0-9a-f-]{36}$/;

function listCategories(custom) {
  return [...BUILT_IN, ...custom.map(({ id, name }) => ({ id, name, custom: true }))];
}

function requireProvider(custom, id) {
  const category = BUILT_IN.find((entry) => entry.id === id) || custom.find((entry) => entry.id === id);
  if (!category) throw new AppError('INVALID_PROVIDER', 'Invalid account provider');
  return category;
}

function requireCustomCategory(custom, id) {
  if (BUILT_IN.some((entry) => entry.id === id)) throw new AppError('BUILT_IN_CATEGORY', '内置栏目不能重命名或删除');
  return requireProvider(custom, id);
}

function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 32 && !/[\u0000-\u001f\u007f]/.test(name);
}

function normalizeName(custom, value, id) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!validName(name)) throw new AppError('INVALID_CATEGORY_NAME', '请输入 1 至 32 个字符的栏目名称');
  if (listCategories(custom).some((entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase())) {
    throw new AppError('CATEGORY_NAME_EXISTS', '已有同名栏目');
  }
  return name;
}

function createCategory(custom, value) {
  if (custom.length >= MAX_CATEGORIES) throw new AppError('CATEGORY_LIMIT', '自定义栏目已达到数量上限');
  const category = { id: `custom-${randomUUID()}`, name: normalizeName(custom, value) };
  custom.push(category);
  return { ...category, custom: true };
}

function renameCategory(custom, id, value) {
  const category = requireCustomCategory(custom, id);
  category.name = normalizeName(custom, value, id);
  return { ...category, custom: true };
}

function validCategoryCatalog(custom) {
  if (!Array.isArray(custom) || custom.length > MAX_CATEGORIES) return false;
  const ids = new Set(BUILT_IN.map(({ id }) => id));
  const names = new Set(BUILT_IN.map(({ name }) => name.toLowerCase()));
  for (const entry of custom) {
    if (typeof entry?.id !== 'string' || !CATEGORY_ID.test(entry.id) || !validName(entry.name)) return false;
    const key = entry.name.toLowerCase();
    if (ids.has(entry.id) || names.has(key)) return false;
    ids.add(entry.id);
    names.add(key);
  }
  return true;
}

module.exports = { createCategory, listCategories, renameCategory, requireCustomCategory, requireProvider, validCategoryCatalog };
