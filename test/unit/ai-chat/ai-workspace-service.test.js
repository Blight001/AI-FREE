'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAttachmentMessages,
  createAiWorkspaceService,
} = require('../../../src/app/main/features/ai-chat/ai-workspace-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-workspace-'));
  const source = path.join(root, '..', `${path.basename(root)}-source.txt`);
  fs.writeFileSync(source, 'fixture content', 'utf8');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(source, { force: true });
  });
  return { root, source };
}

test('工作区服务导入、列出并预览文本文件', async (t) => {
  const { root, source } = fixture(t);
  const dialogCalls = [];
  const service = createAiWorkspaceService({
    workspaceDir: root,
    dialog: {
      showOpenDialog: async (options) => {
        dialogCalls.push(options);
        return { canceled: false, filePaths: [source] };
      },
    },
  });
  const imported = await service.importFiles();
  assert.equal(imported.ok, true);
  assert.equal(imported.files[0].path.startsWith('Uploads/'), true);
  assert.equal(dialogCalls[0].properties.includes('multiSelections'), true);
  const listed = service.list();
  assert.equal(listed.files.some((file) => file.path === imported.files[0].path), true);
  const preview = service.read({ path: imported.files[0].path });
  assert.equal(preview.file.kind, 'text');
  assert.equal(preview.file.content, 'fixture content');
  assert.throws(() => service.read({ path: '../outside.txt' }), /超出 AI 工作区|不存在/);
});

test('附件上下文包含文本、图片和 MCP 引用且使用临时标记', (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'notes.md'), '项目说明', 'utf8');
  fs.writeFileSync(path.join(root, 'pixel.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const messages = buildAttachmentMessages(root, ['notes.md', 'pixel.png'], [{
    type: 'mcp', label: 'run_command', reference: 'run_command', detail: '处理文件',
  }]);
  assert.equal(messages.every((message) => message.ai_free_attachment_context === true), true);
  assert.match(messages[0].content, /项目说明/);
  assert.match(messages[0].content, /@run_command/);
  assert.equal(messages[1].content[1].type, 'image_url');
  assert.match(messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('工作区预览支持视频、JSON 和无扩展名文本识别', (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'clip.mp4'), Buffer.from('video fixture'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"enabled":true}', 'utf8');
  fs.writeFileSync(path.join(root, 'README'), 'plain text without extension', 'utf8');
  const service = createAiWorkspaceService({ workspaceDir: root });
  const video = service.read({ path: 'clip.mp4' }).file;
  assert.equal(video.kind, 'video');
  assert.equal(video.mimeType, 'video/mp4');
  assert.match(video.dataUrl, /^data:video\/mp4;base64,/);
  assert.equal(service.read({ path: 'settings.json' }).file.mimeType, 'application/json');
  assert.equal(service.read({ path: 'README' }).file.kind, 'text');
});
