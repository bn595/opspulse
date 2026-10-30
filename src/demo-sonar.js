'use strict';
// An in-process stand-in for the SonarQube Cloud admin endpoints, used by --demo so the admin tools
// can be tried without touching a real instance. State changes persist until the process exits.

const http = require('http');

function seedProjects() {
  const repos = ['payments-api', 'web-portal', 'portal', 'auth-service', 'data-pipeline', 'mobile-app', 'infra-tf', 'search', 'billing', 'notifications',
    'reporting', 'gateway', 'catalog', 'inventory', 'checkout', 'pricing', 'ledger', 'identity', 'scheduler', 'exporter', 'importer', 'metrics', 'alerts', 'docs'];
  // Repositories renamed since their project was created (SonarQube Cloud renames the project too).
  const renamed = { 'payments-api': 'payments-service', 'web-portal': 'portal', 'data-pipeline': 'data-platform', search: 'search-v2', gateway: 'api-gateway', ledger: 'ledger-core' };
  // Project names set by hand, which no longer say which repository it is.
  const named = { reporting: 'reporting-dashboard', inventory: 'inventory', billing: 'Legacy Billing' };
  const repoOf = { inventory: 'inventory-service' }; // renamed, but the project name was set by hand
  const projects = repos.map((r) => {
    const repo = r === 'billing' ? null : repoOf[r] || renamed[r] || r;
    return { org: 'acme', key: `Acme-Corp_${r}`, name: named[r] || renamed[r] || r, repo: repo && `Acme-Corp/${repo}` };
  });
  projects.push({ org: 'acme', key: 'legacyreports', name: 'reports', repo: null });
  // Analyzed from CI without a binding, so named after the key; one of them was renamed since.
  projects.push({ org: 'acme', key: 'Acme-Corp_events', name: 'Acme-Corp_events', repo: null }, { org: 'acme', key: 'Acme-Corp_jobs', name: 'Acme-Corp_job-runner', repo: null });
  projects.push(...['tools', 'sandbox', 'experiments'].map((r) => {
    const name = r === 'sandbox' ? 'playground' : r;
    return { org: 'acme-labs', key: `acme-labs_${r}`, name, repo: `acme-labs/${name}` };
  }));
  return projects.map((p) => ({ ...p, legacyId: `L-${p.key}` }));
}

function startDemoSonar() {
  const projects = seedProjects();
  const branches = {};
  const patterns = { 'Acme-Corp_ledger': 'main|release-.*' };
  projects.forEach((p, i) => {
    branches[p.key] = [{ name: 'main', isMain: true, type: 'LONG', analysisDate: new Date(Date.now() - i * 3600e3).toISOString() }];
    if (i % 2 === 0) branches[p.key].push({ name: 'dev', isMain: false, type: 'SHORT', analysisDate: new Date(Date.now() - i * 7200e3).toISOString() });
    if (i % 5 === 0) branches[p.key].push({ name: 'release-1', isMain: false, type: 'LONG', analysisDate: new Date(Date.now() - 86400e3).toISOString() });
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const q = req.method === 'POST' ? new URLSearchParams(body) : u.searchParams;
      const send = (status, data) => setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === '' ? '' : JSON.stringify(data)); }, req.method === 'POST' ? 250 : 30);
      const find = (key) => projects.find((p) => p.key === key);
      // Like SonarQube Cloud's CloudFront: API paths containing the word "admin" are refused.
      if (/admin(?![a-z])/i.test(decodeURIComponent(u.pathname))) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<HTML><TITLE>ERROR</TITLE></HTML>'); }
      // Web API v2 reads used by the admin tools.
      if (u.pathname === '/organizations/organizations') {
        const key = q.get('organizationKey');
        return send(200, projects.some((p) => p.org === key) ? [{ key, id: `demo-${key}`, uuidV4: `uuid-${key}` }] : []);
      }
      if (u.pathname === '/projects/projects') {
        // Lists are comma-separated; a repeated parameter keeps only its last value.
        const listParam = (name) => (q.get(name) === null ? [] : q.getAll(name).at(-1).split(',').filter(Boolean));
        const orgs = listParam('organizationIds').map((id) => id.replace(/^uuid-/, ''));
        const keys = listParam('keys');
        let list = projects.filter((p) => !orgs.length || orgs.includes(p.org));
        if (keys.length) list = list.filter((p) => keys.includes(p.key));
        const size = Number(q.get('pageSize') || 50), page = Number(q.get('pageIndex') || 1);
        return send(200, { projects: list.slice((page - 1) * size, page * size).map((p) => ({ key: p.key, name: p.name, legacyId: p.legacyId, organizationId: `uuid-${p.org}` })), page: { pageIndex: page, pageSize: size, total: list.length } });
      }
      if (u.pathname === '/dop-translation/project-bindings') {
        const size = Number(q.get('pageSize') || 50), page = Number(q.get('pageIndex') || 1);
        if (size > 50) return send(400, { message: 'pageSize: must be less than or equal to 50' });
        const bound = projects.filter((p) => `demo-${p.org}` === q.get('organizationId') && p.repo);
        return send(200, {
          bindings: bound.slice((page - 1) * size, page * size).map((p) => ({ projectId: p.legacyId, devOpsPlatform: 'github', slug: p.repo, url: `https://github.com/${p.repo}` })),
          page: { pageIndex: page, pageSize: size, total: bound.length },
        });
      }
      if (u.pathname === '/api/settings/values') {
        const own = patterns[q.get('component')];
        return send(200, { settings: [{ key: 'sonar.branch.longLivedBranches.regex', value: own ?? '(branch|release)-.*', inherited: own == null }] });
      }
      if (u.pathname === '/api/project_branches/list') return send(200, { branches: branches[q.get('project')] || [] });
      if (req.method !== 'POST') return send(404, { errors: [{ msg: 'Unknown url' }] });
      if (u.pathname === '/api/projects/update_key') {
        const p = find(q.get('from'));
        if (!p) return send(404, { errors: [{ msg: `Project '${q.get('from')}' not found` }] });
        if (find(q.get('to'))) return send(400, { errors: [{ msg: `Impossible to update key: a component with key "${q.get('to')}" already exists.` }] });
        branches[q.get('to')] = branches[p.key];
        delete branches[p.key];
        if (patterns[p.key]) { patterns[q.get('to')] = patterns[p.key]; delete patterns[p.key]; }
        p.key = q.get('to');
        return send(204, '');
      }
      if (u.pathname === '/api/settings/set') { patterns[q.get('component')] = q.get('value'); return send(204, ''); }
      if (u.pathname === '/api/project_branches/delete') {
        branches[q.get('project')] = (branches[q.get('project')] || []).filter((b) => b.name !== q.get('branch'));
        return send(204, '');
      }
      return send(404, { errors: [{ msg: 'Unknown url' }] });
    });
  });
  // unref: the demo server must not keep the process alive on its own (opspulse's server does that).
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { server.unref(); resolve(`http://127.0.0.1:${server.address().port}`); }));
}

module.exports = { startDemoSonar };
