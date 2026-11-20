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
module.exports = { html, run };
