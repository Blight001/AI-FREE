'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  dispatch(type) { this.listeners[type]?.({ currentTarget: this, target: this }); }
}

class FakeOption {
  constructor(text, value) { this.textContent = text; this.value = value; }
}

const appRoot = path.resolve(__dirname, '../../../src/app');
const page = vm.createContext({
  document: { createElement: (tagName) => new FakeElement(tagName) },
  Option: FakeOption,
  homeDialogs: { close() {} },
});
vm.runInContext('globalThis.window = globalThis', page);
for (const file of [
  'shared/automation-schema.js',
  'frontend/renderer/controllers/pages/app-shell/automation-mcp-node-editor.js',
  'frontend/renderer/controllers/pages/app-shell/shell-home-automation.js',
]) vm.runInContext(fs.readFileSync(path.join(appRoot, file), 'utf8'), page, { filename: file });
const { HomeAutomationController, AutomationMcpNodeEditor } = vm.runInContext(
  '({ HomeAutomationController, AutomationMcpNodeEditor })', page,
);

function createController(node, mcpTools) {
  const controller = Object.create(HomeAutomationController.prototype);
  const selected = (value = '') => Object.assign(new FakeElement('select'), { value });
  controller.nodes = {
    'automation-browser-select': selected(),
    'automation-editor-message': new FakeElement('span'),
    'automation-mcp-editor': new FakeElement('div'),
    'automation-node-json': new FakeElement('textarea'),
    'automation-node-delete': new FakeElement('button'),
    'automation-start-node': selected(),
  };
  controller.api = { getBrowserConnections: async () => ({ ok: true, connections: [], mcpTools }) };
  controller.mcpTools = [];
  controller.mcpEditor = new AutomationMcpNodeEditor(controller.nodes, () => controller.mcpTools);
  controller.card = { steps: [node], flow: { start: node.id, edges: [] } };
  controller.canvas = { selectedId: node.id, render() {} };
  controller.syncStartNodes = () => {};
  return controller;
}

function field(controller, name) {
  const label = controller.nodes['automation-mcp-editor'].children.find((item) => item.tagName === 'label'
    && item.children[0]?.getAttribute('aria-label') === name);
  return label?.children[0];
}

test('MCP editor builds controls from both schema spellings and preserves legacy node and argument fields', async () => {
  const node = {
    id: 'step_mcp', type: 'mcp', tool: 'browser_action',
    arguments: { action: 'click', legacyArgument: { keep: true } }, legacyNodeField: ['keep'],
  };
  const controller = createController(node, [
    { name: 'browser_action', input_schema: { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['click', 'navigate'] }, timeout: { type: 'integer' }, enabled: { type: 'boolean' },
    } } },
    { name: 'other_tool', inputSchema: { type: 'object', properties: { target: { type: 'string' } } } },
  ]);

  await controller.loadConnections();
  controller.selectNode(node);
  assert.equal(field(controller, 'action').tagName, 'select');
  assert.equal(field(controller, 'timeout').type, 'number');
  assert.equal(field(controller, 'enabled').type, 'checkbox');

  field(controller, 'action').value = JSON.stringify('navigate');
  field(controller, 'action').dispatch('change');
  field(controller, 'timeout').value = '250';
  field(controller, 'timeout').dispatch('change');
  field(controller, 'enabled').checked = true;
  field(controller, 'enabled').dispatch('change');
  let draft = JSON.parse(controller.nodes['automation-node-json'].value);
  assert.equal(draft.arguments.action, 'navigate');
  assert.equal(draft.arguments.timeout, 250);
  assert.equal(draft.arguments.enabled, true);
  assert.deepEqual(draft.arguments.legacyArgument, { keep: true });
  assert.deepEqual(draft.legacyNodeField, ['keep']);

  controller.applyNode();
  assert.equal(controller.card.steps[0].arguments.action, 'navigate');
  field(controller, 'action').value = '';
  field(controller, 'action').dispatch('change');
  draft = JSON.parse(controller.nodes['automation-node-json'].value);
  assert.equal(Object.hasOwn(draft.arguments, 'action'), false);
  controller.applyNode();
  assert.match(controller.nodes['automation-editor-message'].textContent, /action/);

  const picker = controller.nodes['automation-mcp-editor'].children[0];
  picker.value = 'other_tool';
  picker.dispatch('change');
  assert.ok(field(controller, 'target'));
  field(controller, 'target').value = 'current page';
  field(controller, 'target').dispatch('change');
  draft = JSON.parse(controller.nodes['automation-node-json'].value);
  assert.equal(draft.tool, 'other_tool');
  assert.equal(draft.arguments.target, 'current page');
  assert.equal(draft.arguments.timeout, 250);
  assert.deepEqual(draft.legacyNodeField, ['keep']);
});

test('MCP editor keeps tool selection and raw JSON fallback when a tool schema is unavailable', async () => {
  const node = { id: 'legacy_step', type: 'mcp', tool: 'legacy_tool', arguments: { opaque: { value: 1 } }, oldField: 'preserved' };
  const controller = createController(node, [{ name: 'legacy_tool' }, { name: 'next_tool' }]);
  await controller.loadConnections();
  controller.selectNode(node);

  const [picker, hint] = controller.nodes['automation-mcp-editor'].children;
  assert.equal(picker.getAttribute('aria-label'), 'MCP 工具');
  assert.match(hint.textContent, /节点 JSON/);
  picker.value = '';
  picker.dispatch('change');
  controller.applyNode();
  assert.match(controller.nodes['automation-editor-message'].textContent, /请选择 MCP 工具/);
  controller.nodes['automation-mcp-editor'].children[0].value = 'next_tool';
  controller.nodes['automation-mcp-editor'].children[0].dispatch('change');

  const draft = JSON.parse(controller.nodes['automation-node-json'].value);
  assert.equal(draft.tool, 'next_tool');
  assert.deepEqual(draft.arguments, { opaque: { value: 1 } });
  assert.equal(draft.oldField, 'preserved');
});

