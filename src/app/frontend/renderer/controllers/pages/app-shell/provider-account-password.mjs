const MASK = '••••••••';

function setRevealed(button, revealed) {
  const label = revealed ? '隐藏密码' : '查看密码';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(revealed));
  button.title = label;
}

export function createProviderPasswordControl(root) {
  const icon = root.querySelector('#provider-account-eye');
  const home = root.closest('#browser-empty-state');
  let active;

  function hide() {
    if (!active) return;
    const { button, value } = active;
    active = null;
    value.textContent = MASK;
    setRevealed(button, false);
  }

  async function toggle(button, value, target) {
    const wasActive = active?.button === button;
    hide();
    if (wasActive || button.closest('[hidden]')) return;
    const request = { button, value };
    active = request;
    try {
      const result = await window.aiFree.account.getProviderAccountPassword(target);
      if (active !== request || !button.isConnected || button.closest('[hidden]')) return;
      if (!result?.ok || typeof result.data?.password !== 'string') throw new Error('无法读取密码，请重试');
      value.textContent = result.data.password;
      setRevealed(button, true);
    } catch {
      if (active !== request) return;
      hide();
      window.MessageModal?.showErrorMessage?.('无法读取密码，请重试');
    }
  }

  const observer = new MutationObserver(() => hide());
  observer.observe(root, { attributes: true, attributeFilter: ['hidden'] });
  if (home) observer.observe(home, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('pagehide', hide);

  return {
    hide,
    create(target) {
      const control = document.createElement('div');
      control.className = 'provider-password';
      const value = document.createElement('span');
      value.textContent = MASK;
      value.className = 'provider-password-value';
      value.id = `provider-password-${target.provider}-${target.id}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'provider-password-toggle';
      button.setAttribute('aria-controls', value.id);
      setRevealed(button, false);
      button.append(icon.content.cloneNode(true));
      button.addEventListener('click', () => void toggle(button, value, target));
      control.append(value, button);
      return control;
    },
  };
}
