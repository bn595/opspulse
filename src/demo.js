'use strict';
// Synthetic data for --demo mode.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

function actions(now, r) {
  const people = ['jdoe', 'asmith', 'mlee', 'kpatel', 'github-actions[bot]'];
  const spec = [
    ['acme/sonar-permission-jobs', 'Permission jobs', [
      ['Grant project admin', 'grant-admin.yml', 3, 0.04, 'workflow_dispatch'],
      ['Sync group permissions', 'sync-groups.yml', 6, 0.0, 'schedule', 'burst'],
      ['Nightly permission audit', 'nightly-audit.yml', 24, 0.05, 'schedule'],
      ['Onboard new project', 'onboard.yml', 9, 0.12, 'workflow_dispatch'],
    ]],
    ['acme/sonar-access-requests', 'Access requests', [
      ['Process access request', 'process-request.yml', 2, 0.03, 'issues'],
      ['Revoke expired access', 'revoke-expired.yml', 24, 0.0, 'schedule', 'quiet'],
      ['Validate request form', 'validate.yml', 4, 0.08, 'issues'],
    ]],
  ];
  let id = 9000000;
  const repos = spec.map(([repo, label, wfs], ri) => ({
    repo,
    label,
    url: `https://github.com/${repo}/actions`,
    truncated: false,
    workflows: wfs.map(([name, file, every, failRate, event, mode], wi) => {
      const runs = [];
      let n = 400 + wi * 37;
      const stop = mode === 'quiet' ? now - 60 * H : now;
      for (let t = now - 168 * H + r() * every * H; t < stop; t += every * H * (0.6 + r() * 0.8)) {
        let concl = r() < failRate ? 'failure' : r() < 0.03 ? 'cancelled' : 'success';
        if (mode === 'burst' && now - t < 20 * H) concl = r() < 0.75 ? 'failure' : 'success';
        runs.push({ id: id++, n: n++, attempt: 1, status: 'completed', conclusion: concl, event, branch: 'main', actor: people[Math.floor(r() * people.length)], created: iso(t), durationSec: Math.round(40 + r() * 200 + (concl === 'failure' ? 30 : 0)), url: `https://github.com/${repo}/actions/runs/${id}` });
      }
      if (mode === 'burst') runs[runs.length - 1].conclusion = 'failure';
      if (ri === 0 && wi === 0) runs.push({ id: id++, n: n++, attempt: 1, status: 'in_progress', conclusion: null, event, branch: 'main', actor: 'jdoe', created: iso(now - 3 * 60e3), durationSec: null, url: `https://github.com/${repo}/actions/runs/${id}` });
      runs.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
      return { id: 100 + ri * 10 + wi, name, path: `.github/workflows/${file}`, state: 'active', url: `https://github.com/${repo}/actions/workflows/${file}`, runs, lastRun: runs[0], expectEveryHours: mode === 'quiet' ? 26 : null };
    }),
  }));
  return { lookbackHours: 168, repos };
}

function dismissals(now, r) {
  const reasons = {
    'code-scanning': ['false positive', "won't fix", 'used in tests'],
    'secret-scanning': ['false_positive', 'used_in_tests', 'wont_fix'],
    dependabot: ['tolerable_risk', 'not_used', 'inaccurate', 'no_bandwidth', 'fix_started'],
  };
  const titles = {
    'code-scanning': ['SQL injection', 'Reflected cross-site scripting', 'Hard-coded credentials', 'Insecure randomness', 'Path traversal'],
    'secret-scanning': ['Azure Storage Account Key', 'GitHub Personal Access Token', 'Slack Webhook', 'Generic Password'],
    dependabot: ['Prototype pollution in lodash', 'ReDoS in semver', 'Command injection in shell-quote', 'Denial of service in qs'],
  };
  const sev = ['low', 'medium', 'high', 'critical'];
  const people = ['jdoe', 'asmith', 'mlee', 'kpatel', 'tnguyen', 'rgarcia'];
  const orgs = [['acme', 70], ['acme-labs', 22]].map(([org, count]) => {
    const items = [];
    for (let i = 0; i < count; i++) {
      const tool = ['code-scanning', 'secret-scanning', 'dependabot'][Math.floor(r() * r() * 3.2) % 3];
      const repo = `${org}/${['payments-api', 'web-portal', 'data-pipeline', 'mobile-app', 'infra-tf', 'auth-service'][Math.floor(r() * 6)]}`;
      const title = titles[tool][Math.floor(r() * titles[tool].length)];
      items.push({
        tool,
        org,
        at: iso(now - r() ** 1.3 * 30 * 24 * H),
        by: people[Math.floor(r() * r() * people.length)],
        reason: reasons[tool][Math.floor(r() * r() * reasons[tool].length)],
        comment: r() < 0.4 ? 'Reviewed with app team' : '',
        repo,
        title,
        severity: tool === 'secret-scanning' ? null : sev[Math.floor(r() * 4)],
        secretType: tool === 'secret-scanning' ? title.toLowerCase().replace(/\W+/g, '_') : null,
        validity: tool === 'secret-scanning' ? ['active', 'inactive', 'unknown'][Math.floor(r() * 3)] : null,
        package: tool === 'dependabot' ? title.split(' in ').pop() : null,
        url: `https://github.com/${repo}/security`,
      });
    }
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { org, items, errors: {}, truncated: [], hidden: 0 };
  });
  return { lookbackDays: 30, tools: ['code-scanning', 'secret-scanning', 'dependabot'], orgs };
}

