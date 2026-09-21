(function initLogoAssets() {
  'use strict';

  const moduleUrl = document.currentScript.src;

  function resolveLogoUrl(url = moduleUrl) {
    return globalThis.AiFreeAppAssets.resolveLogoUrl(url);
  }

  function applyLogoSources(root = document) {
    const logoUrl = resolveLogoUrl();
    root.querySelectorAll?.('img[data-app-logo]').forEach((image) => {
      if (image.getAttribute('src') !== logoUrl) image.setAttribute('src', logoUrl);
    });
    return logoUrl;
  }

  window.aiFreeLogoAssets = Object.freeze({
    apply: applyLogoSources,
    resolve: resolveLogoUrl,
    url: resolveLogoUrl(),
  });

  applyLogoSources();
})();
