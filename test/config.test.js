'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const config = require('../src/config');

const missing = path.join(os.tmpdir(), 'opspulse-no-config', 'config.json');

test('each loaded configuration is independent, including its defaults', () => {
  const first = config.load(missing);
  first.github.dismissals.enterprise = 'changed';
  first.jira.statusRules.push({ status: 'Blocked' });
  const second = config.load(missing);
  assert.deepEqual([second.github.dismissals.enterprise, second.jira.statusRules], ['', []]);
});
