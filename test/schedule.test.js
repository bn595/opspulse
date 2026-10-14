'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planRefresh } = require('../src/schedule');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const MIN = 60e3;
const intervals = { actions: 10, jira: 10, dismissals: 60, sonar: 60 };

test('sources that have never been attempted are due', () => {
  assert.deepEqual(planRefresh({ intervals, lastAttempt: {}, now: NOW }).due, ['actions', 'jira', 'dismissals', 'sonar']);
});

test('a source is due once its own interval has elapsed', () => {
  const lastAttempt = { actions: NOW - 10 * MIN, jira: NOW - 9 * MIN, dismissals: NOW - 30 * MIN, sonar: NOW - 61 * MIN };
  assert.deepEqual(planRefresh({ intervals, lastAttempt, now: NOW }).due, ['actions', 'sonar']);
});

test('a forced refresh includes every source except rate-limited ones', () => {
  const lastAttempt = { actions: NOW, jira: NOW, dismissals: NOW, sonar: NOW };
  const plan = planRefresh({ intervals, lastAttempt, blockedUntil: { sonar: NOW + 5 * MIN }, now: NOW, force: true });
  assert.deepEqual(plan.due, ['actions', 'jira', 'dismissals']);
});

test('a rate-limited source waits for its block to end even when its interval has passed', () => {
  const plan = planRefresh({ intervals, lastAttempt: { sonar: NOW - 2 * 60 * MIN }, blockedUntil: { sonar: NOW + 5 * MIN }, now: NOW });
  assert.deepEqual(plan.due, ['actions', 'jira', 'dismissals']);
});

test('nextAt is the earliest time any source becomes due', () => {
  const lastAttempt = { actions: NOW - 4 * MIN, jira: NOW - 1 * MIN, dismissals: NOW - 1 * MIN, sonar: NOW - 1 * MIN };
  assert.equal(planRefresh({ intervals, lastAttempt, blockedUntil: { actions: NOW + 20 * MIN }, now: NOW }).nextAt, NOW + 9 * MIN);
});
