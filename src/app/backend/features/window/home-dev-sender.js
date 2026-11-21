'use strict';

function isHomeSender(event, contents, homeUrl = null) {
  if (!contents || contents.isDestroyed() || event.sender !== contents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== contents.mainFrame) return false;
  const url = URL.parse(frame.url);
  if (url?.protocol !== 'file:') return false;
  if (homeUrl) return url.host === homeUrl.host && url.pathname === homeUrl.pathname;
  return url.pathname.endsWith('/frontend/views/app-shell.html');
}

module.exports = { isHomeSender };
