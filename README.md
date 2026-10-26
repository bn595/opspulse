# opspulse

A local, single-page dashboard for monitoring platform automation across GitHub Actions, Jira, GitHub Advanced Security and SonarQube Cloud.

| Panel | Source | What you get |
|---|---|---|
| **Needs attention** | all of the below | One ranked feed: *"3 failures in Sync group permissions in the last 24h"*, *"12 open tickets untouched for 7+ days"*, *"Sonar token expires in 5d"*, *"Jira refresh failed: 401"* |
| **Pipelines** | GitHub Actions | Per-workflow status, last 30 runs as a strip, success rate, failures, median duration, runs-over-time chart. 24h / 3d / 7d. |
| **Ticket backlog** | Jira (one JQL query) | Open / in progress / unassigned / stale counts, status breakdown (click to filter), created-per-day chart, sortable ticket table |
| **GHAS dismissals** | GitHub code scanning, secret scanning, Dependabot | Dismissals per org over 7 / 14 / 30d by tool, reason, person and repo, plus the recent list with comments |
| **SonarQube Cloud** | SonarQube Cloud Web API | Token validity, projects per org, not analyzed in N days, never analyzed, failing quality gate, token expiry |

It runs entirely on your machine. There is **no database, no `npm install`, no build step and no CDN**; it requires only Node.js 18+. Tokens come from **Azure Key Vault via organizational sign-in**, or from a local `.env`, and never reach the browser or the disk.

```
npm run demo        # try it with synthetic data, no tokens needed
```

---

## Quick start

