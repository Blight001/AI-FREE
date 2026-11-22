'use strict';

const { observedRef } = require('./native-browser-file');
const { observedTarget } = require('./native-browser-observation');
const { PAGE_TOKEN, expectedPageToken } = require('./native-browser-page-binding');

const EXTERNAL_OBSERVATIONS = Symbol('external-mcp-observations');
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

function resolveObservedTarget(owner, connection, args) {
  const ref = observedRef(args);
  if (!ref) return args;
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
  return matchesPage(historical, token)
    ? { ...input, observedRefRecoveryCandidate: historical }
    : { ...input, observationMismatch: true };
}

function mergeObservedTarget(target, args) {
  const resolved = { ...target, ...args };
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

function rememberObservation(owner, connection, observationId, targets) {
  const store = observationStore(owner, connection);
  store.observeTargets.set(connection.id, targets);
  const history = store.observationHistory.get(connection.id) || [];
  history.push({ observationId, createdAt: Date.now(), targets });
  store.observationHistory.set(connection.id, history.slice(-OBSERVATION_HISTORY_LIMIT));
}

async function recoverObservedTarget(owner, connection, input) {
  const previous = input.observedRefRecoveryCandidate;
  if (!recoverableLocator(previous)) {
    return {
      ...input, observedRefExpired: true, observedRefRecoveryCandidate: null,
      observedRefRecoveryReason: 'LOCATOR_NOT_STABLE',
      observedRefRecoveryError: '旧 ref 没有唯一且稳定的 selector，无法安全恢复；请重新执行 browser_observe。',
    };
  }
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


module.exports = { EXTERNAL_OBSERVATIONS, clearObservations, resolveObservedTarget, recoverObservedTarget, rememberObservation };
