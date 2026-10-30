'use strict';
// Live tests against a real SonarQube Cloud test organization: `npm run test:live`.
//
// They pin down how the real service behaves, which the fake SonarQube in test/admin-sonar.test.js
// copies, and run the admin tools end to end. They create throwaway projects (keys containing
// "opl-<run id>") and delete them afterwards; nothing else in the organization is changed.
//
// Settings, from .env or the environment:
//   SONAR_TEST_TOKEN  token for the test organization (required; the tests are skipped without it)
//   SONAR_TEST_URL    default https://sonarcloud.io (US region: https://sonarqube.us)
//   SONAR_TEST_ORG    default: the token's only organization, which must be on the free plan
// Never use a work token: these tests create and delete projects.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadDotEnv } = require('../src/config');
const { request } = require('../src/http');
const { createSonarAdmin, apiUrlFor } = require('../src/admin/sonar');

loadDotEnv(path.join(__dirname, '..', '.env'));
const token = process.env.SONAR_TEST_TOKEN;
const V1 = (process.env.SONAR_TEST_URL || 'https://sonarcloud.io').replace(/\/$/, '');
const V2 = token ? apiUrlFor(V1) : '';
const headers = { Authorization: `Bearer ${token}` };
const run = Date.now().toString(36);

const get = async (url) => (await request(url, { headers, platform: 'sonar-live' })).data;
const post = (pathname, form) => request(`${V1}${pathname}`, {
  method: 'POST', platform: 'sonar-live', retries: 0,
  headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(form).toString(),
});
const status = (p) => p.then((r) => r.status, (e) => e.status || e.message);
// Retries an assertion for a while; SonarQube Cloud's search indexes can lag behind a change.
async function eventually(check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

describe('SonarQube Cloud (live)', { skip: !token && 'SONAR_TEST_TOKEN is not set' }, () => {
  let org, orgUuid, orgLegacyId, pre, admin;
  const audits = [];
  const keys = {};
  const created = new Set();

  before(async () => {
    const { organizations } = await get(`${V1}/api/organizations/search?member=true`);
    const chosen = process.env.SONAR_TEST_ORG ? organizations.find((o) => o.key === process.env.SONAR_TEST_ORG) : organizations.length === 1 ? organizations[0] : null;
    assert.ok(chosen, `set SONAR_TEST_ORG to one of: ${organizations.map((o) => o.key).join(', ')}`);
    if (!process.env.SONAR_TEST_ORG) assert.equal(chosen.subscription, 'FREE', `"${chosen.key}" is not on the free plan; set SONAR_TEST_ORG if it really is a test organization`);
    org = chosen.key;
    pre = `${org}_`;
    [{ uuidV4: orgUuid, id: orgLegacyId }] = await get(`${V2}/organizations/organizations?organizationKey=${org}`);

    const id = `opl-${run}`;
    Object.assign(keys, {
      renamed: { key: `${pre}${id}-old`, name: `${id}-renamed` }, // drift: key follows the old name
      admin: { key: `${pre}${id}-y`, name: `${id}-admin-portal` }, // drift, and the new key contains "admin"
      scanner: { key: `${pre}${id}-scanner`, name: `${pre}${id}-scanner` }, // named after its key: not drift
      clash: { key: `${pre}${id}-clash-src`, name: `${id}-clash` }, // drift onto a key that is taken
      taken: { key: `${pre}${id}-clash`, name: `${id}-clash` }, // holds that key; not drift itself
    });
    for (const p of Object.values(keys)) {
      await post('/api/projects/create', { organization: org, project: p.key, name: p.name });
      created.add(p.key);
    }
    admin = createSonarAdmin({
      sonarUrl: V1, token, actor: 'opspulse-live-test', concurrency: 3, platform: 'sonar-live',
      log: { audit: (event, fields) => audits.push({ event, ...fields }), info() {}, warn() {}, error() {} },
    });
  });

  after(async () => {
    // Every key a project of this run may have now, original or renamed.
    const all = new Set([...created, `${pre}opl-${run}-renamed`, `${pre}opl-${run}-admin-portal`]);
    for (const key of all) await status(post('/api/projects/delete', { project: key }));
  });

  const mine = (rows) => rows.filter((r) => r.project.includes(`opl-${run}`));
  const brief = (rows, ...f) => mine(rows).map((r) => [r.project.slice(pre.length), ...f.map((k) => (typeof r[k] === 'string' ? r[k].replace(pre, '') : r[k]))]);

  describe('service behaviour the fake copies', () => {
    test('responses carry the fields opspulse reads', async () => {
      const orgs = await get(`${V2}/organizations/organizations?organizationKey=${org}`);
      assert.match(orgs[0].uuidV4, /^[0-9a-f-]{36}$/);
      const d = await get(`${V2}/projects/projects?organizationIds=${orgUuid}&keys=${keys.renamed.key}&pageSize=10`);
      assert.deepEqual([d.projects[0].key, d.projects[0].name, typeof d.page.total], [keys.renamed.key, keys.renamed.name, 'number']);
      const s = await get(`${V1}/api/settings/values?component=${keys.renamed.key}&keys=sonar.branch.longLivedBranches.regex`);
      assert.equal(typeof s.settings[0].value, 'string');
      const b = await get(`${V1}/api/project_branches/list?project=${keys.renamed.key}`);
      assert.deepEqual([b.branches[0].isMain, b.branches[0].type], [true, 'LONG']);
    });

    test('a list parameter is comma-separated; a repeated one keeps only its last value', async () => {
      const found = async (qs) => (await get(`${V2}/projects/projects?${qs}&pageSize=10`)).projects.map((p) => p.key).sort();
      await eventually(async () => assert.deepEqual(await found(`keys=${keys.renamed.key},${keys.taken.key}`), [keys.renamed.key, keys.taken.key].sort()));
      assert.deepEqual(await found(`keys=${keys.renamed.key}&keys=${keys.taken.key}`), [keys.taken.key]);
    });

    test('repository bindings are listed by the legacy organization id, 50 per page, joined on legacyId', async () => {
      const B = `${V2}/dop-translation/project-bindings`;
      const d = await get(`${B}?organizationId=${orgLegacyId}&pageSize=50&pageIndex=1`);
      assert.equal(typeof d.page.total, 'number');
      await assert.rejects(get(`${B}?organizationId=${orgLegacyId}&pageSize=51`), (e) => e.status === 400);
      await assert.rejects(get(`${B}?organizationId=${orgUuid}`), (e) => e.status === 404);
      if (!d.bindings.length) return; // nothing bound in the test organization: shape not checkable
      const b = d.bindings[0];
      assert.deepEqual([typeof b.projectId, typeof b.slug, typeof b.url], ['string', 'string', 'string']);
      const all = (await get(`${V2}/projects/projects?organizationIds=${orgUuid}&pageSize=5000`)).projects;
      assert.ok(all.some((p) => p.legacyId === b.projectId), 'the binding projectId matches a project legacyId');
    });

    test('CloudFront refuses API paths containing the word "admin"', async () => {
      await assert.rejects(get(`${V2}/projects/project-keys/${pre}opl-${run}-admin-x`), (e) => e.status === 403 && /text\/html/.test(e.message));
      await assert.rejects(get(`${V2}/projects/project-keys/${pre}opl-${run}-administration`), (e) => e.status === 404);
    });
  });

  describe('admin tools end to end', () => {
    test('drift finds renamed projects, including a new key with "admin", and skips scanner-named ones', async () => {
      const { rows } = await eventually(async () => {
        const r = await admin.preview('drift', { org });
        assert.equal(mine(r.rows).length, 3);
        return r;
      });
      assert.ok(mine(rows).every((r) => r.source === 'name' && r.review), 'projects created through the API are not bound');
      assert.deepEqual(brief(rows, 'to', 'status').sort(), [
        [`opl-${run}-clash-src`, `opl-${run}-clash`, 'conflict'],
        [`opl-${run}-old`, `opl-${run}-renamed`, 'change'],
        [`opl-${run}-y`, `opl-${run}-admin-portal`, 'change'],
      ]);
    });

    test('keys from a list are previewed, applied, and audited', async () => {
      const list = [keys.renamed.key, keys.admin.key, keys.scanner.key, `${pre}opl-${run}-missing`];
      const { rows } = await admin.preview('keys', { org, keys: list });
      assert.deepEqual(brief(rows, 'status'), [[`opl-${run}-old`, 'change'], [`opl-${run}-y`, 'change'], [`opl-${run}-scanner`, 'unchanged'], [`opl-${run}-missing`, 'not-found']]);

      const done = await admin.apply('keys', rows, { selected: [keys.renamed.key, keys.admin.key], run });
      assert.deepEqual(brief(done, 'result', 'error').slice(0, 2), [[`opl-${run}-old`, 'done', null], [`opl-${run}-y`, 'done', null]]);
      for (const k of [keys.renamed.key, keys.admin.key]) created.delete(k);
      await eventually(async () => {
        const now = (await get(`${V2}/projects/projects?organizationIds=${orgUuid}&keys=${pre}opl-${run}-renamed,${pre}opl-${run}-admin-portal,${keys.renamed.key}&pageSize=10`)).projects.map((p) => p.key).sort();
        assert.deepEqual(now, [`${pre}opl-${run}-admin-portal`, `${pre}opl-${run}-renamed`]);
      });
      assert.deepEqual(audits.filter((a) => a.run === run).map((a) => [a.event, a.result]), [['sonar.key_updated', 'done'], ['sonar.key_updated', 'done']]);
    });

    test('the branch pattern is set and reads back', async () => {
      const { rows } = await admin.preview('pattern', { org, keys: [keys.scanner.key], pattern: 'main|dev|release-.*' });
      assert.deepEqual(brief(rows, 'status'), [[`opl-${run}-scanner`, 'change']]);
      const done = await admin.apply('pattern', rows, { selected: [keys.scanner.key] });
      assert.equal(done[0].result, 'done');
      const s = await get(`${V1}/api/settings/values?component=${keys.scanner.key}&keys=sonar.branch.longLivedBranches.regex`);
      assert.equal(s.settings[0].value, 'main|dev|release-.*');
    });

    test('branch deletion never touches the main branch and reports missing branches', async () => {
      const main = await admin.preview('delete', { org, keys: [keys.taken.key], branch: 'master' });
      assert.deepEqual(brief(main.rows, 'status', 'actionable'), [[`opl-${run}-clash`, 'main', false]]);
      const missing = await admin.preview('delete', { org, keys: [keys.taken.key], branch: 'dev' });
      assert.deepEqual(brief(missing.rows, 'status'), [[`opl-${run}-clash`, 'missing']]);
    });
  });
});
