'use strict';
// SonarQube Cloud admin tools: gather what a preview needs, then apply the rows the user confirmed.
// Every change is written as an audit log event. Changes run `concurrency` at a time; on a rate limit
// the row is retried after the block ends and the concurrency halves.
//   tools: keys | drift | pattern | delete | longlived
//
// Reads use Web API v2 where it exists (organizations, project listing, key existence); everything
// else is only available in Web API v1. docs/sonar-api.md lists each call and its version.
//
// Keys never go in a URL path: CloudFront in front of SonarQube Cloud refuses paths containing the
// word "admin" (HTML 403), and project keys often contain it.

const { request, RateLimitError } = require('../http');
const plan = require('./plan');

const PAGE_V2 = 5000; // v2 project listing maximum
const CHUNK = 100; // project keys per v2 request
const CHUNK_CHARS = 4000; // and at most this much of them, keeping URLs well under CloudFront's 8 KB
const BINDINGS_PAGE = 50; // v2 repository bindings maximum

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}
// Splits keys into groups of at most CHUNK keys and CHUNK_CHARS characters.
function chunks(keys) {
  const out = [];
  let part = [], size = 0;
  for (const k of keys) {
    if (part.length && (part.length === CHUNK || size + k.length + 1 > CHUNK_CHARS)) { out.push(part); part = []; size = 0; }
    part.push(k);
    size += k.length + 1;
  }
  if (part.length) out.push(part);
  return out;
}

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

// Query string; arrays are comma-separated (SonarQube Cloud keeps only the last of repeated keys).
function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.append(k, [].concat(v).join(','));
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

  // v2 filters projects by organization UUID and bindings by its legacy id; look both up once per key.
  const orgs = new Map();
  async function orgOf(org) {
    if (!orgs.has(org)) {
      const list = await getV2('/organizations/organizations', { organizationKey: org });
      const o = Array.isArray(list) ? list.find((x) => x.key === org) || list[0] : null;
      if (!o) throw new Error(`organization "${org}" was not found or is not visible to this token`);
      orgs.set(org, { uuid: o.uuidV4 || o.id, legacyId: o.id });
    }
    return orgs.get(org);
  }

  // Projects by name prefix (case-insensitive; '' = all) or by key. Keys that don't exist come back
  // as { key, missing: true } in the order given. v2 has no name search, so prefixes filter locally.
  async function listProjects(org, { prefix = '', keys = null }) {
    const organizationIds = (await orgOf(org)).uuid; // the v2 filter takes a list; one organization here
    if (keys) {
      const found = new Map();
      for (const part of chunks(keys)) {
        const d = await getV2('/projects/projects', { organizationIds, keys: part, pageSize: PAGE_V2 });
        for (const c of d.projects || []) found.set(c.key, { key: c.key, name: c.name, legacyId: c.legacyId });
      }
      return keys.map((k) => found.get(k) || { key: k, missing: true });
    }
    const out = [];
    for (let pageIndex = 1; ; pageIndex++) {
      const d = await getV2('/projects/projects', { organizationIds, pageSize: PAGE_V2, pageIndex });
      out.push(...(d.projects || []).map((c) => ({ key: c.key, name: c.name, legacyId: c.legacyId })));
      // Without a total, keep going until a page comes back empty.
      if (!d.projects?.length || (d.page?.total != null && out.length >= d.page.total)) break;
    }
    const lower = prefix.toLowerCase();
    return out.filter((c) => c.name.toLowerCase().startsWith(lower));
  }

  // Keys already taken in any organization the token can see (keys are unique across organizations;
  // a private project elsewhere is invisible, and its conflict shows up when the change is applied).
  async function existingKeys(keys) {
    const taken = new Set();
    for (const part of chunks([...new Set(keys)])) {
      const d = await getV2('/projects/projects', { keys: part, pageSize: CHUNK });
      for (const c of d.projects || []) taken.add(c.key);
    }
    return taken;
  }
  // The repository each project is bound to: project legacyId -> { name, url }. Read for the whole
  // organization; SonarQube Cloud updates a binding when its repository is renamed.
  async function bindingsOf(org) {
    const { legacyId } = await orgOf(org);
    const page = (pageIndex) => getV2('/dop-translation/project-bindings', { organizationId: legacyId, pageSize: BINDINGS_PAGE, pageIndex });
    const first = await page(1);
    let rest;
    if (first.page?.total != null) {
      const pages = Math.ceil(first.page.total / BINDINGS_PAGE);
      rest = await mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), concurrency, page);
    } else {
      rest = []; // without a total, keep going until a page comes back short
      for (let i = 2, last = first; (last.bindings || []).length === BINDINGS_PAGE; i++) rest.push((last = await page(i)));
    }
    const out = new Map();
    for (const d of [first, ...rest]) {
      for (const b of d.bindings || []) if (b.slug) out.set(b.projectId, { name: b.slug.split('/').pop(), url: b.url || null });
    }
    return out;
  }
  async function withRepos(org, projects) {
    const bindings = await bindingsOf(org);
    return projects.map((p) => ({ ...p, repo: bindings.get(p.legacyId) || null }));
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
    if (tool === 'drift') rows = await planWithTakenKeys(plan.findDrift, await withRepos(org, projects));
    else if (tool === 'keys') rows = await planWithTakenKeys(plan.planKeys, await withRepos(org, projects));
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
  async function applyRow(tool, row, { run, stepsDone }) {
    const audit = (event, fields, result, error) => log.audit(event, { ...(run ? { run } : {}), actor, org: row.org, project: row.project, ...fields, result, ...(error ? { error } : {}) });
    const step = async (event, fields, call) => {
      if (stepsDone.has(event)) return;
      try {
        await call();
        stepsDone.add(event);
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
    const stepsDone = new Map(todo.map((r) => [r, new Set()])); // kept off the rows, which are sent to the browser
    let current = concurrency;
    const report = (extra = {}) => onProgress({ rows: out, done: todo.filter((r) => r.result === 'done' || r.result === 'failed').length, total: todo.length, concurrency: current, ...extra });
    await runQueue(todo, async (row) => {
      row.result = 'running';
      report();
      await applyRow(tool, row, { run, stepsDone: stepsDone.get(row) });
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
