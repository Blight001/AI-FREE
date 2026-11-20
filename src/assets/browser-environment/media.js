// Bundled inside the environment template; config is supplied by its lexical scope.
(() => {
function defineMediaMethod(target, name, method) {
  try { Object.defineProperty(target, name, { configurable: true, value: method }); } catch (_) {}
}

function installAudioNoise(seed) {
  const analyser = globalThis.AnalyserNode && globalThis.AnalyserNode.prototype;
  if (analyser) patchAnalyser(analyser, seed);
  const offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (offline && offline.prototype) patchOfflineAudio(offline.prototype, seed);
}

function patchAnalyser(prototype, seed) {
  const methods = [
    'getFloatFrequencyData', 'getFloatTimeDomainData', 'getByteFrequencyData', 'getByteTimeDomainData',
  ];
  for (const name of methods) {
    const original = prototype[name];
    if (typeof original !== 'function') continue;
    defineMediaMethod(prototype, name, function (data) {
      const result = original.apply(this, arguments);
      addAudioNoise(data, `${seed}:${name}`);
      return result;
    });
  }
}

function patchOfflineAudio(prototype, seed) {
  const original = prototype.startRendering;
  if (typeof original !== 'function') return;
  const processed = new WeakSet();
  defineMediaMethod(prototype, 'startRendering', function (...args) {
    const rendering = original.apply(this, args);
    if (!rendering || typeof rendering.then !== 'function') return rendering;
    return rendering.then((buffer) => {
      if (buffer && !processed.has(buffer)) {
        processed.add(buffer);
        addOfflineAudioNoise(buffer, seed);
      }
      return buffer;
    });
  });
}

function addOfflineAudioNoise(buffer, seed) {
  const getChannelData = buffer.getChannelData;
  if (typeof getChannelData !== 'function') return;
  const channels = Math.max(0, Number(buffer.numberOfChannels) || 0);
  for (let channel = 0; channel < channels; channel += 1) {
    addAudioNoise(getChannelData.call(buffer, channel), `${seed}:${channel}`);
  }
}

function addAudioNoise(data, seed) {
  if (!ArrayBuffer.isView(data)) return;
  const values = /** @type {ArrayLike<number> & Record<number, number>} */ (/** @type {unknown} */ (data));
  if (!values.length) return;
  const hash = mediaSeedHash(`${seed}:${values.length}`);
  const index = hash % values.length;
  if (data instanceof Float32Array || data instanceof Float64Array) {
    const delta = (hash & 1) ? 0.000001 : -0.000001;
    values[index] = Math.max(-1, Math.min(1, values[index] + delta));
    return;
  }
  values[index] = Math.max(0, Math.min(255, values[index] + ((hash & 1) ? 1 : -1)));
}

function installClientRectsNoise(seed) {
  const targets = [
    [globalThis.Element && globalThis.Element.prototype, 'element'],
    [globalThis.Range && globalThis.Range.prototype, 'range'],
  ];
  for (const [prototype, kind] of targets) {
    if (!prototype) continue;
    patchRectMethod(prototype, 'getBoundingClientRect', kind, seed);
    patchRectMethod(prototype, 'getClientRects', kind, seed);
  }
}

function patchRectMethod(prototype, name, kind, seed) {
  const original = prototype[name];
  if (typeof original !== 'function') return;
  defineMediaMethod(prototype, name, function (...args) {
    const result = original.apply(this, args);
    return name === 'getBoundingClientRect'
      ? addRectNoise(result, this, kind, seed)
      : addRectListNoise(result, this, kind, seed);
  });
}

function addRectListNoise(list, target, kind, seed) {
  if (!list || typeof list.length !== 'number') return list;
  return new Proxy(list, {
    get(source, key) {
      if (key === 'item') return (index) => addRectNoise(source.item(index), target, kind, seed);
      if (key === Symbol.iterator) {
        return function* iterator() {
          for (let index = 0; index < source.length; index += 1) {
            yield addRectNoise(source[index], target, kind, seed);
          }
        };
      }
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
        return addRectNoise(source[Number(key)], target, kind, seed);
      }
      const value = Reflect.get(source, key, source);
      return typeof value === 'function' ? value.bind(source) : value;
    },
  });
}

function addRectNoise(rect, target, kind, seed) {
  if (!rect) return rect;
  const identity = rectIdentity(target, kind, rect);
  const hash = mediaSeedHash(`${seed}:${identity}`);
  const left = Number(rect.left ?? rect.x) + ((hash & 1) ? 0.01 : -0.01);
  const top = Number(rect.top ?? rect.y) + ((hash & 2) ? 0.01 : -0.01);
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  if (typeof globalThis.DOMRect === 'function') return new globalThis.DOMRect(left, top, width, height);
  return {
    x: left, y: top, left, top, width, height,
    right: left + width, bottom: top + height,
    toJSON() { return { x: left, y: top, width, height, top, right: left + width, bottom: top + height, left }; },
  };
}

function rectIdentity(target, kind, rect) {
  const element = kind === 'range' ? target.commonAncestorContainer || target.startContainer : target;
  const className = typeof element?.className === 'string' ? element.className : '';
  return [element?.tagName || element?.nodeName || '', element?.id || '', className, rect.width, rect.height].join(':');
}

function installSpeechVoiceNoise(seed) {
  const prototype = globalThis.SpeechSynthesis && globalThis.SpeechSynthesis.prototype;
  if (!prototype || typeof prototype.getVoices !== 'function') return;
  const original = prototype.getVoices;
  defineMediaMethod(prototype, 'getVoices', function (...args) {
    return Array.from(original.apply(this, args)).sort((left, right) => {
      return mediaSeedHash(`${seed}:${voiceIdentity(left)}`) - mediaSeedHash(`${seed}:${voiceIdentity(right)}`);
    });
  });
}

function voiceIdentity(voice) {
  return `${voice.voiceURI || ''}:${voice.name || ''}:${voice.lang || ''}`;
}

function mediaSeedHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function installBrowserMediaEnvironment(config) {
  if (config.audioContextMode === 'noise') installAudioNoise(config.mediaSeed);
  if (config.clientRectsMode === 'noise') installClientRectsNoise(config.mediaSeed);
  if (config.speechVoicesMode === 'noise') installSpeechVoiceNoise(config.mediaSeed);
}

installBrowserMediaEnvironment(config);
})();
