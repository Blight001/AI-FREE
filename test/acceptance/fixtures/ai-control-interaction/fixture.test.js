'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { startFixture } = require('./server');
const { sendCustomAIControlMessage } = require('../../../../src/app/backend/services/custom-ai-api');
const { buildAttachmentMessages } = require('../../../../src/app/backend/features/ai-chat/ai-workspace-service');

const PNG_SIGNATURE = '89504e470d0a1a0a';
const SETUP = { timeout: 10000 };

async function fixtureFor(t) {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  return fixture;
}

function readState(fixture) {
  return fetch(fixture.urls.state).then((response) => {
    assert.equal(response.status, 200);
    return response.json();
  });
}

function post(fixture, route, body, filename = 'sample.png', origin = fixture.origin) {
  return fetch(fixture.origin + route, {
    method: 'POST', body, headers: { Origin: origin, 'X-Fixture-Filename': encodeURIComponent(filename) },
  });
}

test('A serves visually distinct same-name PNGs matching the isolated workspace copies', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  assert.equal(new URL(fixture.origin).hostname, '127.0.0.1');
  assert.equal(path.dirname(fixture.workspace), fixture.desktop);
  assert.deepEqual(await fs.readdir(fixture.userData), []);
  const a = await fetch(fixture.urls.a);
  assert.equal(a.status, 200);
  const html = await a.text();
  assert.match(html, /Red square/);
  assert.match(html, /Blue stripes/);
  for (const file of Object.values(fixture.files)) {
    assert.equal(path.basename(file.path), 'sample.png');
    assert.ok(html.includes(file.route));
    const response = await fetch(fixture.origin + file.route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), PNG_SIGNATURE);
    assert.deepEqual(bytes, await fs.readFile(file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  assert.notEqual(fixture.files.red.sha256, fixture.files.blue.sha256);
  for (const [url, title] of [[fixture.urls.b, 'B - Upload target'], [fixture.urls.c, 'C - Distractor']]) {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(`<title>${title}</title>`));
  }
});

test('selection and receipt are separate; B and C record their own byte digests', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const red = await fs.readFile(fixture.files.red.path);
  const blue = await fs.readFile(fixture.files.blue.path);
  const selected = await post(fixture, '/b/select', red);
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), {
    selectionCount: 1, receivedCount: 0, droppedReceipts: 0, lastReceived: null,
    lastSelected: { name: 'sample.png', size: red.length, sha256: fixture.files.red.sha256 },
  });
  assert.equal((await post(fixture, '/b/submit', red)).status, 200);
  const prior = await readState(fixture);
  assert.deepEqual(prior.b.lastReceived, prior.b.lastSelected);
  assert.equal(prior.b.receivedCount, 1);
  assert.equal(prior.c.receivedCount, 0);
  assert.equal((await post(fixture, '/c/select', blue)).status, 200);
  assert.equal((await post(fixture, '/c/submit', blue)).status, 200);
  const final = await readState(fixture);
  assert.deepEqual(final.b, prior.b);
  assert.equal(final.c.selectionCount, 1);
  assert.equal(final.c.receivedCount, 1);
  assert.equal(final.c.lastReceived.sha256, fixture.files.blue.sha256);
});

test('drop-once records the submit before severing its receipt and exposes duplicates', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const red = await fs.readFile(fixture.files.red.path);
  const submit = '/b/submit?mode=drop-once';
  const select = await post(fixture, '/b/select?mode=drop-once', red);
  assert.equal(select.status, 200);
  assert.equal((await select.json()).receivedCount, 0);
  const broken = await post(fixture, submit, red);
  assert.equal(broken.status, 200);
  await assert.rejects(broken.json());
  const committed = await readState(fixture);
  assert.equal(committed.b.receivedCount, 1);
  assert.equal(committed.b.droppedReceipts, 1);
  assert.equal(committed.b.lastReceived.sha256, fixture.files.red.sha256);
  assert.equal(committed.c.receivedCount, 0);
  const duplicate = await post(fixture, submit, red);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).receivedCount, 2);
  assert.equal((await post(fixture, '/c/submit?mode=drop-once', red)).status, 404);
  assert.equal((await post(fixture, '/reset')).status, 200);
  const reset = await readState(fixture);
  assert.deepEqual(reset.b, reset.c);
  assert.equal(reset.b.receivedCount, 0);
  assert.equal(reset.b.selectionCount, 0);
  assert.equal(reset.b.lastReceived, null);
  assert.equal(reset.b.droppedReceipts, 0);
  const afterReset = await post(fixture, submit, red);
  assert.equal(afterReset.status, 200);
  await assert.rejects(afterReset.json());
});

