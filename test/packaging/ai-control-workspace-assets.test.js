'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sidebarRoot = path.join(__dirname, '../../src/app/sidebar');

test('AI 控制页装配上传、工作文件和 @ 引用资源', () => {
  const html = fs.readFileSync(path.join(sidebarRoot, 'ai-control.html'), 'utf8');
  for (const id of [
    'ai-chat-attach', 'ai-chat-attachment-chips', 'ai-chat-workspace-panel',
    'ai-chat-workspace-upload', 'ai-chat-workspace-files', 'ai-chat-workspace-preview',
    'ai-chat-mention-menu',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const relativePath of [
    'client/app/side/controllers/pages/ai-control/ai-control-files.js',
    'client/app/side/styles/modules/ai-control-files.css',
  ]) {
    assert.equal(fs.existsSync(path.join(sidebarRoot, relativePath)), true, relativePath);
    assert.match(html, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
