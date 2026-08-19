'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EditorError, createEditorStore } = require('../../../src/app/main/features/opencut/opencut-editor');

test('OpenCut editor creates, imports and edits a timeline', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencut-editor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createEditorStore(root, {
    probeFile: () => ({ kind: 'video', duration_ms: 4000, width: 1280, height: 720, fps: 24 }),
  });
  const media = path.join(root, 'clip.mp4');
  fs.writeFileSync(media, 'fake-video');

  const created = store.createProject('Demo', { width: 1280, height: 720, fps: 24 });
  assert.equal(created.name, 'Demo');
  assert.equal(store.listProjects().length, 1);
  assert.equal(store.openProject(created.id).id, created.id);

  const asset = store.importMedia(media);
  assert.equal(asset.kind, 'video');
  assert.equal(fs.existsSync(asset.path), true);

  const added = store.edit({ action: 'add', media_id: asset.id, duration_ms: 4000 });
  const clipId = added.clip.id;
  assert.match(added.summary, /放到/);
  assert.equal(added.duration_ms, 4000);

  const trimmed = store.edit({ action: 'trim', clip_id: clipId, duration_ms: 3000, in_ms: 200 });
  assert.equal(trimmed.clip.duration_ms, 3000);

  const split = store.edit({ action: 'split', clip_id: clipId, at_ms: 1000 });
  assert.equal(split.clip.left.duration_ms, 1000);
  const rightId = split.clip.right.id;

  const moved = store.edit({ action: 'move', clip_id: rightId, start_ms: 4000 });
  assert.equal(moved.clip.start_ms, 4000);

  assert.throws(() => store.edit({
    action: 'add', media_id: asset.id, start_ms: 3900, duration_ms: 500,
  }), EditorError);

  const deleted = store.edit({ action: 'delete', clip_id: rightId });
  assert.equal(deleted.clip.id, rightId);
  assert.equal(store.timeline().tracks[0].clips.length, 1);
});

test('OpenCut editor rejects unknown projects and workspace escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencut-missing-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opencut-workspace-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const store = createEditorStore(root);
  assert.throws(() => store.openProject('missing'), /工程不存在/);
  store.createProject('A');
  assert.throws(() => store.importMedia('../outside.mp4', { workspaceDir: workspace }), /超出 AI 工作区/);
});
