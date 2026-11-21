'use strict';

const { ASSETS, FILENAME, assetPath } = require('./pages');

const MODEL_PATH = '/v1/chat/completions';
const MODEL_ID = 'ai-free-fixture';
const API_KEY = 'fixture-local-only';
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const IMAGE_LABEL = '以下图片来自用户附加的 AI-Workspace 文件：';
const ASSET_DATA = Object.fromEntries(Object.entries(ASSETS).map(([color, asset]) => [color, {
  asset, directory: `qa-download-${color}`, dataUrl: `data:image/png;base64,${asset.bytes.toString('base64')}`,
}]));

const observe = (options) => ['browser_observe', { mark: false, ...options }];
const acquire = ['browser_control', { action: 'acquire' }];
const browserFile = (args) => ['browser_file', args];
const answer = (content) => ({ role: 'assistant', content });

function requestError(status, message) {
  return { status, data: { error: { message } } };
}

async function readPayload(request) {
  if (Number(request.headers['content-length']) > MAX_REQUEST_BYTES) return null;
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {}; }
  catch { return {}; }
}

function turnMessages(messages) {
  // The production provider appends attachment context as separate multimodal user messages.
  const index = messages.findLastIndex((item) => item?.role === 'user' && typeof item.content === 'string');
  const command = (messages[index]?.content || '').trim();
  const tail = messages.slice(index + 1).filter((item) => item?.role !== 'system');
  const firstRound = tail.findIndex((item) => item?.role !== 'user' || !Array.isArray(item.content));
  const split = firstRound === -1 ? tail.length : firstRound;
  return { command, attachments: tail.slice(0, split), transcript: tail.slice(split) };
}

function fileAttachment(message) {
  const [label, image] = message.content;
  if (label?.type !== 'text' || image?.type !== 'image_url' || message.content.length !== 2) return null;
  const attachedLabel = typeof label.text === 'string' ? label.text : '';
  if (!attachedLabel.startsWith(IMAGE_LABEL)) return null;
  const relative = attachedLabel.slice(IMAGE_LABEL.length).replaceAll('\\', '/');
  for (const [color, { asset, directory, dataUrl }] of Object.entries(ASSET_DATA)) {
    const downloadPath = new RegExp(`^${directory}/sample(?: \\([1-9][0-9]{0,3}\\))?\\.png$`);
    const validPath = relative === `${asset.id}/${FILENAME}` || downloadPath.test(relative);
    if (validPath && image.image_url?.url === dataUrl) return { color, relative };
  }
  return null;
}

function requireAttachment(attachments) {
  return attachments.length === 1 ? fileAttachment(attachments[0]) : null;
}

function isPage(result, origin, routes) {
  try {
    const url = new URL(result?.url);
    return url.origin === origin && routes.includes(`${url.pathname}${url.search}`);
  } catch { return false; }
}

function fixtureElement(item, id) {
  return item?.elementId === id || item?.selector === `#${id}`;
}

function pageItem(result, id) {
  return Array.isArray(result?.items) ? result.items.find((item) => fixtureElement(item, id)) : null;
}

function downloadPlan(origin, color) {
  const { asset, directory } = ASSET_DATA[color];
  return {
    steps: [observe({ filter: 'media', include_media: true, limit: 20 }), acquire, (results) => {
      const observation = results[0];
      if (!isPage(observation, origin, ['/a'])) return null;
      const image = pageItem(observation, asset.id);
      if (!image?.id || ![image.mediaUrl, image.downloadUrl].includes(origin + assetPath(asset))) return null;
      if (results[1]?.takeoverActive !== true) return null;
      return browserFile({ action: 'download_element', ref: image.id, filename: FILENAME, directory, media_type: 'image' });
    }], tools: ['browser_observe', 'browser_control', 'browser_file'],
    started: (results) => isPage(results[0], origin, ['/a']) && Boolean(pageItem(results[0], asset.id)),
    finish: (result) => result?.success === true
      ? 'The fixture download tool completed. Open the PNG card to verify the image and its source.'
      : 'The fixture download failed. Inspect the tool details before attempting another run.',
  };
}

const B_ROUTES = ['/b', '/b?mode=drop-once'];

function selectionPlan(origin, file) {
  return {
    steps: [observe({ filter: 'file-input', limit: 12 }), acquire, (results) => {
      if (results[1]?.takeoverActive !== true) return null;
      return browserFile({ action: 'upload', path: file.relative, selector: '#fixture-file' });
    }], tools: ['browser_observe', 'browser_control', 'browser_file'],
    started: (results) => isPage(results[0], origin, B_ROUTES) && Boolean(pageItem(results[0], 'fixture-file')),
    finish: (result) => result?.uploadVerification === 'file_selected'
      ? 'The file was handed to the chooser. Check Selection on B. Submit file manually once if this case calls for it.'
      : 'File selection is unverified. Check B and the tool details before taking another action.',
  };
}

