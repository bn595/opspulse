'use strict';
// Builds the attention feed from connector results.
// Item: { id, level: critical|warn|info, source, title, detail, url }

const H = 3600e3;
const D = 86400e3;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function plural(n, word, many) { return `${n} ${n === 1 ? word : many || word + 's'}`; }
function ago(ms) {
  const h = ms / H;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function actionsItems(src, cfg, now) {
  const ac = cfg.github.actions;
  const out = [];
  const win = ac.feedWindowHours * H;
  for (const repo of src.data.repos) {
    if (repo.error) {
      out.push({ id: `act-err-${repo.repo}`, level: 'critical', source: 'actions', title: `Can't read ${repo.label}`, detail: repo.error });
      continue;
    }
    for (const wf of repo.workflows) {
      const recent = wf.runs.filter((r) => now - Date.parse(r.created) <= win);
      const fails = recent.filter((r) => FAILED.has(r.conclusion));
      const last = wf.runs.find((r) => r.status === 'completed');
      if (fails.length >= ac.failureWarn) {
        const level = fails.length >= ac.failureCritical ? 'critical' : 'warn';
        const stillFailing = last && FAILED.has(last.conclusion);
        out.push({
          id: `act-fail-${repo.repo}-${wf.id}`,
          level,
          source: 'actions',
          title: `${plural(fails.length, 'failure')} in ${wf.name} in the last ${ac.feedWindowHours}h`,
          detail: `${repo.label} · ${recent.length} runs, ${stillFailing ? 'latest run failed' : 'latest run recovered'}`,
          url: fails[0].url,
          count: fails.length,
        });
      } else if (last && FAILED.has(last.conclusion)) {
        out.push({
          id: `act-last-${repo.repo}-${wf.id}`,
          level: 'warn',
          source: 'actions',
          title: `${wf.name} is failing`,
          detail: `${repo.label} · latest run #${last.n} failed ${ago(now - Date.parse(last.created))} ago`,
          url: last.url,
        });
      }
      if (wf.expectEveryHours && wf.state === 'active') {
        const lr = wf.lastRun ? Date.parse(wf.lastRun.created) : 0;
        if (now - lr > wf.expectEveryHours * H) {
          out.push({
            id: `act-quiet-${repo.repo}-${wf.id}`,
            level: 'warn',
            source: 'actions',
            title: `${wf.name} hasn't run in ${lr ? ago(now - lr) : 'a long time'}`,
            detail: `${repo.label} · expected every ${wf.expectEveryHours}h`,
            url: wf.url,
          });
        }
      }
      if (wf.state && wf.state !== 'active') {
        out.push({ id: `act-off-${repo.repo}-${wf.id}`, level: 'info', source: 'actions', title: `${wf.name} is ${wf.state.replace(/_/g, ' ')}`, detail: repo.label, url: wf.url });
      }
    }
  }
  return out;
}

function jiraItems(src, cfg, now) {
  const jc = cfg.jira;
  const out = [];
  const open = src.data.issues.filter((i) => i.category !== 'done');
  const search = src.data.searchUrl;

  const fresh = src.data.issues.filter((i) => now - Date.parse(i.created) <= jc.newWindowHours * H);
  if (fresh.length) {
    out.push({ id: 'jira-new', level: 'info', source: 'jira', title: `${plural(fresh.length, 'new ticket')} in the last ${jc.newWindowHours}h`, detail: fresh.slice(0, 3).map((i) => i.key).join(', ') + (fresh.length > 3 ? '…' : ''), url: search });
  }
  const stale = open.filter((i) => now - Date.parse(i.updated) > jc.staleDays * D);
  if (stale.length) {
    out.push({ id: 'jira-stale', level: stale.length >= 10 ? 'critical' : 'warn', source: 'jira', title: `${plural(stale.length, 'open ticket')} untouched for ${jc.staleDays}+ days`, detail: `oldest: ${stale.sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated))[0].key}`, url: search, count: stale.length });
  }
  const unassigned = open.filter((i) => !i.assignee);
  if (unassigned.length >= jc.unassignedWarn) {
    out.push({ id: 'jira-unassigned', level: 'warn', source: 'jira', title: `${plural(unassigned.length, 'open ticket')} with no assignee`, detail: unassigned.slice(0, 3).map((i) => i.key).join(', ') + (unassigned.length > 3 ? '…' : ''), url: search, count: unassigned.length });
  }
  for (const rule of jc.statusRules || []) {
    const hits = open.filter((i) => i.status.toLowerCase() === String(rule.status).toLowerCase() && now - Date.parse(i.statusSince || i.updated) > (rule.olderThanHours ?? (rule.olderThanDays || 0) * 24) * H);
    if (hits.length >= (rule.minCount || 1)) {
      const age = rule.olderThanHours ? `${rule.olderThanHours}h` : `${rule.olderThanDays}d`;
      out.push({ id: `jira-rule-${rule.status}`, level: rule.level || 'warn', source: 'jira', title: `${plural(hits.length, 'ticket')} in “${rule.status}” for over ${age}`, detail: hits.slice(0, 3).map((i) => i.key).join(', ') + (hits.length > 3 ? '…' : ''), url: search, count: hits.length });
    }
  }
  return out;
}

function sonarItems(src, cfg, now) {
  const out = [];
  for (const t of src.data.tokens || []) {
    if (!t.expirationDate) continue;
    const left = Date.parse(t.expirationDate) - now;
    if (left < cfg.sonar.tokenExpiryWarnDays * D) {
      out.push({ id: `sonar-tok-${t.name}`, level: left < 3 * D ? 'critical' : 'warn', source: 'sonar', title: left < 0 ? `Sonar token “${t.name}” has expired` : `Sonar token “${t.name}” expires in ${ago(left)}`, detail: 'Rotate it before the permission jobs start failing', url: `${src.data.url}/account/security` });
    }
  }
  return out;
}

function dismissalItems(src, cfg) {
  const dc = cfg.github.dismissals;
  if (!dc.feed) return [];
  return src.data.orgs
    .filter((o) => o.items.length >= dc.feedWarnCount)
    .map((o) => ({ id: `ghas-${o.org}`, level: 'info', source: 'ghas', title: `${o.items.length} GHAS dismissals in ${o.org} over ${dc.lookbackDays}d`, detail: 'Above the configured review threshold' }));
}

const BUILDERS = { actions: actionsItems, jira: jiraItems, sonar: sonarItems, dismissals: dismissalItems };
const LABEL = { actions: 'GitHub Actions', jira: 'Jira', sonar: 'SonarQube Cloud', dismissals: 'GHAS' };
const RANK = { critical: 0, warn: 1, info: 2 };

function build(sources, cfg, now = Date.now(), extra = []) {
  const items = [...extra];
  for (const [key, src] of Object.entries(sources)) {
    if (src.status === 'disabled') continue;
    const plugin = key.startsWith('plugin:');
    const label = plugin ? src.title || key.slice(7) : LABEL[key];
    const source = plugin ? key.slice(7) : key === 'dismissals' ? 'ghas' : key;
    // A pending Key Vault sign-in is reported once by the secrets item.
    if (src.error && !/waiting for key vault sign-in/i.test(src.error)) {
      items.push({ id: `src-${key}`, level: 'critical', source, title: `${label} refresh failed`, detail: src.error });
    }
    if (src.data) {
      try { items.push(...(plugin ? src.data.feed || [] : BUILDERS[key](src, cfg, now))); } catch (e) { items.push({ id: `feed-${key}`, level: 'warn', source, title: `Couldn't evaluate ${label} rules`, detail: e.message }); }
    }
  }
  return items.sort((a, b) => RANK[a.level] - RANK[b.level] || (b.count || 0) - (a.count || 0));
}

module.exports = { build };
