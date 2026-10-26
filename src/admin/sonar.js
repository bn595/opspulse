'use strict';
// SonarQube Cloud admin tools: gather what a preview needs, then apply the rows the user confirmed.
// Every change is written as an audit log event. Changes run `concurrency` at a time; on a rate limit
// the row is retried after the block ends and the concurrency halves.
//   tools: keys | drift | pattern | delete | longlived
//
// Reads use Web API v2 where it exists (organizations, project listing, key existence); everything
// else is only available in Web API v1. docs/sonar-api.md lists each call and its version.

const { request, RateLimitError } = require('../http');
const plan = require('./plan');

const PAGE_V2 = 5000; // v2 project listing maximum
const CHUNK = 100; // project keys per v2 request

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

// Web API v2 host for a SonarQube Cloud URL: https://sonarqube.us -> https://api.sonarqube.us
function apiUrlFor(sonarUrl) {
  const u = new URL(sonarUrl);
  return `${u.protocol}//api.${u.host}`;
}

// Query string with repeated keys for arrays (v2 style: keys=a&keys=b).
function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) q.append(k, x);
  return q;
}

function createSonarAdmin({ sonarUrl, apiUrl = apiUrlFor(sonarUrl), token, actor, log, concurrency = 5, platform = 'sonar', now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = String(sonarUrl).replace(/\/$/, '');
  const apiBase = String(apiUrl).replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  const get = async (path, params) => (await request(`${base}${path}?${query(params)}`, { headers, platform })).data;
  const getV2 = async (path, params = {}) => (await request(`${apiBase}${path}?${query(params)}`, { headers, platform })).data;
  const post = (path, params) => request(`${base}${path}`, {
    method: 'POST', platform, retries: 0,
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const link = (key) => `${base}/project/overview?id=${encodeURIComponent(key)}`;

  // v2 projects are filtered by organization UUID; look it up once per organization key.
  const orgIds = new Map();
  async function orgId(org) {
    if (!orgIds.has(org)) {
      const list = await getV2('/organizations/organizations', { organizationKey: org });
      const o = Array.isArray(list) ? list.find((x) => x.key === org) || list[0] : null;
      if (!o) throw new Error(`organization "${org}" was not found or is not visible to this token`);
      orgIds.set(org, o.uuidV4 || o.id);
    }
    return orgIds.get(org);
  }

  // Projects by name prefix (case-insensitive; '' = all) or by key. Keys that don't exist come back
  // as { key, missing: true } in the order given. v2 has no name search, so prefixes filter locally.
  async function listProjects(org, { prefix = '', keys = null }) {
    const organizationIds = await orgId(org); // the v2 filter takes a list; one organization here
    if (keys) {
      const found = new Map();
      for (const part of chunks(keys, CHUNK)) {
        const d = await getV2('/projects/projects', { organizationIds, keys: part, pageSize: PAGE_V2 });
        for (const c of d.projects || []) found.set(c.key, { key: c.key, name: c.name });
      }
      return keys.map((k) => found.get(k) || { key: k, missing: true });
    }
    const out = [];
    for (let pageIndex = 1; ; pageIndex++) {
      const d = await getV2('/projects/projects', { organizationIds, pageSize: PAGE_V2, pageIndex });
      out.push(...(d.projects || []).map((c) => ({ key: c.key, name: c.name })));
      // Without a total, keep going until a page comes back empty.
      if (!d.projects?.length || (d.page?.total != null && out.length >= d.page.total)) break;
    }
    const lower = prefix.toLowerCase();
    return out.filter((c) => c.name.toLowerCase().startsWith(lower));
  }

  // Keys already taken anywhere in SonarQube Cloud (keys are unique across organizations).
  async function existingKeys(keys) {
    const taken = await mapLimit([...new Set(keys)], concurrency, async (k) => {
      try {
        await getV2(`/projects/project-keys/${encodeURIComponent(k)}`);
        return k;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    });
    return new Set(taken.filter(Boolean));
  }
  // Plans keys twice: once to learn the target keys, then again knowing which of them are taken.
  async function planWithTakenKeys(planFn, projects) {
    const targets = planFn(projects).filter((r) => r.status === 'change').map((r) => r.to);
    return planFn(projects, { existingKeys: await existingKeys(targets) });
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
    if (tool === 'drift') rows = await planWithTakenKeys(plan.findDrift, projects);
    else if (tool === 'keys') rows = await planWithTakenKeys(plan.planKeys, projects);
    else if (tool === 'pattern') rows = plan.planPattern(await withPattern(projects), pattern);
    else if (tool === 'delete') rows = plan.planDelete(await withBranches(projects), branch);
    else if (tool === 'longlived') rows = plan.planLongLived(await withBranches(await withPattern(projects)), pattern, branch);
    else throw new Error(`unknown admin tool "${tool}"`);
    // Keep the order of the input (list order, or the organization's listing order).
    const order = new Map(listed.map((p, i) => [p.key, i]));
    return { rows: [...rows, ...missing].sort((a, b) => order.get(a.project) - order.get(b.project)).map((r) => ({ ...r, org, url: link(r.project), result: null, error: null })) };
  }

  // Performs one row; each step is audited. Throws RateLimitError so the queue can retry the row;
  // steps that already succeeded are skipped on the retry.
  async function applyRow(tool, row, run) {
    const audit = (event, fields, result, error) => log.audit(event, { ...(run ? { run } : {}), actor, org: row.org, project: row.project, ...fields, result, ...(error ? { error } : {}) });
    row.stepsDone = row.stepsDone || [];
    const step = async (event, fields, call) => {
      if (row.stepsDone.includes(event)) return;
      try {
        await call();
        row.stepsDone.push(event);
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
        await step('sonar.branch_deleted', { branch: row.branch, type: row.type, analysisDate: row.analysisDate }, () => post('/api/project_branches/delete', { project: row.project, branch: row.branch }));
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
  // `run` labels the audit events of one run.
  async function apply(tool, rows, { selected = [], run = null, onProgress = () => {} } = {}) {
    const chosen = new Set(selected);
    const out = rows.map((r) => ({ ...r }));
    const todo = out.filter((r) => r.actionable && chosen.has(r.project));
    for (const r of todo) r.result = 'queued';
    let current = concurrency;
    const report = (extra = {}) => onProgress({ rows: out, done: todo.filter((r) => r.result === 'done' || r.result === 'failed').length, total: todo.length, concurrency: current, ...extra });
    await runQueue(todo, async (row) => {
      row.result = 'running';
      report();
      await applyRow(tool, row, run);
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

module.exports = { createSonarAdmin, apiUrlFor };
