'use strict';

const AUTOMATION_CARD_SERVICE_ACTIONS = Object.freeze([
  'rules', 'list', 'get', 'write', 'patch_step', 'insert_step', 'delete_step', 'move_step', 'delete', 'run',
  'validate', 'clone', 'versions', 'get_version', 'set_enabled', 'export', 'template', 'restore', 'purge',
]);
const AUTOMATION_RUN_ACTIONS = Object.freeze([
  'start_run', 'list_runs', 'get_run', 'list_run_steps', 'cancel_run', 'retry_run', 'pause_run', 'resume_run', 'step_run',
]);
const AUTOMATION_CARD_EXECUTION_ACTIONS = new Set(['run', 'start_run', 'retry_run', 'resume_run', 'step_run']);
const AUTOMATION_CARD_ACTIONS = Object.freeze([...AUTOMATION_CARD_SERVICE_ACTIONS, ...AUTOMATION_RUN_ACTIONS]);
const AUTOMATION_CARD_READ_ONLY_ACTIONS = new Set([
  'rules', 'list', 'get', 'validate', 'versions', 'get_version', 'export', 'template',
  'list_runs', 'get_run', 'list_run_steps',
]);

function needsBrowserAdmission(action) {
  return action === 'purge' || AUTOMATION_CARD_EXECUTION_ACTIONS.has(action);
}

function sameBrowserInstance(original, current) {
  return Boolean(original && current && original.id === current.id
    && original.browserProcessId === current.browserProcessId && original.connectedAt === current.connectedAt);
}

module.exports = {
  needsBrowserAdmission,
  sameBrowserInstance,
  AUTOMATION_CARD_ACTIONS,
  AUTOMATION_CARD_EXECUTION_ACTIONS,
  AUTOMATION_CARD_READ_ONLY_ACTIONS,
  AUTOMATION_CARD_SERVICE_ACTIONS,
  AUTOMATION_RUN_ACTIONS,
};
