#!/usr/bin/env node
'use strict';
// opspulse server. No dependencies; requires Node 18+.
//   node src/server.js [--config path] [--demo] [--port N] [--no-open]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const config = require('./config');
const net = require('./http');
const feed = require('./feed');
const demo = require('./demo');
const { SecretStore } = require('./secrets');
const { createAcks } = require('./acks');
const { createStorage } = require('./storage');
const { loadPlugins, runPlugin, createContext, platformsUsed, pluginKey, pluginIdOf } = require('./plugins');
const { planRefresh } = require('./schedule');
const { BUILTIN, publicSources } = require('./sources');
const { log, configureLog } = require('./log');
const { createSonarAdmin } = require('./admin/sonar');
const { startDemoSonar } = require('./demo-sonar');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const EXAMPLE_PLUGIN = path.join(ROOT, 'plugins', 'examples', 'runs-by-actor.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  console.log(`opspulse ${VERSION}

Usage: node src/server.js [options]
  --config <file>   config file (default: ./config.json or ./config.jsonc next to the app)
  --demo            run with synthetic data, no tokens needed
  --port <n>        override server.port
  --no-open         don't open a browser window
`);
  process.exit(0);
}
const DEMO = flag('--demo');
const CONFIG_PATH = path.resolve(opt('--config') || process.env.OPSPULSE_CONFIG || path.join(ROOT, 'config.json'));

process.on('unhandledRejection', (e) => log.error('process.unhandled_rejection', { error: e?.stack || String(e) }));

let cfg, configMtime = 0;
let store;
let plugins = [];
const sources = {};
const newSource = (extra) => ({ status: 'pending', fetchedAt: null, error: null, data: null, ...extra });
let revision = 0; // bumps on every change the browser should re-fetch
const lastAttempt = {};
function setSource(key, value) { sources[key] = value; revision++; }
for (const k of Object.keys(BUILTIN)) sources[k] = newSource();
function applyNetwork(proxies) { net.configure({ ...cfg.network, proxies }); }

function loadConfig() {
  cfg = config.load(CONFIG_PATH);
  configureLog({ format: cfg.logging.format, file: cfg.logging.file ? path.resolve(cfg._dir, cfg.logging.file) : null });
  if (DEMO) {
    cfg.jira.statusRules = [{ status: 'Blocked', olderThanDays: 3, level: 'warn' }, { status: 'Triage', olderThanHours: 48, level: 'warn' }];
    cfg.jira.staleDays = 7;
  }
  try { configMtime = fs.statSync(cfg._file).mtimeMs; } catch { configMtime = 0; }
  if (store) store.reconfigure(cfg);
  else store = new SecretStore(cfg, { applyNetwork, onSignedIn: () => { log.info('azure.signed_in', { user: store.azure.user || 'unknown' }); refresh(true); } });
  applyNetwork({});
  plugins = loadPlugins(DEMO ? [{ path: EXAMPLE_PLUGIN, failureWarn: 5 }] : cfg.plugins, cfg._dir);
  for (const p of plugins) if (p.error) log.warn('plugin.load_failed', { plugin: p.id, error: p.error });
  const configured = new Set(plugins.map((p) => pluginKey(p.id)));
  for (const k of Object.keys(sources)) if (pluginIdOf(k) && !configured.has(k)) delete sources[k];
  for (const p of plugins) sources[pluginKey(p.id)] = newSource({ ...sources[pluginKey(p.id)], title: p.title });
}
loadConfig();

const setting = (key, name) => BUILTIN[key].section(cfg)[name];
const enabled = (key) => setting(key, 'enabled');

// State that outlives a restart goes through the configured storage backends (read at startup).
const storage = createStorage(cfg.storage.backends, { baseDir: cfg._dir, log });
const SNAPSHOT_KEY = DEMO ? 'demo-snapshot' : 'snapshot';
const acks = createAcks({ storage, key: DEMO ? 'demo-acks' : 'acks' });
let refreshing = null;
let lastRefreshAt = null;
let nextRefreshAt = null;
let secretErrors = [];

async function loadCache() {
  const cached = await storage.get(SNAPSHOT_KEY);
  if (!cached) return;
  for (const k of Object.keys(sources)) if (cached.sources?.[k]?.data) sources[k] = { ...cached.sources[k], status: 'cached' };
  lastRefreshAt = cached.lastRefreshAt || null;
}

// Fetched data only; never tokens or secret values. Storage failures are logged by the storage layer.
function saveCache() {
  storage.set(SNAPSHOT_KEY, { lastRefreshAt, sources });
}

// Minutes between refreshes per source. Plugins use their `refreshMinutes` option.
function intervals() {
  const out = {};
  for (const k of Object.keys(BUILTIN)) if (enabled(k)) out[k] = setting(k, 'refreshMinutes') ?? cfg.server.refreshMinutes;
  for (const p of plugins) out[pluginKey(p.id)] = p.options.refreshMinutes ?? cfg.server.refreshMinutes;
  return out;
}
const blockedUntil = () => Object.fromEntries(Object.entries(sources).filter(([, s]) => s.retryAt).map(([k, s]) => [k, Date.parse(s.retryAt)]));

// Runs one source. `collect(previous)` gets the source's last data; a rate-limit error carries retryAt.
async function runSource(key, collect, extra = {}) {
  lastAttempt[key] = Date.now();
  setSource(key, { ...sources[key], ...extra, status: 'refreshing' });
  const t0 = Date.now();
  try {
    const data = await collect(sources[key].data);
    setSource(key, newSource({ ...extra, status: 'ok', fetchedAt: new Date().toISOString(), durationMs: Date.now() - t0, data }));
  } catch (e) {
    // Keep the last successful data and mark it stale.
    const retryAt = e.retryAt ? new Date(e.retryAt).toISOString() : null;
    setSource(key, { ...sources[key], ...extra, status: retryAt ? 'rate-limited' : 'error', error: e.message, errorAt: new Date().toISOString(), retryAt });
    log.warn(retryAt ? 'source.rate_limited' : 'source.refresh_failed', { source: key, error: e.message, ...(retryAt ? { retryAt } : {}) });
  }
}

// Refreshes the sources that are due; `force` refreshes all except rate-limited ones.
// A forced refresh requested while one is running runs as soon as it finishes.
let forceQueued = false;
async function refresh(force = false) {
  if (refreshing) {
    if (force) forceQueued = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      const m = fs.statSync(cfg._file).mtimeMs;
      if (m !== configMtime) { loadConfig(); revision++; log.info('config.reloaded', { file: cfg._file }); }
    } catch { /* config may not exist in demo mode */ }

    for (const k of Object.keys(BUILTIN)) if (!enabled(k) && sources[k].status !== 'disabled') setSource(k, newSource({ status: 'disabled' }));
    const due = new Set(planRefresh({ intervals: intervals(), lastAttempt, blockedUntil: blockedUntil(), now: Date.now(), force }).due);
    if (!due.size) return;

    let secrets = {};
    if (!DEMO) {
      const r = await store.resolve();
      secrets = r.values;
      if (JSON.stringify(r.errors) !== JSON.stringify(secretErrors)) revision++;
      secretErrors = r.errors;
      for (const e of r.errors) log.warn('secret.unavailable', { error: e });
    }

    const demoData = DEMO ? demo.generate() : null;
    await Promise.all(
      Object.keys(BUILTIN).filter((key) => due.has(key)).map((key) => {
        if (!DEMO && store.status[BUILTIN[key].secret] === 'pending') {
          // Token is in Key Vault and no one has signed in; skip the API call and retry on the next tick.
          const waiting = 'Waiting for Key Vault sign-in';
          if (sources[key].error !== waiting) setSource(key, { ...sources[key], status: 'error', error: waiting, errorAt: new Date().toISOString() });
          return null;
        }
        return runSource(key, (previous) => (DEMO ? demoData[key] : BUILTIN[key].connector.collect(cfg, secrets, previous)));
      })
    );
    // Plugins run after the built-in connectors so ctx.sources holds current data.
    const builtins = Object.fromEntries(Object.keys(BUILTIN).map((k) => [k, sources[k].data || null]));
    await Promise.all(plugins.filter((p) => due.has(pluginKey(p.id))).map((p) => {
      const key = pluginKey(p.id);
      if (p.error) { lastAttempt[key] = Date.now(); setSource(key, newSource({ status: 'error', title: p.title, error: p.error })); return null; }
      // The chip shows the budget of the `platform` option, else of the platform the plugin last called.
      let ctx = null;
      const collect = (previous) => {
        ctx = createContext({ cfg, secrets, store, options: p.options, sources: builtins, previous });
        return runPlugin(p, ctx);
      };
      const platformNow = () => p.options.platform || (ctx && platformsUsed(ctx)[0]) || sources[key].platform || null;
      return runSource(key, collect, { title: p.title, platform: p.options.platform || sources[key].platform || null }).then(() => {
        if (platformNow() !== sources[key].platform) setSource(key, { ...sources[key], platform: platformNow() });
      });
    }));
    lastRefreshAt = new Date().toISOString();
    saveCache();
  })().finally(() => {
    refreshing = null;
    const next = planRefresh({ intervals: intervals(), lastAttempt, blockedUntil: blockedUntil(), now: Date.now() }).nextAt;
    nextRefreshAt = next ? new Date(next).toISOString() : null;
    if (forceQueued) {
      forceQueued = false;
      setImmediate(() => refresh(true));
    }
  });
  return refreshing;
}

function snapshot() {
  const auth = store.authStatus();
  const extra = secretErrors.map((e, i) => ({ id: `secret-${i}`, level: auth.needsLogin ? 'warn' : 'critical', source: 'secrets', title: auth.needsLogin && /sign-in required/i.test(e) ? 'Sign in to load secrets from Key Vault' : 'Secret unavailable', detail: e }));
  return {
    version: VERSION,
    demo: DEMO,
    now: new Date().toISOString(),
    lastRefreshAt,
    nextRefreshAt,
    revision,
    limits: net.rateLimitStatus(),
    refreshing: !!refreshing,
    config: config.publicView(cfg, auth),
    auth,
    sources: publicSources(sources),
    feed: acks.annotate(feed.build(sources, cfg, Date.now(), DEMO ? [] : extra)),
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

let PORT;
function allowedHost(h) {
  // Loopback names only (DNS-rebinding protection).
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || h === `[::1]:${PORT}`;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function redirect(res, to) { res.writeHead(302, { Location: to, ...SECURITY_HEADERS }); res.end(); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// CSRF guard: browsers only send custom headers cross-origin after a CORS preflight, which is never approved.
const sameOrigin = (req) => req.headers['x-opspulse'] === '1';

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return reject(Object.assign(new Error('request body too large'), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// SonarQube Cloud admin tools. A preview is kept on the server and applied by id, so the changes made
// are exactly the ones previewed. Previews expire after 30 minutes and can be applied once.
const PREVIEW_TTL_MS = 30 * 60e3;
const BRANCH_TOOLS = new Set(['delete', 'longlived']);
const previews = new Map(); // id -> { tool, rows, branch, at }
const runs = new Map(); // id -> { tool, rows, progress, finished, error }
let demoSonarUrl = null;

const actorName = () => store.authStatus().user || os.userInfo().username;
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);

async function sonarAdmin() {
  let token = 'demo';
  if (!DEMO) {
    token = (await store.resolve()).values.sonar;
    if (!token) throw Object.assign(new Error('No SonarQube Cloud token is available (sonar.token)'), { status: 400 });
  }
  return createSonarAdmin({ sonarUrl: DEMO ? demoSonarUrl : cfg.sonar.url, token, actor: actorName(), log, concurrency: cfg.admin.concurrency });
}

async function adminPreview(body) {
  for (const [id, p] of previews) if (Date.now() - p.at > PREVIEW_TTL_MS) previews.delete(id);
  const tool = String(body.tool || '');
  const params = { org: String(body.org || '').trim(), prefix: String(body.prefix || ''), keys: body.keys ? asList(body.keys) : null, pattern: body.pattern, branch: String(body.branch || '').trim() };
  if (BRANCH_TOOLS.has(tool) && !params.branch) throw Object.assign(new Error('branch is required'), { status: 400 });
  const { rows } = await (await sonarAdmin()).preview(tool, params);
  const id = crypto.randomUUID();
  previews.set(id, { tool, rows, branch: params.branch, at: Date.now() });
  return { id, rows };
}

async function adminApply(body) {
  const preview = previews.get(String(body.previewId || ''));
  if (!preview) throw Object.assign(new Error('This preview has expired or was already applied. Run the preview again.'), { status: 400 });
  const confirmed = BRANCH_TOOLS.has(preview.tool) ? body.confirm === preview.branch : body.confirm === true;
  if (!confirmed) throw Object.assign(new Error(BRANCH_TOOLS.has(preview.tool) ? `Type the branch name "${preview.branch}" to confirm.` : 'Confirmation is required.'), { status: 400 });
  previews.delete(String(body.previewId));
  const admin = await sonarAdmin();
  const selected = asList(body.selected);
  const id = crypto.randomUUID();
  const run = { tool: preview.tool, rows: preview.rows, progress: null, finished: false, error: null };
  runs.set(id, run);
  log.info('admin.run_started', { run: id, tool: preview.tool, actor: actorName(), projects: selected.length });
  admin.apply(preview.tool, preview.rows, { selected, onProgress: (p) => { run.rows = p.rows; run.progress = { done: p.done, total: p.total, concurrency: p.concurrency, waitingUntil: p.waitingUntil || null }; } })
    .then((rows) => { run.rows = rows; })
    .catch((e) => { run.error = e.message; log.error('admin.run_failed', { run: id, error: e.message }); })
    .finally(() => { run.finished = true; log.info('admin.run_finished', { run: id, tool: preview.tool, done: run.rows.filter((r) => r.result === 'done').length, failed: run.rows.filter((r) => r.result === 'failed').length }); });
  return { runId: id };
}

const FEED_ACTIONS = {
  '/api/feed/ack': (b) => acks.acknowledge(b),
  '/api/feed/snooze': (b) => acks.snooze(b, 24),
  '/api/feed/restore': (b) => acks.restore(String(b.id || '')),
};

const server = http.createServer(async (req, res) => {
  if (!allowedHost(req.headers.host)) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/snapshot' && req.method === 'GET') return send(res, 200, snapshot());
    // Polled by the browser; the full snapshot is fetched only when `revision` or `authKey` changes.
    if (p === '/api/admin/run' && req.method === 'GET') {
      const run = runs.get(url.searchParams.get('id') || '');
      return run ? send(res, 200, run) : send(res, 404, { error: 'unknown run' });
    }
    if (p === '/api/status' && req.method === 'GET') {
      const a = store.authStatus();
      return send(res, 200, { revision, refreshing: !!refreshing, lastRefreshAt, nextRefreshAt, authKey: [a.signedIn, a.needsLogin, a.device?.userCode, a.error].join('|') });
    }
    if (p === '/api/auth/status' && req.method === 'GET') return send(res, 200, store.authStatus());

    if (req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'missing header' });
      if (p === '/api/refresh') { refresh(true); return send(res, 202, { ok: true }); }
      if (p === '/api/auth/device') { const d = await store.startDeviceLogin(); return send(res, 200, { userCode: d.userCode, verificationUri: d.verificationUri, message: d.message, expiresAt: d.expiresAt }); }
      if (p === '/api/auth/signout') { store.signOut(); return send(res, 200, { ok: true }); }
      if (p === '/api/admin/preview' || p === '/api/admin/apply') {
        const body = await readJson(req, 2e6);
        try {
          return send(res, 200, await (p === '/api/admin/preview' ? adminPreview(body) : adminApply(body)));
        } catch (e) {
          return send(res, e.retryAt ? 429 : e.status || 502, { error: e.message });
        }
      }
      if (FEED_ACTIONS[p]) {
        const body = await readJson(req);
        let stored;
        try { stored = FEED_ACTIONS[p](body); } catch (e) { return send(res, 400, { error: e.message }); }
        await stored;
        revision++;
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    // Browser sign-in: redirect to Microsoft, which returns to /auth/azure/callback.
    if (p === '/auth/azure/start') return redirect(res, store.beginBrowserLogin(`http://localhost:${PORT}/auth/azure/callback`));
    if (p === '/auth/azure/callback') {
      try {
        await store.completeBrowserLogin(Object.fromEntries(url.searchParams));
        return redirect(res, '/');
      } catch (e) {
        return send(res, 400, `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><body style="font:15px system-ui;padding:40px;max-width:640px"><h2>Sign-in failed</h2><p>${esc(e.message)}</p><p><a href="/">Back to opspulse</a></p>`, 'text/html; charset=utf-8');
      }
    }

    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

function openBrowser(u) {
  const cmd = process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
  exec(cmd, () => {});
}

function listen(port, tries = 10) {
  PORT = port;
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) return listen(port + 1, tries - 1);
    log.error('server.listen_failed', { error: e.message });
    process.exit(1);
  });
  server.listen(port, cfg.server.host, () => {
    const u = `http://localhost:${port}`;
    const px = Object.entries(cfg.network.proxies).filter(([, v]) => v).map(([k]) => k);
    log.info('server.started', {
      version: VERSION,
      url: u,
      config: cfg._exists ? cfg._file : `${cfg._file} (not found, using defaults)`,
      ...(DEMO ? { demo: true } : {}),
      ...(!DEMO && store.usesVault() ? { keyVault: store.authStatus().vault, auth: cfg.secrets.azureKeyVault.auth } : {}),
      ...(px.length ? { proxies: px.join(',') } : {}),
    });
    if (cfg.server.openBrowser && !flag('--no-open')) openBrowser(u);
  });
}

if (cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost' && cfg.server.host !== '::1') {
  log.warn('server.host_not_loopback', { host: cfg.server.host, note: 'This dashboard has no login; keep it on 127.0.0.1.' });
}
(async () => {
  await Promise.all([loadCache(), acks.load()]);
  if (DEMO) demoSonarUrl = await startDemoSonar();
  listen(Number(opt('--port')) || cfg.server.port);
  refresh();
  setInterval(() => refresh(), 60e3); // each source refreshes on its own interval
})();
