'use strict';
// Plugin panels: user-provided modules that return data for a generic panel.
//   module.exports = { id, title, async collect(ctx) -> { metrics?, table?, chart?, feed? } }
// See README "Plugins" for the result shape and the ctx object.

const path = require('path');
const { request, nextLink } = require('./http');
const { githubHeaders } = require('./connectors/actions');
const { authHeaders: jiraHeaders } = require('./connectors/jira');

const LEVELS = ['critical', 'warn', 'info', 'good'];
const TYPES = ['text', 'number', 'date', 'link'];
const MAX_ROWS = 5000;

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}
const isStr = (v) => typeof v === 'string' && v.length > 0;

function normalizeMetric(m, i) {
  check(m && typeof m === 'object', `metrics[${i}] must be an object`);
  check(isStr(m.label), `metrics[${i}].label must be a non-empty string`);
  check(typeof m.value === 'number' || typeof m.value === 'string', `metrics[${i}].value must be a number or string`);
  check(m.level == null || LEVELS.includes(m.level), `metrics[${i}].level must be one of ${LEVELS.join(', ')}`);
  return { label: m.label, value: m.value, hint: m.hint ?? null, level: m.level ?? null, kpi: m.kpi === true };
}

function normalizeTable(t) {
  check(t && typeof t === 'object', 'table must be an object');
  check(Array.isArray(t.columns) && t.columns.length > 0, 'table.columns must be a non-empty list');
  check(Array.isArray(t.rows), 'table.rows must be a list');
  const columns = t.columns.map((c, i) => {
    check(c && isStr(c.key), `table.columns[${i}].key must be a non-empty string`);
    check(!(c.facet && c.key === 'q'), `table.columns[${i}].key "q" is reserved for search`);
    check(c.type == null || TYPES.includes(c.type), `table.columns[${i}].type must be one of ${TYPES.join(', ')}`);
    return { key: c.key, label: c.label ?? c.key, type: c.type ?? 'text', facet: c.facet === true, href: c.href ?? null };
  });
  t.rows.forEach((r, i) => check(r && typeof r === 'object' && !Array.isArray(r), `table.rows[${i}] must be an object`));
  return { columns, rows: t.rows.slice(0, MAX_ROWS), truncated: t.rows.length > MAX_ROWS };
}

function normalizeChart(c, table) {
  check(c && typeof c === 'object', 'chart must be an object');
  check(table && table.columns.some((col) => col.key === c.key), 'chart.key must name a table column');
  const days = c.days ?? 30;
  check(Number.isInteger(days) && days >= 1 && days <= 365, 'chart.days must be an integer from 1 to 365');
  return { key: c.key, days, title: c.title ?? null };
}

function normalizeFeed(f, i, pluginId) {
  check(f && typeof f === 'object', `feed[${i}] must be an object`);
  check(['critical', 'warn', 'info'].includes(f.level), `feed[${i}].level must be one of critical, warn, info`);
  check(isStr(f.title), `feed[${i}].title must be a non-empty string`);
  return { id: `plugin-${pluginId}-${f.id ?? i}`, level: f.level, source: pluginId, title: f.title, detail: f.detail ?? null, url: f.url ?? null };
}

