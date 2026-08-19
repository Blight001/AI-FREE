'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isDownloadElementUnavailable, observedRef, resolvedFileAction,
} = require('../../../src/app/main/services/native-browser-file');

test('resolvedFileAction upgrades a ref-only download to download_element', () => {
  assert.equal(resolvedFileAction({ action: 'download', ref: 'e2' }), 'download_element');
  assert.equal(resolvedFileAction({ action: 'download', element: 'e2' }), 'download_element');
  assert.equal(resolvedFileAction({ action: 'download', x: 10, y: 20 }), 'download_element');
  assert.equal(resolvedFileAction({
    action: 'download', url: 'https://cdn.example.test/a.jpg', ref: 'e2',
  }), 'download');
});

test('observedRef accepts element aliases used by callers', () => {
  assert.equal(observedRef({ element: 'e9' }), 'e9');
  assert.equal(observedRef({ element_ref: 'e8' }), 'e8');
  assert.equal(observedRef({ ref: 'e2', element: 'ignored' }), 'e2');
});

test('isDownloadElementUnavailable matches old runtime whitelist failures', () => {
  const error = new Error('Runtime Bridge 命令不在白名单');
  error.code = 'COMMAND_NOT_ALLOWED';
  assert.equal(isDownloadElementUnavailable(error), true);
  assert.equal(isDownloadElementUnavailable({ errorCode: 'IMAGE_ELEMENT_REQUIRED' }), true);
  assert.equal(isDownloadElementUnavailable({ message: '下载文件超过大小限制' }), false);
});
