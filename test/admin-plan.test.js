'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../src/admin/plan');

const brief = (rows, ...fields) => rows.map((r) => [r.project, ...fields.map((f) => r[f])]);

test('a new key keeps everything up to the first underscore, case and all, followed by the current name', () => {
  const rows = plan.planKeys([{ key: 'Acme-Corp_payments-api', name: 'payments-service' }]);
  assert.deepEqual(brief(rows, 'to', 'status'), [['Acme-Corp_payments-api', 'Acme-Corp_payments-service', 'change']]);
});

test('keys that already match their name are unchanged', () => {
  assert.deepEqual(brief(plan.planKeys([{ key: 'Acme_api', name: 'api' }]), 'status'), [['Acme_api', 'unchanged']]);
});

test('keys without an underscore are not a recognized format', () => {
  assert.deepEqual(brief(plan.planKeys([{ key: 'legacykey', name: 'api' }]), 'to', 'status'), [['legacykey', null, 'unrecognized']]);
});

test('a name that cannot be part of a key is reported', () => {
  assert.deepEqual(brief(plan.planKeys([{ key: 'Acme_api', name: 'Payments API' }]), 'status'), [['Acme_api', 'invalid']]);
});

test('a target key that exists, or that two projects would share, is a conflict', () => {
  const rows = plan.planKeys(
    [{ key: 'Acme_old-a', name: 'taken' }, { key: 'Acme_old-b', name: 'same' }, { key: 'Acme_old-c', name: 'same' }, { key: 'Acme_fine', name: 'renamed' }],
    { existingKeys: new Set(['Acme_taken']) },
  );
  assert.deepEqual(brief(rows, 'status'), [['Acme_old-a', 'conflict'], ['Acme_old-b', 'conflict'], ['Acme_old-c', 'conflict'], ['Acme_fine', 'change']]);
});

test('drift lists projects whose key no longer follows their name', () => {
  const rows = plan.findDrift([{ key: 'Acme_api', name: 'api' }, { key: 'Acme_web', name: 'portal' }, { key: 'legacy', name: 'x' }, { key: 'Acme_db', name: 'Data Base' }]);
  assert.deepEqual(brief(rows, 'status'), [['Acme_web', 'change'], ['Acme_db', 'invalid']]);
});

test('the branch pattern changes unless the project already uses it', () => {
  const rows = plan.planPattern(
    [{ key: 'Acme_a', name: 'a', pattern: '(branch|release)-.*', inherited: true }, { key: 'Acme_b', name: 'b', pattern: 'main|dev', inherited: false }],
    'main|dev',
  );
  assert.deepEqual(brief(rows, 'from', 'inherited', 'to', 'status'), [['Acme_a', '(branch|release)-.*', true, 'main|dev', 'change'], ['Acme_b', 'main|dev', false, 'main|dev', 'unchanged']]);
});

test('an invalid branch pattern is rejected before anything is planned', () => {
  assert.throws(() => plan.planPattern([], '(dev'), /invalid regular expression/);
});

test('a branch is deleted only where it exists and is not the main branch', () => {
  const rows = plan.planDelete([
    { key: 'Acme_a', name: 'a', branches: [{ name: 'main', isMain: true }, { name: 'dev', isMain: false, type: 'SHORT', analysisDate: '2026-10-01T00:00:00Z' }] },
    { key: 'Acme_b', name: 'b', branches: [{ name: 'main', isMain: true }] },
    { key: 'Acme_c', name: 'c', branches: [{ name: 'dev', isMain: true }] },
  ], 'dev');
  assert.deepEqual(brief(rows, 'status', 'type'), [['Acme_a', 'delete', 'SHORT'], ['Acme_b', 'missing', null], ['Acme_c', 'main', null]]);
});

test('making a branch long-lived sets the pattern and deletes the branch only if it is short-lived', () => {
  const rows = plan.planLongLived([
    { key: 'Acme_a', name: 'a', pattern: '(branch|release)-.*', inherited: true, branches: [{ name: 'dev', isMain: false, type: 'SHORT' }] },
    { key: 'Acme_b', name: 'b', pattern: 'main|dev', inherited: false, branches: [{ name: 'dev', isMain: false, type: 'LONG' }] },
    { key: 'Acme_c', name: 'c', pattern: '(branch|release)-.*', inherited: true, branches: [] },
    { key: 'Acme_d', name: 'd', pattern: 'x', inherited: false, branches: [{ name: 'dev', isMain: true }] },
  ], 'main|dev', 'dev');
  assert.deepEqual(brief(rows, 'setPattern', 'deleteBranch', 'status'), [
    ['Acme_a', true, true, 'change'],
    ['Acme_b', false, false, 'unchanged'],
    ['Acme_c', true, false, 'change'],
    ['Acme_d', false, false, 'main'],
  ]);
});

test('a pattern that does not match the branch would not make it long-lived', () => {
  assert.throws(() => plan.planLongLived([], 'release-.*', 'dev'), /pattern does not match "dev"/);
});

test('only rows that would change are actionable', () => {
  const rows = plan.planDelete([{ key: 'Acme_a', name: 'a', branches: [{ name: 'dev', isMain: false, type: 'SHORT' }] }, { key: 'Acme_b', name: 'b', branches: [] }], 'dev');
  assert.deepEqual(rows.map((r) => r.actionable), [true, false]);
});
