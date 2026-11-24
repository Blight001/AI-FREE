  function formatTurnDuration(durationMs) {
    const seconds = Math.floor(durationMs / 1000);
    if (!seconds) return '用时不到 1 秒';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const parts = [];
    if (hours) parts.push(hours + ' 小时');
    if (minutes) parts.push(minutes + ' 分钟');
    if (seconds % 60) parts.push(seconds % 60 + ' 秒');
    return '用时 ' + parts.join(' ');
  }

  const chatDisclosures = new WeakMap();

  function preservePausedDisclosures(row, previousRow) {
    for (const selector of ['.ai-chat-activity', '.ai-chat-thinking', '.ai-chat-tool', '.ai-chat-tool-raw']) {
      const previous = [...previousRow.querySelectorAll(selector)];
      const byToolId = new Map(previous.map((details) => [details.closest('[data-tool-id]')?.dataset.toolId, details]));
      row.querySelectorAll(selector).forEach((details, index) => {
        const toolId = details.closest('[data-tool-id]')?.dataset.toolId;
        const source = chatDisclosures.get(toolId ? byToolId.get(toolId) : previous[index]);
        if (source) chatDisclosures.get(details)?.setOpen(source.isOpen(), { animate: false });
      });
    }
  }

  function renderChatMessage(message, options, container) {
    return appendMessage(message.role, message.content, {
      pending: message.pending,
      reasoning: message.reasoning,
      toolEvents: message.tool_events,
      traceEvents: message.trace_events,
      durationMs: message.turn_duration_ms,
      attachmentPaths: message.attachmentPaths,
      artifacts: message.artifacts,
      ...options,
    }, container);
  }

  function resolveChatButtonMode(hasContent, chat = state) {
    if (!chat.loading) {
      if (!hasContent && chat.pausedChat) return { icon: 'play', label: '继续 AI 输出', stop: false, insert: false };
      return { icon: 'send', label: '发送消息', stop: false, insert: false };
    }
    if (chat.stopping) return { icon: 'stop', label: '正在停止', stop: true, insert: false };
    if (hasContent) return { icon: 'send', label: '插入当前对话', stop: false, insert: true };
    return { icon: 'stop', label: '停止 AI 输出', stop: true, insert: false };
  }

  function renderChatSendButton(button, mode) {
    if (button.dataset.iconMode !== mode.icon) {
      button.innerHTML = SEND_BUTTON_ICONS[mode.icon];
      button.dataset.iconMode = mode.icon;
    }
    button.title = mode.label;
    button.setAttribute('aria-label', mode.label);
    button.classList.toggle('is-stop', Boolean(mode.stop));
    button.classList.toggle('is-insert', Boolean(mode.insert));
  }

  const chatStreamHandlers = {
    round_start: (run, event) => {
      if (run.resumeRequestId && !run.responseStarted) run.streamView?.resume(event.round);
      run.responseStarted = true;
      run.streamView?.addReasoning('', event.round);
    },
    reasoning_delta: (run, event) => run.streamView?.addReasoning(event.delta, event.round),
    content_delta: (run, event) => run.streamView?.addContent(event.delta, event.round),
    content_replace: (run, event) => run.streamView?.replaceContent(event.content, event.round),
    tool_start: (run, event) => run.streamView?.upsertTool(event.tool || {}, event.round),
    tool_result: (run, event) => run.streamView?.upsertTool(event.tool || {}, event.round),
    tool_progress: (run, event) => run.streamView?.upsertTool(event.tool || {}, event.round),
    artifacts: (run, event) => {
      if (run.canReference === false) return;
      run.downloads = event.artifacts;
      renderConversationDownloads(currentMessages(), run.downloads);
    },
    screenshot: (run, event) => {
      run.screenshot = event;
      renderChatScreenshot(run.streamView?.stack, event);
    },
    user_inserted: (run) => handleInsertedStreamMessage(run),
  };


  function applyChatPresentationEvent(run, event) {
    if (Object.hasOwn(chatStreamHandlers, event.type)) chatStreamHandlers[event.type](run, event);
  }

  function renderChatScreenshot(stack, screenshot) {
    if (!stack || !screenshot?.dataUrl) return;
    let button = stack.querySelector('.ai-chat-screenshot');
    if (button?.dataset.toolCallId === screenshot.toolCallId) return;
    if (!button) {
      button = document.createElement('button');
      button.className = 'ai-chat-screenshot';
      button.type = 'button';
      button.title = '查看浏览器截图';
      button.addEventListener('click', () => openChatScreenshot(button.firstElementChild.src));
      stack.prepend(button);
    }
    const image = document.createElement('img');
    image.alt = '浏览器截图';
    image.decoding = 'async';
    image.src = screenshot.dataUrl;
    button.dataset.toolCallId = screenshot.toolCallId;
    button.replaceChildren(image);
  }

  function chatActionButton(label, title, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', action);
    return button;
  }

  function downloadCard(artifact, canReference) {
    const row = document.createElement('div');
    row.className = 'ai-chat-download-card';
    const name = artifact.name || artifact.path;
    const detail = `${artifact.path} · ${formatWorkspaceFileSize(artifact.size)}`;
    row.append(chatActionButton(`↓ ${name}`, `预览 ${detail}`, () => void previewWorkspaceFile(artifact.path, artifact)));
    if (canReference) row.append(chatActionButton('+', `再次引用 ${name}`,
      (event) => void attachWorkspaceArtifact(artifact, event.currentTarget)));
    return row;
  }

  function renderChatDownloads(container, messages, live = [], canReference = true) {
    if (!container) return;
    const unique = new Map();
    for (const artifact of [...messages.flatMap((message) => message.artifacts || []), ...live]) {
      if (typeof artifact?.path !== 'string' || !artifact.sha256 || !artifact.toolCallId) continue;
      unique.set(JSON.stringify([artifact.path, artifact.sha256]), artifact);
    }
    const signature = JSON.stringify([...unique.keys()]);
    if (container.dataset.downloads === signature) return;
    const hasNewDownloads = unique.size > container.children.length;
    container.replaceChildren(...Array.from(unique.values(), (artifact) => downloadCard(artifact, canReference)));
    container.dataset.downloads = signature;
    container.hidden = !unique.size;
    if (hasNewDownloads) container.scrollLeft = container.scrollWidth;
  }

  function renderConversationDownloads(messages, live) {
    renderChatDownloads(el('ai-chat-downloads'), messages, live);
  }