async function runPlugin(plugin, ctx, { timeoutMs = 120000 } = {}) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs); });
    const out = await Promise.race([plugin.collect(ctx), timeout]);
    check(out && typeof out === 'object' && !Array.isArray(out), 'collect() must return an object');
    check(out.metrics == null || Array.isArray(out.metrics), 'metrics must be a list');
    check(out.feed == null || Array.isArray(out.feed), 'feed must be a list');
    const table = out.table == null ? null : normalizeTable(out.table);
    return {
      metrics: (out.metrics || []).map(normalizeMetric),
      table,
      chart: out.chart == null ? null : normalizeChart(out.chart, table),
      feed: (out.feed || []).map((f, i) => normalizeFeed(f, i, plugin.id)),
    };
  } catch (e) {
    throw new Error(`${plugin.id}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const RESERVED = new Set(['actions', 'jira', 'ghas', 'dismissals', 'sonar', 'feed', 'kpis', 'secrets', 'win', 'at']);
const ID = /^[a-z][a-z0-9-]{0,39}$/;

// entries: config `plugins` list of { path, id?, title?, enabled?, ...options }; paths resolve against baseDir.
// Returns [{ id, title, options, collect, error }]. A plugin with `error` set did not load.
function loadPlugins(entries, baseDir) {
  const used = new Set();
  const out = [];
  for (const entry of entries || []) {
    if (!entry || entry.enabled === false) continue;
    const { path: rel, id: idOverride, title: titleOverride, enabled, ...options } = entry;
    const file = path.resolve(baseDir, String(rel || ''));
    const fallbackId = path.basename(file, '.js').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    let mod = null;
    let error = null;
    try {
      delete require.cache[file];
      mod = require(file);
    } catch (e) {
      error = e.code === 'MODULE_NOT_FOUND' && e.message.includes(file) ? `cannot load ${file}` : `cannot load ${file}: ${e.message}`;
    }
    let id = idOverride || mod?.id || fallbackId;
    if (!error && typeof mod?.collect !== 'function') error = 'module must export collect(ctx)';
    if (!error && !ID.test(id)) error = `id "${id}" must be lowercase letters, digits and dashes`;
    if (!error && RESERVED.has(id)) error = `id "${id}" is reserved`;
    if (used.has(id)) {
      if (!error) error = `id "${id}" is already used by another plugin`;
      let n = 2;
      while (used.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    used.add(id);
    out.push({ id, title: titleOverride || mod?.title || id, options, collect: error ? null : mod.collect, error });
  }
  return out;
}

// GET with a platform's credentials. Absolute URLs must stay on the platform's host so
// credentials are never sent elsewhere (pagination links are absolute).
function authedGet(name, baseUrl, headers, used) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  return async (p) => {
    const absolute = /^https?:\/\//i.test(p);
    if (absolute && !p.startsWith(base + '/')) throw new Error(`ctx.api.${name}.get only accepts paths or URLs on ${base}`);
    used.add(name);
    return (await request(absolute ? p : base + p, { headers, platform: name })).data;
  };
}

const PLATFORMS_USED = new WeakMap(); // ctx -> Set of platforms called through ctx.api

// What a plugin's collect(ctx) receives. Network calls go through the shared client, so proxies apply.
function createContext({ cfg, secrets, store, options, sources, previous = null }) {
  const used = new Set();
  const ctx = {
    options,
    sources,
    previous, // this plugin's last successful result, for incremental fetching
    config: cfg,
    secrets,
    secret: (ref) => store.resolveRef(ref),
    // Without opts.platform, the plugin's `platform` option picks the proxy.
    request: (url, opts = {}) => {
      const platform = opts.platform || options.platform || 'default';
      if (platform !== 'default') used.add(platform);
      return request(url, { ...opts, platform });
    },
    nextLink,
    api: {
      github: { get: authedGet('github', cfg.github.apiUrl, githubHeaders(secrets.github), used) },
      sonar: { get: authedGet('sonar', cfg.sonar.url, { Authorization: `Bearer ${secrets.sonar}` }, used) },
      jira: { get: authedGet('jira', cfg.jira.baseUrl, jiraHeaders(cfg.jira, secrets), used) },
    },
  };
  PLATFORMS_USED.set(ctx, used);
  return ctx;
}
const platformsUsed = (ctx) => [...(PLATFORMS_USED.get(ctx) || [])];

const pluginKey = (id) => `plugin:${id}`;
const pluginIdOf = (key) => (key.startsWith('plugin:') ? key.slice(7) : null);

module.exports = { runPlugin, loadPlugins, createContext, platformsUsed, pluginKey, pluginIdOf };
