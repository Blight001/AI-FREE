'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { dispatchControl, poll, rendererProbe } = require('../flows/electron-controls');

const legacyStep = {
  id: 'legacy-action', type: 'mcp', tool: 'aifree.browser_action', name: '填写表单',
  args: { action: 'click', selector: '#original', nth: '{index}', observation_options: { limit: 4 } },
};
const card = {
  name: '旧版参数验收', steps: [legacyStep, { id: 'done', type: 'end' }],
  flow: { start: legacyStep.id, edges: [{ from: legacyStep.id, to: 'done', label: 'next' }], layout: {} },
};

function createAutomationUiFixture(layout) {
  const services = path.join(layout.root, 'src/app/backend/services');
  const { createNativeAutomationCardService } = require(path.join(services, 'native-automation-card-service.js'));
  const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require(path.join(services, 'native-browser-tool-definitions.js'));
  let state = { items: [], selectedId: '' };
  const service = createNativeAutomationCardService({
    read: () => ({ state: structuredClone(state) }),
    write: (next) => { state = structuredClone(next); return state; },
  });
  return {
    browserAction: NATIVE_BROWSER_TOOL_DEFINITIONS.find(({ name }) => name === 'browser_action'),
    service,
    async handle(input) {
      if (input.action === 'list_runs') return { ok: true, data: { success: true, items: [] } };
      return { ok: true, data: await service.execute(input) };
    },
  };
}

async function clickWhenVisible(inspect, selector) {
  const ready = await poll(() => inspect((target) => Boolean(document.querySelector(target)?.getBoundingClientRect().width), selector), Boolean);
  assert.ok(ready, `控件未显示 ${selector}`);
  assert.deepEqual(await inspect(dispatchControl, selector), { sent: true });
}

async function openSavedNode(win, layout, inspect, cardId) {
  await win.loadFile(layout.pages.shell);
  await clickWhenVisible(inspect, '#home-automation-tab');
  await clickWhenVisible(inspect, `#automation-card-list [data-action="edit"][data-id="${cardId}"]`);
  await clickWhenVisible(inspect, '#automation-editor[open] [data-node-id="legacy-action"]');
}

function editField(label, value) {
  const input = document.querySelector(`#automation-mcp-editor [aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) {
    throw new Error(`缺少可编辑的 MCP 控件：${label}`);
  }
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function checkHomeAutomationEditor(win, layout, fixture) {
  const { item } = await fixture.service.execute({ action: 'write', cardData: card });
  const inspect = rendererProbe(win.webContents);
  const wasVisible = win.isVisible();
  try {
    if (!wasVisible) win.showInactive();
    await openSavedNode(win, layout, inspect, item.id);
    await inspect(editField, 'MCP 工具', 'browser_action');
    assert.equal(await inspect(() => {
      const nth = document.querySelector('#automation-mcp-editor [aria-label="nth"]');
      if (!(nth instanceof HTMLInputElement)) throw new Error('缺少 nth 输入框');
      return nth.value;
    }), '{index}');
    await inspect(editField, 'nth', '1.5');
    await clickWhenVisible(inspect, '#automation-editor-save');
    assert.match(await inspect(() => document.getElementById('automation-editor-message').textContent), /nth/);
    assert.deepEqual((await fixture.service.execute({ action: 'get', id: item.id })).item.cardData, card);
    await inspect(editField, 'nth', '{index}');
    await inspect(editField, 'selector', '#edited');
    await clickWhenVisible(inspect, '#automation-node-apply');
    await clickWhenVisible(inspect, '#automation-editor-save');
    assert.ok(await poll(() => inspect(() => {
      const editor = document.getElementById('automation-editor');
      if (!(editor instanceof HTMLDialogElement)) throw new Error('找不到自动化编辑器对话框');
      return !editor.open;
    }), Boolean), '保存后自动化编辑器仍处于打开状态');
    const expected = { ...legacyStep, tool: 'browser_action', args: { ...legacyStep.args, selector: '#edited' } };
    assert.deepEqual((await fixture.service.execute({ action: 'get', id: item.id })).item.cardData,
      { ...card, steps: [expected, card.steps[1]] });
    await openSavedNode(win, layout, inspect, item.id);
    assert.deepEqual(await inspect(() => {
      const node = document.getElementById('automation-node-json');
      const selector = document.querySelector('#automation-mcp-editor [aria-label="selector"]');
      const tool = document.querySelector('#automation-mcp-editor [aria-label="MCP 工具"]');
      if (!(node instanceof HTMLTextAreaElement)) throw new Error('缺少节点 JSON 文本框');
      if (!(selector instanceof HTMLInputElement)) throw new Error('缺少 selector 输入框');
      if (!(tool instanceof HTMLSelectElement)) throw new Error('缺少 MCP 工具选择框');
      return { node: JSON.parse(node.value), selector: selector.value, tool: tool.value };
    }), { node: expected, selector: '#edited', tool: 'browser_action' });
    await clickWhenVisible(inspect, '#automation-editor-close');
  } finally {
    if (!wasVisible) win.hide();
  }
}

module.exports = { createAutomationUiFixture, checkHomeAutomationEditor };
