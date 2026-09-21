'use strict';

const probes = { type: 'array', maxItems: 32, items: { type: 'object', required: ['name', 'selector'], properties: {
  name: { type: 'string' }, selector: { type: 'string' },
  read: { type: 'string', enum: ['text', 'value', 'count', 'visible', 'attribute', 'duration', 'currentTime'] },
  attribute: { type: 'string' },
} } };
const expect = { type: 'array', maxItems: 32, items: { type: 'object', required: ['name', 'op'], properties: {
  name: { type: 'string' }, op: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'increases_by', 'changes', 'unchanged', 'exists'] },
  value: { type: ['string', 'number', 'boolean'] },
} } };
const checkedActionProperties = {
  probes, expect, identity_probe: { type: 'string', description: '标识当前项目的 probe 名称；操作前后必须不变' },
  inherit_config: { type: 'boolean', description: '为 true 才继承此前 set_mode 配置，默认每个流程或独立操作使用自己的配置' },
  locator: { type: 'object', properties: Object.fromEntries(['test_id', 'id', 'role', 'name', 'text', 'selector', 'scope', 'has_text'].map((name) => [name, { type: 'string' }])), additionalProperties: false },
  nth: { type: 'integer', minimum: 0 }, exact: { type: 'boolean' },
};
const BROWSER_WORKFLOW_TOOL = {
  name: 'browser_workflow',
  description: '自动化/调试双模式。默认 automation：动作前重新定位，动作后重新观察；debug 保留前后截图、AX、业务状态和差异。通过 probes 声明页面业务字段，expect 声明每步结果；未配置不会声称业务验证成功。run 使用现有卡片执行器串行执行最多50步。失败转debug并暂停，已发送动作不会自动重放；resume只核验已执行步骤。pause 在当前步骤结束后释放接管，cancel终止。report可返回前后图片。',
  input_schema: { type: 'object', properties: {
    action: { type: 'string', enum: ['status', 'set_mode', 'run', 'pause', 'resume', 'cancel', 'report'] },
    mode: { type: 'string', enum: ['automation', 'debug'] },
    probes, expect, identity_probe: checkedActionProperties.identity_probe, inherit_config: checkedActionProperties.inherit_config,
    timeout_ms: { type: 'number', maximum: 120000 },
    wait_for_stable: { type: 'boolean', description: '动作后等待页面连续观察稳定再验证，默认开启' },
    report_id: { type: 'string' }, include_images: { type: 'boolean' }, include_details: { type: 'boolean' }, include_history: { type: 'boolean' },
    steps: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['tool', 'arguments'], properties: {
      name: { type: 'string' }, tool: { type: 'string', enum: ['browser_action', 'browser_tab', 'browser_wait'] },
      arguments: { type: 'object', description: '原工具参数，可附probes/expect/identity_probe/timeout_ms' },
    } } },
  }, required: ['action'] },
};

module.exports = { BROWSER_WORKFLOW_TOOL, checkedActionProperties };
