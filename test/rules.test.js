'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/rules');

const ITEMS = [
  { id: 1, tool: 'secret-scanning', by: 'secret-bot[bot]', repo: 'acme/api', raw: { secret_type: 'github_personal_access_token' } },
  { id: 2, tool: 'code-scanning', by: 'jdoe', repo: 'acme/web', labels: [] },
  { id: 3, tool: 'secret-scanning', by: 'mlee', repo: 'acme-labs/tools', labels: ['ops'], raw: { secret_type: 'custom_pattern_42' } },
];
const keep = (section) => {
  const pred = rules.compile(section, 'test');
  return ITEMS.filter((i) => !pred || pred(i)).map((i) => i.id);
};

test('no rules means no predicate', () => {
  assert.equal(rules.compile({}, 'test'), null);
});

test('exclude drops matching items using * wildcards', () => {
  assert.deepEqual(keep({ exclude: [{ by: '*[bot]' }] }), [2, 3]);
});

test('every field in a rule must match', () => {
  assert.deepEqual(keep({ include: [{ tool: 'secret-scanning', repo: 'acme/*' }] }), [1]);
});

test('text matching is case-insensitive', () => {
  assert.deepEqual(keep({ include: [{ tool: 'CODE-SCANNING' }] }), [2]);
});

test('raw API fields are reachable by dotted path and /regex/', () => {
  assert.deepEqual(keep({ include: [{ 'raw.secret_type': '/^custom_pattern_/' }] }), [3]);
});

test('a list matcher accepts any of its values', () => {
  assert.deepEqual(keep({ include: [{ by: ['jdoe', 'mlee'] }] }), [2, 3]);
});

test('array fields match when any element matches', () => {
  assert.deepEqual(keep({ include: [{ labels: 'ops' }] }), [3]);
});

test('null matches missing or empty values', () => {
  assert.deepEqual(keep({ include: [{ labels: null }] }), [1, 2]);
});

test('include and exclude combine', () => {
  assert.deepEqual(keep({ include: [{ tool: 'secret-scanning' }], exclude: [{ by: '*[bot]' }] }), [3]);
});

test('an invalid regular expression names the offending rule', () => {
  assert.throws(() => rules.compile({ exclude: [{ by: '/[/' }] }, 'github.dismissals'), /github\.dismissals\.exclude\[0\]\.by: invalid regular expression/);
});

test('rules must be a list', () => {
  assert.throws(() => rules.compile({ exclude: { by: 'x' } }, 'jira'), /jira\.exclude must be a list of rules/);
});
