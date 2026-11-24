'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAiChatHistoryRepository } = require('../../../src/app/backend/features/ai-chat/history-repository');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-history-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createAiChatHistoryRepository({
    historyRootDir: root,
    accountScope: ({ username } = {}) => username || 'anonymous',
    now: (() => { let tick = 100; return () => ++tick; })(),
    randomUUID: (() => { let id = 0; return () => `generated-${++id}`; })(),
  });
  return { root, repository };
}

function sessionFiles(root, scope = 'alice') {
  return path.join(root, scope, 'sessions');
}

test('索引只保留摘要，读取和更新单条对话不触碰其他对话文件', (t) => {
  const { root, repository } = createFixture(t);
  repository.saveSession({ username: 'alice' }, {
    id: 'large/id:1', title: '第一条', messages: [{ role: 'user', content: 'secret-one' }],
  });
  repository.saveSession({ username: 'alice' }, {
    id: 'second', title: '第二条', messages: [{ role: 'user', content: 'secret-two' }],
  });

  const indexPath = path.join(root, 'alice', 'index.json');
  const indexBefore = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(indexBefore.sessions.length, 2);
  assert.equal(indexBefore.sessions.some((item) => Object.hasOwn(item, 'messages')), false);
  assert.doesNotMatch(fs.readFileSync(indexPath, 'utf8'), /\"messages\"/);

  const files = fs.readdirSync(sessionFiles(root, 'alice')).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 2);
  assert.equal(files.some((name) => name.includes('large')), false);
  const untouched = files.find((name) => !fs.readFileSync(path.join(sessionFiles(root), name), 'utf8').includes('secret-one'));
  const untouchedPath = path.join(sessionFiles(root), untouched);
  const before = fs.readFileSync(untouchedPath, 'utf8');

  const loaded = repository.getSession({ username: 'alice' }, 'large/id:1', { setCurrent: false });
  assert.equal(loaded.session.messages[0].content, 'secret-one');
  repository.saveSession({ username: 'alice' }, {
    id: 'large/id:1', title: '更新标题', messages: [{ role: 'user', content: 'new-secret' }],
  });
  assert.equal(fs.readFileSync(untouchedPath, 'utf8'), before);
  assert.equal(repository.listSessions({ username: 'alice' }).sessions[0].title, '更新标题');
});

test('旧版单文件历史幂等迁移，原文件保留且选中对话不重写正文', (t) => {
  const { root, repository } = createFixture(t);
  const legacyPath = path.join(root, 'alice.json');
  const legacy = {
    version: 1,
    currentId: 'legacy-one',
    sessions: [
      { id: 'legacy-one', title: '旧记录', messages: [{ role: 'user', content: 'legacy-secret' }] },
      { id: 'legacy-two', title: '另一条', messages: [{ role: 'assistant', content: 'answer' }] },
    ],
  };
  const original = JSON.stringify(legacy);
  fs.writeFileSync(legacyPath, original, 'utf8');

  const first = repository.listSessions({ username: 'alice' });
  const bodyPath = fs.readdirSync(sessionFiles(root)).map((name) => path.join(sessionFiles(root), name))
    .find((file) => fs.readFileSync(file, 'utf8').includes('legacy-secret'));
  const bodyBefore = fs.readFileSync(bodyPath, 'utf8');
  assert.equal(first.sessions.length, 2);
  assert.equal(first.currentId, 'legacy-one');
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), original);

  repository.listSessions({ username: 'alice' });
  repository.getSession({ username: 'alice' }, 'legacy-two', { setCurrent: false });
  assert.equal(fs.readFileSync(bodyPath, 'utf8'), bodyBefore);
  assert.equal(repository.listSessions({ username: 'alice' }).currentId, 'legacy-one');
});

test('损坏索引可从会话文件重建，且损坏的旧历史不会被当作空数据覆盖', (t) => {
  const { root, repository } = createFixture(t);
  repository.saveSession({ username: 'alice' }, {
    id: 'recover-me', messages: [{ role: 'user', content: 'preserved' }],
  });
  fs.writeFileSync(path.join(root, 'alice', 'index.json'), '{broken', 'utf8');
  assert.equal(repository.listSessions({ username: 'alice' }).sessions[0].id, 'recover-me');

  const legacyPath = path.join(root, 'bob.json');
  fs.writeFileSync(legacyPath, '{broken', 'utf8');
  assert.throws(() => repository.listSessions({ username: 'bob' }), { code: 'AI_HISTORY_MIGRATION_READ_FAILED' });
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(root, 'bob', 'index.json')), false);
});

test('按账号隔离的独立会话不互相覆盖', (t) => {
  const { repository } = createFixture(t);
  repository.saveSession({ username: 'alice' }, { id: 'same', messages: [{ role: 'user', content: 'A' }] });
  repository.saveSession({ username: 'bob' }, { id: 'same', messages: [{ role: 'user', content: 'B' }] });
  assert.equal(repository.getSession({ username: 'alice' }, 'same').session.messages[0].content, 'A');
  assert.equal(repository.getSession({ username: 'bob' }, 'same').session.messages[0].content, 'B');
});

test('中断迁移可续跑，删除后即使索引丢失也不会从旧文件复活', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-history-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyFile = path.join(root, 'alice.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, currentId: 'remove-me', sessions: [
    { id: 'remove-me', messages: [{ role: 'user', content: 'deleted body' }] },
    { id: 'keep-me', messages: [{ role: 'user', content: 'kept body' }] },
  ] }));
  const originalFs = fs;
  let failIndexOnce = true;
  const failingFs = new Proxy(originalFs, {
    get(target, key) {
      if (key === 'renameSync') return (source, destination) => {
        if (failIndexOnce && String(destination).endsWith(`${path.sep}index.json`)) {
          failIndexOnce = false;
          const error = new Error('injected index failure');
          error.code = 'EIO';
          throw error;
        }
        return target.renameSync(source, destination);
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const options = {
    historyRootDir: root,
    fs: failingFs,
    accountScope: () => 'alice',
    now: () => 10,
    randomUUID: () => 'generated',
  };
  const interrupted = createAiChatHistoryRepository(options);
  assert.throws(() => interrupted.listSessions({}), { code: 'AI_HISTORY_MIGRATION_INDEX_FAILED' });
  assert.equal(fs.readFileSync(legacyFile, 'utf8').includes('deleted body'), true);

  const resumed = createAiChatHistoryRepository({ ...options, fs });
  assert.deepEqual(resumed.listSessions({}).sessions.map((item) => item.id).sort(), ['keep-me', 'remove-me']);
  assert.equal(resumed.listSessions({}).currentId, 'remove-me');
  assert.equal(resumed.getSession({}, 'keep-me', { setCurrent: false }).ok, true);
  assert.equal(resumed.listSessions({}).currentId, 'remove-me');
  assert.equal(resumed.deleteSession({}, 'remove-me').ok, true);
  fs.unlinkSync(path.join(root, 'alice', 'index.json'));
  const recovered = resumed.listSessions({});
  assert.deepEqual(recovered.sessions.map((item) => item.id), ['keep-me']);
  assert.equal(recovered.currentId, 'keep-me');
  assert.equal(fs.readFileSync(legacyFile, 'utf8').includes('deleted body'), true);
});
