'use strict';
// GitHub Advanced Security alert dismissals, per organization or enterprise-wide.
//
// Each (scope, tool) pair is a stream listed newest-updated first. A stream without a sync record
// reads back to the start of the window and replaces its previous alerts; otherwise it reads only
// what changed since its last sync and merges that in. GitHub stops listing an alert as dismissed
// once it is reopened, which an incremental read cannot see, so every stream is re-read in full
// every `fullResyncHours` and whenever the configuration changes or a read hits the page cap. A
// stream that fails keeps its previous alerts and is re-read in full once it succeeds. Sync state
// lives in `_sync`, which the server keeps in its cache but does not send to the browser.

const { nextLink, RateLimitError } = require('../http');
const { gh } = require('./actions');
const rules = require('../rules');

const OVERLAP_MS = 10 * 60e3;
const CONCURRENCY = 6;

const TOOLS = {
  'code-scanning': {
    query: () => 'state=dismissed',
    map: (a) => ({
      at: a.dismissed_at,
      by: a.dismissed_by?.login || null,
      reason: a.dismissed_reason || 'unspecified',
      comment: a.dismissed_comment || '',
      title: a.rule?.description || a.rule?.id || 'Code scanning alert',
      severity: a.rule?.security_severity_level || a.rule?.severity || null,
      ruleId: a.rule?.id || null,
      toolName: a.tool?.name || null,
    }),
  },
  'secret-scanning': {
    query: (dc) => `state=resolved&resolution=${dc.secretResolutions.join(',')}`,
    map: (a) => ({
      at: a.resolved_at,
      by: a.resolved_by?.login || null,
      reason: a.resolution || 'unspecified',
      comment: a.resolution_comment || '',
      title: a.secret_type_display_name || a.secret_type || 'Secret',
      severity: null,
      secretType: a.secret_type || null,
      validity: a.validity || null,
    }),
  },
  dependabot: {
    query: (dc) => `state=${dc.dependabotStates.join(',')}`,
    map: (a) => ({
      at: a.dismissed_at || a.auto_dismissed_at,
      by: a.dismissed_by?.login || (a.state === 'auto_dismissed' ? 'auto-dismissed' : null),
      reason: a.dismissed_reason || (a.state === 'auto_dismissed' ? 'auto_dismissed' : 'unspecified'),
      comment: a.dismissed_comment || '',
      title: a.security_advisory?.summary || a.dependency?.package?.name || 'Dependabot alert',
      severity: a.security_vulnerability?.severity || a.security_advisory?.severity || null,
      package: a.dependency?.package?.name || null,
      ecosystem: a.dependency?.package?.ecosystem || null,
    }),
  },
};

function toItem(tool, a) {
  const repo = a.repository?.full_name || '';
  return { tool, org: repo.split('/')[0] || null, repo, url: a.html_url || `${tool}:${repo}:${a.number}`, ...TOOLS[tool].map(a) };
}

