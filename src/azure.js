'use strict';
// Microsoft Entra ID sign-in and Azure Key Vault access, with no SDK.
//
// Three ways to get a Key Vault access token, all producing the same thing:
//   cli      `az account get-access-token` — reuses the Azure CLI's own SSO session (silent).
//   browser  OAuth 2.0 authorization code + PKCE, public client, redirect to http://localhost:<port>.
//   device   OAuth 2.0 device code flow — user types a code at microsoft.com/devicelogin.
// browser/device need an app registration (public client) in your tenant: see README.

const crypto = require('crypto');
const { execFile } = require('child_process');
const { request } = require('./http');

const PLATFORM = 'azure';

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}
function userFromToken(token) {
  const c = decodeJwt(token);
  return c.preferred_username || c.upn || c.unique_name || c.email || c.name || null;
}

// ---------- Azure CLI ----------
function cliToken(resource) {
  return new Promise((resolve, reject) => {
    const args = ['account', 'get-access-token', '--resource', resource, '--output', 'json'];
    // On Windows `az` is a .cmd shim, which Node refuses to spawn without a shell. Args are fixed.
    execFile('az', args, { timeout: 90000, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT' || /not recognized|not found/i.test(String(stderr))) return reject(new Error('Azure CLI (az) is not installed or not on PATH'));
        const line = String(stderr || err.message).trim().split('\n').filter(Boolean).pop() || 'unknown error';
        return reject(new Error(/az login/i.test(line) ? "Azure CLI has no session — run 'az login' first" : `az: ${line}`));
      }
      try {
        const j = JSON.parse(stdout);
        const expiresAt = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(String(j.expiresOn || '').replace(/\.\d+$/, '')) || Date.now() + 50 * 60e3;
        resolve({ accessToken: j.accessToken, expiresAt, user: userFromToken(j.accessToken) });
      } catch { reject(new Error('az returned unexpected output')); }
    });
  });
}

// ---------- OAuth (browser + device) ----------
class EntraClient {
  constructor({ authority = 'https://login.microsoftonline.com', tenantId, clientId, scope }) {
    this.base = `${authority.replace(/\/$/, '')}/${tenantId}/oauth2/v2.0`;
    this.clientId = clientId;
    // offline_access => refresh token, so the hour-long access token renews silently.
    this.scope = `${scope} offline_access openid profile`;
    this.pending = new Map(); // state -> { verifier, redirectUri, at }
  }

  authorizeUrl(redirectUri) {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    this.pending.set(state, { verifier, redirectUri, at: Date.now() });
    for (const [k, v] of this.pending) if (Date.now() - v.at > 10 * 60e3) this.pending.delete(k);
    const q = new URLSearchParams({
      client_id: this.clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
      scope: this.scope, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    return `${this.base}/authorize?${q}`;
  }

  async exchange({ code, state, error, error_description }) {
    if (error) throw new Error(`Microsoft sign-in failed: ${error_description || error}`);
    const p = this.pending.get(state);
    if (!p) throw new Error('Sign-in response did not match a pending request (expired or replayed). Try again.');
    this.pending.delete(state);
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
  }

  refresh(refreshToken) {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async deviceStart() {
    const { data } = await request(`${this.base}/devicecode`, {
      method: 'POST', platform: PLATFORM,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, scope: this.scope }).toString(),
    });
    return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri, message: data.message, intervalSec: data.interval || 5, expiresAt: Date.now() + (data.expires_in || 900) * 1000 };
  }

  // Resolves with tokens, or null while the user hasn't finished yet. Throws when declined/expired.
  async devicePoll(deviceCode) {
    const { status, data } = await request(`${this.base}/token`, {
      method: 'POST', platform: PLATFORM, throwOnError: false, retries: 0,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: this.clientId, device_code: deviceCode }).toString(),
    });
    if (status < 300) return this.shape(data);
    if (data?.error === 'authorization_pending' || data?.error === 'slow_down') return null;
    throw new Error(`Device sign-in ${data?.error === 'expired_token' ? 'timed out' : 'failed'}: ${(data?.error_description || data?.error || status).toString().split('\n')[0]}`);
  }

  async tokenRequest(fields) {
    const { data } = await request(`${this.base}/token`, {
      method: 'POST', platform: PLATFORM, retries: 0,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, scope: this.scope, ...fields }).toString(),
    });
    return this.shape(data);
  }

  shape(d) {
    return { accessToken: d.access_token, refreshToken: d.refresh_token || null, expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000, user: userFromToken(d.id_token || d.access_token) };
  }
}

// ---------- Key Vault ----------
async function getSecret(vaultUrl, name, accessToken) {
  const url = `${vaultUrl.replace(/\/$/, '')}/secrets/${encodeURIComponent(name)}?api-version=7.4`;
  const { status, data } = await request(url, { platform: PLATFORM, throwOnError: false, headers: { Authorization: `Bearer ${accessToken}` } });
  if (status === 200 && typeof data?.value === 'string') return data.value;
  const vault = new URL(vaultUrl).host;
  const msg = data?.error?.message ? ` (${String(data.error.message).split('\n')[0].slice(0, 160)})` : '';
  if (status === 401) throw Object.assign(new Error(`Key Vault ${vault} rejected the token (401)${msg}`), { status });
  if (status === 403) throw Object.assign(new Error(`Key Vault ${vault} denied access to secret "${name}" (403) — your account needs the "Key Vault Secrets User" role on this vault${msg}`), { status });
  if (status === 404) throw Object.assign(new Error(`Secret "${name}" does not exist in ${vault}`), { status });
  throw Object.assign(new Error(`Key Vault ${vault} returned ${status} for secret "${name}"${msg}`), { status });
}

module.exports = { cliToken, EntraClient, getSecret, userFromToken };
