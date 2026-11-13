# G12 backstop: TEST-company installation

This is a **new plugin consumer, not a core patch**. It runs one code-only job,
`g12-backstop`, every five minutes (UTC cron `*/5 * * * *`). GitHub webhooks and
core review recovery remain the normal/unattended path. This job only detects
missing reviews or failed checks and requests one owner-issue wake. It never
posts a review request, a GitHub comment, or a human mention itself.

## Existing extension points (shipped source evidence)

Paths below are relative to the Paperclip repository root:

- Package layout / worker entry: `packages/plugins/examples/plugin-authoring-smoke-example/package.json:23-27`,
  `packages/plugins/sdk/README.md:93-140`.
- Scheduled code jobs: `packages/plugins/sdk/README.md:169-227`;
  `packages/plugins/sdk/src/worker-rpc-host.ts:2039-2045` dispatches the registered
  function, not a model. Host cron admission serializes manual and scheduled
  runs: `server/src/services/plugin-job-scheduler.ts:111-138`.
- Bound reference resolution: `packages/plugins/sdk/src/types.ts:678-706`;
  `server/src/services/plugin-secrets-handler.ts:198-269` enforces the plugin,
  company and binding path. Saving company config synchronizes bindings:
  `server/src/routes/plugins.ts:2427-2440`.
- Company KV: `packages/plugins/sdk/src/types.ts:745-829`. Proactive company
  authorization comes from config rows: `server/src/services/plugin-loader.ts:2304-2357`.
- Issue-owner wake: `packages/plugins/sdk/src/types.ts:1550-1558` and
  `server/src/services/plugin-host-services.ts:2426-2490`. The host owns company,
  blockers, budget, execution admission and mutation activity logging.
- There is **no manifest HTTP-host allowlist** in the shipped contract:
  `packages/shared/src/types/plugin.ts:692-786`. The plugin constructs only
  `https://api.github.com` URLs and refuses other origins; host HTTP pins DNS,
  blocks private addresses and does not follow redirects:
  `server/src/services/plugin-host-services.ts:180-238,283-335,1788-1801`.
  Capabilities are not a sandbox for trusted Node plugins (`packages/plugins/sdk/README.md:37-44`).

No new seam is required. RFL review and the lead's no-seam register / independent
acceptance remain handoff gates; this package does not claim they happened.

## 1. Review and bind ownership before enabling

