'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourceScope } = require('../../helpers/flows/resources');

test('resources close in reverse dependency order after partial setup and close once', async () => {
  const scope = createResourceScope();
  const events = [];
  scope.defer('directory', () => events.push('directory'));
  scope.defer('server', async () => { events.push('server'); });
  scope.defer('browser', () => events.push('browser'));
  const first = scope.close();
  const second = scope.close();
  assert.deepEqual(await first, { ok: true, failed: [] });
  assert.deepEqual(await second, { ok: true, failed: [] });
  assert.deepEqual(events, ['browser', 'server', 'directory']);
  assert.throws(() => scope.defer('late', () => {}), /RESOURCE_SCOPE_CLOSED/);
});

test('cleanup failures do not skip remaining releases or leak exception details', async () => {
  const scope = createResourceScope();
  let releases = 0;
  scope.defer('server', () => { releases++; });
  scope.defer('browser', () => { throw new Error('token=must-not-leak'); });
  assert.throws(() => scope.defer('browser', () => {}), /DUPLICATE_RESOURCE/);
  const result = await scope.close();
  assert.equal(releases, 1);
  assert.deepEqual(result, { ok: false, failed: ['browser'] });
  assert(!JSON.stringify(result).includes('must-not-leak'));
});
