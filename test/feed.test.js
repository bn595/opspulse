'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const feed = require('../src/feed');

const NOW = Date.parse('2026-10-13T12:00:00Z');
const H = 3600e3;
const D = 24 * H;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const cfg = config.load(path.join(os.tmpdir(), 'opspulse-test-no-config', 'config.json')); // defaults only

const run = (n, conclusion, hoursAgo) => ({ n, status: 'completed', conclusion, created: at(hoursAgo * H), url: `https://gh/run/${n}` });
const workflow = (over) => ({ id: 1, name: 'Sync groups', state: 'active', url: 'https://gh/wf', runs: [], lastRun: null, expectEveryHours: null, ...over });
const actions = (...workflows) => ({ actions: { status: 'ok', data: { repos: [{ repo: 'acme/jobs', label: 'Jobs', workflows }] } } });
const issue = (key, over) => ({ key, status: 'Open', category: 'new', assignee: 'Ann', created: at(30 * D), updated: at(1 * H), ...over });
const jira = (...issues) => ({ jira: { status: 'ok', data: { issues, searchUrl: 'https://jira/search' } } });
const titles = (items) => items.map((i) => `${i.level}: ${i.title}`);

test('three failures inside the feed window are critical', () => {
  const items = feed.build(actions(workflow({ runs: [run(3, 'failure', 1), run(2, 'failure', 2), run(1, 'timed_out', 3)] })), cfg, NOW);
  assert.deepEqual(titles(items), ['critical: 3 failures in Sync groups in the last 24h']);
});

test('a single failure that has since recovered is a warning', () => {
  const items = feed.build(actions(workflow({ runs: [run(2, 'success', 1), run(1, 'failure', 2)] })), cfg, NOW);
  assert.deepEqual(titles(items), ['warn: 1 failure in Sync groups in the last 24h']);
  assert.match(items[0].detail, /latest run recovered/);
});

test('a failing latest run outside the window is still reported', () => {
  const items = feed.build(actions(workflow({ runs: [run(1, 'failure', 30)] })), cfg, NOW);
  assert.deepEqual(titles(items), ['warn: Sync groups is failing']);
});

test('a scheduled workflow that stopped running is overdue', () => {
  const last = run(1, 'success', 30);
  const items = feed.build(actions(workflow({ runs: [last], lastRun: last, expectEveryHours: 26 })), cfg, NOW);
  assert.deepEqual(titles(items), ["warn: Sync groups hasn't run in 30h"]);
});

test('healthy workflows produce no items', () => {
  const r = run(1, 'success', 1);
  assert.deepEqual(feed.build(actions(workflow({ runs: [r], lastRun: r, expectEveryHours: 26 })), cfg, NOW), []);
});

test('stale and unassigned open tickets are flagged, done tickets ignored', () => {
  const items = feed.build(jira(
    issue('IT-1', { updated: at(8 * D) }),
    issue('IT-2', { assignee: null }),
    issue('IT-3', { assignee: null, updated: at(20 * D), status: 'Done', category: 'done' }),
  ), cfg, NOW);
  assert.deepEqual(titles(items), ['warn: 1 open ticket untouched for 7+ days', 'warn: 1 open ticket with no assignee']);
});

test('status rules flag tickets that sat in a status too long', () => {
  const rules = { ...cfg, jira: { ...cfg.jira, statusRules: [{ status: 'Blocked', olderThanDays: 3 }] } };
  const items = feed.build(jira(
    issue('IT-1', { status: 'Blocked', category: 'indeterminate', statusSince: at(4 * D) }),
    issue('IT-2', { status: 'Blocked', category: 'indeterminate', statusSince: at(1 * D) }),
  ), rules, NOW);
  assert.deepEqual(titles(items), ['warn: 1 ticket in “Blocked” for over 3d']);
});

test('a failed refresh is critical and sorts before warnings', () => {
  const sources = { ...jira(issue('IT-2', { assignee: null })), sonar: { status: 'error', error: '401 from sonarcloud.io' } };
  assert.deepEqual(titles(feed.build(sources, cfg, NOW)), ['critical: SonarQube Cloud refresh failed', 'warn: 1 open ticket with no assignee']);
});

test('waiting for Key Vault sign-in is not reported per source', () => {
  const sources = { sonar: { status: 'error', error: 'Waiting for Key Vault sign-in' }, jira: { status: 'error', error: 'Waiting for Key Vault sign-in' } };
  const signIn = { id: 'secret-0', level: 'warn', source: 'secrets', title: 'Sign in to load secrets from Key Vault' };
  assert.deepEqual(titles(feed.build(sources, cfg, NOW, [signIn])), ['warn: Sign in to load secrets from Key Vault']);
});

test('disabled sources are ignored', () => {
  assert.deepEqual(feed.build({ sonar: { status: 'disabled', error: 'x' } }, cfg, NOW), []);
});

test('plugin feed items and plugin failures appear under the plugin title', () => {
  const sources = {
    'plugin:access-report': { status: 'ok', title: 'Access report', data: { feed: [{ id: 'plugin-access-report-0', level: 'warn', source: 'access-report', title: '3 requests waiting' }] } },
    'plugin:broken': { status: 'error', title: 'Broken report', error: 'broken: boom' },
  };
  assert.deepEqual(feed.build(sources, cfg, NOW).map((i) => [i.level, i.source, i.title]), [
    ['critical', 'broken', 'Broken report refresh failed'],
    ['warn', 'access-report', '3 requests waiting'],
  ]);
});

test('a rate-limited source is a warning that says when it resumes', () => {
  const sources = { sonar: { status: 'rate-limited', error: 'rate limited by sonarqube.us; next attempt at 12:30 UTC', retryAt: '2026-10-13T12:30:00.000Z' } };
  assert.deepEqual(feed.build(sources, cfg, NOW).map((i) => [i.level, i.title, i.detail]), [
    ['warn', 'SonarQube Cloud paused by rate limiting', 'rate limited by sonarqube.us; next attempt at 12:30 UTC'],
  ]);
});
