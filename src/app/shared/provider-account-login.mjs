const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME = /^[\p{L}\p{N}_.+-]+$/u;

export function normalizeProviderLogin(value, allowUsername = false) {
  const login = String(value ?? '').trim();
  if (login.length > 254) return '';
  if (EMAIL.test(login)) return login.toLowerCase();
  return allowUsername && USERNAME.test(login) ? login : '';
}
