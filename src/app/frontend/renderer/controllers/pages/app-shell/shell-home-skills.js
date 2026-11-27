(() => {
  const id = name => document.getElementById(name);
  const panel = id('home-skills');
  const api = window.aiFree?.ai;
  let revision = 0;
  let selected = '';
  async function request(promise) {
    if (!promise) throw new Error('AI 控制页面尚未就绪');
    const result = await promise;
    if (!result?.ok) throw new Error(result?.error?.message || '技能库请求失败');
    return result.data;
  }
  function action(run) {
    return () => run().catch(error => { id('skill-status').textContent = error.message; });
  }
  async function preview(item) {
    const ticket = ++revision;
    selected = item.name;
    id('skill-preview-title').textContent = item.title || item.name;
    id('skill-preview-body').textContent = item.error || '';
    if (item.error) return;
    const skill = await request(api?.readSkill?.({ name: item.name, digest: item.digest }));
    if (revision === ticket) id('skill-preview-body').textContent = skill.body;
  }
  function row(item) {
    const button = document.createElement('button');
    const title = document.createElement('strong');
    title.textContent = item.title || item.name;
    const detail = document.createElement('small');
    detail.textContent = item.error ? item.name + '/SKILL.md · ' + item.error : item.description;
    button.append(title, detail);
    button.addEventListener('click', action(() => preview(item)));
    return button;
  }
  async function refresh() {
    const ticket = ++revision;
    const items = await request(api?.listSkills?.());
    if (panel.hidden || revision !== ticket) return;
    id('skill-status').textContent = items.length ? '' : '技能目录为空';
    id('skill-library-list').replaceChildren(...items.map(row));
    const next = items.find(item => item.name === selected) || items[0];
    if (next) await preview(next);
    else id('skill-preview-body').textContent = '';
  }
  id('skill-refresh').addEventListener('click', action(refresh));
  id('skill-create').addEventListener('click', action(() => request(api?.createSkillDraft?.())));
  id('skill-directory').addEventListener('click', action(() => request(api?.openSkillsDirectory?.())));
  const observer = new MutationObserver(() => { if (!panel.hidden) action(refresh)(); });
  window.AppShellSkills = Object.freeze({ bind() {
    if (!panel.hidden) action(refresh)();
    observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  } });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
})();
