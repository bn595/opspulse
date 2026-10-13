#!/usr/bin/env node
'use strict';
// Validates configuration: resolves all secrets (device-code sign-in if required), then runs
// each enabled connector once.
//   node scripts/check-config.js [--config path]

const path = require('path');
const config = require('../src/config');
const net = require('../src/http');
const { SecretStore } = require('../src/secrets');
const CONNECTORS = {
  actions: require('../src/connectors/actions'),
  dismissals: require('../src/connectors/dismissals'),
  sonar: require('../src/connectors/sonar'),
  jira: require('../src/connectors/jira'),
};

const i = process.argv.indexOf('--config');
const file = path.resolve(i > 0 ? process.argv[i + 1] : process.env.OPSPULSE_CONFIG || path.join(__dirname, '..', 'config.json'));
const cfg = config.load(file);
console.log(`config : ${cfg._file}${cfg._exists ? '' : '  (NOT FOUND — defaults only)'}`);
const px = Object.entries(cfg.network.proxies).filter(([, v]) => v);
console.log(`proxies: ${px.length ? px.map(([k, v]) => `${k}=${v.replace(/\/\/[^@]*@/, '//***@')}`).join(', ') : 'none'}`);
if (cfg.network.caFile) console.log(`caFile : ${cfg.network.caFile}`);

const store = new SecretStore(cfg, { applyNetwork: (proxies) => net.configure({ ...cfg.network, proxies }) });
const summarize = {
  actions: (d) => d.repos.map((r) => `${r.repo}: ${r.error ? 'ERROR ' + r.error : `${r.workflows.length} workflows, ${r.workflows.reduce((s, w) => s + w.runs.length, 0)} runs`}`),
  dismissals: (d) => d.orgs.map((o) => `${o.org}: ${o.items.length} dismissals${Object.keys(o.errors).length ? ` (errors: ${Object.entries(o.errors).map(([t, e]) => `${t}: ${e}`).join('; ')})` : ''}`),
  sonar: (d) => [...d.orgs.map((o) => `${o.key}: projects=${o.projects.v ?? o.projects.err}, stale=${o.stale.v ?? o.stale.err}, failingGate=${o.failingGate.v ?? o.failingGate.err}`), `tokens visible: ${d.tokens ? d.tokens.length : 'n/a'}`],
  jira: (d) => [`${d.issues.length} issues${d.truncated ? ' (truncated)' : ''}`],
};

(async () => {
  let bad = 0;

  // The browser callback is unavailable in a terminal, so use device-code sign-in.
  let r = await store.resolve();
  if (store.usesVault()) {
    console.log(`vault  : ${store.authStatus().vault} (auth: ${cfg.secrets.azureKeyVault.auth})`);
    if (store.needsLogin && store.entra) {
      const d = await store.startDeviceLogin();
      console.log(`\n  ${d.message || `Open ${d.verificationUri} and enter the code ${d.userCode}`}\n`);
      while (store.device) await new Promise((res) => setTimeout(res, 2000));
      if (!store.azure.accessToken) { console.log(`✗ sign-in: ${store.lastError}`); process.exit(1); }
      console.log(`✓ signed in as ${store.azure.user}`);
      r = await store.resolve();
    }
  }
  for (const [k, st] of Object.entries(store.status)) if (!k.startsWith('proxy.') && st !== 'unset') console.log(`${st === 'ok' ? '✓' : '✗'} secret ${k}: ${st}`);
  for (const e of r.errors) { bad++; console.log(`  ! ${e}`); }
  console.log('');

  const enabled = { actions: cfg.github.actions.enabled, dismissals: cfg.github.dismissals.enabled, sonar: cfg.sonar.enabled, jira: cfg.jira.enabled };
  for (const [k, c] of Object.entries(CONNECTORS)) {
    if (!enabled[k]) { console.log(`- ${k}: disabled`); continue; }
    const t0 = Date.now();
    try {
      const d = await c.collect(cfg, r.values);
      console.log(`✓ ${k} (${Date.now() - t0}ms)`);
      for (const line of summarize[k](d)) console.log(`    ${line}`);
    } catch (e) {
      bad++;
      console.log(`✗ ${k}: ${e.message}`);
    }
  }
  process.exit(bad ? 1 : 0);
})();