// Reads one stream newest-first until alerts predate `since`. Returns kept items, hidden ids and
// whether the page cap stopped it early.
async function readStream(api, path, tool, since, keep, maxPages) {
  const items = [];
  const hidden = {};
  let url = path;
  let pages = 0;
  while (url) {
    const res = await api.get(url);
    let reachedSince = false;
    for (const a of Array.isArray(res.data) ? res.data : []) {
      if (Date.parse(a.updated_at) < since) { reachedSince = true; break; }
      const item = toItem(tool, a);
      if (!item.at || Date.parse(item.at) < since) continue;
      if (keep && !keep({ ...item, raw: a })) hidden[item.url] = { at: item.at, org: item.org, tool };
      else items.push(item);
    }
    if (reachedSince) return { items, hidden, capped: false };
    url = nextLink(res.headers);
    if (url && ++pages >= maxPages) return { items, hidden, capped: true };
  }
  return { items, hidden, capped: false };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

async function collect(cfg, secrets, previous = null, { now = Date.now() } = {}) {
  const dc = cfg.github.dismissals;
  if (!secrets.github) throw new Error('No GitHub token configured (github.token)');
  const enterprise = dc.enterprise || '';
  if (!enterprise && !dc.orgs.length) throw new Error('Set github.dismissals.enterprise or list orgs under github.dismissals.orgs');
  const api = gh(cfg, secrets.github);
  const keep = rules.compile(dc, 'github.dismissals');
  const windowStart = now - dc.lookbackDays * 86400e3;
  const unknown = dc.tools.filter((t) => !TOOLS[t]);
  if (unknown.length) throw new Error(`github.dismissals.tools: unknown alert type "${unknown[0]}" (use ${Object.keys(TOOLS).join(', ')})`);
  const tools = dc.tools;
  if (!tools.length) throw new Error(`github.dismissals.tools lists no supported alert types (use ${Object.keys(TOOLS).join(', ')})`);
  const scopes = enterprise ? [`enterprises/${enterprise}`] : dc.orgs.map((o) => `orgs/${o}`);

  // Any change to what is fetched or filtered invalidates the merged state.
  const fingerprint = JSON.stringify([scopes, tools, dc.lookbackDays, dc.secretResolutions, dc.dependabotStates, dc.include, dc.exclude]);
  const prev = previous?._sync;
  const incremental = prev && prev.fingerprint === fingerprint && now - prev.fullAt < dc.fullResyncHours * 3600e3;

  const streams = scopes.flatMap((scope) => tools.map((tool) => ({ scope, tool, id: `${scope}:${tool}` })));
  const results = await mapLimit(streams, CONCURRENCY, async (s) => {
    const synced = incremental ? prev.streams[s.id]?.syncedAt : null;
    const since = synced ? Math.max(windowStart, synced - OVERLAP_MS) : windowStart;
    const path = `/${s.scope}/${s.tool}/alerts?${TOOLS[s.tool].query(dc)}&sort=updated&direction=desc&per_page=100`;
    try {
      return { ...s, ok: true, full: !synced, syncedAt: now, ...(await readStream(api, path, s.tool, since, keep, dc.maxPagesPerTool)) };
    } catch (e) {
      RateLimitError.rethrow(e);
      return { ...s, ok: false, error: e.message };
    }
  });
  if (results.every((r) => !r.ok)) throw new Error(results[0].error);

  // Merge by alert URL: newer reads replace older ones. Previous items are kept unless their stream
  // was just read in full. GitHub org names are case-insensitive; config may spell them differently.
  const merged = new Map();
  const hidden = new Map();
  const streamOf = (x) => results.find((r) => r.tool === x.tool && (enterprise || r.scope.toLowerCase() === `orgs/${x.org}`.toLowerCase()));
  const keepPrevious = (x) => { const r = streamOf(x); return !r || !r.ok || !r.full; };
  if (prev && prev.fingerprint === fingerprint) {
    for (const i of previous.orgs.flatMap((o) => o.items)) if (keepPrevious(i)) merged.set(i.url, i);
    for (const [id, h] of Object.entries(prev.hidden || {})) if (keepPrevious(h)) hidden.set(id, h);
  }
  for (const r of results.filter((x) => x.ok)) {
    for (const i of r.items) { merged.set(i.url, i); hidden.delete(i.url); }
    for (const [id, h] of Object.entries(r.hidden)) { hidden.set(id, h); merged.delete(id); }
  }
  const items = [...merged.values()].filter((i) => Date.parse(i.at) >= windowStart).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const [id, h] of hidden) if (Date.parse(h.at) < windowStart) hidden.delete(id);

  // Group for the UI. In org mode every configured org appears, even with no dismissals.
  // Keyed case-insensitively; configured spellings are used for display.
  const orgs = new Map();
  const orgOf = (name) => {
    const key = String(name).toLowerCase();
    if (!orgs.has(key)) orgs.set(key, { org: name, items: [], errors: {}, truncated: [], hidden: 0 });
    return orgs.get(key);
  };
  if (!enterprise) dc.orgs.forEach(orgOf);
  for (const i of items) orgOf(i.org).items.push(i);
  for (const h of hidden.values()) orgOf(h.org).hidden++;
  const errors = {};
  const truncated = [];
  for (const r of results) {
    const target = enterprise ? null : orgOf(r.scope.slice(5));
    if (!r.ok) (target ? target.errors : errors)[r.tool] = r.error;
    if (r.capped) (target ? target.truncated : truncated).push(r.tool);
  }

  const streamsState = {};
  for (const r of results) streamsState[r.id] = r.ok ? { syncedAt: r.syncedAt } : (incremental ? prev.streams[r.id] : null) || {};
  const capped = results.some((r) => r.capped);
  // When every stream was last re-read in full. A capped read leaves a gap, so force another.
  let fullAt = now;
  if (capped) fullAt = 0;
  else if (incremental) fullAt = prev.fullAt;
  return {
    mode: enterprise ? 'enterprise' : 'orgs',
    enterprise: enterprise || null,
    lookbackDays: dc.lookbackDays,
    tools,
    errors,
    truncated,
    orgs: [...orgs.values()].sort((a, b) => a.org.localeCompare(b.org)),
    _sync: { fingerprint, fullAt, streams: streamsState, hidden: Object.fromEntries(hidden) },
  };
}

module.exports = { collect };
