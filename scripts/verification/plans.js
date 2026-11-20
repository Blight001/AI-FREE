'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { catalog, projectRoot } = require('./catalog');
const { validateFlow } = require('../../test/helpers/flows/runner');
const { domainContract } = require('../../test/helpers/flows/domains');

function prepareScenario(file, entry, baseDirectory) {
  if (!entry.interaction?.configurable) throw new Error('INTERACTION_NOT_CONFIGURABLE');
  if (typeof file !== 'string') throw new Error('SCENARIO_PATH_REQUIRED');
  const source = path.resolve(baseDirectory, file);
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('SCENARIO_SIZE_LIMIT');
  const scenario = JSON.parse(fs.readFileSync(source, 'utf8'));
  const contract = domainContract(entry.interaction.domain);
  const tools = Object.keys(contract.operations);
  validateFlow(scenario, Object.fromEntries(tools.map((tool) => [tool, () => {}])), contract);
  return scenario;
}

function snapshotScenario(entry) {
  if (entry.scenario || !entry.interaction?.configurable) return entry;
  return { ...entry, scenario: prepareScenario(entry.interaction.scenario, entry, projectRoot) };
}

function selectedChecks(checks, entries, baseDirectory) {
  const selected = new Map();
  for (const check of checks) {
    if (Object.keys(check).some((key) => !['id', 'scenario'].includes(key))) throw new Error('UNKNOWN_CHECK_OPTION');
    if (!entries.has(check.id) || selected.has(check.id)) throw new Error('UNKNOWN_OR_DUPLICATE_CHECK');
    const registered = entries.get(check.id);
    const entry = { ...registered, scenario: check.scenario === undefined ? undefined
      : prepareScenario(check.scenario, registered, baseDirectory) };
    selected.set(check.id, entry);
  }
  return selected;
}

function resolvePlan(flow, baseDirectory = projectRoot) {
  if (flow.schemaVersion !== 1 || !/^[a-z][a-z0-9-]{0,79}$/.test(flow.id)) throw new Error('INVALID_VERIFICATION_FLOW');
  if (Object.keys(flow).some((key) => !['schemaVersion', 'id', 'checks'].includes(key))) throw new Error('UNKNOWN_FLOW_OPTION');
  if (!Array.isArray(flow.checks) || !flow.checks.length || flow.checks.length > 50) throw new Error('INVALID_FLOW_CHECKS');
  const entries = new Map(catalog().map((entry) => [entry.id, entry]));
  const selected = selectedChecks(flow.checks, entries, baseDirectory);
  const plan = new Map();
  const add = (entry) => {
    if (plan.has(entry.id)) return;
    for (const id of entry.after || []) add(selected.get(id) || entries.get(id));
    plan.set(entry.id, entry);
  };
  for (const entry of selected.values()) add(entry);
  return [...plan.values()].map(snapshotScenario);
}

module.exports = { resolvePlan, snapshotScenario };