function sonar(now) {
  return {
    url: 'https://sonarcloud.io',
    staleDays: 30,
    tokenExpiryWarnDays: 14,
    orgs: [
      { key: 'acme', url: 'https://sonarcloud.io/organizations/acme', projects: { v: 4182 }, stale: { v: 611 }, neverAnalyzed: { v: 143 }, failingGate: { v: 388 } },
      { key: 'acme-labs', url: 'https://sonarcloud.io/organizations/acme-labs', projects: { v: 297 }, stale: { v: 54 }, neverAnalyzed: { v: 12 }, failingGate: { err: '403 — forbidden' } },
    ],
    tokens: [
      { name: 'permission-jobs', createdAt: iso(now - 80 * 24 * H), lastConnectionDate: iso(now - 2 * H), expirationDate: iso(now - 0 + 9 * 24 * H) },
      { name: 'opspulse', createdAt: iso(now - 10 * 24 * H), lastConnectionDate: iso(now), expirationDate: null },
    ],
  };
}

function jira(now, r) {
  const statuses = [
    ['Open', 'new', 0.22],
    ['Triage', 'new', 0.1],
    ['In Progress', 'indeterminate', 0.2],
    ['Waiting for Requester', 'indeterminate', 0.12],
    ['Blocked', 'indeterminate', 0.06],
    ['Done', 'done', 0.3],
  ];
  const kinds = [
    ['Access Request', 'Grant {who} admin on {proj}'],
    ['Access Request', 'Need browse permission for {proj}'],
    ['Incident', 'Quality gate failing unexpectedly on {proj}'],
    ['Question', 'How do I add a new project to {proj} portfolio?'],
    ['Access Request', 'Remove {who} from {proj} (left team)'],
    ['Incident', 'PR decoration missing on {proj}'],
    ['Task', 'Bind {proj} to GitHub repo'],
  ];
  const people = ['Jamie Cruz', null, null, 'Alex Smith', 'Mina Lee'];
  const reporters = ['Jordan Doe', 'Priya Patel', 'Sam Rivera', 'Lee Wong', 'Chris Ito', 'Dana Kim'];
  const projs = ['payments-api', 'web-portal', 'data-pipeline', 'auth-service', 'mobile-app'];
  const issues = [];
  for (let i = 0; i < 84; i++) {
    let x = r();
    const st = statuses.find((s) => (x -= s[2]) < 0) || statuses[0];
    const created = now - r() ** 1.6 * 45 * 24 * H;
    const updated = Math.min(now, created + r() * (now - created));
    const [type, tpl] = kinds[Math.floor(r() * kinds.length)];
    const key = `ITRK-${1200 + i}`;
    issues.push({
      key,
      url: `https://example.atlassian.net/browse/${key}`,
      summary: tpl.replace('{who}', reporters[Math.floor(r() * reporters.length)]).replace('{proj}', projs[Math.floor(r() * projs.length)]),
      status: st[0],
      category: st[1],
      assignee: st[1] === 'new' && r() < 0.6 ? null : people[Math.floor(r() * people.length)] || 'Jamie Cruz',
      reporter: reporters[Math.floor(r() * reporters.length)],
      priority: ['Low', 'Medium', 'Medium', 'High', 'Highest'][Math.floor(r() * 5)],
      type,
      created: iso(created),
      updated: iso(updated),
      statusSince: iso(updated),
      resolved: st[1] === 'done' ? iso(updated) : null,
      labels: [],
    });
  }
  issues.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const jql = 'project = ITRK AND (statusCategory != Done OR resolved >= -30d) ORDER BY created DESC';
  return { baseUrl: 'https://example.atlassian.net', jql, lookbackDays: 30, staleDays: 7, truncated: false, searchUrl: 'https://example.atlassian.net/issues/', issues };
}

function generate() {
  const now = Date.now();
  const r = rng(Math.floor(now / (10 * 60e3))); // stable for 10 minutes
  return { actions: actions(now, r), dismissals: dismissals(now, r), sonar: sonar(now), jira: jira(now, r) };
}

module.exports = { generate };
