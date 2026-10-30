# SonarQube Cloud API usage

opspulse uses SonarQube Cloud **Web API v2** where it offers the operation, and **Web API v1** where it does not yet. SonarSource's [v2 documentation](https://api-docs.sonarsource.com/sonarqube-cloud/default/landing) says: *"Some capabilities are not yet exposed in this version of our APIs. If you can't find an endpoint here, you may find it in the previous version of the API on the SonarQube Cloud Web API v1 page."*

| | Base URL (US region) | Config |
|---|---|---|
| v1 | `https://sonarqube.us/api/...` | `sonar.url` |
| v2 | `https://api.sonarqube.us/<service>/...` | `sonar.apiUrl` (empty = derived from `sonar.url`) |

Both use the same bearer token, the same `sonar` proxy entry (`network.proxies.sonar`) and the same rate-limit tracking.

Behaviour to know about (checked against sonarcloud.io by `npm run test:live`):
- **Lists are comma-separated:** `keys=a,b`. When a parameter is repeated (`keys=a&keys=b`), only the last value counts.
- **No keys in URL paths:** CloudFront in front of the API refuses paths containing the word "admin" (`…/x-admin`, `…/Admin`, but not `…/administration`) with an HTML 403. Project keys often contain it, so opspulse sends keys only in query strings and form bodies.

Migration is tracked in [issue #1](https://github.com/bn595/opspulse/issues/1). When SonarSource adds a v2 endpoint for something below, move the call, update this table, and tick the issue's checklist.

## Admin tools ([src/admin/sonar.js](../src/admin/sonar.js))

| Operation | API | Endpoint | v2 status (checked 2026-10-26) |
|---|---|---|---|
| Organization key → ID | **v2** | `GET /organizations/organizations?organizationKey=` | — |
| List projects (5,000 per page) | **v2** | `GET /projects/projects?organizationIds=&keys=&pageIndex=&pageSize=` | — |
| Which keys are taken (100 per request, any organization the token can see) | **v2** | `GET /projects/projects?keys=a,b,…` | Not `GET /projects/project-keys/{key}`: the key is in the path (see above) |
| Change a project key | v1 | `POST /api/projects/update_key` (`from`, `to`) | Not in v2 |
| Read long-lived branch pattern | v1 | `GET /api/settings/values?component=&keys=sonar.branch.longLivedBranches.regex` | No project settings in v2 |
| Set long-lived branch pattern | v1 | `POST /api/settings/set` (`component`, `key`, `value`) | No project settings in v2 |
| List a project's branches | v1 | `GET /api/project_branches/list?project=` | Only the Analysis API's `analysis-statuses` (analysis status per branch, not a branch list) |
| Delete a branch | v1 | `POST /api/project_branches/delete` (`project`, `branch`) | Not in v2 |

## Dashboard panel ([src/connectors/sonar.js](../src/connectors/sonar.js))

| Operation | API | Endpoint | v2 status (checked 2026-10-26) |
|---|---|---|---|
| Token is valid | v1 | `GET /api/authentication/validate` | Not in v2 |
| Organizations the token belongs to | v1 | `GET /api/organizations/search?member=true` | `GET /organizations/organizations` exists; membership filter not confirmed |
| Projects per organization (count) | v1 | `GET /api/projects/search?organization=&ps=1` (paging total) | `GET /projects/projects?pageSize=0` returns a total; candidate |
| Not analyzed since N days (count) | v1 | `GET /api/projects/search?analyzedBefore=` | No date filter in v2 |
| Never analyzed (count) | v1 | `GET /api/projects/search?onProvisionedOnly=true` | No equivalent filter in v2 |
| Failing quality gate (count) | v1 | `GET /api/components/search_projects?filter=alert_status = ERROR` | Organizations API has project measures; not evaluated |
| Tokens and expiry for the current user | v1 | `GET /api/user_tokens/search` | Not in v2 |

## Plugins ([src/plugins.js](../src/plugins.js))

`ctx.api.sonar.get(path)` calls `sonar.url` (v1). For v2, plugins can call `ctx.request(url, { platform: 'sonar', headers })` with a URL under `sonar.apiUrl`.
