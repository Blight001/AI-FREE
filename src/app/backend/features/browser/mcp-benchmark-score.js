'use strict';

const { EXPECTED_ORDER } = require('./mcp-benchmark-fixture');

const BENCHMARK_VERSION = 1;

function includesReportedAnswer(result, expectedValue) {
  return Boolean(expectedValue) && /\"readValue\"\s*:\s*\"([0-9.]+%)\"/.exec(String(result || ''))?.[1] === expectedValue;
}

function sameOrder(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function scoreMcpBenchmark(snapshot, modelResult, expectedValue) {
  const results = [
    { id: 'table-read', title: '读取与核对', passed: includesReportedAnswer(modelResult, expectedValue), evidence: includesReportedAnswer(modelResult, expectedValue) ? '回答包含页面校验值' : '回答缺少正确页面校验值' },
    { id: 'async-controls', title: '异步控件与输入', passed: snapshot.control?.value === 'MCP-OK' && snapshot.control?.checked === true, evidence: snapshot.control ? `${snapshot.control.value}；已勾选=${snapshot.control.checked}` : '服务端未收到有效控件验证' },
    { id: 'drag-sort', title: '拖拽排序', passed: sameOrder(snapshot.order, EXPECTED_ORDER), evidence: snapshot.order ? snapshot.order.join(', ') : '服务端未收到拖拽后的顺序' },
    { id: 'download', title: '文件下载', passed: snapshot.downloadVerified === true, evidence: snapshot.downloadVerified ? '本轮目录内文件字节匹配' : '未发现匹配的下载产物' },
    { id: 'upload', title: '文件上传', passed: snapshot.uploaded === true, evidence: snapshot.uploaded ? '服务端字节校验通过' : '未收到匹配的合成测试文件' },
  ].map((item) => ({ ...item, points: item.passed ? 20 : 0 }));
  const score = results.reduce((total, item) => total + item.points, 0);
  return { version: BENCHMARK_VERSION, score, maxScore: 100, passed: score === 100, results };
}

module.exports = { BENCHMARK_VERSION, scoreMcpBenchmark };
