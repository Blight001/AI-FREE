'use strict';

const DRAW_CIRCLE = '调用鼠标在这个画布上画一个圆';
const CIRCLE_PATH = '/circle';
const CIRCLE_SCRIPT_PATH = '/circle-page.js';
const SVG_NS = 'http://www.w3.org/2000/svg';

function circlePage() {
  const buttons = Array.from({ length: 42 }, (_, index) => index === 21
    ? '<button id="btnCircle" type="button">圆形</button>'
    : `<button id="tool-${index}" aria-label="${`工具 ${index} 的说明 `.repeat(12)}" type="button">工具 ${index}</button>`);
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>画圆验收</title>
    <style>
      #tools { display:grid; grid-template-columns:repeat(14, minmax(0, 1fr)); gap:2px; max-width:800px }
      button { white-space:nowrap; overflow:hidden; padding-inline:0 }
      #drawing { position:fixed; top:180px; left:12px; background:#eee }
      #noise { position:fixed; top:180px; left:380px }
      #circle-result { position:fixed; top:380px; left:12px }
    </style>
    <div id="tools">${buttons.join('')}</div>
    <svg id="drawing" width="350" height="190" aria-label="画布"></svg>
    <canvas id="noise" width="360" height="180" aria-hidden="true"></canvas>
    <output id="circle-result">圆形数量 0</output><script src="${CIRCLE_SCRIPT_PATH}" defer></script></html>`;
}

function initializeDrawing(namespace) {
  const canvas = document.querySelector('#noise');
  const ctx = canvas.getContext('2d');
  const noise = ctx.createImageData(canvas.width, canvas.height);
  let seed = 173;
  for (let i = 0; i < noise.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise.data.set([seed >>> 24, (seed >>> 16) & 255, (seed >>> 8) & 255, 255], i);
  }
  ctx.putImageData(noise, 0, 0);
  const drawing = document.querySelector('#drawing');
  let active = false;
  let origin = null;
  let selections = 0;
  document.querySelector('#btnCircle').addEventListener('click', () => {
    active = true;
    selections += 1;
  });
  drawing.addEventListener('pointerdown', (event) => {
    if (!active) return;
    drawing.setPointerCapture(event.pointerId);
    origin = { x: event.offsetX, y: event.offsetY };
  });
  drawing.addEventListener('pointerup', (event) => {
    if (!origin) return;
    const diameter = Math.min(Math.abs(event.offsetX - origin.x), Math.abs(event.offsetY - origin.y));
    const circle = document.createElementNS(namespace, 'circle');
    circle.setAttribute('cx', origin.x + diameter / 2);
    circle.setAttribute('cy', origin.y + diameter / 2);
    circle.setAttribute('r', diameter / 2);
    drawing.append(circle);
    origin = null;
    const rendered = drawing.querySelectorAll('circle');
    document.querySelector('#circle-result').textContent = `圆形数量 ${rendered.length}，直径 ${circle.r.baseVal.value * 2}，工具点击 ${selections}`;
  });
}

const circleScript = `(${initializeDrawing.toString()})(${JSON.stringify(SVG_NS)});`;

function circlePlan(origin) {
  const target = origin + CIRCLE_PATH;
  return {
    tools: ['browser_tab', 'browser_control', 'browser_observe', 'browser_action'],
    steps: [
      ['browser_tab', { action: 'list' }],
      ['browser_control', { action: 'acquire' }],
      ['browser_observe', { tags: ['button'], limit: 60, include_screenshot: true, mark: false }],
      ([tabs, control, observed]) => {
        if (!JSON.stringify(tabs).includes(target) || control?.takeoverActive !== true || observed?.url !== target) return null;
        if (!observed.observationId || observed.image_omitted_reason !== 'context_budget' || !observed._context_omitted) return null;
        const button = observed.items?.find((item) => item.elementId === 'btnCircle' || item.selector === '#btnCircle');
        if (!button?.id) return null;
        return ['browser_action', { action: 'click', ref: button.id, observation_id: observed.observationId }];
      },
      ['browser_action', { action: 'drag', x: 48, y: 220, to_x: 144, to_y: 316 }],
      ['browser_observe', { tags: ['output'], keyword: '圆形数量', include_text: true, mark: false }],
    ],
    finish(result) {
      if (result?.url === target && result.items?.some((item) => item.text === '圆形数量 1，直径 96，工具点击 1')) {
        return '已画出一个直径 96 的圆。';
      }
      return '没有读回预期图形。';
    },
  };
}

module.exports = { CIRCLE_PATH, CIRCLE_SCRIPT_PATH, DRAW_CIRCLE, circlePage, circlePlan, circleScript };
