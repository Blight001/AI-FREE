  function getSelectShell(select) {
    return select?.closest?.('.ai-select') || null;
  }

  function closeAllSelects(exceptShell = null) {
    document.querySelectorAll('.ai-select.open').forEach((shell) => {
      if (exceptShell && shell === exceptShell) return;
      closeSelect(shell);
    });
  }

  function closeSelect(shell) {
    if (!shell) return;
    shell.classList.remove('open');
    const trigger = shell.querySelector('.ai-select-trigger');
    const menu = shell.querySelector('.ai-select-menu');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  }

  function openSelect(shell) {
    if (!shell) return;
    const trigger = shell.querySelector('.ai-select-trigger');
    const menu = shell.querySelector('.ai-select-menu');
    const select = shell.querySelector('select');
    if (!trigger || !menu) return;
    // 历史下拉无 native select；其余下拉依赖 native select 状态
    if (select && (select.disabled || trigger.disabled)) return;
    if (!select && trigger.disabled) return;
    closeAllSelects(shell);
    shell.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    const selected = menu.querySelector('[aria-selected="true"]');
    (selected || menu.querySelector('.ai-select-option'))?.focus?.();
  }

  function optionDisplayText(option) {
    if (!option) return '';
    const name = String(option.textContent || '');
    const multiplier = option.dataset?.quotaMultiplier;
    if (!multiplier) return name;
    return `${name} ×${formatQuota(multiplier)}`;
  }
