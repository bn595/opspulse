'use strict';
// SonarQube Cloud admin tools: gather what a preview needs, then apply the rows the user confirmed.
// Every change is written as an audit log event. Changes run `concurrency` at a time; on a rate limit
// the row is retried after the block ends and the concurrency halves.
//   tools: keys | drift | pattern | delete | longlived

const { request, RateLimitError } = require('../http');
const plan = require('./plan');

const PAGE = 500;
const CHUNK = 50; // project keys per search request

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// Runs fn over items `concurrency` at a time. fn rethrows RateLimitError and handles everything
// else itself; a rate-limited item goes back to the front of the queue.
async function runQueue(items, fn, { concurrency, now, wait, onPause }) {
  const queue = [...items];
  const running = new Set();
  let limit = Math.max(1, concurrency);
  let pausedUntil = 0;
  while (queue.length || running.size) {
    while (queue.length && running.size < limit && now() >= pausedUntil) {
      const item = queue.shift();
      const task = Promise.resolve()
        .then(() => fn(item))
        .catch((e) => {
          if (!(e instanceof RateLimitError)) throw e;
          queue.unshift(item);
          limit = Math.max(1, Math.floor(limit / 2));
          pausedUntil = Math.max(pausedUntil, e.retryAt);
          onPause(pausedUntil, limit);
        })
        .finally(() => running.delete(task));
      running.add(task);
    }
    if (running.size) await Promise.race(running);
    else if (queue.length) await wait(pausedUntil - now());
  }
  return limit;
}

