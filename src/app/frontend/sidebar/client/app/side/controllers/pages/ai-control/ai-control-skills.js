const chatSkills = (() => {
  const selected = new Map();
  let catalog = [];
  let generation = 0;
  function renderChips() {
    const box = el('ai-skill-chips');
    box.replaceChildren();
    for (const item of selected.values()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-chat-attachment-chip';
      chip.textContent = '技能 · ' + item.title + ' ×';
      chip.setAttribute('aria-label', '移除技能 ' + item.title);
      chip.onclick = () => { selected.delete(item.name); renderChips(); syncSendState(); };
      box.append(chip);
    }
    box.hidden = !selected.size;
  }
  function close() {
    generation++;
    el('ai-skill-picker').hidden = true;
  }
  function select(item) {
    if (state.loading || managedChatUi.view) { setStatus('请在可编辑的对话中引用技能', 'warning'); return; }
    selected.set(item.name, item);
    close();
    renderChips();
    syncSendState();
    focusElement(el('ai-chat-input'));
  }
  function emptyState(title, detail) {
    const empty = document.createElement('div');
    empty.className = 'ai-skill-empty';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const message = document.createElement('p');
    message.textContent = detail;
    empty.append(heading, message);
    return empty;
  }

  function skillOption(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-skill-option';
    button.setAttribute('aria-pressed', String(selected.has(item.name)));
    const title = document.createElement('strong');
    title.textContent = item.title;
    const description = document.createElement('small');
    description.textContent = item.description;
    const status = document.createElement('span');
    status.className = 'ai-skill-option-status';
    status.textContent = selected.has(item.name) ? '已选择' : '选择';
    button.append(title, description, status);
    button.onclick = () => select(item);
    return button;
  }

  function renderResults() {
    const query = el('ai-skill-search').value.trim().toLowerCase();
    const list = el('ai-skill-results');
    const validItems = catalog.filter(item => !item.error);
    const matches = validItems.filter(item => [item.name, item.title, item.description].join(' ').toLowerCase().includes(query));
    list.replaceChildren(...matches.map(skillOption));
    if (matches.length) return;
    list.append(validItems.length
      ? emptyState('没有找到匹配技能', '试试缩短关键词，或搜索技能的用途。')
      : emptyState('还没有可用技能', '请先在首页「技能库」中创建技能，或检查格式有误的文件。'));
  }

  async function open() {
    el('ai-chat-workspace-panel').hidden = true;
    const ticket = ++generation;
    el('ai-skill-picker').hidden = false;
    el('ai-skill-search').value = '';
    el('ai-skill-search').focus();
    catalog = [];
    const list = el('ai-skill-results');
    list.textContent = '读取中…';
    try {
      const result = await window.aiFree.ai.listSkills();
      if (ticket !== generation) return;
      if (!result.ok) throw new Error(result.error.message);
      catalog = result.data;
      renderResults();
    } catch (error) { if (ticket === generation) list.textContent = error.message; }
  }
  async function resolve() {
    return Promise.all([...selected.values()].map(async ({ name, digest }) => {
      const result = await window.aiFree.ai.readSkill({ name, digest });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    }));
  }
  function bind() {
    el('ai-chat-add-skill')?.addEventListener('click', open);
    el('ai-skill-search')?.addEventListener('input', renderResults);
    el('ai-skill-close')?.addEventListener('click', close);
    el('ai-chat-attach')?.addEventListener('click', close);
    el('ai-skill-picker')?.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); el('ai-chat-attach').focus(); }
    });
    const off = window.aiFree?.ai?.onSkillDraftSelected?.(select);
    if (off) window.addEventListener('pagehide', off, { once: true });
  }
  return { bind, resolve, hasSelection: () => selected.size > 0,
    signature: () => JSON.stringify([...selected.values()].map(item => item.digest)),
    clear() { selected.clear(); close(); renderChips(); } };
})();

