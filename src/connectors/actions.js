'use strict';
// GitHub Actions workflow runs for the configured repositories.

const { request, nextLink } = require('../http');
const rules = require('../rules');

function gh(cfg, token) {
  const base = cfg.github.apiUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return {
    base,
    get: (p) => request(p.startsWith('http') ? p : base + p, { headers, platform: 'github' }),
  };
}

function compactRun(r) {
  const start = Date.parse(r.run_started_at || r.created_at);
  const end = Date.parse(r.updated_at);
  return {
    id: r.id,
    n: r.run_number,
    attempt: r.run_attempt,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    branch: r.head_branch,
    actor: r.triggering_actor?.login || r.actor?.login || null,
    created: r.created_at,
    durationSec: r.status === 'completed' && end > start ? Math.round((end - start) / 1000) : null,
    url: r.html_url,
  };
}

function wanted(filter, wf) {
  if (!filter || filter.length === 0 || filter.includes('*')) return true;
  const file = wf.path.split('/').pop();
  return filter.some((f) => f === wf.name || f === file || f === wf.path || String(f) === String(wf.id));
}

async function fetchRepo(api, entry, ac, keep) {
  const repo = entry.repo;
  let hidden = 0;
  const since = new Date(Date.now() - ac.lookbackHours * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const wfRes = await api.get(`/repos/${repo}/actions/workflows?per_page=100`);
  const workflows = (wfRes.data.workflows || [])
    .filter((w) => entry.includeDynamic || !String(w.path).startsWith('dynamic/'))
    .filter((w) => wanted(entry.workflows, w));
  const byId = new Map(workflows.map((w) => [w.id, { id: w.id, name: w.name, path: w.path, state: w.state, url: w.html_url, runs: [], lastRun: null }]));

  let url = `/repos/${repo}/actions/runs?per_page=100&exclude_pull_requests=true&created=${encodeURIComponent('>=' + since)}`;
  let fetched = 0;
  let truncated = false;
  while (url) {
    const res = await api.get(url);
    for (const r of res.data.workflow_runs || []) {
      fetched++;
      const wf = byId.get(r.workflow_id);
      if (!wf || (entry.branch && r.head_branch !== entry.branch)) continue;
      const run = compactRun(r);
      if (keep && !keep({ ...run, repo, workflow: wf.name, raw: r })) { hidden++; continue; }
      wf.runs.push(run);
    }
    url = nextLink(res.headers);
    if (url && fetched >= ac.maxRunsPerRepo) { truncated = true; break; }
  }

  // Workflows with no runs in the window: fetch the latest run for an accurate "last run".
  const quiet = [...byId.values()].filter((w) => w.runs.length === 0 && w.state === 'active').slice(0, 40);
  await Promise.all(
    quiet.map(async (w) => {
      try {
        const res = await api.get(`/repos/${repo}/actions/workflows/${w.id}/runs?per_page=1&exclude_pull_requests=true`);
        const r = res.data.workflow_runs?.[0];
        if (r) w.lastRun = compactRun(r);
      } catch { /* non-fatal */ }
    })
  );
  for (const w of byId.values()) {
    w.runs.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
    if (!w.lastRun && w.runs[0]) w.lastRun = w.runs[0];
    w.expectEveryHours = entry.expectEveryHours?.[w.name] ?? entry.expectEveryHours?.[w.path.split('/').pop()] ?? null;
  }

  return {
    repo,
    label: entry.label || repo,
    url: `${api.base.includes('api.github.com') ? 'https://github.com' : api.base.replace(/\/api\/v3$/, '')}/${repo}/actions`,
    truncated,
    hidden,
    workflows: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function collect(cfg, secrets) {
  const ac = cfg.github.actions;
  if (!secrets.github) throw new Error('No GitHub token configured (github.token)');
  if (!ac.repos.length) throw new Error('No repos listed under github.actions.repos');
  const api = gh(cfg, secrets.github);
  const keep = rules.compile(ac, 'github.actions');
  const repos = await Promise.all(
    ac.repos.map(async (entry) => {
      try {
        return await fetchRepo(api, entry, ac, keep);
      } catch (e) {
        return { repo: entry.repo, label: entry.label || entry.repo, error: e.message, workflows: [] };
      }
    })
  );
  if (repos.every((r) => r.error)) throw new Error(repos[0].error);
  return { lookbackHours: ac.lookbackHours, repos };
}

module.exports = { collect, gh };
