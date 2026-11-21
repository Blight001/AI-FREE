  let pendingChatUpload = null;

  function showChatUploadConfirmation(run, event) {
    pendingChatUpload = { requestId: run.requestId, id: event.id };
    const target = [event.browserName, event.title, event.host].filter(Boolean).join(' · ');
    el('ai-chat-confirmation-summary').textContent = `${event.files.join('、')} → ${target}`;
    el('ai-chat-upload-confirmation').hidden = false;
  }

  function closeChatUploadConfirmation(id = '') {
    if (id && pendingChatUpload?.id !== id) return;
    pendingChatUpload = null;
    const panel = el('ai-chat-upload-confirmation');
    if (panel) panel.hidden = true;
  }

  async function decideChatUpload(accepted) {
    if (!pendingChatUpload) return;
    const request = { ...pendingChatUpload, accepted };
    closeChatUploadConfirmation(request.id);
    try {
      const result = await window.aiFree.ai.chatApproval(request);
      if (!result?.ok) throw new Error(result?.error?.message || '确认已失效');
    } catch (error) { setStatus(error?.message || '确认已失效', 'warning'); }
  }

  function bindChatUploadConfirmation() {
    el('ai-chat-confirmation-cancel')?.addEventListener('click', () => decideChatUpload(false));
    el('ai-chat-confirmation-accept')?.addEventListener('click', () => decideChatUpload(true));
  }
