'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CARD_CACHE_SCHEMA_VERSION = 2;
const CARD_CACHE_FILE_NAME = 'automation-cards.json';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function definitionDigest(cardData) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(cardData || {}))).digest('hex');
}

function normalizedMetadata(source = {}) {
  const status = String(source.status || 'active').trim().toLowerCase();
  const accessScope = String(source.accessScope || source.access_scope || 'all').trim().toLowerCase();
  return {
    status: ['active', 'deprecated', 'draft', 'validated', 'published'].includes(status) ? status : 'active',
    riskLevel: String(source.riskLevel || source.risk_level || 'read_only').trim() || 'read_only',
    tags: [...new Set((Array.isArray(source.tags) ? source.tags : []).map((tag) => String(tag).trim()).filter(Boolean))],
    accessScope: ['all', 'owner', 'selected'].includes(accessScope) ? accessScope : 'all',
    inputSchema: clone(source.inputSchema && typeof source.inputSchema === 'object' ? source.inputSchema : { type: 'object', properties: {} }),
    limits: clone(source.limits && typeof source.limits === 'object' ? source.limits : { timeoutSeconds: 900, maxTransitions: 120 }),
  };
}

function normalizeVersion(source, fallbackCard, index) {
  const cardData = clone(source?.cardData && typeof source.cardData === 'object' ? source.cardData : fallbackCard);
  const digest = String(source?.digest || definitionDigest(cardData));
  return {
    id: String(source?.id || `legacy-${digest.slice(0, 20)}`),
    versionNumber: Number(source?.versionNumber || index + 1), digest, cardData,
    createdAt: Number(source?.createdAt || 0),
  };
}

function normalizeCardEntry(source = {}) {
  const cardData = clone(source.cardData && typeof source.cardData === 'object' ? source.cardData : {});
  const rawVersions = Array.isArray(source.versions) && source.versions.length ? source.versions : [{}];
  const versions = rawVersions.map((version, index) => normalizeVersion(version, cardData, index));
  const latestVersionId = versions.some((version) => version.id === source.latestVersionId)
    ? source.latestVersionId : versions.at(-1).id;
  const latest = versions.find((version) => version.id === latestVersionId) || versions.at(-1);
  return {
    ...source, ...normalizedMetadata(source), id: String(source.id || '').trim(),
    cardName: String(source.cardName || latest.cardData.name || source.id || '').trim(),
    cardData: clone(latest.cardData), latestVersionId, versions,
  };
}

/** @param {Record<string, any>} [source] */
function normalizeCardCacheState(source = {}) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const items = Array.isArray(value.items)
    ? value.items.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map(normalizeCardEntry)
    : [];
  const requestedSelectedId = String(value.selectedId || '').trim();
  const selectedId = items.some((item) => item.id === requestedSelectedId)
    ? requestedSelectedId : String(items[0]?.id || '').trim();
  return { items, selectedId };
}

function atomicWrite(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch (_) {}
  }
}

function createCardCacheStore(options = {}) {
  const dataDir = path.resolve(String(options.dataDir || path.join(process.cwd(), 'extensions', 'browser_automation')));
  const filePath = path.join(dataDir, CARD_CACHE_FILE_NAME);
  function read() {
    if (!fs.existsSync(filePath)) return { exists: false, state: { items: [], selectedId: '' } };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
    return { exists: true, state: normalizeCardCacheState(parsed) };
  }
  function write(source = {}) {
    const state = normalizeCardCacheState(source);
    atomicWrite(filePath, { schemaVersion: CARD_CACHE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), ...state });
    return state;
  }
  return { dataDir, filePath, read, write };
}

module.exports = {
  CARD_CACHE_FILE_NAME, atomicWrite, createCardCacheStore, definitionDigest,
  normalizeCardCacheState, normalizeCardEntry, normalizedMetadata,
};
