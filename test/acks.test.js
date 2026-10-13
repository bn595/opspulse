'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAcks } = require('../src/acks');

const item = (title) => ({ id: 'jira-stale', level: 'warn', title });

test('an acknowledged item is muted while its title is unchanged', () => {
  const acks = createAcks();
  acks.acknowledge(item('3 open tickets untouched for 7+ days'));
  const [annotated] = acks.annotate([item('3 open tickets untouched for 7+ days')]);
  assert.deepEqual(annotated.muted, { kind: 'acknowledged' });
});

test('an acknowledged item resurfaces when its title changes', () => {
  const acks = createAcks();
  acks.acknowledge(item('3 open tickets untouched for 7+ days'));
  const [annotated] = acks.annotate([item('5 open tickets untouched for 7+ days')]);
  assert.equal(annotated.muted, undefined);
});

test('a snoozed item is muted until the snooze expires', () => {
  let now = Date.parse('2026-10-13T12:00:00Z');
  const acks = createAcks({ now: () => now });
  acks.snooze(item('Sync groups is failing'), 24);

  assert.deepEqual(acks.annotate([item('Sync groups is failing')])[0].muted, { kind: 'snoozed', until: '2026-10-14T12:00:00.000Z' });
  now += 24 * 3600e3;
  assert.equal(acks.annotate([item('Sync groups is failing')])[0].muted, undefined);
});

test('restore unmutes an item', () => {
  const acks = createAcks();
  acks.acknowledge(item('Sync groups is failing'));
  acks.restore('jira-stale');
  assert.equal(acks.annotate([item('Sync groups is failing')])[0].muted, undefined);
});

test('acknowledgements survive a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opspulse-acks-')), 'acks.json');
  createAcks({ file }).acknowledge(item('Sync groups is failing'));
  assert.deepEqual(createAcks({ file }).annotate([item('Sync groups is failing')])[0].muted, { kind: 'acknowledged' });
});

test('invalid requests are rejected', () => {
  const acks = createAcks();
  assert.throws(() => acks.acknowledge({ id: 'jira-stale' }), /id and title are required/);
  assert.throws(() => acks.snooze(item('x'), 0), /hours must be between 1 and 720/);
  assert.throws(() => acks.snooze(item('x'), 'soon'), /hours must be between 1 and 720/);
});
