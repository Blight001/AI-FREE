'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class Element {
  children = [];
  ownText = '';
  events = {};
  attributes = {};
  dataset = {};
  classList = { add() {} };
  className = '';
  open = false;
  hidden = false;

  constructor(tagName) { this.tagName = tagName; }
  set textContent(value) { this.ownText = value; this.children = []; }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(''); }
  set innerHTML(value) {
    this.children = [...value.matchAll(/class="([^"]+)"/g)].map((match) => Object.assign(new Element('span'), { className: match[1] }));
  }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  addEventListener(type, handler) { this.events[type] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.className.split(' ').includes(selector.slice(1))) return child;
      const result = child.querySelector(selector);
      if (result) return result;
    }
    return null;
  }
}

function cardFixture(t, initial = {}) {
  const context = vm.createContext({
    document: { createElement: (tag) => new Element(tag) },
    enableDetailsAnimation: (card) => ({ setOpen(open) { card.open = open; card.events.toggle?.(); } }),
    formatActivityDetail: (value) => typeof value === 'string' ? value : JSON.stringify(value),
    TOOL_DISPLAY_NAMES: {}, TOOL_ACTION_DISPLAY_NAMES: {},
    initial: { id: 'one', name: 'run_command', arguments: { command: 'echo ok', timeout_ms: 1500 }, ...initial },
  });
  const controller = path.join(__dirname, '../../src/app/frontend/sidebar/client/app/side/controllers/pages/ai-control/ai-control-tool-card.js');
  vm.runInContext(fs.readFileSync(controller, 'utf8'), context, { filename: controller });
  return vm.runInContext('createToolActivity(initial)', context);
}

test('command output updates in place, and a collapsed card renders only the progress summary', (t) => {
  const { card, update, setOpen, tool } = cardFixture(t, { status: 'running' });
  const summary = card.querySelector('.ai-chat-tool-state');
  const body = card.querySelector('.ai-chat-command-result');
  assert.equal(summary.textContent, '运行中');
  assert.match(card.querySelector('.ai-chat-command-meta').textContent, /超时 1\.5s/);
  update({ progress: { state: 'running', duration_ms: 640, stdout: 'first' } });
  assert.match(card.querySelector('.ai-chat-tool-duration').textContent, /0\.6s/);
  assert.doesNotMatch(body.textContent, /first/);
  assert.equal(tool.progress, undefined);
  setOpen(true);
  assert.match(body.textContent, /first/);
  const stdout = body.querySelector('.ai-chat-tool-detail-body');
  update({ progress: { state: 'running', duration_ms: 900, stdout: 'first\nsecond', stdout_truncated: true } });
  assert.equal(body.querySelector('.ai-chat-tool-detail-body'), stdout);
  assert.match(body.textContent, /已截断/);
  assert.equal(stdout.textContent, 'first\nsecond');
  update({ progress: { state: 'stopping', duration_ms: 950, stdout: 'first\nsecond' } });
  assert.equal(summary.textContent, '正在停止');
  update({ status: 'error', result: { state: 'stopped', success: false, duration_ms: 1000 } });
  update({ progress: { state: 'running', stdout: 'late' } });
  assert.equal(summary.textContent, '已停止');
  assert.doesNotMatch(card.querySelector('.ai-chat-command-result').textContent, /late/);
});

test('command card shows distinct terminal states and understands old timeout results', (t) => {
  const cases = [
    [{ success: true, state: 'exited', exit_code: 0 }, '执行完成'],
    [{ success: false, state: 'failed', exit_code: 7 }, '执行失败'],
    [{ success: false, state: 'termination_unconfirmed', timed_out: true }, '无法确认终止'],
    [JSON.stringify({ success: false, timed_out: true }), '已超时'],
  ];
  for (const [result, label] of cases) {
    const { card } = cardFixture(t, { status: 'error', result });
    assert.equal(card.querySelector('.ai-chat-tool-state').textContent, label);
  }
});
