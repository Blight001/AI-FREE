'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../contracts/ipc-result');
const { normalizeProviderLogin } = require('../../../shared/provider-account-login.mjs');
const categories = require('./provider-account-categories');

function accountSummary({ id, email, note, smsUrl = '' }) {
  return { id, email, note: note ?? smsUrl, smsUrl, hasPassword: true };
}

function findAccount(state, provider, id) {
  categories.requireProvider(state.categories, provider);
  const entry = state.entries.find((candidate) => candidate.provider === provider && candidate.id === id);
  if (!entry) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found');
  return entry;
}

function decodeVault(version, content) {
  if (version === 1 && Array.isArray(content)) return { version, entries: content, categories: [], trash: [] };
  if (Array.isArray(content?.entries) && categories.validCategoryCatalog(content.categories)) {
    if (version === 2) return { version, entries: content.entries, categories: content.categories, trash: [] };
    if (version === 3 && validTrash(content.trash)) {
      return { version, entries: content.entries, categories: content.categories, trash: content.trash };
    }
  }
  throw new Error('Account credential file is invalid');
}

function validTrash(trash) {
  if (!Array.isArray(trash)) return false;
  const ids = new Set();
  for (const item of trash) {
    if (typeof item?.id !== 'string' || ids.has(item.id) || typeof item.deletedAt !== 'string') return false;
    const { entry, category } = item;
    if (typeof entry?.id !== 'string' || typeof entry.email !== 'string' || typeof entry.password !== 'string') return false;
    if (typeof category?.name !== 'string' || entry.provider !== category.id) return false;
    ids.add(item.id);
  }
  return true;
}

function archiveAccounts(state, entries, category) {
  if (!entries.length) return;
  const deletedAt = new Date().toISOString();
  state.version = 3;
  for (const entry of entries) {
    state.trash.push({ id: crypto.randomUUID(), deletedAt, entry, category: { id: category.id, name: category.name } });
  }
  const archived = new Set(entries);
  state.entries = state.entries.filter((entry) => !archived.has(entry));
}

function trashSummary({ id, deletedAt, entry, category }) {
  return { id, deletedAt, email: entry.email, provider: category.id, category: category.name };
}

function findTrash(state, id) {
  const item = state.trash.find((candidate) => candidate.id === id);
  if (!item) throw new AppError('ACCOUNT_TRASH_NOT_FOUND', '回收站中没有此账号');
  return item;
}

function requireUniqueLogin(state, provider, email, exceptId = undefined) {
  if (state.entries.some((entry) => entry.provider === provider && entry.email === email && entry.id !== exceptId)) {
    throw new AppError('ACCOUNT_ALREADY_EXISTS', 'Account already exists');
  }
}

function validatedLogin(state, provider, email) {
  const custom = categories.requireProvider(state.categories, provider).custom !== false;
  const normalizedEmail = normalizeProviderLogin(email, custom);
  if (!normalizedEmail) throw new AppError('INVALID_ACCOUNT_LOGIN', custom ? 'Enter a valid account name or email address' : 'Enter a valid email address');
  return normalizedEmail;
}

function validatedPassword(password) {
  const value = String(password || '');
  if (!value) throw new AppError('ACCOUNT_PASSWORD_REQUIRED', 'Enter an account password');
  return value;
}

class ProviderAccountVault {
  constructor({ fs, path, safeStorage, filePath }) {
    this.fs = fs;
    this.path = path;
    this.safeStorage = safeStorage;
    this.filePath = path.resolve(filePath);
  }

  read() {
    if (!this.fs.existsSync(this.filePath)) return { version: 1, entries: [], categories: [], trash: [] };
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('System credential storage is unavailable');
    const payload = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
    if (![1, 2, 3].includes(payload?.version) || typeof payload.encrypted !== 'string') throw new Error('Account credential file is invalid');
    const content = JSON.parse(this.safeStorage.decryptString(Buffer.from(payload.encrypted, 'base64')));
    return decodeVault(payload.version, content);
  }

