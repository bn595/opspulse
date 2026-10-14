'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const client = require('../src/http');

function serve(handler, onConnect) {
  const server = http.createServer(handler);
  if (onConnect) server.on('connect', onConnect);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, close: () => server.close() })));
}
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('a platform proxy forwards plain-HTTP requests with Basic proxy credentials', async (t) => {
  const seen = [];
  const proxy = await serve((req, res) => { seen.push({ url: req.url, auth: req.headers['proxy-authorization'] }); json(res, { ok: true }); });
  t.after(proxy.close);
  client.configure({ proxies: { sonar: `http://svc:p%40ss@127.0.0.1:${proxy.port}` }, timeoutSeconds: 5 });

  const r = await client.request('http://sonar.example:9000/api/x?y=1', { platform: 'sonar', retries: 0 });

  assert.deepEqual(r.data, { ok: true });
  assert.deepEqual(seen, [{ url: 'http://sonar.example:9000/api/x?y=1', auth: 'Basic c3ZjOnBAc3M=' }]); // svc:p@ss, decoded from svc:p%40ss
});

test('HTTPS through a proxy that refuses CONNECT fails once with a readable message', async (t) => {
  let connects = 0;
  const proxy = await serve(() => {}, (req, sock) => { connects++; sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); });
  t.after(proxy.close);
  client.configure({ proxies: { sonar: proxy.url }, timeoutSeconds: 5 });

  await assert.rejects(client.request('https://sonarqube.us/api/x', { platform: 'sonar', retries: 2 }), /refused CONNECT to sonarqube\.us:443 \(proxy authentication required/);
  assert.equal(connects, 1, 'a refused proxy is not retried');
});

test('platforms without a proxy connect directly', async (t) => {
  const direct = await serve((req, res) => json(res, { direct: true }));
  t.after(direct.close);
  client.configure({ proxies: { sonar: 'http://127.0.0.1:9' }, timeoutSeconds: 5 });

  assert.deepEqual((await client.request(direct.url, { platform: 'github', retries: 0 })).data, { direct: true });
});

test('an HTML page instead of JSON is reported as interception', async (t) => {
  const page = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Sign in</html>'); });
  t.after(page.close);
  client.configure({ timeoutSeconds: 5 });

  await assert.rejects(client.request(page.url, { platform: 'jira', retries: 0 }), /expected JSON but got text\/html.*SSO login page/);
});

test('HTTP errors carry the status, a hint and the vendor message', async (t) => {
  const api = await serve((req, res) => json(res, { message: 'Bad credentials' }, 401));
  t.after(api.close);
  client.configure({ timeoutSeconds: 5 });

  await assert.rejects(client.request(`${api.url}/user`, { platform: 'github', retries: 0 }), (e) => {
    assert.equal(e.status, 401);
    assert.match(e.message, /^401 from 127\.0\.0\.1:\d+\/user — token rejected .*\(Bad credentials\)$/);
    return true;
  });
});

test('a 429 with a short Retry-After is waited out and retried', async (t) => {
  let calls = 0;
  const api = await serve((req, res) => { if (++calls === 1) { res.setHeader('retry-after', '1'); return json(res, {}, 429); } json(res, { attempt: calls }); });
  t.after(api.close);
  client.configure({ timeoutSeconds: 5 });

  assert.deepEqual((await client.request(api.url, { platform: 'github', retries: 1 })).data, { attempt: 2 });
});

// Rate-limit tests use a distinct platform name each, because limits are tracked per platform.
const T0 = Date.parse('2026-10-14T12:00:00Z');
function clockAt(ms) { const c = { now: ms }; client.configure({ timeoutSeconds: 5, now: () => c.now }); return c; }
function counting(handler) { const hits = { n: 0 }; return [hits, (req, res) => { hits.n++; handler(req, res); }]; }

