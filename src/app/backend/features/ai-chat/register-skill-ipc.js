'use strict';

const { skillsDirectory, readSkill, listSkills, skillError } = require('../../platform/workspace-skills');
const { AppError, ok, fail } = require('../../../contracts/ipc-result');

function fromFrame(event, contents) {
  return contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
}

function registerSkillIpc(ipc, deps) {
  const sidebar = () => deps.getSideView?.()?.webContents;
  const directory = () => skillsDirectory(deps.aiSandboxDir);
  function authorize(homeOnly, callback) {
    return async (event, input) => {
      if (!fromFrame(event, deps.getMainWindow?.()?.webContents) && (homeOnly || !fromFrame(event, sidebar()))) {
        return fail(new AppError('SKILL_FORBIDDEN', '当前页面无法访问技能库'));
      }
      try { return ok(await callback(input)); } catch (error) { return fail(skillError(error)); }
    };
  }
  const disposers = [
    ipc.handle('ai-skill-list', authorize(false, () => listSkills(directory()))),
    ipc.handle('ai-skill-read', authorize(false, input => readSkill(directory(), input.name, input.digest))),
    ipc.handle('ai-skill-open-directory', authorize(true, async () => {
      if (await deps.openDirectory(directory())) throw new AppError('SKILL_IO', '无法打开技能目录');
      return {};
    })),
    ipc.handle('ai-skill-create-draft', authorize(true, () => {
      const skill = readSkill(directory(), 'create-skill');
      deps.showBenchmarkSidebar();
      const contents = sidebar();
      if (!contents || contents.isDestroyed() || contents.isLoadingMainFrame()) throw new AppError('SKILL_SIDEBAR_BUSY', '侧栏正在加载，请稍后再试');
      contents.send('ai-skill-draft-selected', { name: skill.name, title: skill.title, digest: skill.digest });
      return {};
    })),
  ];
  return () => disposers.forEach(dispose => dispose());
}

module.exports = { registerSkillIpc };
