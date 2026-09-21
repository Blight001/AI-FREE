'use strict';
const assert = require('node:assert/strict');
const { mcpToolResult } = require('../../../src/app/backend/services/mcp-tool-result');
const html = `<title>Workflow acceptance</title><style>button{margin:8px;padding:10px}#timeline{min-height:35px}</style>
<header><button>顶部工具栏</button></header>
<h1 id="project">测试项目</h1><div id="timeline"></div><output id="clicks">0</output>
<button data-testid="add" onclick="add()">添加到时间轴</button>
<button id="delayed" onclick="document.querySelector('#clicks').textContent++;setTimeout(add,850)">延迟添加</button>
<button id="export" onclick="document.querySelector('#dialog').hidden=false">打开导出</button>
<button id="switch" onclick="document.querySelector('#project').textContent='另一个项目'">切换项目</button>
<button id="move" onclick="document.querySelector('[data-testid=add]').style.marginLeft='180px'">移动添加按钮</button>
<button id="multiline" onclick="this.dataset.state='clicked'"><span style="display:block">♫</span>音频</button>
<div id="dialog" hidden><h2>导出测试项目</h2><input id="duration" value="10"></div>
<script>function add(){document.querySelector('#timeline').insertAdjacentHTML('beforeend','<span class="clip">片段</span>')}</script>`;
const probes = [
  { name: 'project', selector: '#project', read: 'text' },
  { name: 'clips', selector: '.clip', read: 'count' },
  { name: 'clicks', selector: '#clicks', read: 'text' },
  { name: 'export', selector: '#dialog', read: 'attribute', attribute: 'hidden' },
];

async function run(automation, id, origin) {
  const call = (tool, args) => automation.dispatch(id, tool, args);
  await call('browser_control', { action: 'acquire' });
  await call('browser_tab', { action: 'navigate', url: `${origin}/workflow` });
  await call('browser_wait', { selector: '#project', condition: 'visible', timeout_ms: 5000 });
  await call('browser_workflow', { action: 'set_mode', mode: 'debug', probes: probes.slice(0, 3), identity_probe: 'project' });
  let observed = await call('browser_observe', { mark: false });
  assert.equal(observed.region, null, 'default observation must not select the first header');
  const missingRegion = await call('browser_observe', { region: { role: 'navigation', label: 'missing' }, mark: false });
  assert.equal(missingRegion.errorCode, 'REGION_NOT_FOUND');
  await call('browser_control', { action: 'acquire' });
  const multiline = await call('browser_action', { action: 'click', locator: { role: 'button', name: '♫ 音频' },
    probes: [{ name: 'clicked', selector: '#multiline', read: 'attribute', attribute: 'data-state' }], identity_probe: '',
    expect: [{ name: 'clicked', op: 'equals', value: 'clicked' }] });
  assert.equal(multiline.success, true, JSON.stringify(multiline));
  observed = await call('browser_observe', { mark: false });
  const add = observed.items.find((item) => item.testId === 'add');
  assert(add, 'data-testid metadata must survive observation');
  assert.equal((await call('browser_action', { action: 'click', selector: '#move' })).success, true);
  const moved = await call('browser_action', { action: 'click', ref: add.id, observation_id: observed.observationId,
    expect: [{ name: 'clips', op: 'increases_by', value: 1 }] });
  assert.equal(moved.success, true, JSON.stringify(moved));
  const report = await call('browser_workflow', { action: 'report', include_images: true });
  assert.equal(report.images.length, 2);
  assert(report.steps[0].before.accessibilityTree.nodes.length > 0);
  assert(!JSON.stringify(mcpToolResult(report).structuredContent).includes('base64,'));
  assert.equal(mcpToolResult(report).content.filter((item) => item.type === 'image').length, 2);

  await call('browser_workflow', { action: 'set_mode', mode: 'automation' });
  const chain = await call('browser_workflow', { action: 'run', steps: [
    { name: '延迟添加', tool: 'browser_action', arguments: { action: 'click', selector: '#delayed', timeout_ms: 100,
      expect: [{ name: 'clips', op: 'increases_by', value: 1 }] } },
    { name: '导出', tool: 'browser_action', arguments: { action: 'click', selector: '#export',
      probes: [{ name: 'title', selector: '#dialog h2', read: 'text' }, { name: 'dialog', selector: '#dialog', read: 'visible' }],
      identity_probe: '', expect: [{ name: 'title', op: 'equals', value: '导出测试项目' }, { name: 'dialog', op: 'equals', value: true }] } },
  ] });
  assert.equal(chain.success, false, 'business timeout must pause the chain');
  assert.equal(chain.mode, 'debug'); assert.equal(chain.status, 'paused');
  const resumed = await call('browser_workflow', { action: 'resume' });
  assert.equal(resumed.success, true, JSON.stringify(resumed));
  const state = await automation.runtimeCommand(automation.requireConnection(id), 'inspect-page-state', { probes });
  assert.equal(state.values.clips.value, 2, 'resume must not duplicate the committed addition');
  assert.equal(state.values.clicks.value, '1');
  const switched = await call('browser_workflow', { action: 'run', steps: [
    { tool: 'browser_action', arguments: { action: 'click', selector: '#switch', timeout_ms: 100 } },
  ] });
  assert.equal(switched.success, false); assert.equal(switched.errorCode, 'BUSINESS_STATE_MISMATCH');
  await call('browser_workflow', { action: 'cancel' });
  console.log('[native-workflow] moving refs, debug AX/images, state checks, delayed resume without duplicate, project switch passed');
}
module.exports = { html, run };
