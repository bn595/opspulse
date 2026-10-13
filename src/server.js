#!/usr/bin/env node
'use strict';
// opspulse — local ops dashboard. Zero dependencies; Node 18+.
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
const CONNECTORS = {
  actions: require('./connectors/actions'),
  dismissals: require('./connectors/dismissals'),
  sonar: require('./connectors/sonar'),
  jira: require('./connectors/jira'),
};

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = require(path.join(ROOT, 'package.json')).version;

// ---------- args ----------
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

process.on('unhandledRejection', (e) => console.error('  unhandled:', e?.stack || e));

// ---------- state ----------
let cfg, configMtime = 0;
let store;
function applyNetwork(proxies) { net.configure({ ...cfg.network, proxies }); }

function loadConfig() {
  cfg = config.load(CONFIG_PATH);
  if (DEMO) {
    cfg.jira.statusRules = [{ status: 'Blocked', olderThanDays: 3, level: 'warn' }, { status: 'Triage', olderThanHours: 48, level: 'warn' }];
    cfg.jira.staleDays = 7;
  }
  try { configMtime = fs.statSync(cfg._file).mtimeMs; } catch { configMtime = 0; }
  if (store) store.reconfigure(cfg);
  else store = new SecretStore(cfg, { applyNetwork, onSignedIn: () => { console.log(`  signed in to Azure as ${store.azure.user || 'unknown user'}`); refresh(); } });
  applyNetwork({});
}
loadConfig();

const ENABLED = () => ({
  actions: cfg.github.actions.enabled,
  dismissals: cfg.github.dismissals.enabled,
  sonar: cfg.sonar.enabled,
  jira: cfg.jira.enabled,
});

const CACHE_FILE = path.join(cfg._dir, '.cache', DEMO ? 'demo.json' : 'snapshot.json');
const sources = {};
for (const k of Object.keys(CONNECTORS)) sources[k] = { status: 'pending', fetchedAt: null, error: null, data: null };
let refreshing = null;
let lastRefreshAt = null;
let nextRefreshAt = null;
let secretErrors = [];

try {
  const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  for (const k of Object.keys(sources)) if (cached.sources?.[k]?.data) sources[k] = { ...cached.sources[k], status: 'cached' };
  lastRefreshAt = cached.lastRefreshAt || null;
} catch { /* no cache yet */ }

function saveCache() {
  // Fetched data only (ticket titles, run metadata). Never tokens or secret values.
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastRefreshAt, sources }));
  } catch (e) { console.warn('  could not write cache:', e.message); }
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const m = fs.statSync(cfg._file).mtimeMs;
      if (m !== configMtime) { loadConfig(); console.log('  config changed, reloaded'); }
    } catch { /* config may not exist in demo mode */ }

    let secrets = {};
    if (!DEMO) {
      const r = await store.resolve();
      secrets = r.values;
      secretErrors = r.errors;
      for (const e of r.errors) console.warn(`  [secrets] ${e}`);
    }

    const enabled = ENABLED();
    const demoData = DEMO ? demo.generate() : null;
    const NEEDS = { actions: 'github', dismissals: 'github', sonar: 'sonar', jira: 'jira' };
    await Promise.all(
      Object.entries(CONNECTORS).map(async ([key, conn]) => {
        if (!enabled[key]) { sources[key] = { status: 'disabled', fetchedAt: null, error: null, data: null }; return; }
        if (!DEMO && store.status[NEEDS[key]] === 'pending') {
          // The token lives in Key Vault and nobody has signed in yet: say so once, don't hammer the API.
          sources[key] = { ...sources[key], status: 'error', error: 'Waiting for Key Vault sign-in', errorAt: new Date().toISOString() };
          return;
        }
        sources[key] = { ...sources[key], status: 'refreshing' };
        const t0 = Date.now();
        try {
          const data = DEMO ? demoData[key] : await conn.collect(cfg, secrets);
          sources[key] = { status: 'ok', fetchedAt: new Date().toISOString(), durationMs: Date.now() - t0, error: null, data };
        } catch (e) {
          // Keep the last good data so the dashboard stays useful; flag it as stale.
          sources[key] = { ...sources[key], status: 'error', error: e.message, errorAt: new Date().toISOString() };
          console.warn(`  [${key}] ${e.message}`);
        }
      })
    );
    lastRefreshAt = new Date().toISOString();
    saveCache();
  })().finally(() => {
    refreshing = null;
    nextRefreshAt = new Date(Date.now() + cfg.server.refreshMinutes * 60e3).toISOString();
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
    refreshing: !!refreshing,
    config: config.publicView(cfg, auth),
    auth,
    sources,
    feed: feed.build(sources, cfg, Date.now(), DEMO ? [] : extra),
  };
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

let PORT;
function allowedHost(h) {
  // Blocks DNS-rebinding: only answer to loopback names.
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || h === `[::1]:${PORT}`;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function redirect(res, to) { res.writeHead(302, { Location: to, ...SECURITY_HEADERS }); res.end(); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Same-origin guard for state-changing calls: browsers won't attach this header cross-origin without CORS.
const sameOrigin = (req) => req.headers['x-opspulse'] === '1';

const server = http.createServer(async (req, res) => {
  if (!allowedHost(req.headers.host)) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/snapshot' && req.method === 'GET') return send(res, 200, snapshot());
    if (p === '/api/auth/status' && req.method === 'GET') return send(res, 200, store.authStatus());

    if (req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'missing header' });
      if (p === '/api/refresh') { refresh(); return send(res, 202, { ok: true }); }
      if (p === '/api/auth/device') { const d = await store.startDeviceLogin(); return send(res, 200, { userCode: d.userCode, verificationUri: d.verificationUri, message: d.message, expiresAt: d.expiresAt }); }
      if (p === '/api/auth/signout') { store.signOut(); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    // Browser sign-in: top-level navigation to Microsoft, back to /auth/azure/callback on this port.
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
    send(res, 500, { error: e.message });
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
    console.error(e.message);
    process.exit(1);
  });
  server.listen(port, cfg.server.host, () => {
    const u = `http://localhost:${port}`;
    console.log(`\n  opspulse ${VERSION}${DEMO ? '  (demo data)' : ''}`);
    console.log(`  config : ${cfg._exists ? cfg._file : `${cfg._file} (not found — using defaults)`}`);
    if (!DEMO && store.usesVault()) console.log(`  secrets: Azure Key Vault ${store.authStatus().vault} (auth: ${cfg.secrets.azureKeyVault.auth})`);
    const px = Object.entries(cfg.network.proxies).filter(([, v]) => v).map(([k]) => k);
    if (px.length) console.log(`  proxy  : ${px.join(', ')}`);
    console.log(`  open   : ${u}\n`);
    if (cfg.server.openBrowser && !flag('--no-open')) openBrowser(u);
  });
}

if (cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost' && cfg.server.host !== '::1') {
  console.warn('  WARNING: server.host is not loopback. This dashboard has no login; keep it on 127.0.0.1.');
}
listen(Number(opt('--port')) || cfg.server.port);
refresh();
setInterval(refresh, Math.max(1, cfg.server.refreshMinutes) * 60e3);
