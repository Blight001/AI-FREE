'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AppError } = require('../../contracts/ipc-result');
const { atomicWrite } = require('./atomic-json');

const kinds = ['images', 'sound'];
function validPreferenceTree(value) {
  const object = (item) => item && typeof item === 'object' && !Array.isArray(item);
  if (!object(value)) return false;
  const sections = [value.profile, value.profile?.content_settings, value.profile?.content_settings?.exceptions];
  const exceptions = sections[2];
  return [...sections, ...kinds.map((kind) => exceptions?.[kind])].every((item) => item === undefined || object(item));
}

function readFile(root) {
  const file = path.join(root, 'Default', 'Preferences');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validPreferenceTree(value)) throw new Error();
    return { file, value };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, value: {} };
    throw new AppError('SITE_PREF_UNREADABLE', '浏览器偏好文件无法读取');
  }
}

function exactHost(pattern) {
  const match = /^(https?:\/\/(?:[a-z\d.-]+|\[[\da-f:]+\])(?::\d+)?),\*$/i.exec(pattern);
  return match ? URL.parse(match[1])?.hostname : '';
}

function readPortableRules(root) {
  const { value } = readFile(root);
  const rules = [];
  for (const kind of kinds) {
    const entries = value.profile?.content_settings?.exceptions?.[kind] || {};
    for (const [pattern, entry] of Object.entries(entries)) {
      const host = exactHost(pattern);
      if (host && [1, 2].includes(entry?.setting) && !Number(entry.expiration || 0)) {
        rules.push({ host, kind, pattern, setting: entry.setting });
      }
    }
  }
  return rules;
}

function plan(value, rules) {
  const exceptions = value.profile?.content_settings?.exceptions;
  const changes = rules.map(({ kind, pattern, setting }) => ({ kind, pattern,
    before: exceptions?.[kind]?.[pattern]?.setting ?? null, after: setting,
  })).filter((rule) => rule.before !== rule.after);
  const revision = createHash('sha256').update(JSON.stringify(changes)).digest('hex');
  return { changes, revision };
}

function previewPreferences(root, rules) { return plan(readFile(root).value, rules); }

function applyPreferences(root, rules, revision, write = atomicWrite) {
  const { file, value } = readFile(root);
  const preview = plan(value, rules);
  if (preview.revision !== revision) throw new AppError('SITE_PREVIEW_STALE', '设置已变化，请重新预览');
  if (!preview.changes.length) return { ...preview, verifiedCount: 0 };
  value.profile ??= {};
  value.profile.content_settings ??= {};
  const exceptions = value.profile.content_settings.exceptions ??= {};
  for (const { kind, pattern, after } of preview.changes) {
    exceptions[kind] ??= {};
    exceptions[kind][pattern] = { setting: after };
  }
  write(file, value);
  if (previewPreferences(root, rules).changes.length) {
    throw new AppError('SITE_PREF_VERIFY_FAILED', '目标浏览器的偏好与预览不一致，请刷新后重新预览');
  }
  return { ...preview, verifiedCount: preview.changes.length };
}

module.exports = { readPortableRules, previewPreferences, applyPreferences };
