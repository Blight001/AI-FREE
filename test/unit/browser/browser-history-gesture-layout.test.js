'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BROWSER_HISTORY_GESTURE_GEOMETRY,
  createBrowserHistoryGestureRows,
  findBrowserHistoryGestureRowAtPoint,
  getBrowserHistoryGesturePopupHeight,
} = require('../../../src/app/shared/browser-history-gesture-layout');

test('history popup hit regions match the rendered row height and spacing', () => {
  const history = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
  const rows = createBrowserHistoryGestureRows(history);
  const layout = { x: 40, y: 100, width: 280, height: getBrowserHistoryGesturePopupHeight(rows.length), rows };

  assert.deepEqual(rows, [
    { id: 'first', top: 35, bottom: 107 },
    { id: 'second', top: 110, bottom: 182 },
    { id: 'third', top: 185, bottom: 257 },
  ]);
  for (const row of rows) {
    const centerY = layout.y + (row.top + row.bottom) / 2;
    assert.equal(findBrowserHistoryGestureRowAtPoint(layout, layout.x + 20, centerY)?.id, row.id);
  }
  assert.equal(findBrowserHistoryGestureRowAtPoint(layout, layout.x + 20, layout.y + 108), null);
  assert.equal(findBrowserHistoryGestureRowAtPoint(layout, layout.x + layout.width, layout.y + 71), null);
  assert.equal(BROWSER_HISTORY_GESTURE_GEOMETRY.rowHeight, 72);
  assert.equal(BROWSER_HISTORY_GESTURE_GEOMETRY.rowGap, 3);
});

test('popup height is derived from the same row geometry, including empty state', () => {
  assert.equal(getBrowserHistoryGesturePopupHeight(0), 97);
  assert.equal(getBrowserHistoryGesturePopupHeight(1), 115);
  assert.equal(getBrowserHistoryGesturePopupHeight(3), 265);
});
