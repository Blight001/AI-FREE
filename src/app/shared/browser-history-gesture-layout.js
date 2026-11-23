(function initBrowserHistoryGestureLayout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BrowserHistoryGestureLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBrowserHistoryGestureLayout() {
  const BROWSER_HISTORY_GESTURE_GEOMETRY = Object.freeze({
    panelBorder: 1,
    panelPadding: 7,
    titleHeight: 27,
    rowHeight: 72,
    rowGap: 3,
    emptyMessageHeight: 54,
  });

  function getBrowserHistoryGesturePopupHeight(rowCount) {
    const rows = Math.max(0, Number(rowCount) || 0);
    const { panelBorder, panelPadding, titleHeight, rowHeight, rowGap, emptyMessageHeight } = BROWSER_HISTORY_GESTURE_GEOMETRY;
    const frameHeight = 2 * (panelBorder + panelPadding) + titleHeight;
    if (!rows) return frameHeight + emptyMessageHeight;
    return frameHeight + rows * rowHeight + (rows - 1) * rowGap;
  }

  function getBrowserHistoryGestureMaxRows(availableHeight) {
    const { rowHeight, rowGap, panelBorder, panelPadding, titleHeight } = BROWSER_HISTORY_GESTURE_GEOMETRY;
    const frameHeight = 2 * (panelBorder + panelPadding) + titleHeight;
    return Math.max(1, Math.floor((availableHeight - frameHeight + rowGap) / (rowHeight + rowGap)));
  }

  function createBrowserHistoryGestureRows(history) {
    const { panelBorder, panelPadding, titleHeight, rowHeight, rowGap } = BROWSER_HISTORY_GESTURE_GEOMETRY;
    const firstRowTop = panelBorder + panelPadding + titleHeight;
    const rowStep = rowHeight + rowGap;
    return (Array.isArray(history) ? history : []).map((item, index) => {
      const top = firstRowTop + index * rowStep;
      return { id: String(item?.id || ''), top, bottom: top + rowHeight };
    });
  }

  function findBrowserHistoryGestureRowAtPoint(layout, clientX, clientY) {
    if (!layout || clientX < layout.x || clientX >= layout.x + layout.width
      || clientY < layout.y || clientY >= layout.y + layout.height) return null;
    const relativeY = clientY - layout.y;
    return (Array.isArray(layout.rows) ? layout.rows : []).find((row) => (
      relativeY >= row.top && relativeY < row.bottom
    )) || null;
  }

  return {
    BROWSER_HISTORY_GESTURE_GEOMETRY,
    createBrowserHistoryGestureRows,
    findBrowserHistoryGestureRowAtPoint,
    getBrowserHistoryGestureMaxRows,
    getBrowserHistoryGesturePopupHeight,
  };
});