1. Install [Node.js](https://nodejs.org) 18.17 or newer (`node -v`).
2. Copy the example config and fill it in (comments are allowed in `config.json`):
   ```
   cp config.example.jsonc config.json
   ```
   Then either point the token fields at Key Vault (see [Secrets from Azure Key Vault](#secrets-from-azure-key-vault)) or copy `.env.example` to `.env` and paste tokens there.
3. Check everything before opening the UI:
   ```
   npm run check
   ```
   This resolves every secret (signing you in to Azure with a device code if needed), applies the proxies, calls each API once and reports the result of each check, including the reason for any failure (`401`, missing scope, unknown org, proxy refusal).
4. Start it:
   ```
   npm start
   ```
   On Windows you can also double-click `start.cmd`. On macOS or Linux, run `./start.sh`. A browser tab opens at `http://localhost:4777`.

Each source refreshes in the background on its own interval (Actions and Jira every 10 minutes, GHAS and Sonar every 60 by default). **Refresh** in the top bar refreshes everything now, except sources paused by a rate limit. The last good data is cached in `.cache/` so a restart shows something immediately. If a source fails, its last data stays visible with a warning, and the failure goes into the feed.

Edits to `config.json` are picked up on the next refresh without a restart.

### CLI flags

```
node src/server.js [--config path/to/config.json] [--port 4800] [--no-open] [--demo]
```

`OPSPULSE_CONFIG=/path/config.json` works too. `.env` is read from the same folder as the config file. `config.jsonc` is accepted as an alternative file name.

---

## Secrets from Azure Key Vault

This is the recommended setup. Tokens are stored as Key Vault secrets, vault RBAC controls who can read them, and each user signs in with their own organizational account.

```jsonc
"secrets": {
  "azureKeyVault": {
    "vaultUrl": "https://your-vault.vault.azure.net",
    "auth": "auto"          // auto | cli | browser | device
  }
},
"github": { "token": "keyvault:github-token" },
"sonar":  { "token": "keyvault:sonar-token" },
"jira":   { "token": "keyvault:jira-token" }
```

Any `token` / `email` / proxy field can be a `keyvault:<secret-name>` reference. The default names used in the example config are **`github-token`**, **`sonar-token`** and **`jira-token`**; pick any names you like, the reference is what counts.

### How the sign-in works

| `auth` | What happens | Needs |
|---|---|---|
| **`browser`** | The dashboard shows **Sign in with Microsoft**. The browser goes to the normal company sign-in page (including MFA and Conditional Access); if the user is already signed in to Microsoft 365, this is usually a single account-selection step. Then it comes back to `http://localhost:<port>/auth/azure/callback`. Standard OAuth 2.0 authorization code flow with PKCE, no client secret. | Nothing |
| **`device`** | Shows a code to type at <https://microsoft.com/devicelogin>. Useful when the browser callback is blocked, and what `npm run check` uses in a terminal. | Nothing |
| **`cli`** | Runs `az account get-access-token` and reuses the Azure CLI's existing session. Silent. | [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) installed and `az login` done once |
| **`auto`** (default) | Tries `cli` first; if `az` isn't installed or logged in, falls back to `browser`. | Nothing |

Whichever way you sign in, the result is an access token for `https://vault.azure.net` that only works for Key Vault, used to call the vault's REST API directly. There is no Azure SDK involved. Tokens and secrets stay in memory; closing the console window forgets them.

### No app registration needed (by default)

Every Microsoft sign-in has to name an app (`clientId`). By default opspulse uses the **Azure CLI's public client ID** (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`), the same default Microsoft's own Azure Identity SDK uses for browser and device-code sign-in. It's pre-consented for Key Vault in every tenant, so there's no consent screen and nothing to set up. `tenantId` defaults to `organizations`, meaning any work account signs in to its home tenant.

**Security is unchanged by this choice.** What decides access is the user's identity plus their role on the vault, not which app ID was used. The trade-offs are visibility and policy:

- Sign-in logs show the app as **"Microsoft Azure CLI"**.
- If your tenant blocks the Azure CLI for non-admin users with Conditional Access, sign-in fails with an `AADSTS53003` error. Test once with a normal user account before rolling out.

Set `tenantId` explicitly if users are guests in the vault's tenant (their home tenant would be the wrong one).

### Optional: your own app registration

If security wants sign-ins labelled as "opspulse", or the Azure CLI is blocked, register an app once and put its IDs in config:

1. Entra ID → **App registrations** → **New registration**. Name it e.g. `opspulse`. Supported account types: *this organization only*.
2. **Authentication** → *Add a platform* → **Mobile and desktop applications**. Add the redirect URI `http://localhost` (Entra accepts any port for localhost on this platform). Under *Advanced settings*, set **Allow public client flows** to **Yes** (required for the device code flow).
3. **API permissions** → *Add a permission* → **Azure Key Vault** → Delegated → `user_impersonation`. Grant admin consent so users don't see a consent screen.
4. Set `secrets.azureKeyVault.clientId` and `tenantId` in `config.json`.

### Vault side

- Create the secrets (`github-token`, `sonar-token`, `jira-token`) in the vault.
- The vault must use the **Azure RBAC** permission model.
- Each user (or a group they're in) needs a **data-plane** role on the vault: **Key Vault Secrets User** (read-only, the minimum), **Key Vault Secrets Officer** or **Key Vault Administrator**. **Owner and Contributor are not enough**: they manage the vault but can't read secret values. Without a data-plane role the dashboard reports `403 … needs the "Key Vault Secrets User" role`.
- If the vault's public network access is disabled or firewalled, users must be on the corporate network or VPN to reach it.
- Rotate a token by updating the secret. Running dashboards pick it up on the next refresh after `cacheMinutes` (default 60), or immediately after **sign out** → sign in.

### Where secrets are kept while the tool runs

In the Node process's memory, nowhere else.

- Secret values are held for `cacheMinutes` and then re-read from the vault.
- The Entra access token (1 h) and refresh token stay in memory until you click **sign out** or stop the process. With `auth: cli`, opspulse holds only the 1-hour access token: the long-lived session is the Azure CLI's own, protected by DPAPI (Windows) or the Keychain (macOS).
- `.cache/snapshot.json` holds fetched *data* only (run metadata, ticket titles). `/api/snapshot` carries no token, secret, or proxy credential, and the UI only ever sees `ok / missing / pending / error` per secret.

Tokens are not cached on disk: any key a local tool could use for encryption would be readable by the same user account, so it would add complexity without adding protection. Signing in again is a single SSO step.

---

## Proxies

Node does not honour `HTTPS_PROXY` on its own, so proxies are explicit, **one per platform**:

```jsonc
"network": {
  "proxies": {
    "github": "",                               // direct
    "sonar": "http://proxy.corp.example:8080",  // via proxy
    "jira": "env:OPSPULSE_PROXY_JIRA",          // from .env, e.g. when it includes credentials
    "azure": ""                                 // Entra + Key Vault; cannot itself be a keyvault: ref
  },
  "caFile": "corp-root-ca.pem",                 // optional, for TLS-inspecting proxies
  "timeoutSeconds": 30
}
```

- `http://` and `https://` proxies are supported. HTTPS targets go through a `CONNECT` tunnel; plain-HTTP targets (an `http://` GHES, say) are forward-proxied.
- Credentials go in the URL (`http://user:pass@host:port`) and are sent as `Proxy-Authorization: Basic`. Keep them in `.env` or Key Vault via a reference, not literally in `config.json`. The UI only ever shows the proxy's host.
- `caFile` is a PEM bundle **added to** Node's bundled roots (it doesn't replace them). Setting the `NODE_EXTRA_CA_CERTS` environment variable works too.
- Errors are specific: `proxy X refused CONNECT to host:443 (407 …)`, `DNS lookup failed (behind a proxy? set network.proxies)`, `TLS certificate rejected (corporate TLS inspection? set network.caFile)`, and `expected JSON but got text/html — a proxy or SSO login page is probably intercepting`.

---

## Tokens

Only needed if you're not using Key Vault for a given value. Any `token` / `email` / proxy value can be:

- `"keyvault:NAME"`: read from the configured vault (see above)
- `"env:VAR_NAME"`: from the environment or `.env` (never committed)
- `"file:relative/or/absolute/path"`: from a file
- a literal string (not recommended for tokens)

| Token | Needs |
|---|---|
| **GitHub** | **Classic PAT:** `repo`, `security_events`, `read:org`. The account must be an org owner or in the **security manager** role to read org-level alerts. GHAS enterprise mode (`github.dismissals.enterprise`) requires a classic PAT from an enterprise member. If your org enforces SSO, **authorize the token for SSO**. **Fine-grained PAT:** owner = the org; repository permissions *Actions: read*, *Code scanning alerts: read*, *Secret scanning alerts: read*, *Dependabot alerts: read*, *Metadata: read* on all repos you want counted. |
| **SonarQube Cloud** | A user token from *My Account → Security* for an account with **Administer** on each organization. Project search needs admin rights. Without them those numbers show `n/a`. |
| **Jira Cloud** | Your Atlassian email (`jira.email`) and an API token from <https://id.atlassian.com/manage-profile/security/api-tokens>. The account must be able to browse the projects in your JQL. |
| **Jira Data Center / Server** | Set `"deployment": "datacenter"` and use a Personal Access Token. `email` is not needed. |

GitHub Enterprise Server or GHE.com: set `github.apiUrl` (for example `https://github.example.com/api/v3`).

The default `sonar.url` is the US region, `https://sonarqube.us`. For the EU region set it to `https://sonarcloud.io`.

---

## Configuration reference

Everything has a default. Only set what you need. See [`config.example.jsonc`](config.example.jsonc).

### `server`
| key | default | |
|---|---|---|
| `port` | `4777` | If the port is taken, the next free one (up to +10) is used |
| `host` | `127.0.0.1` | Keep on loopback; the dashboard has no authentication. |
| `openBrowser` | `true` | |
| `refreshMinutes` | `10` | Default interval for plugins without their own `refreshMinutes`. Built-in sources have their own setting. |

### `network`
| key | default | |
|---|---|---|
| `proxies.github` / `.sonar` / `.jira` / `.azure` | `""` | Proxy URL per platform, empty = direct. Accepts `env:` / `file:` / `keyvault:` refs (not `keyvault:` for `azure`). |
| `caFile` | `""` | Extra PEM CA bundle, relative to the config file |
| `timeoutSeconds` | `30` | Per request |
| `timeouts` | `{}` | Per-platform overrides in seconds, e.g. `{ "sonar": 90 }` |

### `secrets.azureKeyVault`
| key | default | |
|---|---|---|
| `vaultUrl` | `""` | `https://<name>.vault.azure.net`. Required when any `keyvault:` ref is used. |
| `auth` | `auto` | `auto` / `cli` / `browser` / `device` |
| `tenantId` | `organizations` | Tenant to sign in to. Set it for guest users or to pin the tenant. |
| `clientId` | Azure CLI's public client ID | Replace with your own app registration if wanted (see above) |
| `authority` | `https://login.microsoftonline.com` | Change for sovereign clouds |
| `scope` | `https://vault.azure.net/.default` | Change for sovereign clouds (e.g. `https://vault.usgovcloudapi.net/.default`) |
| `cacheMinutes` | `60` | How long fetched secret values are kept before re-reading the vault |

### `github.actions`
| key | default | |
|---|---|---|
| `enabled` | `true` | |
| `refreshMinutes` | `10` | |
| `repos` | `[]` | `"org/repo"` or `{ repo, label, workflows, branch, expectEveryHours, includeDynamic }` |
| `repos[].workflows` | all | Names, file names (`sync.yml`), paths or IDs. `["*"]` = all. |
| `repos[].branch` | any | Only count runs on this branch |
| `repos[].expectEveryHours` | – | `{ "Workflow name or file.yml": 26 }`. Feed warns and the row shows **Overdue** when the workflow hasn't run in that long. Good for scheduled jobs that silently stop. |
| `repos[].includeDynamic` | `false` | Include GitHub-managed workflows (CodeQL default setup, Dependabot, Pages) |
| `lookbackHours` | `168` | How much run history to fetch (the UI window picker goes up to this) |
| `feedWindowHours` | `24` | Window for the "x failures in x hours" feed rule |
| `failureWarn` / `failureCritical` | `1` / `3` | Failure counts in that window that raise a warning or critical |
| `maxRunsPerRepo` | `1000` | Safety cap |

### `github.dismissals`
| key | default | |
|---|---|---|
| `refreshMinutes` | `60` | |
| `enterprise` | `""` | Enterprise slug. Uses the enterprise-wide alert endpoints instead of `orgs`. Classic token required. See [Running at scale](#running-at-scale). |
| `orgs` | `[]` | Orgs to count when `enterprise` is not set |
| `lookbackDays` | `30` | 7 / 14 / 30 / 90 window picker, capped at this |
| `tools` | all three | Any of `code-scanning`, `secret-scanning`, `dependabot` |
| `secretResolutions` | everything except `revoked` | Which secret-scanning resolutions count as a "dismissal". Sent to GitHub as a filter. |
| `dependabotStates` | `["dismissed"]` | Add `"auto_dismissed"` to include alerts Dependabot dismissed itself |
| `fullResyncHours` | `24` | Hours between full re-reads; refreshes in between fetch only changes |
| `feed` | `false` | Set to `true` to post an info item when an org has ≥ `feedWarnCount` dismissals in the window |
| `maxPagesPerTool` | `20` | Pages of 100 per stream and refresh. If hit, the UI warns and the next refresh does a full sync. |

### `sonar`
| key | default | |
|---|---|---|
| `url` | `https://sonarqube.us` | EU region: `https://sonarcloud.io` |
| `apiUrl` | derived | Web API v2 host; empty means `https://api.` + the host of `url` (e.g. `https://api.sonarqube.us`) |
| `refreshMinutes` | `60` | |
| `organizations` | all orgs you're a member of | |
| `staleDays` | `30` | "Not analyzed in N days" |
| `tokenExpiryWarnDays` | `14` | Feed warns when any token on this account expires within N days |

### `jira`
| key | default | |
|---|---|---|
| `deployment` | `cloud` | `cloud` or `datacenter` |
| `refreshMinutes` | `10` | |
| `baseUrl` | – | `https://your-company.atlassian.net` |
| `jql` | – | Your backlog query. To also get resolved-in-period numbers, include recently closed tickets, e.g. `project = X AND (statusCategory != Done OR resolved >= -30d)` |
| `lookbackDays` | `30` | Created-per-day chart and resolved count |
| `staleDays` | `7` | Open tickets with no update for this long are flagged |
| `newWindowHours` | `24` | Window for the "x new tickets" feed item |
| `unassignedWarn` | `1` | Feed warns at this many unassigned open tickets |
| `statusRules` | `[]` | `{ "status": "Blocked", "olderThanDays": 3, "level": "warn", "minCount": 1 }`. Use `olderThanHours` for finer control. Age is measured from the last status-category change (Cloud) or the last update. |
| `maxIssues` | `1000` | Safety cap |
| `include` / `exclude` | – | Rules, see [Exclude or include data with rules](#exclude-or-include-data-with-rules). Also available on `github.actions` and `github.dismissals`. |

### `ui`
| key | default | |
|---|---|---|
| `panels` | `[]` | Panel ids to show first, in order |
| `hide` | `[]` | Panel ids to hide |

### `plugins`
A list of `{ "path": "...", "id"?, "title"?, "enabled"?, ...options }`. Paths are relative to the config file. See [Plugins](#plugins).

### `admin`
| key | default | |
|---|---|---|
| `concurrency` | `5` | Changes made at once by the admin tools; halved automatically if SonarQube Cloud rate-limits |

### `logging`, `storage`
See [Logging](#logging) and [Storage](#storage).

---

## Customizing

opspulse is meant to be shaped around what your team actually cares about. There are four levels, from no-config to code.

### Filter and share views in the UI

- Click any breakdown bar (reason, person, repository, status, assignee…), tool tile or org tab to filter. Filters combine; each breakdown is computed with the *other* filters applied, so you can still see and switch to alternatives.
- Active filters show as pills above the table. Remove one with ×, or **Clear all**.
- Search narrows further (title, repository, person, comment, secret type, package…).
- Filters, search and time windows live in the URL. **Copy link** gives a link that reopens exactly that view, which is handy for bookmarks or for sending to someone.
- **Export CSV** downloads every row matching the current filters, not just the visible page.

### Exclude or include data with rules

Rules filter data on the server, before counts, charts and the feed see it. Use them to remove noise you never want to see, for example dismissals handled by an automated bot.

```jsonc
"github": {
  "dismissals": {
    "exclude": [ { "by": "*[bot]" } ],
    "include": [ { "tool": "secret-scanning" }, { "tool": "code-scanning", "severity": ["critical", "high"] } ]
  }
}
```

- An item is kept when it matches **any** `include` rule (or there are none) and **no** `exclude` rule.
- Within one rule, **every** field must match.
- A matcher is text (case-insensitive, `*` wildcard), `"/regex/flags"`, a number or boolean, `null` (missing or empty), or a list of matchers (any of them).
- Fields:
  - **GHAS dismissals:** `tool`, `org`, `repo`, `by`, `reason`, `title`, `severity`, `comment`, `secretType`, `validity`, `package`, `ecosystem`, `ruleId`, `toolName`.
  - **Actions runs** (`github.actions`): `repo`, `workflow`, `actor`, `event`, `branch`, `conclusion`.
  - **Jira issues** (`jira`): `status`, `assignee`, `reporter`, `priority`, `type`, `labels`, `summary`.
- Any field of the original API response is available as `raw.<path>`, for example `{ "raw.secret_type": "/^custom_pattern_/" }` or `{ "raw.fields.labels": "security" }`.
- Each panel notes how many items its rules hid.

### Acknowledge and snooze feed items

Each item in **Needs attention** has **Acknowledge** and **Snooze 24h**.

- An acknowledged item stays hidden until its text changes, so *3 failures* acknowledged comes back as *5 failures*.
- A snoozed item returns after 24 hours.
- Hidden items are listed under **Show acknowledged or snoozed items**, each with **Restore**.
- State is kept in `.cache/acks.json`.

### Arrange panels

```jsonc
"ui": {
  "panels": ["feed", "ghas", "my-plugin"],   // shown first, in this order
  "hide": ["sonar"]
}
```

Panel ids are `feed`, `kpis`, `actions`, `jira`, `ghas` and `sonar`, plus your plugins' ids. Panels you don't list keep their default order after the listed ones.

## Plugins

A plugin adds a panel built from your own logic: a cross-platform report, an internal API, data joined across sources. It gets the same UI as the built-in panels (filters, search, sorting, chart, CSV, links, feed items) without touching the front end.

```jsonc
"plugins": [
  { "path": "./plugins/my-report.js", "staleDays": 30 }   // other keys become ctx.options
]
```

```js
// plugins/my-report.js
module.exports = {
  id: 'my-report',            // lowercase letters, digits, dashes; also the panel id
  title: 'My report',
  async collect(ctx) {
    const data = await ctx.api.sonar.get('/api/projects/search?organization=acme&ps=500');
    const rows = data.components.map((p) => ({ project: p.key, analyzed: p.lastAnalysisDate || null, url: `${ctx.config.sonar.url}/project/overview?id=${p.key}` }));
    return {
      metrics: [{ label: 'Projects', value: rows.length, kpi: true }],
      table: {
        columns: [
          { key: 'project', label: 'Project', type: 'link', href: 'url' },
          { key: 'analyzed', label: 'Last analysis', type: 'date' },
        ],
        rows,
      },
      feed: rows.length ? [] : [{ level: 'warn', title: 'No projects visible to the Sonar token' }],
    };
  },
};
```

**What `collect` returns.** Every part is optional.

| Key | Shape |
|---|---|
| `metrics` | `[{ label, value, hint?, level?: critical\|warn\|info\|good, kpi?: true }]`. `kpi: true` also shows the metric in the top row. Metrics are computed by the plugin, so they do not change with panel filters. |
| `table` | `{ columns: [{ key, label?, type?: text\|number\|date\|link, facet?: true, href?: <key of a URL field> }], rows: [ {...} ] }`. `facet: true` adds a clickable breakdown for that column. Up to 5,000 rows. |
| `chart` | `{ key: <date column>, days?: 30, title? }`. Rows per day, following the panel filters. |
| `feed` | `[{ level: critical\|warn\|info, title, detail?, url?, id? }]`. These go into **Needs attention** and can be acknowledged like any other item. |

**What `ctx` provides.**

| | |
|---|---|
| `ctx.api.github.get(path)`, `ctx.api.sonar.get(path)`, `ctx.api.jira.get(path)` | Authenticated GET with the configured tokens, base URLs and proxies. Returns the parsed JSON. |
| `ctx.request(url, opts)`, `ctx.nextLink(headers)` | The underlying HTTP client (set `opts.platform` to pick a proxy) and GitHub `Link` pagination. |
| `ctx.secret(ref)` | Resolves any reference (`keyvault:name`, `env:VAR`, `file:path`), so a plugin can use its own secrets. |
| `ctx.sources` | What the built-in panels fetched in this refresh: `actions`, `dismissals`, `sonar`, `jira` (or `null`). Join across them without extra API calls. |
| `ctx.options`, `ctx.config` | The plugin's own config entry, and the full configuration. |
| `ctx.previous` | This plugin's last successful result (or `null`), for fetching only what changed. |

**Behaviour.** Plugins run after the built-in connectors, every `refreshMinutes` from their config entry (default `server.refreshMinutes`). Invalid output is rejected with a message naming the field. A plugin that throws, fails to load or exceeds two minutes shows an error in its own panel and the feed, and nothing else is affected. Edits to a plugin file are picked up when `config.json` changes or the tool restarts.

Plugins are ordinary Node modules running with the same access as opspulse itself, including your tokens, so only load code you trust. [`plugins/examples/runs-by-actor.js`](plugins/examples/runs-by-actor.js) is a complete example that needs no API calls; `npm run demo` shows it.

## Admin tools (SonarQube Cloud)

The **Admin** view (side navigation, or `#/admin`) holds bulk tools for SonarQube Cloud. Every tool follows the same steps: choose an organization and projects, **preview** what would change, untick anything you want to leave alone, **confirm**, then watch per-project results with links. Results can be exported as CSV.

| Tool | What it does |
|---|---|
| **Name drift** | Lists every project in an organization whose key no longer follows its name, which happens when a repository is renamed: SonarQube Cloud picks up the new name but keeps the old key. Keys in another format (no `_`) are listed too when the name differs, for follow-up by hand. |
| **Project keys** | Updates the keys of chosen projects to follow their current name. |
| **Long-lived branch pattern** | Sets `sonar.branch.longLivedBranches.regex` on chosen projects. Includes a tester that shows whether a branch name would be long-lived. |
| **Delete branch** | Deletes one branch from chosen projects. Main branches are never deleted. |
| **Make branch long-lived** | Sets the pattern, then deletes the branch where it exists as short-lived, so its next analysis recreates it as long-lived. A branch's type is fixed at its first analysis, so this is the way to turn an existing branch long-lived. |

**How a new key is derived.** Everything up to and including the first `_` of the current key is kept exactly (case included), followed by the project's current name: `Acme-Corp_payments-api`, renamed to `payments-service`, becomes `Acme-Corp_payments-service`. The preview flags keys without an `_`, names that aren't valid in a key, and target keys already taken anywhere in SonarQube Cloud.

**Choosing projects.** By name prefix (case-insensitive; empty means every project) or a pasted list of keys.

**Safety.**
- A preview is stored on the server and applied by id within 30 minutes, once, so what changes is exactly what was previewed.
- Applying requires confirmation; deleting a branch requires typing its name.
- Changing a key breaks pipelines that still pass the old `sonar.projectKey`; the preview says so.
- The admin tools act with the configured SonarQube Cloud token, so what a user can change is what that token may administer (each project needs **Administer**).
- Every change is an `audit` log event: the run, who, which project, before and after (for a deleted branch, its type and last analysis), and the result.

**Speed.** Changes run `admin.concurrency` at a time (default 5). If SonarQube Cloud rate-limits the run, the remaining projects wait for the block to end and continue at half the concurrency; nothing needs re-running.

**APIs.** Project listing and key checks use Web API v2 (5,000 projects per page); the changes use Web API v1, which v2 does not cover yet. [`docs/sonar-api.md`](docs/sonar-api.md) lists every call, and [issue #1](https://github.com/bn595/opspulse/issues/1) tracks moving the rest to v2.

`npm run demo` includes a stand-in SonarQube Cloud (organizations `acme` and `acme-labs`) for trying the tools safely.

## Logging

opspulse logs to stdout, one JSON object per line (`time`, `level`, `event`, fields). That is what container platforms collect: in Azure Container Apps the lines land in Log Analytics without configuration. At a terminal the same records print as readable lines.

| key | default | |
|---|---|---|
| `logging.format` | `auto` | `json`, `pretty`, or `auto` (pretty at a terminal, JSON otherwise) |
| `logging.file` | `""` | Also append every record, as JSON, to this file (relative to the config file) |

Levels are `info`, `warn`, `error` and `audit`. Fields whose names look like credentials (token, secret, password, authorization) are replaced with `[redacted]`.

## Storage

State that should survive a restart (the dashboard snapshot cache and acknowledgements) goes through `storage.backends`:

```jsonc
"storage": {
  "backends": [
    { "type": "file", "dir": ".cache" },                                       // the default
    { "type": "module", "path": "./storage/blob.js", "container": "opspulse" }  // your own backend
  ]
}
```

- `[]` keeps nothing between restarts (memory only), which suits a stateless container.
- With several backends, writes go to all of them and reads come from the first that has the document. A failing backend is logged and skipped.
- A module backend exports `createStorage(options, { log, request })` returning `{ get(key), set(key, value), delete(key) }` (all async; `get` returns `null` when there is nothing). Every option except `type` and `path` is passed through, plus `baseDir` (the config file's directory). `request` is opspulse's HTTP client; use it for network calls so they go through the `network.proxies.azure` proxy (or another, with `{ platform }`), the CA file and rate limiting.
- [`storage/examples/sqlite.js`](storage/examples/sqlite.js) is a working backend on Node's built-in `node:sqlite` (Node 22.5+, no package). [`storage/examples/template.js`](storage/examples/template.js) is a starting point for others, such as Azure Blob Storage.
- `npm run check` writes, reads back and deletes a test document in every configured backend.

## Running at scale

opspulse is built for large enterprises (tens of thousands of repositories, many organizations). What it costs per refresh:

| Source | Cost | Grows with |
|---|---|---|
| Actions | 1 request per configured repo, plus run pages | Only the repos you list |
| GHAS dismissals | After the first sync, about 1 request per stream (alert type × org, or alert type in enterprise mode) | Dismissals since the last refresh |
| SonarQube Cloud | About 4 requests per organization (counts come from result totals) | Number of Sonar organizations |
| Jira | Pages of 100 issues | Your JQL |

**Recommendations**

- **Use enterprise mode for GHAS** when you are an enterprise member who owns or is security manager of the organizations: set `github.dismissals.enterprise` to the enterprise slug. Three streams cover every organization, including ones added during a migration. It needs a **classic** token; GitHub's enterprise alert endpoints don't accept fine-grained tokens. Endpoints used: [code scanning](https://docs.github.com/en/enterprise-cloud@latest/rest/code-scanning/code-scanning#list-code-scanning-alerts-for-an-enterprise), [secret scanning](https://docs.github.com/en/enterprise-cloud@latest/rest/secret-scanning/secret-scanning#list-secret-scanning-alerts-for-an-enterprise) (returns default secret patterns), [Dependabot](https://docs.github.com/en/enterprise-cloud@latest/rest/dependabot/alerts#list-dependabot-alerts-for-an-enterprise).
- **Keep intervals proportional to how fast data changes.** Defaults: Actions and Jira every 10 minutes, GHAS and Sonar every 60. Each source has its own `refreshMinutes`.
- **Exclude automated noise with rules** (for example `{ "by": "*[bot]" }`) so it never reaches counts, the feed or the browser.

**How rate limits are handled.** Each platform's budget is tracked from its rate-limit headers (GitHub reports 5,000 requests per hour for a personal token). Requests stop before a budget runs out. A rate-limited platform is paused (honouring `Retry-After`, otherwise backing off 2 → 4 → 8 → 16 → 30 minutes; SonarQube Cloud does not publish its limits and asks clients to wait minutes). While paused, the source keeps its last data, its chip shows when it resumes, the feed shows a warning, and no requests are sent. Source chips show the remaining GitHub budget.

**How GHAS stays cheap.** The first sync reads each stream back to the start of the window. Later refreshes read only what changed since the last one and merge it. If a stream fails, its last known alerts stay visible (with the error shown) until it can be read again. Because GitHub stops listing an alert as dismissed once it is reopened, and an incremental read can't see that, a full resync runs every `fullResyncHours` (default 24) and whenever the configuration changes. Until then a reopened alert can still be shown as dismissed.

**The browser** polls a small status endpoint and downloads data only when something changed.

## How the feed decides what's important

| Level | Raised when |
|---|---|
| **Critical** | A source can't be refreshed (bad or expired token, network, proxy). A secret can't be read from the vault. A workflow has ≥ `failureCritical` failures in `feedWindowHours`. ≥ 10 stale tickets. A Sonar token expires in < 3 days. |
| **Warning** | Sign-in to Key Vault is needed. A workflow has ≥ `failureWarn` failures, or its latest run failed. A scheduled workflow is overdue. Stale or unassigned tickets. A `statusRules` match. A Sonar token expires within `tokenExpiryWarnDays`. |
| **Info** | New tickets in `newWindowHours`. A workflow is disabled. Optional GHAS volume. |

All rules live in [`src/feed.js`](src/feed.js) and are plain functions of the fetched data.

---

## Layout

```
src/
  server.js           HTTP server (loopback only), refresh loop, sign-in and admin routes
  schedule.js         which sources are due to refresh
  config.js           config (JSON with comments) + .env loading
  secrets.js          resolves keyvault:/env:/file: refs; holds secrets in memory only
  azure.js            Entra sign-in (CLI, browser PKCE, device code) + Key Vault REST
  http.js             node:http client: per-platform proxies, timeouts and rate limits, retries, readable errors
  feed.js             attention rules
  rules.js            include/exclude rules for connector data
  acks.js             acknowledged and snoozed feed items
  plugins.js          plugin loading, output validation, plugin context
  sources.js          the built-in sources table; what the browser may see of them
  log.js              structured logging to stdout
  storage.js          pluggable storage backends
  demo.js             synthetic data for --demo
  demo-sonar.js       stand-in SonarQube Cloud for the admin tools in --demo
  admin/
    plan.js           admin previews (key derivation, drift, branch pattern, deletion)
    sonar.js          admin reads (v2) and changes (v1), concurrency and rate-limit handling
  connectors/
    actions.js        GitHub Actions runs
    dismissals.js     GHAS dismissals (code scanning, secret scanning, Dependabot)
    sonar.js          SonarQube Cloud
    jira.js           Jira Cloud / Data Center
public/
  view.js             filtering, breakdowns, URL state, CSV, panel order (shared with the tests)
  app.js              rendering and interaction
  admin.js            the admin view
plugins/examples/     example plugin
storage/examples/     SQLite storage backend and a template
docs/sonar-api.md     every SonarQube Cloud call and whether it uses Web API v1 or v2
scripts/check-config.js
test/                 node:test suites, run with npm test
```

Each connector is `collect(cfg, secrets) -> plain JSON`, with no knowledge of the UI, so the same modules can move behind a Backstage backend plugin, an Azure Function or a Container App (with the snapshot written to Blob Storage) without rewriting the API logic. `secrets.js` would then be swapped for a managed identity, which is the same `getSecret` call with a different token source.

## Development

```
npm test
```

Tests use Node's built-in runner, so there is still nothing to install. They test behaviour at module interfaces: rules, the feed, view logic, scheduling, acknowledgements, storage, logging, plugins, the admin tools, the connectors (against local fake GitHub and SonarQube Cloud APIs), the HTTP client (against local fake proxies) and the secret store (against local fake Entra and Key Vault endpoints). Nothing in the suite calls a real external service.

## Security notes

- The server binds to `127.0.0.1` and rejects requests whose `Host` isn't `localhost` / `127.0.0.1` / `[::1]` (DNS-rebinding protection). Every state-changing endpoint (refresh, sign-in, sign-out, acknowledge, admin) requires a custom header, so other websites can't trigger them. Request bodies are capped at 4 KB (2 MB for admin requests, which carry project lists).
- Browser sign-in uses PKCE and a one-time `state`; a callback with an unknown or reused `state` is rejected.
- Tokens, secret values and proxy credentials are never sent to the browser. `/api/snapshot` only carries fetched data, per-secret status, and proxy host names.
- Ticket summaries and dismissal comments are user-generated. The UI escapes all of it, and a strict CSP blocks inline and third-party scripts. CSV exports prefix text cells that start with `=`, `+`, `-` or `@` so spreadsheet applications don't run them as formulas.
- Plugins run with the same access as opspulse, including tokens. Only load plugin code you trust.
- The stored snapshot (`.cache/snapshot.json` with the default file backend) holds fetched data (ticket titles, alert titles), never tokens. It is git-ignored and safe to delete.
- The admin view can change SonarQube Cloud projects for anyone who can open the dashboard, limited by the configured token's permissions. Keep the server on loopback.
- `config.json`, `config.jsonc` and `.env` are git-ignored.

## Known limitations

API usage follows the vendors' public documentation. Run `npm run check` in each new environment to confirm access. Specific considerations:

- **Sonar token expiry** relies on `expirationDate` from `api/user_tokens/search`. If your instance doesn't return it, the expiry column shows "no expiry" and no warning is raised.
- **Sonar "failing quality gate"** uses `api/components/search_projects` with `filter=alert_status = ERROR`. If that's refused, the tile shows `n/a` with the error on hover. Nothing else is affected.
- **Jira Cloud** uses the enhanced search endpoint (`/rest/api/3/search/jql`). It doesn't return a total, so counts are of fetched issues (capped by `maxIssues`, flagged in the UI if hit).
- **GHAS** alerts reopened after dismissal stay listed until the next full resync (`fullResyncHours`).
- **Entra sign-in** may be restricted by tenant policy. In that case the error page after sign-in shows an `AADSTS…` code identifying the cause.

## Optional: one-file executable

Node can bundle this into a single `.exe` with [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html). That needs a bundler step to inline `public/`. The zero-dependency `node src/server.js` route is usually easier to get past enterprise software policies, so it's the supported path.

## License

MIT. See [LICENSE](LICENSE).