test('invalid writes do not change counts, and close removes both the listener and the fixtures', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  assert.equal((await post(fixture, '/b/select', 'invalid', '../sample.png')).status, 400);
  assert.equal((await post(fixture, '/b/submit', 'invalid', 'sample.png', 'http://127.0.0.1:1')).status, 403);
  assert.equal((await post(fixture, '/b/submit', Buffer.alloc(1024 * 1024 + 1))).status, 413);
  assert.equal((await readState(fixture)).b.receivedCount, 0);
  assert.equal((await readState(fixture)).b.selectionCount, 0);
  await fixture.close();
  await fixture.close();
  await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
  await assert.rejects(fetch(fixture.urls.state));
});

test('delayed command emits progress, optional oversized output and a descendant completion marker', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const execution = promisify(execFile)(process.execPath, [fixture.command, '--delay-ms', '400', '--output-bytes', '80000'], {
    cwd: path.dirname(fixture.command), timeout: 3500, windowsHide: true,
  });
  let observedOutput = false;
  execution.child.stdout.once('data', () => { observedOutput = true; });
  const { stdout, stderr } = await execution;
  assert.equal(observedOutput, true);
  assert.match(stdout, /^fixture: start\r?\nfixture: child pid=\d+/);
  assert.match(stdout, /fixture: complete\s*$/);
  assert.ok(Buffer.byteLength(stdout) > 64 * 1024);
  assert.match(stderr, /^fixture: progress/);
  assert.equal(await fs.readFile(fixture.commandMarker, 'utf8'), 'child completed\n');
});

function customConfig(fixture) {
  return { enabled: true, baseUrl: fixture.urls.model, model: fixture.model.id,
    apiKey: fixture.model.apiKey, supportsImageInput: true };
}

function provider(t, fixture, toolNames = []) {
  const old = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  t.after(() => {
    if (old === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = old;
  });
  const tools = toolNames.map((name) => ({ name }));
  return async (messages) => {
    const result = await sendCustomAIControlMessage(customConfig(fixture), messages, { tools });
    assert.equal(result.ok, true, result.message);
    return result.message;
  };
}

const user = (content) => ({ role: 'user', content });

function assertCall(message, name, args) {
  assert.equal(message.tool_calls.length, 1);
  const call = message.tool_calls[0];
  assert.equal(call.function.name, name);
  assert.deepEqual(JSON.parse(call.function.arguments), args);
}

function toolResult(message, result) {
  const call = message.tool_calls[0];
  return [message, { role: 'tool', name: call.function.name, tool_call_id: call.id, content: JSON.stringify(result) }];
}

test('production custom API reaches the loopback fixture without an account and sees only current attachments', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const complete = provider(t, fixture);
  const red = buildAttachmentMessages(fixture.workspace, ['source-red/sample.png']);
  const blue = buildAttachmentMessages(fixture.workspace, ['source-blue/sample.png']);
  const old = [user('QA ATTACH'), ...red, { role: 'assistant', content: 'prior reply' }];
  const result = await complete([...old, user('QA ATTACH'), ...blue]);
  assert.match(result.content, /source-blue\/sample\.png \(Blue stripes\)/);
  assert.deepEqual(result.tool_calls, []);
  assert.match((await complete([...old, user('QA ATTACH')])).content, /exactly one fixture PNG/);
  assert.match((await complete([user('QA ATTACH'), ...red, ...blue])).content, /exactly one fixture PNG/);
  assert.match((await complete([user('say QA ATTACH'), ...blue])).content, /No tool ran/);
});

