'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { CONFIRMED_UPLOAD_FILES } = require('../../../src/app/backend/browser-runtime/chromium-upload-staging');
const path = require('node:path');

async function acceptPageBinding({ manager, pid, profileId, url, uploadPath, requests, waitForRequest }) {
  const command = async (name, payload, token) => (await manager.dispatchAutomationByProcessId(
    pid, name, payload, token === undefined ? {} : { expectedPageToken: token },
  )).result;
  const active = async () => (await command('list-tabs', {})).activeTab;
  const before = await active();
  assert(before.pageToken, 'The rebuilt Chromium fork must expose a document token');
  const observed = await command('observe-page', { filter: 'media', show_highlights: false }, before.pageToken);
  assert.equal(observed.success, true);
  assert(observed.items.some((item) => item.selector === '#attachment-image'));
  assert.equal((await command('automation-takeover', { action: 'acquire' }, before.pageToken)).takeoverActive, true);
  const select = (token) => manager.selectFilesByProcessId(pid, { path: uploadPath }, { expectedPageToken: token });
  await acceptTransparentFileInput({ command, select, token: before.pageToken, uploadPath, waitForRequest });
  const pending = (await select(before.pageToken)).result;
  assert(pending.selectionId);
  const clicksBefore = requests.filter((request) => request.path === '/file-click').length;
  const uploadsBefore = requests.filter((request) => request.path === '/file-result').length;

  await manager.reload(profileId, 'chromium');
  const after = await active();
  assert.equal(after.url, url);
  assert.equal(after.id, before.id);
  assert(after.pageToken);
  assert.notEqual(after.pageToken, before.pageToken);
  for (const { name, payload } of [
    { name: 'observe-page', payload: {} }, { name: 'capture-screenshot', payload: {} },
    { name: 'automation-takeover', payload: { action: 'acquire' } },
    { name: 'perform-action', payload: { action: 'wait', selector: '#file' } },
    { name: 'perform-action', payload: { action: 'upload_file', selector: '#file', selectionId: pending.selectionId } },
  ]) {
    const result = await command(name, payload, before.pageToken);
    assert.equal(result.errorCode, 'BROWSER_TARGET_CHANGED', name);
    assert.equal(result.actionExecuted, false, name);
  }
  assert.equal((await select(before.pageToken)).result.errorCode, 'BROWSER_TARGET_CHANGED');
  assert.equal((await command('automation-takeover', { action: 'acquire' }, after.pageToken)).takeoverActive, true);
  const oldArming = await command('perform-action', {
    action: 'upload_file', selector: '#file', selectionId: pending.selectionId,
  }, after.pageToken);
  assert.equal(oldArming.errorCode, 'FILE_SELECTION_NOT_ARMED');
  assert.equal(oldArming.actionExecuted, false);
  assert.equal(requests.filter((request) => request.path === '/file-click').length, clicksBefore);
  assert.equal(requests.filter((request) => request.path === '/file-result').length, uploadsBefore);

  await assertConfirmedBytes({ manager, pid, uploadPath, token: after.pageToken, command, waitForRequest,
    previousRequests: new Set(requests) });
  assert.equal(requests.filter((request) => request.path === '/file-click').length, clicksBefore + 1);
  assert.equal(requests.filter((request) => request.path === '/file-result').length, uploadsBefore + 1);
  assert.equal((await command('capture-screenshot', {}, after.pageToken)).success, true);
  assert.equal((await command('perform-action', {
    action: 'wait', selector: '#file', condition: 'attached',
  }, after.pageToken)).found, true);
  await acceptElementDownload(command, after.pageToken, uploadPath);
  await command('automation-takeover', { action: 'release' });
  await acceptPointerRace({ manager, profileId, url, requests, command, active, select });
  process.stdout.write('Native page binding acceptance passed (same-URL reload, file chooser, guarded download, pointer race).\n');
}

