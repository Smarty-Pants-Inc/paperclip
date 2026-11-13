# TEST-first installation (operator/image owner)

These are future authorized steps, not actions performed by the builder. No
Google, Paperclip or 1Password calls are part of this package's tests/build.
Do not paste secrets into chat, logs, config JSON, or command-line arguments.

## Build at the merged SHA

From the fork workspace (Node >=24.11, pnpm):

```sh
pnpm --filter @smarty/plugin-mail-intake... --filter paperclip install --ignore-scripts --no-frozen-lockfile
cd packages/plugins/plugin-mail-intake
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination /approved/artifacts
sha256sum /approved/artifacts/smarty-plugin-mail-intake-0.1.0.tgz
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
tar -xzf /approved/artifacts/smarty-plugin-mail-intake-0.1.0.tgz \
  -C /approved/plugins/mail-intake --strip-components=1
paperclipai plugin install /approved/plugins/mail-intake --api-base https://TEST-ORIGIN
```

Do not pass a tgz directly as a directory or claim that it is catalog-installed.
Cloud-managed hosts reject arbitrary local/npm paths; the image owner must
confirm its approved day-one staging/admission route. A tgz alone does not
bypass that guard. Catalog/image integration is deferred, not silently added.

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
    "routineOrigin": "https://CANONICAL-PUBLIC-TEST-ORIGIN",
    "routinePublicId": "<existing-TEST-public-id>"
  }
}
```

Config save binds the refs at their exact config paths. Never use `op://`, raw
values or global config. Keep only TEST configured for this proof. Explicit
company IDs scope config, secret resolution and all KV operations.

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
An explicit empty array authorizes firing **all** currently eligible incoming
history at first enable; to avoid replay, supply the explicitly approved existing
IDs instead. No automatic baseline, eviction or guessed received-time cutoff.

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
