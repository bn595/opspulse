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

test('admin.concurrency must be a whole number of 1 or more', () => {
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opspulse-config-'));
  const file = path.join(dir, 'config.json');
  for (const bad of [0, -1, 2.5, '5']) {
    fs.writeFileSync(file, JSON.stringify({ admin: { concurrency: bad } }));
    assert.throws(() => config.load(file), /admin\.concurrency must be a whole number of 1 or more/);
  }
  fs.writeFileSync(file, JSON.stringify({ admin: { concurrency: 10 } }));
  assert.equal(config.load(file).admin.concurrency, 10);
});
