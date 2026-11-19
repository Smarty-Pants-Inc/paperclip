# Private captures load by path

Captured data, even redacted, must never be committed to this public fork.
Captures load by path from R1 or an approved private store; no capture data lives here.

Run `captured-fixture-postgres.test.ts` with either:

- `PAPERCLIP_CAPTURE_DIRS=/private/take-a,/private/take-b` (comma-separated capture directories), or
- `PAPERCLIP_CAPTURE_ROOT=/private/captures` (every immediate subdirectory containing `MANIFEST.json`).

`PAPERCLIP_CAPTURE_DIRS` takes precedence when both variables are set. Invalid,
empty, or unreadable configured paths fail rather than silently skip. With neither
variable set, captured cases skip with a message naming both variables. The default
run loads only the hand-written seven-row fixture at `../synthetic/capture-loader/`
through the real migrated embedded-PostgreSQL harness.

Each private capture also replays the server's real `evaluateNativeControllerTakeover`
/ `proveOwnerGone` host check using controller identities loaded from
`native_run_finalizations.controller_host_hash` and `controller_boot_id`.
The scoped test helper `withCapturedControllerIdentity` defaults to the recorded
PID-space hash through the existing `currentProcessSpaceHash` spy seam. It restores
the seam on success or failure. It leaves the current replay controller's fresh
boot alone: using the recorded owner boot as the current boot would incorrectly
report `current_process`. Captured rows, PID observations and safety checks are
not replaced. Cleared terminal leases still undergo proof via
`requireStoppedController` and `requireRecordedProcessSpace`.

The same owner is checked three ways: identity feed disabled must refuse
`controller_host_unprovable`; recorded identity must reach the next real PID-identity
decision; a different identity must still refuse `controller_host_unprovable`.
That next decision may still refuse takeover (for example, a replay-host PID started
before the captured controller). The identity feed does not bypass this check.
`HOSTID PASS` lines contain only capture names, counts and decision codes, never
captured identity values. This proves the recovery host/PID boundary, not a full
Runner replay or a product fix. After installing workspace dependencies and
running `node scripts/ensure-plugin-build-deps.mjs`, run only these rows:

```sh
cd server
PAPERCLIP_CAPTURE_ROOT=/private/captures pnpm exec vitest run --config vitest.config.ts \
  src/__tests__/captured-fixture-postgres.test.ts -t 'replays controller host proof' --silent=false
```

`CAPTURE_DEMO_RED=1` retains the opt-in failing invariant for gate2 captures; it
is failure-state evidence, not a product fix. Only use trusted private manifests:
the round-trip helper executes their SQL in the disposable harness.

Private store: `Smarty-Pants-Inc/smarty-agent-files`, under `captures/<name>/`,
with a `MANIFEST.sha256` per capture (factory-lead follow-up; replaces
"private store: TBD by factory-lead (org 09:46Z)"). Only the seven explicitly
approved GATE captures are stored there; never publish fresh captures there.
This forward-only removal does not remove data from earlier commits; no history
rewrite is performed.
