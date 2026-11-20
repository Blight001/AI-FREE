'use strict';

const { setTimeout: delay } = require('node:timers/promises');

function dispatchControl(selector, key) {
  const element = document.querySelector(selector);
  if (!element?.getBoundingClientRect().width || element.disabled) return { sent: false, errorCode: 'CONTROL_UNAVAILABLE' };
  element.focus();
  if (key) element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  else element.click();
  return { sent: true };
}

async function poll(read, matches, signal) {
  const until = Date.now() + 2000;
  let value = await read();
  while (!matches(value) && Date.now() < until) {
    await delay(20, undefined, { signal });
    value = await read();
  }
  return value;
}

function rendererProbe(webContents) {
  return (fn, ...args) => webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
}

module.exports = { dispatchControl, poll, rendererProbe };
