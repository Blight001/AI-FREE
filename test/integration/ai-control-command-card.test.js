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
  classList = {
    contains: (name) => this.className.split(' ').includes(name),
    add: (name) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
    remove: (name) => { this.className = this.className.split(' ').filter((value) => value !== name).join(' '); },
    toggle: () => {},
  };
  style = { removeProperty() {} };
  className = '';
  open = false;
  hidden = false;

  constructor(tagName) { this.tagName = tagName; }
  set textContent(value) { this.ownText = value; this.children = []; }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(''); }
  set innerHTML(value) {
    this.children = [...value.matchAll(/class="([^"]+)"/g)].map((match) => Object.assign(new Element('span'), { className: match[1] }));
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
    }
    this.children.push(...nodes);
  }
  prepend(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
    }
    this.children.unshift(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  appendChild(node) { this.append(node); }
  addEventListener(type, handler) { this.events[type] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getBoundingClientRect() { return { height: 0 }; }
  click() { this.events.click?.({ preventDefault() {} }); }
  querySelector(selector) {
    if (selector === ':scope > summary') return this.children.find((child) => child.tagName === 'summary');
    for (const child of this.children) {
      if (child.className.split(' ').includes(selector.slice(1))) return child;
      const result = child.querySelector(selector);
      if (result) return result;
    }
    return null;
  }
}

function loadController(context, name) {
  const controller = path.join(__dirname, '../../src/app/frontend/sidebar/client/app/side/controllers/pages/ai-control', name);
  vm.runInContext(fs.readFileSync(controller, 'utf8'), context, { filename: controller });
}

function cardFixture(t, initial = {}) {
  const context = vm.createContext({
    document: { createElement: (tag) => new Element(tag) },
    enableDetailsAnimation: (card) => ({ setOpen(open) { card.open = open; card.events.toggle?.(); } }),
    formatActivityDetail: (value) => typeof value === 'string' ? value : JSON.stringify(value),
    TOOL_DISPLAY_NAMES: {}, TOOL_ACTION_DISPLAY_NAMES: {},
    initial: { id: 'one', name: 'run_command', arguments: { command: 'echo ok', timeout_ms: 1500 }, ...initial },
  });
  loadController(context, 'ai-control-tool-card.js');
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

test('the page batch uses one activity and keeps its confirmed count on interruption', (t) => {
  const { card, update } = cardFixture(t, { name: 'browser_page_batch', status: 'running', arguments: {} });
  const summary = card.querySelector('.ai-chat-tool-state');
  update({ progress: { completed: 3, requested: 10 } });
  assert.equal(summary.textContent, '3/10 步');
  update({ status: 'error', result: { completed: 3, requested: 10, failedStepOutcome: 'unknown' } });
  update({ progress: { completed: 4, requested: 10 } });
  assert.equal(summary.textContent, '已中断 · 3/10 步');
});

function assistantFixture(options = { pending: true }) {
  const container = new Element('div');
  const context = vm.createContext({
    document: { createElement: (tag) => new Element(tag) },
    window: { getComputedStyle: () => ({ opacity: '1', transform: 'none' }) },
    el: () => container,
    formatActivityDetail: (value) => typeof value === 'string' ? value : JSON.stringify(value),
    renderMarkdownInto: (element, text) => { element.textContent = text; },
    TOOL_DISPLAY_NAMES: {}, TOOL_ACTION_DISPLAY_NAMES: {},
    options,
  });
  loadController(context, 'ai-control-tool-card.js');
  loadController(context, 'ai-control-chat-presentation.js');
  loadController(context, 'ai-control-tool-display.js');
  const view = vm.runInContext('createAssistantView(options)', context);
  const stack = container.querySelector('.ai-chat-assistant-stack');
  const groups = () => (stack.querySelector('.ai-chat-process-body') || stack).children
    .filter((node) => node.className === 'ai-chat-activity' && !node.hidden);
  const tool = (id, status, round) => view.upsertTool({ id, status, name: 'run_command' }, round);
  return { view, container, stack, groups, tool };
}

function clickDisclosure(details) {
  details.querySelector(':scope > summary').click();
}

test('consecutive tools stay in one expanded group until the next reply starts', () => {
  const { view, container, groups, tool } = assistantFixture();
  tool('first', 'running', 0);
  tool('first', 'success', 0);
  view.addContent(' ', 1);
  assert.equal(groups()[0].open, true);
  view.replaceContent('', 1);
  tool('second', 'running', 1);
  tool('second', 'error', 1);
  assert.equal(groups().length, 1);
  assert.match(groups()[0].textContent, /2次工具调用/);
  assert.equal(groups()[0].open, true);

  view.addContent('后续回复', 2);
  assert.equal(groups()[0].open, false);
  assert.match(container.querySelector('.ai-chat-answer').textContent, /后续回复/);
  clickDisclosure(groups()[0]);
  view.addContent('继续输出', 2);
  view.finalize();
  assert.equal(groups()[0].open, true);
});

test('a manually opened group stays open while the newest group collapses', () => {
  const { view, container, groups, tool } = assistantFixture();
  tool('first', 'success', 0);
  view.addContent('阶段回复', 1);
  clickDisclosure(groups()[0]);
  assert.equal(groups()[0].open, true);

  tool('second', 'success', 1);
  assert.deepEqual(groups().map((group) => group.open), [true, true]);
  view.setContent('最终回复');
  view.finalize();
  assert.deepEqual(groups().map((group) => group.open), [true, false]);
  assert.equal(container.querySelector('.ai-chat-process').open, true);
});

test('a completed staged reply folds its opening and progress as one ordered process', () => {
  const { view, stack, tool } = assistantFixture();
  view.addContent('开场说明', 0);
  tool('first', 'success', 0);
  view.addContent('中途进度', 1);
  tool('second', 'success', 1);
  view.addContent('最终回复', 2);
  assert.equal(stack.querySelector('.ai-chat-process'), null);
  view.finalize();

  const process = stack.querySelector('.ai-chat-process');
  assert.ok(process, 'The finalized turn has an expandable process');
  assert.equal(process.open, false);
  assert.deepEqual(stack.children.map((child) => child.className), ['ai-chat-process', 'ai-chat-answer-wrap']);
  assert.equal(stack.children[1].querySelector('.ai-chat-answer').textContent, '最终回复');
  assert.deepEqual(process.querySelector('.ai-chat-process-body').children.filter((node) => !node.hidden).map((node) =>
    node.querySelector('.ai-chat-answer')?.textContent || node.querySelector('.ai-chat-tool').dataset.toolId),
  ['开场说明', 'first', '中途进度', 'second']);
  clickDisclosure(process);
  assert.equal(process.open, true);
  view.finalize();
  assert.equal(process.open, true);
});

test('a paused turn shows its elapsed time and keeps the disclosure preference through continuation', () => {
  const { view, stack, groups, tool } = assistantFixture();
  view.addContent('开场说明', 0);
  tool('first', 'success', 0);
  view.addContent('未完成', 1);
  view.finalize({ durationMs: 237000, paused: true });
  assert.equal(stack.querySelector('.ai-chat-process'), null);
  assert.equal(groups()[0].open, false);
  assert.match(stack.querySelector('.ai-chat-turn-duration').textContent, /用时 3 分钟 57 秒/);
  clickDisclosure(groups()[0]);

  view.resume(1);
  assert.equal(stack.querySelector('.ai-chat-turn-duration'), null);
  view.addContent('续写完成', 1);
  view.finalize({ durationMs: 241000 });
  const completedProcess = stack.querySelector('.ai-chat-process');
  assert.equal(completedProcess.open, true);
  assert.match(completedProcess.querySelector(':scope > summary').textContent, /用时 4 分钟 1 秒/);
  assert.doesNotMatch(stack.textContent, /未完成/);
});

test('a restored timed turn without details displays a duration without a disclosure', () => {
  const { stack } = assistantFixture({ content: '简单回复', durationMs: 1000 });
  assert.equal(stack.querySelector('.ai-chat-process'), null);
  assert.equal(stack.querySelector('.ai-chat-turn-duration').textContent, '用时 1 秒');
});

test('a reply without intermediate text keeps the existing tool disclosure', () => {
  const { stack, groups } = assistantFixture({
    content: '最终回复', toolEvents: [{ id: 'only', name: 'run_command', status: 'success' }],
  });
  assert.equal(stack.querySelector('.ai-chat-process'), null);
  assert.equal(groups()[0].open, false);
});

test('manually opened tool details stay visible when the reply or finalization arrives', () => {
  const { view, groups, tool } = assistantFixture();
  tool('first', 'running', 0);
  const card = groups()[0].querySelector('.ai-chat-tool');
  clickDisclosure(card);
  tool('first', 'success', 0);
  view.replaceContent('最终回复', 1);
  view.finalize();
  assert.equal(groups()[0].open, true);
  assert.equal(card.open, true);
});

test('finalization without a reply folds the last tool group, including restored history', () => {
  const live = assistantFixture();
  live.tool('first', 'error', 0);
  live.view.finalize();
  assert.equal(live.groups()[0].open, false);

  const restored = assistantFixture({ toolEvents: [{ id: 'first', name: 'run_command', status: 'error' }] });
  assert.equal(restored.groups()[0].open, false);
});
