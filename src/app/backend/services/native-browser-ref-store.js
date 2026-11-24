'use strict';

const { observedRef } = require('./native-browser-file');
const { AX_COORDINATE_REF, observedTarget } = require('./native-browser-observation');
const { PAGE_TOKEN, expectedPageToken } = require('./native-browser-page-binding');

const EXTERNAL_OBSERVATIONS = Symbol('external-mcp-observations');
const CLICK_ACTIONS = /^(click|double_click|right_click)$/;
const OBSERVATION_HISTORY_LIMIT = 3;
const OBSERVATION_HISTORY_TTL_MS = 30000;

function text(value) { return String(value ?? '').trim(); }

function nonNegativePoint(x, y) {
  const point = { x: Number(x), y: Number(y) };
  if (!Object.values(point).every(Number.isFinite)) return null;
  return Math.min(point.x, point.y) >= 0 ? point : null;
}

function normalizedComparable(value) {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

function recoveryMatches(previous, item) {
  const selectorMatches = text(previous.selector) && text(previous.selector) === text(item.selector);
  const stableRefMatches = text(previous.stableRef) && text(previous.stableRef) === text(item.stableRef);
  if (!selectorMatches && !stableRefMatches) return false;
  if (previous.observedTag && previous.observedTag !== normalizedComparable(item.tag)) return false;
  if (previous.observedRole && previous.observedRole !== normalizedComparable(item.role)) return false;
  const nextLabel = normalizedComparable(item.label || item.ariaLabel || item.placeholder || item.text);
  return !previous.observedLabel || normalizedComparable(previous.observedLabel) === nextLabel;
}

function recoverableLocator(target) {
  return target?.selectorUnique === true
    && ['high', 'medium'].includes(text(target.selectorStability).toLowerCase())
    && !!text(target.selector);
}

function matchesPage(target, token) {
  return target && (token === undefined || target[PAGE_TOKEN] === token);
}

function observationStore(owner, connection) {
  return connection[EXTERNAL_OBSERVATIONS] === true ? owner.externalObservations : owner;
}

function clearObservations(owner, connectionId) {
  for (const store of [owner, owner.externalObservations]) {
    store.observeTargets.delete(connectionId);
    store.observationHistory.delete(connectionId);
  }
}

function resolveCoordinateObservation(owner, connection, args) {
  const observationId = text(args.observation_id ?? args.observationId);
  if (!observationId || text(args.selector) || !nonNegativePoint(args.x, args.y)) return args;
  if (!CLICK_ACTIONS.test(text(args.action))) return args;
  const token = expectedPageToken(connection);
  const snapshot = observationStore(owner, connection).observationHistory.get(connection.id)?.at(-1);
  if (token && snapshot?.observationId === observationId && matchesPage(snapshot, token)
    && Date.now() - snapshot.createdAt <= OBSERVATION_HISTORY_TTL_MS) return args;
  return { ...args, observation_id: observationId, observationMismatch: true };
}

function resolveDragEndpoint(owner, connection, args) {
  if (text(args.action) !== 'drag' || Number.isFinite(Number(args.to_x)) && Number.isFinite(Number(args.to_y))) return { input: args };
  const observationId = text(args.observation_id ?? args.observationId);
  const ref = text(args.to_ref);
  const target = observationStore(owner, connection).observeTargets.get(connection.id)?.get(ref);
  const token = expectedPageToken(connection);
  if (!observationId || !ref || !matchesPage(target, token) || target.observationId !== observationId
    || !Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))
    || Number(target.x) < 0 || Number(target.y) < 0) {
    return { failure: { success: false, errorCode: 'DRAG_TARGET_INVALID',
      error: '拖拽终点必须是同一次最新观察中的有效 to_ref，或提供 to_x/to_y 坐标。', actionExecuted: false } };
  }
  return { input: { ...args, to_x: target.x, to_y: target.y } };
}

function resolveObservedTarget(owner, connection, args) {
  const ref = observedRef(args);
  if (!ref) return resolveCoordinateObservation(owner, connection, args);
  const input = text(args.ref) ? args : { ...args, ref };
  const token = expectedPageToken(connection);
  if (token === undefined && text(input.selector)) return input;
  const observation = text(input.observation_id ?? input.observationId);
  const store = observationStore(owner, connection);
  const target = store.observeTargets.get(connection.id)?.get(ref);
  if (matchesPage(target, token) && (!observation || observation === target.observationId)) {
    return mergeObservedTarget(target, input);
  }
  if (!observation) return { ...input, observedRefExpired: true };
  const historical = findHistoricTarget(store, connection.id, observation, ref);
  if (!matchesPage(historical, token)) return { ...input, observationMismatch: true };
  if (historical[AX_COORDINATE_REF]) return unstableRef(input);
  return { ...input, observedRefRecoveryCandidate: historical };
}

