'use strict';

function installBrowserGraphicsEnvironment(config) {
  installScreen(config.screen);
  installWebGl(config);
  installCanvasNoise(config.canvasMode, config.canvasSeed);
}

function installScreen(screen) {
  if (!screen) return;
  const target = globalThis.screen;
  if (!target) return;
  for (const key of ['width', 'height', 'availWidth', 'availHeight', 'availLeft', 'availTop', 'colorDepth', 'pixelDepth']) {
    defineValue(target, key, screen[key]);
  }
}

function defineValue(target, key, value) {
  if (target == null || value == null) return;
  try { Object.defineProperty(target, key, { configurable: true, get: () => value }); } catch (_) {}
}

function installWebGl(config) {
  const contexts = [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext];
  for (const Context of contexts) {
    const prototype = Context && Context.prototype;
    if (!prototype) continue;
    if (config.webglMode === 'custom') patchWebGlParameters(prototype, config);
    if (config.webglImageMode === 'noise') patchReadPixels(prototype, config.webglImageSeed);
  }
}

function patchWebGlParameters(prototype, config) {
  const original = prototype.getParameter;
  if (typeof original !== 'function') return;
  try {
    Object.defineProperty(prototype, 'getParameter', {
      configurable: true,
      value: function (parameter) {
        if (parameter === 0x9245 && config.webglVendor) return config.webglVendor;
        if (parameter === 0x9246 && config.webglRenderer) return config.webglRenderer;
        return original.call(this, parameter);
      },
    });
  } catch (_) {}
}

function patchReadPixels(prototype, seed) {
  const original = prototype.readPixels;
  if (typeof original !== 'function') return;
  try {
    Object.defineProperty(prototype, 'readPixels', {
      configurable: true,
      value: function (...args) {
        const result = original.apply(this, args);
        addWebGlNoise(args[6], args[2], args[3], seed);
        return result;
      },
    });
  } catch (_) {}
}

function addWebGlNoise(data, width, height, seed) {
  if (!ArrayBuffer.isView(data)) return;
  const values = /** @type {ArrayLike<number> & Record<number, number>} */ (/** @type {unknown} */ (data));
  if (values.length < 4) return;
  const pixels = Math.max(1, Math.floor(values.length / 4));
  const hash = seedHash(seed + ':' + width + 'x' + height);
  const offset = (hash % pixels) * 4 + ((hash >>> 8) % 3);
  const floatData = data instanceof Float32Array || data instanceof Float64Array;
  const delta = (hash & 1) ? (floatData ? 0.000001 : 1) : (floatData ? -0.000001 : -1);
  const maximum = floatData ? 1 : 255;
  values[offset] = Math.max(0, Math.min(maximum, values[offset] + delta));
}

function installCanvasNoise(mode, seed) {
  if (mode !== 'noise') return;
  const canvases = globalThis.HTMLCanvasElement && globalThis.HTMLCanvasElement.prototype;
  const contexts = [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D];
  const originalGetImageData = new Map();
  for (const Context of contexts) {
    const prototype = Context && Context.prototype;
    if (!prototype || typeof prototype.getImageData !== 'function') continue;
    const original = prototype.getImageData;
    originalGetImageData.set(prototype, original);
    try {
      Object.defineProperty(prototype, 'getImageData', {
        configurable: true,
        value: function (...args) { return addCanvasNoise(original.apply(this, args), seed); },
      });
    } catch (_) {}
  }
  if (canvases) patchCanvasSerialization(canvases, originalGetImageData, seed);
  const offscreen = globalThis.OffscreenCanvas && globalThis.OffscreenCanvas.prototype;
  if (offscreen) patchOffscreenSerialization(offscreen, originalGetImageData, seed);
}

function addCanvasNoise(imageData, seed) {
  if (!imageData || !imageData.data || !imageData.data.length) return imageData;
  const width = Math.max(1, Number(imageData.width) || 1);
  const height = Math.max(1, Number(imageData.height) || 1);
  const hash = seedHash(seed + ':' + width + 'x' + height);
  const pixel = (hash % (width * height)) * 4;
  const channel = (hash >>> 8) % 3;
  const delta = (hash & 1) ? 1 : -1;
  imageData.data[pixel + channel] = Math.max(0, Math.min(255, imageData.data[pixel + channel] + delta));
  return imageData;
}

function seedHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function patchCanvasSerialization(prototype, nativeGetImageData, seed) {
  for (const method of ['toDataURL', 'toBlob']) {
    const original = prototype[method];
    if (typeof original !== 'function') continue;
    try {
      Object.defineProperty(prototype, method, {
        configurable: true,
        value: function (...args) {
          const clone = noisyCanvasCopy(this, nativeGetImageData, seed);
          return original.apply(clone || this, args);
        },
      });
    } catch (_) {}
  }
}

function patchOffscreenSerialization(prototype, nativeGetImageData, seed) {
  const original = prototype.convertToBlob;
  if (typeof original !== 'function') return;
  try {
    Object.defineProperty(prototype, 'convertToBlob', {
      configurable: true,
      value: function (...args) {
        const clone = noisyCanvasCopy(this, nativeGetImageData, seed);
        return original.apply(clone || this, args);
      },
    });
  } catch (_) {}
}

function noisyCanvasCopy(source, nativeGetImageData, seed) {
  const width = Number(source.width) || 0;
  const height = Number(source.height) || 0;
  if (!width || !height) return null;
  try {
    const clone = typeof globalThis.OffscreenCanvas === 'function'
      && source instanceof globalThis.OffscreenCanvas
      ? new globalThis.OffscreenCanvas(width, height)
      : globalThis.document.createElement('canvas');
    clone.width = width;
    clone.height = height;
    const context = clone.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0);
    const getImageData = nativeGetImageData.get(Object.getPrototypeOf(context));
    if (!getImageData) return null;
    const plan = noisePlan(width, height, seed);
    const pixel = getImageData.call(context, plan.x, plan.y, 1, 1);
    addCanvasNoise(pixel, seed + ':' + width + 'x' + height);
    context.putImageData(pixel, plan.x, plan.y);
    return clone;
  } catch (_) {
    return null;
  }
}

function noisePlan(width, height, seed) {
  const hash = seedHash(seed + ':' + width + 'x' + height);
  return { x: hash % width, y: (hash >>> 8) % height };
}

function buildBrowserGraphicsEnvironmentSource() {
  const dependencies = [
    installBrowserGraphicsEnvironment, installScreen, defineValue, installWebGl, patchWebGlParameters,
    patchReadPixels, addWebGlNoise, installCanvasNoise, addCanvasNoise, seedHash,
    patchCanvasSerialization, patchOffscreenSerialization, noisyCanvasCopy, noisePlan,
  ];
  const declarations = dependencies.map((fn) => `const ${fn.name} = ${fn.toString()};`).join('\n');
  return `(() => { ${declarations}\ninstallBrowserGraphicsEnvironment(config); })();`;
}

module.exports = { buildBrowserGraphicsEnvironmentSource };
