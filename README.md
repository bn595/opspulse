# opspulse

A local, single-page ops dashboard for the person (or team) who runs the platform glue nobody else understands.

It pulls from four places and puts them on one screen:

| Panel | Source | What you get |
|---|---|---|
| **Needs attention** | all of the below | One ranked feed: *"3 failures in Sync group permissions in the last 24h"*, *"12 open tickets untouched for 7+ days"*, *"Sonar token expires in 5d"*, *"Jira refresh failed: 401"* |
| **Pipelines** | GitHub Actions | Per-workflow status, last 30 runs as a strip, success rate, failures, median duration, runs-over-time chart. 24h / 3d / 7d. |
| **Ticket backlog** | Jira (one JQL query) | Open / in progress / unassigned / stale counts, status breakdown (click to filter), created-per-day chart, sortable ticket table |
| **GHAS dismissals** | GitHub code scanning, secret scanning, Dependabot | Dismissals per org over 7 / 14 / 30d by tool, reason, person and repo, plus the recent list with comments |
| **SonarQube Cloud** | SonarQube Cloud Web API | Token validity, projects per org, not analyzed in N days, never analyzed, failing quality gate, token expiry |

It runs entirely on your machine. There's **no database, no `npm install`, no build step and no CDN**: just Node.js 18+ and these files. Tokens come from **Azure Key Vault via your company sign-in**, or from a local `.env`, and never reach the browser or the disk.

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
   This resolves every secret (signing you in to Azure with a device code if needed), applies the proxies, calls each API once and prints exactly what worked and what didn't (`401`, missing scope, wrong org, proxy refused, and so on).
4. Start it:
   ```
   npm start
   ```
   On Windows you can also double-click `start.cmd`. On macOS or Linux, run `./start.sh`. A browser tab opens at `http://localhost:4777`.

Data refreshes in the background every `server.refreshMinutes` (default 10). **Refresh** in the top bar forces a refresh. The last good data is cached in `.cache/` so a restart shows something immediately. If a source fails, its last data stays visible with a warning, and the failure goes into the feed.

Edits to `config.json` are picked up on the next refresh without a restart.

### CLI flags

```
node src/server.js [--config path/to/config.json] [--port 4800] [--no-open] [--demo]
```

`OPSPULSE_CONFIG=/path/config.json` works too. `.env` is read from the same folder as the config file. `config.jsonc` is accepted as an alternative file name.

---

## Secrets from Azure Key Vault

This is the intended setup at work: nobody pastes tokens anywhere. The three tokens live as secrets in a Key Vault, RBAC on the vault decides who may read them, and each user signs in with their own company account.

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
| **`cli`** | Runs `az account get-access-token` and reuses the Azure CLI's existing SSO session. Silent. | [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) installed and `az login` done once |
| **`browser`** | The dashboard shows **Sign in with Microsoft**. Your browser goes through company SSO (MFA, Conditional Access, whatever your tenant enforces) and comes back to `http://localhost:<port>/auth/azure/callback`. Standard OAuth 2.0 authorization code flow with PKCE, no client secret. | `tenantId` + `clientId` (an app registration, below) |
| **`device`** | Shows a code to type at <https://microsoft.com/devicelogin>. Useful when the browser callback is blocked or in `npm run check`. | `tenantId` + `clientId` |
| **`auto`** (default) | Tries `cli` first; if that fails and `tenantId`/`clientId` are set, falls back to `browser`. | – |

Whichever way you sign in, the result is an access token for `https://vault.azure.net`, which is used to call the vault's REST API directly. There is no Azure SDK involved.

### App registration (once per tenant, for `browser` / `device`)

Somebody with rights to create app registrations does this once; every user of the dashboard shares the `clientId`.

1. Entra ID → **App registrations** → **New registration**. Name it e.g. `opspulse`. Supported account types: *this organization only*.
2. **Authentication** → *Add a platform* → **Mobile and desktop applications**. Add the redirect URI `http://localhost` (Entra accepts any port for localhost on this platform). Under *Advanced settings*, set **Allow public client flows** to **Yes** (required for the device code flow).
3. **API permissions** → *Add a permission* → **Azure Key Vault** → Delegated → `user_impersonation`. Grant admin consent if your tenant requires it for delegated permissions.
4. Copy the **Application (client) ID** and **Directory (tenant) ID** into `config.json`.

No client secret, no certificate: it's a public client, exactly like the Azure CLI itself.

### Vault side

- Create the secrets (`github-token`, `sonar-token`, `jira-token`) in the vault.
- Give each dashboard user the **Key Vault Secrets User** role on the vault (or on the individual secrets). Nobody else can read them, and the dashboard reports a clear `403 … needs the "Key Vault Secrets User" role` when they can't.
- Rotate a token by updating the secret. Running dashboards pick it up on the next refresh after `cacheMinutes` (default 60), or immediately after **sign out** → sign in.

### Where secrets are kept while the tool runs

In the Node process's memory, nowhere else.

