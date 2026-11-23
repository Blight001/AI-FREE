  const CHAT_DRAFT_LIMIT = 12000;
  const inlineChatChip = '.ai-chat-inline-chip';

  function makeInlineChatChip(name, kind, path = '') {
    const chip = document.createElement('span');
    chip.className = inlineChatChip.slice(1);
    chip.contentEditable = 'false';
    chip.dataset.kind = kind;
    finishInlineChatChip(chip, name, path);
    return chip;
  }

  function finishInlineChatChip(chip, name, path) {
    chip.textContent = name;
    chip.dataset.path = path;
    chip.title = path ? `${chip.dataset.kind} · ${name}` : `正在导入 ${name}`;
    chip.setAttribute('aria-label', chip.title);
  }

  function collectChatDraft(node, parts) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(child.data.replace(/\u00a0/g, ' '));
      } else if (child.matches?.(inlineChatChip)) {
        parts.push(child);
      } else if (child.nodeName === 'BR') {
        if (child.nextSibling) parts.push('\n');
      } else {
        if (child.nodeName === 'DIV' && child.previousSibling) parts.push('\n');
        collectChatDraft(child, parts);
      }
    }
  }

  function readChatDraft(input) {
    const parts = [];
    if (input) collectChatDraft(input, parts);
    const literalText = parts.filter((part) => typeof part === 'string').join('');
    const inlineAttachments = [];
    let pending = false;
    const content = parts.map((part) => {
      if (typeof part === 'string') return part;
      const { path, kind } = part.dataset;
      if (!path) { pending = true; return ''; }
      const label = `${kind}：${part.textContent}`;
      let marker = `【${label}】`;
      for (let index = 2; literalText.includes(marker) || inlineAttachments.some((item) => item.marker === marker); index++) {
        marker = `【${label} #${index}】`;
      }
      inlineAttachments.push({ path, marker });
      return marker;
    }).join('');
    return { content, inlineAttachments, pending };
  }

  function writeChatDraft(input, content = '', inlineAttachments = []) {
    const parts = [];
    let offset = 0;
    for (const { path, marker } of inlineAttachments) {
      const index = content.indexOf(marker, offset);
      if (index < 0 || !marker) continue;
      const name = path.split('/').pop();
      parts.push(content.slice(offset, index), makeInlineChatChip(name, fileKindLabel({ name }), path));
      offset = index + marker.length;
    }
    if (offset < content.length) parts.push(content.slice(offset));
    input.replaceChildren(...parts.filter(Boolean));
    syncChatDraftPlaceholder(input);
  }

  function syncChatDraftPlaceholder(input) {
    input.toggleAttribute('data-empty', !input.textContent);
  }

  function chatDraftSelection(input) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !input.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
    return selection.getRangeAt(0);
  }

  function replaceChatDraftSelection(range, text) {
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (text) document.execCommand('insertText', false, text);
    else document.execCommand('delete');
  }

  function chatDraftMention(input) {
    const selection = chatDraftSelection(input);
    if (!selection?.collapsed || selection.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const node = selection.startContainer;
    const before = node.data.slice(0, selection.startOffset);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!match) return null;
    const range = selection.cloneRange();
    range.setStart(node, before.length - match[2].length - 1);
    return { range, query: match[2].toLowerCase() };
  }

  function chatDraftRemaining(input) {
    const selected = chatDraftSelection(input)?.toString().length || 0;
    return Math.max(0, CHAT_DRAFT_LIMIT - input.textContent.length + selected);
  }

  function adjacentChatChip(range, backward) {
    const { startContainer: node, startOffset: offset } = range;
    const atText = node.nodeType === Node.TEXT_NODE;
    if (atText && offset !== (backward ? 0 : node.length)) return null;
    const sibling = backward ? 'previousSibling' : 'nextSibling';
    let adjacent = atText ? node[sibling] : node.childNodes[offset - Number(backward)];
    while (adjacent?.nodeType === Node.TEXT_NODE && !adjacent.length) adjacent = adjacent[sibling];
    return adjacent?.matches?.(inlineChatChip) ? adjacent : null;
  }

  function deleteAdjacentChatChip(input, event) {
    if (event.isComposing || state.aiInputComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    const selection = chatDraftSelection(input);
    if (!selection?.collapsed) return;
    const chip = adjacentChatChip(selection, event.key === 'Backspace');
    if (!chip) return;
    event.preventDefault();
    const range = document.createRange();
    range.selectNode(chip);
    replaceChatDraftSelection(range, '');
  }

  function bindChatDraftEditor(input) {
    input.addEventListener('keydown', (event) => deleteAdjacentChatChip(input, event));
    input.addEventListener('dragover', (event) => event.preventDefault());
    input.addEventListener('drop', (event) => event.preventDefault());
    input.addEventListener('beforeinput', (event) => {
      const format = event.inputType.startsWith('format');
      const tooLong = !event.isComposing && event.data && event.data.length > chatDraftRemaining(input);
      if (format || tooLong) event.preventDefault();
    });
  }
