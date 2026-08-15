  function formatWorkspaceFileSize(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function workspaceFileByPath(filePath) {
    return state.workspaceFiles.find((file) => String(file.path || '') === String(filePath || '')) || null;
  }

  function renderAttachmentChips() {
    const container = el('ai-chat-attachment-chips');
    if (!container) return;
    container.innerHTML = '';
    for (const filePath of state.attachmentPaths) {
      const chip = document.createElement('span');
      chip.className = 'ai-chat-attachment-chip';
      const label = document.createElement('span');
      label.textContent = workspaceFileByPath(filePath)?.name || filePath;
      label.title = filePath;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `移除 ${label.textContent}`);
      remove.addEventListener('click', () => toggleChatAttachment(filePath));
      chip.append(label, remove);
      container.appendChild(chip);
    }
    container.hidden = state.attachmentPaths.length === 0;
    syncSendState();
  }

  function toggleChatAttachment(filePath, force) {
    const pathValue = String(filePath || '').trim();
    if (!pathValue) return;
    const selected = state.attachmentPaths.includes(pathValue);
    const shouldSelect = force === undefined ? !selected : force;
    state.attachmentPaths = shouldSelect
      ? [...new Set([...state.attachmentPaths, pathValue])].slice(0, 16)
      : state.attachmentPaths.filter((item) => item !== pathValue);
    renderAttachmentChips();
    renderWorkspaceFiles();
  }

  function workspaceFileRow(file) {
    const row = document.createElement('article');
    row.className = 'ai-chat-workspace-file';
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'ai-chat-workspace-file-info';
    const name = document.createElement('strong');
    name.textContent = String(file.name || file.path || '文件');
    const detail = document.createElement('span');
    detail.textContent = `${file.path} · ${formatWorkspaceFileSize(file.size)}`;
    info.append(name, detail);
    info.addEventListener('click', () => previewWorkspaceFile(file.path));
    const attach = document.createElement('button');
    attach.type = 'button';
    attach.className = 'ai-chat-workspace-file-attach';
    const selected = state.attachmentPaths.includes(file.path);
    attach.textContent = selected ? '已附加' : '附加';
    attach.classList.toggle('is-selected', selected);
    attach.addEventListener('click', () => toggleChatAttachment(file.path));
    row.append(info, attach);
    return row;
  }

  function renderWorkspaceFiles() {
    const container = el('ai-chat-workspace-files');
    if (!container) return;
    container.innerHTML = '';
    if (!state.workspaceFiles.length) {
      const empty = document.createElement('p');
      empty.className = 'ai-chat-workspace-empty';
      empty.textContent = 'AI-Workspace 中暂无文件，可点击“上传文件”导入。';
      container.appendChild(empty);
      return;
    }
    state.workspaceFiles.forEach((file) => container.appendChild(workspaceFileRow(file)));
  }

  async function loadWorkspaceFiles() {
    const container = el('ai-chat-workspace-files');
    if (container) container.textContent = '正在读取工作文件…';
    try {
      const result = await window.aiFree?.ai?.workspaceList?.();
      if (!result?.ok) throw new Error(result?.message || '工作文件读取失败');
      state.workspaceFiles = Array.isArray(result.files) ? result.files : [];
      renderWorkspaceFiles();
    } catch (error) {
      if (container) container.textContent = error?.message || String(error);
    }
  }

  async function importWorkspaceFiles() {
    try {
      const result = await window.aiFree?.ai?.workspaceImport?.();
      if (!result?.ok) throw new Error(result?.message || '文件上传失败');
      const imported = Array.isArray(result.files) ? result.files : [];
      await loadWorkspaceFiles();
      imported.forEach((file) => toggleChatAttachment(file.path, true));
      if (imported.length) setStatus(`已上传并附加 ${imported.length} 个文件`, 'success');
    } catch (error) {
      setStatus(error?.message || String(error), 'warning');
    }
  }

  function renderWorkspacePreview(file) {
    const preview = el('ai-chat-workspace-preview');
    if (!preview) return;
    preview.innerHTML = '';
    const title = document.createElement('strong');
    title.textContent = `${file.name} · ${formatWorkspaceFileSize(file.size)}`;
    preview.appendChild(title);
    if (file.kind === 'image' && file.dataUrl) {
      const image = document.createElement('img');
      image.src = file.dataUrl;
      image.alt = file.name;
      preview.appendChild(image);
    } else if (file.kind === 'text') {
      const content = document.createElement('pre');
      content.textContent = `${file.content || ''}${file.truncated ? '\n\n…预览已截断' : ''}`;
      preview.appendChild(content);
    } else {
      const message = document.createElement('p');
      message.textContent = '该文件不支持文本预览，但可以附加给 AI，并通过 run_command 处理。';
      preview.appendChild(message);
    }
    preview.hidden = false;
  }

  async function previewWorkspaceFile(filePath) {
    const preview = el('ai-chat-workspace-preview');
    if (preview) { preview.hidden = false; preview.textContent = '正在读取预览…'; }
    try {
      const result = await window.aiFree?.ai?.workspaceRead?.({ path: filePath });
      if (!result?.ok) throw new Error(result?.message || '文件预览失败');
      renderWorkspacePreview(result.file || {});
    } catch (error) {
      if (preview) preview.textContent = error?.message || String(error);
    }
  }

  function currentMentionRange(input) {
    const cursor = Number(input?.selectionStart || 0);
    const before = String(input?.value || '').slice(0, cursor);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!match) return null;
    return { start: cursor - match[2].length - 1, end: cursor, query: match[2].toLowerCase() };
  }

  function mentionCandidates(query) {
    const localTools = [
      { name: 'windows_tab', description: '管理 AI-FREE 浏览器栏目' },
      { name: 'run_command', description: '读取和处理 AI-Workspace 文件' },
    ];
    const tools = [...localTools, ...state.mcpTools].map((tool) => ({
      type: 'mcp', label: String(tool.name || ''), reference: String(tool.name || ''),
      detail: String(tool.description || 'MCP 工具'),
    }));
    const files = state.workspaceFiles.map((file) => ({
      type: 'file', label: String(file.name || ''), reference: String(file.path || ''),
      detail: `${file.path}，${formatWorkspaceFileSize(file.size)}`,
    }));
    const seen = new Set();
    return [...tools, ...files].filter((item) => {
      const key = `${item.type}:${item.reference}`;
      if (!item.label || seen.has(key)) return false;
      seen.add(key);
      return !query || `${item.label} ${item.reference} ${item.detail}`.toLowerCase().includes(query);
    }).slice(0, 12);
  }

  function renderMentionMenu() {
    const input = el('ai-chat-input');
    const menu = el('ai-chat-mention-menu');
    if (!input || !menu) return;
    const range = currentMentionRange(input);
    const candidates = range ? mentionCandidates(range.query) : [];
    const active = Math.min(Number(menu.dataset.active || 0), Math.max(0, candidates.length - 1));
    menu.dataset.active = String(active);
    menu.innerHTML = '';
    if (!range || !candidates.length) { menu.hidden = true; return; }
    candidates.forEach((candidate, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = String(index);
      button.className = index === active ? 'is-active' : '';
      const type = candidate.type === 'file' ? '文件' : 'MCP';
      button.textContent = `${candidate.label}  ·  ${type}`;
      button.title = candidate.detail;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => selectChatMention(candidate, range));
      menu.appendChild(button);
    });
    menu._candidates = candidates;
    menu._range = range;
    menu.hidden = false;
  }

  function selectChatMention(candidate, range) {
    const input = el('ai-chat-input');
    if (!input || !candidate || !range) return;
    const token = `@${candidate.label}`;
    input.value = `${input.value.slice(0, range.start)}${token} ${input.value.slice(range.end)}`;
    const cursor = range.start + token.length + 1;
    input.setSelectionRange(cursor, cursor);
    state.chatMentions = [...state.chatMentions.filter((item) => (
      `${item.type}:${item.reference}` !== `${candidate.type}:${candidate.reference}`
    )), candidate].slice(-32);
    if (candidate.type === 'file') toggleChatAttachment(candidate.reference, true);
    el('ai-chat-mention-menu').hidden = true;
    resizeInput();
    syncSendState();
    input.focus();
  }

  function handleChatMentionKey(event) {
    const menu = el('ai-chat-mention-menu');
    if (!menu || menu.hidden) return false;
    const candidates = menu._candidates || [];
    let active = Number(menu.dataset.active || 0);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length;
      menu.dataset.active = String(active);
      renderMentionMenu();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectChatMention(candidates[active], menu._range);
      return true;
    }
    if (event.key === 'Escape') { event.preventDefault(); menu.hidden = true; return true; }
    return false;
  }

  function hasSelectedChatAttachments() {
    return state.attachmentPaths.length > 0;
  }

  function takeChatAttachmentContext(content = '') {
    const text = String(content || '');
    const activeMentions = state.chatMentions.filter((item) => text.includes(`@${item.label}`));
    const result = { attachmentPaths: [...state.attachmentPaths], mentions: activeMentions };
    state.attachmentPaths = [];
    state.chatMentions = [];
    renderAttachmentChips();
    return result;
  }

  function bindChatWorkspace() {
    el('ai-chat-attach')?.addEventListener('click', () => {
      const panel = el('ai-chat-workspace-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) void loadWorkspaceFiles();
    });
    el('ai-chat-workspace-close')?.addEventListener('click', () => { el('ai-chat-workspace-panel').hidden = true; });
    el('ai-chat-workspace-refresh')?.addEventListener('click', loadWorkspaceFiles);
    el('ai-chat-workspace-upload')?.addEventListener('click', importWorkspaceFiles);
    void loadWorkspaceFiles();
  }
