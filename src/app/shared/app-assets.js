(function initAppAssets(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AiFreeAppAssets = api;
})(globalThis, function createAppAssets() {
  'use strict';

  // Anchor to the application tree, never to the hosting page's nesting depth.
  // Keep pathname encoded: decoding it would turn #, % and ? into URL syntax.
  function resolveLogoUrl(moduleUrl) {
    const url = new URL(moduleUrl);
    if (url.protocol !== 'file:') throw new Error('App assets require a local file URL');
    const sourceIndex = url.pathname.lastIndexOf('/src/app/');
    if (sourceIndex < 0) throw new Error('App asset URL is outside the application tree');
    const appRoot = url.pathname.slice(0, sourceIndex + 1);
    const resourcesRoot = appRoot.replace(/app\.asar(?:\.unpacked)?\/$/i, '');
    url.pathname = resourcesRoot !== appRoot
      ? `${resourcesRoot}resource/logo.ico`
      : `${appRoot}src/assets/logo.ico`;
    url.search = '';
    url.hash = '';
    return url.href;
  }

  return Object.freeze({ resolveLogoUrl });
});
