'use strict';

const FILENAME = 'sample.png';
const ASSETS = {
  red: {
    id: 'source-red', label: 'Red square',
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAA1klEQVR4nO3aSw3DQBRD0eCYnVEbwjAIvRRBu+nnRdWRBsGV7dh6Oc4V73wO4UDnfCkRgAJQ3nEJBQWgUFC+96lhsQAUCgqLZarQyqD8CNC1e6t3OwVd00QAKkCloLJYx9NHSBegUlBZrDIoimI0aVMjtliM1SqK1aRratQW6/hGNVYLUCmoLFYZFFcNZx93seVwuFxWt6K4NeltamxbbM+XQ2O1AJWCymIdDyC/4BWgUlBZrDIof//8aR+AQkFhscigjOexkA5AoaCwWMZzR1EMQPmUgh6dDVPhIuzGCwAAAABJRU5ErkJggg==', 'base64'),
  },
  blue: {
    id: 'source-blue', label: 'Blue stripes',
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAxUlEQVR4nO3VwWkDQBRDQbeRotyV+3ptuBu5AV8COXzCwJ6XRUizj9d7X8/Ps1+d/3rP49qDXsfuEVACmgZlYmNQkM4vtjvfs28+AU2DMrExqJu4QjoBTYMysTGom7hCOgFNgzKxMaibuEI6AU2DMrExqJu4QjoBTYMysTGom7hCOgFNgzKxMaibuEI6AU2DMrExqJu4QjoBTYMysTGom7hCOgFNgzKxMaibuEI6AU2DMrExqJu4QjoBTYMysTGom7hCOgFNgzKxMaibuEI6AU2DMrExqJu4QjoBTYMysTGom7j+FdIfR7IqLIQWUxsAAAAASUVORK5CYII=', 'base64'),
  },
};

function assetPath(asset) {
  return `/assets/${asset.id}/${FILENAME}`;
}

function page(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title><style>main{overflow-wrap:anywhere} figure{margin-inline:0} img{max-width:100%;height:auto}</style>
    <main><h1 id="fixture-title">${title}</h1>${body}</main></html>`;
}

function sourcePage() {
  return page('A - Source', Object.values(ASSETS).map((asset) => `
    <figure><img id="${asset.id}" src="${assetPath(asset)}" alt="${asset.label}" width="192" height="128">
    <figcaption>${asset.label} - ${FILENAME} <a href="${assetPath(asset)}" download="${FILENAME}">Download</a></figcaption></figure>`).join(''));
}

function uploadPage(target, mode) {
  const title = target === 'b' ? 'B - Upload target' : 'C - Distractor';
  return page(title, `<div id="upload-fixture" data-target="${target}" data-mode="${mode}">
    <p>Mode: <span id="fixture-mode">${mode}</span></p>
    <label for="fixture-file">PNG file</label> <input id="fixture-file" type="file" accept="image/png,.png">
    <button id="fixture-submit" type="button" disabled>Submit file</button>
    <button id="fixture-read" type="button">Read server state</button>
    <p>Selection: <span id="selection-status" role="status">empty</span></p>
    <p>Receipt: <span id="receipt-status" role="status">idle</span></p>
    <p>Readback: <span id="readback-status" role="status">idle</span></p>
    <dl><dt>Selection count</dt><dd id="selection-count">0</dd>
    <dt>Received count</dt><dd id="received-count">0</dd>
    <dt>Last received name</dt><dd id="received-name">-</dd>
    <dt>Last received SHA-256</dt><dd id="received-sha256">-</dd>
    <dt>Dropped receipts</dt><dd id="dropped-receipts">0</dd></dl></div>
    <script src="/upload-page.js" defer></script>`);
}

module.exports = { ASSETS, FILENAME, assetPath, sourcePage, uploadPage };
