'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../src/admin/plan');

const brief = (rows, ...fields) => rows.map((r) => [r.project, ...fields.map((f) => r[f])]);

test('a new key keeps everything up to the first underscore, case and all, followed by the current name', () => {
  const rows = plan.planKeys([{ key: 'Acme-Corp_payments-api', name: 'payments-service' }]);
  assert.deepEqual(brief(rows, 'to', 'status'), [['Acme-Corp_payments-api', 'Acme-Corp_payments-service', 'change']]);
});

test('a name that already carries the key prefix is not prefixed twice', () => {
  const rows = plan.planKeys([{ key: 'Acme-Corp_old', name: 'Acme-Corp_new' }, { key: 'Acme-Corp_old2', name: 'acme-corp_new2' }]);
  assert.deepEqual(brief(rows, 'to', 'status'), [['Acme-Corp_old', 'Acme-Corp_new', 'change'], ['Acme-Corp_old2', 'Acme-Corp_new2', 'change']]);
});

test('a project named after its own key (the scanner default) is not drift', () => {
  assert.deepEqual(plan.findDrift([{ key: 'Acme-Corp_payments-api', name: 'Acme-Corp_payments-api' }]), []);
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
  const rows = plan.findDrift([{ key: 'Acme_api', name: 'api' }, { key: 'Acme_web', name: 'portal' }, { key: 'Acme_db', name: 'Data Base' }]);
  assert.deepEqual(brief(rows, 'status'), [['Acme_web', 'change'], ['Acme_db', 'invalid']]);
});

test('drift also lists keys in an unrecognized format whose name differs, for manual follow-up', () => {
  const rows = plan.findDrift([{ key: 'legacyreports', name: 'reports' }, { key: 'reports2', name: 'reports2' }]);
  assert.deepEqual(brief(rows, 'status', 'actionable'), [['legacyreports', 'unrecognized', false]]);
});

// Projects with `repo`: the repository they are bound to ({ name, url }), or null when unbound.
const repo = (name) => ({ name, url: `https://github.com/Acme/${name}` });

test('the new key follows the bound repository, not the project name', () => {
  const rows = plan.planKeys([
    { key: 'Acme_old', name: 'whatever-ui', repo: repo('payments') },
    { key: 'Acme_payments2', name: 'Payments 2 (legacy)', repo: repo('payments2') },
  ]);
  assert.deepEqual(brief(rows, 'to', 'status', 'source', 'repo'), [
    ['Acme_old', 'Acme_payments', 'change', 'repo', 'payments'],
    ['Acme_payments2', 'Acme_payments2', 'unchanged', 'repo', 'payments2'],
  ]);
});

test('a key that matches its repository is not drift, whatever the project is named', () => {
  assert.deepEqual(plan.findDrift([{ key: 'Acme_payments', name: 'payments-ui', repo: repo('payments') }]), []);
});

test('without a binding the project name is used, and the row is marked for review', () => {
  const rows = plan.planKeys([{ key: 'Acme_old', name: 'new', repo: null }, { key: 'Acme_x', name: 'y', repo: repo('z') }]);
  assert.deepEqual(brief(rows, 'to', 'source', 'review', 'actionable'), [['Acme_old', 'Acme_new', 'name', true, true], ['Acme_x', 'Acme_z', 'repo', false, true]]);
});

test('a branch pattern is required', () => {
  const p = [{ key: 'Acme_a', name: 'a', pattern: 'x', branches: [] }];
  for (const pattern of ['', '  ', undefined, null]) {
    assert.throws(() => plan.planPattern(p, pattern), /pattern is required/);
    assert.throws(() => plan.planLongLived(p, pattern, 'dev'), /pattern is required/);
  }
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
