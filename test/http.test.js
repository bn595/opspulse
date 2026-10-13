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

test('429 responses are retried', async (t) => {
  let calls = 0;
  const api = await serve((req, res) => (++calls === 1 ? json(res, {}, 429) : json(res, { attempt: calls })));
  t.after(api.close);
  client.configure({ timeoutSeconds: 5 });

  assert.deepEqual((await client.request(api.url, { platform: 'github', retries: 1 })).data, { attempt: 2 });
});
