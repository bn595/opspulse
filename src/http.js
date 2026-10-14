'use strict';
// HTTP client on node:http/https (Node's fetch does not support proxies). Provides per-platform
// proxies, timeouts and rate limiting, an optional extra CA, retries on 5xx, descriptive errors and
// Link-header pagination. Each request names a `platform`.
//
// Rate limiting, per platform: requests stop before a reported budget (x-ratelimit-*) runs out;
// a short Retry-After is waited out; a long one, an exhausted budget, or a 429 without Retry-After
// blocks the platform (backing off 2, 4, 8, 16, 30 minutes). While blocked, requests fail fast with
// a RateLimitError carrying `retryAt`.

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');

const UA = 'opspulse';
let net = { proxies: {}, ca: undefined, timeoutSeconds: 30, timeouts: {}, now: Date.now };
const agents = new Map();
const limits = new Map(); // platform -> { limit, remaining, resetAt, blockedUntil, backoff }; kept across configure()
const BACKOFF_MINUTES = [2, 4, 8, 16, 30];

class ApiError extends Error {
  constructor(message, status, url) {
    super(message);
    this.status = status;
    this.url = url;
  }
}
class RateLimitError extends ApiError {
  constructor(message, url, retryAt) {
    super(message, 429, url);
    this.retryAt = retryAt;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Applies network settings. Called at startup and on config reload.
function configure(network = {}) {
  net = { proxies: network.proxies || {}, timeoutSeconds: network.timeoutSeconds || 30, timeouts: network.timeouts || {}, now: network.now || Date.now, ca: undefined };
  if (network.caFile) {
    // `ca` replaces the bundled roots, so append to them.
    net.ca = [...tls.rootCertificates, fs.readFileSync(network.caFile, 'utf8')];
  }
  for (const a of agents.values()) a.destroy();
  agents.clear();
}

function proxyAuth(p) {
  if (!p.username) return {};
  const cred = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
  return { 'Proxy-Authorization': 'Basic ' + Buffer.from(cred).toString('base64') };
}

// https.Agent that tunnels through an HTTP(S) proxy via CONNECT.
class TunnelAgent extends https.Agent {
  constructor(proxyUrl, ca) {
    super({ keepAlive: true, ca });
    this.proxy = new URL(proxyUrl);
  }
  createConnection(options, cb) {
    const p = this.proxy;
    const target = `${options.host}:${options.port || 443}`;
    const viaTls = p.protocol === 'https:';
    const req = (viaTls ? https : http).request({
      host: p.hostname,
      port: p.port || (viaTls ? 443 : 80),
      method: 'CONNECT',
      path: target,
      headers: { Host: target, ...proxyAuth(p) },
      ca: this.options.ca,
      timeout: net.timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const why = res.statusCode === 407 ? 'proxy authentication required — add user:pass@ to the proxy URL' : `HTTP ${res.statusCode}`;
        return cb(new Error(`proxy ${p.host} refused CONNECT to ${target} (${why})`));
      }
      cb(null, tls.connect({ socket, servername: options.host, ca: this.options.ca }));
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.once('error', (e) => cb(new Error(`proxy ${p.host} unreachable: ${e.code || e.message}`)));
    req.end();
  }
}

function agentFor(platform, isHttps) {
  const proxy = net.proxies[platform] || '';
  const key = `${isHttps ? 'https' : 'http'}|${proxy}`;
  if (!agents.has(key)) {
    let a;
    if (!isHttps) a = new http.Agent({ keepAlive: true });
    else if (proxy) a = new TunnelAgent(proxy, net.ca);
    else a = new https.Agent({ keepAlive: true, ca: net.ca });
    agents.set(key, a);
  }
  return agents.get(key);
}

function rawRequest(url, { method, headers, body, platform, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    // Plain-HTTP targets are forward-proxied rather than tunnelled.
    const fwd = !isHttps && net.proxies[platform] ? new URL(net.proxies[platform]) : null;
    const opts = fwd
      ? { host: fwd.hostname, port: fwd.port || (fwd.protocol === 'https:' ? 443 : 80), path: u.href, method, headers: { ...headers, Host: u.host, ...proxyAuth(fwd) }, agent: false, ca: net.ca }
      : { host: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method, headers, agent: agentFor(platform, isHttps) };
    const mod = (fwd ? fwd.protocol : u.protocol) === 'https:' ? https : http;

    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : v; } },
          text: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function hintFor(status) {
  if (status === 401) return 'token rejected (expired, revoked or wrong)';
  if (status === 403) return 'forbidden: token lacks a scope/permission, or rate limited';
  if (status === 404) return 'not found (or token cannot see it)';
  if (status === 407) return 'proxy authentication required';
  if (status === 410) return 'endpoint removed by the vendor';
  if (status === 429) return 'rate limited';
  return '';
}

function limitFor(platform) {
  if (!limits.has(platform)) limits.set(platform, { limit: null, remaining: null, resetAt: null, blockedUntil: null, backoff: 0 });
  return limits.get(platform);
}
function readBudget(l, headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining == null) return;
  l.remaining = Number(remaining);
  l.limit = Number(headers.get('x-ratelimit-limit')) || l.limit;
  l.resetAt = Number(headers.get('x-ratelimit-reset')) * 1000 || l.resetAt;
}
const reserveFor = (limit) => Math.max(20, Math.ceil(limit * 0.02));
const clockTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
function block(platform, url, until, reason) {
  limitFor(platform).blockedUntil = until;
  return new RateLimitError(`${reason}; next attempt at ${clockTime(until)}`, url, until);
}

// { platform: { limit, remaining, resetAt, blockedUntil } } for platforms seen so far.
function rateLimitStatus() {
  const now = net.now();
  return Object.fromEntries([...limits].map(([p, l]) => [p, { limit: l.limit, remaining: l.remaining, resetAt: l.resetAt, blockedUntil: l.blockedUntil > now ? l.blockedUntil : null }]));
}

function describeNetError(e, url, timeoutMs) {
  const host = new URL(url).host;
  if (e.code === 'ETIMEDOUT' || e.message === 'timeout') return `timed out after ${timeoutMs / 1000}s calling ${host}`;
  if (e.code === 'ENOTFOUND') return `DNS lookup failed for ${host} (behind a proxy? set network.proxies)`;
  if (e.code === 'ECONNREFUSED') return `connection refused by ${host}`;
  if (/CERT|certificate|self.signed|unable to verify/i.test(e.code || e.message)) return `TLS certificate rejected for ${host} (corporate TLS inspection? set network.caFile) — ${e.code || e.message}`;
  if (/^proxy /.test(e.message)) return e.message;
  return `network error calling ${host}: ${e.code || e.message}`;
}

// request(url, opts) -> { status, data, headers }
//   opts: method, headers, body (object is sent as JSON), platform, timeoutMs, retries,
//         throwOnError (default true; non-2xx throws ApiError, rate limits throw RateLimitError)
async function request(url, { method = 'GET', headers = {}, body, platform = 'default', timeoutMs = (net.timeouts[platform] ?? net.timeoutSeconds) * 1000, retries = 2, throwOnError = true } = {}) {
  const host = new URL(url).host;
  const l = limitFor(platform);
  const h = { 'User-Agent': UA, Accept: 'application/json', ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string' && !h['Content-Type']) h['Content-Type'] = 'application/json';
    h['Content-Length'] = Buffer.byteLength(payload);
  }

  let attempt = 0;
  for (;;) {
    const now = net.now();
    if (l.blockedUntil > now) throw new RateLimitError(`${host} is rate limited; next attempt at ${clockTime(l.blockedUntil)}`, url, l.blockedUntil);
    if (l.limit && l.remaining != null && l.resetAt > now && l.remaining <= reserveFor(l.limit)) {
      throw block(platform, url, l.resetAt, `${host} request budget nearly used (${l.remaining} of ${l.limit} left)`);
    }
    let res;
    try {
      res = await rawRequest(url, { method, headers: h, body: payload, platform, timeoutMs });
    } catch (e) {
      if (attempt++ < retries && e.code !== 'ETIMEDOUT' && !/^proxy .*refused/.test(e.message)) { await sleep(1000 * attempt); continue; }
      throw new ApiError(describeNetError(e, url, timeoutMs), 0, url);
    }

    readBudget(l, res.headers);
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    const limited = res.status === 429 || (res.status === 403 && (retryAfter > 0 || l.remaining === 0 || /secondary rate limit/i.test(res.text)));
    if (limited) {
      if (retryAfter > 0 && retryAfter <= 60 && attempt++ < retries) { await sleep(retryAfter * 1000); continue; }
      let until;
      if (retryAfter > 0) until = now + retryAfter * 1000;
      else if (l.remaining === 0 && l.resetAt > now) until = l.resetAt;
      else until = now + BACKOFF_MINUTES[Math.min(l.backoff++, BACKOFF_MINUTES.length - 1)] * 60e3;
      throw block(platform, url, until, `rate limited by ${host}`);
    }
    if (res.status >= 500 && attempt++ < retries) { await sleep(1500 * attempt); continue; }
    if (res.status < 400) { l.backoff = 0; l.blockedUntil = null; }

    let data = null;
    if (res.text) {
      try { data = JSON.parse(res.text); } catch {
        if (res.status < 300 || throwOnError) {
          const ct = res.headers.get('content-type') || 'unknown type';
          throw new ApiError(`${res.status} from ${new URL(url).host}: expected JSON but got ${ct}${/html/i.test(ct) ? ' — a proxy or SSO login page is probably intercepting the request' : ''}`, res.status, url);
        }
      }
    }
    if (res.status >= 300 && throwOnError) {
      const detail = data?.message || data?.errors?.[0]?.msg || data?.errorMessages?.[0] || data?.error_description || data?.error?.message || (data ? '' : (res.text || '').slice(0, 200));
      const hint = hintFor(res.status);
      throw new ApiError(`${res.status} from ${new URL(url).host}${new URL(url).pathname}${hint ? ` — ${hint}` : ''}${detail ? ` (${String(detail).split('\n')[0]})` : ''}`, res.status, url);
    }
    return { status: res.status, data, headers: res.headers };
  }
}

function nextLink(headers) {
  const link = headers.get('link');
  if (!link) return null;
  const m = link.split(',').map((s) => s.trim()).find((s) => /rel="next"/.test(s));
  return m ? m.slice(m.indexOf('<') + 1, m.indexOf('>')) : null;
}

module.exports = { configure, request, nextLink, rateLimitStatus, ApiError, RateLimitError, sleep };