- Secret values are held for `cacheMinutes` and then re-read from the vault.
- The Entra access token (1 h) and refresh token stay in memory until you click **sign out** or stop the process. With `auth: cli`, we hold only the 1-hour access token: the long-lived session is the Azure CLI's own, protected by DPAPI (Windows) or the Keychain (macOS).
- `.cache/snapshot.json` holds fetched *data* only (run metadata, ticket titles). `/api/snapshot` carries no token, secret, or proxy credential, and the UI only ever sees `ok / missing / pending / error` per secret.

Why not encrypt a token cache on disk? Any key a local tool could use to encrypt it would be readable by the same user account, so it would add complexity without adding protection. Not persisting is the honest design, and signing in again is a one-click SSO.

---

## Proxies

Node does not honour `HTTPS_PROXY` on its own, so proxies are explicit, **one per platform**:

```jsonc
"network": {
  "proxies": {
    "github": "",                               // direct
    "sonar": "http://proxy.corp.example:8080",  // via proxy
    "jira": "env:OPSPULSE_PROXY_JIRA",          // from .env (handy when it needs user:pass@)
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
- a literal string (fine for an email; don't do it for tokens)

| Token | Needs |
|---|---|
| **GitHub** | **Classic PAT:** `repo`, `security_events`, `read:org`. The account must be an org owner or in the **security manager** role to read org-level alerts. If your org enforces SSO, **authorize the token for SSO**. **Fine-grained PAT:** owner = the org; repository permissions *Actions: read*, *Code scanning alerts: read*, *Secret scanning alerts: read*, *Dependabot alerts: read*, *Metadata: read* on all repos you want counted. |
| **SonarQube Cloud** | A user token from *My Account → Security* for an account with **Administer** on each organization. Project search needs admin rights. Without them those numbers show `n/a`. |
| **Jira Cloud** | Your Atlassian email (`jira.email`) and an API token from <https://id.atlassian.com/manage-profile/security/api-tokens>. The account must be able to browse the projects in your JQL. |
| **Jira Data Center / Server** | Set `"deployment": "datacenter"` and use a Personal Access Token. `email` is not needed. |

GitHub Enterprise Server or GHE.com: set `github.apiUrl` (for example `https://github.example.com/api/v3`).

SonarQube Cloud US region: set `sonar.url` to `https://sonarqube.us`.

---

## Configuration reference

Everything has a default. Only set what you need. See [`config.example.jsonc`](config.example.jsonc).

### `server`
| key | default | |
|---|---|---|
| `port` | `4777` | If the port is taken, the next free one (up to +10) is used |
| `host` | `127.0.0.1` | Keep this on loopback. There's no login. |
| `openBrowser` | `true` | |
| `refreshMinutes` | `10` | Background refresh interval |

### `network`
| key | default | |
|---|---|---|
| `proxies.github` / `.sonar` / `.jira` / `.azure` | `""` | Proxy URL per platform, empty = direct. Accepts `env:` / `file:` / `keyvault:` refs (not `keyvault:` for `azure`). |
| `caFile` | `""` | Extra PEM CA bundle, relative to the config file |
| `timeoutSeconds` | `30` | Per request |

