'use strict';

const EDITOR_PATH = '/draft-editor';
const EDITOR_SCRIPT_PATH = '/draft-editor.js';
const EDITOR_PROMPT = 'QA PREVIEW DRAFT';

const editorPage = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Draft editor</title>
  <button id="open" type="button">Open draft</button>
  <section id="editor" hidden><label>Draft <input id="draft"></label>
  <button id="preview" type="button">Preview</button><button id="accept" type="button" disabled>Accept preview</button></section>
  <output id="result">Idle</output><script src="${EDITOR_SCRIPT_PATH}" defer></script></html>`;

function wireEditor() {
  const get = (id) => document.getElementById(id);
  get('open').addEventListener('click', () => { get('editor').hidden = false; });
  get('preview').addEventListener('click', () => {
    get('result').textContent = `Preview: ${get('draft').value}`;
    get('accept').disabled = false;
  });
  get('accept').addEventListener('click', () => { get('result').textContent = `Accepted: ${get('draft').value}`; });
}

const editorScript = `(${wireEditor.toString()})();`;
const action = (name, args) => ({ tool: 'browser_action', arguments: { action: name, ...args } });
const wait = (args) => ({ tool: 'browser_wait', arguments: { timeout_ms: 2000, ...args } });

function editorPlan(origin) {
  const steps = [
    action('click', { selector: '#open' }),
    wait({ selector: '#draft', condition: 'visible' }),
    action('click', { selector: '#draft' }),
    action('type', { selector: '#draft', text: 'First draft' }),
    action('press_key', { key: 'End' }),
    action('insert_text', { text: '!' }),
    action('click', { selector: '#preview' }),
    wait({ selector: '#result', condition: 'text_contains', value: 'Preview: First draft!' }),
    action('click', { selector: '#accept' }),
    wait({ selector: '#result', condition: 'text_contains', value: 'Accepted: First draft!' }),
  ];
  const target = origin + EDITOR_PATH;
  return {
    tools: ['browser_tab', 'browser_control', 'browser_observe', 'browser_page_batch'],
    steps: [
      ['browser_tab', { action: 'list' }],
      ['browser_control', { action: 'acquire' }],
      ['browser_observe', { tags: ['button'], mark: false }],
      ([tabs, control, observed]) => tabs.activeTab?.url === target && control?.takeoverActive === true
        && observed?.url === target && observed.items?.some(({ selector }) => selector === '#open')
        ? ['browser_page_batch', { steps }] : null,
      (results) => results.at(-1)?.completed === steps.length ? ['browser_observe', { tags: ['output'], mark: false }] : null,
    ],
    finish: (result) => result?.url === target && result.items?.some(({ text }) => text === 'Accepted: First draft!')
      ? 'Verified draft preview after ten page steps.' : 'The expected draft preview was not verified.',
  };
}

module.exports = { EDITOR_PATH, EDITOR_SCRIPT_PATH, EDITOR_PROMPT, editorPage, editorScript, editorPlan };
