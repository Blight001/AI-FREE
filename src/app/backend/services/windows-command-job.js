'use strict';

const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const script = require('./windows-command-job-script');

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\Windows', 'System32');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const VERDICT = /^(exit:\d{1,10}|cancelled:|launch_failed:|unconfirmed:)$/;
const ENCODED_SCRIPT = Buffer.from(script, 'utf16le').toString('base64');

function quoteWindowsArg(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function commandLine(executable, command, shell) {
  if (shell === 'powershell') return `"${executable}" -NoLogo -NoProfile -NonInteractive -Command ${quoteWindowsArg(command)}`;
  // cmd /s removes the outer pair of quotes; preserve the command's own quoting and operators.
  return `"${executable}" /d /s /c "${command}"`;
}

function createVerdictReader(token) {
  const prefix = Buffer.from(`\x1e${token}:`);
  let pending = Buffer.alloc(0);
  let verdict = '';
  return {
    get verdict() { return verdict; },
    read(chunk, onReady) {
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      pending = Buffer.alloc(0);
      let rest = data;
      const output = [];
      let start;
      while ((start = rest.indexOf(prefix)) !== -1) {
        const end = rest.subarray(start, start + prefix.length + 32).indexOf(31);
        if (end === -1) break;
        const value = rest.subarray(start + prefix.length, start + end).toString('ascii');
        if (value !== 'ready:' && !VERDICT.test(value)) break;
        output.push(rest.subarray(0, start));
        rest = rest.subarray(start + end + 1);
        if (value === 'ready:') onReady();
        else verdict = value;
      }
      const last = rest.lastIndexOf(30);
      const tail = last === -1 ? null : rest.subarray(last);
      if (tail && tail.length < prefix.length + 32 && !tail.includes(31) &&
          tail.subarray(0, prefix.length).equals(prefix.subarray(0, tail.length))) {
        pending = Buffer.from(tail);
        rest = rest.subarray(0, last);
      }
      return output.length ? Buffer.concat([...output, rest]) : rest;
    },
    finish: () => pending,
  };
}

function createWindowsCommandJob(command, shell, env) {
  const token = randomBytes(16).toString('hex');
  const application = shell === 'powershell' ? POWERSHELL : (process.env.ComSpec || path.join(SYSTEM32, 'cmd.exe'));
  const reader = createVerdictReader(token);
  return {
    executable: POWERSHELL,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT],
    env: {
      // Keep the PowerShell supervisor's profile initialization out of the workspace.
      ...env, USERPROFILE: undefined, APPDATA: os.tmpdir(),
      AI_FREE_JOB_TOKEN: token, AI_FREE_JOB_APPLICATION: application,
      AI_FREE_JOB_COMMAND_LINE: commandLine(application, command, shell),
    },
    stderr: reader,
    outcome(reason) {
      const [kind, value] = reader.verdict.split(':');
      if (kind === 'exit') return { state: Number(value) === 0 ? 'exited' : 'failed', code: Number(value) };
      if (kind === 'cancelled' && reason) return { state: reason, code: null };
      if (kind === 'launch_failed') return { state: 'failed', code: null, error: '无法启动 Windows 命令进程树' };
      return { state: 'termination_unconfirmed', code: null, error: '无法确认 Windows 命令进程树已退出' };
    },
  };
}

module.exports = { createWindowsCommandJob };