  write({ version, entries, categories, trash }) {
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('System credential storage is unavailable');
    const content = version === 1 ? entries : { entries, categories, ...(version === 3 ? { trash } : {}) };
    const payload = JSON.stringify({ version, encrypted: this.safeStorage.encryptString(JSON.stringify(content)).toString('base64') });
    this.fs.mkdirSync(this.path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
      this.fs.writeFileSync(temporary, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
      this.fs.renameSync(temporary, this.filePath);
      try { this.fs.chmodSync(this.filePath, 0o600); } catch (_) {}
    } finally {
      try { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); } catch (_) {}
    }
  }

  list(provider) {
    const state = this.read();
    categories.requireProvider(state.categories, provider);
    return state.entries.filter((entry) => entry.provider === provider).map(accountSummary);
  }

  listCategories() {
    return categories.listCategories(this.read().categories);
  }

  createCategory(name) {
    const state = this.read();
    const category = categories.createCategory(state.categories, name);
    this.write({ ...state, version: Math.max(state.version, 2) });
    return category;
  }

  renameCategory(provider, name) {
    const state = this.read();
    const category = categories.renameCategory(state.categories, provider, name);
    this.write(state);
    return category;
  }

  removeCategory(provider) {
    const state = this.read();
    const category = categories.requireCustomCategory(state.categories, provider);
    archiveAccounts(state, state.entries.filter((entry) => entry.provider === provider), category);
    state.categories = state.categories.filter((entry) => entry.id !== provider);
    this.write(state);
  }

  getPassword(provider, id) {
    return this.getCredentials(provider, id).password;
  }

  getCredentials(provider, id) {
    const { email, password } = findAccount(this.read(), provider, id);
    return { email, password };
  }

  updateCredentials({ provider, id, email, password, note }) {
    const state = this.read();
    const entry = findAccount(state, provider, id);
    const login = validatedLogin(state, provider, email);
    requireUniqueLogin(state, provider, login, id);
    entry.email = login;
    if (password) entry.password = validatedPassword(password);
    entry.note = note.trim();
    this.write(state);
    return accountSummary(entry);
  }

  updateNote(provider, id, note) {
    const state = this.read();
    const entry = findAccount(state, provider, id);
    entry.note = note.trim();
    this.write(state);
    return accountSummary(entry);
  }

  save({ provider, email, password, note = undefined, smsUrl = '' }) {
    const state = this.read();
    const normalizedEmail = validatedLogin(state, provider, email);
    const normalizedPassword = validatedPassword(password);
    const normalizedSmsUrl = String(smsUrl || '').trim();
    if (normalizedSmsUrl) {
      let url;
      try { url = new URL(normalizedSmsUrl); } catch (_) { throw new Error('SMS URL must be a valid HTTP/HTTPS address'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SMS URL must use HTTP or HTTPS');
    }
    requireUniqueLogin(state, provider, normalizedEmail);
    const entry = {
      id: crypto.randomUUID(), provider, email: normalizedEmail, password: normalizedPassword,
      note: note?.trim(), smsUrl: normalizedSmsUrl,
    };
    state.entries.push(entry);
    this.write(state);
    return accountSummary(entry);
  }

  remove(provider, id) {
    const state = this.read();
    const entry = findAccount(state, provider, id);
    const category = categories.requireProvider(state.categories, provider);
    archiveAccounts(state, [entry], category);
    this.write(state);
    return true;
  }

  listTrash() {
    return this.read().trash.map(trashSummary).reverse();
  }

  getTrash(id) {
    return trashSummary(findTrash(this.read(), id));
  }

  restore(id) {
    const state = this.read();
    const item = findTrash(state, id);
    const { entry, category } = item;
    requireUniqueLogin(state, entry.provider, entry.email);
    const catalog = categories.listCategories(state.categories);
    if (!catalog.some((current) => current.id === category.id)) {
      const restored = [...state.categories, category];
      if (!categories.validCategoryCatalog(restored)) {
        throw new AppError('ACCOUNT_CATEGORY_CONFLICT', '无法恢复原栏目，请检查是否有同名栏目或已达到栏目上限');
      }
      state.categories = restored;
    }
    state.trash = state.trash.filter((candidate) => candidate !== item);
    state.entries.push(entry);
    this.write(state);
    return accountSummary(entry);
  }

  purge(id) {
    const state = this.read();
    const item = findTrash(state, id);
    state.trash = state.trash.filter((candidate) => candidate !== item);
    this.write(state);
  }

}

module.exports = { ProviderAccountVault };
