'use strict';

function text(value) { return String(value == null ? '' : value).trim(); }

function nonNegativePoint(x, y) {
  const point = { x: Number(x), y: Number(y) };
  if (!Object.values(point).every(Number.isFinite)) return null;
  return Math.min(point.x, point.y) >= 0 ? point : null;
}

function firstText(values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return '';
}

function fileUploadMetadata(source, tag, inputType) {
  if (source.requiresFileUpload === true) return true;
  return tag === 'input' && inputType === 'file';
}

function observedCenter(item) {
  const source = item || {};
  const explicit = nonNegativePoint(source.clickX, source.clickY);
  if (explicit) return explicit;
  const [x, y, width, height] = [source.x, source.y, source.width, source.height].map(Number);
  if (![x, y, width, height].every(Number.isFinite) || Math.min(width, height) <= 0) return null;
  return nonNegativePoint(x + (width / 2), y + (height / 2));
}

function observedMetadata(item, context = {}) {
  const source = item || {};
  const tag = text(source.tag).toLowerCase();
  const inputType = text(source.inputType).toLowerCase();
  const requiresFileUpload = fileUploadMetadata(source, tag, inputType);
  const metadata = {
    stableRef: text(source.stableRef),
    observedRole: text(source.role).toLowerCase(),
    observedLabel: firstText([source.label, source.ariaLabel, source.placeholder, source.text]),
    observedUrl: text(context.url),
    selectorUnique: source.selectorUnique === true,
    selectorStability: text(source.selectorStability).toLowerCase(),
  };
  if (tag) metadata.observedTag = tag;
  if (inputType) metadata.observedInputType = inputType;
  if (requiresFileUpload) metadata.requiresFileUpload = true;
  return metadata;
}

function observedTarget(item, observationId, context = {}) {
  const id = text(item?.id);
  if (!id) return null;
  const selector = text(item?.selector);
  const point = observedCenter(item);
  if (!selector && !point) return null;
  return [id, {
    ...(selector ? { selector } : {}), ...(point || {}), observationId,
    ...observedMetadata(item, context),
  }];
}

function expiredObservedRefResult(input) {
  if (input.observedRefExpired !== true) return null;
  return {
    success: false,
    action: text(input.action).toLowerCase(),
    errorCode: 'OBSERVED_REF_EXPIRED',
    error: input.observedRefRecoveryError
      || '该元素 ref 不属于最近一次 browser_observe 结果。请重新观察并立即使用最新 ref，或改用稳定 selector。',
    ref: text(input.ref),
    retryable: true,
    ...(input.observedRefRecoveryReason ? { reason: input.observedRefRecoveryReason } : {}),
    suggestedTool: 'browser_observe',
  };
}

function mismatchedObservationResult(input) {
  if (input.observationMismatch !== true) return null;
  return {
    success: false,
    action: text(input.action).toLowerCase(),
    errorCode: 'OBSERVATION_MISMATCH',
    error: 'observation_id 与最近一次 browser_observe 快照不一致。请重新观察后使用新返回的 observationId 和 ref。',
    ref: text(input.ref),
    observationId: text(input.observation_id),
    suggestedTool: 'browser_observe',
  };
}

