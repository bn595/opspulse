'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStorage } = require('../src/storage');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opspulse-storage-'));
function recorder() {
  const events = [];
  return { events, log: { warn: (event, fields) => events.push([event, fields]), info: () => {}, error: () => {}, audit: () => {} } };
}
// A module backend written to disk, as a user would.
function moduleBackend(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), `module.exports = { createStorage: ${body} };`);
  return { type: 'module', path: `./${name}` };
}
const MEMORY = `(options) => { const m = new Map(); return { name: options.label, get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }; }`;
const BROKEN = `() => ({ get: async () => { throw new Error('blob unreachable'); }, set: async () => { throw new Error('blob unreachable'); }, delete: async () => { throw new Error('blob unreachable'); } })`;

test('the file backend keeps documents across restarts', async () => {
  const dir = tmp();
  await createStorage([{ type: 'file', dir: '.cache' }], { baseDir: dir }).set('acks', { a: 1 });
  assert.deepEqual(await createStorage([{ type: 'file', dir: '.cache' }], { baseDir: dir }).get('acks'), { a: 1 });
});

test('with no backends nothing is stored', async () => {
  const s = createStorage([], { baseDir: tmp() });
  await s.set('acks', { a: 1 });
  assert.equal(await s.get('acks'), null);
});

test('writes go to every backend and reads come from the first that has the document', async () => {
  const dir = tmp();
  const s = createStorage([moduleBackend(dir, 'mem.js', MEMORY), { type: 'file', dir: 'state' }], { baseDir: dir });
  await s.set('snapshot', { v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'snapshot.json'), 'utf8')), { v: 1 });

  const fresh = createStorage([moduleBackend(dir, 'mem2.js', MEMORY), { type: 'file', dir: 'state' }], { baseDir: dir });
  assert.deepEqual(await fresh.get('snapshot'), { v: 1 }, 'falls back to the second backend when the first is empty');
});

test('a failing backend is logged and does not stop the others', async () => {
  const dir = tmp();
  const { events, log } = recorder();
  const s = createStorage([moduleBackend(dir, 'broken.js', BROKEN), { type: 'file', dir: 'state' }], { baseDir: dir, log });
  await s.set('acks', { a: 1 });
  assert.deepEqual(await s.get('acks'), { a: 1 });
  assert.deepEqual(events.map(([e, f]) => [e, f.backend, f.key, f.error]), [
    ['storage.write_failed', 'module ./broken.js', 'acks', 'blob unreachable'],
    ['storage.read_failed', 'module ./broken.js', 'acks', 'blob unreachable'],
  ]);
});

test('module backends receive their options', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'opts.js'), 'module.exports = { createStorage: (o) => ({ get: async () => o, set: async () => {}, delete: async () => {} }) };');
  const s = createStorage([{ type: 'module', path: './opts.js', container: 'opspulse', account: 'acct' }], { baseDir: dir });
  assert.deepEqual(await s.get('anything'), { container: 'opspulse', account: 'acct', baseDir: dir });
});

test('delete removes a document from every backend', async () => {
  const dir = tmp();
  const s = createStorage([{ type: 'file', dir: 'a' }, { type: 'file', dir: 'b' }], { baseDir: dir });
  await s.set('acks', { a: 1 });
  await s.delete('acks');
  assert.deepEqual([fs.existsSync(path.join(dir, 'a', 'acks.json')), fs.existsSync(path.join(dir, 'b', 'acks.json'))], [false, false]);
});

test('check() round-trips a document through each backend', async () => {
  const dir = tmp();
  const s = createStorage([{ type: 'file', dir: 'state' }, moduleBackend(dir, 'broken.js', BROKEN)], { baseDir: dir, log: recorder().log });
  assert.deepEqual(await s.check(), [
    { backend: 'file state', ok: true, error: null },
    { backend: 'module ./broken.js', ok: false, error: 'blob unreachable' },
  ]);
});

test('configuration mistakes are reported with the entry at fault', () => {
  assert.throws(() => createStorage([{ type: 'nosql' }], { baseDir: tmp() }), /storage\.backends\[0\]: unknown type "nosql" \(use file or module\)/);
  assert.throws(() => createStorage([{ type: 'module', path: './missing.js' }], { baseDir: tmp() }), /storage\.backends\[0\]: cannot load .*missing\.js/);
});

test('document keys are limited to safe names', async () => {
  await assert.rejects(createStorage([{ type: 'file', dir: 'state' }], { baseDir: tmp() }).set('../escape', {}), /invalid storage key/);
});
