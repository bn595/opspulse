'use strict';
// Example plugin: recent workflow runs by who triggered them, with a warning when one person's
// runs keep failing. It reads data the Actions panel already fetched, so it makes no API calls.
// Options: days (default 7), failureWarn (default 3).

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

module.exports = {
  id: 'runs-by-actor',
  title: 'Runs by actor',

  async collect(ctx) {
    const actions = ctx.sources.actions;
    if (!actions) throw new Error('requires the GitHub Actions panel (github.actions) to be enabled and loaded');
    const days = ctx.options.days ?? 7;
    const failureWarn = ctx.options.failureWarn ?? 3;
    const since = Date.now() - days * 86400e3;

    const rows = [];
    for (const repo of actions.repos) {
      for (const wf of repo.workflows) {
        for (const r of wf.runs) {
          if (r.status !== 'completed' || Date.parse(r.created) < since) continue;
          rows.push({ actor: r.actor || 'unknown', repo: repo.repo, workflow: wf.name, conclusion: r.conclusion, created: r.created, durationSec: r.durationSec, url: r.url });
        }
      }
    }

    const failuresBy = new Map();
    for (const r of rows) if (FAILED.has(r.conclusion)) failuresBy.set(r.actor, (failuresBy.get(r.actor) || 0) + 1);
    const failures = [...failuresBy.values()].reduce((a, b) => a + b, 0);

    return {
      metrics: [
        { label: 'Runs', value: rows.length },
        { label: 'Actors', value: new Set(rows.map((r) => r.actor)).size },
        { label: 'Failure rate', value: rows.length ? `${Math.round((failures / rows.length) * 100)}%` : '—', level: failures ? 'warn' : null },
      ],
      table: {
        columns: [
          { key: 'created', label: 'When', type: 'date' },
          { key: 'actor', label: 'Actor', facet: true },
          { key: 'workflow', label: 'Workflow', type: 'link', href: 'url', facet: true },
          { key: 'repo', label: 'Repository', facet: true },
          { key: 'conclusion', label: 'Result', facet: true },
          { key: 'durationSec', label: 'Duration (s)', type: 'number' },
        ],
        rows,
      },
      chart: { key: 'created', days, title: 'Runs per day' },
      feed: [...failuresBy]
        .filter(([, n]) => n >= failureWarn)
        .map(([actor, n]) => ({ id: actor, level: 'warn', title: `${actor} triggered ${n} failed runs in ${days} days` })),
    };
  },
};
