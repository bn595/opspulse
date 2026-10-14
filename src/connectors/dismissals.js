'use strict';
// GitHub Advanced Security alert dismissals per organization.

const { nextLink, RateLimitError } = require('../http');
const { gh } = require('./actions');
const rules = require('../rules');

const TOOLS = {
  'code-scanning': {
    path: (org) => `/orgs/${org}/code-scanning/alerts?state=dismissed&sort=updated&direction=desc&per_page=100`,
    map: (a) => ({
      at: a.dismissed_at,
      by: a.dismissed_by?.login || null,
      reason: a.dismissed_reason || 'unspecified',
      comment: a.dismissed_comment || '',
      repo: a.repository?.full_name,
      title: a.rule?.description || a.rule?.id || 'Code scanning alert',
      severity: a.rule?.security_severity_level || a.rule?.severity || null,
      ruleId: a.rule?.id || null,
      toolName: a.tool?.name || null,
      url: a.html_url,
    }),
  },
  'secret-scanning': {
    path: (org) => `/orgs/${org}/secret-scanning/alerts?state=resolved&sort=updated&direction=desc&per_page=100`,
    map: (a) => ({
      at: a.resolved_at,
      by: a.resolved_by?.login || null,
      reason: a.resolution || 'unspecified',
      comment: a.resolution_comment || '',
      repo: a.repository?.full_name,
      title: a.secret_type_display_name || a.secret_type || 'Secret',
      severity: null,
      secretType: a.secret_type || null,
      validity: a.validity || null,
      url: a.html_url,
    }),
  },
  dependabot: {
    path: (org) => `/orgs/${org}/dependabot/alerts?state=dismissed&sort=updated&direction=desc&per_page=100`,
    map: (a) => ({
      at: a.dismissed_at,
      by: a.dismissed_by?.login || null,
      reason: a.dismissed_reason || 'unspecified',
      comment: a.dismissed_comment || '',
      repo: a.repository?.full_name,
      title: a.security_advisory?.summary || a.dependency?.package?.name || 'Dependabot alert',
      severity: a.security_vulnerability?.severity || a.security_advisory?.severity || null,
      package: a.dependency?.package?.name || null,
      ecosystem: a.dependency?.package?.ecosystem || null,
      url: a.html_url,
    }),
  },
};

async function fetchTool(api, org, tool, dc, sinceMs, filter) {
  const def = TOOLS[tool];
  const out = [];
  let url = def.path(org);
  let pages = 0;
  let truncated = false;
  while (url) {
    const res = await api.get(url);
    const items = Array.isArray(res.data) ? res.data : [];
    let olderSeen = false;
    for (const a of items) {
      // Sorted by updated_at desc, and dismissing an alert updates it, so stop at the window edge.
      if (Date.parse(a.updated_at) < sinceMs) { olderSeen = true; break; }
      if (tool === 'secret-scanning' && !dc.secretResolutions.includes(a.resolution)) continue;
      const d = { tool, org, ...def.map(a) };
      if (!d.at || Date.parse(d.at) < sinceMs) continue;
      if (!filter.keep({ ...d, raw: a })) continue;
      out.push(d);
    }
    if (olderSeen) break;
    url = nextLink(res.headers);
    if (url && ++pages >= dc.maxPagesPerTool) { truncated = true; break; }
  }
  return { items: out, truncated };
}

async function collect(cfg, secrets) {
  const dc = cfg.github.dismissals;
  if (!secrets.github) throw new Error('No GitHub token configured (github.token)');
  if (!dc.orgs.length) throw new Error('No orgs listed under github.dismissals.orgs');
  const api = gh(cfg, secrets.github);
  const sinceMs = Date.now() - dc.lookbackDays * 86400e3;
  const filters = dc.orgs.map(() => rules.filter(dc, 'github.dismissals'));

  const orgs = await Promise.all(
    dc.orgs.map(async (org, i) => {
      const result = { org, items: [], errors: {}, truncated: [], hidden: 0 };
      await Promise.all(
        dc.tools.filter((t) => TOOLS[t]).map(async (tool) => {
          try {
            const r = await fetchTool(api, org, tool, dc, sinceMs, filters[i]);
            result.items.push(...r.items);
            if (r.truncated) result.truncated.push(tool);
          } catch (e) {
            if (e instanceof RateLimitError) throw e;
            result.errors[tool] = e.message;
          }
        })
      );
      result.items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      result.hidden = filters[i].hidden;
      return result;
    })
  );
  const allFailed = orgs.every((o) => Object.keys(o.errors).length === dc.tools.length);
  if (allFailed) throw new Error(Object.values(orgs[0].errors)[0]);
  return { lookbackDays: dc.lookbackDays, tools: dc.tools, orgs };
}

module.exports = { collect };
