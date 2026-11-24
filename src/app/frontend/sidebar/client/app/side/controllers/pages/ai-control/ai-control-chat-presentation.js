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
    const view = appendMessage(message.role, message.content, {
      pending: message.pending,
      reasoning: message.reasoning,
      toolEvents: message.tool_events,
      traceEvents: message.trace_events,
      durationMs: message.turn_duration_ms,
      attachmentPaths: message.attachmentPaths,
      artifacts: message.artifacts,
      ...options,
    }, container);
    renderChatScreenshots(view?.stack, message.artifacts);
    return view;
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
      if (!event.artifact) setStatus('截图已显示，但未能保存到历史记录', 'warning');
      renderChatScreenshot(run.streamView?.stack, event);
    },
    user_inserted: (run) => handleInsertedStreamMessage(run),
  };


  function applyChatPresentationEvent(run, event) {
    if (Object.hasOwn(chatStreamHandlers, event.type)) chatStreamHandlers[event.type](run, event);
  }

  const SCREENSHOT_TOOL_NAMES = new Set(['browser_screenshot', 'browser_observe', 'browser_action']);

  function isChatScreenshotArtifact(artifact) {
    return SCREENSHOT_TOOL_NAMES.has(artifact?.toolName);
  }

  function renderChatScreenshots(stack, artifacts) {
    if (!Array.isArray(artifacts)) return;
    artifacts.filter(isChatScreenshotArtifact).forEach((artifact) => renderChatScreenshot(stack, artifact));
  }

  function screenshotDisplayType(screenshot) {
    if (typeof screenshot?.dataUrl === 'string' && screenshot.dataUrl.startsWith('data:image/')) return 'inline';
    if (isChatScreenshotArtifact(screenshot) && typeof screenshot.path === 'string') return 'artifact';
    return '';
  }

  function findScreenshotTool(stack, toolCallId) {
    return [...stack.querySelectorAll('.ai-chat-tool[data-tool-id]')]
      .find((card) => card.dataset.toolId === toolCallId);
  }

  function findScreenshotButton(stack, toolCallId) {
    return [...stack.querySelectorAll('.ai-chat-screenshot')]
      .find((item) => item.dataset.toolCallId === toolCallId);
  }

  function createScreenshotButton(toolCallId, screenshot, displayType) {
    const button = document.createElement('button');
    button.className = 'ai-chat-screenshot';
    button.type = 'button';
    button.title = displayType === 'inline' ? '查看浏览器截图' : '正在加载历史截图';
    button.dataset.toolCallId = toolCallId;
    const image = document.createElement('img');
    image.alt = '浏览器截图';
    image.decoding = 'async';
    button.addEventListener('click', () => {
      if (displayType === 'inline') openChatScreenshot(image.src);
      else void previewWorkspaceFile(screenshot.path, screenshot);
    });
    button.appendChild(image);
    return { button, image };
  }

  function markScreenshotUnavailable(button, image, label) {
    image.alt = label;
    button.title = '查看截图文件';
  }

  function loadHistoricalScreenshot(button, image, screenshot) {
    void Promise.resolve().then(() => readWorkspacePreview(screenshot.path, screenshot)).then((result) => {
      if (!button.isConnected) return;
      if (result?.ok && result.file?.dataUrl) {
        image.src = result.file.dataUrl;
        button.title = '查看浏览器截图';
      } else markScreenshotUnavailable(button, image, '历史截图文件不可用');
    }).catch(() => {
      if (button.isConnected) markScreenshotUnavailable(button, image, '历史截图加载失败');
    });
  }

  function renderChatScreenshot(stack, screenshot) {
    const toolCallId = String(screenshot?.toolCallId || '');
    const displayType = screenshotDisplayType(screenshot);
    if (!stack || !displayType || !toolCallId) return;
    const tool = findScreenshotTool(stack, toolCallId);
    if (!tool) return;
    const existing = findScreenshotButton(stack, toolCallId);
    if (existing) {
      if (tool.nextElementSibling !== existing) tool.after(existing);
      return;
    }
    const { button, image } = createScreenshotButton(toolCallId, screenshot, displayType);
    tool.after(button);
    if (displayType === 'inline') image.src = screenshot.dataUrl;
    else loadHistoricalScreenshot(button, image, screenshot);
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
      if (isChatScreenshotArtifact(artifact)) continue;
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
