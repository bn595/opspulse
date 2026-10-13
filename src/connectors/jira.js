'use strict';
// Jira issues for one JQL query. Cloud uses /rest/api/3/search/jql (token pagination);
// Data Center uses /rest/api/2/search with a bearer PAT.

const { request } = require('../http');
const rules = require('../rules');

const FIELDS = ['summary', 'status', 'assignee', 'reporter', 'priority', 'issuetype', 'created', 'updated', 'statuscategorychangedate', 'resolutiondate', 'labels'];

function compact(base, i) {
  const f = i.fields || {};
  return {
    key: i.key,
    url: `${base}/browse/${i.key}`,
    summary: f.summary || '',
    status: f.status?.name || 'Unknown',
    category: f.status?.statusCategory?.key || 'indeterminate', // new | indeterminate | done
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    priority: f.priority?.name || null,
    type: f.issuetype?.name || null,
    created: f.created,
    updated: f.updated,
    statusSince: f.statuscategorychangedate || null,
    resolved: f.resolutiondate || null,
    labels: f.labels || [],
  };
}

async function collect(cfg, secrets) {
  const jc = cfg.jira;
  if (!jc.baseUrl) throw new Error('jira.baseUrl is not set');
  if (!jc.jql) throw new Error('jira.jql is not set');
  if (!secrets.jira) throw new Error('No Jira token configured (jira.token)');
  const base = jc.baseUrl.replace(/\/$/, '');
  const cloud = jc.deployment !== 'datacenter';
  if (cloud && !secrets.jiraEmail) throw new Error('Jira Cloud needs jira.email alongside the API token');

  const headers = cloud
    ? { Authorization: 'Basic ' + Buffer.from(`${secrets.jiraEmail}:${secrets.jira}`).toString('base64') }
    : { Authorization: `Bearer ${secrets.jira}` };

  // Invalid credentials are treated as anonymous and return no issues, so verify auth first.
  try {
    await request(`${base}/rest/api/${cloud ? 3 : 2}/myself`, { headers, retries: 0, platform: 'jira' });
  } catch (e) {
    throw new Error(e.status === 401 || e.status === 403 || e.status === 404 ? `Jira rejected the credentials (${e.status}) — check jira.email / jira.token` : e.message);
  }

  const keep = rules.compile(jc, 'jira');
  let hidden = 0;
  const add = (i) => {
    const c = compact(base, i);
    if (keep && !keep({ ...c, raw: i })) { hidden++; return; }
    issues.push(c);
  };
  const issues = [];
  let truncated = false;
  if (cloud) {
    let token = null;
    do {
      const qs = new URLSearchParams({ jql: jc.jql, maxResults: '100', fields: FIELDS.join(',') });
      if (token) qs.set('nextPageToken', token);
      const { data } = await request(`${base}/rest/api/3/search/jql?${qs}`, { headers, platform: 'jira' });
      for (const i of data.issues || []) add(i);
      token = data.isLast === false || data.nextPageToken ? data.nextPageToken : null;
      if (token && issues.length >= jc.maxIssues) { truncated = true; break; }
    } while (token);
  } else {
    let startAt = 0;
    for (;;) {
      const qs = new URLSearchParams({ jql: jc.jql, maxResults: '100', startAt: String(startAt), fields: FIELDS.join(',') });
      const { data } = await request(`${base}/rest/api/2/search?${qs}`, { headers, platform: 'jira' });
      const page = data.issues || [];
      for (const i of page) add(i);
      startAt += page.length;
      if (!page.length || startAt >= (data.total ?? 0)) break;
      if (issues.length >= jc.maxIssues) { truncated = true; break; }
    }
  }

  return {
    baseUrl: base,
    jql: jc.jql,
    lookbackDays: jc.lookbackDays,
    staleDays: jc.staleDays,
    truncated,
    hidden,
    searchUrl: `${base}/issues/?jql=${encodeURIComponent(jc.jql)}`,
    issues,
  };
}

module.exports = { collect };
