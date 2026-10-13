'use strict';
// Loads config.json (comments and trailing commas allowed) plus a sibling .env file.
//
// Any token/email/proxy value is a *reference*, resolved later by src/secrets.js:
//   "keyvault:NAME"   -> secret NAME from the Azure Key Vault in `secrets.azureKeyVault`
//   "env:VAR_NAME"    -> process.env.VAR_NAME (also read from .env)
//   "file:path"       -> contents of that file (trimmed)
//   "literal-value"   -> used as-is (fine for emails, not for tokens)

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 4777, openBrowser: true, refreshMinutes: 10 },
  network: {
    // One proxy URL per platform; empty = direct. Supports env:/keyvault: refs since proxies often carry credentials.
    proxies: { github: '', sonar: '', jira: '', azure: '' },
    caFile: '', // extra PEM CA bundle for TLS-inspecting proxies (NODE_EXTRA_CA_CERTS also works)
    timeoutSeconds: 30,
  },
  secrets: {
    azureKeyVault: {
      vaultUrl: '', // https://<name>.vault.azure.net — required when any "keyvault:" ref is used
      auth: 'auto', // auto | cli | browser | device
      authority: 'https://login.microsoftonline.com',
      tenantId: '', // browser/device only
      clientId: '', // browser/device only: a public-client app registration
      scope: 'https://vault.azure.net/.default',
      cacheMinutes: 60, // re-read secrets from the vault after this long
    },
  },
  github: {
    apiUrl: 'https://api.github.com',
    token: 'env:OPSPULSE_GITHUB_TOKEN',
    actions: {
      enabled: true,
      repos: [],
      lookbackHours: 168,
      feedWindowHours: 24,
      failureWarn: 1,
      failureCritical: 3,
      maxRunsPerRepo: 1000,
    },
    dismissals: {
      enabled: true,
      orgs: [],
      lookbackDays: 30,
      tools: ['code-scanning', 'secret-scanning', 'dependabot'],
      secretResolutions: ['false_positive', 'wont_fix', 'used_in_tests', 'pattern_edited', 'pattern_deleted'],
      maxPagesPerTool: 20,
      feed: false,
      feedWarnCount: 25,
    },
  },
  sonar: {
    enabled: true,
    url: 'https://sonarcloud.io',
    token: 'env:OPSPULSE_SONAR_TOKEN',
    organizations: [],
    staleDays: 30,
    tokenExpiryWarnDays: 14,
  },
  jira: {
    enabled: true,
    deployment: 'cloud', // 'cloud' | 'datacenter'
    baseUrl: '',
    email: 'env:OPSPULSE_JIRA_EMAIL',
    token: 'env:OPSPULSE_JIRA_TOKEN',
    jql: '',
    lookbackDays: 30,
    staleDays: 7,
    newWindowHours: 24,
    unassignedWarn: 1,
    maxIssues: 1000,
    statusRules: [],
  },
};

// The reference strings that secrets.js resolves. Key = name used everywhere else.
function secretRefs(cfg) {
  return {
    github: cfg.github.token,
    sonar: cfg.sonar.token,
    jira: cfg.jira.token,
    jiraEmail: cfg.jira.email,
    'proxy.github': cfg.network.proxies.github,
    'proxy.sonar': cfg.network.proxies.sonar,
    'proxy.jira': cfg.network.proxies.jira,
    'proxy.azure': cfg.network.proxies.azure,
  };
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// JSON with // and /* */ comments and trailing commas. String-aware, so "https://x" survives.
function stripJsonComments(src) {
  let out = '', i = 0, inStr = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; }
    else { out += c; i++; }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

function load(configPath) {
  let file = path.resolve(configPath);
  // Accept config.jsonc as a fallback spelling so editors highlight comments properly.
  if (!fs.existsSync(file) && fs.existsSync(file.replace(/\.json$/, '.jsonc'))) file = file.replace(/\.json$/, '.jsonc');
  const dir = path.dirname(file);
  loadDotEnv(path.join(dir, '.env'));

  let user = {};
  const exists = fs.existsSync(file);
  if (exists) {
    try {
      user = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`Could not parse ${file}: ${e.message}`);
    }
  }
  const cfg = merge(DEFAULTS, user);
  cfg._file = file;
  cfg._exists = exists;
  cfg._dir = dir;
  cfg.github.actions.repos = (cfg.github.actions.repos || []).map((r) => (typeof r === 'string' ? { repo: r } : r));
  if (cfg.network.caFile) cfg.network.caFile = path.resolve(dir, cfg.network.caFile);
  return cfg;
}

// What the browser is allowed to see about the configuration (no tokens, no proxy credentials).
function publicView(cfg, secretStatus) {
  const s = secretStatus.secrets;
  return {
    configFile: cfg._file,
    configExists: cfg._exists,
    refreshMinutes: cfg.server.refreshMinutes,
    network: { proxies: secretStatus.proxyHosts || {}, caFile: !!cfg.network.caFile },
    actions: { enabled: cfg.github.actions.enabled, repos: cfg.github.actions.repos.map((r) => r.repo), lookbackHours: cfg.github.actions.lookbackHours, feedWindowHours: cfg.github.actions.feedWindowHours, tokenSet: s.github === 'ok' },
    dismissals: { enabled: cfg.github.dismissals.enabled, orgs: cfg.github.dismissals.orgs, lookbackDays: cfg.github.dismissals.lookbackDays, tokenSet: s.github === 'ok' },
    sonar: { enabled: cfg.sonar.enabled, url: cfg.sonar.url, organizations: cfg.sonar.organizations, tokenSet: s.sonar === 'ok' },
    jira: { enabled: cfg.jira.enabled, baseUrl: cfg.jira.baseUrl, jql: cfg.jira.jql, lookbackDays: cfg.jira.lookbackDays, tokenSet: s.jira === 'ok' },
  };
}

module.exports = { load, publicView, secretRefs, stripJsonComments };
