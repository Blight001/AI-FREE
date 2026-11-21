'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { readPortableRules } = require('./site-preferences');
const { listIndexedDbOrigins } = require('./site-indexed-db-layout');

const indexes = [
  { label: 'Cookie', field: 'cookies', file: ['Network', 'Cookies'],
    sql: 'SELECT host_key AS site, COUNT(*) AS n FROM cookies GROUP BY host_key',
    host: (site) => String(site).replace(/^\./, '').toLowerCase() },
  { label: '存储桶', field: 'buckets', file: ['WebStorage', 'QuotaManager'],
    sql: 'SELECT storage_key AS site, COUNT(*) AS n FROM buckets GROUP BY storage_key',
    host: (site) => {
      const url = URL.parse(String(site).split('^')[0]);
      return url && ['https:', 'http:'].includes(url.protocol) ? url.hostname : '';
    } },
];

async function readIndex(file, sql) {
  try { await fs.access(file); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

async function addIndexedDbOrigins(sites, chromiumData) {
  for (const origin of await listIndexedDbOrigins(chromiumData)) {
    const host = new URL(origin).hostname;
    const site = sites.get(host) || { host, cookies: 0, buckets: 0 };
    (site.indexedDbOrigins ??= []).push(origin);
    sites.set(host, site);
  }
}

async function listSiteMetadata(chromiumData) {
  const sites = new Map();
  const unavailable = [];
  for (const index of indexes) {
    const file = path.join(chromiumData, 'Default', ...index.file);
    try {
      for (const row of await readIndex(file, index.sql)) {
        const host = index.host(row.site);
        if (!host) continue;
        const site = sites.get(host) || { host, cookies: 0, buckets: 0 };
        site[index.field] += Number(row.n);
        sites.set(host, site);
      }
    } catch { unavailable.push(index.label); }
  }
  try {
    for (const rule of readPortableRules(chromiumData)) {
      const site = sites.get(rule.host) || { host: rule.host, cookies: 0, buckets: 0 };
      (site.rules ??= []).push({ kind: rule.kind, pattern: rule.pattern, setting: rule.setting });
      sites.set(rule.host, site);
    }
  } catch { unavailable.push('网站偏好'); }
  try { await addIndexedDbOrigins(sites, chromiumData); } catch { unavailable.push('IndexedDB'); }
  for (const index of indexes.filter((entry) => unavailable.includes(entry.label))) {
    for (const site of sites.values()) site[index.field] = null;
  }
  return { sites: [...sites.values()].sort((a, b) => a.host.localeCompare(b.host)), unavailable };
}

module.exports = { listSiteMetadata };
