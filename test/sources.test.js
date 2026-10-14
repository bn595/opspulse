'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const { BUILTIN, publicSources } = require('../src/sources');

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

test('the built-in source table reads each source section from the configuration', () => {
  const cfg = config.load(path.join(os.tmpdir(), 'opspulse-no-config', 'config.json'));
  cfg.jira.enabled = false;
  assert.deepEqual(Object.entries(BUILTIN).map(([k, s]) => [k, s.section(cfg).enabled, s.section(cfg).refreshMinutes]), [
    ['actions', true, 10], ['dismissals', true, 60], ['sonar', true, 60], ['jira', false, 10],
  ]);
});
