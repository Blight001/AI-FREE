'use strict';

const fs = require('node:fs');
const { atomicWrite } = require('../../platform/atomic-json');
const { BENCHMARK_VERSION } = require('./mcp-benchmark-score');

const MAX_HISTORY = 50;

function safeModelName(value) {
  return String(value || '').slice(0, 120)
    .replace(/sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._-]+|(?:api[_ -]?key|token|secret)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/[A-Za-z0-9_-]{48,}/g, '[redacted]');
}

function normalizeRecord(record) {
  return {
    id: String(record.id || ''),
    mode: record.mode === 'online' ? 'online' : 'local',
    benchmarkVersion: record.benchmarkVersion ?? BENCHMARK_VERSION,
    sourceHash: typeof record.sourceHash === 'string' ? record.sourceHash.slice(0, 200) : '',
    createdAt: Number(record.createdAt || 0),
    modelId: safeModelName(record.modelId),
    modelName: safeModelName(record.modelName),
    status: ['completed', 'failed', 'cancelled', 'invalid'].includes(record.status) ? record.status : 'invalid',
    reasonCode: /^[A-Z0-9_]{1,80}$/.test(String(record.reasonCode || '')) ? String(record.reasonCode) : '',
    score: Number.isInteger(record.score) ? Math.max(0, Math.min(100, record.score)) : null,
    results: Array.isArray(record.results) ? record.results.slice(0, 5).map((item) => ({
      id: String(item.id || ''), title: String(item.title || '').slice(0, 80),
      passed: item.passed === true, points: item.points === 20 ? 20 : 0,
      evidence: String(item.evidence || '').slice(0, 180),
    })) : [],
  };
}

function createMcpBenchmarkHistory(filePath) {
  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('成绩文件格式无效');
      return parsed.slice(-MAX_HISTORY).map(normalizeRecord);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  function append(record) {
    const records = read();
    records.push(normalizeRecord(record));
    atomicWrite(filePath, records.slice(-MAX_HISTORY));
    return records.slice(-MAX_HISTORY);
  }

  return { read, append };
}

module.exports = { MAX_HISTORY, createMcpBenchmarkHistory, normalizeRecord, safeModelName };
