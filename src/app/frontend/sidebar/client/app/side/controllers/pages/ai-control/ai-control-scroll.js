  let resetAiChatScroll = () => {};

  function bindAiChatScroll() {
    const viewport = el('ai-chat-messages');
    const messages = el('ai-chat-message-list');
    const button = el('ai-chat-jump-bottom');
    if (!viewport || !messages || !button) return;

    const lifetime = new AbortController();
    const { signal } = lifetime;
    const bottom = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const atBottom = () => bottom() - viewport.scrollTop <= 4;
    let following = true;
    let lastTop = viewport.scrollTop;

    function updateButton() {
      button.hidden = atBottom();
      if (button.hidden && document.activeElement === button) viewport.focus({ preventScroll: true });
    }

    function onLayout() {
      if (following && !atBottom()) {
        viewport.scrollTop = bottom();
        lastTop = viewport.scrollTop;
      }
      updateButton();
    }

    resetAiChatScroll = () => {
      following = true;
      viewport.scrollTop = bottom();
      lastTop = viewport.scrollTop;
      updateButton();
    };

    viewport.addEventListener('scroll', () => {
      const top = viewport.scrollTop;
      if (top !== lastTop) following = atBottom();
      lastTop = top;
      updateButton();
    }, { passive: true, signal });
    viewport.addEventListener('wheel', (event) => {
      if (event.deltaY < 0 && bottom() > 0) following = false;
      if (event.deltaY > 0 && atBottom()) following = true;
    }, { passive: true, signal });
    button.addEventListener('click', resetAiChatScroll, { signal });

    const observer = new ResizeObserver(onLayout);
    observer.observe(viewport);
    observer.observe(messages);
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      observer.disconnect();
      lifetime.abort();
      resetAiChatScroll = () => {};
    }, { signal });
    resetAiChatScroll();
  }
