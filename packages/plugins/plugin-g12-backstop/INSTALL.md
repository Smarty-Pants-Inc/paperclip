# G12 backstop: TEST-company installation

This is a **new plugin consumer, not a core patch**. It runs one code-only job,
`g12-backstop`, every five minutes (UTC cron `*/5 * * * *`). GitHub webhooks and
core review recovery remain the normal/unattended path. This job only detects
missing reviews or failed checks and requests an **at-least-once owner-issue
wake**. Duplicate admissions are possible; the owner must make the effect
idempotent under the contract below. The plugin never posts a review request,
a GitHub comment, or a human mention itself.

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
no acceptance/pending receipt is recorded. The key retries after correction and
its per-key backoff deadline (initially five minutes); later PRs are still scanned.

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
an external runtime dependency, following the SDK's bundler shape. It also emits
`dist/reconcile.js`, an admin-only single-key reconciliation helper (below), not
a registered worker tool, route or scheduled job. No lockfile
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
   at or after M minutes and its owner-agent issue wake. Repeat a tick and
   restart/replay: a saved sent receipt suppresses the same semantic key. Prove
   that a pending-only crash re-arms after the bounded wait.
2. Completed failing/timed-out current-head check: acknowledged wakes are
   suppressed per distinct key; uncertain/deferred delivery may repeat. Confirm
   the owner checks GitHub before acting and does not repeat an existing effect.
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

## Owner contract: at-least-once wake, idempotent effect

Every wake `reason` contains one JSON line with `dedupeKey`, `repo` (the configured
`owner/name`), `prNumber`, and `headSha`. Failing-check wakes also contain
`checkRunId` and `conclusion`. The second line is always exactly:

> Before acting, check GitHub for an existing review/comment or action at this PR head sha (or for this check run); if one exists, stop.

The host carries this reason into the owner's wake context as `wakeReason`.
The owner must read it, inspect GitHub at the specified PR head/check run before
acting, and stop if an existing review/comment or action already covers it.
Duplicate wakes (including a deferred admission followed by a retry) are not
permission to repeat an action. The owner performs the effect check using its
own authorized GitHub access; the plugin does not perform that check, obtain
write permissions, or promise exactly-once effects on the owner's behalf.
Preserve this contract in the assigned owner's instructions before enabling.

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
  Editable names never participate in dedupe: renamed checks keep the same key,
  while same-name checks from distinct apps/runs remain distinct. The key is
  passed as SDK `idempotencyKey` and as `dedupeKey` in the wake reason JSON.
- **At-least-once delivery, not exactly-once admission.** Before dispatch, persist
  `{ pendingAt, reconcileAt, agentId, issueId }` under
  `wake:<SHA-256 of semantic key>`. Only an acknowledged write permits dispatch.
  `queued:true` records **sent**, using the compatible
  `{ acceptedAt, agentId, issueId }` receipt shape. A saved sent receipt suppresses
  future dispatches for that key. If its write fails, pending remains recoverable.
  `deduped` counts suppression by either sent or unexpired pending receipts, not
  proof of model execution; `wakes` counts acknowledged acceptance. No raw key,
  check name, PR title/body, provider row or credential is stored in plugin KV.
  The host serializes this job and the worker rejects concurrent calls; there is
  no KV compare-and-swap or exactly-once-delivery claim.
- **Per-key retry backoff and cursor progress.** Throws from `requestWakeup`,
  `queued:false`, and malformed acknowledgements save backoff, then clear pending.
  Neither throws nor `queued:false` prove non-admission: the host can accept
  deferred work and return false, or throw after acceptance. Retrying is deliberate
  under the owner effect contract. Local issue-read failures/assignee mismatches
  also save backoff before dispatch. Retry delays are 5, 10, 20, 40, then 60 minutes,
  capped at 60 minutes and persisted across worker restart. During key backoff
  there is no issue-read/wakeup call for that key (the normal bounded GitHub scan
  still runs). `refused` includes keys skipped for backoff. Refused keys never pin
  the scan cursor; siblings and later PRs are visited. Fixed refusal errors are
  reported after advancing/checkpointing the scan, not at the first refused PR.
  Upstream error text/type is never used to decide whether an admission happened.
