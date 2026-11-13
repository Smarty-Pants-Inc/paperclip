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

## Contract

1. Re-read config using the explicitly bound company on each tick. Disabled or
   never configured means no mail, secret, or state activity. Only one company
   can be bound to a worker; a different/global company save fails closed.
2. Read an explicitly initialized, company/mailbox-scoped array of seen Gmail
   message IDs. Missing/corrupt state fails, never silently baselines history.
3. Resolve the company-bound `gmailGrantRef`: a secret **JSON string** containing
   exactly `{client_id, client_secret, refresh_token}`. Exchange the original
   matching user OAuth grant at `https://oauth2.googleapis.com/token`. Required
   grant: `https://www.googleapis.com/auth/gmail.readonly` (`gmail.metadata`
   cannot use `q`). Tokens are execution-local and never written to KV/logs.
4. List at `gmail.googleapis.com` with `q=-in:sent -in:drafts -in:chats`, including
   archived incoming mail. Exhaust all pages, then get only
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

## Egress and failures

`src/intake.ts` exports one authoritative `ALLOWED_HOSTS(routineOrigin)` constant
list factory: `gmail.googleapis.com`, `oauth2.googleapis.com`, and the configured
routine origin's hostname. Its result is frozen. Company config is not put in a
mutable module-global list. All requests pass `safeHttp`, which additionally
requires HTTPS/default port, exact methods/paths, no URL credentials, no
redirects, and no alternative routine URL. This is a **code-level check**, not a
network sandbox: Paperclip's `http.outbound` capability itself remains broad.

Transport, token, list/page, metadata, validation, or state failure throws only
`could not read mail`, with no cause/provider text logged. Any incomplete scan
leaves seen unchanged and fires nothing. Page bounds (100 pages of at most 500
IDs) and the 240-second tick signal are failed reads, not quiet successes.
The SDK HTTP bridge currently omits `signal`/`redirect`; the host itself returns
redirects and bounds each request to 30 seconds. The wrapper checks tick abort
before and after every awaited fetch (a host call already running must settle).
Delivery failure can retain earlier successful per-ID checkpoints. Seen IDs are
never evicted. There is no automatic catch-up timestamp or implicit query cut.

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
