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
    'client/app/side/styles/modules/website-console-theme.css',
  ]) {
    assert.equal(fs.existsSync(path.join(sidebarRoot, relativePath)), true, relativePath);
    assert.match(html, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const fileCss = fs.readFileSync(path.join(
    sidebarRoot, 'client/app/side/styles/modules/ai-control-files.css',
  ), 'utf8');
  assert.doesNotMatch(fileCss, /\.ai-chat-workspace-panel button\s*\{/);
  assert.match(fileCss, /\.ai-chat-workspace-file-info\s*\{[^}]*height:\s*auto\s*!important/s);
  for (const id of [
    'ai-chat-workspace-preview', 'ai-chat-workspace-preview-title',
    'ai-chat-workspace-preview-body', 'ai-chat-workspace-preview-close',
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /media-src 'self' data: blob:/);
  const fileScript = fs.readFileSync(path.join(
    sidebarRoot, 'client/app/side/controllers/pages/ai-control/ai-control-files.js',
  ), 'utf8');
  assert.match(fileScript, /ai-chat-workspace-file-preview/);
  assert.match(fileScript, /document\.createElement\('video'\)/);
});

test('AI 控制与个人中心装配网站控制台统一主题', () => {
  const themeAsset = 'client/app/side/styles/modules/website-console-theme.css';
  assert.equal(fs.existsSync(path.join(sidebarRoot, themeAsset)), true);
  for (const page of ['ai-control.html', 'account-center.html']) {
    const html = fs.readFileSync(path.join(sidebarRoot, page), 'utf8');
    assert.match(html, new RegExp(themeAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const aiCss = fs.readFileSync(path.join(sidebarRoot, 'client/app/side/styles/modules/ai-control.css'), 'utf8');
  const themeCss = fs.readFileSync(path.join(sidebarRoot, themeAsset), 'utf8');
  assert.doesNotMatch(aiCss, /\.ai-chat-composer button\s*\{/);
  assert.match(aiCss, /#ai-chat-send\s*\{/);
  assert.match(themeCss, /\.ai-model-inline-select \.ai-select-trigger\s*\{[^}]*display:\s*flex/s);
  assert.match(themeCss, /\.ai-browser-gear-select \.ai-browser-gear-trigger[\s\S]*?border:\s*0\s*!important;[\s\S]*?background:\s*transparent\s*!important;/);
});

test('AI 新对话欢迎区不再显示浏览器连接或对话模式', () => {
  const html = fs.readFileSync(path.join(sidebarRoot, 'ai-control.html'), 'utf8');
  const messages = fs.readFileSync(path.join(
    sidebarRoot, 'client/app/side/controllers/pages/ai-control/ai-control-messages.js',
  ), 'utf8');

  for (const source of [html, messages]) {
    assert.doesNotMatch(source, /AI-FREE COPILOT/);
    assert.doesNotMatch(source, /普通对话模式/);
    assert.doesNotMatch(source, /当前未连接浏览器/);
    assert.doesNotMatch(source, /个浏览器已连接/);
  }
  assert.match(html, /今天想一起完成什么？/);
  assert.match(messages, /直接描述你的目标即可。/);
});
