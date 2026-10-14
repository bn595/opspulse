'use strict';
// Loads config.json (JSONC) and a sibling .env file.
// Token, email and proxy values are references resolved by secrets.js:
//   "keyvault:NAME"  secret from the configured Azure Key Vault
//   "env:VAR"        environment variable (including .env)
//   "file:path"      file contents
//   other            literal value

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 4777, openBrowser: true, refreshMinutes: 10 },
  ui: { panels: [], hide: [] }, // panel ids: feed, kpis, actions, jira, ghas, sonar, or a plugin id
  network: {
    // Proxy URL per platform; empty means direct. Accepts secret references.
    proxies: { github: '', sonar: '', jira: '', azure: '' },
    caFile: '', // additional PEM CA bundle
    timeoutSeconds: 30,
    timeouts: {}, // per-platform overrides in seconds, e.g. { "sonar": 90 }
  },
  secrets: {
    azureKeyVault: {
      vaultUrl: '', // required when any keyvault: reference is used
      auth: 'auto', // auto | cli | browser | device
      authority: 'https://login.microsoftonline.com',
      // 'organizations' signs in to the user's home tenant. Set explicitly for guest accounts.
      tenantId: 'organizations',
      // Azure CLI public client ID, pre-consented for Key Vault. Replace with a custom app registration if required.
      clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
      scope: 'https://vault.azure.net/.default',
      cacheMinutes: 60,
    },
  },
  github: {
    apiUrl: 'https://api.github.com',
    token: 'env:OPSPULSE_GITHUB_TOKEN',
    actions: {
      enabled: true,
      refreshMinutes: 10,
      repos: [],
      lookbackHours: 168,
      feedWindowHours: 24,
      failureWarn: 1,
      failureCritical: 3,
      maxRunsPerRepo: 1000,
    },
    dismissals: {
      enabled: true,
      refreshMinutes: 60,
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
    refreshMinutes: 60,
    url: 'https://sonarqube.us', // EU region: https://sonarcloud.io
    token: 'env:OPSPULSE_SONAR_TOKEN',
    organizations: [],
    staleDays: 30,
    tokenExpiryWarnDays: 14,
  },
  plugins: [],
  jira: {
    enabled: true,
    refreshMinutes: 10,
    deployment: 'cloud', // cloud | datacenter
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

// Secret references resolved by secrets.js, keyed by internal name.
// Secrets that enabled built-in sources need; only these are reported when missing.
function requiredSecrets(cfg) {
  const req = new Set();
  if (cfg.github.actions.enabled || cfg.github.dismissals.enabled) req.add('github');
  if (cfg.sonar.enabled) req.add('sonar');
  if (cfg.jira.enabled) {
    req.add('jira');
    if (cfg.jira.deployment !== 'datacenter') req.add('jiraEmail');
  }
  return req;
}

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

// Removes comments and trailing commas outside string literals.
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
  // Fall back to config.jsonc when config.json is absent.
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

// Configuration exposed to the browser. Excludes tokens and proxy credentials.
function publicView(cfg, secretStatus) {
  const s = secretStatus.secrets;
  return {
    configFile: cfg._file,
    configExists: cfg._exists,
    refreshMinutes: cfg.server.refreshMinutes,
    ui: cfg.ui,
    network: { proxies: secretStatus.proxyHosts || {}, caFile: !!cfg.network.caFile },
    actions: { enabled: cfg.github.actions.enabled, repos: cfg.github.actions.repos.map((r) => r.repo), lookbackHours: cfg.github.actions.lookbackHours, feedWindowHours: cfg.github.actions.feedWindowHours, tokenSet: s.github === 'ok' },
    dismissals: { enabled: cfg.github.dismissals.enabled, orgs: cfg.github.dismissals.orgs, lookbackDays: cfg.github.dismissals.lookbackDays, tokenSet: s.github === 'ok' },
    sonar: { enabled: cfg.sonar.enabled, url: cfg.sonar.url, organizations: cfg.sonar.organizations, tokenSet: s.sonar === 'ok' },
    jira: { enabled: cfg.jira.enabled, baseUrl: cfg.jira.baseUrl, jql: cfg.jira.jql, lookbackDays: cfg.jira.lookbackDays, tokenSet: s.jira === 'ok' },
  };
}

module.exports = { load, publicView, secretRefs, requiredSecrets, stripJsonComments };
