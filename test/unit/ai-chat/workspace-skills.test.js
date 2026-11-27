'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { skillsDirectory, listSkills, readSkill } = require('../../../src/app/backend/platform/workspace-skills');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-skill-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('新工作区提供创建模板，刷新保留自定义正文并拒绝失效引用', t => {
  const work = workspace(t);
  const root = skillsDirectory(work);
  const [initial] = listSkills(root);
  assert.equal(initial.title, '添加技能');
  assert.equal(initial.body, undefined);
  const entry = path.join(root, initial.name, 'SKILL.md');
  fs.appendFileSync(entry, '\n定制内容');
  assert.throws(() => readSkill(root, initial.name, initial.digest), { code: 'SKILL_CHANGED' });
  assert.match(readSkill(skillsDirectory(work), initial.name).body, /定制内容/);
});
test('错误技能独立报告，拒绝目录穿越或工作区外的链接', t => {
  const work = workspace(t);
  const root = skillsDirectory(work);
  fs.mkdirSync(path.join(root, 'empty'));
  fs.symlinkSync(work, path.join(root, 'outside'), 'junction');
  const items = listSkills(root);
  assert.equal(items.filter(item => item.error).length, 2);
  assert.throws(() => readSkill(root, '../outside'), { code: 'SKILL_INVALID' });
  assert.ok(items.find(item => item.digest));
});
