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

  function insertPendingPastedTextChip(input) {
    const batch = crypto.randomUUID();
    const chip = makeInlineChatChip('正在保存粘贴文本…', '文件');
    chip.dataset.batch = batch;
    document.execCommand('insertHTML', false, chip.outerHTML);
    const inserted = input.querySelector(`[data-batch="${batch}"]`);
    if (inserted) {
      const caret = document.createRange();
      caret.setStartAfter(inserted);
      caret.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(caret);
    }
    return inserted;
  }

  async function resolvePastedTextAttachment(input, text, chip, replaced, sessionId) {
    try {
      const file = await savePastedText(text);
      attachPastedTextFile(input, chip, replaced, sessionId, file);
    } catch (error) {
      restorePastedTextChip(input, chip, replaced);
      setStatus(error?.message || String(error), 'warning');
    } finally {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  async function savePastedText(text) {
    const result = await window.aiFree?.ai?.workspaceImportPasted?.({ text });
    const [file] = result?.files || [];
    if (!result?.ok || !file?.path) throw new Error(result?.message || '长文本保存失败');
    return file;
  }

  function attachPastedTextFile(input, chip, replaced, sessionId, file) {
    if (!isPastedTextChipCurrent(input, chip, replaced, sessionId)) return;
    if (!toggleChatAttachment(file.path, true)) throw new Error('无法将长文本附加到消息');
    replacePastedTextChip(chip, file.path);
    setStatus(`长文本已保存并附加：${file.path}`, 'success');
    void loadWorkspaceFiles();
  }

  function isPastedTextChipCurrent(input, chip, replaced, sessionId) {
    if (input.contains(chip) && (state.currentSession?.id || '') === sessionId) return true;
    restorePastedTextChip(input, chip, replaced);
    setStatus('对话已切换，长文本已保存但未附加到当前消息', 'warning');
    return false;
  }

  function replacePastedTextChip(chip, filePath) {
    const marker = document.createTextNode(`（超长粘贴文本已保存为工作区文件：${filePath}，请阅读全文后再回答。）`);
    chip.replaceWith(marker);
    const caret = document.createRange();
    caret.setStartAfter(marker);
    caret.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(caret);
  }

  function restorePastedTextChip(input, chip, replaced) {
    if (!input.contains(chip)) return;
    chip.before(replaced);
    chip.remove();
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
      const text = clipboard.getData('text/plain');
      if (!text) return;
      if (text.length <= chatDraftRemaining(input)) {
        document.execCommand('insertText', false, text);
        return;
      }
      if (state.attachmentPaths.length >= 16) {
        setStatus('每条消息最多附加 16 个文件，请先移除一个附件', 'warning');
        return;
      }
      const range = chatDraftSelection(input);
      if (!range) return;
      const replaced = range.cloneContents();
      const sessionId = state.currentSession?.id || '';
      const chip = insertPendingPastedTextChip(input);
      if (chip) void resolvePastedTextAttachment(input, text, chip, replaced, sessionId);
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
