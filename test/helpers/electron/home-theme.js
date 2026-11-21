'use strict';

const assert = require('node:assert/strict');

async function readTheme(win, theme) {
  win.webContents.send('app-theme-changed', theme);
  return win.webContents.executeJavaScript(`(async () => {
    const home = document.getElementById('browser-empty-state');
    const findRecord = (id) => home.querySelector('[data-history-id="' + id + '"]');
    const running = () => findRecord('fixture-browser-0');
    for (let attempt = 0; attempt < 40 && (!running() || document.documentElement.dataset.theme !== '${theme}'); attempt++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const homeButton = document.getElementById('home-tab-btn');
    const themedElements = [homeButton, running(), findRecord('fixture-browser-1'),
      findRecord('fixture-browser-2'), findRecord('shared-browser')];
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const transitions = themedElements.flatMap((element) => element.getAnimations());
    await Promise.allSettled(transitions.map((transition) => transition.finished));
    const rgba = (color) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    const inspect = (row) => {
      const style = getComputedStyle(row);
      return {
        label: row.querySelector('.browser-history-main').innerText,
        fill: rgba(style.backgroundColor),
        blurred: style.backdropFilter.includes('blur('),
        border: style.borderColor,
        borderAlpha: rgba(style.borderColor)[3],
      };
    };
    const wallpaper = getComputedStyle(home, '::before');
    return {
      wallpaperBlend: wallpaper.backgroundBlendMode,
      wallpaperTint: rgba(wallpaper.backgroundColor),
      wallpaperFilter: wallpaper.filter,
      running: inspect(running()),
      current: inspect(findRecord('fixture-browser-1')),
      error: inspect(findRecord('fixture-browser-2')),
      closed: inspect(findRecord('shared-browser')),
      railBlurred: getComputedStyle(home.querySelector('.shell-home-rail')).backdropFilter.includes('blur('),
      homeSelected: getComputedStyle(homeButton).borderColor,
      dockBorder: getComputedStyle(document.getElementById('tab-bar')).borderTopColor,
      runningOutline: rgba(getComputedStyle(running()).borderColor),
    };
  })()`);
}

async function checkHomeTheme(win) {
  const light = await readTheme(win, 'light');
  try {
    const dark = await readTheme(win, 'dark');
    for (const appearance of [light, dark]) {
      assert.match(appearance.running.label, /运行中/);
      assert.match(appearance.current.label, /当前浏览器/);
      assert.match(appearance.error.label, /异常/);
      assert.doesNotMatch(appearance.closed.label, /运行中|当前浏览器|异常/);
      for (const record of [appearance.running, appearance.current, appearance.error, appearance.closed]) {
        assert.ok(record.blurred && record.fill[3] >= 220 && record.fill[3] < 255);
      }
      assert.equal(appearance.running.borderAlpha, 255);
      assert.notEqual(appearance.running.border, appearance.closed.border);
      assert.notEqual(appearance.current.border, appearance.running.border);
      assert.notEqual(appearance.error.border, appearance.running.border);
      assert.ok(appearance.railBlurred);
      assert.notEqual(appearance.homeSelected, appearance.dockBorder);
      assert.equal(appearance.wallpaperBlend, 'normal');
      assert.equal(appearance.wallpaperTint[3], 0);
      assert.match(appearance.wallpaperFilter, /^blur\([0-9]+px\)$/);
    }
    assert.deepEqual(light.runningOutline, [99, 102, 241, 255]);
    assert.deepEqual(dark.runningOutline, [165, 180, 252, 255]);
    const nightChannels = dark.closed.fill.slice(0, 3);
    assert.ok(Math.max(...nightChannels) < 55 && Math.max(...nightChannels) - Math.min(...nightChannels) < 10,
      'night card fill should be neutral dark gray');
    for (const state of ['running', 'current', 'error', 'closed']) {
      assert.equal(light[state].fill[3], dark[state].fill[3]);
      assert.ok(light[state].fill[0] > dark[state].fill[0] + 100, `expected a darker night fill for ${state}`);
    }
  } finally {
    win.webContents.send('app-theme-changed', 'light');
  }
}

module.exports = { checkHomeTheme };
