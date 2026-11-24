  let workspacePreviewRequestId = 0;
  let workspacePreviewFocus;

  function workspaceTextPreview(file) {
    const content = document.createElement('pre');
    let text = String(file.content || '');
    if (file.mimeType === 'application/json') {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
    }
    content.textContent = `${text}${file.truncated ? '\n\n…预览已截断' : ''}`;
    return content;
  }

  function workspacePreviewContent(file) {
    if (file.kind === 'image' && file.dataUrl) {
      const image = document.createElement('img');
      image.src = file.dataUrl;
      image.alt = file.name;
      return image;
    }
    if (['video', 'audio'].includes(file.kind) && file.dataUrl) {
      const media = document.createElement(file.kind);
      media.src = file.dataUrl;
      media.controls = true;
      media.preload = 'metadata';
      return media;
    }
    if (file.kind === 'text') return workspaceTextPreview(file);
    const message = document.createElement('p');
    message.textContent = file.previewTooLarge
      ? '文件体积超过应用内预览上限，仍可附加给 AI 或通过 run_command 处理。'
      : '该文件暂不支持直接预览，但可以附加给 AI，并通过 run_command 处理。';
    return message;
  }

  function configurePreviewZoom(image) {
    const tools = el('ai-chat-workspace-preview-tools');
    if (!tools || image.tagName !== 'IMG') return;
    let zoom = 1;
    let fittedWidth = 0;
    const setZoom = (value) => {
      fittedWidth ||= image.getBoundingClientRect().width;
      if (!image.naturalWidth || !fittedWidth) return;
      zoom = Math.min(4, Math.max(0.5, value));
      image.classList.toggle('is-zoomed', zoom !== 1);
      image.style.width = zoom === 1 ? '' : `${Math.round(fittedWidth * zoom)}px`;
      if (zoom === 1) fittedWidth = 0;
      reset.textContent = `${Math.round(zoom * 100)}%`;
      smaller.disabled = zoom <= 0.5;
      larger.disabled = zoom >= 4;
    };
    const smaller = chatActionButton('−', '缩小图片', () => setZoom(zoom - 0.25));
    const reset = chatActionButton('100%', '恢复适应窗口', () => setZoom(1));
    const larger = chatActionButton('+', '放大图片', () => setZoom(zoom + 0.25));
    tools.replaceChildren(smaller, reset, larger);
    tools.hidden = false;
  }

  function resetPreviewZoom() {
    const tools = el('ai-chat-workspace-preview-tools');
    if (!tools) return;
    tools.replaceChildren();
    tools.hidden = true;
  }

  function renderWorkspacePreview(file) {
    const body = el('ai-chat-workspace-preview-body');
    if (!body) return;
    const content = workspacePreviewContent(file);
    body.replaceChildren(content);
    content.addEventListener('error', () => {
      if (body.firstElementChild !== content) return;
      resetPreviewZoom();
      body.textContent = '无法解码此文件。';
    }, { once: true });
    configurePreviewZoom(content);
    el('ai-chat-workspace-preview-title').textContent = file.name || '文件预览';
    el('ai-chat-workspace-preview-meta').textContent = file.path ? `${file.path} · ${formatWorkspaceFileSize(file.size)}` : '';
  }

  function openChatScreenshot(dataUrl) {
    startWorkspacePreview();
    renderWorkspacePreview({ kind: 'image', dataUrl, name: '浏览器截图' });
  }

  function closeWorkspacePreview() {
    workspacePreviewRequestId += 1;
    const preview = el('ai-chat-workspace-preview');
    if (!preview || preview.hidden) return;
    preview.querySelector('video, audio')?.pause();
    const body = el('ai-chat-workspace-preview-body');
    if (body) body.innerHTML = '';
    preview.hidden = true;
    resetPreviewZoom();
    if (workspacePreviewFocus?.isConnected) workspacePreviewFocus.focus({ preventScroll: true });
    workspacePreviewFocus = null;
  }

  function startWorkspacePreview() {
    const requestId = ++workspacePreviewRequestId;
    const preview = el('ai-chat-workspace-preview');
    const body = el('ai-chat-workspace-preview-body');
    if (preview?.hidden) {
      workspacePreviewFocus = document.activeElement;
      preview.hidden = false;
    }
    resetPreviewZoom();
    if (body) body.textContent = '正在读取预览…';
    const title = el('ai-chat-workspace-preview-title');
    const meta = el('ai-chat-workspace-preview-meta');
    if (title) title.textContent = '文件预览';
    if (meta) meta.textContent = '';
    el('ai-chat-workspace-preview-close')?.focus();
    return { requestId, body };
  }

  function readWorkspacePreview(filePath, artifact, validateOnly = false) {
    const input = artifact ? { path: filePath, artifact, validateOnly } : { path: filePath };
    return window.aiFree?.ai?.workspaceRead?.(input);
  }

  function assertWorkspacePreviewResult(result) {
    if (!result?.ok) throw new Error(result?.message || '文件预览失败');
    return result.file || {};
  }

  async function previewWorkspaceFile(filePath, artifact) {
    const { requestId, body } = startWorkspacePreview();
    try {
      const file = assertWorkspacePreviewResult(await readWorkspacePreview(filePath, artifact));
      if (requestId !== workspacePreviewRequestId) return;
      renderWorkspacePreview(file);
    } catch (error) {
      if (requestId !== workspacePreviewRequestId) return;
      if (body) body.textContent = error?.message || String(error);
    }
  }

