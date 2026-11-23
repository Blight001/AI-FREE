'use strict';

const recent = [];
function record(event) {
  const output = top.document.getElementById('events');
  if (!output) return;
  const label = event.target.id || event.target.localName || '页面';
  const point = event instanceof MouseEvent ? ` ${event.clientX}, ${event.clientY} btn=${event.button} buttons=${event.buttons}` : '';
  recent.unshift(`${event.type} · ${label}${point} · trusted=${event.isTrusted}`);
  recent.length = Math.min(recent.length, 10);
  output.textContent = recent.join('\n');
}

for (const name of ['pointerover', 'pointerdown', 'pointerup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'change', 'scroll']) {
  document.addEventListener(name, record, true);
}
document.addEventListener('contextmenu', (event) => event.preventDefault());
const knob = document.getElementById('drag-target');
const track = document.getElementById('track');
if (knob && track) {
  let start = null;
  knob.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    start = { x: event.clientX, left: knob.offsetLeft };
  });
  document.addEventListener('pointermove', (event) => {
    if (!start || !(event.buttons & 1)) return;
    const left = Math.max(0, Math.min(start.left + event.clientX - start.x, track.clientWidth - knob.offsetWidth));
    knob.style.left = `${left}px`;
    record(event);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    document.addEventListener(name, () => { start = null; });
  }
}
