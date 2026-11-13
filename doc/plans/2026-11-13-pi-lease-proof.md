# Goal 5 lease proof — prepared fixture

## Import onto I-2 prime (2026-11-13)

Imported only the handed-off lease fixture and this preparation document onto
`cl/pi-i2prime` (`8be516736e4daedf9c2d1fbd98c618a999863fac`). The final handed-off
fixture SHA-256 is `a8751b834716f58aab6d666958954d69a57613487f3a52d2ef817d264ee8aa7b`;
the older hash and source HEAD below describe preparation history, not this import.
No Goal-2 dirty overlay is included. Execution results belong in the task evidence,
not in this historical preparation report.

Existing documented feature used first: `doc/architecture/runner-pi-capabilities.md:619–620`
documents loading the private JSONL for normal continuation after a separately
admitted restart. This fixture calls the existing backend `recoverSession`, DB
lease admission and native Pi driver; it adds no extension seam or core behavior.
Verification follows `.agents/skills/verify-paperclip/SKILL.md`: qualify the actual
target and preserve failures; this is not UI/full-server or daily-work acceptance.

## Between-turn fixture API compatibility (RESUME 2)

The fixture is now based on I-2 double-prime (`ab0b0b032923deb0379e5cc417c836bf713d4c4d`).
The import hash above identifies the untouched handoff; subsequent fixture-only
repairs deliberately change that hash:

- Route the loopback Messages endpoint by URL pathname. Native Pi's Messages SDK
  sends `/v1/messages?beta=true`; retain the full URL in the evidence rather than
  returning a fixture-generated 404 for the supported query.
- Invoke real cancellation to revoke publication, then always close the session.
  Between turns, the public interrupt contract can return its typed
  `already_terminal` outcome. Accept only that code after a real snapshot shows
  no active turn or pending runtime requests. This is not physical retirement
  proof: the unchanged exact runner/Pi process-birth checks must still pass before
  lease revocation and the provider's termination receipt.
- Apply that same cancellation/close helper to the successor and failure cleanup.
  Other cancellation errors remain failures; no durable state is rewritten.

For the I-7 backend-only fixture, also adopt the selected source's durable
Runner ID and save it on the successor run before constructing the backend.
`executeNativeSession` normally performs that step after loading the retained
binding. Passing the newly prepared ID directly to `createRunnerdBackend` skips
that outer production step and fails the remote `runner_identity` check. This
fixture correction changes no product identity guard or remote state.

The I-7 archive assertion likewise follows the existing remote recovery seam:
`rotateAuthorityEpoch` preserves controller and Runner authority under matching
`authority-epochs`, not the executor's distinct `continuity-breaks` lane. Compare
the full authoritative DB checkpoint (not the intentionally small external
controller projection) and remote Runner state against their actual archives.
Require exactly one real `thread/resume` frame, with a matching successful native
identity readback, before accepting history continuity.

Build a fresh real-file provider pack from the candidate, and select a runnerd
whose compiled native Pi profile matches the generated manifest. Runtime results,
including any successor admission failure, belong in retained task evidence, not
in this preparation report. This fixture still does not exercise the full-server
missing-history fresh-conversation notice or the F7 UI.

## Original preparation report (historical, not execution evidence)

## Delivery / ownership

Prepared `server/src/__tests__/native-pi-rpc-bplus1-lease.e2e.test.ts` (434 lines). SHA-256: `525a26c8be8b8458549bd06c09475540a0417fb779f0c23913f4e36b625e17cb`.
Actual HEAD observed at handoff: `a9e36a18ea4ad738d6febea257f13a613ca9693a` (initial base was `babe7a9fcdca34cdbbf5574e24351dfc560b1702`; parent moved the shared HEAD). Only this new test and this report were written. No production source, existing test, Goal 1 writer's files, Git state, external service, or agent was changed. No tests, collection, typecheck, builds or network were run; TS/runtime validity is pending parent execution. No task-owned runtime was launched.

Read the rendered role at `.local/bplus1-parent/task-role.json`, factory/repo instructions, required NOTE and prep report, complete existing full-server harness, real runner integration and actual DB safe-successor matrix/source. The Goal 1 baseline RED and private author are not modified or folded into this harness.

## Exact scope: what this can qualify

This is the permitted **real DB + simulated sandbox command runner** harness, not a full Express/API journey. The remote fixture executes actual subprocesses through the public `AdapterExecutionTarget` / `CommandManagedRuntimeRunner` contract. Controller roots and simulated sandbox/workspace roots are separate. It uses real remote runnerd, TLS sandbox ingress proxy, provider pack/proxy, Pi, its JSONL and scripted local Messages.

It exercises the base's **same reusable simulated allocation, retired execution/environment lease → new DB execution/environment lease** path. A provider allocation identifier stays the same (the sandbox acquisition outcome is `resumed`), while execution/ingress authority is scoped to a different environment lease row. This is not the one-hour PRP connection lease. It is also **not** proof of destroying/recreating a Boat VM, a new Boat provider allocation identifier, or restoring a transcript into a different remote filesystem. The retired command runner rejects all subsequent commands; its old ingress endpoint rejects access after revocation. Do not broaden this scope in the final acceptance claim.

## Acceptance assertions in the prepared test

