'use strict';
// HTTP client built on node:http/https. Node's built-in fetch ignores proxies, so this module
// owns the sockets: per-platform HTTPS proxies (CONNECT tunnels), an optional extra CA for
// TLS-inspecting corporate proxies, timeouts, retry on 429/5xx (and 403 + Retry-After, which is how
// GitHub signals secondary rate limits), readable errors, and Link-header pagination.
//
// Every call names a `platform` ('github' | 'sonar' | 'jira' | 'azure') so the right proxy is used.

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');

const UA = 'opspulse';
let net = { proxies: {}, ca: undefined, timeoutMs: 30000 };
const agents = new Map();

class ApiError extends Error {
  constructor(message, status, url) {
    super(message);
    this.status = status;
    this.url = url;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Called once at startup and again when the config file changes.
function configure(network = {}) {
  net = { proxies: network.proxies || {}, timeoutMs: (network.timeoutSeconds || 30) * 1000, ca: undefined };
  if (network.caFile) {
    // Setting `ca` replaces Node's bundled roots, so append rather than replace.
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

// An https.Agent whose sockets are opened through an HTTP(S) proxy with CONNECT.
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
    // Plain-http targets (e.g. an http:// GHES) go through the proxy as a classic forward request.
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
//   opts: method, headers, body (object => JSON, string => as-is), platform, timeoutMs, retries,
//         throwOnError (default true: non-2xx becomes an ApiError with a readable message)
async function request(url, { method = 'GET', headers = {}, body, platform = 'default', timeoutMs = net.timeoutMs, retries = 2, throwOnError = true } = {}) {
  const h = { 'User-Agent': UA, Accept: 'application/json', ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string' && !h['Content-Type']) h['Content-Type'] = 'application/json';
    h['Content-Length'] = Buffer.byteLength(payload);
  }

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await rawRequest(url, { method, headers: h, body: payload, platform, timeoutMs });
    } catch (e) {
      if (attempt++ < retries && e.code !== 'ETIMEDOUT' && !/^proxy .*refused/.test(e.message)) { await sleep(1000 * attempt); continue; }
      throw new ApiError(describeNetError(e, url, timeoutMs), 0, url);
    }

    const retryAfter = Number(res.headers.get('retry-after'));
    const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && retryAfter > 0);
    if (retryable && attempt++ < retries) {
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1500 * attempt);
      continue;
    }

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

module.exports = { configure, request, nextLink, ApiError, sleep };