function observeDiagnostics(result, input, observationId) {
  const requested = Number(input.text_limit ?? input.textLimit);
  const requestedTextLimit = Number.isFinite(requested) ? requested : 120;
  const appliedTextLimit = Number(result?.textLimit) || Math.max(20, Math.min(500, requestedTextLimit));
  const items = Array.isArray(result?.items) ? result.items : [];
  const capReason = requestedTextLimit !== appliedTextLimit ? 'runtime maximum' : null;
  return {
    ...result, observationId, requestedTextLimit, appliedTextLimit,
    limitCapped: requestedTextLimit !== appliedTextLimit,
    capReason,
    itemsTruncated: result?.truncated === true,
    returnedCount: items.length,
    totalMatched: Number(result?.totalMatched) || items.length,
    items: items.map((item) => ({ ...item, observationId })),
  };
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function itemBounds(item) {
  return {
    left: number(item.x), top: number(item.y),
    width: Math.max(0, number(item.width)), height: Math.max(0, number(item.height)),
    get right() { return this.left + this.width; },
    get bottom() { return this.top + this.height; },
  };
}

function hashRef(value, prefix) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function fallbackRole(item, tag, inputType) {
  const current = text(item.role).toLowerCase();
  if (current) return current;
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') return inputType === 'search' ? 'searchbox' : 'textbox';
  return item.interactive === true || item.kind === 'interactive' ? 'button' : '';
}

function fallbackControlType(item, tag, inputType, role) {
  const current = text(item.controlType).toLowerCase();
  if (current) return current;
  if (tag === 'input') return inputType === 'search' ? 'text-input' : `${inputType || 'text'}-input`;
  return role;
}

function fallbackSemantics(item) {
  const tag = text(item.tag).toLowerCase();
  const inputType = text(item.inputType).toLowerCase();
  const role = fallbackRole(item, tag, inputType);
  const controlType = fallbackControlType(item, tag, inputType, role);
  const label = text(item.label || item.ariaLabel || item.placeholder || item.text);
  const bounds = itemBounds(item);
  const selector = text(item.selector);
  return {
    ...item, role, controlType, label,
    editable: item.editable === true || ['textbox', 'searchbox'].includes(role),
    stableRef: text(item.stableRef) || hashRef(`${selector}|${label}|${bounds.left}|${bounds.top}`, 'node'),
    selectorUnique: typeof item.selectorUnique === 'boolean' ? item.selectorUnique : null,
    selectorMatchCount: Number.isFinite(Number(item.selectorMatchCount)) ? Number(item.selectorMatchCount) : null,
    locator: item.locator || { strategy: role && label ? 'role-and-name' : 'css', role, name: label, cssPath: selector, unique: null },
  };
}

function processInput(source = {}) {
  return {
    ...source,
    mode: text(source.mode || 'elements').toLowerCase(),
    region: source.region || {},
    regionRef: text(source.regionRef ?? source.region_ref),
    regionMode: text(source.regionMode ?? source.region_mode ?? 'centerInside'),
    regionPadding: Math.max(0, number(source.regionPadding ?? source.padding, 10)),
    expectedRegionLayoutHash: text(
      source.expectedRegionLayoutHash ?? source.regionLayoutHash ?? source.region_layout_hash,
    ),
    kinds: source.kinds || [], tags: source.tags || [], roles: source.roles || [],
    controlTypes: source.controlTypes || source.control_types || [],
  };
}

function regionDescriptor(role, label, bounds, source) {
  const key = `${role}|${Math.round(bounds.left)}|${Math.round(bounds.top)}|${Math.round(bounds.width)}|${Math.round(bounds.height)}`;
  return {
    ref: hashRef(key, `region-${role}`), role, label, source,
    bounds: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
    coordinateSystem: 'viewport-css-px',
    layoutHash: hashRef(key, 'layout'),
  };
}

function inferRegions(items, viewport) {
  const width = Math.max(1, number(viewport.width));
  const height = Math.max(1, number(viewport.height));
  const candidates = items.map((item) => ({ item, bounds: itemBounds(item) }));
  const sidebar = candidates.filter(({ bounds }) => (
    bounds.left <= width * 0.12 && bounds.width <= width * 0.45 && bounds.height >= height * 0.35
  )).sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height))[0];
  const regions = [];
  if (sidebar) regions.push(regionDescriptor('navigation', '侧边栏', sidebar.bounds, 'item-layout-fallback'));
  const mainLeft = sidebar ? Math.max(0, sidebar.bounds.right) : 0;
  if (width - mainLeft > 40) regions.push(regionDescriptor('main', '主要内容区', {
    left: mainLeft, top: 0, width: width - mainLeft, height,
  }, 'viewport-layout-fallback'));
  regions.push(regionDescriptor('document', '当前页面', { left: 0, top: 0, width, height }, 'viewport-layout-fallback'));
  return regions;
}

function rectangleFromInput(region) {
  if (!region || !Number.isFinite(Number(region.x))) return null;
  return {
    left: number(region.x), top: number(region.y),
    width: number(region.width), height: number(region.height),
    get right() { return this.left + this.width; },
    get bottom() { return this.top + this.height; },
  };
}

function regionBounds(region) {
  return rectangleFromInput(region?.bounds) || rectangleFromInput(region);
}

