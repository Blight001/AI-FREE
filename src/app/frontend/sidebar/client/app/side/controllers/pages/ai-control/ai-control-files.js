  const draftFileArtifacts = new Map();
  let workspaceDraftSessionId;

  function fileKindLabel(file) {
    return file?.type?.startsWith('image/') || String(file?.name || '').match(/\.(png|jpe?g|gif|webp)$/i)
      ? '图片' : '文件';
  }

  function formatWorkspaceFileSize(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderAttachmentChips() {
    const container = el('ai-chat-attachment-chips');
    if (!container) return;
    container.innerHTML = '';
    for (const filePath of state.attachmentPaths) {
      const chip = document.createElement('span');
      chip.className = 'ai-chat-attachment-chip';
      const label = document.createElement('span');
      label.textContent = `附加 · ${filePath}`;
      label.title = `${filePath}（发送时供 AI 读取）`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `移除附件 ${filePath}`);
      remove.addEventListener('click', () => toggleChatAttachment(filePath));
      chip.append(label, remove);
      container.appendChild(chip);
    }
    container.hidden = state.attachmentPaths.length === 0;
    syncSendState();
  }

  function toggleChatAttachment(filePath, force, artifact) {
    syncWorkspaceDraftSession();
    const pathValue = String(filePath || '').trim();
    if (!pathValue) return;
    const selected = state.attachmentPaths.includes(pathValue);
    const shouldSelect = force === undefined ? !selected : force;
    if (shouldSelect && !selected && state.attachmentPaths.length >= 16) {
      setStatus('每条消息最多附加 16 个文件', 'warning');
      return false;
    }
    if (shouldSelect) {
      if (!selected) state.attachmentPaths.push(pathValue);
      if (artifact) draftFileArtifacts.set(pathValue, artifact);
    } else {
      state.attachmentPaths = state.attachmentPaths.filter((item) => item !== pathValue);
      draftFileArtifacts.delete(pathValue);
    }
    renderAttachmentChips();
    renderWorkspaceFiles();
    return true;
  }

  function syncWorkspaceDraftSession() {
    const id = state.currentSession?.id || '';
    if (workspaceDraftSessionId !== undefined && workspaceDraftSessionId !== id) {
      state.attachmentPaths = [];
      state.chatMentions = [];
      const input = el('ai-chat-input');
      if (input?.querySelector(inlineChatChip)) {
        input.querySelectorAll(inlineChatChip).forEach((chip) => chip.remove());
        syncChatDraftPlaceholder(input);
        resizeInput();
      }
      chatSkills.clear();
      draftFileArtifacts.clear();
      closeWorkspacePreview();
      renderAttachmentChips();
      renderWorkspaceFiles();
    }
    workspaceDraftSessionId = id;
  }

  function workspaceFileRow(file) {
    const row = document.createElement('article');
    row.className = 'ai-chat-workspace-file';
    const info = document.createElement('div');
    info.className = 'ai-chat-workspace-file-info';
    const name = document.createElement('strong');
    name.textContent = String(file.name || file.path || '文件');
    const detail = document.createElement('span');
    detail.textContent = `${file.path} · ${formatWorkspaceFileSize(file.size)}`;
    info.append(name, detail);
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'ai-chat-workspace-file-preview';
    preview.title = `预览 ${name.textContent}`;
    preview.setAttribute('aria-label', preview.title);
    preview.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.7"></circle></svg>';
    preview.addEventListener('click', () => previewWorkspaceFile(file.path));
    const attach = document.createElement('button');
    attach.type = 'button';
    attach.className = 'ai-chat-workspace-file-attach';
    const selected = state.attachmentPaths.includes(file.path);
    attach.textContent = selected ? '已附加' : '附加';
    attach.classList.toggle('is-selected', selected);
    attach.addEventListener('click', () => toggleChatAttachment(file.path));
    row.append(info, preview, attach);
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

  async function attachWorkspaceArtifact(artifact, button) {
    const sessionId = state.currentSession?.id;
    button.disabled = true;
    try {
      assertWorkspacePreviewResult(await readWorkspacePreview(artifact.path, artifact, true));
      if (state.currentSession?.id !== sessionId || !button.isConnected) return;
      if (toggleChatAttachment(artifact.path, true, artifact)) el('ai-chat-input')?.focus();
    } catch (error) {
      if (state.currentSession?.id === sessionId && button.isConnected) setStatus(error.message, 'warning');
    } finally {
      button.disabled = false;
    }
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
    const range = chatDraftMention(input);
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
      button.textContent = candidate.type === 'file'
        ? `${candidate.reference} · 附加文件`
        : `${candidate.label} · MCP`;
      button.title = candidate.detail;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => selectChatMention(candidate, range.range));
      menu.appendChild(button);
    });
    menu._candidates = candidates;
    menu._range = range.range;
    menu.hidden = false;
  }

  function selectChatMention(candidate, range) {
    const input = el('ai-chat-input');
    if (!input || !candidate || !range) return;
    const isFile = candidate.type === 'file';
    if (isFile && !toggleChatAttachment(candidate.reference, true)) return;
    const token = isFile ? '' : `@${candidate.label} `;
    replaceChatDraftSelection(range, token);
    if (!isFile) {
      state.chatMentions = [...state.chatMentions.filter((item) => item.reference !== candidate.reference), candidate].slice(-32);
    }
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
    return state.attachmentPaths.length > 0 || chatSkills.hasSelection();
  }

  function takeChatAttachmentContext(content = '', inlineAttachments = []) {
    const text = String(content || '');
    const activeMentions = state.chatMentions.filter((item) => item.type !== 'file' && text.includes(`@${item.label}`));
    const attachmentPaths = [...state.attachmentPaths];
    const artifactReferences = attachmentPaths.map((filePath) => draftFileArtifacts.get(filePath)).filter(Boolean);
    const result = { attachmentPaths, artifactReferences, mentions: activeMentions };
    if (inlineAttachments.length) result.inlineAttachments = inlineAttachments;
    state.attachmentPaths = [];
    state.chatMentions = [];
    draftFileArtifacts.clear();
    renderAttachmentChips();
    renderWorkspaceFiles();
    return result;
  }

  function bindChatWorkspace() {
    el('ai-chat-input')?.addEventListener('paste', pasteChatDraft);
    el('ai-chat-attach')?.addEventListener('click', () => {
      const panel = el('ai-chat-workspace-panel');
      panel.hidden = !panel.hidden;
    });
    el('ai-chat-workspace-close')?.addEventListener('click', () => { el('ai-chat-workspace-panel').hidden = true; });
    el('ai-chat-workspace-refresh')?.addEventListener('click', loadWorkspaceFiles);
    el('ai-chat-workspace-upload')?.addEventListener('click', async () => {
      el('ai-chat-workspace-panel').hidden = true;
      await importWorkspaceFiles();
    });
    chatSkills.bind();
    el('ai-chat-workspace-preview-close')?.addEventListener('click', closeWorkspacePreview);
    document.querySelector('[data-workspace-preview-close]')?.addEventListener('click', closeWorkspacePreview);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !el('ai-chat-workspace-preview')?.hidden) closeWorkspacePreview();
    });
  }
