export const MAX_IMPORT_TEXT = 64 * 1024;
export const MAX_IMPORT_ACCOUNTS = 50;

const LABEL = /^(账号|邮箱|邮箱密码|密码)(?:\s*[:：]\s*(.*))?$/;
const FIELDS = { 账号: 'email', 邮箱: 'email', 邮箱密码: 'mailPassword', 密码: 'password' };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function fromDelimitedLine(line) {
  const [email, password, identifier, extra, ...remaining] = line.split('----').map((part) => part.trim());
  if (identifier === undefined) return { email, password };
  if (!remaining.length && UUID.test(identifier) && extra && !/^x$/i.test(password)) return { email, password };
  return {};
}

function collectAccounts(allowUsername) {
  const accounts = [];
  const seen = new Set();
  let skipped = 0;
  return {
    add({ email = '', password = '' }) {
      const normalized = normalizeProviderLogin(email, allowUsername);
      if (!normalized || !password || password.length > 1024 || seen.has(normalized)) {
        skipped += 1;
        return;
      }
      if (accounts.length === MAX_IMPORT_ACCOUNTS) throw new RangeError('一次最多导入 50 个账号');
      seen.add(normalized);
      accounts.push({ email: normalized, password });
    },
    result: () => ({ accounts, skipped }),
  };
}

export function parseProviderAccountText(text, allowUsername = false) {
  if (text.length > MAX_IMPORT_TEXT) throw new RangeError('粘贴文本过长，请分批导入');
  const collector = collectAccounts(allowUsername);
  let draft = null;
  let pending = '';

  function finishDraft() {
    if (draft) collector.add({ email: draft.email, password: draft.mailPassword ?? draft.password });
    draft = null;
    pending = '';
  }

  for (const line of text.split(/\r\n?|\n/)) {
    const value = line.trim();
    if (!value) continue;
    const label = LABEL.exec(value);
    if (label) {
      const field = FIELDS[label[1]];
      if (field === 'email') {
        finishDraft();
        draft = {};
      }
      if (draft) {
        draft[field] = label[2] || '';
        pending = draft[field] ? '' : field;
      }
    } else if (value.includes('----') && (allowUsername || value.split('----', 1)[0].includes('@'))) {
      finishDraft();
      collector.add(fromDelimitedLine(value));
    } else if (pending) {
      draft[pending] = value;
      pending = '';
    } else {
      finishDraft();
    }
  }
  finishDraft();
  return collector.result();
}
import { normalizeProviderLogin } from '../../../../../shared/provider-account-login.mjs';