test('MCP editor keeps legacy args fields and validates typed values from both controls and JSON', async () => {
  const node = { id: 'legacy_args', type: 'mcp', tool: 'typed_tool', args: { action: 'click', selector: '#save', count: 2 } };
  const controller = createController(node, [{ name: 'typed_tool', input_schema: {
    type: 'object', required: ['action', 'count'], additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['click', 'submit'] }, selector: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
    },
  } }]);
  await controller.loadConnections();
  controller.selectNode(node);

  field(controller, 'count').value = '3';
  field(controller, 'count').dispatch('change');
  let draft = JSON.parse(controller.nodes['automation-node-json'].value);
  assert.deepEqual(draft.args, { action: 'click', selector: '#save', count: 3 });
  assert.equal(Object.hasOwn(draft, 'arguments'), false);
  controller.applyNode();
  assert.equal(controller.card.steps[0].args.count, 3);

  controller.nodes['automation-node-json'].value = JSON.stringify({ ...draft, args: { ...draft.args, count: 3.5 } });
  controller.mcpEditor.parseAndRender();
  controller.applyNode();
  assert.match(controller.nodes['automation-editor-message'].textContent, /count/);
  assert.equal(controller.card.steps[0].args.count, 3);

  controller.nodes['automation-node-json'].value = JSON.stringify({ ...draft, args: { ...draft.args, extra: true } });
  controller.mcpEditor.parseAndRender();
  controller.applyNode();
  assert.match(controller.nodes['automation-editor-message'].textContent, /extra/);
});

test('MCP editor validates nested array item schemas', () => {
  const editor = new AutomationMcpNodeEditor({}, () => [{ name: 'nested', input_schema: {
    type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: {
      pin: { type: 'string' },
    } } } },
  } }]);
  assert.throws(() => editor.validateNode({ type: 'mcp', tool: 'nested', arguments: {
    rows: [{ pin: 4 }],
  } }), /rows.*0.*pin/);
});

test('template values survive form edits and validation without publishing an editor on window', async () => {
  assert.equal(Object.hasOwn(page, 'AppShellAutomationMcpNodeEditor'), false);
  assert.equal(Object.hasOwn(page, 'AutomationMcpNodeEditor'), false);
  const args = { action: '{operation}', count: '{amount}', enabled: '{flag}', selector: '#old' };
  const node = { id: 'template', type: 'mcp', tool: 'template_tool', args };
  const controller = createController(node, [{ name: 'template_tool', inputSchema: { type: 'object', properties: {
    action: { enum: ['click'] }, count: { type: 'integer' }, enabled: { type: 'boolean' }, selector: { type: 'string' },
  } } }]);
  await controller.loadConnections();
  controller.selectNode(node);
  for (const name of ['action', 'count', 'enabled']) {
    const control = field(controller, name);
    assert.equal(control.tagName === 'select' ? JSON.parse(control.value) : control.value, args[name]);
  }
  field(controller, 'selector').value = '#new';
  field(controller, 'selector').dispatch('change');
  controller.applyNode();
  assert.deepEqual(JSON.parse(JSON.stringify(controller.card.steps[0])), { ...node, args: { ...args, selector: '#new' } });
});

test('form edits use the raw JSON draft and honor arguments precedence when both spellings exist', async () => {
  const node = { id: 'mixed', type: 'mcp', tool: 'custom', arguments: { name: 'initial' }, args: { name: 'fallback' } };
  const controller = createController(node, [{ name: 'custom', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }]);
  await controller.loadConnections();
  controller.selectNode(node);
  const json = controller.nodes['automation-node-json'];
  json.value = JSON.stringify({ ...node, arguments: { ...node.arguments, extension: 'from JSON' } });
  controller.mcpEditor.parseAndRender();
  const control = field(controller, 'name');
  assert.equal(control.value, 'initial');
  control.value = 'edited';
  control.dispatch('change');
  controller.applyNode();
  assert.deepEqual(JSON.parse(JSON.stringify(controller.card.steps[0])), {
    ...node, arguments: { name: 'edited', extension: 'from JSON' },
  });
});

test('saving directly from the form rejects an invalid draft before writing and accepts a corrected draft', async () => {
  const node = { id: 'direct-save', type: 'mcp', tool: 'custom', args: { count: 2 } };
  const controller = createController(node, [{ name: 'custom', inputSchema: { type: 'object', properties: { count: { type: 'integer' } } } }]);
  await controller.loadConnections();
  controller.selectNode(node);
  controller.nodes['automation-editor-name'] = { value: 'direct save' };
  controller.nodes['automation-status'] = { dataset: {} };
  controller.panel = { hidden: true };
  const writes = [];
  controller.api.manageAutomationCard = async (args) => {
    writes.push(JSON.parse(JSON.stringify(args.cardData)));
    return { ok: true, data: { success: true } };
  };
  const control = field(controller, 'count');
  control.value = '2.5';
  control.dispatch('change');
  await assert.rejects(controller.saveEditor(), /arguments.count/);
  assert.equal(writes.length, 0);
  assert.equal(controller.card.steps[0].args.count, 2);
  control.value = '3';
  control.dispatch('change');
  await controller.saveEditor();
  assert.deepEqual(writes.map((card) => card.steps[0].args), [{ count: 3 }]);
});