test('a low GitHub request budget stops requests before the limit is reached', async (t) => {
  const reset = Math.floor(T0 / 1000) + 1800;
  const [hits, handler] = counting((req, res) => { res.setHeader('x-ratelimit-limit', '5000'); res.setHeader('x-ratelimit-remaining', '50'); res.setHeader('x-ratelimit-reset', String(reset)); json(res, {}); });
  const api = await serve(handler);
  t.after(api.close);
  clockAt(T0);

  await client.request(api.url, { platform: 'gh-budget' });
  await assert.rejects(client.request(api.url, { platform: 'gh-budget' }), (e) => e.retryAt === reset * 1000 && /request budget nearly used \(50 of 5000 left\)/.test(e.message));
  assert.equal(hits.n, 1);
});

test('a 429 without Retry-After blocks the platform for minutes, then recovers', async (t) => {
  let limited = true;
  const [hits, handler] = counting((req, res) => (limited ? json(res, {}, 429) : json(res, { ok: true })));
  const api = await serve(handler);
  t.after(api.close);
  const clock = clockAt(T0);

  await assert.rejects(client.request(api.url, { platform: 'sonar-429' }), (e) => e.retryAt === T0 + 2 * 60e3 && /rate limited by 127\.0\.0\.1/.test(e.message));
  await assert.rejects(client.request(api.url, { platform: 'sonar-429' }), (e) => e.retryAt === T0 + 2 * 60e3);
  assert.equal(hits.n, 1, 'calls during the block are not sent');

  clock.now = T0 + 2 * 60e3;
  limited = false;
  assert.deepEqual((await client.request(api.url, { platform: 'sonar-429' })).data, { ok: true });
});

test('repeated 429s back off for longer each time', async (t) => {
  const api = await serve((req, res) => json(res, {}, 429));
  t.after(api.close);
  const clock = clockAt(T0);

  await assert.rejects(client.request(api.url, { platform: 'sonar-backoff' }), (e) => e.retryAt === T0 + 2 * 60e3);
  clock.now = T0 + 2 * 60e3;
  await assert.rejects(client.request(api.url, { platform: 'sonar-backoff' }), (e) => e.retryAt === T0 + 6 * 60e3);
});

test('a long Retry-After is not waited on; the platform is blocked until then', async (t) => {
  const api = await serve((req, res) => { res.setHeader('retry-after', '600'); json(res, {}, 429); });
  t.after(api.close);
  clockAt(T0);
  await assert.rejects(client.request(api.url, { platform: 'jira-long', retries: 2 }), (e) => e.retryAt === T0 + 600e3);
});

test('a 403 with no requests left blocks until the reset time', async (t) => {
  const reset = Math.floor(T0 / 1000) + 900;
  const api = await serve((req, res) => { res.setHeader('x-ratelimit-remaining', '0'); res.setHeader('x-ratelimit-reset', String(reset)); json(res, { message: 'API rate limit exceeded' }, 403); });
  t.after(api.close);
  clockAt(T0);
  await assert.rejects(client.request(api.url, { platform: 'gh-403' }), (e) => e.retryAt === reset * 1000);
});

test('rate-limit status reports the budget per platform', async (t) => {
  const api = await serve((req, res) => { res.setHeader('x-ratelimit-limit', '5000'); res.setHeader('x-ratelimit-remaining', '4200'); res.setHeader('x-ratelimit-reset', '1791990000'); json(res, {}); });
  t.after(api.close);
  clockAt(T0);
  await client.request(api.url, { platform: 'gh-status' });
  assert.deepEqual(client.rateLimitStatus()['gh-status'], { limit: 5000, remaining: 4200, resetAt: 1791990000000, blockedUntil: null });
});

test('a platform-specific timeout overrides the default', async (t) => {
  const api = await serve((req, res) => setTimeout(() => json(res, {}), 300));
  t.after(api.close);
  client.configure({ timeoutSeconds: 5, timeouts: { slowplat: 0.1 } });
  await assert.rejects(client.request(api.url, { platform: 'slowplat', retries: 0 }), /timed out after 0\.1s/);
  assert.deepEqual((await client.request(api.url, { platform: 'fastplat', retries: 0 })).data, {});
});