- **Bounded pending recovery.** New pending reservations expire after 30 minutes.
  A crash after pending but before dispatch, a lost pending-write acknowledgement,
  or a failed sent-receipt write re-arms on the next eligible observation at/after
  `reconcileAt`, subject to persisted backoff, current eligibility, host availability,
  and scan/GET/rate limits. Existing pending receipts (including `unresolvedAt`)
  retain their saved deadline but no longer suppress forever. Each observation
  attempts at most one dispatch per key; no in-tick retry loop, new timer or history
  poller is added. Retry deadlines are eligibility bounds, not wall-clock delivery
  guarantees. A lost response can yield duplicate admissions, and the owner must
  check GitHub before acting. The SDK transports the deterministic `idempotencyKey`
  (`packages/plugins/sdk/src/types.ts:1550-1558`), but the shipped host has no
  general `g12:*` replay fence or reliable admission receipt
  (`server/src/services/plugin-host-services.ts:2426-2490`,
  `server/src/services/heartbeat/queue.ts:4904-4985`).
- The numeric-ID key format is incompatible with the earlier name-based format;
  before upgrading an already-enabled installation, reconcile active conditions
  and expect name-based receipts not to dedupe the new keys. Old name-based
  receipts are not read or copied into new state.
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
- Job errors and warning-log codes use the closed `G12ErrorCode` enum. Only the
  locally constructed `G12Error` type carries a trusted `.code`; boundaries never
  select a code from `.message`, even if upstream text exactly equals a valid
  enum member. Untyped failures use the fixed code for that call site.
- This is the explicitly requested five-minute safety-net scan for missed
  external GitHub webhooks; GitHub is the source of truth. Enabled but otherwise
  idle scans still contact GitHub. Unconfigured/`enabled:false` ticks do not
  access HTTP, secrets or KV. Disable the plugin to stop scheduled execution.
  There is no plugin-owned timer. Keep host sleep blockers: an internal cron
  cannot wake a stopped host (`doc/idle-plugin-jobs.md:63-82`).

## Single-key operator reconciliation (lead/admin only)

Automatic pending recovery and refusal retries require no operator reconciliation.
This optional helper remains for positively evidenced corrections; the shipped
SDK has no capability here that proves whether an ambiguous `g12:*` wake was
accepted. Reconciliation is bounded to one key and at most two state reads/two
writes. The owner effect contract applies even after a manual correction.

1. Disable the plugin and wait for the in-flight job and its host requests to
   settle. Do not reconcile concurrently: company KV has no compare-and-swap.
2. Identify the exact semantic key, company, plugin record and pending receipt.
   Preserve its `pendingAt`, `agentId` and `issueId`; never dump provider payloads
   or credentials. Review that one host admission's activity/run/transport
   evidence. Limit initial investigation to 15 minutes; if inconclusive, do not
   fabricate proof or mutate state. Re-enable to allow normal bounded retries,
   or keep disabled and escalate to the lead if the owner contract is not ready.
   Do not infer non-admission from an empty history query, error message, elapsed
   time or a newly cleared blocker.
3. With positive evidence of acceptance, use `outcome: "accepted"`. With positive
   evidence that the call never dispatched, use `outcome: "not-dispatched"`.
   The latter writes per-key backoff **before** clearing pending, so a failed
   maintenance write also fails safe. It re-arms only after that retry deadline.
4. In an already-authorized, company/plugin-bound host maintenance context,
   import `reconcileWake` from the built `dist/reconcile.js`. Supply only a
   scoped state adapter exposing `get(ScopeKey)` and `set(ScopeKey, value)`;
   do not add a public endpoint, obtain new credentials or bypass authorization.
   The host's `pluginStateStore` can supply that adapter for an authorized admin;
   keep the adapter bound to the reviewed plugin ID and company.

```js
await reconcileWake(scopedState, companyId, semanticKey, {
  pendingAt, agentId, issueId, // Exact values from the reviewed pending receipt.
  outcome: "accepted",       // Or positively proven "not-dispatched" only.
});
```

The helper rejects stale timestamps, mismatched agent/issue IDs, unknown outcomes
and non-pending receipts. It validates current state, performs bounded writes and
makes no HTTP, secret or wake call. It does not discover or independently verify
proof; that is the authorized operator's obligation. Preserve the evidence link
and decision in the handoff, inspect the one receipt/backoff afterwards, and only
then re-enable. Never clear all accepted/pending receipts: that can repeat work.
