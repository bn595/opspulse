'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const config = require('../src/config');
const { SecretStore } = require('../src/secrets');
const { runPlugin, loadPlugins, createContext } = require('../src/plugins');

const plugin = (collect) => ({ id: 'access-report', title: 'Access report', collect });

test('a minimal result is normalized with defaults', async () => {
  const panel = await runPlugin(plugin(async () => ({
    metrics: [{ label: 'Requests', value: 12 }],
    table: { columns: [{ key: 'repo', facet: true }, { key: 'count', label: 'Count', type: 'number' }], rows: [{ repo: 'acme/api', count: 3 }] },
  })), {});

  assert.deepEqual(panel, {
    metrics: [{ label: 'Requests', value: 12, hint: null, level: null, kpi: false }],
    table: {
      columns: [{ key: 'repo', label: 'repo', type: 'text', facet: true, href: null }, { key: 'count', label: 'Count', type: 'number', facet: false, href: null }],
      rows: [{ repo: 'acme/api', count: 3 }],
      truncated: false,
    },
    chart: null,
    feed: [],
  });
});

test('malformed output is rejected with the offending field named', async () => {
  await assert.rejects(runPlugin(plugin(async () => ({ metrics: [{ value: 1 }] })), {}), /access-report: metrics\[0\]\.label must be a non-empty string/);
  await assert.rejects(runPlugin(plugin(async () => ({ table: { columns: [{ key: 'a', type: 'money' }], rows: [] } })), {}), /access-report: table\.columns\[0\]\.type must be one of text, number, date, link/);
  await assert.rejects(runPlugin(plugin(async () => 'nope')), /access-report: collect\(\) must return an object/);
});

test('feed items are namespaced to the plugin', async () => {
  const panel = await runPlugin(plugin(async () => ({ feed: [{ level: 'warn', title: '3 requests waiting', url: 'https://x' }, { id: 'stale', level: 'info', title: 'Old data' }] })), {});
  assert.deepEqual(panel.feed, [
    { id: 'plugin-access-report-0', level: 'warn', source: 'access-report', title: '3 requests waiting', detail: null, url: 'https://x' },
    { id: 'plugin-access-report-stale', level: 'info', source: 'access-report', title: 'Old data', detail: null, url: null },
  ]);
});

test('a plugin that throws reports its own name', async () => {
  await assert.rejects(runPlugin(plugin(async () => { throw new Error('boom'); }), {}), /^Error: access-report: boom$/);
});

function pluginDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opspulse-plugins-'));
  for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
  return dir;
}
const MODULE = (id) => `module.exports = { id: '${id}', title: 'T ${id}', collect: async () => ({}) };`;

test('plugins load from paths relative to the config directory, with entry options', () => {
  const dir = pluginDir({ 'a.js': MODULE('alpha') });
  const [p] = loadPlugins([{ path: './a.js', threshold: 5 }], dir);
  assert.deepEqual([p.id, p.title, p.options.threshold, p.error], ['alpha', 'T alpha', 5, null]);
});

test('config entries can override the id and title', () => {
  const dir = pluginDir({ 'a.js': MODULE('alpha') });
  const [p] = loadPlugins([{ path: './a.js', id: 'beta', title: 'Beta report' }], dir);
  assert.deepEqual([p.id, p.title], ['beta', 'Beta report']);
});

test('load problems become per-plugin errors instead of exceptions', () => {
  const dir = pluginDir({ 'ok.js': MODULE('ok'), 'jira.js': MODULE('jira'), 'dup.js': MODULE('ok'), 'bad.js': 'module.exports = {};' });
  const loaded = loadPlugins([{ path: 'ok.js' }, { path: 'missing.js' }, { path: 'jira.js' }, { path: 'dup.js' }, { path: 'bad.js' }], dir);
  assert.deepEqual(loaded.map((p) => [p.id, p.error && p.error.replace(dir, '<dir>')]), [
    ['ok', null],
    ['missing', 'cannot load <dir>' + path.sep + 'missing.js'],
    ['jira', 'id "jira" is reserved'],
    ['ok-2', 'id "ok" is already used by another plugin'],
    ['bad', 'module must export collect(ctx)'],
  ]);
});

test('disabled entries are skipped', () => {
  const dir = pluginDir({ 'a.js': MODULE('alpha') });
  assert.deepEqual(loadPlugins([{ path: 'a.js', enabled: false }], dir), []);
});

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
function contextFor(user, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opspulse-ctx-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(user));
  const cfg = config.load(path.join(dir, 'config.json'));
  const secrets = { github: 'gh-token', sonar: 'sonar-token', jira: 'jira-token', jiraEmail: 'ann@contoso.com' };
  return createContext({ cfg, secrets, store: new SecretStore(cfg), options: { threshold: 2 }, sources: {}, ...extra });
}

