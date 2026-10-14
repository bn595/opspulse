'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const net = require('../src/http');
const dismissals = require('../src/connectors/dismissals');

const H = 3600e3;
const T0 = Date.parse('2026-10-14T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// Code scanning alert dismissed `hoursAgo` before `now`.
const codeAlert = (n, owner, now, hoursAgo, by = 'jdoe') => ({
  number: n,
  html_url: `https://github.com/${owner}/api/security/code-scanning/${n}`,
  updated_at: iso(now - hoursAgo * H),
  dismissed_at: iso(now - hoursAgo * H),
  dismissed_by: { login: by },
  dismissed_reason: 'false positive',
  repository: { full_name: `${owner}/api` },
  rule: { id: 'js/sql-injection', description: 'SQL injection' },
  tool: { name: 'CodeQL' },
});

// Fake GitHub API. `routes(pathname)` returns the alerts for that list endpoint, newest first.
// Pages hold two alerts so pagination is exercised.
async function fakeGitHub(t, routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    const all = routes(u.pathname) || [];
    if (all === 'fail') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"Not Found"}'); }
    const page = Number(u.searchParams.get('page') || 1);
    const items = all.slice((page - 1) * 2, page * 2);
    if (page * 2 < all.length) {
      u.searchParams.set('page', page + 1);
      res.setHeader('link', `<http://127.0.0.1:${server.address().port}${u.pathname}?${u.searchParams}>; rel="next"`);
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(items));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  net.configure({ timeoutSeconds: 5 });
  return { apiUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function cfgWith(apiUrl, dismissalsCfg) {
  const cfg = config.load(path.join(os.tmpdir(), 'opspulse-no-config', 'config.json'));
  cfg.github.apiUrl = apiUrl;
  cfg.github.dismissals = { ...cfg.github.dismissals, tools: ['code-scanning'], ...dismissalsCfg };
  return cfg;
}
const byOrg = (data) => Object.fromEntries(data.orgs.map((o) => [o.org, o.items.map((i) => i.title + '#' + i.url.split('/').pop())]));

test('org mode collects each org and groups alerts by org', async (t) => {
  const gh = await fakeGitHub(t, (p) => ({
    '/orgs/acme/code-scanning/alerts': [codeAlert(1, 'acme', T0, 1), codeAlert(2, 'acme', T0, 2)],
    '/orgs/labs/code-scanning/alerts': [codeAlert(7, 'labs', T0, 3)],
  })[p]);
  const data = await dismissals.collect(cfgWith(gh.apiUrl, { orgs: ['acme', 'labs'] }), { github: 't' }, null, { now: T0 });
  assert.deepEqual(byOrg(data), { acme: ['SQL injection#1', 'SQL injection#2'], labs: ['SQL injection#7'] });
});

test('enterprise mode uses enterprise endpoints only and groups alerts by repository owner', async (t) => {
  const gh = await fakeGitHub(t, (p) => (p === '/enterprises/acme-ent/code-scanning/alerts' ? [codeAlert(1, 'acme', T0, 1), codeAlert(5, 'labs', T0, 2), codeAlert(2, 'acme', T0, 3)] : null));
  const data = await dismissals.collect(cfgWith(gh.apiUrl, { enterprise: 'acme-ent', orgs: [] }), { github: 't' }, null, { now: T0 });
  assert.deepEqual(byOrg(data), { acme: ['SQL injection#1', 'SQL injection#2'], labs: ['SQL injection#5'] });
  assert.ok(gh.requests.every((r) => r.startsWith('/enterprises/acme-ent/')), gh.requests.join('\n'));
});

test('secret scanning asks GitHub to filter by resolution, and Dependabot can include auto-dismissed alerts', async (t) => {
  const gh = await fakeGitHub(t, () => []);
  await dismissals.collect(cfgWith(gh.apiUrl, { orgs: ['acme'], tools: ['secret-scanning', 'dependabot'], secretResolutions: ['false_positive', 'used_in_tests'], dependabotStates: ['dismissed', 'auto_dismissed'] }), { github: 't' }, null, { now: T0 });
  const q = (prefix) => new URLSearchParams(gh.requests.find((r) => r.startsWith(prefix)).split('?')[1]);
  assert.equal(q('/orgs/acme/secret-scanning/').get('resolution'), 'false_positive,used_in_tests');
  assert.equal(q('/orgs/acme/dependabot/').get('state'), 'dismissed,auto_dismissed');
});

test('an incremental refresh fetches only what changed and merges it with the previous result', async (t) => {
  let alerts = [codeAlert(2, 'acme', T0, 1), codeAlert(1, 'acme', T0, 30)];
  const gh = await fakeGitHub(t, (p) => (p === '/orgs/acme/code-scanning/alerts' ? alerts : null));
  const cfg = cfgWith(gh.apiUrl, { orgs: ['acme'] });
  const first = await dismissals.collect(cfg, { github: 't' }, null, { now: T0 });

  const later = T0 + 1 * H;
  alerts = [codeAlert(3, 'acme', later, 0.1), codeAlert(2, 'acme', T0, 1), codeAlert(1, 'acme', T0, 30)];
  gh.requests.length = 0;
  const second = await dismissals.collect(cfg, { github: 't' }, first, { now: later });

  assert.deepEqual(byOrg(second), { acme: ['SQL injection#3', 'SQL injection#2', 'SQL injection#1'] });
  assert.equal(gh.requests.length, 1, 'stops at the first page once alerts predate the last sync');
});

test('alerts that leave the time window are dropped on incremental refreshes', async (t) => {
  const gh = await fakeGitHub(t, (p) => (p === '/orgs/acme/code-scanning/alerts' ? [codeAlert(2, 'acme', T0, 1), codeAlert(1, 'acme', T0, 29 * 24)] : null));
  const cfg = cfgWith(gh.apiUrl, { orgs: ['acme'], lookbackDays: 30 });
  const first = await dismissals.collect(cfg, { github: 't' }, null, { now: T0 });
  const second = await dismissals.collect(cfg, { github: 't' }, first, { now: T0 + 2 * 24 * H - 1 });
  assert.deepEqual(byOrg(second), { acme: ['SQL injection#2'] });
});

test('a full resync after fullResyncHours removes alerts GitHub no longer lists as dismissed', async (t) => {
  let alerts = [codeAlert(2, 'acme', T0, 1), codeAlert(1, 'acme', T0, 2)];
  const gh = await fakeGitHub(t, (p) => (p === '/orgs/acme/code-scanning/alerts' ? alerts : null));
  const cfg = cfgWith(gh.apiUrl, { orgs: ['acme'], fullResyncHours: 24 });
  const first = await dismissals.collect(cfg, { github: 't' }, null, { now: T0 });

  alerts = [codeAlert(2, 'acme', T0, 1)]; // alert 1 was reopened
  const beforeResync = await dismissals.collect(cfg, { github: 't' }, first, { now: T0 + 23 * H });
  const afterResync = await dismissals.collect(cfg, { github: 't' }, beforeResync, { now: T0 + 25 * H });

  assert.deepEqual(byOrg(beforeResync), { acme: ['SQL injection#2', 'SQL injection#1'] });
  assert.deepEqual(byOrg(afterResync), { acme: ['SQL injection#2'] });
});

test('changing the configuration forces a full resync', async (t) => {
  const gh = await fakeGitHub(t, (p) => (p === '/orgs/acme/code-scanning/alerts' ? [codeAlert(2, 'acme', T0, 1), codeAlert(1, 'acme', T0, 2)] : null));
  const first = await dismissals.collect(cfgWith(gh.apiUrl, { orgs: ['acme'] }), { github: 't' }, null, { now: T0 });
  const second = await dismissals.collect(cfgWith(gh.apiUrl, { orgs: ['acme'], exclude: [{ by: 'jdoe' }] }), { github: 't' }, first, { now: T0 + H });
  assert.deepEqual([byOrg(second), second.orgs[0].hidden], [{ acme: [] }, 2]);
});

test('alerts hidden by rules are counted once across incremental refreshes', async (t) => {
  const gh = await fakeGitHub(t, (p) => (p === '/orgs/acme/code-scanning/alerts' ? [codeAlert(2, 'acme', T0, 0.05, 'bot[bot]'), codeAlert(1, 'acme', T0, 1)] : null));
  const cfg = cfgWith(gh.apiUrl, { orgs: ['acme'], exclude: [{ by: '*[bot]' }] });
  let data = await dismissals.collect(cfg, { github: 't' }, null, { now: T0 });
  for (let i = 1; i <= 3; i++) data = await dismissals.collect(cfg, { github: 't' }, data, { now: T0 + i * 60e3 });
  assert.equal(data.orgs[0].hidden, 1);
});

test('a rate limit fails the whole collection', async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  net.configure({ timeoutSeconds: 5, now: () => T0 });
  const cfg = cfgWith(`http://127.0.0.1:${server.address().port}`, { orgs: ['acme', 'labs'] });
  await assert.rejects(dismissals.collect(cfg, { github: 't' }, null, { now: T0 }), (e) => e instanceof net.RateLimitError);
});

test('a stream that fails during a full resync keeps its previous alerts', async (t) => {
  let failLabs = false;
  const gh = await fakeGitHub(t, (p) => {
    if (p === '/orgs/acme/code-scanning/alerts') return [codeAlert(1, 'acme', T0, 1)];
    if (p === '/orgs/labs/code-scanning/alerts') return failLabs ? 'fail' : [codeAlert(7, 'labs', T0, 2)];
    return null;
  });
  const cfg = cfgWith(gh.apiUrl, { orgs: ['acme', 'labs'], fullResyncHours: 24 });
  const first = await dismissals.collect(cfg, { github: 't' }, null, { now: T0 });
  failLabs = true;
  const resync = await dismissals.collect(cfg, { github: 't' }, first, { now: T0 + 25 * H });

  assert.deepEqual(byOrg(resync), { acme: ['SQL injection#1'], labs: ['SQL injection#7'] });
  assert.match(resync.orgs.find((o) => o.org === 'labs').errors['code-scanning'], /^404 /);
});

test('a configuration without supported alert types is reported clearly', async (t) => {
  const gh = await fakeGitHub(t, () => []);
  await assert.rejects(dismissals.collect(cfgWith(gh.apiUrl, { orgs: ['acme'], tools: ['nope'] }), { github: 't' }, null, { now: T0 }), /github\.dismissals\.tools lists no supported alert types/);
});
