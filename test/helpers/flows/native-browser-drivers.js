'use strict';

const assert = require('node:assert/strict');
const { bindDomain } = require('./domains');
const { mcpToolResult } = require('../../../src/app/backend/services/mcp-tool-result');

function validateNavigation(tool, args, origin) {
  if (tool === 'browser_tab' && args.url) assert.equal(new URL(args.url).origin, origin, 'FLOW_FIXTURE_NAVIGATION_REQUIRED');
  if (tool === 'browser_workflow') {
    for (const step of args.steps || []) validateNavigation(step.tool, step.arguments || {}, origin);
  }
}

function findObserved({ observation, testId, selector }) {
  assert(Boolean(testId) !== Boolean(selector), 'FLOW_SINGLE_LOCATOR_REQUIRED');
  const items = observation.items.filter((item) => testId ? item.testId === testId : item.selector === selector);
  assert.equal(items.length, 1, 'FLOW_TARGET_NOT_UNIQUE');
  return { ref: items[0].id, value: items[0].value, checked: items[0].checked };
}

function checkReport({ report }) {
  const result = mcpToolResult(report);
  return {
    images: result.content.filter((item) => item.type === 'image').length,
    ax: report.steps[0].before.accessibilityTree.nodes.length > 0,
    metadataSafe: !JSON.stringify(result.structuredContent).includes('base64,'),
  };
}

function observationEvidence({ observation, forbiddenText }) {
  const nodes = observation.accessibilityTree?.nodes;
  const checkboxes = (nodes || []).filter((node) => node.role === 'checkBox');
  return {
    ax: observation.accessibilityTree?.format === 'ax-tree-v1' && Array.isArray(nodes),
    png: observation.screenshot?.format === 'png' && observation.dataUrl?.startsWith('data:image/png'),
    passwordSafe: typeof forbiddenText === 'string' && forbiddenText.length > 0
      && !JSON.stringify(observation).includes(forbiddenText),
    checkedTrue: checkboxes.some((node) => node.states.checked === true),
    checkedFalse: checkboxes.some((node) => node.states.checked === false),
  };
}

function tabTargets({ listing }) {
  const tabs = listing.tabs;
  assert(tabs.length >= 2, 'FLOW_TWO_TABS_REQUIRED');
  const target = listing.activeTab?.id || tabs[0].id;
  const other = tabs.find((tab) => String(tab.id) !== String(target));
  return { target: Number(target), other: Number(other.id), countAfterClose: tabs.length - 1 };
}

function nativeBrowserDrivers(automation, id, origin) {
  const tools = ['browser_control', 'browser_tab', 'browser_wait', 'browser_observe', 'browser_action', 'browser_workflow'];
  const drivers = Object.fromEntries(tools.map((tool) => [tool, (args) => {
    validateNavigation(tool, args, origin);
    return automation.dispatch(id, tool, args);
  }]));
  return bindDomain('native-browser', {
    ...drivers, findObserved, checkReport, observationEvidence, tabTargets,
    // These readbacks bypass action/workflow success reporting.
    inspectState: (args) => automation.runtimeCommand(automation.requireConnection(id), 'inspect-page-state', args),
    inspectTabs: () => automation.runtimeCommand(automation.requireConnection(id), 'list-tabs'),
  });
}

module.exports = { nativeBrowserDrivers };
