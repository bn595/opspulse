'use strict';
// Resolves secret references (env:, file:, keyvault:, literal) and keeps results in memory only.
// Key Vault values are cached for `cacheMinutes`; Entra tokens are held until sign-out or exit.
// Nothing is written to disk: a local encryption key would be readable by the same user account.

const fs = require('fs');
const path = require('path');
const { cliToken, EntraClient, getSecret } = require('./azure');
const { secretRefs } = require('./config');

const KV = /^keyvault:/;

class SecretStore {
  constructor(cfg, { applyNetwork = () => {}, onSignedIn = () => {} } = {}) {
    this.applyNetwork = applyNetwork;
    this.onSignedIn = onSignedIn;
    this.azure = { accessToken: null, expiresAt: 0, refreshToken: null, user: null, method: null };
    this.device = null;
    this.lastError = null;
    this.needsLogin = false;
    this.cache = { values: {}, at: 0 };
    this.reconfigure(cfg);
  }

  reconfigure(cfg) {
    this.refs = secretRefs(cfg);
    this.kv = cfg.secrets.azureKeyVault;
    this.dir = cfg._dir;
    this.cache = { values: {}, at: 0 };
    this.status = {};
    this.proxies = {};
    this.entra = this.kv.tenantId && this.kv.clientId ? new EntraClient(this.kv) : null;
  }

  usesVault() { return Object.values(this.refs).some((r) => KV.test(r || '')); }

  resolveLocal(ref) {
    if (!ref || typeof ref !== 'string') return '';
    if (ref.startsWith('env:')) return (process.env[ref.slice(4)] || '').trim();
    if (ref.startsWith('file:')) {
      const p = path.resolve(this.dir, ref.slice(5));
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
    }
    return ref.trim();
  }

  // -> { values: { github, sonar, jira, jiraEmail }, errors: [string] }
  async resolve() {
    const values = {};
    const errors = [];
    const status = {};
    const proxies = {};
    const kvNames = {};

    for (const [key, ref] of Object.entries(this.refs)) {
      if (!ref) { status[key] = 'unset'; values[key] = ''; continue; }
      if (KV.test(ref)) { kvNames[key] = ref.slice(9).trim(); continue; }
      const v = this.resolveLocal(ref);
      values[key] = v;
      status[key] = v ? 'ok' : 'missing';
      if (!v && !key.startsWith('proxy.')) errors.push(`${key}: ${ref} is empty — ${ref.startsWith('env:') ? 'set it in .env' : ref.startsWith('file:') ? 'file missing or empty' : 'no value'}`);
    }
    for (const k of Object.keys(this.refs)) if (k.startsWith('proxy.')) proxies[k.slice(6)] = values[k] || '';
    // Apply non-vault proxies first; they may be required to reach the vault.
    this.applyNetwork(proxies);

    const wanted = Object.keys(kvNames);
    if (wanted.length) {
      if (kvNames['proxy.azure']) errors.push('network.proxies.azure cannot come from Key Vault (it is needed to reach Key Vault)');
      if (!this.kv.vaultUrl) {
        errors.push('secrets.azureKeyVault.vaultUrl is not set but "keyvault:" references are used');
        for (const k of wanted) { status[k] = 'error'; values[k] = ''; }
      } else if (this.cache.at && Date.now() - this.cache.at < this.kv.cacheMinutes * 60e3 && wanted.every((k) => k in this.cache.values)) {
        for (const k of wanted) { values[k] = this.cache.values[k]; status[k] = values[k] ? 'ok' : 'missing'; }
      } else {
        let token = null;
        try {
          token = await this.vaultToken();
        } catch (e) {
          this.lastError = e.message;
          errors.push(e.message);
          for (const k of wanted) { status[k] = this.needsLogin ? 'pending' : 'error'; values[k] = ''; }
        }
        if (token) {
          const fetched = {};
          await Promise.all(wanted.map(async (k) => {
            try {
              fetched[k] = await getSecret(this.kv.vaultUrl, kvNames[k], token);
              values[k] = fetched[k];
              status[k] = fetched[k] ? 'ok' : 'missing';
            } catch (e) {
              values[k] = '';
              status[k] = 'error';
              errors.push(e.message);
              if (e.status === 401) { this.azure.accessToken = null; this.azure.expiresAt = 0; }
            }
          }));
          if (Object.keys(fetched).length === wanted.length) this.cache = { values: fetched, at: Date.now() };
          else this.cache = { values: {}, at: 0 };
          if (!errors.length) this.lastError = null;
        }
      }
      for (const k of Object.keys(this.refs)) if (k.startsWith('proxy.')) proxies[k.slice(6)] = values[k] || '';
      this.applyNetwork(proxies);
    }

    this.status = status;
    this.proxies = proxies;
    return { values, errors };
  }

