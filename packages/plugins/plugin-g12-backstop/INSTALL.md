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
private key lets trusted plugin code sign as that App. The six capabilities are
exactly `jobs.schedule`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`,
`plugin.state.write`, `issues.wakeup`. There is no agent invocation, issue read,
comment write, tool registration, UI or routine capability.

Use the existing authorized reviewer App and installation, with repository access
and GitHub **Checks: read** and **Pull requests: read**. Explicit repository lists
also restrict the requested installation token to those repository names. `all`
means all repositories accessible to that installation. Token permissions are
requested read-only; the App private key itself is more powerful and is why RFL
review is required.

For each PR author login, choose the owning **agent**, not Paul or the reviewer.
Prepare a dedicated, stable-assignee issue in the TEST company, assigned to that
agent and wakeable (`todo` / `in_progress` / other host-permitted status), without
unresolved blockers or an active budget hard stop.

**Important SDK limit:** `issues.requestWakeup` targets the issue's *current*
assignee; its signature has no expected-agent fence. With the exact capability
set, this plugin cannot read/verify the assignee. `owners[login].agentId` records
intended ownership but is not runtime authorization. The lead must verify and
preserve the issue → agent binding before enabling. Stop the plugin and settle
active work before reassignment/remapping. If that operational condition cannot
be guaranteed, do not enable this issue-path build; escalate rather than add
undeclared read/invoke authority. No unconditional wrong-assignee prevention is
claimed (`server/src/services/plugin-host-services.ts:2429-2455`).

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
path. Repo names and author logins normalize to lowercase. `repos` can be `"all"`;
an explicit list is safer for first enable. M defaults to 15 when omitted.

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
- Semantic wake keys are exactly `g12:missing:<repo>:<pr>:<head>` and
  `g12:fail:<repo>:<pr>:<head>:<check name>:<conclusion>`. The SDK's `idempotencyKey`
  is the issue-path equivalent of an HTTP `Idempotency-Key` header. The same key
  is in wake `reason`, so the owner receives the repo/PR/head/check context.
- **At-most-once attempt, not exactly-once delivery.** Shipped heartbeat stores
  arbitrary keys but lacks a general `g12:*` unique/replay fence (see
  `packages/db/src/schema/agent_wakeup_requests.ts:46-115` and
  `server/src/services/heartbeat/queue.ts:4904-4985`). The plugin durably reserves
  a receipt **before** issuing the wake. The host serializes this job and the
  worker rejects concurrent calls; there is no KV compare-and-swap claim.
- A crash after reservation but before dispatch can lose the wake; a crash or
  timeout after dispatch leaves an uncertain receipt. Refused/uncertain/reserved
  receipts do not automatically replay. While the same condition persists,
  ticks fail with `G12_WAKE_*_RECONCILE_RECEIPT`, and log numeric counts only.
  Queued/coalesced means host acceptance, not model completion. Multiple distinct
  keys may coalesce according to ordinary host execution policy.
- To reconcile, disable the plugin, wait for active runs to settle, inspect the
  exact receipt in plugin state and corresponding issue activity/run history.
  Hash = SHA-256 of the semantic key; state key = `wake:<hex hash>`. Never reset
  all state or blindly delete reservations: that can duplicate an accepted wake.
  Any targeted re-arm after proof of no accepted effect is an explicit authorized
  operator action, not an automatic retry. No public reset API is added here.
- Receipt/history retention is intentional: deleting it weakens dedupe, including
  a return to an older head. Storage grows with observed PR heads and wake keys.
  No new maintenance scan or automatic pruning is introduced.
- Each tick has a four-minute scan budget and at most 5,000 GitHub requests. The
  host's per-request timeout is 30 seconds. A budget/rate-limit/HTTP error fails
  the job, never implies missing review, and never starts a model by itself.
  Use a bounded repo list if a full installation cannot fit that budget.
- This is the explicitly requested five-minute safety-net scan for missed
  external GitHub webhooks; GitHub is the source of truth. Enabled but otherwise
  idle scans still contact GitHub. Unconfigured/`enabled:false` ticks do not
  access HTTP, secrets or KV. Disable the plugin to stop scheduled execution.
  There is no plugin-owned timer. Keep host sleep blockers: an internal cron
  cannot wake a stopped host (`doc/idle-plugin-jobs.md:63-82`).
