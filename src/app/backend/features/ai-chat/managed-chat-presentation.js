'use strict';

const { sanitizeMessage, sanitizeToolEvent } = require('../../lib/ai-chat-history');

const MAX_TEXT = 131072;
const MAX_EVENTS = 256;
const MAX_TOOL_TEXT = 8192;

function presentationTool(tool) {
  const snapshot = sanitizeToolEvent(tool);
  snapshot.arguments = snapshot.arguments.slice(0, MAX_TOOL_TEXT);
  snapshot.result = snapshot.result.slice(0, MAX_TOOL_TEXT);
  return snapshot;
}

function presentationEvent({ type, round, delta, content, tool, artifacts }) {
  switch (type) {
    case 'round_start':
      return { type, round };
    case 'content_delta':
    case 'reasoning_delta':
      return { type, round, delta: String(delta || '').slice(0, MAX_TEXT) };
    case 'content_replace':
      return { type, round, content: String(content || '').slice(0, MAX_TEXT) };
    case 'tool_start':
    case 'tool_result':
      return { type, round, tool: presentationTool(tool) };
    case 'tool_progress':
      return { type, round, tool: { id: tool?.id, progress: tool?.progress } };
    case 'artifacts':
      return { type, artifacts: sanitizeMessage({ role: 'assistant', artifacts }).artifacts || [] };
    default:
      return null;
  }
}

function recordPresentationEvent(control, rawEvent) {
  const event = presentationEvent(rawEvent);
  if (!event) return false;
  if (event.type === 'content_delta') control.draft = (control.draft + event.delta).slice(0, MAX_TEXT);
  if (event.type === 'content_replace') control.draft = event.content;
  const last = control.events.at(-1);
  if (event.delta !== undefined && last?.type === event.type && last.round === event.round) {
    last.delta = (last.delta + event.delta).slice(0, MAX_TEXT);
  } else {
    control.events.push({ ...event, seq: ++control.sequence });
    if (control.events.length > MAX_EVENTS) control.events.shift();
  }
  return true;
}

function presentationTrace(previous, next) {
  const trace = [...(previous.trace_events || []), ...(next.trace_events || [])].slice(-MAX_EVENTS);
  return trace.map((event) => event.type === 'tool'
    ? { ...event, tool: presentationTool(event.tool) }
    : { ...event, content: String(event.content || '').slice(0, MAX_TEXT) });
}

function completedPresentation(record, message = {}, duration) {
  const previous = record.presentation || {};
  const trace = presentationTrace(previous, message);
  const summary = sanitizeMessage({
    role: 'assistant', content: '',
    reasoning: trace.length ? '' : String(message.reasoning || previous.reasoning || '').slice(0, MAX_TEXT),
    trace_events: trace,
    tool_events: trace.length ? [] : (message.tool_events || []).slice(-MAX_EVENTS).map(presentationTool),
    artifacts: [...(previous.artifacts || []), ...(message.artifacts || [])].slice(-16),
    turn_duration_ms: (previous.turn_duration_ms || 0) + duration,
  });
  return { ...summary, revision: (previous.revision || 0) + 1 };
}

module.exports = { completedPresentation, recordPresentationEvent };
