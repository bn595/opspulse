'use strict';
// The built-in sources: the connector that collects each, the platform it calls (for proxies and
// rate-limit budgets), the secret it needs, and its configuration section (enabled, refreshMinutes, ...).

const BUILTIN = {
  actions: { connector: require('./connectors/actions'), platform: 'github', secret: 'github', section: (cfg) => cfg.github.actions },
  dismissals: { connector: require('./connectors/dismissals'), platform: 'github', secret: 'github', section: (cfg) => cfg.github.dismissals },
  sonar: { connector: require('./connectors/sonar'), platform: 'sonar', secret: 'sonar', section: (cfg) => cfg.sonar },
  jira: { connector: require('./connectors/jira'), platform: 'jira', secret: 'jira', section: (cfg) => cfg.jira },
};

// Sources as sent to the browser: connector sync state (`_sync`) stays on the server, and each
// source names its platform. Plugin sources carry their own `platform`.
function publicSources(sources) {
  return Object.fromEntries(Object.entries(sources).map(([k, s]) => {
    const out = { ...s, platform: BUILTIN[k]?.platform ?? s.platform ?? null };
    if (s.data?._sync) {
      const { _sync, ...data } = s.data;
      out.data = data;
    }
    return [k, out];
  }));
}

module.exports = { BUILTIN, publicSources };
