'use strict';
(function () {
  const state = { timer: null, polling: false, initialized: false, disposed: false };
  const statuses = { idle: '准备就绪', running: '正在执行', paused: '已暂停，可接管页面', completed: '已完成', cancelled: '流程已结束' };
  const find = (id) => document.getElementById(`ai-control-workflow-${id}`);
  function connectionId() { return document.querySelector('#ai-chat-browser')?.value || ''; }
  async function call(action, mode) {
    const selected = connectionId();
    if (!selected || state.disposed || (action === 'status' && state.polling)) return;
    if (action === 'status') state.polling = true;
    try {
      const result = await window.aiFree.ai.workflow({ connection_id: selected, action, ...(mode ? { mode } : {}) });
      if (!state.disposed && connectionId() === selected) render(result, action);
    } catch (_) { if (!state.disposed) find('status').textContent = '浏览器连接暂时不可用'; }
    finally { if (action === 'status') state.polling = false; }
  }
  function details(data) {
    return (data.steps || []).map((step) => {
      const checks = (step.difference?.checks || []).map((check) =>
        `${check.name}：预期 ${check.op} ${check.expected ?? ''}；实际 ${check.actual ?? '不可用'}；${check.passed ? '通过' : '未通过'}`);
      return [`页面：${step.after?.url || step.before?.url || '未知'}`, `耗时：${step.durationMs || 0} 毫秒`,
        step.errorCode ? `原因：${step.reason || step.errorCode}` : '步骤完成', ...checks].join('\n');
    }).join('\n\n');
  }
  function statusText(data) {
    return `${statuses[data.status] || '准备就绪'}${data.currentStep ? ` · 第 ${data.currentStep} 步` : ''}${data.pausePending ? ' · 当前步骤结束后交回控制' : ''}`;
  }
  function render(result, action) {
    const data = result?.data || result;
    if (!data || result.ok === false || data.success === false) {
      find('status').textContent = data?.error || result?.error || '暂时无法读取浏览器状态'; return;
    }
    find('mode').value = data.mode || 'automation';
    find('status').textContent = statusText(data);
    find('resume').disabled = data.status !== 'paused';
    find('mode').disabled = data.status === 'running';
    if (action === 'report') { find('detail').hidden = false; find('detail').textContent = details(data) || '还没有诊断记录'; }
  }
  function init() {
    if (state.initialized) return;
    state.initialized = true;
    document.querySelector('#ai-control-workflow-mode')?.addEventListener('change', (event) => call('set_mode', event.target.value));
    document.querySelector('#ai-control-workflow-pause')?.addEventListener('click', () => call('pause'));
    document.querySelector('#ai-control-workflow-resume')?.addEventListener('click', () => call('resume'));
    document.querySelector('#ai-control-workflow-report')?.addEventListener('click', () => call('report'));
    find('cancel').addEventListener('click', () => call('cancel'));
    document.getElementById('ai-chat-browser')?.addEventListener('change', () => { find('detail').hidden = true; call('status'); });
    const refresh = () => call('status'); refresh(); state.timer = setInterval(refresh, 2000);
    window.addEventListener('unload', () => { state.disposed = true; clearInterval(state.timer); }, { once: true });
  }
  window.aiControlWorkflow = { init, call };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
