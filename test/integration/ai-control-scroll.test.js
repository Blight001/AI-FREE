'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = path.resolve(__dirname, '../../src/app/frontend/sidebar/client/app/side/controllers/pages/ai-control/ai-control-scroll.js');

function fixture() {
  const viewport = Object.assign(new EventTarget(), { scrollHeight: 500, clientHeight: 200, scrollTop: 0 });
  const button = Object.assign(new EventTarget(), { hidden: true });
  const document = { activeElement: null };
  viewport.focus = () => { document.activeElement = viewport; };
  const window = new EventTarget();
  let resize;
  const surface = { viewport, messages: {}, button };
  const context = vm.createContext({ window, document, AbortController, surface, ResizeObserver: class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() {}
  } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context);
  vm.runInContext('bindChatScroll(surface)', context);
  return { viewport, button, document, grow: (height) => { viewport.scrollHeight = height; resize(); } };
}

test('新内容只在底部跟随，上滑后保留位置，再次滚到底部自动恢复', () => {
  const { viewport, button, grow } = fixture();
  assert.equal(viewport.scrollTop, 300);
  grow(600);
  assert.equal(viewport.scrollTop, 400);

  viewport.scrollTop = 140;
  viewport.dispatchEvent(new Event('scroll'));
  grow(700);
  assert.equal(viewport.scrollTop, 140);
  assert.equal(button.hidden, false);

  viewport.scrollTop = 499;
  viewport.dispatchEvent(new Event('scroll'));
  grow(800);
  assert.equal(viewport.scrollTop, 600);
  assert.equal(button.hidden, true);
});

test('向上的滚轮先暂停跟随，回到底部按钮恢复跟随并转移键盘焦点', () => {
  const { viewport, button, document, grow } = fixture();
  viewport.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: -20 }));
  grow(600);
  assert.equal(viewport.scrollTop, 300);
  assert.equal(button.hidden, false);
  document.activeElement = button;
  button.dispatchEvent(new Event('click'));
  grow(700);
  assert.equal(viewport.scrollTop, 500);
  assert.equal(button.hidden, true);
  assert.equal(document.activeElement, viewport);
});

test('思考收起引起的延迟滚动事件不会取消最新回复跟随', () => {
  const { viewport, button, grow } = fixture();
  // Chromium 收缩时先钳制 scrollTop，消息随后在下一次 scroll 回调前增长。
  viewport.scrollHeight = 300;
  viewport.scrollTop = 100;
  viewport.scrollHeight = 800;
  viewport.dispatchEvent(new Event('scroll'));
  grow(800);
  assert.equal(viewport.scrollTop, 600);
  assert.equal(button.hidden, true);
});
