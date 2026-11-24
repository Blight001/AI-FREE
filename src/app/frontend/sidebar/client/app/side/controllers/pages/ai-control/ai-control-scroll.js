  let resetAiChatScroll = () => {};

  function mountChatViewport(host, viewportId, messageListId, label) {
    const fragment = el('ai-chat-viewport-template').content.cloneNode(true);
    const viewport = fragment.querySelector('.ai-chat-messages');
    const messages = fragment.querySelector('.ai-chat-message-list');
    const button = fragment.querySelector('.ai-chat-jump-bottom');
    viewport.id = viewportId;
    viewport.setAttribute('aria-label', label);
    messages.id = messageListId;
    button.setAttribute('aria-controls', viewportId);
    host.append(fragment);
    return { viewport, messages, button };
  }

  function bindAiChatScroll() {
    const surface = mountChatViewport(el('ai-chat-viewport-host'), 'ai-chat-messages', 'ai-chat-message-list', '对话消息');
    surface.button.id = 'ai-chat-jump-bottom';
    const welcome = el('ai-chat-welcome-template').content.cloneNode(true);
    welcome.querySelector('img').src = window.aiFreeLogoAssets.url;
    surface.messages.append(welcome);
    resetAiChatScroll = bindChatScroll(surface);
  }

  function bindChatScroll({ viewport, messages, button }) {
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const bottom = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const atBottom = () => bottom() - viewport.scrollTop <= 4;
    let following = true;
    let lastTop = viewport.scrollTop;
    let layoutBottom = bottom();

    function updateButton() {
      button.hidden = atBottom();
      if (button.hidden && document.activeElement === button) viewport.focus({ preventScroll: true });
    }

    function onLayout() {
      layoutBottom = bottom();
      if (following && !atBottom()) {
        viewport.scrollTop = layoutBottom;
        lastTop = viewport.scrollTop;
      }
      updateButton();
    }

    const reset = () => {
      following = true;
      layoutBottom = bottom();
      viewport.scrollTop = layoutBottom;
      lastTop = viewport.scrollTop;
      updateButton();
    };

    viewport.addEventListener('scroll', () => {
      const top = viewport.scrollTop;
      // Chromium can clamp scrollTop while collapsing content, before ResizeObserver runs.
      if (top !== lastTop && (!following || bottom() === layoutBottom)) following = atBottom();
      lastTop = top;
      updateButton();
    }, { passive: true, signal });
    viewport.addEventListener('wheel', (event) => {
      if (event.deltaY < 0 && bottom() > 0) following = false;
      if (event.deltaY > 0 && atBottom()) following = true;
    }, { passive: true, signal });
    button.addEventListener('click', reset, { signal });

    const observer = new ResizeObserver(onLayout);
    observer.observe(viewport);
    observer.observe(messages);
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      observer.disconnect();
      lifetime.abort();
    }, { signal });
    reset();
    return reset;
  }
