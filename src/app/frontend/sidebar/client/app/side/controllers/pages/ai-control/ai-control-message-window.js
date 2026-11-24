'use strict';

function aiControlMessageWindowStart(messages, endExclusive, limit) {
  const length = Array.isArray(messages) ? messages.length : 0;
  const end = Math.max(0, Math.min(length, Number(endExclusive) || 0));
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  let start = Math.max(0, end - size);
  while (start > 0 && messages[start]?.role !== 'user') start -= 1;
  return start;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { aiControlMessageWindowStart };
}