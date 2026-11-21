'use strict';

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createWindowsCommandJob } = require('./windows-command-job');

const MAX_OUTPUT_BYTES = 64 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const STOP_GRACE_MS = 6000;
const STARTUP_TIMEOUT_MS = 15000;

function boundedOutput() {
  const buffer = Buffer.allocUnsafe(MAX_OUTPUT_BYTES);
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      const written = chunk.copy(buffer, size);
      const changed = written > 0 || (!truncated && written < chunk.length);
      size += written;
      truncated ||= written < chunk.length;
      return changed;
    },
    snapshot() {
      // Leave an incomplete UTF-8 character out until its remaining bytes arrive.
      return { text: new StringDecoder('utf8').write(buffer.subarray(0, size)), truncated };
    },
  };
}

function localProcess(command, shell, env) {
  if (process.platform === 'win32') return createWindowsCommandJob(command, shell, env);
  if (shell === 'powershell') return { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], env };
  if (shell === 'cmd') return { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command], env };
  return { executable: process.env.SHELL || '/bin/sh', args: ['-c', command], env };
}

function commandLog(onProgress) {
  const stdout = boundedOutput();
  const stderr = boundedOutput();
  const started = performance.now();
  let callback = onProgress;
  let timer;
  let state = 'running';
  function snapshot() {
    const out = stdout.snapshot();
    const err = stderr.snapshot();
    return {
      duration_ms: Math.round(performance.now() - started),
      stdout: out.text, stderr: err.text,
      stdout_truncated: out.truncated, stderr_truncated: err.truncated,
    };
  }
  function publish() {
    timer = undefined;
    try { callback?.({ state, ...snapshot() }); } catch (_) {
      // A broken observer should not keep a command or its timers alive.
      callback = undefined;
    }
  }
  function push(stream, chunk) {
    const changed = (stream === 'stdout' ? stdout : stderr).push(chunk);
    if (changed && callback && !timer) timer = setTimeout(publish, PROGRESS_INTERVAL_MS);
  }
  function stopping() {
    state = 'stopping';
    clearTimeout(timer);
    publish();
  }
  function finish() {
    clearTimeout(timer);
    return snapshot();
  }
  return { push, stopping, finish };
}

function forceStop(child, windows) {
  if (!child.pid) return;
  if (windows) child.kill('SIGKILL');
  else try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') child.kill('SIGKILL');
  }
}

function supervise(child, spec, command, log, abortSignal) {
  return new Promise((resolve) => {
    const job = spec.outcome;
    let reason;
    let watchdog;
    let spawnError;
    function stop(nextReason) {
      if (reason) return;
      reason = nextReason;
      clearTimeout(timer);
      log.stopping();
      if (job) child.stdin.end();
      else forceStop(child, false);
      watchdog = setTimeout(() => {
        forceStop(child, Boolean(job));
        child.stdout.destroy();
        child.stderr.destroy();
      }, STOP_GRACE_MS);
    }
    const abort = () => stop('stopped');
    const timeout = () => stop('timed_out');
    let timer = setTimeout(timeout, job ? STARTUP_TIMEOUT_MS : command.timeoutMs);
    function ready() {
      if (reason) return;
      clearTimeout(timer);
      timer = setTimeout(timeout, command.timeoutMs);
    }
    child.stdin?.on('error', () => { /* The supervisor may close the pipe before a racing stop. */ });
    child.stdout.on('data', (chunk) => log.push('stdout', chunk));
    child.stderr.on('data', (chunk) => log.push('stderr', spec.stderr ? spec.stderr.read(chunk, ready) : chunk));
    child.on('error', (error) => { if (!child.pid) spawnError = error; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(watchdog);
      abortSignal?.removeEventListener('abort', abort);
      if (spec.stderr) log.push('stderr', spec.stderr.finish());
      const output = log.finish();
      const outcome = spawnError ? { state: 'failed', code: null, error: spawnError.message }
        : job ? job(reason)
          : { state: reason ? 'termination_unconfirmed' : (code === 0 ? 'exited' : 'failed'), code };
      resolve(commandResult(command, outcome, output, signal, reason));
    });
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
  });
}

function commandResult(command, outcome, output, signal, reason) {
  return {
    success: outcome.state === 'exited', command: command.text, directory: command.directory,
    exit_code: outcome.code, signal: signal || null,
    timed_out: outcome.state === 'timed_out' || (outcome.state === 'termination_unconfirmed' && reason === 'timed_out'),
    state: outcome.state, ...(outcome.error ? { error: outcome.error } : {}), ...output,
  };
}

/** @param {{text: string, directory: string, cwd: string, shell: string, timeoutMs: number, env: NodeJS.ProcessEnv}} command
 * @param {{signal?: AbortSignal, onProgress?: (event: {state: string, duration_ms: number, stdout: string, stderr: string, stdout_truncated: boolean, stderr_truncated: boolean}) => void}} [options]
 */
async function runCommandProcess(command, { signal, onProgress } = {}) {
  const log = commandLog(onProgress);
  if (signal?.aborted) return commandResult(command, { state: 'stopped', code: null }, log.finish(), null, 'stopped');
  const spec = localProcess(command.text, command.shell, command.env);
  const child = spawn(spec.executable, spec.args, {
    cwd: command.cwd, env: spec.env, windowsHide: true, detached: process.platform !== 'win32',
    stdio: [spec.outcome ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  return supervise(child, spec, command, log, signal);
}

module.exports = { runCommandProcess };
