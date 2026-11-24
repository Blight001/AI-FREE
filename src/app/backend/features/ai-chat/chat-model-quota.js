'use strict';

const { parseChatQuotaUsed } = require('../../../shared/quota-display');

function recordModelQuota(state, result) {
  if (state.useCustomApi || !state.onQuotaUsed) return;
  const increment = parseChatQuotaUsed(result?.quota_cost_increment);
  const cost = increment ?? parseChatQuotaUsed(result?.quota_cost);
  if (cost > 0) state.onQuotaUsed(cost);
}

module.exports = { recordModelQuota };
