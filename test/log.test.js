'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('../src/log');

const NOW = new Date('2026-10-26T12:00:00.000Z');
function capture({ isTTY = false } = {}) {
  const lines = [];
  return { lines, stream: { isTTY, write: (s) => { lines.push(s); return true; } } };
}

test('json format writes one object per line with time, level, event and fields', () => {
  const out = capture();
  createLogger({ format: 'json', stream: out.stream, now: () => NOW }).warn('source.refresh_failed', { source: 'sonar', error: '401' });
  assert.deepEqual(out.lines, ['{"time":"2026-10-26T12:00:00.000Z","level":"warn","event":"source.refresh_failed","source":"sonar","error":"401"}\n']);
});

test('pretty format is readable at a terminal', () => {
  const out = capture({ isTTY: true });
  createLogger({ format: 'auto', stream: out.stream, now: () => NOW }).audit('sonar.key_updated', { project: 'Acme_new', from: 'Acme_old' });
  assert.deepEqual(out.lines, ['12:00:00 AUDIT sonar.key_updated project=Acme_new from=Acme_old\n']);
});

test('auto format writes json when output is not a terminal', () => {
  const out = capture({ isTTY: false });
  createLogger({ format: 'auto', stream: out.stream, now: () => NOW }).info('server.started', { port: 4777 });
  assert.deepEqual(JSON.parse(out.lines[0]), { time: '2026-10-26T12:00:00.000Z', level: 'info', event: 'server.started', port: 4777 });
});

test('the optional file receives json lines regardless of console format', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opspulse-log-')), 'opspulse.log');
  const out = capture({ isTTY: true });
  const log = createLogger({ format: 'pretty', stream: out.stream, file, now: () => NOW });
  log.audit('sonar.branch_deleted', { project: 'Acme_api', branch: 'dev' });
  log.info('server.started', {});
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).event), ['sonar.branch_deleted', 'server.started']);
});

test('fields that look like credentials are redacted', () => {
  const out = capture();
  createLogger({ format: 'json', stream: out.stream, now: () => NOW }).info('debug', { token: 'ghp_x', clientSecret: 's', password: 'p', authorization: 'Bearer y', project: 'Acme_api' });
  assert.deepEqual(JSON.parse(out.lines[0]), { time: NOW.toISOString(), level: 'info', event: 'debug', token: '[redacted]', clientSecret: '[redacted]', password: '[redacted]', authorization: '[redacted]', project: 'Acme_api' });
});
