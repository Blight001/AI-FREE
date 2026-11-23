'use strict';
const assert = require('node:assert/strict');
const { nativeBrowserDrivers } = require('../../helpers/flows/native-browser-drivers');
const { emitFlowReport } = require('../../../scripts/verification/flow-reports');
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
];

async function run(automation, id, origin, flow = require('../flows/native-workflow.json')) {
  const { runFlow } = require('../../helpers/flows/runner');
  const result = await runFlow(flow, {
    ...nativeBrowserDrivers(automation, id, origin), input: { url: `${origin}/workflow`, probes },
    onProgress: ({ id: step, status }) => console.log(`[native-workflow] ${step}: ${status}`),
  });
  emitFlowReport(result);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
const framePages = {
  '/workflow-frames': `<title>Workflow frames</title>
    <button id="cover-control" onclick="document.getElementById('cover').hidden=false">Cover frame</button>
    <output id="frame-result">waiting</output>
    <div style="position:relative;margin:60px 0 0 90px;width:460px;height:330px">
      <iframe title="Outer frame" src="/workflow-frame-outer" style="width:440px;height:310px;border:5px solid"></iframe>
      <div id="cover" hidden style="position:absolute;inset:0;background:#ccc"></div>
    </div>`,
  '/workflow-frame-outer': `<iframe title="Inner frame" src="/workflow-frame-inner"
    style="margin:35px 0 0 45px;width:285px;height:190px;border:7px solid"></iframe>`,
  '/workflow-frame-inner': `<button id="frame-button" style="margin:25px">Frame fixture button</button>
    <script>
      const output = top.document.querySelector('#frame-result');
      let clicks = 0;
      output.textContent = 'ready';
      document.querySelector('#frame-button').addEventListener('click', (event) => {
        output.textContent = String(++clicks) + ' clicks, trusted=' + event.isTrusted;
      });
    </script>`,
};

function framePage(pathname) {
  return Object.hasOwn(framePages, pathname) ? framePages[pathname] : undefined;
}

async function checkFrameEntry(call, origin, entry) {
  const url = origin + '/workflow-frames';
  const take = await call('browser_control', { action: 'acquire' });
  assert.equal(take.success, true, entry);
  try {
    const nav = await call('browser_tab', { action: 'replace', url });
    assert.equal(nav.success, true, JSON.stringify(nav));
    const waitFor = (value) => call('browser_wait', {
      condition: 'text_contains', selector: '#frame-result', value, timeout_ms: 4000,
    });
    assert.equal((await waitFor('ready')).found, true, entry);
    const observed = await call('browser_observe', { filter: 'button', keyword: 'Frame fixture button', mark: false });
    const target = observed.items.find((item) => item.elementId === 'frame-button');
    assert(target, entry + ' must observe the nested button');
    const click = (targetArgs, value) => call('browser_action', {
      action: 'click', ...targetArgs,
      probes: [{ name: 'frame', selector: '#frame-result', read: 'text' }],
      expect: [{ name: 'frame', op: 'equals', value }],
    });
    const result = await click({ ref: target.id, observation_id: observed.observationId }, '1 clicks, trusted=true');
    assert.equal(result.businessVerification?.passed, true, entry + ' ' + JSON.stringify(result));
    assert.equal((await waitFor('1 clicks, trusted=true')).found, true, entry);
    const covered = await click({ selector: '#cover-control' }, '1 clicks, trusted=true');
    assert.equal(covered.success, true, entry + ' ' + JSON.stringify(covered));
    const blocked = await click({ selector: '#frame-button' }, '1 clicks, trusted=true');
    assert.equal(blocked.errorCode, 'TARGET_NOT_ACTIONABLE', entry);
    assert.equal(blocked.reason, 'occluded', entry);
    assert.equal(blocked.actionExecuted, false, entry);
    assert.equal((await waitFor('1 clicks, trusted=true')).found, true, entry);
    console.log('[native-workflow] same-origin frame verified via ' + entry);
  } finally {
    await call('browser_workflow', { action: 'cancel' });
    await call('browser_control', { action: 'release' });
  }
}

async function checkSameOriginFrames(automation, id, origin) {
  const { dispatchExternalBrowserTool } = require('../../../src/app/backend/services/external-browser-page-routing');
  const dispatch = automation.dispatch.bind(automation);
  await checkFrameEntry((tool, args) => dispatch(id, tool, args), origin, 'sidebar');
  await checkFrameEntry((tool, args) => dispatchExternalBrowserTool(dispatch, id, tool, args, {}), origin, 'external MCP');
}

module.exports = { html, run, framePage, checkSameOriginFrames };
