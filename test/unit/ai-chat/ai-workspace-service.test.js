'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAttachmentMessages,
  buildInlineAttachmentMessages,
  createAiWorkspaceService,
  createDownloadArtifact,
  inspectWorkspaceFileSync,
  verifyWorkspaceArtifactSync,
} = require('../../../src/app/backend/features/ai-chat/ai-workspace-service');

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

test('粘贴文件导入工作区并在正文标记处内联图片或文本内容', (t) => {
  const { root } = fixture(t);
  const service = createAiWorkspaceService({ workspaceDir: root });
  const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const imported = service.importPastedFiles([
    { name: 'clipboard.png', data: imageBytes.toString('base64') },
    { name: 'notes.txt', data: Buffer.from('文本文件内容').toString('base64') },
  ]);
  assert.equal(imported.files.length, 2);
  const message = {
    role: 'user',
    content: '把这个图片【图片：clipboard.png】，放到这个文件里面【文件：notes.txt】',
    inlineAttachments: [
      { path: imported.files[0].path, marker: '【图片：clipboard.png】' },
      { path: imported.files[1].path, marker: '【文件：notes.txt】' },
    ],
  };
  const [built] = buildInlineAttachmentMessages(root, [message]);
  assert.equal(built.content[0].text, '把这个图片');
  assert.equal(built.content[1].type, 'image_url');
  assert.equal(built.content[2].text, '，放到这个文件里面');
  assert.match(built.content[3].text, /文本文件内容/);
  assert.throws(() => service.importPastedFiles([{ name: '../escape.txt', data: 'not-base64!' }]), /内容无效/);
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
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

function downloadResult(data, relativePath = 'media/pixel.png') {
  return {
    success: true, action: 'download_element', relative_path: relativePath,
    size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
}

function mediaArtifact(result) {
  return createDownloadArtifact({ toolName: 'browser_media', action: 'download', toolCallId: 'download-1', result });
}

test('only successful downloads with a safe relative path and a digest produce artifact metadata', () => {
  const result = downloadResult(Buffer.from('fixture'), 'media\\pixel.png');
  const artifact = mediaArtifact({ ...result, absolute_path: 'not persisted', final_url: 'not persisted' });
  assert.deepEqual(artifact, {
    path: 'media/pixel.png', name: 'pixel.png', kind: 'image', size: result.size,
    sha256: result.sha256, toolName: 'browser_media', toolCallId: 'download-1',
  });
  for (const bad of [
    { success: false }, { action: 'save_session' }, { action: 'upload' }, { relative_path: '../outside.png' },
    { relative_path: 'C:\\outside.png' }, { relative_path: '/root.txt' }, { sha256: '' }, { size: 2 ** 31 },
  ]) {
    assert.equal(mediaArtifact({ ...result, ...bad }), null);
  }
  assert.equal(createDownloadArtifact({ toolName: 'browser_file', action: 'save_session', result, toolCallId: 'session' }), null);
  assert.equal(createDownloadArtifact({ toolName: 'custom_tool', action: 'download', result, toolCallId: 'external' }), null);
});

test('preview, reattach, chat and upload checks all reject same-size replacement and missing files', (t) => {
  const { root } = fixture(t);
  const original = Buffer.from('old png fixture');
  const file = path.join(root, 'pixel.png');
  const result = downloadResult(original, 'pixel.png');
  const artifact = mediaArtifact(result);
  const service = createAiWorkspaceService({ workspaceDir: root });
  const input = { path: artifact.path, artifact };
  fs.writeFileSync(file, original);
  assert.equal(service.read(input).file.dataUrl, `data:image/png;base64,${original.toString('base64')}`);
  assert.equal(service.read({ ...input, validateOnly: true }).file.dataUrl, undefined);
  assert.equal(verifyWorkspaceArtifactSync(root, artifact).sha256, artifact.sha256);
  assert.equal(buildAttachmentMessages(root, [artifact.path], [], [artifact])[0].content[1].image_url.url,
    `data:image/png;base64,${original.toString('base64')}`);
  assert.equal(service.read({ ...input, path: 'another.png' }).error.code, 'ARTIFACT_INVALID');
  assert.throws(() => buildAttachmentMessages(root, [], [], [artifact]), { code: 'ARTIFACT_INVALID' });
  const before = inspectWorkspaceFileSync(root, artifact.path);
  fs.writeFileSync(file, 'new png fixture');
  assert.notEqual(inspectWorkspaceFileSync(root, artifact.path).sha256, before.sha256);
  assert.equal(service.read(input).error.code, 'ARTIFACT_CHANGED');
  assert.equal(service.read({ ...input, validateOnly: true }).error.code, 'ARTIFACT_CHANGED');
  assert.throws(() => verifyWorkspaceArtifactSync(root, artifact), { code: 'ARTIFACT_CHANGED' });
  assert.throws(() => buildAttachmentMessages(root, [artifact.path], [], [artifact]), { code: 'ARTIFACT_CHANGED' });
  fs.renameSync(file, path.join(root, 'moved.png'));
  assert.equal(service.read(input).error.code, 'ARTIFACT_UNAVAILABLE');
});

test('a removed file mention cannot send attachment content or path metadata', (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'fixture data');
  const mention = { type: 'file', label: 'secret.txt', reference: 'secret.txt', detail: 'fixture metadata' };
  assert.deepEqual(buildAttachmentMessages(root, [], [mention]), []);
});

test('an artifact cannot be reattached through a junction or directory symlink outside the workspace', (t) => {
  const { root, source } = fixture(t);
  const outside = fs.mkdtempSync(path.join(root, '..', 'ai-free-artifact-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.copyFileSync(source, path.join(outside, 'fixture.txt'));
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const artifact = mediaArtifact(downloadResult(fs.readFileSync(source), 'linked/fixture.txt'));
  assert.throws(() => verifyWorkspaceArtifactSync(root, artifact), { code: 'ARTIFACT_CHANGED' });
  assert.throws(() => inspectWorkspaceFileSync(root, artifact.path), { code: 'ARTIFACT_CHANGED' });
});
