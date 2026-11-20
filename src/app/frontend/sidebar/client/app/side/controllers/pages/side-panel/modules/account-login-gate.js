async function redirectToAccountLogin() {
  const session = await window.aiFree.account.getSession().catch(() => null);
  if (session?.authenticated === true) return false;
  window.aiFree.ui.requestAccountCenter();
  return true;
}
