'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const config = require('../src/config');
const net = require('../src/http');
const { SecretStore } = require('../src/secrets');

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

function setup(user) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opspulse-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(user));
  return config.load(path.join(dir, 'config.json'));
}
const newStore = (cfg) => new SecretStore(cfg, { applyNetwork: (proxies) => net.configure({ ...cfg.network, proxies }) });

// Entra token endpoint and Key Vault, standing in for Microsoft.
async function fakeMicrosoft(t, secrets) {
  const entra = await serve((req, res) => {
    if (req.url.endsWith('/oauth2/v2.0/token')) return json(res, { access_token: 'vault-token', refresh_token: 'refresh', expires_in: 3600, id_token: jwt({ preferred_username: 'ann@contoso.com' }) });
    json(res, { error: 'not_found' }, 404);
  });
  const vault = await serve((req, res) => {
    if (req.headers.authorization !== 'Bearer vault-token') return json(res, { error: { message: 'bad token' } }, 401);
    const name = decodeURIComponent(req.url.split('/secrets/')[1].split('?')[0]);
    if (name in secrets) return json(res, { value: secrets[name] });
    json(res, { error: { code: 'Forbidden', message: 'Caller is not authorized' } }, 403);
  });
  t.after(() => { entra.close(); vault.close(); });
  return { authority: entra.url, vaultUrl: vault.url };
}

async function signIn(store) {
  const state = new URL(store.beginBrowserLogin('http://localhost:4777/auth/azure/callback')).searchParams.get('state');
  await store.completeBrowserLogin({ code: 'auth-code', state });
}

test('env, file and literal references resolve without Key Vault', async (t) => {
  process.env.OPSPULSE_TEST_GH = 'gh-from-env';
  t.after(() => delete process.env.OPSPULSE_TEST_GH);
  const cfg = setup({ github: { token: 'env:OPSPULSE_TEST_GH' }, sonar: { token: 'file:sonar.txt' }, jira: { token: 'literal-jira', email: 'ann@contoso.com' } });
  fs.writeFileSync(path.join(cfg._dir, 'sonar.txt'), 'sonar-from-file\n');

  const { values, errors } = await newStore(cfg).resolve();

  assert.deepEqual([values.github, values.sonar, values.jira, values.jiraEmail], ['gh-from-env', 'sonar-from-file', 'literal-jira', 'ann@contoso.com']);
  assert.deepEqual(errors, []);
});

test('an empty env reference is reported with a fix', async () => {
  const cfg = setup({ sonar: { token: 'env:OPSPULSE_TEST_UNSET' } });
  const { errors } = await newStore(cfg).resolve();
  assert.ok(errors.includes('sonar: env:OPSPULSE_TEST_UNSET is empty — set it in .env'), errors.join('\n'));
});

test('keyvault references without a vault URL are a configuration error', async () => {
  const cfg = setup({ jira: { token: 'keyvault:jira-token' } });
  const { errors } = await newStore(cfg).resolve();
  assert.ok(errors.some((e) => /vaultUrl is not set/.test(e)), errors.join('\n'));
});

test('keyvault secrets wait for sign-in, then load after browser sign-in', async (t) => {
  const ms = await fakeMicrosoft(t, { 'jira-token': 'jira-secret' });
  const cfg = setup({ jira: { token: 'keyvault:jira-token' }, secrets: { azureKeyVault: { vaultUrl: ms.vaultUrl, authority: ms.authority, auth: 'browser' } } });
  const store = newStore(cfg);

  await store.resolve();
  assert.equal(store.authStatus().needsLogin, true);
  assert.equal(store.authStatus().secrets.jira, 'pending');

  await signIn(store);
  const { values } = await store.resolve();
  assert.equal(values.jira, 'jira-secret');
  assert.equal(store.authStatus().user, 'ann@contoso.com');
});

test('a secret the user may not read names the missing role', async (t) => {
  const ms = await fakeMicrosoft(t, {});
  const cfg = setup({ sonar: { token: 'keyvault:sonar-token' }, secrets: { azureKeyVault: { vaultUrl: ms.vaultUrl, authority: ms.authority, auth: 'browser' } } });
  const store = newStore(cfg);
  await signIn(store);

  const { errors } = await store.resolve();
  assert.ok(errors.some((e) => /denied access to secret "sonar-token" \(403\).*Key Vault Secrets User/.test(e)), errors.join('\n'));
  assert.equal(store.authStatus().secrets.sonar, 'error');
});

test('sign-in callbacks with an unknown state are rejected', async () => {
  const cfg = setup({ jira: { token: 'keyvault:x' }, secrets: { azureKeyVault: { vaultUrl: 'https://v.vault.azure.net' } } });
  await assert.rejects(newStore(cfg).completeBrowserLogin({ code: 'c', state: 'forged' }), /did not match a pending request/);
});

test('status output never contains secret values or proxy credentials', async (t) => {
  const ms = await fakeMicrosoft(t, { 'jira-token': 'jira-secret' });
  process.env.OPSPULSE_TEST_PROXY = 'http://svc:proxy-password@proxy.corp:8080';
  t.after(() => delete process.env.OPSPULSE_TEST_PROXY);
  const cfg = setup({ jira: { token: 'keyvault:jira-token' }, network: { proxies: { github: 'env:OPSPULSE_TEST_PROXY' } }, secrets: { azureKeyVault: { vaultUrl: ms.vaultUrl, authority: ms.authority, auth: 'browser' } } });
  const store = newStore(cfg);
  await signIn(store);
  await store.resolve();

  const status = JSON.stringify(store.authStatus());
  for (const secret of ['jira-secret', 'vault-token', 'refresh', 'proxy-password']) assert.ok(!status.includes(secret), `status leaks ${secret}`);
  assert.equal(store.authStatus().proxyHosts.github, 'proxy.corp:8080');
});

test('sign-out forgets the session', async (t) => {
  const ms = await fakeMicrosoft(t, { 'jira-token': 'jira-secret' });
  const cfg = setup({ jira: { token: 'keyvault:jira-token' }, secrets: { azureKeyVault: { vaultUrl: ms.vaultUrl, authority: ms.authority, auth: 'browser' } } });
  const store = newStore(cfg);
  await signIn(store);
  await store.resolve();

  store.signOut();
  const { values } = await store.resolve();
  assert.equal(values.jira, '');
  assert.equal(store.authStatus().needsLogin, true);
});