test('ctx.api calls Sonar at the configured URL with the token', async (t) => {
  const seen = [];
  const sonar = await serve((req, res) => { seen.push([req.url, req.headers.authorization]); res.setHeader('content-type', 'application/json'); res.end('{"paging":{"total":7}}'); });
  t.after(sonar.close);
  const ctx = contextFor({ sonar: { url: sonar.url } });

  assert.deepEqual(await ctx.api.sonar.get('/api/projects/search?ps=1'), { paging: { total: 7 } });
  assert.deepEqual(seen, [['/api/projects/search?ps=1', 'Bearer sonar-token']]);
});

test('ctx.api calls Jira Cloud with email and API token', async (t) => {
  let auth;
  const jira = await serve((req, res) => { auth = req.headers.authorization; res.setHeader('content-type', 'application/json'); res.end('{"issues":[]}'); });
  t.after(jira.close);
  const ctx = contextFor({ jira: { baseUrl: jira.url } });

  await ctx.api.jira.get('/rest/api/3/myself');
  assert.equal(auth, 'Basic YW5uQGNvbnRvc28uY29tOmppcmEtdG9rZW4='); // ann@contoso.com:jira-token
});

test('ctx.secret resolves references, ctx.options and ctx.sources pass through', async (t) => {
  process.env.OPSPULSE_TEST_PLUGIN_SECRET = 'plugin-secret';
  t.after(() => delete process.env.OPSPULSE_TEST_PLUGIN_SECRET);
  const ctx = contextFor({}, { sources: { jira: { issues: [{ key: 'IT-1' }] } } });
  assert.equal(await ctx.secret('env:OPSPULSE_TEST_PLUGIN_SECRET'), 'plugin-secret');
  assert.equal(ctx.options.threshold, 2);
  assert.deepEqual(ctx.sources.jira.issues, [{ key: 'IT-1' }]);
});

test('ctx.secret explains a keyvault reference without a configured vault', async () => {
  await assert.rejects(contextFor({}).secret('keyvault:report-token'), /secrets\.azureKeyVault\.vaultUrl is not set/);
});

test('a plugin that never finishes times out', async () => {
  await assert.rejects(runPlugin(plugin(() => new Promise(() => {})), {}, { timeoutMs: 50 }), /access-report: timed out after 0\.05s/);
});

test('the example plugin breaks down recent runs and flags repeated failures', async () => {
  const example = loadPlugins([{ path: 'plugins/examples/runs-by-actor.js', failureWarn: 2 }], path.join(__dirname, '..'))[0];
  const now = Date.now();
  const run = (actor, conclusion, hoursAgo) => ({ actor, conclusion, status: 'completed', created: new Date(now - hoursAgo * 3600e3).toISOString(), durationSec: 60, url: 'https://gh/run' });
  const actions = { repos: [{ repo: 'acme/jobs', workflows: [{ name: 'Sync', url: 'https://gh/wf', runs: [run('jdoe', 'failure', 1), run('jdoe', 'failure', 2), run('ann', 'success', 3), run('ann', 'success', 24 * 30)] }] }] };

  const panel = await runPlugin(example, { options: example.options, sources: { actions } });

  assert.deepEqual(panel.metrics.map((m) => [m.label, m.value]), [['Runs', 3], ['Actors', 2], ['Failure rate', '67%']]);
  assert.deepEqual(panel.table.rows.map((r) => [r.actor, r.conclusion]), [['jdoe', 'failure'], ['jdoe', 'failure'], ['ann', 'success']]);
  assert.deepEqual(panel.feed.map((f) => f.title), ['jdoe triggered 2 failed runs in 7 days']);
});

test('ctx.api refuses to send credentials to another host', async () => {
  const ctx = contextFor({ sonar: { url: 'https://sonarcloud.io' } });
  await assert.rejects(ctx.api.sonar.get('https://attacker.example/collect'), /ctx\.api\.sonar\.get only accepts paths or URLs on https:\/\/sonarcloud\.io/);
});

test('ctx.request routes through the proxy of the plugin platform option by default', async (t) => {
  const seen = [];
  const proxy = await serve((req, res) => { seen.push(req.url); res.setHeader('content-type', 'application/json'); res.end('{}'); });
  t.after(proxy.close);
  require('../src/http').configure({ proxies: { jira: proxy.url } });
  t.after(() => require('../src/http').configure({}));
  const ctx = contextFor({}, { options: { platform: 'jira' } });

  await ctx.request('http://internal.example/api/requests');
  assert.deepEqual(seen, ['http://internal.example/api/requests']);
});

test('a facet column cannot be named q, which is reserved for search', async () => {
  await assert.rejects(runPlugin(plugin(async () => ({ table: { columns: [{ key: 'q', facet: true }], rows: [] } })), {}), /access-report: table\.columns\[0\]\.key "q" is reserved for search/);
});

test('ctx.previous holds the plugin result from the last refresh, for incremental work', async () => {
  const last = { metrics: [{ label: 'Projects', value: 10 }] };
  assert.deepEqual(contextFor({}, { previous: last }).previous, last);
  assert.equal(contextFor({}).previous, null);
});