async function acceptTransparentFileInput({ command, select, token, uploadPath, waitForRequest }) {
  const result = await command('observe-page', { filter: 'file-input', show_highlights: false }, token);
  const fileInput = result.items.find((item) => item.selector === '#reference-file');
  assert(fileInput, 'Targeted observation must include a transparent file input');
  assert.equal(fileInput.visible, false);
  assert.equal(fileInput.requiresFileUpload, true);
  assert.equal(fileInput.disabled, false);
  const rejectedSelection = (await select(token)).result;
  const rejected = await command('perform-action', {
    action: 'upload_file', selector: '#disabled-reference-file', selectionId: rejectedSelection.selectionId,
  }, token);
  assert.equal(rejected.errorCode, 'FILE_SELECTION_TARGET_INVALID');
  assert.equal(rejected.actionExecuted, false);
  const armed = (await select(token)).result;
  assert(armed.selectionId);
  const uploaded = await command('perform-action', {
    action: 'upload_file', selector: fileInput.selector, selectionId: armed.selectionId,
  }, token);
  assert.equal(uploaded.fileSelected, true, JSON.stringify(uploaded));
  const request = await waitForRequest((item) => item.path === '/reference-result');
  const receipt = new URLSearchParams(request.query);
  assert.equal(receipt.get('trusted'), 'true');
  assert.equal(receipt.get('name'), path.basename(uploadPath));
  assert.equal(receipt.get('contents'), await fs.readFile(uploadPath, 'utf8'));
}

async function assertConfirmedBytes({ manager, pid, uploadPath, token, command, waitForRequest, previousRequests }) {
  const absolutePath = await fs.realpath(uploadPath);
  const contents = await fs.readFile(absolutePath);
  const confirmed = { absolutePath, size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  const current = (await manager.selectFilesByProcessId(pid, {
    path: absolutePath, [CONFIRMED_UPLOAD_FILES]: [confirmed],
  }, { expectedPageToken: token })).result;
  try {
    await fs.writeFile(absolutePath, Buffer.alloc(contents.length, 120));
    const uploaded = await command('perform-action', {
      action: 'upload_file', selector: '#file', selectionId: current.selectionId,
    }, token);
    assert.equal(uploaded.fileSelected, true, JSON.stringify(uploaded));
    const received = await waitForRequest((request) => request.path === '/file-result' && !previousRequests.has(request));
    const state = new URLSearchParams(received.query);
    assert.equal(state.get('name'), path.basename(absolutePath));
    assert.equal(state.get('contents'), contents.toString('utf8'));
  } finally {
    await fs.writeFile(absolutePath, contents);
  }
}

async function acceptElementDownload(command, token, uploadPath) {
  const input = { selector: '#attachment-image', target_path: path.join(path.dirname(uploadPath), 'bound-image.svg') };
  await assert.rejects(command('download-element', input), { code: 'COMMAND_NOT_ALLOWED' });
  const result = await command('download-element', input, token);
  assert.equal(result.downloadStarted, true, JSON.stringify(result));
}

async function acceptPointerRace({ manager, profileId, url, requests, command, active, select }) {
  const target = new URL(url);
  target.searchParams.set('pointer-race', '1');
  await manager.navigate(profileId, 'chromium', target.href);
  const page = await active();
  assert.equal((await command('automation-takeover', { action: 'acquire' }, page.pageToken)).takeoverActive, true);
  const selection = (await select(page.pageToken)).result;
  const requestsBefore = requests.filter((request) => request.path === '/file-click' || request.path === '/file-result').length;
  const result = await command('perform-action', {
    action: 'upload_file', selector: '#file', selectionId: selection.selectionId,
  }, page.pageToken);
  assert.equal(result.errorCode, 'UPLOAD_OUTCOME_UNVERIFIED', JSON.stringify(result));
  assert.equal(result.actionExecuted, undefined);
  assert.notEqual((await active()).pageToken, page.pageToken);
  assert.equal(requests.filter((request) => request.path === '/file-click' || request.path === '/file-result').length, requestsBefore);
  await command('automation-takeover', { action: 'release' });
}

module.exports = { acceptPageBinding };
