# TEST-first installation (operator/image owner)

These are future authorized steps, not actions performed by the builder. No
Google, Paperclip or 1Password calls are part of this package's tests/build.
Do not paste secrets into chat, logs, config JSON, or command-line arguments.

## Build at the merged SHA

From the fork workspace (Node >=24.11, pnpm):

```sh
pnpm --filter @smarty/plugin-mail-intake... --filter paperclip install --ignore-scripts --frozen-lockfile
# Only if ERR_PNPM_OUTDATED_LOCKFILE: repository policy permits resolving in place.
# pnpm --filter @smarty/plugin-mail-intake... --filter paperclip install --ignore-scripts --no-frozen-lockfile
cd packages/plugins/plugin-mail-intake
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination /approved/artifacts
sha256sum /approved/artifacts/smarty-plugin-mail-intake-0.1.5.tgz
```

Only GitHub automation commits the root lockfile; do not commit install churn.
The worker bundles the SDK/runtime; the tgz has no production dependencies and
needs no registry download. Contents: `package.json`, built manifest/worker,
README and these instructions. No secret, state snapshot or dev dependency is
packed. Rebuild at the **merged** SHA; a pre-merge artifact is not that build.

Day one ships a local-path tgz. **No `distribution/catalog.json` change** is in
this slice (the capacity-lead note supersedes feasibility's catalog suggestion).
The current loader's `localPath` accepts a directory, not a `.tgz` file
(`server/src/services/plugin-loader.ts:1234–1247`). The image owner must unpack
this tgz into an approved server-visible plugin directory, then use the normal
local-path installer, for example on a non-managed authorized TEST instance:

```sh
mkdir -p /approved/plugins/mail-intake
# Verify the supplied SHA-256 before extracting.
tar -xzf /approved/artifacts/smarty-plugin-mail-intake-0.1.5.tgz \
  -C /approved/plugins/mail-intake --strip-components=1
paperclipai plugin install /approved/plugins/mail-intake --api-base https://TEST-ORIGIN
```

Do not pass a tgz directly as a directory or claim that it is catalog-installed.
Cloud-managed hosts reject arbitrary local/npm paths; the image owner must
confirm its approved day-one staging/admission route. A tgz alone does not
bypass that guard. Catalog/image integration is deferred, not silently added.

## Upgrading to 0.1.5 (from 0.1.4 or earlier)

Approve the added `companies.read` capability through the host's normal upgrade
flow if requested. Discovery uses only documented SDK calls; no core change or
database edit is required. Exactly one company may have a nonempty saved plugin
config. Existing saved config is recovered at startup and every tick, including
an install with zero plugin_state rows; do not re-save config just to wake it.
Missing configuration fails the job and health reports `mail intake is not
configured`; invalid or ambiguous config reports `config invalid` or `multiple companies configured`.

A restart does not authorize a new baseline. Keep existing seen state intact.
If state was never initialized, use the disabled, company-scoped action below;
otherwise, initialization still refuses to overwrite it. The host represents
its BOARD user as SDK actor type `"user"` with the authorized company ID (SDK
`src/protocol.ts:442–460`); no agent or run ID is required. The action refuses
foreign/global company scope before any mail or secret call.

## Company configuration and secret custody

In TEST Company Settings > Secrets, the authorized operator provisions two
TEST-owned secrets through an already-supported provider:

- Gmail structured JSON secret: original matching `client_id`, `client_secret`,
  `refresh_token` for smarty@ with `gmail.readonly`. This is a user OAuth grant,
  not a Google service account or 1Password reader credential.
- Existing TEST routine webhook's bearer secret, separate from the Gmail grant.

Save **company-scoped** plugin config via Settings > Configuration (secret-ref
pickers) or `POST /api/plugins/<installed-plugin-id>/config`:

```json
{
  "companyId": "<TEST-company-uuid>",
  "configJson": {
    "enabled": false,
    "mailbox": "smarty@smartypants.ai",
    "gmailGrantRef": {"type":"secret_ref","secretId":"<gmail-secret-uuid>","version":"latest"},
    "routineFireSecretRef": {"type":"secret_ref","secretId":"<routine-secret-uuid>","version":"latest"},
    "routineOrigin": "https://hq.smartypants.ai",
    "routinePublicId": "<existing-TEST-public-id>",
    "scanWindowDays": 7
  }
}
```

Config save binds the refs at their exact config paths. Never use `op://`, raw
values or global config. Keep only TEST configured for this proof. Explicit
company IDs scope config, secret resolution and all KV operations.
The compiled origin is HQ only; use a TEST company there, or obtain the exact
canonical distinct TEST-instance origin for a reviewed frozen-list rebuild.
An arbitrary origin, port (including explicit 443), IP or userinfo is rejected.
Config cannot widen the host list. No distinct TEST hostname was supplied to
this build. `scanWindowDays` is an integer from 1 to 30 (default 7); agree that
catch-up boundary before enabling. Older mail is deliberately outside intake.

## Explicit one-time seen initialization

Missing seen state deliberately fails. Agree the real mailbox cut line first.
Using the authenticated company-scoped actions bridge documented in
`doc/plugins/PLUGIN_AUTHORING_GUIDE.md:482` and
`server/src/routes/plugins.ts:1699–1775`, invoke
`POST /api/plugins/<installed-plugin-id>/actions/initialize-seen` once:

```json
{"companyId":"<TEST-company-uuid>","params":{"mailbox":"smarty@smartypants.ai","seenIds":[]}}
```

The host injects the authorized company into params and immutable actor context.
This action requires disabled config, matching company/mailbox, IDs-only input
and an absent state row. It cannot reset existing state or run during a tick.
Since 0.1.5 the action only validates and records the request (plugin state
`init:<sha256(mailbox)>`), then returns `{"accepted":true}` within a few host
calls: the host caps an action RPC at 30 s (`server/src/services/
plugin-worker-manager.ts:82`), and reading a real mailbox takes longer. The next
job tick (5-minute host budget, `plugin-job-scheduler.ts:50`) does the same
complete, bounded Gmail scan as a tick and gets internalDate metadata before
writing version-2 state. Health shows `initializing` until then, `ok` after; a
failed read shows `mailbox read failed` and the next tick retries; rejected IDs
show `seenIds not in window` and need a new request (a failed request may be
replaced; a pending one may not). Enabling before that tick does not complete it. Every supplied ID must be present within
that window; out-of-window/unknown IDs and incomplete reads fail without writing.
The scan's window start is persisted as the epoch-ms `notBefore` floor. Each
complete tick can advance, but never lower, that floor. Widening `scanWindowDays`
never back-fills old mail, including IDs already pruned from state.
An explicit empty array authorizes firing **all** incoming mail within the
configured window at first enable; to avoid replay, supply the explicitly approved
IDs from that same window. No automatic baseline or guessed received-time cutoff.
This package has not been installed yet; legacy ID-array state is rejected, not
silently migrated with fabricated dates. An operator with pre-release legacy
state must arrange an explicit approved reinitialization before enabling.

## Receiver and real proof, then enable

Preserve the existing routine and all legitimate principal access. Disable only
its periodic schedule trigger; keep its bearer webhook enabled. Set the routine's
`concurrencyPolicy` to `always_enqueue`. Confirm its variables consume exactly
`messageId`, `threadId`, `receivedTime` (ISO UTC). It owns actual routing/content
access. Do not re-enable the old periodic model scanner.

After setup, save the full config with `enabled:true`. Prove on real TEST work:
quiet tick (no task); seen replay (no task); one new mail (one queued task);
multi-page and interrupted read (safe failure/no seen advance); two arrivals
while receiver active (two admissions); restart/lost-KV retry (same receipt);
KV/log/payload privacy. Check job history and actual routing separately. Then
leave enabled only under the authorized deployment's liveness/sleep policy.
Delivery failures retry after 2 minutes, doubling to at most 6 hours; the tenth
failure parks the ID and emits the fixed-text job-health warning
`mail intake has parked deliveries: <id>, <id>` (only validated Gmail IDs vary).
The documented SDK `onHealth()` surface also reports `degraded` with
`details.parked: [{id, attempts, lastFailureAt}]`; the last failure time is epoch
ms, or `null` for legacy failures without a recorded time. These diagnostics
survive restart and contain no subjects, senders, bodies or provider errors.
Later messages continue. Parked entries remain until their internalDate ages
below the monotonic floor; inspect the receiving routine through its normal
authorized history, not through message content in plugin logs. Seen and failure
entries are pruned after complete scans only.