test('fixture completion route rejects bad host, browser origins, credentials, models and streams', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const payload = { model: fixture.model.id, messages: [user('QA ATTACH')], stream: false };
  const request = (body, headers) => fetch(fixture.urls.model, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fixture.model.apiKey}`, ...headers } });
  assert.equal((await fetch(fixture.urls.model)).status, 405);
  assert.equal((await fetch(fixture.urls.model.replace('127.0.0.1', 'localhost'))).status, 403);
  for (const headers of [{ Origin: fixture.origin }, { Authorization: '' }]) {
    assert.equal((await request(JSON.stringify(payload), headers)).status, 403);
  }
  assert.equal((await request(JSON.stringify(payload), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request(JSON.stringify({ ...payload, model: 'unknown' }))).status, 400);
  assert.equal((await request(JSON.stringify({ ...payload, stream: true }))).status, 400);
  assert.equal((await request('{')).status, 400);
  assert.equal((await request(' '.repeat(2 * 1024 * 1024 + 1))).status, 413);
  // The origin exemption for the provider does not apply to the existing fixture write routes.
  assert.equal((await fetch(fixture.urls.reset, { method: 'POST' })).status, 403);
});

const browserTools = ['browser_observe', 'browser_control', 'browser_file'];

async function reachAcquire(complete, messages, observeArgs, observation) {
  const observe = await complete(messages);
  assertCall(observe, 'browser_observe', observeArgs);
  const transcript = [...messages, ...toolResult(observe, observation)];
  const acquire = await complete(transcript);
  assertCall(acquire, 'browser_control', { action: 'acquire' });
  return [...transcript, ...toolResult(acquire, { success: true, takeoverActive: true })];
}

test('bound download uses only the chosen observed A image and stops on wrong targets or replay', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const complete = provider(t, fixture, browserTools);
  const messages = [user('QA DOWNLOAD BLUE')];
  const observeArgs = { mark: false, filter: 'media', include_media: true, limit: 20 };
  const observation = { success: true, url: fixture.urls.a, items: [
    { id: 'r1', selector: '#source-red', mediaUrl: fixture.origin + fixture.files.red.route },
    { id: 'r2', selector: '#source-blue', mediaUrl: fixture.origin + fixture.files.blue.route },
  ] };
  const observe = await complete(messages);
  const wrongPage = [...messages, ...toolResult(observe, { ...observation, url: fixture.urls.c })];
  assert.deepEqual((await complete(wrongPage)).tool_calls, []);
  const acquired = await reachAcquire(complete, messages, observeArgs, observation);
  const download = await complete(acquired);
  assertCall(download, 'browser_file', { action: 'download_element', ref: 'r2', filename: 'sample.png',
    directory: 'qa-download-blue', media_type: 'image' });
  const completed = [...acquired, ...toolResult(download, { success: true })];
  const reply = await complete(completed);
  assert.match(reply.content, /Open the PNG card/);
  assert.deepEqual((await complete([...completed, reply])).tool_calls, []);
  assert.deepEqual((await complete([...acquired, download])).tool_calls, []);
});

test('binding B or drop-once permits only selection and never replays unknown results', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const complete = provider(t, fixture, browserTools);
  const downloaded = 'qa-download-red/sample (1).png';
  await fs.mkdir(path.join(fixture.workspace, 'qa-download-red'));
  await fs.copyFile(fixture.files.red.path, path.join(fixture.workspace, downloaded));
  const attachment = buildAttachmentMessages(fixture.workspace, [downloaded]);
  const messages = [user('QA SELECT B'), ...attachment];
  const observeArgs = { mark: false, filter: 'file-input', limit: 12 };
  const observation = { success: true, url: fixture.urls.dropOnce, items: [{ selector: '#fixture-file' }] };
  const observe = await complete(messages);
  const wrongPage = [...messages, ...toolResult(observe, { ...observation, url: fixture.urls.c })];
  assert.deepEqual((await complete(wrongPage)).tool_calls, []);
  const acquired = await reachAcquire(complete, messages, observeArgs, observation);
  const select = await complete(acquired);
  assertCall(select, 'browser_file', { action: 'upload', path: downloaded, selector: '#fixture-file' });
  for (const result of [
    { success: true, uploadVerification: 'file_selected' },
    { success: false, errorCode: 'UPLOAD_NOT_CONFIRMED' },
    { success: false, errorCode: 'UPLOAD_OUTCOME_UNVERIFIED' },
  ]) {
    const reply = await complete([...acquired, ...toolResult(select, result)]);
    assert.deepEqual(reply.tool_calls, []);
    assert.match(reply.content, result.success ? /Submit file manually/ : /selection is unverified/);
  }
  assert.deepEqual((await complete([user('QA SELECT B')])).tool_calls, []);
  const state = await readState(fixture);
  assert.equal(state.b.receivedCount, 0);
  assert.equal(state.c.selectionCount, 0);
});

test('optional B readback emits just a read-only observation and reports visible receipt status', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const complete = provider(t, fixture, ['browser_observe']);
  const messages = [user('QA OBSERVE B')];
  const observe = await complete(messages);
  assertCall(observe, 'browser_observe', { mark: false, filter: 'text', tags: ['span', 'dd'], include_text: true, limit: 12 });
  const reply = await complete([...messages, ...toolResult(observe, { success: true, url: fixture.urls.dropOnce, items: [
    { elementId: 'receipt-status', text: 'unknown' }, { elementId: 'readback-status', text: 'verified' },
    { elementId: 'received-count', text: '1' },
  ] })]);
  assert.match(reply.content, /Receipt unknown, readback verified, displayed received count 1/);
  assert.deepEqual(reply.tool_calls, []);
});

test('command prompts use only the seeded script, fixed arguments and working directory', SETUP, async (t) => {
  const fixture = await fixtureFor(t);
  const complete = provider(t, fixture, ['run_command']);
  for (const [prompt, timeout_ms, extra] of [
    ['QA COMMAND', 15000, ''], ['QA COMMAND TIMEOUT', 1000, ''], ['QA COMMAND TRUNCATE', 15000, ' --output-bytes 80000'],
  ]) {
    const messages = [user(prompt)];
    const run = await complete(messages);
    assertCall(run, 'run_command', { command: `node delayed-command.js --delay-ms 6000${extra}`, directory: 'command', timeout_ms });
    const reply = await complete([...messages, ...toolResult(run, { timed_out: timeout_ms === 1000 })]);
    assert.deepEqual(reply.tool_calls, []);
  }
  assert.deepEqual((await complete([user('QA COMMAND & echo custom')])).tool_calls, []);
  assert.deepEqual((await complete([user('QA DOWNLOAD RED')])).tool_calls, []);
});