function createSonarAdmin({ sonarUrl, token, actor, log, concurrency = 5, platform = 'sonar', now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = String(sonarUrl).replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  const get = async (path, params) => (await request(`${base}${path}?${new URLSearchParams(params)}`, { headers, platform })).data;
  const post = (path, params) => request(`${base}${path}`, {
    method: 'POST', platform, retries: 0,
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const link = (key) => `${base}/project/overview?id=${encodeURIComponent(key)}`;

  // Projects by name prefix (case-insensitive; '' = all) or by key. Keys that don't exist come back
  // as { key, missing: true } in the order given.
  async function listProjects(org, { prefix = '', keys = null }) {
    if (keys) {
      const found = new Map();
      for (const part of chunks(keys, CHUNK)) {
        const d = await get('/api/projects/search', { organization: org, projects: part.join(','), ps: PAGE });
        for (const c of d.components || []) found.set(c.key, { key: c.key, name: c.name });
      }
      return keys.map((k) => found.get(k) || { key: k, missing: true });
    }
    const out = [];
    for (let p = 1; ; p++) {
      const d = await get('/api/projects/search', { organization: org, ps: PAGE, p, ...(prefix.length >= 2 ? { q: prefix } : {}) });
      out.push(...(d.components || []).map((c) => ({ key: c.key, name: c.name })));
      if (!d.components?.length || out.length >= (d.paging?.total ?? 0)) break;
    }
    const lower = prefix.toLowerCase();
    return out.filter((c) => c.name.toLowerCase().startsWith(lower));
  }

  async function existingKeys(org, keys) {
    const found = new Set();
    for (const part of chunks([...new Set(keys)], CHUNK)) {
      const d = await get('/api/projects/search', { organization: org, projects: part.join(','), ps: PAGE });
      for (const c of d.components || []) found.add(c.key);
    }
    return found;
  }

  const withPattern = (projects) => mapLimit(projects, concurrency, async (p) => {
    const d = await get('/api/settings/values', { component: p.key, keys: plan.PATTERN_SETTING });
    const s = (d.settings || []).find((x) => x.key === plan.PATTERN_SETTING) || {};
    return { ...p, pattern: s.value ?? null, inherited: s.inherited !== false };
  });
  const withBranches = (projects) => mapLimit(projects, concurrency, async (p) => {
    const d = await get('/api/project_branches/list', { project: p.key });
    return { ...p, branches: d.branches || [] };
  });

  // params: { org, prefix?, keys?, pattern?, branch? } -> { rows }
  async function preview(tool, { org, prefix = '', keys = null, pattern, branch }) {
    if (!org) throw new Error('org is required');
    const listed = tool === 'drift' ? await listProjects(org, {}) : await listProjects(org, { prefix, keys });
    const projects = listed.filter((p) => !p.missing);
    const missing = listed.filter((p) => p.missing).map((p) => ({ project: p.key, name: null, status: 'not-found', actionable: false }));
    let rows;
    if (tool === 'drift') rows = plan.findDrift(projects);
    else if (tool === 'keys') {
      const draft = plan.planKeys(projects);
      const targets = draft.filter((r) => r.status === 'change').map((r) => r.to);
      rows = plan.planKeys(projects, { existingKeys: await existingKeys(org, targets) });
    } else if (tool === 'pattern') rows = plan.planPattern(await withPattern(projects), pattern);
    else if (tool === 'delete') rows = plan.planDelete(await withBranches(projects), branch);
    else if (tool === 'longlived') rows = plan.planLongLived(await withBranches(await withPattern(projects)), pattern, branch);
    else throw new Error(`unknown admin tool "${tool}"`);
    // Keep the order of the input (list order, or the organization's listing order).
    const order = new Map(listed.map((p, i) => [p.key, i]));
    return { rows: [...rows, ...missing].sort((a, b) => order.get(a.project) - order.get(b.project)).map((r) => ({ ...r, org, url: link(r.project), result: null, error: null })) };
  }

  // Performs one row; each step is audited. Throws RateLimitError so the queue can retry the row.
  async function applyRow(tool, row) {
    const audit = (event, fields, result, error) => log.audit(event, { actor, org: row.org, project: row.project, ...fields, result, ...(error ? { error } : {}) });
    const step = async (event, fields, call) => {
      try {
        await call();
        audit(event, fields, 'done');
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
        audit(event, fields, 'failed', e.message);
        throw Object.assign(new Error(e.message), { failedStep: true });
      }
    };
    try {
      if (tool === 'keys' || tool === 'drift') {
        await step('sonar.key_updated', { from: row.from, to: row.to }, () => post('/api/projects/update_key', { from: row.from, to: row.to }));
        row.url = link(row.to);
      }
      if (tool === 'pattern' || (tool === 'longlived' && row.setPattern)) {
        await step('sonar.branch_pattern_set', { from: row.from, to: row.to }, () => post('/api/settings/set', { component: row.project, key: plan.PATTERN_SETTING, value: row.to }));
      }
      if (tool === 'delete' || (tool === 'longlived' && row.deleteBranch)) {
        await step('sonar.branch_deleted', { branch: row.branch }, () => post('/api/project_branches/delete', { project: row.project, branch: row.branch }));
      }
      row.result = 'done';
      row.error = null;
    } catch (e) {
      if (e instanceof RateLimitError) {
        row.result = 'waiting';
        throw e;
      }
      row.result = 'failed';
      row.error = e.message;
    }
  }

  // Applies the actionable rows whose project is in `selected`; returns all rows with results.
  async function apply(tool, rows, { selected = [], onProgress = () => {} } = {}) {
    const chosen = new Set(selected);
    const out = rows.map((r) => ({ ...r }));
    const todo = out.filter((r) => r.actionable && chosen.has(r.project));
    for (const r of todo) r.result = 'queued';
    let current = concurrency;
    const report = (extra = {}) => onProgress({ rows: out, done: todo.filter((r) => r.result === 'done' || r.result === 'failed').length, total: todo.length, concurrency: current, ...extra });
    await runQueue(todo, async (row) => {
      row.result = 'running';
      report();
      await applyRow(tool, row);
      report();
    }, {
      concurrency, now, wait,
      onPause: (until, limit) => { current = limit; report({ waitingUntil: until }); },
    });
    report({ finished: true });
    return out;
  }

  return { preview, apply };
}

module.exports = { createSonarAdmin };