**RFL must review this package before it is enabled**, because resolving the App
private key lets trusted plugin code sign as that App. The seven capabilities are
exactly `jobs.schedule`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`,
`plugin.state.write`, `issues.read`, `issues.wakeup`. `issues.read` is required to
verify the mapped issue's assignee before waking it. There is no agent invocation,
comment write, tool registration, UI or routine capability.

Use the existing authorized reviewer App and installation, with repository access
and GitHub **Checks: read** and **Pull requests: read**. A nonempty explicit
repository list is mandatory; `repos: "all"`, empty and missing lists are rejected
before secret resolution or HTTP. Every installation-token request carries the
repository-name restriction and read-only permissions. The App private key itself
is more powerful and is why RFL review is required.

For each PR author login, choose the owning **agent**, not Paul or the reviewer.
Prepare a dedicated, stable-assignee issue in the TEST company, assigned to that
agent and wakeable (`todo` / `in_progress` / other host-permitted status), without
unresolved blockers or an active budget hard stop.

The plugin reads the mapped issue with `issues.get(issueId, companyId)` immediately
before requesting a wake. Missing, cross-company, unassigned or differently assigned
issues are refused with `G12_ISSUE_ASSIGNEE_MISMATCH` in the warning log and job error;
no wake receipt is recorded, so the next tick retries after correction.

**Remaining SDK race limit:** `issues.requestWakeup` targets the issue's current
assignee and has no atomic expected-agent argument. The preflight read detects an
existing mismatch, but cannot prevent reassignment *between* that read and host
dispatch (`server/src/services/plugin-host-services.ts:2426-2455`). Preserve a stable
issue → agent binding while enabled; stop the plugin and settle active work before
reassignment/remapping. Atomic fencing requires a host/SDK change outside this
plugin-only patch. Do not claim unconditional wrong-assignee prevention.

## 2. Build and install (paperclip-lead, not the task agent)

In the target checkout with its normal approved dependency setup:

```sh
pnpm --filter @smarty-pants/plugin-g12-backstop build
pnpm --filter @smarty-pants/plugin-g12-backstop test
pnpm --filter @smarty-pants/plugin-g12-backstop typecheck
```

The build emits `dist/manifest.js` and `dist/worker.js`, with the shipped SDK as
an external runtime dependency, following the SDK's bundler shape. No lockfile
is changed by this patch; dependency/lockfile refresh follows repository policy.

Using an existing authorized board/admin session, install through Settings →
Plugins, or `POST /api/plugins/install` with this JSON body (substitute the
absolute path **on the Paperclip server**, not the task host):

```json
{
  "packageName": "/ABSOLUTE/CHECKOUT/packages/plugins/plugin-g12-backstop",
  "isLocalPath": true
}
```

The request schema is `server/src/routes/plugins.ts:139-147`. Keep the returned
plugin record ID. Local-path installation requires this checkout and built SDK
to remain present. It is a development/TEST workflow, not a published npm
artifact (`packages/plugins/sdk/README.md:37-52`). On a cloud-managed host,
local installs are limited to the approved bundled catalog root; do not bypass
that restriction (`server/src/routes/plugins.ts:1223-1246`). This patch does not
change the production bundle/catalog/distribution process.

## 3. Save TEST-only config and the single secret reference

Have the lead select the App private-key secret **reference already authorized
in TEST**. Do not paste a PEM, a resolved secret, a connection's private internal
binding, an environment variable or a 1Password value into plugin config. Use
exactly one `{ "type": "secret_ref", "secretId": "..." }` object; optional
`version` is `"latest"` or a positive version number.

Save via `POST /api/plugins/<plugin-record-id>/config`, or the equivalent plugin
settings form. Replace every angle-bracket placeholder below. The outer
`companyId`, inner `companyId` and secret's company must all be TEST's actual
UUID. **Do not add a second company's config row** for this single-company
worker. Start with `enabled: false`:

```json
{
  "companyId": "<TEST-company-uuid>",
  "configJson": {
    "enabled": false,
    "companyId": "<TEST-company-uuid>",
    "appId": 12345,
    "installationId": 67890,
    "privateKeyRef": { "type": "secret_ref", "secretId": "<TEST-App-key-secret-uuid>" },
    "repos": ["YourOrg/your-repo"],
    "missingReviewMinutes": 15,
    "maxGetsPerTick": 200,
    "owners": {
      "pr-author-login": { "agentId": "<owning-agent-uuid>", "issueId": "<stable-owner-issue-uuid>" }
    }
  }
}
```

`appId` and `installationId` above are examples, not deployment identities.
The save route creates/updates the secret binding for `targetType=plugin`, this
plugin record ID, TEST company and config path `privateKeyRef`. A connection's
binding alone is insufficient. Verify the saved config and bound ref metadata,
never the value. No trigger URL or second secret is used: this is the issue-wake
path. Repo names and author logins normalize to lowercase. Only explicit repository
arrays are accepted. M defaults to 15 when omitted. `maxGetsPerTick` defaults to
200 and accepts integers from 2 through 1000; two GETs allow a resumed PR-page read
and at least one check-page read per tick.

## 4. Enable, verify the real path, then leave the five-minute job enabled

After RFL and ownership review, save the same full config with `enabled: true`.
Enable the plugin via UI or `POST /api/plugins/<id>/enable` if it is not ready
(`server/src/routes/plugins.ts:2082-2118`). Confirm exactly one job via
`GET /api/plugins/<id>/jobs`, cron `*/5 * * * *`, active status. A manual check is
`POST /api/plugins/<id>/jobs/<job-record-id>/trigger`; it returns before completion.
Read `/jobs/<job-record-id>/runs` for the actual result, not just HTTP acceptance
(`server/src/routes/plugins.ts:2609-2714`).

The lead must preserve evidence on authorized **real daily-work PRs** in TEST:

1. Missing App review: record the first eligible tick/current head, then the tick
   at or after M minutes and its one owner-agent issue wake. Repeat a tick and
   restart/replay without another wake for that semantic key.
2. Completed failing/timed-out current-head check: one wake per distinct key.
   Cancelled/pending/success/stale-head checks do not wake. A new head re-arms.
3. Healthy/empty ticks: numeric counts, no new agent/model run attributable to
   this job. No human is notified directly.
4. Confirm the actual recipient matches the mapping, the binding belongs only
   to TEST, and normal host budget/blocker controls remain effective.

The subsequent owner agent's authorized `gh` mention runs under Paul's separate
user-identity grant, **never** under the plugin's installation token. The plugin
does not admit a new review or replace the core recovery patch.

No live install, App permission check, real PR action, model run or TEST-company
acceptance was performed by the implementation task.

## Policy, idempotency and operational limits

- Eligible = open, non-draft PR in the configured repositories, with a mapped
  author. First observation of that eligible `(App, installation, repo, PR, head)`
  starts the M-minute clock; PR creation time is not substituted. A present
  `Paperclip Review` from this App on this head (any status) suppresses *missing*
  review. Failures/timed-outs of any current-head check still qualify immediately.
- All repository/PR/check listings are paginated. Checks request `filter=latest`
  to avoid superseded attempts. First-seen times and wake receipts are company
  scoped in namespace `g12-v1`; no PEM/JWT/token/provider response is persisted.
- Semantic wake keys are exactly `g12:missing:<repo-id>:<pr-number>:<head-sha>` and
  `g12:fail:<repo-id>:<pr-number>:<head-sha>:<check-app-id>:<check-run-id>:<conclusion>`.
  Repository IDs come from the PR's base repository; check IDs come from GitHub.
  Editable names never participate in dedupe: renamed checks do not double-wake,
  while same-name checks from distinct apps/runs remain distinct. The same key is
  passed as both wake `reason` and SDK `idempotencyKey`.
- **Acknowledged-acceptance dedupe, not exactly-once delivery.** A key is recorded
  only after `issues.requestWakeup` returns `queued:true`. Receipts contain only
  `acceptedAt`, `agentId` and `issueId`, under `wake:<SHA-256 of semantic key>`.
  No raw key, check name, PR title/body, provider row or credential is stored.
  The host serializes this job and the worker rejects concurrent calls; there is
  no KV compare-and-swap claim.
- A pre-dispatch exception (including blockers, status or budget) fails with
  `G12_WAKE_FAILED`; `queued:false` fails with `G12_WAKE_REFUSED`. Both log only a
  fixed enum code and counts, leave no receipt and retain the current scan position
  for a retry next tick. A refused/misassigned issue therefore pauses scan progress
  at that PR until it is corrected; it does not permanently consume the wake key.
  Queued/coalesced means host acceptance, not model completion.
- **Ambiguity limit:** an accepted wake followed by a lost response or a failed
  receipt write can repeat next tick. The shipped host does not provide a general
  atomic `g12:*` replay fence (see `packages/db/src/schema/agent_wakeup_requests.ts:46-115`
  and `server/src/services/heartbeat/queue.ts:4904-4985`). Reserving before dispatch
  is deliberately not used: it permanently lost refused wakes. Exactly-once repair
  belongs at the host acceptance boundary, outside this plugin-only patch.
- To reconcile, disable the plugin, wait for active runs to settle, compare the
  specific receipt with issue activity/run history. Never reset all accepted
  receipts: that can repeat accepted wakes. No public reset API is added here.
  The numeric-ID key format is incompatible with the previous name-based format;
  before upgrading an already-enabled installation, reconcile active conditions
  and expect legacy receipts not to dedupe the new keys. Old receipts are not read
  or copied into new state.
- Receipt/history retention is intentional: deleting it weakens dedupe, including
  a return to an older head. Storage grows with observed PR heads and wake keys.
  No new maintenance scan or automatic pruning is introduced.
- Each tick has a four-minute scan budget and at most `maxGetsPerTick` GitHub GETs
  (default 200), plus one read-only installation-token POST. The company-scoped
  `scan` cursor persists a config digest, repository/page/offset positions, active
  PR number/head SHA, a review-presence bit and a retry timestamp. A recreated worker
  resumes instead of rescanning from repository one; check pagination can span ticks.
  No missing review is declared until every check page for that PR has been read.
  The resumed PR page is refreshed, and a changed PR/head resets its check position.
  GitHub page lists are not snapshots: concurrent insertions/removals can shift
  positions, with the next complete sweep providing reconciliation.
- GET/time-budget exhaustion checkpoints and yields successfully to the next host
  tick without a timer or sleep. `x-ratelimit-remaining: 0` uses `x-ratelimit-reset`
  (or a five-minute fallback); `retry-after` accepts seconds or an HTTP date. These
  deadlines survive restart, including limits on successful responses and token
  minting. Before expiry, ticks access neither secrets nor HTTP. HTTP 429 without
  a usable deadline also gets a five-minute backoff. Other HTTP errors fail closed
  and never imply missing review. The host's per-request timeout is 30 seconds.
- Job errors and warning-log codes use the closed `G12ErrorCode` enum; arbitrary
  code-shaped host strings, response bodies and provider text are never forwarded.
- This is the explicitly requested five-minute safety-net scan for missed
  external GitHub webhooks; GitHub is the source of truth. Enabled but otherwise
  idle scans still contact GitHub. Unconfigured/`enabled:false` ticks do not
  access HTTP, secrets or KV. Disable the plugin to stop scheduled execution.
  There is no plugin-owned timer. Keep host sleep blockers: an internal cron
  cannot wake a stopped host (`doc/idle-plugin-jobs.md:63-82`).
