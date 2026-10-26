'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('../src/http');
const { createSonarAdmin } = require('../src/admin/sonar');

const T0 = Date.parse('2026-10-26T12:00:00Z');
const PATTERN = 'sonar.branch.longLivedBranches.regex';

// Fake SonarQube Cloud with mutable state. Pages hold `pageSize` projects. `delayMs` keeps POSTs in
// flight long enough to measure concurrency; `limitOnce` makes the first matching POST return 429.
async function fakeSonar(t, { projects, branches = {}, patterns = {}, pageSize = 500, delayMs = 0, limitOnce = null, failKeys = [], omitTotal = false }) {
  const state = { projects: projects.map((p) => ({ ...p })), branches: structuredClone(branches), patterns: { ...patterns }, posts: [], inFlight: 0, maxInFlight: 0, limited: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const q = req.method === 'POST' ? new URLSearchParams(body) : u.searchParams;
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'GET') {
        // Web API v2 reads. v1 project search is deliberately absent: the admin tools must not use it.
        if (u.pathname === '/organizations/organizations') {
          const key = q.get('organizationKey');
          return send(200, state.projects.some((p) => p.org === key) ? [{ key, id: `legacy-${key}`, uuidV4: `uuid-${key}` }] : []);
        }
        if (u.pathname === '/projects/projects') {
          const orgs = q.getAll('organizationIds').map((id) => id.replace(/^uuid-/, ''));
          const keys = q.getAll('keys');
          let list = state.projects.filter((p) => !orgs.length || orgs.includes(p.org));
          if (keys.length) list = list.filter((p) => keys.includes(p.key));
          const size = Math.min(Number(q.get('pageSize') || 50), pageSize), page = Number(q.get('pageIndex') || 1);
          state.v2PageSizes = [...(state.v2PageSizes || []), Number(q.get('pageSize'))];
          return send(200, { projects: list.slice((page - 1) * size, page * size).map((p) => ({ key: p.key, name: p.name, organizationId: `uuid-${p.org}` })), page: omitTotal ? { pageIndex: page, pageSize: size } : { pageIndex: page, pageSize: size, total: list.length } });
        }
        if (u.pathname.startsWith('/projects/project-keys/')) {
          const key = decodeURIComponent(u.pathname.slice('/projects/project-keys/'.length));
          return state.projects.some((p) => p.key === key) ? send(200, { key }) : send(404, { message: 'Not Found' });
        }
        if (u.pathname === '/api/settings/values') {
          const own = state.patterns[q.get('component')];
          return send(200, { settings: [{ key: PATTERN, value: own ?? '(branch|release)-.*', inherited: own == null }] });
        }
        if (u.pathname === '/api/project_branches/list') return send(200, { branches: state.branches[q.get('project')] || [{ name: 'main', isMain: true, type: 'LONG' }] });
        return send(404, {});
      }
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      setTimeout(() => {
        state.inFlight--;
        const params = Object.fromEntries(q);
        if (limitOnce && !state.limited && u.pathname === limitOnce) { state.limited = true; return send(429, {}); }
        state.posts.push([u.pathname, params]);
        if (failKeys.includes(params.from || params.component || params.project)) return send(403, { errors: [{ msg: 'Insufficient privileges' }] });
        if (u.pathname === '/api/projects/update_key') { state.projects.find((p) => p.key === params.from).key = params.to; return send(204, ''); }
        if (u.pathname === '/api/settings/set') { state.patterns[params.component] = params.value; return send(204, ''); }
        if (u.pathname === '/api/project_branches/delete') { state.branches[params.project] = state.branches[params.project].filter((b) => b.name !== params.branch); return send(204, ''); }
        send(404, {});
      }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

let platforms = 0; // a distinct rate-limit platform per test, so one test's block can't leak into the next
function adminFor(url, extra = {}) {
  const audits = [];
  const clock = { now: T0 };
  net.configure({ timeoutSeconds: 5, now: () => clock.now });
  const admin = createSonarAdmin({
    sonarUrl: url, apiUrl: url, token: 'tok', actor: 'ann@contoso.com', concurrency: 5, platform: `sonar-admin-${++platforms}`,
    log: { audit: (event, fields) => audits.push({ event, ...fields }), info() {}, warn() {}, error() {} },
    now: () => clock.now, wait: async (ms) => { clock.now += ms; },
    ...extra,
  });
  return { admin, audits, clock };
}
const project = (org, key, name) => ({ org, key, name });
const brief = (rows, ...f) => rows.map((r) => [r.project, ...f.map((k) => r[k])]);

test('a key preview selects projects by name prefix across pages and flags existing target keys', async (t) => {
  const s = await fakeSonar(t, { pageSize: 2, projects: [
    project('acme', 'Acme_pay-old', 'pay-api'), project('acme', 'Acme_pay-web', 'pay-web'), project('acme', 'Acme_pay-x', 'pay-api2'),
    project('acme', 'Acme_pay-api2', 'other'), project('acme', 'Acme_docs', 'docs'),
  ] });
  const { admin } = adminFor(s.url);
  const { rows } = await admin.preview('keys', { org: 'acme', prefix: 'pay' });
  assert.deepEqual(brief(rows, 'to', 'status'), [['Acme_pay-old', 'Acme_pay-api', 'change'], ['Acme_pay-web', 'Acme_pay-web', 'unchanged'], ['Acme_pay-x', 'Acme_pay-api2', 'conflict']]);
});

test('a key preview can take an explicit list of projects', async (t) => {
  const s = await fakeSonar(t, { projects: [project('acme', 'Acme_a', 'renamed-a'), project('acme', 'Acme_b', 'b'), project('acme', 'Acme_c', 'c')] });
  const { rows } = await adminFor(s.url).admin.preview('keys', { org: 'acme', keys: ['Acme_a', 'Acme_c', 'Acme_missing'] });
  assert.deepEqual(brief(rows, 'status'), [['Acme_a', 'change'], ['Acme_c', 'unchanged'], ['Acme_missing', 'not-found']]);
});

test('drift is found across the whole organization', async (t) => {
  const s = await fakeSonar(t, { projects: [project('acme', 'Acme_a', 'a'), project('acme', 'Acme_old', 'new'), project('labs', 'Labs_x', 'y')] });
  const { rows } = await adminFor(s.url).admin.preview('drift', { org: 'acme' });
  assert.deepEqual(brief(rows, 'to'), [['Acme_old', 'Acme_new']]);
});

test('pattern and branch previews read each project settings and branches', async (t) => {
  const s = await fakeSonar(t, {
    projects: [project('acme', 'Acme_a', 'a'), project('acme', 'Acme_b', 'b')],
    patterns: { Acme_b: 'main|dev' },
    branches: { Acme_a: [{ name: 'main', isMain: true, type: 'LONG' }, { name: 'dev', isMain: false, type: 'SHORT' }] },
  });
  const { admin } = adminFor(s.url);
  const pattern = await admin.preview('pattern', { org: 'acme', keys: ['Acme_a', 'Acme_b'], pattern: 'main|dev' });
  assert.deepEqual(brief(pattern.rows, 'from', 'inherited', 'status'), [['Acme_a', '(branch|release)-.*', true, 'change'], ['Acme_b', 'main|dev', false, 'unchanged']]);
  const del = await admin.preview('delete', { org: 'acme', keys: ['Acme_a', 'Acme_b'], branch: 'dev' });
  assert.deepEqual(brief(del.rows, 'status'), [['Acme_a', 'delete'], ['Acme_b', 'missing']]);
});

test('apply changes only selected actionable rows, reports each with a link, and audits every change', async (t) => {
  const s = await fakeSonar(t, { projects: [project('acme', 'Acme_old-a', 'a'), project('acme', 'Acme_old-b', 'b'), project('acme', 'Acme_c', 'c')] });
  const { admin, audits } = adminFor(s.url);
  const { rows } = await admin.preview('keys', { org: 'acme', prefix: '' });
  const done = await admin.apply('keys', rows, { selected: ['Acme_old-a', 'Acme_c'], run: 'run-1' });

  assert.deepEqual(brief(done, 'result', 'url'), [
    ['Acme_old-a', 'done', `${s.url}/project/overview?id=Acme_a`],
    ['Acme_old-b', null, `${s.url}/project/overview?id=Acme_old-b`],
    ['Acme_c', null, `${s.url}/project/overview?id=Acme_c`],
  ]);
  assert.deepEqual(s.state.posts, [['/api/projects/update_key', { from: 'Acme_old-a', to: 'Acme_a' }]]);
  assert.deepEqual(audits, [{ event: 'sonar.key_updated', run: 'run-1', actor: 'ann@contoso.com', org: 'acme', project: 'Acme_old-a', from: 'Acme_old-a', to: 'Acme_a', result: 'done' }]);
});

test('a failing row is reported and audited without stopping the others', async (t) => {
  const s = await fakeSonar(t, { projects: [project('acme', 'Acme_a', 'a2'), project('acme', 'Acme_b', 'b2')], failKeys: ['Acme_a'] });
  const { admin, audits } = adminFor(s.url);
  const { rows } = await admin.preview('keys', { org: 'acme', prefix: '' });
  const done = await admin.apply('keys', rows, { selected: ['Acme_a', 'Acme_b'] });
  assert.deepEqual(brief(done, 'result'), [['Acme_a', 'failed'], ['Acme_b', 'done']]);
  assert.match(done[0].error, /^403 .*Insufficient privileges/);
  assert.deepEqual(audits.map((a) => [a.project, a.result]), [['Acme_a', 'failed'], ['Acme_b', 'done']]);
});

test('no more than the configured number of changes run at once', async (t) => {
  const keys = Array.from({ length: 12 }, (_, i) => `Acme_p${i}`);
  const s = await fakeSonar(t, { delayMs: 30, projects: keys.map((k) => project('acme', k, `${k.slice(5)}-new`)) });
  const { admin } = adminFor(s.url, { concurrency: 3 });
  const { rows } = await admin.preview('keys', { org: 'acme', prefix: '' });
  const done = await admin.apply('keys', rows, { selected: keys });
  assert.equal(done.filter((r) => r.result === 'done').length, 12);
  assert.equal(s.state.maxInFlight, 3);
});

test('a rate limit mid-run waits for the block, slows down, and finishes every row', async (t) => {
  const keys = Array.from({ length: 8 }, (_, i) => `Acme_p${i}`);
  const s = await fakeSonar(t, { delayMs: 10, limitOnce: '/api/projects/update_key', projects: keys.map((k) => project('acme', k, `${k.slice(5)}-new`)) });
  const pauses = [];
  const { admin, clock } = adminFor(s.url, { concurrency: 4 });
  const { rows } = await admin.preview('keys', { org: 'acme', prefix: '' });
  const done = await admin.apply('keys', rows, { selected: keys, onProgress: (p) => { if (p.waitingUntil) pauses.push([p.waitingUntil, p.concurrency]); } });

  assert.equal(done.filter((r) => r.result === 'done').length, 8);
  assert.deepEqual(pauses[0], [T0 + 2 * 60e3, 2]);
  assert.ok(clock.now >= T0 + 2 * 60e3, 'waited for the block to end');
});

test('making a branch long-lived sets the pattern before deleting the short-lived branch', async (t) => {
  const s = await fakeSonar(t, {
    projects: [project('acme', 'Acme_a', 'a')],
    branches: { Acme_a: [{ name: 'main', isMain: true, type: 'LONG' }, { name: 'dev', isMain: false, type: 'SHORT', analysisDate: '2026-10-01T00:00:00Z' }] },
  });
  const { admin, audits } = adminFor(s.url);
  const { rows } = await admin.preview('longlived', { org: 'acme', keys: ['Acme_a'], pattern: 'main|dev', branch: 'dev' });
  await admin.apply('longlived', rows, { selected: ['Acme_a'] });
  assert.deepEqual(s.state.posts, [
    ['/api/settings/set', { component: 'Acme_a', key: PATTERN, value: 'main|dev' }],
    ['/api/project_branches/delete', { project: 'Acme_a', branch: 'dev' }],
  ]);
  assert.deepEqual(audits.map((a) => a.event), ['sonar.branch_pattern_set', 'sonar.branch_deleted']);
  assert.deepEqual([audits[1].type, audits[1].analysisDate], ['SHORT', '2026-10-01T00:00:00Z'], 'what was deleted is on record');
});

test('a row retried after a rate limit does not repeat steps that already succeeded', async (t) => {
  const s = await fakeSonar(t, {
    limitOnce: '/api/project_branches/delete',
    projects: [project('acme', 'Acme_a', 'a')],
    branches: { Acme_a: [{ name: 'main', isMain: true, type: 'LONG' }, { name: 'dev', isMain: false, type: 'SHORT' }] },
  });
  const { admin, audits } = adminFor(s.url);
  const { rows } = await admin.preview('longlived', { org: 'acme', keys: ['Acme_a'], pattern: 'main|dev', branch: 'dev' });
  const done = await admin.apply('longlived', rows, { selected: ['Acme_a'] });
  assert.equal(done[0].result, 'done');
  assert.deepEqual(s.state.posts.map(([p]) => p), ['/api/settings/set', '/api/project_branches/delete']);
  assert.deepEqual(audits.map((a) => a.event), ['sonar.branch_pattern_set', 'sonar.branch_deleted']);
});

test('project listing continues when the response gives no total', async (t) => {
  const s = await fakeSonar(t, { pageSize: 2, omitTotal: true, projects: ['a', 'b', 'c', 'd', 'e'].map((k) => project('acme', `Acme_${k}`, `${k}-new`)) });
  const { rows } = await adminFor(s.url).admin.preview('drift', { org: 'acme' });
  assert.equal(rows.length, 5);
});

test('project listing uses Web API v2 with large pages', async (t) => {
  const s = await fakeSonar(t, { projects: [project('acme', 'Acme_a', 'a'), project('acme', 'Acme_b', 'b')] });
  await adminFor(s.url).admin.preview('drift', { org: 'acme' });
  assert.deepEqual(s.state.v2PageSizes, [5000]);
});

test('a target key taken in another organization is a conflict', async (t) => {
  const s = await fakeSonar(t, { projects: [project('acme', 'Acme_old', 'shared'), project('labs', 'Acme_shared', 'other')] });
  const { rows } = await adminFor(s.url).admin.preview('keys', { org: 'acme', prefix: '' });
  assert.deepEqual(brief(rows, 'to', 'status'), [['Acme_old', 'Acme_shared', 'conflict']]);
});

test('an unknown organization is reported clearly', async (t) => {
  const s = await fakeSonar(t, { projects: [project('acme', 'Acme_a', 'a')] });
  await assert.rejects(adminFor(s.url).admin.preview('drift', { org: 'nope' }), /organization "nope" was not found or is not visible to this token/);
});