function intersection(item, region, padding) {
  const bounds = itemBounds(item);
  const left = Math.max(bounds.left, region.left - padding);
  const top = Math.max(bounds.top, region.top - padding);
  const right = Math.min(bounds.right, region.right + padding);
  const bottom = Math.min(bounds.bottom, region.bottom + padding);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  return {
    ratio: Math.round((overlap / Math.max(1, bounds.width * bounds.height)) * 1000) / 1000,
    centerInside: bounds.left + bounds.width / 2 >= region.left - padding
      && bounds.left + bounds.width / 2 <= region.right + padding
      && bounds.top + bounds.height / 2 >= region.top - padding
      && bounds.top + bounds.height / 2 <= region.bottom + padding,
    fullyInside: bounds.left >= region.left - padding && bounds.right <= region.right + padding
      && bounds.top >= region.top - padding && bounds.bottom <= region.bottom + padding,
  };
}

function matchesRegion(item, region, mode, padding) {
  const hit = intersection(item, region, padding);
  const included = mode === 'fullyInside' ? hit.fullyInside
    : (mode === 'intersecting' ? hit.ratio > 0 : hit.centerInside);
  return { included, ratio: hit.ratio };
}

function regionItem(item, hit, descriptor, input) {
  const bounds = itemBounds(item);
  const area = regionBounds(descriptor);
  const sameContainer = Math.abs(bounds.left - area.left) < 2 && Math.abs(bounds.top - area.top) < 2
    && Math.abs(bounds.width - area.width) < 2 && Math.abs(bounds.height - area.height) < 2;
  const navigationChild = descriptor.role === 'navigation' && item.kind === 'interactive' && !sameContainer;
  return {
    ...item,
    ...(sameContainer ? { role: descriptor.role, controlType: descriptor.role, label: descriptor.label } : {}),
    ...(navigationChild ? { role: 'menuitem', controlType: 'menu-item' } : {}),
    insideRegion: true,
    intersection: { mode: input.regionMode, ratio: hit.ratio },
    regionRef: descriptor.ref,
    containerRef: descriptor.ref,
    ancestorContext: [{ role: descriptor.role, label: descriptor.label }],
  };
}

function findRequestedRegion(input, regions) {
  if (text(input.regionRef)) return regions.find((region) => region.ref === text(input.regionRef)) || null;
  const requested = input.region || {};
  if (!requested.role && !requested.label) return null;
  const role = text(requested.role).toLowerCase();
  const label = text(requested.label).toLowerCase();
  return regions.find((region) => (!role || region.role === role)
    && (!label || text(region.label).toLowerCase().includes(label))) || null;
}

function matchesStructuredFilters(item, input) {
  if (input.kinds.length && !input.kinds.includes(text(item.kind).toLowerCase())) return false;
  if (input.tags.length && !input.tags.includes(text(item.tag).toLowerCase())) return false;
  if (input.roles.length && !input.roles.includes(text(item.role).toLowerCase())) return false;
  return !input.controlTypes.length || input.controlTypes.includes(text(item.controlType).toLowerCase());
}

function applyStructuredFilters(result, input) {
  const requested = input.kinds.length || input.tags.length || input.roles.length || input.controlTypes.length;
  if (!requested) return false;
  result.items = result.items.filter((item) => matchesStructuredFilters(item, input));
  result.count = result.items.length;
  result.returnedCount = result.items.length;
  return true;
}

function queryDiagnostics(input, regionApplied, layer, returnedCount) {
  const requested = [];
  if (input.kinds?.length) requested.push('kinds');
  if (input.tags?.length) requested.push('tags');
  if (input.roles?.length) requested.push('roles');
  if (input.controlTypes?.length) requested.push('control_types');
  if (input.regionRef || Object.keys(input.region || {}).length) requested.push('region');
  const appliedFilters = requested.filter((name) => name !== 'region' || regionApplied);
  const ignoredFilters = requested.includes('region') && !regionApplied
    ? [{ name: 'region', reason: 'region was not resolved or applied' }] : [];
  return {
    mode: input.mode, requestedFilters: requested,
    regionProvided: requested.includes('region'), regionApplied,
    appliedFilters, ignoredFilters, appliedLayer: layer, returnedCount,
  };
}

