'use strict';

const VIDEO_EDITING_REGRESSION_CARD = Object.freeze({
  name: '本地视频剪辑回归测试',
  description: '面向本地视频编辑器的独立项目、素材、时间轴、导出业务验证模板。调用方需按页面实际控件覆盖 locator。',
  tags: ['local-web', 'regression', 'video-editor'],
  definition: { isolation: 'independent-test-project', cleanup: 'caller-controlled', read_only: false },
  steps: [
    { id: 'project', name: '选择项目并验证身份', type: 'mcp', tool: 'browser_workflow', arguments: { action: 'run', inherit_config: false, steps: [] } },
    { id: 'timeline', name: '添加素材并验证时间轴', type: 'mcp', tool: 'browser_workflow', arguments: { action: 'run', steps: [] } },
    { id: 'export', name: '打开导出并验证参数', type: 'mcp', tool: 'browser_workflow', arguments: { action: 'run', steps: [] } },
  ],
});

function videoEditingRegressionCard(overrides = {}) {
  return { ...VIDEO_EDITING_REGRESSION_CARD, ...overrides, probes: [
    { name: 'project', selector: '#projectSelect', read: 'text' },
    { name: 'duration', selector: '#exportEstimate', read: 'text' },
    { name: 'exportStatus', selector: '[data-testid="export-status"]', read: 'text' },
    ...(Array.isArray(overrides.probes) ? overrides.probes : []),
  ], expect: [
    { name: 'project', op: 'contains', value: '最终验收' },
    { name: 'duration', op: 'contains', value: '3 秒' },
    { name: 'exportStatus', op: 'contains', value: '导出任务已提交' },
    ...(Array.isArray(overrides.expect) ? overrides.expect : []),
  ] };
}

module.exports = { VIDEO_EDITING_REGRESSION_CARD, videoEditingRegressionCard };
