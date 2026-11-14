# @smarty/plugin-mail-intake

A trusted CODE-only worker for the existing smarty@ routing routine. No model,
agent invocation, Gmail writes, custom UI, or Paperclip core change.

## Documented feature first

[PLUGIN_AUTHORING_GUIDE.md:366–370](https://github.com/Smarty-Pants-Inc/paperclip/blob/bba01a19a6f1e61c0c2d3a30f7595a9a3d3dde17/doc/plugins/PLUGIN_AUTHORING_GUIDE.md#L366-L370)
distinguishes managed routines (visible business work) from plugin `jobs[]`
(runtime maintenance). This plugin uses `jobs.schedule` and
`ctx.jobs.register("mail-intake", handler)` for `*/2 * * * *`; only a new message
fires the existing business routine. See also the
[SDK jobs contract](https://github.com/Smarty-Pants-Inc/paperclip/blob/bba01a19a6f1e61c0c2d3a30f7595a9a3d3dde17/packages/plugins/sdk/README.md#scheduled-recurring-jobs) and
[routine webhooks/idempotency](https://github.com/Smarty-Pants-Inc/paperclip/blob/bba01a19a6f1e61c0c2d3a30f7595a9a3d3dde17/docs/api/routines.md#fire-public-trigger).
The package layout follows [fork PR #23](https://github.com/Smarty-Pants-Inc/paperclip/pull/23)
(`factory-lead/g12-backstop-plugin`).

Parked-message diagnostics use the documented
[`onHealth()` lifecycle hook (SDK README:127)](https://github.com/Smarty-Pants-Inc/paperclip/blob/96c12d3a01cc5cbb90e4bd09a3e919d88d25cd23/packages/plugins/sdk/README.md#L127)
which returns `{ status, message?, details? }` for the existing health dashboard.
The [SDK contract:250–258](https://github.com/Smarty-Pants-Inc/paperclip/blob/96c12d3a01cc5cbb90e4bd09a3e919d88d25cd23/packages/plugins/sdk/src/define-plugin.ts#L250-L258)
confirms the host surfaces these diagnostics. No custom status UI or core change.

## Restart recovery (0.1.2)

Startup, each job tick and health reconstruct the single configured company from
saved host configuration, not a config-change notification or plugin KV row.
[`PluginCompaniesClient.list()` (SDK types.ts:1180–1193)](../sdk/src/types.ts#L1180-L1193)
provides company IDs; [`ctx.config.get(companyId)` (430–437)](../sdk/src/types.ts#L430-L437)
reads each company's saved config. Empty configs are unconfigured; a nonempty
invalid config or multiple configured companies fails closed. No ID, config or
credential is copied into instance state. This also recovers pre-0.1.2 installs
with saved config but **zero plugin_state rows**, without a config re-save.

### 0.1.3 / 0.1.4 fixes found on a real c1dea0db host

- 0.1.3: setup and ticks skip companies the host scope-denies (`company context
  is required`) instead of aborting discovery.
- 0.1.4: the board `initialize-seen` action accepts the `renderEnvironment` key
  the host always forwards (`server/src/routes/plugins.ts:1772` sends
  `body?.renderEnvironment ?? null`; SDK `worker-rpc-host.ts:2115-2120` merges it
  into params). 0.1.3 refused it and reported the wrong code, `config invalid`.
  Bad action input now reports `params invalid`. An enabled tick with missing or
  malformed seen state now reports `state invalid`, not `mailbox read failed`.

### 0.1.5 (review-fleet-2 F1/F2, live prod F3)

- F3: on prod, `initialize-seen` hit the host's 30 s action cap (`RPC call
  "performAction" timed out after 30000ms`, `server/src/services/
  plugin-worker-manager.ts:82`) while reading 58 messages. The action now only
  validates and records the request and returns `{accepted:true}`; the next job
  tick (5-minute cap, `plugin-job-scheduler.ts:50`) reads the mailbox and writes
  the baseline. Health reports `initializing`, then `ok`. Metadata reads run in
  a fixed pool of 8 (same request count, bounded by the 240 s read signal).
- F1: a scope denial is skipped only for companies the host never reported as
  configured. The host replays `configChanged` for each saved config row at
  worker start (`plugin-loader.ts:2497-2501`) and on each save; a denied company
  in that set fails the job and health with `config read failed`.
  `multiCompanyConfig: true` lets a second company's `configChanged` reach the
  plugin (SDK `worker-rpc-host.ts:1979-1997`); the plugin still fails closed on
  two configured companies.
- F2: one code per step: `params invalid`, `host read failed`, `config read
  failed`, `config invalid`, `config enabled`, `state read failed`, `state
  invalid`, `state exists`, `state write failed`, `initialization pending`,
  `seenIds not in window`, `mailbox read failed`, `busy`.

Discovery requires the documented `companies.read` capability (SDK README:413).
It is the only added capability; an upgrade may require the host's normal
capability approval before activation (PLUGIN_SPEC.md:1595). Do not bypass it.
The job fails if no company resolves; `onHealth()` returns
`{status:"error", message:"mail intake is not configured"}` instead of healthy.
Discovery/invalid-config failures use the fixed `could not read mail` message.

The [SDK action context (protocol.ts:442–460)](../sdk/src/protocol.ts#L442-L460)
names a board principal **`"user"`**, not `"board"`; the host bridge translates
its BOARD actor to that shape (`server/src/routes/plugins.ts:817–824`). A board
user needs no agent or run ID. Initialization requires the host context company,
actor company and injected parameter company to all match the recovered company;
foreign/global contexts are refused before secret, Gmail or state-write calls.

## Secret-ref schema / runtime boundary

The manifest declares each ref as `{type:"string", format:"secret-ref"}`.
The settings picker still saves the **binding object**, never a raw UUID or value:
[PLUGIN_SPEC.md:1293](../../../doc/plugins/PLUGIN_SPEC.md#L1293) and
[PLUGIN_SPEC.md:1501](../../../doc/plugins/PLUGIN_SPEC.md#L1501).
The host [plugin-config-validator.ts:32–34](../../../server/src/services/plugin-config-validator.ts#L32-L34)
projects valid bindings to IDs for Ajv validation only. `parseConfig` validates
stored binding objects, and the worker passes them unchanged to
`ctx.secrets.resolve(ref, {companyId, configPath})` (SDK `src/types.ts`,
`PluginSecretsClient.resolve`). Do not change runtime config to UUID strings.
The authoring guide and SDK README at this package's base revision do not
specify this schema projection; the cited specification and host validator do.
`tests/host-config.test.ts` exercises that actual host validator plus runtime
secret resolution and preserves the old object-schema failure as a control.

## Contract

1. Discover saved config at startup and on each tick, always with explicit
   company IDs. Disabled jobs do no mail, secret or state work. Unconfigured
   jobs fail visibly and health reports not configured. Only one company may
   have a nonempty config; a different/global company save fails closed.
2. Read explicitly initialized, company/mailbox-scoped version-2 state: seen
   `{id, internalDate}` records, failures `{id, internalDate, attempts,
   nextRetryAt, lastFailureAt}`, and a monotonic `notBefore` floor (epoch ms).
   Only IDs, millisecond timestamps and counts persist. Older version-2 rows
   without a floor get the current window cutoff after their first complete
   tick. Missing, legacy-array or corrupt state fails, never silently baselines history.
3. Resolve the company-bound `gmailGrantRef`: a secret **JSON string** containing
   exactly `{client_id, client_secret, refresh_token}`. Exchange the original
   matching user OAuth grant at `https://oauth2.googleapis.com/token`. Required
   grant: `https://www.googleapis.com/auth/gmail.readonly` (`gmail.metadata`
   cannot use `q`). Tokens are execution-local and never written to KV/logs.
4. List at `gmail.googleapis.com` with
   `q=-in:sent -in:drafts -in:chats newer_than:7d`, including archived incoming
   mail. `scanWindowDays` defaults to 7 and accepts integer days 1–30 only.
   The initialize-seen action uses the same scanner and window. Exhaust all
   pages, then get only
   `format=metadata&fields=id,threadId,internalDate` for unseen IDs. No subjects,
   addresses, snippets, headers or bodies are requested. `resultSizeEstimate` is
   not an exact count. Terminal-page exhaustion is not an immutable snapshot.
5. Only after **all** reads succeed, resolve the separate `routineFireSecretRef`
   and POST one payload per unseen message to
   `<routineOrigin>/api/routine-triggers/public/<routinePublicId>/fire`:
   `{messageId, threadId, receivedTime}`. `receivedTime` is Gmail `internalDate`
   rendered as UTC ISO-8601, not the scan clock. No other payload fields.
6. Stable `Idempotency-Key` = SHA-256 of company/mailbox/message identity, scoped
   to the routine. Save the ID immediately after each 2xx. Retry skips saved
   IDs; HTTP/KV crash gaps reuse the receiver's receipt key. This is deduplicated
   **admission**, not exactly-once transport or successful downstream routing.
7. A delivery failure checkpoints only its ID/date, attempt count and next retry,
   then continues to the next message. Backoff starts at two minutes, doubles,
   and caps at six hours. After ten failures it stays parked until it ages out;
   each complete tick names the parked Gmail IDs in the fixed-text warning
   `mail intake has parked deliveries: <id>, <id>` through the SDK logger/health
   dashboard. Nothing but validated IDs varies in this warning. `onHealth()`
   also reads durable company/mailbox state and returns `status: "degraded"`, the
   same warning, and `details.parked: [{id, attempts, lastFailureAt}]`. No mail or
   secret calls are made for health. `lastFailureAt` is epoch ms; legacy failures
   without that recorded time report `null`, not an invented time. No subject,
   sender, body or provider error is exposed. Backoff/parked IDs do not block
   later messages. A successful retry removes its failure record and adds seen.
8. Initialize-seen records the start of its scanned window as `notBefore`.
   After a complete read, each tick advances this floor to
   `max(previous notBefore, current window cutoff)` and prunes seen/failure
   records below it, even on an empty tick. Listed messages with
   `internalDate < notBefore` are never fired or added to seen. The floor never
   moves backward: **widening the window never back-fills**, even after old IDs
   have been pruned. A message exactly at the floor remains eligible and its
   seen record is retained. Never advance the floor or prune on an incomplete
   read, or retain message/thread content in state.

## Egress and failures

`src/intake.ts` exports a fully frozen build-time `ALLOWED_HOSTS` array:
`gmail.googleapis.com`, `oauth2.googleapis.com`, `hq.smartypants.ai`. Config cannot
widen it. `routineOrigin` must exactly match `https://hq.smartypants.ai` (no port,
userinfo, IP literal, trailing slash or normalization). This is the fail-closed
build-time fallback: `PluginContext` exposes no instance URL
(`packages/plugins/sdk/src/types.ts:2210–2318`), nor does the normal worker
environment (`server/src/services/plugin-loader.ts:155–179`,
`plugin-worker-manager.ts:3090–3101`). No distinct real TEST origin was supplied;
none is guessed or accepted. A distinct TEST instance requires its canonical
origin frozen into a reviewed rebuild, never an arbitrary config override.
All requests pass `safeHttp`, which also checks exact methods/paths and refuses
redirects. This is a **code-level check**, not a network sandbox: Paperclip's
`http.outbound` capability itself remains broad.

Transport, token, list/page, metadata, validation, or state failure throws only
`could not read mail`, with no cause/provider text logged. Any incomplete scan
leaves seen unchanged and fires nothing. Page bounds (100 pages of at most 500
IDs) and the 240-second tick signal are failed reads, not quiet successes.
The SDK HTTP bridge currently omits `signal`/`redirect`; the host itself returns
redirects and bounds each request to 30 seconds. The wrapper checks tick abort
before and after every awaited fetch (a host call already running must settle).
Delivery failure retains earlier successful per-ID checkpoints and does not
abort other deliveries. State-write failure remains fatal. The explicit window
is the agreed catch-up cut: mail older than that window is intentionally not
replayed, and old IDs/failures are pruned. Widening that window does not back-fill
mail below the persisted monotonic floor.

## Scheduling and evidence limits

The org explicitly requested v1's two-minute external-mail reconciliation.
There is no Gmail push ingress in this bounded slice; the shared plugin scheduler
owns the deadline, not a new worker timer. Scanning stops when disabled or
unconfigured. Enabled quiet ticks still read Gmail, so this is not idle/sleep
proof. A stopped host cannot be woken by its internal cron. No host sleep blocker
is relaxed. Operators reconcile outstanding host runs after process loss.

Run `pnpm typecheck`, `pnpm test`, `pnpm build` from this package after a filtered
workspace install. Tests use mocked host services and reject native fetch. Their
keep reasons are trust boundaries, IDs-only data safety and otherwise costly
failure injection. They do **not** prove TEST credentials, installation, receiver
variable compatibility, `always_enqueue`, or live routing. See [INSTALL.md](INSTALL.md).
