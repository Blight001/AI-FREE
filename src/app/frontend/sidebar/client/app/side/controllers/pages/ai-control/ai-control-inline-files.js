  function pastedFileName(file, index) {
    const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    const extension = extensions[file.type] || '';
    if (file.name && (/\.[^./\\]+$/.test(file.name) || !extension)) return file.name;
    return `粘贴${fileKindLabel(file)}${index ? `-${index + 1}` : ''}${extension}`;
  }

  function readPastedFile(file, index) {
    return new Promise((resolve, reject) => {
      const name = pastedFileName(file, index);
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`读取 ${name} 失败`));
      reader.onload = () => resolve({ name, data: String(reader.result || '').split(',')[1] || '' });
      reader.readAsDataURL(file);
    });
  }

  function clipboardFiles(clipboard) {
    if (clipboard.files.length) return [...clipboard.files];
    return [...clipboard.items].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
  }

  function insertPendingChatChips(input, files) {
    // Chromium's edit command keeps the insertion in the same undo stack as normal typing.
    const batch = crypto.randomUUID();
    const html = files.map((file, index) => {
      const chip = makeInlineChatChip(pastedFileName(file, index), fileKindLabel(file));
      chip.dataset.batch = batch;
      return chip.outerHTML;
    }).join('');
    document.execCommand('insertHTML', false, html);
    const chips = [...input.querySelectorAll(`[data-batch="${batch}"]`)];
    if (chips.length) {
      const caret = document.createRange();
      caret.setStartAfter(chips.at(-1));
      caret.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(caret);
    }
    return chips;
  }

  async function resolvePastedChatChips(input, files, chips, replaced) {
    try {
      const payload = await Promise.all(files.map(readPastedFile));
      const result = await window.aiFree?.ai?.workspaceImportPasted?.({ files: payload });
      if (!result?.ok) throw new Error(result?.message || '粘贴文件导入失败');
      if (result.files?.length !== chips.length) throw new Error('粘贴文件导入结果不完整');
      chips.forEach((chip, index) => finishInlineChatChip(chip, result.files[index].name, result.files[index].path));
      void loadWorkspaceFiles();
    } catch (error) {
      const first = chips.find((chip) => input.contains(chip));
      if (first) {
        first.before(replaced);
        setStatus(error?.message || String(error), 'warning');
      }
      chips.forEach((chip) => chip.remove());
    } finally {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function pasteChatDraft(event) {
    const input = event.currentTarget;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    event.preventDefault();
    const files = clipboardFiles(clipboard);
    if (!files.length) {
      const text = clipboard.getData('text/plain').slice(0, chatDraftRemaining(input));
      if (text) document.execCommand('insertText', false, text);
      return;
    }
    const range = chatDraftSelection(input);
    if (!range) return;
    const replaced = range.cloneContents();
    const selected = replaced.querySelectorAll(inlineChatChip).length;
    if (files.length + input.querySelectorAll(inlineChatChip).length - selected > 16) {
      setStatus('每条消息最多内联 16 个文件', 'warning');
      return;
    }
    const chips = insertPendingChatChips(input, files);
    if (chips.length === files.length) {
      void resolvePastedChatChips(input, files, chips, replaced);
    }
  }
