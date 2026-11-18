# Upstream-port test supersedes — RFL C1

Authorization record for the port candidate
[`6eed7c6e90628b29ab04681254a2105cae66aae0`](https://github.com/Smarty-Pants-Inc/paperclip/commit/6eed7c6e90628b29ab04681254a2105cae66aae0)
(`fl/port-final-head-next`), as requested by RFL at 10:46Z on 2026-11-16.
This records existing authorizations; it does not authorize a new test change.
No code or tests are changed by the documentation commit containing this record.

The 15 numbered sections below are **15 unique upstream-owned files**, in the
order of the supplied independent `JUDGE-INVENTORY.md`. Each section includes
all upstream commits named for that file by the judge. Test titles identify the
changed tests or, for shared imports/fixtures and additive edits, the tests
supported by the replacement. An import edit is not described as a deleted
assertion. The separately authorized fork-test replacement follows the inventory.
The corresponding fork-behavior dispositions are in [LEDGER.md](LEDGER.md).

## Upstream-owned files (judge inventory)

### 1. `packages/paperclip-runner/src/live/runnerd-codex-transport-orphaned-tool-at-attach.test.ts`

Upstream: [46e5e4450ffada4826775a8336ef6f33ae8ef345](https://github.com/paperclipai/paperclip/commit/46e5e4450ffada4826775a8336ef6f33ae8ef345), [#21786](https://github.com/paperclipai/paperclip/pull/21786).

- Test: `settles an earlier generation's in-flight tool call at attach even when that attach never finishes startup`
- Test: `settles an earlier generation's in-flight tool call at attach even when that attach never finishes startup (%s at detach)`
- Test: `still settles a call stopped before dispatch as not dispatched when the controller closes without a restart`

The former single case becomes dispatched/pre-dispatch cases. Upstream replaces
the `semantic_tool.input` polling assertion with an explicit `callReached` and
dispatch gate, retaining settlement checks and adding the non-restart control.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 2. `scripts/__tests__/run-vitest-stable-shard.test.mjs`

Upstream: [03309f1650d3b0033e87e65f8240e7135124c5c0](https://github.com/paperclipai/paperclip/commit/03309f1650d3b0033e87e65f8240e7135124c5c0), [#21835](https://github.com/paperclipai/paperclip/pull/21835).

- Test: `12 PR without-chat shards plus the dedicated chat and native-runner lanes cover the original server group exactly`

The exact shard-coverage assertion includes the dedicated warm-successor Runner
release suite, and asserts its exclusion from the ordinary shard list.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 3. `server/src/__tests__/agent-instruction-copy-retry-backoff.test.ts`

Upstream: [30fc64e212a970d8a6a111d118ded5f13575d41f](https://github.com/paperclipai/paperclip/commit/30fc64e212a970d8a6a111d118ded5f13575d41f), [#21596](https://github.com/paperclipai/paperclip/pull/21596).

- Test: `collects a copy on the next pass once its local stop is recorded, long after its run finished`
- Test: `collects a remote copy on the next pass once its lease records the termination receipt`
- Test: `sends a run-scoped hint only when a waiting copy is brought forward, and writes nothing otherwise`
- Test: `collects a copy whose stop is recorded between the worker's evidence read and its backoff write`

The removed line is an expanded shared DB import, not a removed test assertion.
Upstream adds environment-lease/work-signal imports and stop-proof-driven cleanup
cases. Existing capped-backoff/backlog coverage is not waived by this record.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 4. `server/src/__tests__/heartbeat-native-predispatch-retry.test.ts`

Upstream:
[890dcbdd66f177dcdd6fc724f7a87b590060589b](https://github.com/paperclipai/paperclip/commit/890dcbdd66f177dcdd6fc724f7a87b590060589b), [#21627](https://github.com/paperclipai/paperclip/pull/21627);
[e82c4f0a318d979632550bb304547d134ff82d6d](https://github.com/paperclipai/paperclip/commit/e82c4f0a318d979632550bb304547d134ff82d6d), [#21472](https://github.com/paperclipai/paperclip/pull/21472).

- Test: `stops retrying with a truthful failure when the next attempt met the same unretired sandbox instead of a fresh one`
- Test: `continues a follow-up on a blocked task whose predecessor could not be retired`
- Test: `does not continue a task that was blocked only after its run failed`

The shared `unretiredPredecessorOnce` fixture gains blocked-task and repeated-attempt
tracking; `startTask` supports the blocked status and its blocking relation.
The two blocked-task titles are the `$title` parameter rows from #21472.
These are shared-fixture/import replacements plus additional regressions, not
permission to remove the existing pre-dispatch safety checks.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 5. `server/src/services/heartbeat/run-output.test.ts`

Upstream: [47a2c82d3541cf7d69e334d292cfa85d962811a5](https://github.com/paperclipai/paperclip/commit/47a2c82d3541cf7d69e334d292cfa85d962811a5), [#21450](https://github.com/paperclipai/paperclip/pull/21450).

- Test: `shows the wait as live status and writes nothing to the run while its log claim waits`
- Test: `holds the log's finalization until a reattach's deferred re-verification %s`
- Test: `settles at once when no log re-verification was deferred`
- Test: `lets a reattach start before its existing log is re-verified (deferred %s)`

The existing test's `appendRunEvent` mock accepts the explicit run/event signature.
Upstream adds deferred log-reverification/finalization coverage for release-swap
reattachment; the no-write-during-claim-wait assertion remains.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 6. `server/src/services/native-runtime/native-controller-recovery.integration.test.ts`

Upstream:
[2b23119ed25536f8f5d69d521b1cbd463fc26ad8](https://github.com/paperclipai/paperclip/commit/2b23119ed25536f8f5d69d521b1cbd463fc26ad8), [#21774](https://github.com/paperclipai/paperclip/pull/21774);
[890dcbdd66f177dcdd6fc724f7a87b590060589b](https://github.com/paperclipai/paperclip/commit/890dcbdd66f177dcdd6fc724f7a87b590060589b), [#21627](https://github.com/paperclipai/paperclip/pull/21627);
[958eda6f166281c0ee073211013afd30dee04b41](https://github.com/paperclipai/paperclip/commit/958eda6f166281c0ee073211013afd30dee04b41), [#21697](https://github.com/paperclipai/paperclip/pull/21697);
[df9914dbd98ce4b188526f8c11ac1310149c0d2c](https://github.com/paperclipai/paperclip/commit/df9914dbd98ce4b188526f8c11ac1310149c0d2c), [#21791](https://github.com/paperclipai/paperclip/pull/21791).

- Test: `does not publish an admission wait after authority changes: %s`
- Test: `keeps a warm follow-up that inherited its predecessor's process identity on the same run until the outgoing owner's deadline`
- Test: `waits while the outgoing server that ran the finished turn still holds its warm session, then takes it over once that server exits`
- Test: `waits for a live outgoing server in another process space until its controller lease ends`
- Test: `stops waiting for a live outgoing server once the finished turn's warm window has closed`
- Test: `keeps a follow-up waiting for a live outgoing server until that server has checkpointed the session after the turn`
- Test: `the outgoing server checkpoints and closes its idle warm session while the incoming server's follow-up waits for it, and the follow-up resumes within one recheck`
- Test: `holds a resumption claim of the parked follow-up until the outgoing server's save commits`
- Test: `refuses the outgoing server's idle checkpoint when the parked follow-up is no longer waiting on it: %s`

#21774 expands the authority-change cases to inherited/own process identities;
#21627 adds the live outgoing-owner scenarios and controller-instance import;
#21697 adds the checkpoint-aware outgoing-owner wait; #21791 carries the exact
`waitingForOwner` run/boot identity into the defer/failure-detail expectation,
adds checkpoint/backup ownership helpers, and adds fenced parked-successor cases.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 7. `server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`

Upstream: [47a2c82d3541cf7d69e334d292cfa85d962811a5](https://github.com/paperclipai/paperclip/commit/47a2c82d3541cf7d69e334d292cfa85d962811a5), [#21450](https://github.com/paperclipai/paperclip/pull/21450).

- Test: `leaves a run this process handed to the next server for that server`

Replace `awaiting_evidence/controller_still_alive` with
`blocked/handed_off_to_next_controller`, and check that the finalization row,
activity rows and recovery-action rows are unchanged. The adjacent
`keeps waiting for a different live controller in this process space` case is
not the assertion being replaced.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 8. `server/src/services/native-runtime/native-session-executor.test.ts`

Upstream:
[03309f1650d3b0033e87e65f8240e7135124c5c0](https://github.com/paperclipai/paperclip/commit/03309f1650d3b0033e87e65f8240e7135124c5c0), [#21835](https://github.com/paperclipai/paperclip/pull/21835);
[47a2c82d3541cf7d69e334d292cfa85d962811a5](https://github.com/paperclipai/paperclip/commit/47a2c82d3541cf7d69e334d292cfa85d962811a5), [#21450](https://github.com/paperclipai/paperclip/pull/21450);
[890dcbdd66f177dcdd6fc724f7a87b590060589b](https://github.com/paperclipai/paperclip/commit/890dcbdd66f177dcdd6fc724f7a87b590060589b), [#21627](https://github.com/paperclipai/paperclip/pull/21627);
[958eda6f166281c0ee073211013afd30dee04b41](https://github.com/paperclipai/paperclip/commit/958eda6f166281c0ee073211013afd30dee04b41), [#21697](https://github.com/paperclipai/paperclip/pull/21697);
[aaec67b89161e42571bd12f7c3e3b26ac92be3ce](https://github.com/paperclipai/paperclip/commit/aaec67b89161e42571bd12f7c3e3b26ac92be3ce), [#21597](https://github.com/paperclipai/paperclip/pull/21597);
[d149e30323282edbf39f9e00100eef10c91f0711](https://github.com/paperclipai/paperclip/commit/d149e30323282edbf39f9e00100eef10c91f0711), [#21853](https://github.com/paperclipai/paperclip/pull/21853);
[d14a3b88b188cf5eee0e44c826facead8221062b](https://github.com/paperclipai/paperclip/commit/d14a3b88b188cf5eee0e44c826facead8221062b), [#21782](https://github.com/paperclipai/paperclip/pull/21782).

Existing test replacements:

- Test: `releases an idle warm owner whose sandbox lease is gone when its environment is deleted (%s)`
- Test: `releases settled %s only under its current owner and retires its cache (unknown=%s, shutdown=%s, journalFailure=%s, deadline=%s, retirement=%s)`
- Test: `uses the bundled Linux image authority for remote %s without controller overrides`
- Test: `forgets a warm owner whose idle close failed only once the host gave up its sandbox: $lease`
- Test: `forgets a warm owner whose idle close failed only once its sandbox has a stop or destroy receipt: $lease`

#21835 deletes `expect(where).toHaveBeenCalledOnce()` in this upstream-owned file
because successor proof adds a DB read. The separate fork judge keeps the exact
receipt-specific counts recorded below. #21627 adds replacement-handoff cases
and an explicit 3,000 ms wait while retaining the once-called assertion.
#21697 adds prior-receipt/deploy-overlap coverage to the bundled-image test;
fork-only provider scenario rows remain.

**#21782 reverses #21504** (fork port `5901709f83`): the old three-row
lease-status-only test becomes the five-row stop/destroy-receipt test.
`pending_cleanup` and `released` change from `forgotten: true` to
`forgotten: false`; `retained` stays false; stopped/destroyed receipt cases are
true. Lease status alone no longer releases the warm owner. This supersedes the
#21504 behavior, not the historical commit; see [LEDGER.md](LEDGER.md).

Additional named replacement coverage in the judge-listed commits:

- Test: `ends the reattach phase once a reattached %s session is driven by this server again, without the cap or manual settling`
- Test: `closes a warm session promptly when a replacement server starts this server's runs (%s the turn ends)`
- Test: `a follow-up that starts within the outgoing server's close window waits for its live lease instead of relaunching the Runner`
- Test: `closes idle warm sessions of different agents in parallel and one at a time within an agent`
- Test: `keeps retrying a failed idle warm close after a failed environment sweep cleared its retry timer`
- Test: `stops the retained Runner of a finished warm owner that refused suspend and releases it without a checkpoint when its environment is deleted`
- Test: `keeps a finished warm owner whose retained Runner survives the stop`
- Test: `never stops the retained Runner of a warm owner whose run has not finished`
- Test: `logs sandbox Runner evidence for a close failure of a warm session reused by a later run`
- Test: `releases at controller restart a warm owner whose Runner durably suspended and exited but whose check found a live process without its runner id`
- Test: `keeps a durably suspended warm owner when %s`
- Test: `an idle warm session whose close fails with runner_remote_process_identity_unavailable and whose Runner is proven gone is released at controller restart`
- Test: `names the Runner check in a warm close failure and keeps an unproven owner registered at controller restart`
- Test: `retries a failed idle warm close a bounded number of times`
- Test: `reads the warm owner's own lease rows at controller restart: $lease`

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 9. `server/src/services/native-runtime/remote-runner-recovery-diagnostics.test.ts`

Upstream: [d149e30323282edbf39f9e00100eef10c91f0711](https://github.com/paperclipai/paperclip/commit/d149e30323282edbf39f9e00100eef10c91f0711), [#21853](https://github.com/paperclipai/paperclip/pull/21853).

- Test: `requires the saved generation before accepting a zombie receipt (%j)`
- Test: `reports a live process without its runner id apart from a changed marker (%j)`

The empty-fingerprint row expects code 48 instead of 44, distinguishing
`process_runner_id_missing` from `process_identity_changed`. The replacement
imports the named reason helper and adds the explicit live-process cases.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 10. `server/src/services/native-runtime/sandbox-runner-port-holders.integration.test.ts`

Upstream: [d149e30323282edbf39f9e00100eef10c91f0711](https://github.com/paperclipai/paperclip/commit/d149e30323282edbf39f9e00100eef10c91f0711), [#21853](https://github.com/paperclipai/paperclip/pull/21853).

- Test: `stops only the named session's finished Runner and then proves it exited`

The replaced import adds `sandboxSessionRunnerExited`, used by the new
finished-owner stop/positive-exit test. No existing assertion is deleted by
that import replacement.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 11. `tests/restart-chaos/daytona-image.test.ts`

Upstream: [47a2c82d3541cf7d69e334d292cfa85d962811a5](https://github.com/paperclipai/paperclip/commit/47a2c82d3541cf7d69e334d292cfa85d962811a5), [#21450](https://github.com/paperclipai/paperclip/pull/21450).

- Test: `accepts a mismatch only for the exact image content ID named by the test override`

The import gains `vi`; `expect` is retained. The added regression accepts only
the specifically named image-content-ID test override and retains the mismatch
rejection otherwise. This corrects the earlier record's description of an
`expect`-import deletion; see reconciliation below.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 12. `tests/restart-chaos/triggers.test.ts`

Upstream:
[9ebc276b4254cd2711307435117b0adc2289b317](https://github.com/paperclipai/paperclip/commit/9ebc276b4254cd2711307435117b0adc2289b317), [#21730](https://github.com/paperclipai/paperclip/pull/21730);
[c5218f5ec48c18c3f2df04a86fad7e3af3840a4d](https://github.com/paperclipai/paperclip/commit/c5218f5ec48c18c3f2df04a86fad7e3af3840a4d), [#21852](https://github.com/paperclipai/paperclip/pull/21852).

- Test: `does not flag a slow model request while the provider turn is active with no tool running (w-20261115T044649-s7106/t028)`
- Test: `still fails a silent run with no active provider turn, and a provider turn silent past the provider-latency bound`
- Test: `does not flag a run that is still acquiring its environment before its first run event (w-20261116T001158-s7106/t010)`
- Test: `R5 and U1 agree on a preparing run: a 6 and 7 minute restore passes both, silence past the preparation bound fails both`
- Test: `still fails a run silent past the preparation bound, and a started run silent past the stall bound`
- Test: `marks a running run as preparing only while its events read back empty`

#21730 adds active-provider-turn evidence/bounds coverage. #21852 extends the
shared `quietTurn` fixture with `preparing` and imports preparation/universal
bounds for environment-acquisition cases. Silent runs still fail their
applicable bound; a held or preparing run is not misclassified as undispatched.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 13. `tests/restart-chaos/wake-evidence.test.ts`

Upstream: [554e6d415c34d5208aedf1de653318c61ddd5c4f](https://github.com/paperclipai/paperclip/commit/554e6d415c34d5208aedf1de653318c61ddd5c4f), [#21692](https://github.com/paperclipai/paperclip/pull/21692).

- Test: `writes one file per task with the wake row, context snapshot, status changes and serving controller`

The first capture explicitly expects `providerTurnStarted: false`; after a
`turn.started` event is inserted, the replacement capture assertion retains
`runId` and adds `providerTurnStarted: true`. The import gains `heartbeatRunEvents`.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 14. `tests/restart-chaos/warm-shutdown.test.ts`

Upstream: [c5218f5ec48c18c3f2df04a86fad7e3af3840a4d](https://github.com/paperclipai/paperclip/commit/c5218f5ec48c18c3f2df04a86fad7e3af3840a4d), [#21852](https://github.com/paperclipai/paperclip/pull/21852).

- Test: `fails the staging shape: a 409 delete, started sandboxes and a bare failed count at shutdown`
- Test: `reports a forced stop without failing when cleanup still finished`
- Test: `reports each distinct (run, reason) once, not each log line (w-20261116T001158-s7106 A1: 2 sessions, 29 lines)`
- Test: `still fails on one distinct failure, and keeps different reasons for the same run apart`
- Test: `names the first idle-close failure once, across chunk boundaries and interleaved streams`
- Test: `lists the sandbox captures taken at the first idle-close failure`
- Test: `waits for a pending capture only up to its bound`

The two existing assertion shapes become structured distinct-failure records
(including `firstLine`), not raw strings. New cases distinguish per-run/reason
failures from repeated log lines and the aggregate shutdown summary; they retain
the one-distinct-failure negative control and bounded capture behavior.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

### 15. `ui/src/components/task-chat/TaskChatRunnerTurn.test.tsx`

Upstream:
[6dd0349d5208df88050d2c014766e1303c54017e](https://github.com/paperclipai/paperclip/commit/6dd0349d5208df88050d2c014766e1303c54017e), [#21564](https://github.com/paperclipai/paperclip/pull/21564);
[833689a3fcd84c8968c15297231824c3c3de570d](https://github.com/paperclipai/paperclip/commit/833689a3fcd84c8968c15297231824c3c3de570d), [#21447](https://github.com/paperclipai/paperclip/pull/21447).

- Test: `shows the server's %s wait while admission is held`
- Test: `keeps startup feedback briefly, then says a queued turn with no named hold is waiting to start`
- Test: `does not repeat the agent's waiting line in the turn body`
- Test: `does not call a running turn waiting, however long it runs`

#21447 adds truthful queued-wait/long-running controls. #21564 replaces the
redundant current-activity-label expectations with exact single-explanation
checks in the header and an absent current-activity element, including the
routine-execution hold. This is not a waiver to display duplicate explanations.

superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)

## One fork-test replacement (separate authorization)

File: `server/src/services/native-runtime/judge-tl08-started.test.ts`.
Test: `releases an idle warm owner whose sandbox lease is gone when its environment is deleted (%s)`.
Existing candidate carry:
[a16e71bf10038577664db8db9594bb12e7787849](https://github.com/Smarty-Pants-Inc/paperclip/commit/a16e71bf10038577664db8db9594bb12e7787849).

`expect(where).toHaveBeenCalledOnce()` -> `toHaveBeenCalledTimes(receipt === 'destroyed' ? 1 : 2)`

superseded by replacement (RFL 08:30Z 11-16): upstream #21835 adds one DB lookup

Upstream [03309f1650d3b0033e87e65f8240e7135124c5c0](https://github.com/paperclipai/paperclip/commit/03309f1650d3b0033e87e65f8240e7135124c5c0),
[#21835](https://github.com/paperclipai/paperclip/pull/21835), removes the old count
in the upstream-owned test (section 8). The fork judge instead retains an exact
count: `destroyed` is 1; `stopped` and `unproven` are 2. The actual code uses
double-quoted `"destroyed"`; the expression above uses the brief's requested
single-quoted notation for the same replacement. This is one fork assertion,
not a sixteenth upstream-owned file, and this docs commit does not edit it.

## Reconciliation with `PORT-LAND-SUPERSEDES.md`

**The judge's inventory wins.** The earlier record counts 15 named entries
(14 assertion/title entries plus the #21782 reversal), but those entries cover
only 8 unique files. Its entries 1–13 and 15 map to 7 of this inventory's files;
its entry 14 is the already-on-target Group C provider-pack test. The present
record counts files, includes shared-import/fixture edits and additive test
support, and retains every file/commit pair in `JUDGE-INVENTORY.md`.

| Earlier record | Present disposition / difference |
|---|---|
| Entries 1–2 (`TaskChatRunnerTurn`) | Combined in section 15; add judge-listed #21447 alongside #21564. |
| Entry 3 (restart recovery) | Section 7; the adjacent live-controller assertion remains distinct. |
| Entries 4–5, 10, 15 (executor) | Combined in section 8; all seven judge-listed commits included, with #21782's reversal of #21504 explicit. |
| Entries 6, 9 (controller recovery) | Combined in section 6; include all four judge-listed commits, not just the two assertion/title hits. |
| Entries 7–8 (orphaned tool attach) | Combined in section 1; both parameterization and dispatch-gate replacements recorded. |
| Entry 11 (wake evidence) | Section 13; also records the first capture's new `providerTurnStarted: false` expectation. |
| Entries 12–13 (warm shutdown) | Combined in section 14; structured failure expectations and replacement controls named. |
| Entry 14 (`server/src/services/native-runtime/remote-provider-pack-verification.test.ts`, #21781) | Not one of the judge's 15 candidate-edited files. This already-on-target Group C entry is not counted or replayed; its carry dispositions remain in [LEDGER.md](LEDGER.md). |
| Separate Daytona import hit | Included as section 11, not excluded. Both upstream #21450 and its candidate carry `2fce3bf85` add `vi` and retain `expect`; the earlier statement that `expect` was deleted is incorrect. The import itself has no test title; the added override regression is named. |

The earlier numbered entries omit these eight judge-required files (the earlier
unnumbered Daytona note is included here):

- `scripts/__tests__/run-vitest-stable-shard.test.mjs`
- `server/src/__tests__/agent-instruction-copy-retry-backoff.test.ts`
- `server/src/__tests__/heartbeat-native-predispatch-retry.test.ts`
- `server/src/services/heartbeat/run-output.test.ts`
- `server/src/services/native-runtime/remote-runner-recovery-diagnostics.test.ts`
- `server/src/services/native-runtime/sandbox-runner-port-holders.integration.test.ts`
- `tests/restart-chaos/daytona-image.test.ts`
- `tests/restart-chaos/triggers.test.ts`

Source records supplied with the 10:46Z brief: `JUDGE-INVENTORY.md`,
`PORT-LAND-SUPERSEDES.md`, `PORT-LAND-LEDGER-AMEND.md` and `PORT-LEDGER.md`.
Those external source filenames are provenance labels, not missing repository
links. Upstream Git objects and the candidate carries provide the linked edit
evidence above. This is an authorization inventory, not a claim of a fresh test
run, independent acceptance audit, CI pass, image qualification or live release.
