  function resolveFocusedOption(menu) {
    const active = document.activeElement;
    if (!active?.classList?.contains('ai-select-option') || !menu.contains(active)) return null;
    return String(active.dataset.value ?? '');
  }

  function createSelectOption(option, context) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ai-select-option';
    item.role = 'option';
    item.dataset.value = option.value;
    item.setAttribute('aria-selected', String(option.selected));
    if (option.disabled) {
      item.disabled = true;
      item.setAttribute('aria-disabled', 'true');
    }
    const label = document.createElement('span');
    label.className = 'ai-select-option-label';
    label.textContent = option.textContent || '';
    item.appendChild(label);
    const multiplier = option.dataset?.quotaMultiplier;
    if (multiplier) {
      const meta = document.createElement('span');
      meta.className = 'ai-select-option-meta';
      meta.textContent = `×${formatQuota(multiplier)}`;
      item.appendChild(meta);
    }
    item.addEventListener('click', (event) => handleSelectOptionClick(event, item, context));
    return item;
  }

  function handleSelectOptionClick(event, item, context) {
    event.preventDefault();
    if (item.disabled) return;
    const next = String(item.dataset.value ?? '');
    if (context.select.value !== next) {
      context.select.value = next;
      context.select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      syncSelectUi(context.select);
    }
    closeSelect(context.shell);
  }

  function appendModelAction(shell, menu) {
    if (shell.dataset.aiSelect !== 'model') return;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'ai-select-option ai-model-custom-api-action';
    action.textContent = '添加自定义模型';
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeSelect(shell);
      window.aiFree?.ai?.openHomeModelSettings?.();
    });
    menu.appendChild(action);
  }

  function restoreFocusedOption(shell, menu, value) {
    if (value === null || !shell.classList.contains('open')) return;
    Array.from(menu.querySelectorAll('.ai-select-option'))
      .find((item) => String(item.dataset.value ?? '') === value)
      ?.focus?.();
  }

  function syncSelectUi(select) {
    const shell = getSelectShell(select);
    if (!shell || !select) return;
    const trigger = shell.querySelector('.ai-select-trigger');
    const valueEl = shell.querySelector('.ai-select-value');
    const menu = shell.querySelector('.ai-select-menu');
    if (!trigger || !valueEl || !menu) return;

    const options = Array.from(select.options || []);
    trigger.disabled = Boolean(select.disabled);
    valueEl.textContent = optionDisplayText(options.find((option) => option.selected) || options[0] || null);
    const focusedOptionValue = resolveFocusedOption(menu);
    menu.replaceChildren(...options.map((option) => createSelectOption(option, { select, shell })));
    appendModelAction(shell, menu);
    restoreFocusedOption(shell, menu, focusedOptionValue);
  }

  function bindSelectShell(shell) {
    if (!shell || shell.dataset.bound === '1') return;
    shell.dataset.bound = '1';
    const select = shell.querySelector('select');
    const trigger = shell.querySelector('.ai-select-trigger');
    const menu = shell.querySelector('.ai-select-menu');
    if (!select || !trigger || !menu) return;

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      if (trigger.disabled || select.disabled) return;
      if (shell.classList.contains('open')) closeSelect(shell);
      else openSelect(shell);
    });

    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSelect(shell);
      } else if (event.key === 'Escape') {
        closeSelect(shell);
      }
    });

    menu.addEventListener('keydown', (event) => {
      const items = Array.from(menu.querySelectorAll('.ai-select-option:not([disabled])'));
      if (!items.length) return;
      const current = document.activeElement;
      const index = items.indexOf(current);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[Math.min(items.length - 1, Math.max(0, index) + 1)]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[Math.max(0, (index < 0 ? items.length : index) - 1)]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSelect(shell);
        trigger.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    });

    select.addEventListener('change', () => syncSelectUi(select));
    syncSelectUi(select);
  }

  function bindHistorySelectShell() {
    const shell = el('ai-chat-history-select');
    if (!shell || shell.dataset.bound === '1') return;
    shell.dataset.bound = '1';
    const trigger = shell.querySelector('.ai-select-trigger');
    const menu = shell.querySelector('.ai-select-menu');
    if (!trigger || !menu) return;

    el('ai-chat-new-conversation')?.addEventListener('click', () => {
      closeSelect(shell);
      void startNewConversation();
    });
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      if (shell.classList.contains('open')) {
        closeSelect(shell);
      } else {
        void refreshHistoryList().finally(() => openSelect(shell));
      }
    });
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void refreshHistoryList().finally(() => openSelect(shell));
      } else if (event.key === 'Escape') {
        closeSelect(shell);
      }
    });
  }

  function initCustomSelects() {
    document.querySelectorAll('.ai-select').forEach((shell) => {
      // 历史下拉没有 native select，单独绑定
      if (shell.dataset.aiSelect === 'history' || shell.id === 'ai-chat-history-select') return;
      bindSelectShell(shell);
    });
    bindHistorySelectShell();
    document.addEventListener('pointerdown', (event) => {
      const shell = event.target?.closest?.('.ai-select');
      if (!shell) closeAllSelects();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAllSelects();
    });
  }

  /* ---------------- 额度圆环 ---------------- */
