'use strict';
// SonarQube Cloud token health and per-organization project counts.
// Sub-calls fail individually; a missing permission shows "n/a" for that value only.

const { request, RateLimitError } = require('../http');

async function collect(cfg, secrets) {
  const sc = cfg.sonar;
  if (!secrets.sonar) throw new Error('No SonarQube Cloud token configured (sonar.token)');
  const base = sc.url.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${secrets.sonar}` };
  const get = (p) => request(base + p, { headers, platform: 'sonar' }).then((r) => r.data);
  const total = (p) => get(p).then((d) => d?.paging?.total ?? d?.total ?? null);
  // A count that fails shows n/a; a rate limit fails the whole source so it is retried later.
  const soft = (p) => p.then((v) => ({ v }), (e) => { if (e instanceof RateLimitError) throw e; return { err: e.message }; });

  const valid = await get('/api/authentication/validate');
  if (!valid?.valid) throw new Error('SonarQube Cloud says the token is not valid');

  let orgKeys = sc.organizations;
  if (!orgKeys.length) {
    orgKeys = [];
    for (let page = 1; ; page++) {
      const r = await get(`/api/organizations/search?member=true&ps=100&p=${page}`);
      orgKeys.push(...(r.organizations || []).map((o) => o.key));
      if (!r.organizations?.length || orgKeys.length >= (r.paging?.total ?? 0)) break;
    }
  }

  const staleDate = new Date(Date.now() - sc.staleDays * 86400e3).toISOString().slice(0, 10);
  const orgs = await Promise.all(
    orgKeys.map(async (key) => {
      const o = encodeURIComponent(key);
      const [projects, stale, neverAnalyzed, failingGate] = await Promise.all([
        soft(total(`/api/projects/search?organization=${o}&ps=1`)),
        soft(total(`/api/projects/search?organization=${o}&ps=1&analyzedBefore=${staleDate}`)),
        soft(total(`/api/projects/search?organization=${o}&ps=1&onProvisionedOnly=true`)),
        soft(total(`/api/components/search_projects?organization=${o}&ps=1&filter=${encodeURIComponent('alert_status = ERROR')}`)),
      ]);
      return { key, url: `${base}/organizations/${o}`, projects, stale, neverAnalyzed, failingGate };
    })
  );

  // Used to warn about upcoming token expiry.
  let tokens = null;
  try {
    const t = await get('/api/user_tokens/search');
    tokens = (t.userTokens || []).map((x) => ({
      name: x.name,
      createdAt: x.createdAt || null,
      lastConnectionDate: x.lastConnectionDate || null,
      expirationDate: x.expirationDate || null,
    }));
  } catch { /* optional */ }

  return { url: base, staleDays: sc.staleDays, tokenExpiryWarnDays: sc.tokenExpiryWarnDays, orgs, tokens };
}

module.exports = { collect };