function observationStatus(result, id, pattern) {
  const value = pageItem(result, id)?.text;
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function observeBPlan(origin) {
  return {
    steps: [observe({ filter: 'text', tags: ['span', 'dd'], include_text: true, limit: 12 })], tools: ['browser_observe'],
    finish(result) {
      if (!isPage(result, origin, B_ROUTES)) return 'Bind the fixture B page before using QA OBSERVE B.';
      const receipt = observationStatus(result, 'receipt-status', /^(idle|pending|confirmed|unknown)$/);
      const readback = observationStatus(result, 'readback-status', /^(idle|pending|verified|readback-error)$/);
      const count = observationStatus(result, 'received-count', /^\d{1,9}$/);
      if (!receipt || !readback || count === null) return 'Use Read server state or urls.state for the fixture receipt details.';
      return `Observed B. Receipt ${receipt}, readback ${readback}, displayed received count ${count}. Compare the SHA-256 in urls.state.`;
    },
  };
}

function commandPlan(mode) {
  const timeout_ms = mode === 'TIMEOUT' ? 1000 : 15000;
  const output = mode === 'TRUNCATE' ? ' --output-bytes 80000' : '';
  const command = `node delayed-command.js --delay-ms 6000${output}`;
  return {
    steps: [['run_command', { command, directory: 'command', timeout_ms }]], tools: ['run_command'],
    finish: (result) => result?.timed_out
      ? 'The fixture command timed out. Inspect its status and completion marker.'
      : 'Inspect the fixture command card for the exit status and output.',
  };
}

function choosePlan(command, origin, attachments) {
  if (command === 'QA ATTACH' || command === 'QA SELECT B') {
    const file = requireAttachment(attachments);
    if (!file) return 'Attach exactly one fixture PNG using @ or Re-reference, then send the exact QA prompt.';
    if (command === 'QA ATTACH') return `Received ${file.relative} (${ASSET_DATA[file.color].asset.label}).`;
    return selectionPlan(origin, file);
  }
  const download = /^QA DOWNLOAD (RED|BLUE)$/.exec(command);
  if (download) return downloadPlan(origin, download[1].toLowerCase());
  if (command === 'QA OBSERVE B') return observeBPlan(origin);
  const run = /^QA COMMAND(?: (TIMEOUT|TRUNCATE))?$/.exec(command);
  if (run) return commandPlan(run[1]);
  return 'Use an exact QA fixture prompt. No tool ran.';
}

function toolCall(command, index, [name, args]) {
  const id = `call-${command.toLowerCase().replaceAll(' ', '-')}-${index + 1}`;
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function readToolResult([assistant, tool], expected) {
  const call = assistant?.tool_calls?.[0];
  if (assistant?.role !== 'assistant' || assistant.tool_calls?.length !== 1 || call?.id !== expected.id) return null;
  if (call.function?.name !== expected.function.name || call.function?.arguments !== expected.function.arguments) return null;
  if (tool?.role !== 'tool' || tool.tool_call_id !== call.id || tool.name !== call.function.name) return null;
  try { return JSON.parse(tool.content); }
  catch { return null; }
}

function advancePlan(plan, command, transcript) {
  const results = [];
  for (const [index, step] of plan.steps.entries()) {
    if (index === 1 && plan.started && !plan.started(results)) break;
    const spec = typeof step === 'function' ? step(results) : step;
    if (!spec) break;
    const call = toolCall(command, index, spec);
    const remaining = transcript.slice(index * 2);
    if (!remaining.length) return { ...answer(null), tool_calls: [call] };
    const result = readToolResult(remaining, call);
    if (!result || remaining.length % 2 !== 0) break;
    if (remaining.length === 2 && index === plan.steps.length - 1) return answer(plan.finish(result));
    if (result.success === false || result.ok === false) break;
    results.push(result);
  }
  return answer('The fixture sequence stopped. Check the page binding and tool details before taking another action.');
}

function complete(payload, origin) {
  const { command, attachments, transcript } = turnMessages(payload.messages);
  const plan = choosePlan(command, origin, attachments);
  if (typeof plan === 'string') return answer(plan);
  const offered = new Set(Array.isArray(payload.tools) ? payload.tools.map((item) => item?.function?.name) : []);
  if (plan.tools.some((name) => !offered.has(name))) return answer('The fixture tools are unavailable in this chat.');
  return advancePlan(plan, command, transcript);
}

async function modelResponse(request, origin) {
  if (request.method !== 'POST') return requestError(405, 'Use POST for fixture completions');
  // This is a public placeholder. It distinguishes the desktop provider from page-origin requests.
  if (request.headers.origin || request.headers.authorization !== `Bearer ${API_KEY}`) {
    return requestError(403, 'Use the fixture API key from the desktop custom API');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    return requestError(415, 'Use a JSON request');
  }
  const payload = await readPayload(request);
  if (payload === null) return requestError(413, 'Fixture request too large');
  if (payload.model !== MODEL_ID || !Array.isArray(payload.messages) || payload.stream === true) {
    return requestError(400, 'Use the fixture model ID and non-streaming chat messages');
  }
  const message = complete(payload, origin);
  return { status: 200, data: { id: 'chatcmpl-ai-free-fixture', object: 'chat.completion', model: MODEL_ID,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] } };
}

module.exports = { MODEL_PATH, MODEL_ID, API_KEY, modelResponse };