  get resource() { return this.kv.scope.replace(/\/\.default$/, ''); }

  async vaultToken() {
    const a = this.azure;
    if (a.accessToken && a.expiresAt - Date.now() > 2 * 60e3) return a.accessToken;
    if (a.refreshToken && this.entra) {
      try { this.setTokens(await this.entra.refresh(a.refreshToken), a.method); return a.accessToken; } catch { /* fall through to a fresh sign-in */ }
    }
    const mode = this.kv.auth || 'auto';
    let cliErr = null;
    if (mode === 'auto' || mode === 'cli') {
      try { this.setTokens(await cliToken(this.resource), 'cli'); this.needsLogin = false; return a.accessToken; } catch (e) { cliErr = e; }
      if (mode === 'cli') throw new Error(`Azure CLI sign-in failed: ${cliErr.message}`);
    }
    if (!this.entra) {
      throw new Error(mode === 'auto'
        ? `${cliErr.message}. Browser sign-in is unavailable because secrets.azureKeyVault.tenantId or clientId is empty`
        : 'secrets.azureKeyVault.auth is "' + mode + '" but tenantId/clientId are not set');
    }
    this.needsLogin = true;
    throw new Error('Microsoft sign-in required to read secrets from Key Vault');
  }

  setTokens(t, method) {
    this.azure = { accessToken: t.accessToken, expiresAt: t.expiresAt, refreshToken: t.refreshToken || null, user: t.user || this.azure.user, method };
    this.needsLogin = false;
    this.lastError = null;
    this.cache = { values: {}, at: 0 };
  }

  beginBrowserLogin(redirectUri) {
    if (!this.entra) throw new Error('Browser sign-in needs secrets.azureKeyVault.tenantId and clientId');
    return this.entra.authorizeUrl(redirectUri);
  }

  async completeBrowserLogin(query) {
    try {
      this.setTokens(await this.entra.exchange(query), 'browser');
      this.onSignedIn();
    } catch (e) {
      this.lastError = e.message;
      throw e;
    }
  }

  async startDeviceLogin() {
    if (!this.entra) throw new Error('Device sign-in needs secrets.azureKeyVault.tenantId and clientId');
    if (this.device && this.device.expiresAt > Date.now()) return this.device;
    const d = await this.entra.deviceStart();
    this.device = d;
    const poll = async () => {
      if (this.device !== d) return; // cancelled or replaced
      try {
        const t = await this.entra.devicePoll(d.deviceCode);
        if (t) { this.device = null; this.setTokens(t, 'device'); this.onSignedIn(); return; }
        if (Date.now() > d.expiresAt) throw new Error('Device sign-in timed out');
        setTimeout(poll, d.intervalSec * 1000);
      } catch (e) {
        this.device = null;
        this.lastError = e.message;
      }
    };
    setTimeout(poll, d.intervalSec * 1000);
    return d;
  }

  signOut() {
    this.azure = { accessToken: null, expiresAt: 0, refreshToken: null, user: null, method: null };
    this.device = null;
    this.cache = { values: {}, at: 0 };
    this.needsLogin = this.usesVault() && !['cli'].includes(this.kv.auth);
    this.lastError = null;
  }

  authStatus() {
    const a = this.azure;
    const signedIn = !!a.accessToken && a.expiresAt > Date.now();
    return {
      enabled: this.usesVault(),
      vault: (() => { try { return new URL(this.kv.vaultUrl).host; } catch { return this.kv.vaultUrl || ''; } })(),
      mode: this.kv.auth || 'auto',
      signedIn,
      user: signedIn || a.refreshToken ? a.user : null,
      method: a.method,
      needsLogin: this.needsLogin && !signedIn,
      canInteractive: !!this.entra,
      device: this.device ? { userCode: this.device.userCode, verificationUri: this.device.verificationUri, message: this.device.message, expiresAt: this.device.expiresAt } : null,
      error: this.lastError,
      secrets: Object.fromEntries(Object.entries(this.status).filter(([k]) => !k.startsWith('proxy.'))),
      // Host only; proxy URLs may contain credentials.
      proxyHosts: Object.fromEntries(Object.entries(this.proxies).map(([k, v]) => { try { return [k, v ? new URL(v).host : '']; } catch { return [k, '(invalid URL)']; } })),
      loadedAt: this.cache.at || null,
    };
  }
}

module.exports = { SecretStore };