function regionError(input, regions, code, message) {
  return {
    success: false, errorCode: code, error: message,
    regionRef: text(input.regionRef), regions, items: [], count: 0, returnedCount: 0,
    query: queryDiagnostics(input, false, 'application-fallback', 0),
  };
}

function fallbackOverview(result, input, regions) {
  return {
    ...result, mode: 'overview', items: [], count: 0, returnedCount: 0,
    regions, regionCount: regions.length,
    regionDetection: {
      success: regions.length > 0, source: 'application-item-layout-fallback',
      reason: regions.length ? null : 'no region candidates detected',
    },
    query: queryDiagnostics(input, false, 'application-fallback', 0),
  };
}

function fallbackRegionElements(result, input, regions) {
  const explicitRectangle = rectangleFromInput(input.region);
  const descriptor = explicitRectangle ? regionDescriptor('region', '自定义区域', explicitRectangle, 'request-rectangle')
    : findRequestedRegion(input, regions);
  if (!descriptor && input.regionRef) return regionError(input, regions, 'REGION_STALE', '区域引用已失效，请重新执行 mode=overview');
  if (!descriptor && (input.region?.role || input.region?.label)) {
    return regionError(input, regions, 'REGION_NOT_FOUND', '没有找到匹配的语义区域，不会回退为全页观察');
  }
  if (!descriptor) return { ...result, query: queryDiagnostics(input, false, 'chromium-legacy', result.items.length) };
  if (input.expectedRegionLayoutHash && input.expectedRegionLayoutHash !== descriptor.layoutHash) {
    return regionError(input, regions, 'REGION_STALE', '区域布局已变化，请重新执行 mode=overview');
  }
  const bounds = regionBounds(descriptor);
  const filtered = result.items.map((item) => ({ item, hit: matchesRegion(
    item, bounds, input.regionMode, input.regionPadding,
  ) })).filter(({ hit }) => hit.included).map(({ item, hit }) => regionItem(item, hit, descriptor, input));
  return {
    ...result, items: filtered, count: filtered.length, returnedCount: filtered.length,
    region: { ...descriptor, valid: true }, regionApplied: true,
    regionBounds: descriptor.bounds, regionMode: input.regionMode,
    padding: input.regionPadding, matchedCount: filtered.length,
    query: queryDiagnostics(input, true, 'application-fallback', filtered.length),
  };
}

function normalizeMediaCollections(result) {
  const media = result.items.filter((item) => item.kind === 'media' && (item.mediaUrl || item.downloadUrl));
  const mediaRefs = new Set(media.map((item) => text(item.id)));
  const links = (Array.isArray(result.downloadLinks) ? result.downloadLinks : [])
    .filter((link) => !mediaRefs.has(text(link.ref)) && text(link.kind) !== 'media');
  result.downloadLinks = links;
  result.downloadLinkCount = links.length;
  if (!Array.isArray(result.mediaResources)) result.mediaResources = media.map((item) => ({
    ref: item.id, type: item.mediaType || item.tag, src: item.mediaUrl || item.downloadUrl,
    srcset: item.mediaUrls || [], navigationHref: item.linkedUrl || null, downloadable: false,
  }));
  result.mediaResourceCount = result.mediaResources.length;
}

function processObservationResult(result, input, observationId) {
  const options = processInput(input);
  const diagnosed = observeDiagnostics(result, options, observationId);
  diagnosed.items = diagnosed.items.map(fallbackSemantics);
  normalizeMediaCollections(diagnosed);
  const structuredFallback = applyStructuredFilters(diagnosed, options);
  const nativeRegionResult = options.mode === 'overview'
    ? Array.isArray(result.regions) : (!options.regionRef && !Object.keys(options.region || {}).length) || result.regionApplied === true || !!result.region;
  if (nativeRegionResult) {
    const layer = structuredFallback ? 'chromium-native+application-filters' : 'chromium-native';
    diagnosed.query = queryDiagnostics(options, !!result.region, layer, diagnosed.items.length);
    return diagnosed;
  }
  const regions = inferRegions(diagnosed.items, diagnosed.viewport || {});
  if (options.mode === 'overview') return fallbackOverview(diagnosed, options, regions);
  return fallbackRegionElements(diagnosed, options, regions);
}

module.exports = {
  expiredObservedRefResult, mismatchedObservationResult, observedTarget, processObservationResult,
};