### `secrets.azureKeyVault`
| key | default | |
|---|---|---|
| `vaultUrl` | `""` | `https://<name>.vault.azure.net`. Required when any `keyvault:` ref is used. |
| `auth` | `auto` | `auto` / `cli` / `browser` / `device` |
| `tenantId`, `clientId` | `""` | For `browser` / `device` (and `auto`'s fallback) |
| `authority` | `https://login.microsoftonline.com` | Change for sovereign clouds |
| `scope` | `https://vault.azure.net/.default` | Change for sovereign clouds (e.g. `https://vault.usgovcloudapi.net/.default`) |
| `cacheMinutes` | `60` | How long fetched secret values are kept before re-reading the vault |

### `github.actions`
| key | default | |
|---|---|---|
| `enabled` | `true` | |
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
| `orgs` | `[]` | Orgs to count |
| `lookbackDays` | `30` | 7 / 14 / 30 / 90 window picker, capped at this |
| `tools` | all three | Any of `code-scanning`, `secret-scanning`, `dependabot` |
| `secretResolutions` | everything except `revoked` | Which secret-scanning resolutions count as a "dismissal" |
| `feed` | `false` | Set to `true` to post an info item when an org has ≥ `feedWarnCount` dismissals in the window |
| `maxPagesPerTool` | `20` | 100 alerts per page. The UI warns if the cap is hit. |

### `sonar`
| key | default | |
|---|---|---|
| `url` | `https://sonarcloud.io` | |
| `organizations` | all orgs you're a member of | |
| `staleDays` | `30` | "Not analyzed in N days" |
| `tokenExpiryWarnDays` | `14` | Feed warns when any token on this account expires within N days |

### `jira`
| key | default | |
|---|---|---|
| `deployment` | `cloud` | `cloud` or `datacenter` |
| `baseUrl` | – | `https://your-company.atlassian.net` |
| `jql` | – | Your backlog query. To also get resolved-in-period numbers, include recently closed tickets, e.g. `project = X AND (statusCategory != Done OR resolved >= -30d)` |
| `lookbackDays` | `30` | Created-per-day chart and resolved count |
| `staleDays` | `7` | Open tickets with no update for this long are flagged |
| `newWindowHours` | `24` | Window for the "x new tickets" feed item |
| `unassignedWarn` | `1` | Feed warns at this many unassigned open tickets |
| `statusRules` | `[]` | `{ "status": "Blocked", "olderThanDays": 3, "level": "warn", "minCount": 1 }`. Use `olderThanHours` for finer control. Age is measured from the last status-category change (Cloud) or the last update. |
| `maxIssues` | `1000` | Safety cap |

---

## How the feed decides what's important

| Level | Raised when |
|---|---|
| **Critical** | A source can't be refreshed (bad or expired token, network, proxy). A secret can't be read from the vault. A workflow has ≥ `failureCritical` failures in `feedWindowHours`. ≥ 10 stale tickets. A Sonar token expires in < 3 days. |
| **Warning** | Sign-in to Key Vault is needed. A workflow has ≥ `failureWarn` failures, or its latest run failed. A scheduled workflow is overdue. Stale or unassigned tickets. A `statusRules` match. A Sonar token expires within `tokenExpiryWarnDays`. |
| **Info** | New tickets in `newWindowHours`. A workflow is disabled. Optional GHAS volume. |

All rules live in [`src/feed.js`](src/feed.js) and are plain functions of the fetched data, so adding one takes a few lines.

---

## Layout

```
src/
  server.js           HTTP server (loopback only), scheduler, cache, sign-in routes
  config.js           config (JSON with comments) + .env loading
  secrets.js          resolves keyvault:/env:/file: refs; holds secrets in memory only
  azure.js            Entra sign-in (CLI, browser PKCE, device code) + Key Vault REST
  http.js             node:http client: per-platform proxies, extra CA, retries, readable errors
  feed.js             attention rules
  demo.js             synthetic data for --demo
  connectors/
    actions.js        GitHub Actions runs
    dismissals.js     GHAS dismissals (code scanning, secret scanning, Dependabot)
    sonar.js          SonarQube Cloud
    jira.js           Jira Cloud / Data Center
public/               index.html, app.js, styles.css: no framework, no build
scripts/check-config.js
```

Each connector is `collect(cfg, secrets) -> plain JSON`, with no knowledge of the UI. That's deliberate: the same modules can move behind a Backstage backend plugin, an Azure Function or a Container App (with the snapshot written to Blob Storage) without rewriting the API logic. `secrets.js` would then be swapped for a managed identity, which is the same `getSecret` call with a different token source.

## Security notes

- The server binds to `127.0.0.1` and rejects requests whose `Host` isn't `localhost` / `127.0.0.1` / `[::1]` (DNS-rebinding protection). Every state-changing endpoint (refresh, device sign-in, sign-out) requires a custom header, so other websites can't trigger them.
- Browser sign-in uses PKCE and a one-time `state`; a callback with an unknown or reused `state` is rejected.
- Tokens, secret values and proxy credentials are never sent to the browser. `/api/snapshot` only carries fetched data, per-secret status, and proxy host names.
- Ticket summaries and dismissal comments are user-generated. The UI escapes all of it, and a strict CSP blocks inline and third-party scripts.
- `.cache/snapshot.json` holds fetched data (ticket titles, alert titles), never tokens. It's git-ignored. Delete it whenever you like.
- `config.json`, `config.jsonc` and `.env` are git-ignored.

## Known limits / unverified

The API calls follow GitHub's, Atlassian's, Sonar's and Microsoft's public docs. In this repo they've been exercised against the live APIs for authentication failures only, not with real data. Run `npm run check` first in a new environment. Specific things to watch:

- **Sonar token expiry** relies on `expirationDate` from `api/user_tokens/search`. If your instance doesn't return it, the expiry column shows "no expiry" and no warning is raised.
- **Sonar "failing quality gate"** uses `api/components/search_projects` with `filter=alert_status = ERROR`. If that's refused, the tile shows `n/a` with the error on hover. Nothing else is affected.
- **Jira Cloud** uses the enhanced search endpoint (`/rest/api/3/search/jql`). It doesn't return a total, so counts are of fetched issues (capped by `maxIssues`, flagged in the UI if hit).
- **GHAS** pages are sorted by `updated` and stop at the window edge. Very large orgs may need a higher `maxPagesPerTool`.
- **Entra browser sign-in** has been tested up to the redirect to `login.microsoftonline.com` and the callback validation; the final token exchange and Key Vault read were tested against local fakes, not a real tenant. If your tenant blocks public clients or requires admin consent, the error page after sign-in will carry the `AADSTS…` code to look up.

## Optional: one-file executable

Node can bundle this into a single `.exe` with [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html). That needs a bundler step to inline `public/`. The zero-dependency `node src/server.js` route is usually easier to get past enterprise software policies, so it's the supported path.

## License

MIT. See [LICENSE](LICENSE).
