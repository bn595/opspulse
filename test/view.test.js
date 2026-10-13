'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../public/view.js');

const ALERTS = [
  { id: 1, tool: 'secret-scanning', reason: 'false_positive', repo: 'acme/api', title: 'Slack token' },
  { id: 2, tool: 'secret-scanning', reason: 'used_in_tests', repo: 'acme/api', title: 'AWS key' },
  { id: 3, tool: 'secret-scanning', reason: 'false_positive', repo: 'acme/web', title: 'Slack token' },
  { id: 4, tool: 'code-scanning', reason: 'false_positive', repo: 'acme/web', title: 'SQL injection' },
  { id: 5, tool: 'dependabot', reason: 'tolerable_risk', repo: 'acme/web', title: 'lodash' },
];
const facets = {
  tool: { label: 'Tool', get: (i) => i.tool },
  reason: { label: 'Reason', get: (i) => i.reason },
  repo: { label: 'Repository', get: (i) => i.repo },
};
const panel = (filters = {}, query = '') => ({ facets, filters, query, search: (i) => `${i.title} ${i.repo}` });
const ids = (items) => items.map((i) => i.id);

test('filterItems keeps items matching every active facet', () => {
  assert.deepEqual(ids(view.filterItems(ALERTS, panel({ tool: 'secret-scanning', reason: 'false_positive' }))), [1, 3]);
});

test('filterItems applies search text case-insensitively on top of facets', () => {
  assert.deepEqual(ids(view.filterItems(ALERTS, panel({ repo: 'acme/web' }, 'SLACK'))), [3]);
});

test('filterItems ignores filters on facets the panel does not define', () => {
  assert.deepEqual(ids(view.filterItems(ALERTS, panel({ unknown: 'x' }))), [1, 2, 3, 4, 5]);
});

test('breakdown counts honour other filters but not its own', () => {
  const { rows } = view.breakdown(ALERTS, panel({ tool: 'secret-scanning', reason: 'false_positive' }), 'reason');
  assert.deepEqual(rows.map((r) => [r.key, r.count]), [['false_positive', 2], ['used_in_tests', 1]]);
});

test('breakdown limits rows, reports the remainder, and keeps the active value visible', () => {
  const { rows, more } = view.breakdown(ALERTS, panel({ reason: 'tolerable_risk' }), 'reason', { limit: 1 });
  assert.deepEqual(rows.map((r) => r.key), ['false_positive', 'tolerable_risk']);
  assert.equal(more, 2);
});

test('view state round-trips through the URL hash', () => {
  const state = { win: 72, ghasWin: 14, filters: { ghas: { org: 'acme', tool: 'secret-scanning' }, jira: { status: 'In Progress' } }, queries: { jira: 'grant & revoke' }, focus: 'ghas' };
  assert.deepEqual(view.decodeState(view.encodeState(state)), state);
});

test('decodeState tolerates a leading #, bad numbers and keys without a panel', () => {
  assert.deepEqual(view.decodeState('#win=abc&nopanel=1&jira.status=Done'), { filters: { jira: { status: 'Done' } }, queries: {} });
});

test('toCsv quotes when needed and neutralises spreadsheet formulas in text', () => {
  const csv = view.toCsv([['Value', (r) => r]], ['=HYPERLINK("x")', '-5 items', -5, 42, 'a,b', 'say "hi"', null]);
  assert.equal(csv, ['Value', `"'=HYPERLINK(""x"")"`, "'-5 items", '-5', '42', '"a,b"', '"say ""hi"""', ''].join('\r\n'));
});
