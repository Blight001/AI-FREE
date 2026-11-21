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
  if (version === 1 && Array.isArray(content)) return { version, entries: content, categories: [] };
  if (version === 2 && Array.isArray(content?.entries) && categories.validCategoryCatalog(content.categories)) {
    return { version, entries: content.entries, categories: content.categories };
  }
  throw new Error('Account credential file is invalid');
}

class ProviderAccountVault {
  constructor({ fs, path, safeStorage, filePath }) {
    this.fs = fs;
    this.path = path;
    this.safeStorage = safeStorage;
    this.filePath = path.resolve(filePath);
  }

  read() {
    if (!this.fs.existsSync(this.filePath)) return { version: 1, entries: [], categories: [] };
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('System credential storage is unavailable');
    const payload = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
    if (![1, 2].includes(payload?.version) || typeof payload.encrypted !== 'string') throw new Error('Account credential file is invalid');
    const content = JSON.parse(this.safeStorage.decryptString(Buffer.from(payload.encrypted, 'base64')));
    return decodeVault(payload.version, content);
  }

  write({ version, entries, categories }) {
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('System credential storage is unavailable');
    const content = version === 1 ? entries : { entries, categories };
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
    this.write({ ...state, version: 2 });
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
    categories.requireCustomCategory(state.categories, provider);
    this.write({ ...state,
      categories: state.categories.filter((entry) => entry.id !== provider),
      entries: state.entries.filter((entry) => entry.provider !== provider),
    });
  }

  getPassword(provider, id) {
    return findAccount(this.read(), provider, id).password;
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
    const custom = categories.requireProvider(state.categories, provider).custom !== false;
    const normalizedEmail = normalizeProviderLogin(email, custom);
    const normalizedPassword = String(password || '');
    const normalizedSmsUrl = String(smsUrl || '').trim();
    if (!normalizedEmail) throw new Error(custom ? 'Enter a valid account name or email address' : 'Enter a valid email address');
    if (!normalizedPassword) throw new Error('Enter an account password');
    if (normalizedSmsUrl) {
      let url;
      try { url = new URL(normalizedSmsUrl); } catch (_) { throw new Error('SMS URL must be a valid HTTP/HTTPS address'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SMS URL must use HTTP or HTTPS');
    }
    if (state.entries.some((entry) => entry.provider === provider && entry.email === normalizedEmail)) throw new Error('Account already exists');
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
    this.write({ ...state, entries: state.entries.filter((candidate) => candidate !== entry) });
    return true;
  }
}

module.exports = { ProviderAccountVault };
