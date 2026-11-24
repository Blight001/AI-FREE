'use strict';

function interruptedToolResult(started) {
  return {
    success: false,
    state: started ? 'termination_unconfirmed' : 'stopped',
    actionExecuted: started ? null : false,
    errorCode: started ? 'AI_TOOL_OUTCOME_UNCONFIRMED' : 'AI_TOOL_NOT_STARTED',
    error: started ? '工具已中断，执行结果未知。继续前请先核验结果，避免重放。' : '工具因用户停止而未开始。',
  };
}

function skipInterruptedManagedTools(state, checkpoint) {
  if (!checkpoint.pending.some((call) => state.managedNoReplay?.(call.function?.name))) return false;
  for (const call of checkpoint.pending) {
    state.modelMessages.push({ role: 'tool', tool_call_id: call.id, name: call.function?.name,
      content: JSON.stringify(interruptedToolResult(call.id === checkpoint.inFlight)) });
  }
  state.modelMessages.push({ role: 'system', ai_free_card_context: true,
    content: '浏览器步骤已中断。列出标签并重新观察，核对页面和此前动作结果后再继续。结果未知的操作不得直接重发。' });
  return true;
}

module.exports = { interruptedToolResult, skipInterruptedManagedTools };
