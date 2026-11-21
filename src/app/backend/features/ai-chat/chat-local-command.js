'use strict';

const { redactSensitiveText } = require('../../browser-runtime/chromium-diagnostic-redaction');

const isLocalCommand = (toolName) => ['run_command', 'sandbox_files'].includes(toolName);

function commandMetadata(result) {
  return {
    state: result?.state, success: result?.success, exit_code: result?.exit_code,
    timed_out: result?.timed_out, stdout_truncated: result?.stdout_truncated,
    stderr_truncated: result?.stderr_truncated, duration_ms: result?.duration_ms,
  };
}

function visibleCommandOutput(result) {
  return { ...commandMetadata(result), stdout: redactSensitiveText(result?.stdout),
    stderr: redactSensitiveText(result?.stderr), error: redactSensitiveText(result?.error) };
}

function executeLocalCommand(context, activity, args) {
  return context.windowTools.execute(activity.name, args, {
    signal: context.signal,
    onProgress: (snapshot) => context.emit({
      type: 'tool_progress', tool: { id: activity.id, name: activity.name, progress: visibleCommandOutput(snapshot) }, round: context.round,
    }),
  });
}

module.exports = { commandMetadata, executeLocalCommand, isLocalCommand, visibleCommandOutput };
