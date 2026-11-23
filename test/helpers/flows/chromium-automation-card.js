'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { entryTools } = require('./chromium-mcp-file-parity');

const LOGIN_PATH = '/automation-card-login';
const SIGNED_IN = 'Signed in as Fixture User';
const SIGNED_OUT = 'Signed out';

function createCardLoginFixture() {
  const evidence = { state: SIGNED_OUT, loginSubmits: 0, pageLoads: 0 };
  function serve(url, method, response) {
    if (url.pathname !== LOGIN_PATH) return false;
    if (method === 'GET') {
      evidence.pageLoads += 1;
      response.end(`<!doctype html><meta charset="utf-8"><title>Local sign-in fixture</title>
        <button id="login">Sign in</button><button id="logout">Sign out</button>
        <dialog id="chooser"><button id="email">Continue with email</button><button id="dismiss">Close</button></dialog>
        <output id="login-state">${evidence.state}</output>
        <script>
          document.addEventListener('click', async (event) => {
            if (!event.isTrusted || !event.target.matches('button')) return;
            const chooser = document.querySelector('#chooser');
            const id = event.target.id;
            if (id === 'login') return chooser.showModal();
            if (id === 'dismiss') return chooser.close();
            if (id === 'email') chooser.close();
            const receipt = await fetch('?action=' + (id === 'email' ? 'login' : id), { method: 'POST' });
            if (receipt.ok) document.querySelector('#login-state').textContent = await receipt.text();
          });
        </script>`);
      return true;
    }
    const action = url.searchParams.get('action');
    if (method !== 'POST' || !['login', 'logout'].includes(action)) {
      response.writeHead(400).end();
      return true;
    }
    if (action === 'login') evidence.loginSubmits += 1;
    evidence.state = action === 'login' ? SIGNED_IN : SIGNED_OUT;
    response.end(evidence.state);
    return true;
  }
  return { serve, evidence };
}

async function waitForCompletion(call, runId) {
  const deadline = Date.now() + 45000;
  let lastStep;
  while (Date.now() < deadline) {
    const { run } = await call('manage_card', { action: 'get_run', run_id: runId });
    if (run.finishedAt) return run;
    lastStep = run.currentStepId;
    await delay(40);
  }
  assert.fail(`The card did not finish within 45s (last step: ${lastStep})`);
}

function waitForLoginState(value) {
  return { condition: 'text_contains', selector: '#login-state', value, timeout_ms: 3000 };
}

async function verifyLoginCheckpoint(call, fixture, stage, state, loginSubmits) {
  const observed = await call('browser_wait', waitForLoginState(state));
  const evidence = fixture.evidence;
  assert.equal(observed.success, true, `Expected the page to show "${state}" after ${stage}`);
  process.stdout.write(`${stage} ${JSON.stringify(evidence)}\n`);
  assert.equal(evidence.state, state, `Local login state after ${stage}`);
  assert.equal(evidence.loginSubmits, loginSubmits, `Login POST count after ${stage}`);
  assert.equal(evidence.pageLoads, 1, `Login document requested again during ${stage}`);
}

async function verifyPartialLoginFailure(external, sidebar, fixture, url) {
  const { item } = await external('manage_card', { action: 'write', cardData: {
    name: 'Fixture with invalid wait', website: url, steps: [
      { type: 'click', selector: '#login' },
      { type: 'wait', selector: '#email', ms: 'invalid' },
    ],
  } });
  const { run } = await external('manage_card', { action: 'start_run', id: item.id });
  const failed = await waitForCompletion(sidebar, run.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.output.stepIndex, 2);
  assert.equal(failed.error.code, 'AUTOMATION_ARGUMENT_INVALID');
  assert.equal(failed.sideEffectsMayHaveOccurred, true);
  assert.equal(failed.retryAvailable, false);
  assert.equal((await external('browser_wait', { selector: '#chooser[open] #email', condition: 'visible' })).success, true);
  // The first click still holds the dialog open. Restore the observed starting state before a fresh run.
  assert.equal((await external('browser_action', { action: 'click', selector: '#dismiss' })).actionExecuted, true);
  assert.equal((await external('browser_wait', { selector: '#chooser', condition: 'hidden' })).success, true);
  await verifyLoginCheckpoint(external, fixture, 'Closed dialog after failed step 2', SIGNED_OUT, 1);
}

async function verifySamePageLogin(entries, fixture, url) {
  const [external, sidebar] = entries;
  assert.equal((await external('browser_control', { action: 'acquire' })).success, true);
  try {
    await verifyLoginCheckpoint(external, fixture, 'Initial page', SIGNED_OUT, 0);
    const opened = await external('browser_action', { action: 'click', selector: '#login' });
    assert.equal(opened.actionExecuted, true);
    for (const [selector, state] of [['#email', SIGNED_IN], ['#logout', SIGNED_OUT]]) {
      const click = await external('browser_action', { action: 'click', selector });
      assert.equal(click.actionExecuted, true, `Manual ${selector} click`);
      await verifyLoginCheckpoint(external, fixture, `Manual ${selector}`, state, 1);
    }
    await verifyPartialLoginFailure(external, sidebar, fixture, url);
    const { item } = await external('manage_card', { action: 'write', cardData: {
      name: 'Same-page fixture sign-in', website: url, steps: [
        { type: 'click', selector: '#login' },
        { type: 'wait', selector: '#chooser[open] #email' },
        { type: 'click', selector: '#email' },
        { type: 'mcp', tool: 'browser_wait', arguments: waitForLoginState(SIGNED_IN) },
      ],
    } });
    const { run } = await external('manage_card', { action: 'start_run', id: item.id });
    const completed = await waitForCompletion(sidebar, run.id);
    assert.equal(completed.id, run.id);
    process.stdout.write(`External start_run -> sidebar get_run: ${completed.status}\n`);
    assert.equal(completed.status, 'succeeded', completed.error?.message);
    await verifyLoginCheckpoint(external, fixture, 'Card sign-in', SIGNED_IN, 2);
  } finally {
    await external('browser_control', { action: 'release' });
  }
}

async function verifyAutomationCard({ manager, profileId, origin, workspace, loginFixture }) {
  const entries = entryTools(manager, workspace);
  const { item } = await entries[0]('manage_card', { action: 'write',
    cardData: { name: 'Native navigation', steps: [{ type: 'navigate', url: '{url}' }] },
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  });
  for (const [i, call] of entries.entries()) {
    assert.equal((await call('browser_control', { action: 'acquire' })).success, true);
    try {
      const url = `${origin}/page?profile=d&card=${i}`;
      const { run } = await call('manage_card', { action: 'start_run', id: item.id, inputs: { url } });
      const completed = await waitForCompletion(entries[1 - i], run.id);
      assert.equal(completed.status, 'succeeded', completed.error?.message);
      assert.equal((await manager.listTabs(profileId, 'chromium')).result.activeTab.url, url);
    } finally {
      await call('browser_control', { action: 'release' });
    }
  }
  process.stdout.write('Both MCP entries ran the same card, queried the other run and navigated real Chromium.\n');
  const url = origin + LOGIN_PATH;
  await manager.navigate(profileId, 'chromium', url);
  await verifySamePageLogin(entries, loginFixture, url);
}

module.exports = { createCardLoginFixture, verifyAutomationCard };