1. Actual isolated Postgres records, completion contract via `prepareNativeHeartbeatRun`, native execution input and real `createRunnerdBackend` open the first Pi conversation. The private nonce appears in the scripted assistant response/real Pi JSONL, never the first input prompt.
2. Capture runner/Pi PID, PPID, boot ID and Linux process birth ticks. Await real session cancellation cleanup and close, then independently verify both recorded births no longer exist. Only **after** this observation does the simulated provider revoke the old lease's command/ingress authority and create the identity-bound `remoteTerminationReceipt`. The real environment service persists it. No pre-seeded receipt or transport-close-only retirement.
3. Store the measured snapshot with metadata constructed by existing exported `createNativeControllerRecovery` and the actual `nativeControllerMigrationDescriptor` digest. The finalization record represents acknowledged cancelled terminal failure; the actual durable command checkpoint must have no pending work. These are explicit fixture/control-plane records, not a claim that the HTTP Stop API was driven.
4. The real environment service acquires a new execution lease using `replacesReusableLeaseId`. The real resume selector must choose the stopped predecessor. `buildNativeExecutionWithCheckpoint` must preserve normalized conversation/provider session identity.
5. The actual returned production backend's `recoverSession` must succeed. The next real Pi subprocess must have a different runner and Pi PID, append to the exact same JSONL without changing its existing bytes, and recall the private nonce from assistant history while its latest prompt lacks the nonce. No mocked recoverSession, spy or SDK-private entry point.
6. Existing Rust raw provider trace must contain the actual `thread/resume` request and matching successful proxy response with the predecessor provider session ID. The real proxy responds only after its Pi driver recovery. A successful cold open/new conversation without this trace cannot pass.
7. The source controller and remote Runner authority must remain preserved under the ordinary matching `authority-epochs` rotation (not the executor's separate `continuity-breaks` lane). The controller archive is compared byte-for-byte with the authoritative DB checkpoint materialized through `restoreSessionDirectory`; the remote Runner archive is compared with its pre-successor bytes. The JSONL must contain exactly one session header, and all owned runner/Pi births must be absent after cleanup. Postgres is stopped through its exact discovered port/data directory without deleting its evidence.

All fixture subprocesses/listeners happen only when the parent explicitly enables/runs this test. It requires no real model account or external Boat service. Existing authority/lineage/file/uncertainty gates are used unchanged.

## Parent execution

Run serially, not alongside other sandbox-ingress tests: production runner ingress uses its fixed listener port. Use the parent's owned, syntax-checked execution script and canonical long-command/exit receipts. Read `.local/bplus1-parent/scratch-root` first; do not reuse historical cleaned paths.

From `/srv/scratch/paul/pi-resident-wt/bplus1/server`:

```sh
pnpm exec vitest run --config vitest.config.ts src/__tests__/native-pi-rpc-bplus1-lease.e2e.test.ts
```

Environment (set in the parent script; **not executed here**):

```sh
TMPDIR=<parent-owned dedicated scratch root>
PATH=/opt/node-v24.19.0-linux-x64/bin:$TMPDIR/bin:/srv/scratch/paul/pi-resident-wt/.rust/cargo/bin:$PATH
PAPERCLIP_PI_LEASE_E2E=1
PAPERCLIP_RUNNER_BINARY=<absolute qualified runnerd binary>
PAPERCLIP_RUNNERD_PATH=$PAPERCLIP_RUNNER_BINARY
PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH=<absolute qualified provider-pack directory>
PAPERCLIP_PI_E2E_EVIDENCE=<existing parent-owned evidence directory>
```

The scratch `bin/pi` must resolve the qualified Pi 1.5.2 binary. Do not put unqualified home credentials or real provider routes into this run. Unset `DATABASE_URL`, `PAPERCLIP_TEST_DATABASE_URL`, GitHub tokens and model API keys as in parent setup. The test sets a private Paperclip home/state root, `PI_OFFLINE=1`, actual `paperclip/faux` model metadata with xhigh capability, and local Messages routing. Use candidate runner and candidate provider pack for GREEN; baseline/candidate identity and exact command exit remain the parent's responsibility.

On execution it prints `Pi sandbox lease evidence retained: <root>` and preserves `stages.json`, `commands.json`, `requests.json`, `prp-events.json`, `processes.json`, DB runs/leases/events/owners, old transcript bytes, raw per-run provider trace, retirement receipt, `proof.json` on success, and `failure.txt` on body failure. A run that fails before `proof.json` is not a pass. The test never invokes the helper's deletion cleanup.

## Pending evidence / shortest next step

**No Goal 5 GREEN is claimed.** Parent must first collect/execute this one explicit test and retain the real return status. In particular, actual remote provisioning, managed-harness backup/checkpoint shape, Pi subprocess discovery, raw trace envelope and test-only TS validity have not been runtime-validated. If the real server migration gate still refuses, preserve the exact refusal/DB evidence rather than weakening guards. The source uses no Goal 1 private fix and may reveal the same owner-state issue under this scenario; that is evidence, not a license to bypass it.

If acceptance specifically requires **another provider allocation / another sandbox filesystem**, this harness intentionally does not meet that stronger clause. Shortest extension is a second lease-bound runner rooted in a fresh simulated remote workspace, provider acquisition `replacement`, with restoration through the existing verified failover backup path; do not call `replacesReusableLeaseId` with a different provider allocation, because `environmentService.acquireLease` deliberately requires the predecessor's providerLeaseId for that same-allocation handoff. First qualify the delivered resumed-allocation lease case before adding that distinct scenario.

QUIESCENT — ownership returned; scope: `server/src/__tests__/native-pi-rpc-bplus1-lease.e2e.test.ts` and `.local/bplus1-parent/lease-proof-prep.md`; head: `a9e36a18ea4ad738d6febea257f13a613ca9693a`; queued source requests: superseded; result: `.local/bplus1-parent/lease-proof-prep.md`. No owned runtime/background job was started. Parent must confirm terminal native task state after consuming this result.
