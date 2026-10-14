'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicSources } = require('../src/sources');

test('connector sync state is never sent to the browser', () => {
  const sources = { dismissals: { status: 'ok', data: { orgs: [], _sync: { fingerprint: 'x', hidden: { a: 1 } } } } };
  const out = publicSources(sources);
  assert.deepEqual(out.dismissals.data, { orgs: [] });
  assert.ok(sources.dismissals.data._sync, 'the server keeps its own copy');
});

test('each source says which platform budget it draws on', () => {
  const out = publicSources({ sonar: { status: 'ok' }, actions: { status: 'ok' }, 'plugin:report': { status: 'ok', platform: 'jira' } });
  assert.deepEqual([out.sonar.platform, out.actions.platform, out['plugin:report'].platform], ['sonar', 'github', 'jira']);
});
