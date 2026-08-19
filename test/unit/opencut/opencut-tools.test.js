'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createEditorStore } = require('../../../src/app/main/features/opencut/opencut-editor');
const { createOpenCutTools } = require('../../../src/app/main/features/opencut/opencut-tools');

function createFakeHost() {
  let running = false;
  return {
    start: async () => {
      running = true;
      return { running, url: 'http://127.0.0.1:5173/', summary: 'started' };
    },
    stop: () => {
      running = false;
      return { running };
    },
    status: () => ({ running, url: running ? 'http://127.0.0.1:5173/' : '' }),
  };
}

test('OpenCut tool catalog names and create flow', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencut-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const editor = createEditorStore(root, {
    probeFile: () => ({ kind: 'video', duration_ms: 1000, width: 64, height: 64, fps: 30 }),
  });
  const tools = createOpenCutTools({ editor, host: createFakeHost(), workspaceDir: root });
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes('opencut.project.create'));
  assert.ok(names.includes('opencut.timeline.edit'));
  assert.ok(names.every((name) => name.includes('.')));

  const created = await tools.execute('opencut.project.create', { name: 'A' });
  assert.match(created.summary, /已创建/);
  const media = path.join(root, 'a.mp4');
  fs.writeFileSync(media, 'x');
  const asset = await tools.execute('opencut.media.import', { path: media });
  const edited = await tools.execute('opencut.timeline.edit', {
    action: 'add', media_id: asset.id, duration_ms: 1000,
  });
  assert.equal(edited.duration_ms, 1000);
  const listed = await tools.execute('opencut.project.list', {});
  assert.equal(listed.projects.length, 1);
  await assert.rejects(() => tools.execute('order.query', {}), /未知的 OpenCut 工具/);
});
