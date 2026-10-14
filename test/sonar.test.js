'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const net = require('../src/http');
const sonar = require('../src/connectors/sonar');

// Fake SonarQube Cloud. `handler(pathname, params)` returns [status, body].
async function fakeSonar(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    const [status, body] = handler(u.pathname, u.searchParams) || [404, {}];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  net.configure({ timeoutSeconds: 5 });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
function cfgFor(url, sonarCfg = {}) {
  const cfg = config.load(path.join(os.tmpdir(), 'opspulse-no-config', 'config.json'));
  Object.assign(cfg.sonar, { url, ...sonarCfg });
  return cfg;
}
const total = (n) => [200, { paging: { pageIndex: 1, pageSize: 1, total: n }, components: [] }];

// Counts per organization keyed by query, as SonarQube Cloud reports them in paging.total.
function platform(pathname, q, counts) {
  if (pathname === '/api/authentication/validate') return [200, { valid: true }];
  if (pathname === '/api/user_tokens/search') return [200, { userTokens: [] }];
  const c = counts[q.get('organization')];
  if (!c) return null;
  if (pathname === '/api/projects/search' && q.get('onProvisionedOnly')) return total(c.never);
  if (pathname === '/api/projects/search' && q.get('analyzedBefore')) return total(c.stale);
  if (pathname === '/api/projects/search') return total(c.projects);
  if (pathname === '/api/components/search_projects') return c.gate === 'forbidden' ? [403, { errors: [{ msg: 'Insufficient privileges' }] }] : total(c.gate);
  return null;
}

test('reports platform-level counts per organization', async (t) => {
  const s = await fakeSonar(t, (p, q) => platform(p, q, { acme: { projects: 4182, stale: 611, never: 143, gate: 388 } }));
  const data = await sonar.collect(cfgFor(s.url, { organizations: ['acme'] }), { sonar: 'tok' });
  const o = data.orgs[0];
  assert.deepEqual([o.key, o.projects, o.stale, o.neverAnalyzed, o.failingGate], ['acme', { v: 4182 }, { v: 611 }, { v: 143 }, { v: 388 }]);
});

test('a count the token may not read shows as unavailable without failing the others', async (t) => {
  const s = await fakeSonar(t, (p, q) => platform(p, q, { acme: { projects: 10, stale: 1, never: 0, gate: 'forbidden' } }));
  const o = (await sonar.collect(cfgFor(s.url, { organizations: ['acme'] }), { sonar: 'tok' })).orgs[0];
  assert.deepEqual(o.projects, { v: 10 });
  assert.match(o.failingGate.err, /^403 .*Insufficient privileges/);
});

test('without configured organizations, every organization the token belongs to is discovered', async (t) => {
  const orgs = Array.from({ length: 230 }, (_, i) => ({ key: `org-${i + 1}` }));
  const counts = Object.fromEntries(orgs.map((o) => [o.key, { projects: 1, stale: 0, never: 0, gate: 0 }]));
  const s = await fakeSonar(t, (p, q) => {
    if (p === '/api/organizations/search') {
      const page = Number(q.get('p') || 1), size = Number(q.get('ps'));
      return [200, { organizations: orgs.slice((page - 1) * size, page * size), paging: { pageIndex: page, pageSize: size, total: orgs.length } }];
    }
    return platform(p, q, counts);
  });
  const data = await sonar.collect(cfgFor(s.url, { organizations: [] }), { sonar: 'tok' });
  assert.equal(data.orgs.length, 230);
  assert.equal(data.orgs.at(-1).key, 'org-230');
});

test('a rate limit fails the whole collection so it can be retried later', async (t) => {
  const s = await fakeSonar(t, (p) => (p === '/api/authentication/validate' ? [200, { valid: true }] : [429, {}]));
  net.configure({ timeoutSeconds: 5, now: () => Date.parse('2026-10-14T12:00:00Z') });
  await assert.rejects(sonar.collect(cfgFor(s.url, { organizations: ['acme'] }), { sonar: 'tok' }), (e) => e instanceof net.RateLimitError);
});

test('an invalid token is reported as such', async (t) => {
  const s = await fakeSonar(t, (p) => (p === '/api/authentication/validate' ? [200, { valid: false }] : null));
  await assert.rejects(sonar.collect(cfgFor(s.url, { organizations: ['acme'] }), { sonar: 'tok' }), /token is not valid/);
});