function mergeObservedTarget(target, args) {
  const { [AX_COORDINATE_REF]: axCoordinate, ...metadata } = target;
  const resolved = { ...metadata, ...args };
  if (axCoordinate && CLICK_ACTIONS.test(text(args.action))) {
    // AX-only targets have no DOM locator. Keep the ref's viewport point for the click.
    resolved.observedRole = '';
    resolved.observedLabel = '';
  }
  if (!text(args.selector) && target.selector) resolved.selector = target.selector;
  const explicitPoint = nonNegativePoint(args.x, args.y);
  if (explicitPoint) Object.assign(resolved, explicitPoint);
  else if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
    resolved.x = target.x;
    resolved.y = target.y;
  }
  return resolved;
}

function findHistoricTarget(owner, connectionId, observationId, ref) {
  pruneObservationHistory(owner, connectionId);
  return owner.observationHistory.get(connectionId)?.find((snapshot) => (
    snapshot.observationId === observationId
  ))?.targets.get(ref) || null;
}

function pruneObservationHistory(owner, connectionId) {
  const now = Date.now();
  const history = (owner.observationHistory.get(connectionId) || [])
    .filter((snapshot) => now - snapshot.createdAt <= OBSERVATION_HISTORY_TTL_MS)
    .slice(-OBSERVATION_HISTORY_LIMIT);
  if (history.length) owner.observationHistory.set(connectionId, history);
  else owner.observationHistory.delete(connectionId);
}

function rememberObservation(owner, connection, observationId, observation) {
  const token = expectedPageToken(connection);
  const targets = new Map(observation.items
    .map((item) => observedTarget(item, observationId, { url: observation.url })).filter(Boolean));
  for (const target of targets.values()) target[PAGE_TOKEN] = token;
  const store = observationStore(owner, connection);
  store.observeTargets.set(connection.id, targets);
  const history = store.observationHistory.get(connection.id) || [];
  history.push({ observationId, createdAt: Date.now(), targets, [PAGE_TOKEN]: token });
  store.observationHistory.set(connection.id, history.slice(-OBSERVATION_HISTORY_LIMIT));
}

function unstableRef(input) {
  return {
    ...input, observedRefExpired: true, observedRefRecoveryCandidate: null,
    observedRefRecoveryReason: 'LOCATOR_NOT_STABLE',
    observedRefRecoveryError: '旧 ref 没有唯一且稳定的 selector，无法安全恢复；请重新执行 browser_observe。',
  };
}

async function recoverObservedTarget(owner, connection, input) {
  const previous = input.observedRefRecoveryCandidate;
  if (!recoverableLocator(previous)) return unstableRef(input);
  const current = await owner.runtimeCommand(connection, 'observe-page', {
    limit: 1000, includeText: true, includeMedia: true, showHighlights: false,
  });
  if (!previous.observedUrl || !text(current?.url) || text(current.url) !== previous.observedUrl) {
    return {
      ...input, observedRefExpired: true, observedRefRecoveryCandidate: null,
      observedRefRecoveryReason: 'DOCUMENT_CHANGED',
      observedRefRecoveryError: '页面身份无法确认或已发生导航，旧 ref 不再可信；请重新执行 browser_observe。',
    };
  }
  const matches = (Array.isArray(current?.items) ? current.items : [])
    .filter((item) => recoveryMatches(previous, item));
  if (matches.length !== 1 || matches[0].selectorUnique !== true) {
    return {
      ...input, observedRefExpired: true, observedRefRecoveryCandidate: null,
      observedRefRecoveryReason: matches.length > 1 ? 'LOCATOR_AMBIGUOUS' : 'TARGET_CHANGED',
      observedRefRecoveryError: matches.length > 1
        ? '旧 ref 在当前页面匹配到多个元素，已拒绝自动操作；请重新执行 browser_observe。'
        : '旧 ref 对应元素已消失或语义发生变化；请重新执行 browser_observe。',
    };
  }
  const recovered = observedTarget(matches[0], previous.observationId, { url: current.url });
  if (!recovered) return { ...input, observedRefExpired: true, observedRefRecoveryCandidate: null };
  return {
    ...mergeObservedTarget(recovered[1], input),
    observedRefRecoveryCandidate: null, observedRefRecovered: true,
  };
}


module.exports = { EXTERNAL_OBSERVATIONS, clearObservations, resolveDragEndpoint, resolveObservedTarget, recoverObservedTarget, rememberObservation };
