# Boat sandbox provider 0.1.16-retry429

## Provider liveness inspection

Each ordinary `environmentInspectLease` call makes a fresh, uncached
`GET /sandboxes/{id}` with a 10-second timeout. Transport and HTTP failures throw;
only a confirmed sandbox-not-found or Boat's terminal `cancelled` state reports
`destroyed`. A missing sandbox requires a JSON 404 envelope with
`code: "not_found"` and no `error.details.path`, an ID matching Boat's
`^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$` pattern, and a fresh, uncached
`GET /orgs` with the same key returning `ok: true` and exactly **one entry total**,
which must be an organization whose `id` equals the lease's recorded
`metadata.boatOrgId` (also bounded to 10 seconds). In addition, the sandbox read
explicitly sends `X-Boat-Org: <recorded boatOrgId>`: this is the documented
[account-key request scope](https://docs.boat.dev/api-keys.md), not an inference
about key type. An organization key naming another org is refused by Boat.
The inventory guard counts Personal, inactive, and duplicate rows too; it does
not filter by `active`. Boat defines `active` as the default billing wallet for
new sandboxes, not key scope ([list organizations](https://docs.boat.dev/api/reference/account/list-organizations.md),
[active wallet](https://docs.boat.dev/organizations/active-wallet.md)). Thus even
a scoped request with a multi-entry inventory is conservatively refused.
A bare, malformed, route-style, or otherwise ambiguous 404, an invalid ID,
missing recorded org, personal ownership, failed org lookup, or a different or
ambiguous inventory throws instead: absence is **not proven**. Boat's
[API error contract](https://docs.boat.dev/api/v1.md#error-model) says `not_found`
can also mean a missing key or saved snapshot, so a 404 alone is not sufficient.

Acquire and successful resume record `boatOrgId` only from the latest exact-ID
sandbox observation's `team.id`. Explicit `team: null` means personal billing
and records `boatOwner: {kind: "personal"}` with no `boatOrgId`; omitted or
invalid `team` means unknown and records neither. There is **no `/orgs` fallback**
for ownership. Readiness and setup observations must match the expected sandbox
ID, as must resume reads, POST responses and TTL refreshes. On resume, both old
ownership fields are removed before the new observation's ownership is recorded;
unrelated metadata is retained. An earlier create/read/POST response never
supplies ownership missing or contradicted in the final observation. See Boat's
[`Sandbox.team` contract](https://docs.boat.dev/api/reference/sandboxes/get-sandbox.md).
Personal and unknown leases (including unbound older leases) cannot prove 404
retirement. Positive inspection does not migrate or persist ownership for an
older lease; rollout/backfill remains a separate operational requirement.
`archived` reports `stopped` only when `stoppedAt` is non-null. `ready`, `idle`,
and `running` report `active`; all other states report `unknown`, including
`archived` without a stop timestamp. See Boat's [GET contract](https://docs.boat.dev/api/reference/sandboxes/get-sandbox.md).

Observations preserve `stoppedAt` and `lastReboot.at` as `lastRebootAt` verbatim,
using null when absent. `observedAt` is the HTTP response's strict RFC 7231
`Date` converted to ISO, or null when missing or invalid; it is never replaced
with the plugin's local clock. IMF-fixdate and the obsolete RFC 850/asctime
recipient forms are accepted only with exact grammar, matching weekday, valid
calendar/time components, and a post-epoch timestamp no more than 24 hours ahead
of the local clock. Numeric/ISO dates, invalid calendar dates, non-GMT zones,
and out-of-range clocks return null; `Date.parse` leniency is not used.
Missing resources also retain the response observation time when available.
The existing idle-drain accounting and creation-operation inspection are unchanged.
These fields describe provider observations, not authenticated Runner readiness
or process continuity. This release adds the three optional observation fields
to its vendored SDK; the corresponding Core consumer is a separate change.

Request failures retain only method, path, HTTP status (`httpStatus`, null when
no response arrived), and a fixed category (`request_error`, `network_error`,
`http_error`, `parse_error`, or `ambiguous_404`). Provider error fields,
`statusText`, network diagnostics, JSON previews and original causes are not
retained. The configured key is centrally redacted from the resulting message
and stack, including accidental collisions with an otherwise-safe path.

## Route A — default off

This build preserves the live env-file, snapshotIdentity and unconditional
stop-and-retain line and the existing S9 guardian/duplex contract. Its vendored
Paperclip SDK and shared package originate from Core `cl/img1b`
`ae66270620cb7eeaae2a13fc0aef22e3656d44ad`. This release adds only the three
optional liveness observation fields to the SDK protocol; shared is unchanged.
The inherited S9 Core-boundary tests use host sources at
`51d9a5afbd2a99b974ae060a372082352174df71`; the image 1b archive does not contain
that S9 host module. This build does not qualify carrier-on operation on image 1b.

**Install precondition:** the manifest advertises `duplexCommandStream: true`.
Before installing, read back and record `enableSandboxDuplexBridge=false` and
the Core version on the target instance. This is an install step, not proof
provided by this build. Static duplex support also exposes that
separate generic bridge when its experimental setting is true. A non-SSH lease
gets a typed refusal and the real bridge falls back once to its file path.
Default/false does not attempt duplex. See [SSH.md](SSH.md) for the proof boundary.

`duplexCarrier` defaults to `off`. Only `"ssh"` with successful current lease
preflight receives `runnerGuardianVersion:1`. Core also requires `reuseLease:true`,
exact active reusable lease binding and live Runner qualification before S9
release/resume. SSH staging installs root-owned code and the fixed client entry,
then verifies the resident `systemd --user` service with `Restart=no`. Resume
reports changed boot/empty status as cold-start evidence, never continuity.

off takes effect at the next run start; a run that started with ssh ON finishes its own observe/park.
Opens are possible until the next acquire or resume (an off save does not stop them immediately); the next acquire or resume retires with 0 opens.
The next scoped off acquire/resume removes the key, guardian marker and preflight
receipt. This is the Core-limited boundary, not immediate revocation on an off save.

Directory sync renames before applying the target directory mode. Replacement
restores owner write on an existing target before removing it. The EXIT trap also
restores owner write on extracted staging data before cleanup, including failure
paths with read-only nested directories.

Resume verifies the recorded workspace sentinel at the allocation's original
cwd, even when Core rewrites `remoteCwd` to a prepared shared workspace below it.
The allocation receipt must name the same sandbox and original cwd; foreign or
non-normalized sentinel paths are refused. The scoped sentinel token is unchanged.

The [carrier guide](SSH.md) and [guest protocol](guest/README.md) describe exact
argv, private framing, root-owned installation, release/resume order and limits.
This candidate's loopback SSH, real guardian, fake Runner and actual Core bridge
tests do not qualify live Boat, Pi, checkpoint recovery or daily-work continuity.
Independent audit, service-UID isolation and the lead's live gates remain required.

## Existing retained-provider behavior

## Per-execution environment privacy

Exec env values are uploaded as shell-quoted `export` lines using the files API, never interpolated into Boat command text. Each call precreates a 0700 random directory and 0600 file outside both cwd and the recorded workspace root. The wrapper enforces 0600 again, sources the file, and removes the file and directory before exec; API DELETE in finally is best-effort backup on every failure path. Empty env leaves the command unchanged. Large UTF-8 env uses the same signed-upload threshold as stdin (4 MiB). Keys must match `[A-Za-z_][A-Za-z0-9_]*`.

There is no file-mode field in Boat's [write API](https://docs.boat.dev/api/reference/agent/write-sandbox-file.md): permissions use `umask 077` and shell chmod, not an invented API. Values exist briefly on sandbox disk; a snapshot in that window can capture them. They remain in the process environment. Whether file PUT bodies are retained in provider audit/internal logs is **unknown (docs silent)**. [Command history](https://docs.boat.dev/long-running-tasks/command-history.md) retains command text for 90 days and excludes regular-file writes from process-output capture; that is not a guarantee about HTTP-body retention. Cleanup cannot be guaranteed after a provider outage or plugin crash. This does not redact caller-supplied command arguments, stdin, or process output. No live qualification is claimed by these local tests.

Install `paperclipai-plugin-boat-0.1.16-retry429.tgz` as an instance plugin. Destroy, release, failed-acquisition cleanup, and orphan cleanup always use the same non-force, completion-confirmed stop. The plugin never sends `DELETE /sandboxes/{id}`. The `retainOnDestroy` boolean remains accepted for compatibility, defaults to true, and is ignored: false, absent, and true all stop and keep the sandbox. Configure `"reuseLease": true` to resume the same retained Boat sandbox ID across runs; reuse defaults to false. A successful destroy returns `{ providerLeaseId, state: "stopped" }`, not a false `destroyed` receipt. Stop failures remain failures, without force or a destructive fallback. This is sandbox-lifecycle retention, not a general file-immutability policy: command cancellation and temporary stdin-file housekeeping do not delete the sandbox and are unchanged.

Reuse is scoped by the same agent and the same execution workspace. For projectless environments, the issue ID is used instead. Reuse across issues therefore requires a project with a shared execution workspace. This follows Paperclip's `buildReusableSandboxLeaseScope` behavior (`server/src/services/environment-runtime.ts:1016-1043`). Retention without reuse preserves the disk but does not make a subsequent run reuse that allocation. Existing lease configurations are also protected once this plugin version is installed, even if their recorded `retainOnDestroy` is false or absent.

Retained, stopped sandboxes cost **no compute**; their remaining footprint is Boat's stopped-sandbox storage, whose automatic snapshots are currently **included at no cost** for at least 14 days ([pricing](https://docs.boat.dev/pricing.md#included-at-no-cost), [limits](https://docs.boat.dev/limits.md)); separate paid saved snapshots above plan limits and the AI proxy can still charge. An owner must independently back up the actual Pi raw session and managed home, verify the backup by reading it back, and only then delete the exact retained sandbox; do not treat ordinary workspace copy-back or the 14-day retention window as a verified backup, and finish or save a longer-lived snapshot before day 14. The documented [update route](https://docs.boat.dev/api/reference/sandboxes/update-sandbox.md) accepts only name, TTL, and subdomain, not labels, so this version deliberately skips `paperclip-retained=destroyed` rather than inventing a label update. List candidates using the existing ownership labels via [GET /sandboxes](https://docs.boat.dev/api/reference/sandboxes/list-sandboxes.md), for example `/api/v1/sandboxes?label=owner%3Dpaperclip%3A<company-id>&label=environment%3D<environment-id>&state=archived&limit=200`; follow every `pageInfo.nextCursor` while `hasMore` is true, and reconcile exact IDs with Paperclip's stopped termination receipts before owner-controlled deletion. These labels identify owned candidates, not proof they were destroyed or backed up.

## Failed acquisition recovery

Every acquire sends a unique `paperclip-acquire` label and the same idempotency key. Core's durable `creationOperationId` supplies the label when available; direct SDK calls use a UUID. If create throws, times out (30 seconds), or omits its ID, the plugin queries Boat's documented `GET /sandboxes?label=paperclip-acquire%3D<attempt-id>`, follows `pageInfo.nextCursor`, verifies company/environment/run ownership, and cleans every matching exact ID. Cleanup only performs non-force, completion-confirmed stops, regardless of the recorded configuration. Acquisition cleanup makes at most three attempts per ID, with 250 ms and 500 ms backoff. Exhaustion throws the SDK's `PluginEnvironmentCreationCleanupError`, containing the exact ID, attempt identity, non-secret labels, and credential fingerprint.

The plugin also declares `creationOperationVersion: 1` and implements `environmentInspectLease`. This is necessary: canary.4's generic sandbox acquire path does **not** persist an orphan merely because an exception has a `providerLeaseId`. Its durable creation intent later invokes inspection; the plugin rediscovers the attempt and returns the SDK's `creationCleanup` envelope. Core validates that envelope, inserts an exact-ID `pending_cleanup` lease with the recorded configuration, and retries destroy. Retention still applies on that retry. A list outage or not-yet-visible identity throws from inspection so the intent remains scheduled, rather than becoming `needs_reconciliation` without a cleanup attempt. A currently empty list is not treated as proof that a timed-out create cannot materialize later.

Recovery follows core's durable schedule (normally a creation settle floor of 30 minutes, then cleanup backoff); this is **not immediate cleanup or a zero-charge guarantee**. If the provider remains unavailable, compute can continue until a confirmed stop or the requested provider TTL. A direct SDK caller without core's durable intent must retain the typed error/attempt identity and own retry itself. Empty lookups remain pending rather than falsely reporting a destroyed resource. Core's recovered creation-cleanup lease is runless: it settles `expired/success` after the stopped RPC receipt, but does not create a run-continuation termination receipt. No core patch is required.

## Paperclip Runner sandbox transport

This candidate implements Paperclip's existing sandbox-provider Runner route, not `onEnvironmentTask` and not a legacy callback bridge. It was built against fork commit `68149e4901ab108c8bd148d211b543c50d45989d` and follows the bundled Daytona provider's ingress, sentinel and lifecycle contracts.

Configure `reuseLease: true`, `runnerLifecycleMode: "warm"`, and `runnerIdleTimeoutMs` (default 300000; 1000–86400000). The host remains responsible for PRP authentication, checkpointing, suspension and the idle timer. Boat returns a private WSS route for runnerd's `0.0.0.0:43127` listener. Its documented `_token` becomes the secret `Cookie: _port_auth=...` header; the endpoint URL contains no token or query, and the port is never made public. The SDK advertises the implemented hook and core negotiates `runnerWebSocketIngress` normally.

Every scoped acquisition writes `.paperclip-runtime/reusable-sandbox-lease.json` and reports its allocation-file digest. Resume verifies that proof before reuse; a live warm sandbox is not restarted. Missing/foreign Runner proof expires the lease without deleting it; provider outages remain retryable errors. Stop fences new commands, sync and ingress; explicit resume reopens admission only after identity verification. SDK idle drain remains present until active requests and observed running allocations have provider-confirmed termination. No idle polling or token-refresh timer is installed.

The provider TTL outlives the host's warm/reconnect windows by five minutes and is renewed on an authorized warm handoff when a host floor applies. Boat's `archiveAfter` is a **sliding auto-stop**, not a hard expiry. Acquisitions with `requestedExpiresAt` are refused before allocation; no hard lifetime is invented. Boat stop snapshots the disk. **Lead measurement 11-12:** stop reached `archived` in about 11 seconds; resume within ten minutes returned the same machine with memory and processes intact even with `{ttlSeconds, noEnv:true}`. After ten minutes resume creates a new machine from the snapshot. The docs also allow early machine reclamation, so process continuity is never guaranteed and stopped-disk retention is not indefinite (`boatdocs-0110/snapshots_stop.md:76-89`).

### Immutable snapshot identity

Use `config.snapshot` for a saved-snapshot **name or UUID**. A UUID is resolved by `GET /saved-snapshots`, matching exactly one `snapshotId`; zero or multiple matches fail closed, without substituting another name or allocating. The plugin then reads `GET /saved-snapshots/{name}` immediately before create, requires a ready snapshot with the same pinned UUID, and creates with `{from: name}`. A name takes the direct GET path. Boat does not accept a snapshot UUID in create's `from` field. The documented list response is `snapshots: SavedSnapshot[]`; no `limit` or pagination query is sent ([list API](https://docs.boat.dev/api/reference/snapshots/list-saved-snapshots.md)). Malformed lists, failed lookups, non-ready snapshots, invalid identities, and moved pins fail before create or cleanup mutations.

Only an acquire with `resolveSnapshotIdentity: true` returns `lease.metadata.snapshotIdentity = {provider, requestedRef, id, name, organizationId, createdAt}`. `provider` is exactly `config.provider` (the full plugin provider key), `requestedRef` is exactly `config.snapshot` and equals the resolved `id` or `name`, `id` is the saved snapshot UUID, and `createdAt` is its saved timestamp. `organizationId` comes from the created sandbox's `team.id` in GET/create, never from the Paperclip company or snapshot source sandbox. A missing team identity fails qualification and invokes normal owned-allocation cleanup. Both acquire and resume preserve the configured provider in lease metadata; direct legacy SDK callers without a provider retain the `boat` fallback. Lease metadata also preserves `snapshot` for core binding verification. Ordinary acquisition resolves the same safe create target but omits `snapshotIdentity`.

The manifest now binds saved templates to `snapshot` and clears conflicting `from`/`pinnedSnapshotId` fields. Supplying `snapshot` together with either legacy selector is rejected. Existing configs without `snapshot` keep their behavior, including `from` share codes and the legacy `pinnedSnapshotId` guard. The exported legacy `resolveBoatSnapshotIdentity(config)` still resolves `from` and returns its original five-field result; it is not a lease qualification result. `snapshot` participates in the workspace fingerprint, without changing tokens for snapshot-free configs. The env-file execution implementation is unchanged.

This is a preflight guard, not an atomic Boat compare-and-create: **delete + re-save of the same name between the re-read and create cannot be detected after create**, because Boat does not return the source snapshot ID. Keep qualified names immutable operationally; the core qualification owner must not describe this as atomic artifact selection.

### Qualification boundaries at the pinned core

- The existing ingress seam needs no core change: private Cookie authentication fits `secretHeaders`.
- Normal native platform qualification accepts immutable OCI images or verified **Daytona** snapshot identities (`server/src/services/environment-probe.ts`, `sandbox-snapshot-qualification.ts`). This plugin supplies the `snapshot` lease-identity contract for the lead's provider-neutral qualification extension; the pinned core still needs that extension. Do not fake an OCI image or bypass admission.
- Core's managed warm-session policy currently permits Codex and selected Copilot credentials, not ACPX/Pi (`native-warm-capability.ts`, `heartbeat/native-lifecycle.ts`). Exposing the same config as Daytona does not override that gate. Managed Pi warm support requires a core credential/session-home handoff change and qualification, owned by the lead.
- This build ran only local provider fixtures and the real packaged SDK boundary. Real Boat WSS/PRP execution, daily work, and cold <8 s / wake <3 s remain unmeasured. No live readiness or performance claim is made.

## Rollback

In Paperclip administration, open **Plugins**, disable the Boat sandbox provider first, then uninstall/remove it. Follow the instance plugin administration instructions: https://docs.paperclip.ing/administration/plugins/ . Disable before uninstalling to stop further driver selection while preserving a deliberate rollback sequence. Do not downgrade or turn retention off for protected leases before their raw-session backups have passed read-back.
