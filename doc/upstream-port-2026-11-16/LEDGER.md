# LEDGER: fork-only commits — amended for the upstream port (RFL C6)

This is the supplied `PORT-LEDGER.md` amended under RFL's 10:46Z 2026-11-16
request. The current port candidate is
[`6eed7c6e90628b29ab04681254a2105cae66aae0`](https://github.com/Smarty-Pants-Inc/paperclip/commit/6eed7c6e90628b29ab04681254a2105cae66aae0)
(`fl/port-final-head-next`). This documentation commit changes no code or tests.
The test-authorization inventory is [SUPERSEDES.md](SUPERSEDES.md).

## Original ledger scope and amendment rule

The original comparison was upstream master `29903bed59`, merge-base
`ef2a49b6df554a80701d1daf788b2002a512c61c`, base (dl/img2-M2d)
`a763d193f89d9e25abe3e06edb86b411f04951f4`, and original port head
`527ef57f69cecf897786cddb290339b1228a3efe`. Those are historical comparison
identifiers, not a claim that the original port head is the current candidate.

The original port cherry-picked ON TOP of its base rather than rebasing or
merging down. All 998 original fork-only ancestry rows below retain their
numbers, SHAs, dates, authors, subjects and order. **History carried does not
mean behavior unchanged.** Default `CARRIED (same sha)` describes historical
commit retention; the explicit effect dispositions take precedence. The 16
amended rows point to their effect disposition, and `5901709f83` is flagged in
both places rather than left with an unqualified carried status.

`PORT-LAND-LEDGER-AMEND.md` identifies 21 touched fork commits: the five prior
exception rows plus 16 missing **effect dispositions**. The 16 were already
among the 998 ancestry rows; they are not 16 newly discovered history entries.
Their dispositions and reasons below are carried from that supplied amendment.
No new product decision or authorization to replay a change is made here.
Group C and the #20791 sealed-pack integration were already on the M2h-derived
target and are not replayed by this record.

## Commits whose effect the port changes

Exactly 21 effect dispositions follow: five prior exceptions (including the
corrected #21504 row), then the 16 C6 amendments. `DROPPED` describes code effect,
not removal of a historical commit. The first three restart-pool replacements
remain dropped; the Pi ingress-reopen behavior remains carried. References to
old carry IDs and old test runs in the original ledger are historical evidence,
not a claim of fresh verification on this docs commit.

| fork sha | subject | status | reason | evidence |
|---|---|---|---|---|
| f70a59d976 | fix: close warm native sessions concurrently on restart | DROPPED (code effect) | Superseded by upstream aaec67b891 (#21597): per-agent parallel idle close; RFL row 8a. The original ledger named carry ebc9558120; the current candidate carries the replacement as b00e4b745. The commit stays in history; its pool code in native-session-executor.ts / shutdown.ts is replaced. Its prior test edits are not reverted by the port; the original ledger's external RESULT.md row 8a reported their run. This docs amendment does not rerun them. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/f70a59d97623c516c28665c8ff475ed7bbb384b3) |
| 1aa37d83d3 | fix: bound restart warm closes to five workers | DROPPED (code effect) | Superseded by upstream aaec67b891 (#21597): per-agent parallel idle close; RFL row 8a. The original ledger named carry ebc9558120; the current candidate carries the replacement as b00e4b745. The commit stays in history; its pool code in native-session-executor.ts / shutdown.ts is replaced. Its prior test edits are not reverted by the port; the original ledger's external RESULT.md row 8a reported their run. This docs amendment does not rerun them. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/1aa37d83d38f813c073e3b65b7b035e270fad036) |
| c96c17e636 | fix: restart warm closes use the judged four workers | DROPPED (code effect) | Superseded by upstream aaec67b891 (#21597): per-agent parallel idle close; RFL row 8a. The original ledger named carry ebc9558120; the current candidate carries the replacement as b00e4b745. The commit stays in history; its pool code in native-session-executor.ts / shutdown.ts is replaced. Its prior test edits are not reverted by the port; the original ledger's external RESULT.md row 8a reported their run. This docs amendment does not rerun them. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/c96c17e63660284901f7eb6bc8a605b80528ae99) |
| f946f8f3d1 | fix(native): an idle warm Pi chat reopens its runner ingress before suspend, or retires a lost owner and continues the same conversation | CARRIED, one line adapted | The idle-close exit check `await this.#runnerHasExited()` uses upstream's bounded probe `#runnerExitObservedWithin(...)` from e82c4f0a31 (#21472; original carry 02c6983dba, current candidate carry 37370172e). The reopen-before-suspend and runnerLost logic remains. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/f946f8f3d1cab710a23874d4703810f4999467c0) |
| 5901709f83 | Start follow-up runs normally when a warm sandbox's window ends during its idle close (#21504) | **FLAG: history CARRIED; lease-status-only release behavior DROPPED / reversed by upstream #21782** | This is the fork port of upstream 1f388ed385 (#21504), so #21504 was not re-picked (with 07e0383282 and 8959352b8c already in history). Upstream d14a3b88b188cf5eee0e44c826facead8221062b (#21782; current carry 332196933) reverses its lease-status-only release: pending_cleanup/released no longer forget the warm owner; positive stopped/destroyed receipts are required. superseded by upstream's own replacement (RFL 08:50Z 11-16, C1). | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/5901709f83a5a7eda79ee5d02e99a6618588d9b1) |
| 283dc8a562 | `perf(runner): verify only the selected provider pack once per process` | **CARRIED, adapted** | Selected-provider filtering and tree memoization remain in remote verification. Upstream #21781 adds named failures around the same scan. The current target's #20791 daemon admission bypasses this scan for sealed image packs; it does not widen Pi identity. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/283dc8a56229db3578f624fd45930fe70fea6d01) |
| 3c80928afe | `fix(server): launch native Pi through the verified remote runner pack` | **CARRIED, adapted** | Pi's verified-pack launch path remains. Import/signature integration incorporates upstream #21781/#21784, and the already-target #20791 daemon path. No Pi identity fallback is introduced by this carry. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/3c80928afe269209cc4344cc783932842a2ad7d1) |
| 3e86afebde | `perf(server): memoize immutable remote provider pack verification by lease` | **CARRIED, adapted** | Lease-scoped memoization remains; upstream #21784 includes provenance acceptance in both the memo identity and recursive verification arguments so unlike checks cannot share a memo result. Group C was already on target. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/3e86afebdefdc06416b0bfae65ff1ec8b8b3b9b6) |
| 5221b95aef | `fix(native): a positively pre-dispatch failure is not a resume barrier` | **CARRIED** | The affected attributed line is a test import expanded by upstream #21774/#21791. The pre-dispatch safety behavior is not removed; recovery tests gain the upstream identity and warm-owner scenarios. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/5221b95aefb54c90d20642bf9fcdbbd1ef20d320) |
| 560bf15e8a | `Revert "fix(agents): working-copy cleanup stops retrying when its source is gone"` | **CARRIED, adapted** | The revert's retry-preserving behavior stays. Upstream #21596 adds `AgentDirectoryOperationBusyError`, a millisecond `updatedAt` compare fence, and immediate discovery when a stop proof changes the row. It does not drop unresolved copies. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/560bf15e8a3609a22f739f2d73be5883613679a1) |
| 573b97d2df | `Merge upstream master ef2a49b6 into production C8` | **CARRIED, touched test declaration adapted** | The historical merge remains. The bundled-Linux-image-authority parameterized test declaration is extended by upstream #21697 while retaining fork-only provider rows. This is not a new replay of that merge. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/573b97d2dfd8a6db283e029bba89800124e6b1c7) |
| 5d9949aea4 | `Revert "fix(native-runtime): a stopped Boat sandbox fails fast as sandbox_stopped and is resumed once at command dispatch (REG-26)"` | **CARRIED, adapted** | The reverted Boat behavior is not restored. Upstream #21781 changes a bare catch in provider-pack candidate verification to report the concrete failure check before trying another candidate. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/5d9949aea4f75d3e3a62059089be8b291cd9929c) |
| 6f9146e972 | `fix(server): verify native Pi remote provider packs` | **CARRIED, adapted** | Pi still requires exact identity and verifies its native artifacts. Upstream #21781 names failure checks around those validations; #21784's ordinary-provider provenance work does not supersede Pi's exact-identity rule. Group C already lives on target. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/6f9146e972db4eefdb1d3ff184a8f0d2fca2f4a6) |
| 74ccf17092 | `fix(recovery): continue a failed continuation again instead of escalating it to the board (#21394)` | **CARRIED, extended** | Automatic continuation remains. Upstream #21450 adds `deferred_reattach_phase` and an early bounded deferral while release-swap reattachment owns work, preventing the ordinary sweep from racing that owner. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/74ccf170925fff24a5848539ad44ed3bbccf158b) |
| 75b4e49293 | `fix(native): restrict retained-idle authority to checkpoint maintenance` | **CARRIED, signature adapted** | The checkpoint-maintenance-only authorization remains. The default argument `{ checkpointMaintenanceOnly: false }` lets upstream's three-argument call work without granting retained-idle maintenance authority; #21791 adds the fenced parked-successor wait proof. The approved carry fixup supplies this integration. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/75b4e4929349734ad0f012cd0e88e113bb931ad3) |
| 76fb05c3b5 | `fix(native): keep an unreachable remote Runner alive when a failed run closes (#20923)` | **CARRIED, probe bounded** | Upstream #21472 replaces unbounded `#runnerHasExited()` with `#runnerExitObservedWithin(...)`; lack of positive exit proof still retains the unsettled remote Runner for same-run reattachment. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/76fb05c3b55c3a012e5b24d0d48e0788ab34ff3c) |
| 824673c2d3 | `Reduce native Pi cold preparation with sealed snapshot digest admission` | **CARRIED, evolved on target** | Sealed-preinstalled selection remains before ordinary staged/preinstalled/uploaded fallback. Upstream #21781 supplies rejected-candidate reasons and #21784 provenance-aware ordinary-pack reuse; current target's judged #20791 admits sealed image packs via the existing Runner daemon rather than re-scanning them. This landing preserves those target bytes. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/824673c2d3e29e8696736deb2e4bd87d14d53140) |
| b2acea45e9 | `fix(runner): locale-independent pack tree order` | **CARRIED** | The scan still sorts with byte/code-unit comparisons (`a.name < b.name ? -1 : ...`), not localeCompare. Upstream #21781 wraps the walker to return a named unreadable/digest failure without changing the tree order. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/b2acea45e91f0d767f64fc58ba03cdd502e238e0) |
| b78a335ec4 | `fix: settle warm retirement setup and preserve resumed refusal authority` | **CARRIED** | Upstream #21472/#21627 extend the test fixture's `unretiredPredecessorOnce` options with `taskBlocked` and repeated-attempt tracking, adding blocked-task and repeated-refusal regressions. Exact unstarted-claim release and preserved refusal authority remain; no prior scenario is deleted by this port. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/b78a335ec4a1ce0ed862be3b8eae5784a36a63ba) |
| da3951be3d | `fix(instructions): back off working copies that cannot make progress (#21586)` | **CARRIED, extended** | Capped retry/backoff remains. Upstream #21596 adds immediate stop-proof-driven collection and busy-cleanup handling, and adds an environment lease test import. C3 runs its unchanged backlog test repeatedly on the landed head. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/da3951be3d6139e94e0de3fbcbfb314f7c142244) |
| e668c1d35a | `fix(server): hash provider-pack manifests in the builder key order` | **CARRIED** | The fork's `canonicalProviderPackDigestJson` remains for manifest digests, distinct from semantic equality canonicalization. Upstream #21781 refactors the digest conditional into a named failure check, not a different hash order. Current target already carries that integration. | [fork commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/e668c1d35a9a0ebac995d38513bc69d6b2df4a0d) |

### Mandatory #21504 / #21782 behavior flag

**`5901709f83`: behavior DROPPED / SUPERSEDED; history CARRIED.**
The original ledger's unqualified `CARRIED (same sha)` was correct for ancestry
but not for the resulting release behavior. Upstream
[#21504](https://github.com/paperclipai/paperclip/pull/21504) was already ported;
upstream
[#21782](https://github.com/paperclipai/paperclip/pull/21782),
[d14a3b88b188cf5eee0e44c826facead8221062b](https://github.com/paperclipai/paperclip/commit/d14a3b88b188cf5eee0e44c826facead8221062b),
reverses the lease-status-only owner release. Its current candidate carry is
[332196933](https://github.com/Smarty-Pants-Inc/paperclip/commit/332196933).

In the executor test, the three lease-status rows become five evidence rows:
`pending_cleanup` and `released` change from `forgotten: true` to
`forgotten: false`; `retained` remains false; positive stopped/destroyed receipt
rows are true. The warm owner must not be released on lease status alone.
This is **superseded by upstream's own replacement (RFL 08:50Z 11-16, C1)**;
[SUPERSEDES.md section 8](SUPERSEDES.md#8-serversrcservicesnative-runtimenative-session-executortestts)
records the exact old/new test titles and authorization.

### Linked replacement references for the effect table

- [#21450](https://github.com/paperclipai/paperclip/pull/21450): bounded release-swap reattach deferral.
- [#21472](https://github.com/paperclipai/paperclip/pull/21472): bounded Runner exit proof.
- [#21596](https://github.com/paperclipai/paperclip/pull/21596): stop-proof-driven working-copy collection.
- [#21597](https://github.com/paperclipai/paperclip/pull/21597): parallel idle close across agents, replacing the fork restart pool.
- [#21627](https://github.com/paperclipai/paperclip/pull/21627): live outgoing-owner wait and repeated-retirement cases.
- [#21697](https://github.com/paperclipai/paperclip/pull/21697): checkpoint-aware deploy-overlap wait and provider scenarios.
- [#21774](https://github.com/paperclipai/paperclip/pull/21774): inherited process-identity authority.
- [#21781](https://github.com/paperclipai/paperclip/pull/21781): named provider-pack verification failures (already on target, Group C).
- [#21784](https://github.com/paperclipai/paperclip/pull/21784): provenance-aware ordinary-provider pack reuse (already on target, Group C).
- [#21791](https://github.com/paperclipai/paperclip/pull/21791): fenced outgoing checkpoint ownership while a successor waits.
- [smarty-dev#20791](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20791): the already-target sealed-image pack admission, carried as [4c25354bce238d96ffc06c8a8ffa549c94c243f5](https://github.com/Smarty-Pants-Inc/paperclip/commit/4c25354bce238d96ffc06c8a8ffa549c94c243f5); no replay or new identity fallback is authorized here.

The supplied amendment's C3 backlog-run statement is a reference to the port
verification work, not a test executed by this docs task. This effect inventory
is not a claim of release/image qualification: new provider pack, sealed
snapshot, restart-up composition and live gates remain the lead's release work.

Source records: supplied `PORT-LEDGER.md` and `PORT-LAND-LEDGER-AMEND.md`, reconciled
with the candidate history. External source/evidence filenames are provenance
labels, not repository links to absent scratch files. This amendment does not
claim a fresh product-test run, independent acceptance audit or CI pass.

## All 998 fork-only commits (default: CARRIED, same sha)

| # | sha | date | author | subject | status |
|---|---|---|---|---|---|
| 1 | 7589946a3b | 2026-11-11 | smarty-fleet-write[bot] | feat: make the persisted run-log chunk cap configurable | CARRIED (same sha) |
| 2 | 417b15bdca | 2026-11-11 | smarty-fleet-write[bot] | fix(environments): keep a reusable plugin sandbox when its ordinary release fails | CARRIED (same sha) |
| 3 | c1129669f9 | 2026-11-11 | smarty-fleet-write[bot] | test(environments): expect stop-only intent for a stale-lifecycle reusable release | CARRIED (same sha) |
| 4 | e4e01bb706 | 2026-11-11 | smarty-fleet-write[bot] | fix(runner): run a Claude Pi agent's top thinking level as Pi xhigh, never max | CARRIED (same sha) |
| 5 | d892d2291a | 2026-11-11 | smarty-fleet-write[bot] | fix(runner): fail closed when mapping a Pi agent's max thinking level | CARRIED (same sha) |
| 6 | 877b6be573 | 2026-11-11 | smarty-fleet-write[bot] | feat(runner): load operator-named Pi extensions under the Runner | CARRIED (same sha) |
| 7 | e210444932 | 2026-11-11 | smarty-fleet-write[bot] | feat(runner): native Pi extension and package support under the Runner | CARRIED (same sha) |
| 8 | 68149e4901 | 2026-11-05 | A8IO | fix(pi): honor sandbox cancellation until execution settles | CARRIED (same sha) |
| 9 | 7dcaaf9d69 | 2026-09-29 | alex | fix(adapter-utils): key sandbox session identity on the provider lease | CARRIED (same sha) |
| 10 | fe2fe7b2da | 2026-09-29 | alex | fix(adapters): keep remoteExecution in session codecs | CARRIED (same sha) |
| 11 | e053f73312 | 2026-09-30 | alex | fix(claude-local): do not log a fresh remote session when the session resumes | CARRIED (same sha) |
| 12 | b7bfd4e547 | 2026-11-12 | smarty-fleet-write[bot] | Runner: managed custom gateways for Pi (Messages and Responses) through a shared loopback broker | CARRIED (same sha) |
| 13 | 9e2f6e778b | 2026-11-12 | smarty-fleet-write[bot] | feat(environments): qualify provider snapshots generically through the snapshot identity handshake | CARRIED (same sha) |
| 14 | fb75c599ec | 2026-11-12 | smarty-fleet-write[bot] | feat(runner): native Pi RPC driver pieces: admission, environment probe, event projector, real Pi 1.5.2 RPC recordings | CARRIED (same sha) |
| 15 | 134b71f8ac | 2026-11-12 | smarty-fleet-write[bot] | feat(runner): register qualified native Pi RPC runnerd facade seam | CARRIED (same sha) |
| 16 | 09a37ea038 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): isolate pi_rpc identity and native Pi distribution from ACPX | CARRIED (same sha) |
| 17 | 7c6dfc95b2 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): separate native piRpcThinkingLevel from preserved ACPX thinking | CARRIED (same sha) |
| 18 | ee3c559d89 | 2026-11-12 | smarty-fleet-write[bot] | wip: native Pi RPC server admission and scoped model catalog | CARRIED (same sha) |
| 19 | a5f7b7f616 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): qualify native Pi admission, thinking caps and managed warm retention | CARRIED (same sha) |
| 20 | 22d9cee66d | 2026-11-12 | smarty-fleet-write[bot] | test(server): repair managed-route fixture typing and guard Pi catalog scope | CARRIED (same sha) |
| 21 | 269da96799 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): recover native Pi from its durable local facade state | CARRIED (same sha) |
| 22 | 063c5039aa | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): admit native Pi transport and park settled resident sessions | CARRIED (same sha) |
| 23 | bd04dbca47 | 2026-11-12 | smarty-fleet-write[bot] | feat(runner): bind and materialize independent native Pi provider-pack closure | CARRIED (same sha) |
| 24 | d8404e9d64 | 2026-11-12 | smarty-fleet-write[bot] | fix(plugin-sdk): admit native Pi RPC launch requirements | CARRIED (same sha) |
| 25 | 95c51168a0 | 2026-11-12 | smarty-fleet-write[bot] | test(runner-e2e): discover the native Pi RPC production profile | CARRIED (same sha) |
| 26 | 4939c0a0a8 | 2026-11-12 | smarty-fleet-write[bot] | test(runner): reproduce late Pi events crossing admitted turn and run origins | CARRIED (same sha) |
| 27 | 0662e71031 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): preserve driver origin on every native Pi projected event | CARRIED (same sha) |
| 28 | 0639c382de | 2026-11-12 | smarty-fleet-write[bot] | shared: AdapterModel.family (for dev-lead; one line) | CARRIED (same sha) |
| 29 | fb85d7515a | 2026-11-12 | smarty-fleet-write[bot] | ui(pi_rpc): native Pi effort picker, scoped gateway catalog, setup/config without ACPX rewrite | CARRIED (same sha) |
| 30 | 589ab862d4 | 2026-11-12 | smarty-fleet-write[bot] | feat(runner): native Pi RPC driver, transport and runnerd app-server proxy (binding 28, WIP: runnerd 2-turn proof pending) | CARRIED (same sha) |
| 31 | e44f355a15 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): pi proxy reads PAPERCLIP_PI_RUNTIME_DIR, the name runnerd passes | CARRIED (same sha) |
| 32 | e90e89aa97 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): pi proxy answers the Codex executor handshake (initialize, thread/start) like OpenCode; runnerd 2-turn residency test | CARRIED (same sha) |
| 33 | a558369e97 | 2026-11-12 | smarty-fleet-write[bot] | feat(runner): pi_rpc credential via lane 1's loopback broker (default) or env; merge into the agent's models.json instead of replacing it | CARRIED (same sha) |
| 34 | 6fa77e1832 | 2026-11-12 | smarty-fleet-write[bot] | test(runner): pi proxy refuses a bare memfd binding on Linux (needs the verified path) | CARRIED (same sha) |
| 35 | 4b6159d64a | 2026-11-12 | smarty-fleet-write[bot] | revert(runner): keep the shared loopback broker's close semantics (refused connection after close) unchanged for ACPX | CARRIED (same sha) |
| 36 | 878c0be3f2 | 2026-11-12 | smarty-fleet-write[bot] | test(runner): broker capability refused after close (connection refused); chat is now a supported managed Pi protocol | CARRIED (same sha) |
| 37 | 24b8e0060a | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): forward PAPERCLIP_PI_RPC_CREDENTIAL_MODE to the pi_rpc proxy | CARRIED (same sha) |
| 38 | fdf31c41e0 | 2026-11-12 | smarty-fleet-write[bot] | ui(transcript): render native Pi (pi_rpc) runs correctly in task chat and run log | CARRIED (same sha) |
| 39 | e0dd32e394 | 2026-11-12 | smarty-fleet-write[bot] | test(pi): specify in-process child selection and bridge gates | CARRIED (same sha) |
| 40 | 8c57cabf2c | 2026-11-12 | smarty-fleet-write[bot] | feat(pi): gate explicit in-process child selections and required bridge | CARRIED (same sha) |
| 41 | 20a706d7fb | 2026-11-12 | smarty-fleet-write[bot] | Revert "feat(pi): gate explicit in-process child selections and required bridge" | CARRIED (same sha) |
| 42 | 4740034507 | 2026-11-12 | smarty-fleet-write[bot] | Revert "test(pi): specify in-process child selection and bridge gates" | CARRIED (same sha) |
| 43 | fad0f9bc0f | 2026-11-12 | smarty-fleet-write[bot] | test(pi): specify native-home admission, MCP policy and raw artifact gates | CARRIED (same sha) |
| 44 | 0492893e28 | 2026-11-12 | smarty-fleet-write[bot] | feat(pi): validate native home, codemode MCP and guard raw artifacts | CARRIED (same sha) |
| 45 | cb48e346e5 | 2026-11-12 | smarty-fleet-write[bot] | test(pi): seed direct MCP declarations at the native provider boundary | CARRIED (same sha) |
| 46 | d3996c3ba6 | 2026-11-12 | smarty-fleet-write[bot] | chore(runner): regenerate the PRP contract manifest for the native Pi RPC protocol changes | CARRIED (same sha) |
| 47 | bc75695714 | 2026-11-12 | smarty-fleet-write[bot] | fix(adapter-utils): never inject the Codex permission default into native Pi RPC configs | CARRIED (same sha) |
| 48 | 4077f78494 | 2026-11-12 | smarty-fleet-write[bot] | feat(pi): attest native home startup load facts at bind | CARRIED (same sha) |
| 49 | 5865258c63 | 2026-11-12 | smarty-fleet-write[bot] | fix(shared): accept the broker loopback paperclip/<id> model for native Pi RPC fixed connections | CARRIED (same sha) |
| 50 | 6f9146e972 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): verify native Pi remote provider packs | **CARRIED, adapted** (history: same sha; effect: see above) |
| 51 | e668c1d35a | 2026-11-12 | smarty-fleet-write[bot] | fix(server): hash provider-pack manifests in the builder key order | **CARRIED** (history: same sha; effect: see above) |
| 52 | dc0c96d0bd | 2026-11-12 | smarty-fleet-write[bot] | test(server): cover saved native Pi RPC agent through runner launch | CARRIED (same sha) |
| 53 | 3c80928afe | 2026-11-12 | smarty-fleet-write[bot] | fix(server): launch native Pi through the verified remote runner pack | **CARRIED, adapted** (history: same sha; effect: see above) |
| 54 | 3e06108905 | 2026-11-12 | smarty-fleet-write[bot] | test(server): build the server-path pack fixture digest in the builder key order | CARRIED (same sha) |
| 55 | ffbe22e90d | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): wire live admission and originating event projectors | CARRIED (same sha) |
| 56 | acb1858cef | 2026-11-12 | smarty-fleet-write[bot] | feat(pi_rpc): rebind resident run authority with revocable providers | CARRIED (same sha) |
| 57 | ccc094a29d | 2026-11-12 | smarty-fleet-write[bot] | rust(pi_rpc): retain settled processes across admitted run refreshes | CARRIED (same sha) |
| 58 | 084356da59 | 2026-11-12 | smarty-fleet-write[bot] | feat(pi_rpc): fence live semantic and UI callbacks by captured authority | CARRIED (same sha) |
| 59 | b5705b038e | 2026-11-12 | smarty-fleet-write[bot] | test(pi_rpc): prepare runnerd resident authority acceptance with full runtime closure | CARRIED (same sha) |
| 60 | 08dc282832 | 2026-11-12 | smarty-fleet-write[bot] | test(pi_rpc): qualify the existing runnerd smoke against owned native resources | CARRIED (same sha) |
| 61 | 65293cb77c | 2026-11-12 | smarty-fleet-write[bot] | rust(pi_rpc): preserve verified proxy resource path | CARRIED (same sha) |
| 62 | 092cb3f820 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): attest owned extension resources across descriptor launch | CARRIED (same sha) |
| 63 | 3bc2f233b9 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): admit native Pi RPC at the native attempt provider gate | CARRIED (same sha) |
| 64 | ddd5c74f7a | 2026-11-12 | smarty-fleet-write[bot] | rust(pi_rpc): forward fresh run instructions during revalidation | CARRIED (same sha) |
| 65 | 16e8f4b5ed | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): restore native home resources and refresh private instructions | CARRIED (same sha) |
| 66 | 0020b9f949 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): never delete raw provider traces (R-keep-all-traces) | CARRIED (same sha) |
| 67 | c35dc14e75 | 2026-11-12 | smarty-fleet-write[bot] | fix(shared): admit native Pi RPC connection pool profiles | CARRIED (same sha) |
| 68 | 84a83b2f59 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): prove stopped native Pi sessions safe for continuation | CARRIED (same sha) |
| 69 | 29241cc4b0 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): sync admitted company skills into the native agent home | CARRIED (same sha) |
| 70 | 9b2a6049f7 | 2026-11-12 | smarty-fleet-write[bot] | fix(ai-connections): accept native Pi (pi_rpc) fixed bindings on routed gateway connections | CARRIED (same sha) |
| 71 | f8f2bfa8e2 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): keep provider traces readable past the legacy 24 h deadline | CARRIED (same sha) |
| 72 | 9c6f6190c2 | 2026-11-12 | smarty-fleet-write[bot] | merge pi-native/integration 9b2a6049 (cl/pi-resident, conn-compat, F014, nativehome) into dl/fix-422 | CARRIED (same sha) |
| 73 | 592b25e1f6 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): wire verified local native Pi launch artifacts | CARRIED (same sha) |
| 74 | 6ed01d1eb9 | 2026-11-12 | smarty-fleet-write[bot] | fix(native): include Pi RPC in accounting, MCP and warm-state gates | CARRIED (same sha) |
| 75 | 2855e582d7 | 2026-11-12 | smarty-fleet-write[bot] | fix(shared): take the integration rule for native Pi connection compatibility | CARRIED (same sha) |
| 76 | d8c71980cd | 2026-11-12 | smarty-fleet-write[bot] | fix(server): keep a failed provider-trace capture copy instead of unlinking it | CARRIED (same sha) |
| 77 | b93961a160 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): make provider-trace expiry a no-op under keep-forever | CARRIED (same sha) |
| 78 | 27e4a198da | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): admit native Pi in plan contract and typed inputs | CARRIED (same sha) |
| 79 | f924db2d42 | 2026-11-12 | smarty-fleet-write[bot] | feat(runner): let sandbox leases release and reclaim a resident Runner (park/claim over a guardian channel) | CARRIED (same sha) |
| 80 | 2cfebaf31e | 2026-11-12 | smarty-fleet-write[bot] | test(server): supply verified packs for local native Pi launch tests | CARRIED (same sha) |
| 81 | 755b8045cb | 2026-11-12 | smarty-fleet-write[bot] | rust(pi_rpc): retain native MCP connection environment | CARRIED (same sha) |
| 82 | afa08378a6 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): configure native Paperclip MCP in codemode | CARRIED (same sha) |
| 83 | af35d75bcf | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): bridge active-turn steering through the RPC facade | CARRIED (same sha) |
| 84 | d485ee51e1 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): retarget the admitted run instruction grant | CARRIED (same sha) |
| 85 | 5a62891eef | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): preserve admitted native Pi model thinking capability | CARRIED (same sha) |
| 86 | 28c0a66b4c | 2026-11-12 | smarty-fleet-write[bot] | rust(pi_rpc): retain native MCP connection environment | CARRIED (same sha) |
| 87 | bc1749d172 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): configure native Paperclip MCP in codemode | CARRIED (same sha) |
| 88 | 6c03c16325 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): retarget the admitted run instruction grant | CARRIED (same sha) |
| 89 | 51d9a5afbd | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): enable and qualify Runner API dynamic tools | CARRIED (same sha) |
| 90 | 0dfd25095b | 2026-11-12 | smarty-fleet-write[bot] | Revert "fix(pi_rpc): configure native Paperclip MCP in codemode" | CARRIED (same sha) |
| 91 | ed2fb301f1 | 2026-11-12 | smarty-fleet-write[bot] | Revert "rust(pi_rpc): retain native MCP connection environment" | CARRIED (same sha) |
| 92 | fe70b8fbf3 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): enable and qualify Runner API dynamic tools | CARRIED (same sha) |
| 93 | 1204ea2fc0 | 2026-11-12 | Paperclip Agent | fix(native-pi): complete runtime fallbacks and pinned pool selection | CARRIED (same sha) |
| 94 | 6fa70b1bfc | 2026-11-12 | smarty-fleet-write[bot] | feat(issues): let the assignee's direct manager agent steer a queued plain comment into the active run | CARRIED (same sha) |
| 95 | 9cf77d02e2 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): preserve provider query strings through loopback | CARRIED (same sha) |
| 96 | a0e7cad878 | 2026-11-12 | smarty-fleet-write[bot] | build(runner): pin pi-subagents 0.88.0 and yaml 2.8.3; Pi 1.5.2 types for the native Pi extension | CARRIED (same sha) |
| 97 | 451b032909 | 2026-11-12 | smarty-fleet-write[bot] | Reapply "test(pi): specify in-process child selection and bridge gates" | CARRIED (same sha) |
| 98 | b018f550ea | 2026-11-12 | smarty-fleet-write[bot] | Reapply "feat(pi): gate explicit in-process child selections and required bridge" | CARRIED (same sha) |
| 99 | 2d1bbe48be | 2026-11-12 | smarty-fleet-write[bot] | test(pi): pin stock subagent role fixture independent of installation | CARRIED (same sha) |
| 100 | 6d5a8c91c2 | 2026-11-12 | smarty-fleet-write[bot] | test(pi): specify S-1 socket authority and liveness stop barriers | CARRIED (same sha) |
| 101 | cedab75349 | 2026-11-12 | smarty-fleet-write[bot] | feat(pi): gate async native starts and observe child stop settlement | CARRIED (same sha) |
| 102 | dbe878ea5e | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): use code-unit order for remote pack comparison | CARRIED (same sha) |
| 103 | c1d8505a61 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): keep the sandbox's configured Pi agent dir for pi_rpc | CARRIED (same sha) |
| 104 | 43975ba76e | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): allow 120 s for remote pack verification | CARRIED (same sha) |
| 105 | 089f43e18e | 2026-11-12 | smarty-fleet-write[bot] | merge: image 1 (dl/img1 43975ba7) + cand/image2 (cedab753) for image 2; drivers/pi capability conflict resolved to steering:true | CARRIED (same sha) |
| 106 | 717e2606a4 | 2026-11-12 | smarty-fleet-write[bot] | test(server): fix native pi_rpc server-path test types | CARRIED (same sha) |
| 107 | cfa0fce5f7 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): compose native Pi child bridge and bundle both factories | CARRIED (same sha) |
| 108 | 72463c3488 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): keep home subagent package out of provider pack | CARRIED (same sha) |
| 109 | 9908dbe97e | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): qualify Pi pack entry permissions and portable YAML shim | CARRIED (same sha) |
| 110 | 0df333e114 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): announce over the bind protocol envelope | CARRIED (same sha) |
| 111 | 2fa0cf7399 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): only our own extension's session_start failure is fatal | CARRIED (same sha) |
| 112 | ba39b2c487 | 2026-11-12 | smarty-fleet-write[bot] | test(pi_rpc): preserve child spawn authority during active steer | CARRIED (same sha) |
| 113 | dde9705d04 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): normalize Pi Responses tool call identities | CARRIED (same sha) |
| 114 | 599daef44c | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): bound Pi tool display without losing transport errors | CARRIED (same sha) |
| 115 | 041b0cfb5e | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): preserve display-only entries, inputs, home and usage | CARRIED (same sha) |
| 116 | dc59458557 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): retain terminal authority and restart continuity | CARRIED (same sha) |
| 117 | ce28cf8b07 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): retain registered home at runner process boundary | CARRIED (same sha) |
| 118 | fa29eefd4e | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): bind agent home from provider-local runtime context | CARRIED (same sha) |
| 119 | d9ee0fad45 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): bound Pi tool display without losing transport errors | CARRIED (same sha) |
| 120 | 36cb3a804c | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): preserve Pi custom display and queued control state | CARRIED (same sha) |
| 121 | 617195bb7c | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): persist accepted Pi finishes across native restarts | CARRIED (same sha) |
| 122 | 283dc8a562 | 2026-11-12 | smarty-fleet-write[bot] | perf(runner): verify only the selected provider pack once per process | **CARRIED, adapted** (history: same sha; effect: see above) |
| 123 | b2acea45e9 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): locale-independent pack tree order | **CARRIED** (history: same sha; effect: see above) |
| 124 | 81797205b8 | 2026-11-12 | smarty-fleet-write[bot] | feat(pi): qualify fresh agents with native metadata and retired setup hello | CARRIED (same sha) |
| 125 | 9240111049 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): admit native setup drafts and preserve turn identity | CARRIED (same sha) |
| 126 | 472270ae72 | 2026-11-12 | smarty-fleet-write[bot] | test: align steer peer and adapter-validation test with C5b | CARRIED (same sha) |
| 127 | 13d99ea0e6 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): keep Pi stderr on a failed startup | CARRIED (same sha) |
| 128 | bec0718bb7 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): give environment sync RPCs a 120 s floor | CARRIED (same sha) |
| 129 | dabb4a538d | 2026-11-12 | smarty-fleet-write[bot] | test(pi): align admitted model and real Responses child bridge fixtures | CARRIED (same sha) |
| 130 | 486f5bdc94 | 2026-11-12 | smarty-fleet-write[bot] | server: admit native Pi imports and preserve legacy conversion settings | CARRIED (same sha) |
| 131 | 4543ce87b6 | 2026-11-12 | smarty-fleet-write[bot] | server: map native Pi thinking levels in MCP agent configuration | CARRIED (same sha) |
| 132 | 0ab6489f83 | 2026-11-12 | smarty-fleet-write[bot] | server: explicitly reject unmanaged Pi probes and expose its provider option | CARRIED (same sha) |
| 133 | 1e40e4c98a | 2026-11-12 | smarty-fleet-write[bot] | runner: report the configured provider for native Pi threads | CARRIED (same sha) |
| 134 | 1aff74b71c | 2026-11-12 | smarty-fleet-write[bot] | test(server): fix the Pi adapter-registry test typings | CARRIED (same sha) |
| 135 | 28a5757e3d | 2026-11-12 | smarty-fleet-write[bot] | test(pi): load the real subagents home in Responses runnerd proof | CARRIED (same sha) |
| 136 | d660143262 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): trust root-owned executable and proxy resources | CARRIED (same sha) |
| 137 | 60dbea598e | 2026-11-12 | smarty-fleet-write[bot] | merge image 1b dl/img1b fa29eefd into image 2 | CARRIED (same sha) |
| 138 | 052cb4baff | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): skip agent-files binding without an instructions grant | CARRIED (same sha) |
| 139 | d0fe4d250f | 2026-11-12 | smarty-fleet-write[bot] | test(pi): align image-2 admission fixtures and sync timeout floor | CARRIED (same sha) |
| 140 | 70b65abb27 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): skip agent-files binding without an instructions grant | CARRIED (same sha) |
| 141 | e2ee9d91e4 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): keep earlier runnerd diagnostics across relaunches; hold Pi lost-turn continuation until restore is proven | CARRIED (same sha) |
| 142 | 007abe7514 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): normalize Pi Responses tool call identities | CARRIED (same sha) |
| 143 | 30c4b9231e | 2026-11-12 | smarty-fleet-write[bot] | fix(runnerd): refuse a malformed provider tool call without exiting runnerd | CARRIED (same sha) |
| 144 | 7b627c172a | 2026-11-12 | smarty-fleet-write[bot] | test(server): fix native pi_rpc server-path test types | CARRIED (same sha) |
| 145 | 03e89f8e29 | 2026-11-12 | smarty-fleet-write[bot] | test(server): native executor pack-verify timeout floor is 120 s (from d0fe4d25, test-only) | CARRIED (same sha) |
| 146 | 9882e31650 | 2026-11-12 | smarty-fleet-write[bot] | Merge 1b' (cl/img1b-prime 03e89f8e) into pi-native/integration for image 2 | CARRIED (same sha) |
| 147 | acb53fd26f | 2026-11-12 | smarty-fleet-write[bot] | fix(runnerd): settle pi_rpc tool results after a timeout and replay by toolCallId | CARRIED (same sha) |
| 148 | 294cad662a | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): a lost pi_rpc turn fails with a typed non-recoverable cause; keep pi_rpc in the restart test | CARRIED (same sha) |
| 149 | 707a616c70 | 2026-11-12 | smarty-fleet-write[bot] | test(shared): align Pi lifecycle examples with native RPC defaults | CARRIED (same sha) |
| 150 | 231c241087 | 2026-11-12 | smarty-fleet-write[bot] | test(runner): cover real nested Pi callback identities | CARRIED (same sha) |
| 151 | 0dc6008419 | 2026-11-12 | smarty-fleet-write[bot] | test(runner): verify native finish and warm Pi reuse | CARRIED (same sha) |
| 152 | dc30e3bde9 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): forward events for every run/turn id and pin Pi token usage with a test | CARRIED (same sha) |
| 153 | 2868978cf0 | 2026-11-12 | smarty-fleet-write[bot] | fix(runnerd): keep every generation's diagnostics on both launch paths | CARRIED (same sha) |
| 154 | 3db56a9669 | 2026-11-12 | smarty-fleet-write[bot] | test(server): expect native Pi RPC for SSH agent creation | CARRIED (same sha) |
| 155 | 78647dfdea | 2026-11-12 | smarty-fleet-write[bot] | fix(policy): declare Node engine for Pi RPC distribution | CARRIED (same sha) |
| 156 | b925701269 | 2026-11-12 | smarty-fleet-write[bot] | style(runner): apply cargo fmt to native provider sources | CARRIED (same sha) |
| 157 | 392de16551 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): distinguish provider pack root in session inventory | CARRIED (same sha) |
| 158 | 90d212c166 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): contain malformed runtime requests per RPC | CARRIED (same sha) |
| 159 | a1529a5911 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): withdraw hardcoded Claude max clamps; the cap is config | CARRIED (same sha) |
| 160 | 4d6be5df90 | 2026-11-12 | smarty-fleet-write[bot] | Merge dl/img2-r3 into cand/image2-recut (image-2 triage) | CARRIED (same sha) |
| 161 | 1bcb5da6a7 | 2026-11-12 | smarty-fleet-write[bot] | Merge dl/img2-r456 into cand/image2-recut (image-2 triage) | CARRIED (same sha) |
| 162 | 64ec9d2b9b | 2026-11-12 | smarty-fleet-write[bot] | test(runner): prove Pi alias trace lookup and agent-files fixture | CARRIED (same sha) |
| 163 | 29061956d4 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): preserve final channel and bound final summaries | CARRIED (same sha) |
| 164 | 2d99c439c6 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): reject empty native completion outcomes | CARRIED (same sha) |
| 165 | 2b34dc49b0 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): withdraw remaining hardcoded Claude max restrictions | CARRIED (same sha) |
| 166 | f6c19533ab | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): preserve Pi usage receipt identity and reported cost | CARRIED (same sha) |
| 167 | 39d77e2c8a | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): retain Pi unknown child-usage accounting marker | CARRIED (same sha) |
| 168 | 49568cfbb8 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): admit ordinary subagent children without a pre-issued bridge binding | CARRIED (same sha) |
| 169 | e69198918d | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): withdraw hardcoded Claude clamps (Paul: policy lives in config) | CARRIED (same sha) |
| 170 | 9725911f91 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): normalize dynamic tool definitions so one bad tool never fails the bind | CARRIED (same sha) |
| 171 | e423255e03 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): pass the initial binding in a private 0600 file, not one env var | CARRIED (same sha) |
| 172 | a3d2f9a6d1 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): give dynamic tool callbacks their own 60 s deadline | CARRIED (same sha) |
| 173 | d988d56570 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): forward item.failed and carry Pi's provider error into turn/failed | CARRIED (same sha) |
| 174 | e5140628f3 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): reopen a fresh Pi after Stop or failure; an idle interrupt keeps Pi | CARRIED (same sha) |
| 175 | 513aa3b8b2 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): broker uses a 120 s byte-idle deadline, not a 10-minute total cut | CARRIED (same sha) |
| 176 | 005992c589 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): pass image input to Pi prompt and steer; refuse only that request | CARRIED (same sha) |
| 177 | f9ccad16ab | 2026-11-12 | smarty-fleet-write[bot] | Merge fl/pi-img2-fixes into cand/image2-recut (audit A: P0-5/6, P1-1/3/4/11/12) | CARRIED (same sha) |
| 178 | 3926657cf4 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): recover from oversized and invalid proxy stdout frames (B3) | CARRIED (same sha) |
| 179 | 7e1c91dece | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): bound deferred terminal settlement and release expired waiters (B5) | CARRIED (same sha) |
| 180 | 167323708d | 2026-11-12 | smarty-fleet-write[bot] | test(runner): Pi resident-attach fixture creates its proxy 0600 and admits it explicitly | CARRIED (same sha) |
| 181 | 9d9350de28 | 2026-11-12 | smarty-fleet-write[bot] | test(acpx): expect Pi max to pass through (cap is config) | CARRIED (same sha) |
| 182 | 9de0fdb90e | 2026-11-12 | smarty-fleet-write[bot] | test(server): expect Claude max to pass through (cap is config) | CARRIED (same sha) |
| 183 | cf3b14b5b6 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): retain terminals when completed-tail draining fails | CARRIED (same sha) |
| 184 | f66f921cea | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): give dynamic tool callbacks their own 60 s deadline | CARRIED (same sha) |
| 185 | ba9f498c11 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): report per-turn usage as the sum of its messages | CARRIED (same sha) |
| 186 | 76fb05c3b5 | 2026-11-12 | smarty-fleet-write[bot] | fix(native): keep an unreachable remote Runner alive when a failed run closes (#20923) | **CARRIED, probe bounded** (history: same sha; effect: see above) |
| 187 | 751688e7b5 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): reject an out-of-order controller command instead of exiting (#20946) | CARRIED (same sha) |
| 188 | ae4d9f8f7c | 2026-11-12 | smarty-fleet-write[bot] | fix(native): keep a remote Runner alive when a failed turn start or event stream closes the run (#21023) | CARRIED (same sha) |
| 189 | 39b3149783 | 2026-11-12 | smarty-fleet-write[bot] | fix(native): keep a live reattached Runner when its restart recovery read times out (#21053) | CARRIED (same sha) |
| 190 | 3bca64b756 | 2026-11-12 | smarty-fleet-write[bot] | fix(native): an agent termination Stop with no turn result stays a cancellation (#21093) | CARRIED (same sha) |
| 191 | c8cb04e31a | 2026-11-12 | smarty-fleet-write[bot] | Merge fl/upstream-native-keepalive-img2 (adopt upstream #20923 #20946 #21023 #21053 #21093) into cand/image2-recut | CARRIED (same sha) |
| 192 | 46c5e6510a | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): fail final output-limited turns after settlement | CARRIED (same sha) |
| 193 | 17b5d2e837 | 2026-11-12 | smarty-fleet-write[bot] | fix(native): keep an unreachable remote Runner alive when a failed run closes (#20923) | CARRIED (same sha) |
| 194 | 24d853b2eb | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): reject an out-of-order controller command instead of exiting (#20946) | CARRIED (same sha) |
| 195 | b075eaf695 | 2026-11-12 | smarty-fleet-write[bot] | fix(native): keep a remote Runner alive when a failed turn start or event stream closes the run (#21023) | CARRIED (same sha) |
| 196 | 91bd1c7767 | 2026-11-12 | smarty-fleet-write[bot] | fix(native): keep a live reattached Runner when its restart recovery read times out (#21053) | CARRIED (same sha) |
| 197 | 23caf041ad | 2026-11-12 | smarty-fleet-write[bot] | fix(native): an agent termination Stop with no turn result stays a cancellation (#21093) | CARRIED (same sha) |
| 198 | 0438e0e1a2 | 2026-11-12 | smarty-fleet-write[bot] | Merge sl/r9-fallback (R9 unbound subagent children + R10 clamp withdrawal) into cand/image2-recut | CARRIED (same sha) |
| 199 | aa5ca17992 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): route Pi dialogs through call-local runtime admission | CARRIED (same sha) |
| 200 | 4db4779c86 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): build the managed model entry from config and Pi's catalog on bind and rebind | CARRIED (same sha) |
| 201 | 14c2a34dec | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): bound prompt ACK waits and retire unknown acceptance | CARRIED (same sha) |
| 202 | ba4addf366 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): honor handled and queued prompt dispositions per turn | CARRIED (same sha) |
| 203 | e6598bc8e4 | 2026-11-12 | smarty-fleet-write[bot] | Fix image attachments in remote native workspaces (#20939) | CARRIED (same sha) |
| 204 | d58c638e44 | 2026-11-12 | smarty-fleet-write[bot] | Add turn-scoped attachment downloads to native Runner (#20956) | CARRIED (same sha) |
| 205 | b69dc18595 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): carry staged images into native Pi turns | CARRIED (same sha) |
| 206 | af3f4d692e | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): oversized text and tool arguments become marked previews, never session-fatal | CARRIED (same sha) |
| 207 | 877f146af6 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): subagent child thinking level passes through to Pi; record requested and effective | CARRIED (same sha) |
| 208 | c586827acc | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): large Pi records get a bounded display projection instead of killing the session | CARRIED (same sha) |
| 209 | fb2f818343 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): repin the native Pi RPC closure after the engines.node declaration | CARRIED (same sha) |
| 210 | a9735c44e6 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): Pi's native auto-retry continues the admitted turn | CARRIED (same sha) |
| 211 | 25e76df794 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi): withdraw the remaining hardcoded Claude thinking clamps (Paul: caps live in config) | CARRIED (same sha) |
| 212 | cc63dbf8ab | 2026-11-12 | smarty-fleet-write[bot] | Merge image-2 F7 and staged Pi attachments through one image path | CARRIED (same sha) |
| 213 | 95db0f475b | 2026-11-12 | smarty-fleet-write[bot] | Merge fl/pi-closure-pin (repin native Pi RPC closure after R5) into cand/image2-recut | CARRIED (same sha) |
| 214 | 80cbbd2fff | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): release turn-local identities at settlement so warm sessions never hit the cap | CARRIED (same sha) |
| 215 | a488ede450 | 2026-11-12 | smarty-fleet-write[bot] | Merge fl/img2-att-join (attachments adopted from upstream #20939/#20956 + Pi image path joined with F7) into cand/image2-recut | CARRIED (same sha) |
| 216 | 45164adbb3 | 2026-11-12 | smarty-fleet-write[bot] | ci(runner): materialize the native Pi RPC closure when its pin inputs change | CARRIED (same sha) |
| 217 | f03242ecca | 2026-11-12 | smarty-fleet-write[bot] | test(runner): bring native_provider_backend fixtures up to the product | CARRIED (same sha) |
| 218 | 6c722112db | 2026-11-12 | smarty-fleet-write[bot] | test(pi_rpc): commit full-server gate and public home fixture builder | CARRIED (same sha) |
| 219 | aa7d246182 | 2026-11-12 | smarty-fleet-write[bot] | test(pi_rpc): declare scripted faux model capabilities in the copied home | CARRIED (same sha) |
| 220 | b59cacd66c | 2026-11-12 | smarty-fleet-write[bot] | fix(ui): single post-sign-in navigation; re-fire root redirects per history entry | CARRIED (same sha) |
| 221 | cb5117db4a | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): admit the thinking level Pi applies when config lowers it; refuse only an escalation | CARRIED (same sha) |
| 222 | 9a1a23b4af | 2026-11-12 | smarty-fleet-write[bot] | Merge fl/ci-pi-closure-check (CI: materialize the Pi RPC closure on pin-input changes) into cand/image2-recut | CARRIED (same sha) |
| 223 | 2c71e40a20 | 2026-11-12 | smarty-fleet-write[bot] | fix(agents): keep a managed instructions bundle managed when a restarted volume-free server saves another setting (#20997) | CARRIED (same sha) |
| 224 | 3c11453778 | 2026-11-12 | smarty-fleet-write[bot] | test(agents): cover env-only managed bundle patches | CARRIED (same sha) |
| 225 | 33027266bb | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): preserve late tool receipts without retaining settled turns | CARRIED (same sha) |
| 226 | 0658f2fe9a | 2026-11-12 | smarty-fleet-write[bot] | Merge fl/bundle-mode-keep (adopt upstream #20997: env-only PATCH keeps managed instructions) into cand/image2-recut | CARRIED (same sha) |
| 227 | de01b90a18 | 2026-11-12 | Smarty Task Agent | fix(pi): preserve conversation history across Stop and cold reopen | CARRIED (same sha) |
| 228 | cae9ce8911 | 2026-11-12 | smarty-fleet-write[bot] | style(runner): rustfmt the Pi staged-image path checks | CARRIED (same sha) |
| 229 | 55cf68c351 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): read the sandbox user's ~/.pi/agent/models.json as a config source for the managed entry | CARRIED (same sha) |
| 230 | 033be06916 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): preserve thinking for unknown managed Pi models | CARRIED (same sha) |
| 231 | c0eb013df2 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): backpressure callback bursts and reserve lifecycle dispatch | CARRIED (same sha) |
| 232 | 1bdce6eebe | 2026-11-12 | smarty-fleet-write[bot] | feat(pi_rpc): default thinking = the highest level the model admits; accept the per-turn effort | CARRIED (same sha) |
| 233 | f297a67b7d | 2026-11-12 | smarty-fleet-write[bot] | Merge dl/img2-h10s (B3 oversized/invalid proxy stdout frames, B5 bounded deferred terminal) into cand/image2-recut | CARRIED (same sha) |
| 234 | 707343478e | 2026-11-12 | smarty-fleet-write[bot] | Merge dl/img2-h10u (B8 Pi usage receipt identity and cost) into cand/image2-recut | CARRIED (same sha) |
| 235 | 783f1ad90d | 2026-11-12 | smarty-fleet-write[bot] | Merge cl/image2-r8-b9 (R8 thinking default from catalog/config, B9 per-turn effort) into cand/image2-recut | CARRIED (same sha) |
| 236 | e2c1864298 | 2026-11-12 | smarty-fleet-write[bot] | test(acpx): Pi thinking passes through for every model (the Claude clamp was withdrawn) | CARRIED (same sha) |
| 237 | 5bea4a419f | 2026-11-12 | smarty-fleet-write[bot] | test(server): rung-4 agents-talk full-server Pi RPC E2E (assignment wake, blocked-child relay, manager steer) | CARRIED (same sha) |
| 238 | 7f23596b48 | 2026-11-12 | smarty-fleet-write[bot] | Merge asm13 Pi RPC fixes into image-2, preserving native policy and authority | CARRIED (same sha) |
| 239 | e7bd0259f0 | 2026-11-12 | smarty-fleet-write[bot] | Merge cand/image2-recut (B3/B5/B8, R8/B9, acpx pass-through tests) into the join | CARRIED (same sha) |
| 240 | 92892fb195 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): backpressure callback bursts and reserve lifecycle dispatch | CARRIED (same sha) |
| 241 | 0e52c6a91a | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): verify pi_rpc agents with the native Pi probe | CARRIED (same sha) |
| 242 | 5512b9cb89 | 2026-11-12 | smarty-fleet-write[bot] | test(runner): Pi resident-attach test reports why the runner refused to suspend | CARRIED (same sha) |
| 243 | 37c9d6ae34 | 2026-11-12 | smarty-fleet-write[bot] | Merge asm14 native Pi verification into joined image-2 | CARRIED (same sha) |
| 244 | 64957489e0 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): retire silent active turns on event-idle deadline (L15) | CARRIED (same sha) |
| 245 | 9d94be0c7a | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): an empty final answer with usage is not a completed turn | CARRIED (same sha) |
| 246 | 9c2e9f22f6 | 2026-11-12 | smarty-fleet-write[bot] | test(pi_rpc): the gate runs the stop-continue e2e and records each selected test hash | CARRIED (same sha) |
| 247 | c80e307412 | 2026-11-12 | smarty-fleet-write[bot] | Merge cand/image2-recut (attach close diagnostic 5512b9cb, test-only) into img2/next | CARRIED (same sha) |
| 248 | 34ae2e9c8f | 2026-11-12 | smarty-fleet-write[bot] | Merge dl/img1b-pp-asm15 (F5 empty-with-usage not completed; gate runs stop-continue e2e) into img2/next | CARRIED (same sha) |
| 249 | 5dacbe33c6 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): certify empty cleanup when no child runtime is loaded | CARRIED (same sha) |
| 250 | aa8fabbbf7 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): project compaction lifecycle and failed items (L17) | CARRIED (same sha) |
| 251 | 76a6b7d91b | 2026-11-12 | smarty-fleet-write[bot] | test(pi_rpc): boundary regressions from the architecture review | CARRIED (same sha) |
| 252 | 984d4fba6e | 2026-11-12 | smarty-fleet-write[bot] | Merge fl/pi-boundary-tests (architecture-review boundary regressions in-repo) into img2/next | CARRIED (same sha) |
| 253 | 3be555d098 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): back up and restore Pi's conversation transcript with the sandbox | CARRIED (same sha) |
| 254 | 7ea4a9a6fe | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): carry Pi's compat on the managed model entry (adaptive thinking + mid-conversation effort) | CARRIED (same sha) |
| 255 | 91f6715a69 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): preserve measured parent and child turn usage | CARRIED (same sha) |
| 256 | fbffe3fd70 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): back up and restore Pi's conversation transcript with the sandbox | CARRIED (same sha) |
| 257 | f06aa77326 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): carry Pi's compat on the managed model entry (adaptive thinking + mid-conversation effort) | CARRIED (same sha) |
| 258 | 5a7c02f85c | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): preserve measured parent and child turn usage | CARRIED (same sha) |
| 259 | 8d439f59f6 | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): pi_rpc sessions advertise steering; agent-authored steers resolve their responsible user | CARRIED (same sha) |
| 260 | 6aa1447274 | 2026-11-12 | smarty-fleet-write[bot] | Merge fv2/r4-full-server-e2e (pi_rpc steering advertised + rung-4 full-server E2E) into img2/next | CARRIED (same sha) |
| 261 | 76226cde01 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): idle deadline counts tool execution and keeps the conversation | CARRIED (same sha) |
| 262 | 2fac350922 | 2026-11-12 | smarty-fleet-write[bot] | Merge fl/pi-idle-events-2 (L15 idle deadline keeps the conversation, L17 compaction/failed-item mapping) into img2/next | CARRIED (same sha) |
| 263 | 223a1431c3 | 2026-11-12 | smarty-fleet-write[bot] | Merge dl/img2-j38 (transcript backup, Pi compat entry, measured usage) into img2/next | CARRIED (same sha) |
| 264 | 83405d6e93 | 2026-11-12 | smarty-fleet-write[bot] | Record dl/img1b-pp-asm16 as merged (ancestry gate): its 3 commits are in via j38's image-2 adaptations fbffe3fd/f06aa773/5a7c02f8 | CARRIED (same sha) |
| 265 | 25c87f76ca | 2026-11-12 | smarty-fleet-write[bot] | fix(server): extend environment sync worker RPC defaults | CARRIED (same sha) |
| 266 | d462eaf58e | 2026-11-12 | smarty-fleet-write[bot] | perf(heartbeat): reuse anonymous GitHub launchers on unchanged live leases | CARRIED (same sha) |
| 267 | 2320743afe | 2026-11-12 | smarty-fleet-write[bot] | fix(ui): keep Agent Chat tool steps after a reload (conversationOnly is never set in conversationMode) | CARRIED (same sha) |
| 268 | 3e86afebde | 2026-11-12 | smarty-fleet-write[bot] | perf(server): memoize immutable remote provider pack verification by lease | **CARRIED, adapted** (history: same sha; effect: see above) |
| 269 | a03c018c27 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): trust the root-owned immutable preinstalled pack's Pi and proxy | CARRIED (same sha) |
| 270 | ce12117b0b | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): a facade diagnostic carrying the pending command id is not a stale hello turn (M1) | CARRIED (same sha) |
| 271 | 79711f0b98 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): provider errors stay provider errors (D2) | CARRIED (same sha) |
| 272 | 84d38d521f | 2026-11-12 | smarty-fleet-write[bot] | fix(heartbeat): invalidate launcher receipt before failed restaging | CARRIED (same sha) |
| 273 | dba889dc8b | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): Paul's final answer is labelled final, not progress | CARRIED (same sha) |
| 274 | 5c69cc7c1f | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): test managed AI connections with the native Pi probe | CARRIED (same sha) |
| 275 | abd4d726b0 | 2026-11-12 | smarty-fleet-write[bot] | fix(server): probe native Pi through plugin runner tasks | CARRIED (same sha) |
| 276 | 78f5636a24 | 2026-11-12 | smarty-fleet-write[bot] | test(server): isolate native Pi hello from scripted model turns | CARRIED (same sha) |
| 277 | 12073d27a9 | 2026-11-12 | smarty-fleet-write[bot] | fix: drain compatible sandbox configuration changes after checkpoint | CARRIED (same sha) |
| 278 | 4087c9db9e | 2026-11-12 | smarty-fleet-write[bot] | perf(run-events): append a native event in one transaction of two statements (#21131) | CARRIED (same sha) |
| 279 | d00773126b | 2026-11-12 | smarty-fleet-write[bot] | fix(native): say what a Runner command waited behind when it times out (#21056) | CARRIED (same sha) |
| 280 | 75fcb05da7 | 2026-11-12 | smarty-fleet-write[bot] | test(ui): app-lead's corrected cold-remount regression test (no leaked transcript spy) | CARRIED (same sha) |
| 281 | 7568cd3412 | 2026-11-12 | smarty-fleet-write[bot] | perf: skip unchanged native workspace realization on held leases | CARRIED (same sha) |
| 282 | 0cd420b36a | 2026-11-12 | smarty-fleet-write[bot] | perf: retain preparation receipts through validated warm lease handoffs | CARRIED (same sha) |
| 283 | 8dd845b028 | 2026-11-12 | smarty-fleet-write[bot] | fix: retire stale preparation proofs before changing retained layouts | CARRIED (same sha) |
| 284 | 71ba436306 | 2026-11-12 | smarty-fleet-write[bot] | test: keep prepare receipts scoped across compatible-config drains | CARRIED (same sha) |
| 285 | 38c0b679b5 | 2026-11-12 | smarty-fleet-write[bot] | test: align compatible drain checkpoint fixture with image B Pi transcript profile | CARRIED (same sha) |
| 286 | c5391f0315 | 2026-11-12 | smarty-fleet-write[bot] | fix(native-runtime): stage only changed runtime context assets | CARRIED (same sha) |
| 287 | 34542ae7c2 | 2026-11-12 | smarty-fleet-write[bot] | fix(native-runtime): await runner identity publication events | CARRIED (same sha) |
| 288 | e09fec5a77 | 2026-11-12 | smarty-fleet-write[bot] | feat(ui): snooze and restore decisions in the Coordinator inbox | CARRIED (same sha) |
| 289 | 0b28daf0a1 | 2026-11-12 | smarty-fleet-write[bot] | fix(github): add explicit agent_env shell authentication mode | CARRIED (same sha) |
| 290 | 735a1d807f | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): reserve window-safe compaction headroom for managed sessions | CARRIED (same sha) |
| 291 | 7fa6b895fc | 2026-11-12 | smarty-fleet-write[bot] | fix(server): retain reusable warm sandboxes after ordinary failed turns | CARRIED (same sha) |
| 292 | a761afa113 | 2026-11-12 | smarty-fleet-write[bot] | fix(issues): a blocked/cancelled child's stop reaches the parent's assignee under STANDARD trust too (PATCH + native paths) | CARRIED (same sha) |
| 293 | c648a4148f | 2026-11-12 | smarty-fleet-write[bot] | fix(runner): isolate optional Node compile caches at launch | CARRIED (same sha) |
| 294 | 48ecb7b2f0 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): restore asm14 native setup probe (M1) | CARRIED (same sha) |
| 295 | 3b2cd89d3e | 2026-11-12 | smarty-fleet-write[bot] | fix(runnerd): survive EXDEV when replacing state files on Boat's lazy workspace mount | CARRIED (same sha) |
| 296 | 5c0ae6e121 | 2026-11-12 | smarty-fleet-write[bot] | test(server): a Pi chat reply that ends on final_answer is PUBLISHED, including when the same turn closes the issue | CARRIED (same sha) |
| 297 | 6b0d4fff85 | 2026-11-13 | smarty-fleet-write[bot] | fix(pi): preserve complete managed model image capabilities | CARRIED (same sha) |
| 298 | 02fe65b16c | 2026-11-13 | smarty-fleet-write[bot] | fix(pi): distinguish malformed plugin provider configuration from auth failure | CARRIED (same sha) |
| 299 | 8a00e09c5a | 2026-11-13 | smarty-fleet-write[bot] | test(cursor-cloud): expect runner-owned Node compile cache policy | CARRIED (same sha) |
| 300 | 0fe97a6fe1 | 2026-11-13 | smarty-fleet-write[bot] | fix(server): rename stale provider packs before detached cleanup | CARRIED (same sha) |
| 301 | 8a1266681a | 2026-11-13 | smarty-fleet-write[bot] | fix(mcp): resolve legacy header credentials through grants and fail closed | CARRIED (same sha) |
| 302 | 1ecabeae8f | 2026-11-13 | smarty-fleet-write[bot] | fix(server): bound warm retention after consecutive ordinary failures | CARRIED (same sha) |
| 303 | b630556170 | 2026-11-13 | smarty-fleet-write[bot] | fix(pi): fence managed model sampling routing and thinking overrides | CARRIED (same sha) |
| 304 | 1fc617023d | 2026-11-13 | smarty-fleet-write[bot] | test(server): gate Done/comment continuing Pi turns and post-failure reply | CARRIED (same sha) |
| 305 | b52a086180 | 2026-11-13 | smarty-fleet-write[bot] | fix(server): a board cancel keeps a warm sandbox running instead of forcing stop_and_retain | CARRIED (same sha) |
| 306 | 8419bb7c75 | 2026-11-13 | smarty-fleet-write[bot] | fix: keep assigned MCP tools after per-call denials | CARRIED (same sha) |
| 307 | b092164c57 | 2026-11-13 | smarty-fleet-write[bot] | test: assert physical warm reuse across strict Pi continuing turns | CARRIED (same sha) |
| 308 | e124fb156f | 2026-11-13 | smarty-fleet-write[bot] | fix: enforce subtree scopes for new agent configuration grants | CARRIED (same sha) |
| 309 | e9c563127e | 2026-11-13 | smarty-fleet-write[bot] | fix: close CEO permission and grant reconciliation scope bypasses | CARRIED (same sha) |
| 310 | a18d0e6286 | 2026-11-13 | smarty-fleet-write[bot] | tool access: agent-scoped installs serve only their agents (deny by default) | CARRIED (same sha) |
| 311 | b5e1cfa85d | 2026-11-13 | smarty-fleet-write[bot] | tool access: preserve audit context for install-scope denials | CARRIED (same sha) |
| 312 | 824673c2d3 | 2026-11-12 | smarty-fleet-write[bot] | Reduce native Pi cold preparation with sealed snapshot digest admission | **CARRIED, evolved on target** (history: same sha; effect: see above) |
| 313 | 96f0577665 | 2026-11-12 | smarty-fleet-write[bot] | Reuse Runner plugin capability checks (#20987) | CARRIED (same sha) |
| 314 | dfb7fd83b5 | 2026-11-12 | smarty-fleet-write[bot] | Reuse retained Runner descriptions during startup (#21004) | CARRIED (same sha) |
| 315 | d32c2c4416 | 2026-11-12 | smarty-fleet-write[bot] | fix(recovery): reconnect a live remote Runner with its admitted skills instead of re-downloading them (#21064) | CARRIED (same sha) |
| 316 | 4e90ff0189 | 2026-11-12 | smarty-fleet-write[bot] | perf(storage): hash and encrypt workspace snapshots off the server thread (#21138) | CARRIED (same sha) |
| 317 | 73d14f2375 | 2026-11-12 | smarty-fleet-write[bot] | fix(workspaces): verify existing worktrees before fresh retries (#20876) | CARRIED (same sha) |
| 318 | 7cb9ebd741 | 2026-11-12 | smarty-fleet-write[bot] | fix(environments): skip blank lease ID queries (#15200) | CARRIED (same sha) |
| 319 | a0dfb98f47 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): budget provider pack archive transfers | CARRIED (same sha) |
| 320 | 0e620a27d5 | 2026-11-13 | smarty-fleet-write[bot] | fix(runtime): stop never-started warm failures before continuation | CARRIED (same sha) |
| 321 | 06c68efbfc | 2026-11-13 | smarty-fleet-write[bot] | fix(server): a hired pi_rpc teammate inherits its native thinking level | CARRIED (same sha) |
| 322 | e14740ae55 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): write the conversation id at session open; other mint sites fail closed | CARRIED (same sha) |
| 323 | 6693f63c2e | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): an unverifiable legacy task-session pointer starts a recorded conversation instead of failing every turn | CARRIED (same sha) |
| 324 | 7f3f447770 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): narrow the legacy conversation id before adoption (server typecheck on image B) | CARRIED (same sha) |
| 325 | 0bc2718742 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): Stop and host interrupts abort the turn and keep Pi (the abort ladder) | CARRIED (same sha) |
| 326 | 3f50cf0849 | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): a Pi interrupt that settles before its RPC reply is success, not a lost race | CARRIED (same sha) |
| 327 | 38de367558 | 2026-11-12 | smarty-fleet-write[bot] | test(pi_rpc): reconcile abort-ladder fixtures with image B admission and warm reuse | CARRIED (same sha) |
| 328 | 0ad7ddc3ba | 2026-11-12 | smarty-fleet-write[bot] | feat(pi_rpc): recoverSession reopens the saved Pi conversation (driver method, like Codex/OpenCode) | CARRIED (same sha) |
| 329 | db6244eb1a | 2026-11-12 | smarty-fleet-write[bot] | fix(pi_rpc): a missing saved Pi file on a replaced box continues fresh instead of failing every message | CARRIED (same sha) |
| 330 | 30c7b4107d | 2026-11-13 | smarty-fleet-write[bot] | fix(pi_rpc): a restored Pi session reports its admitted model, so restart recovery is accepted | CARRIED (same sha) |
| 331 | 48dfaf645d | 2026-11-13 | smarty-fleet-write[bot] | fix(pi_rpc): a board Stop keeps the same Pi when the abort settles; an unverifiable legacy pointer says so once | CARRIED (same sha) |
| 332 | c9ce8c8b9a | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): bound provider trace rehydration work per pump | CARRIED (same sha) |
| 333 | 2aa93ea56e | 2026-11-13 | smarty-fleet-write[bot] | fix(server): never echo provider credentials from environment lease metadata | CARRIED (same sha) |
| 334 | cb24bb5c55 | 2026-11-13 | smarty-fleet-write[bot] | fix(run-dispatch): wake a pending card's addressee even when it is not the assignee | CARRIED (same sha) |
| 335 | e3ad07fef0 | 2026-11-13 | smarty-fleet-write[bot] | fix(runtime): carry optional Node cache policy through bootstrap launches | CARRIED (same sha) |
| 336 | 7b1afed3eb | 2026-11-13 | smarty-fleet-write[bot] | fix(pi_rpc): the first RPC to a new Pi process waits for its startup, not the 10 s admission bound | CARRIED (same sha) |
| 337 | 3b3b7219df | 2026-11-12 | smarty-fleet-write[bot] | feat(pi_rpc): 'Compact now' runs Pi's native compact on the same session | CARRIED (same sha) |
| 338 | b7e1da7977 | 2026-11-13 | smarty-fleet-write[bot] | test(pi_rpc): the first RPC to a new Pi process waits for startup; later admission RPCs keep 10 s | CARRIED (same sha) |
| 339 | 4dabd89508 | 2026-11-13 | smarty-fleet-write[bot] | fix(pi_rpc): the startup wait isn't cut short by the transport's 30 s deadline; closing the proxy aborts a pending open | CARRIED (same sha) |
| 340 | a65327ba04 | 2026-11-13 | pi-n1 task agent | fix(runtime): retain warm Pi after Stop in later conversation runs | CARRIED (same sha) |
| 341 | c289eedcec | 2026-11-13 | smarty-fleet-write[bot] | test(pi_rpc): a rotated 'latest' secret restarts Pi but keeps the conversation (full-server resume path) | CARRIED (same sha) |
| 342 | 6da2b6512e | 2026-11-13 | smarty-fleet-write[bot] | fix(review): a native reviewer's task context lists the issue's attachments with their stored sha256 | CARRIED (same sha) |
| 343 | e75fbd22bf | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): gate ingress startup and bound connect deadlines | CARRIED (same sha) |
| 344 | a50c09feb3 | 2026-11-13 | smarty-fleet-write[bot] | feat(connections): sign in to GitHub with your own GitHub App (port of upstream #15949) | CARRIED (same sha) |
| 345 | 53168845e3 | 2026-11-13 | smarty-fleet-write[bot] | fix(connections): detect a GitHub source from config or transport config in the direct OAuth callback | CARRIED (same sha) |
| 346 | 896c3fb272 | 2026-11-13 | smarty-fleet-write[bot] | Revert REG-12 e3ad07fe (forced NODE_DISABLE_COMPILE_CACHE env on every remote command) | CARRIED (same sha) |
| 347 | 6e2b86b2ae | 2026-11-13 | smarty-fleet-write[bot] | test(pi_rpc): the first get_state gets the startup bound; closing the proxy aborts a pending open | CARRIED (same sha) |
| 348 | d8725b4638 | 2026-11-13 | smarty-fleet-write[bot] | fix(pi_rpc): a Pi session whose close failed can be closed again, so one failed continuation no longer kills the chat | CARRIED (same sha) |
| 349 | 831f0dc712 | 2026-11-13 | smarty-fleet-write[bot] | fix(pi_rpc): a missing saved Pi file starts a visible fresh thread under the same conversation | CARRIED (same sha) |
| 350 | f25aa3834b | 2026-11-13 | smarty-fleet-write[bot] | test(pi_rpc): exercise cancelled sandbox lease successor recovery | CARRIED (same sha) |
| 351 | 8f533d2e1f | 2026-11-13 | smarty-fleet-write[bot] | fix(pi_rpc): recover quiescent stopped conversations on a new lease | CARRIED (same sha) |
| 352 | 21bdd4e5fc | 2026-11-13 | smarty-fleet-write[bot] | fix(ui): desktop chat's paused-agent notice no longer hides behind the composer dock | CARRIED (same sha) |
| 353 | 7d164711af | 2026-11-13 | smarty-fleet-write[bot] | fix(ui): Tasks search keeps every typed character | CARRIED (same sha) |
| 354 | 31814a0059 | 2026-11-13 | smarty-fleet-write[bot] | test(pi_rpc): the missing-file lifecycle e2e expects no idle resident to close under per_turn | CARRIED (same sha) |
| 355 | 171aaedfed | 2026-11-13 | smarty-fleet-write[bot] | Revert "fix(issues): a blocked/cancelled child's stop reaches the parent's assignee under STANDARD trust too (PATCH + native paths)" | CARRIED (same sha) |
| 356 | 20c1b282a7 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): relay a low-trust native child stop to the parent like the issue route does | CARRIED (same sha) |
| 357 | c9c1f35d31 | 2026-11-13 | smarty-fleet-write[bot] | fix: never reuse sandbox leases across boot-source changes | CARRIED (same sha) |
| 358 | fae8d6562f | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): keep Pi setup compile cache inside staging | CARRIED (same sha) |
| 359 | e38a7ceaf5 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): a stopped Boat sandbox fails fast as sandbox_stopped and is resumed once at command dispatch (REG-26) | CARRIED (same sha) |
| 360 | 4a4478d041 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): a warm runner is not reused after its sandbox restarted on resume (REG-26) | CARRIED (same sha) |
| 361 | 5662fafbae | 2026-11-13 | Smarty G-5b task agent | fix(pi_rpc): preserve invalid history and share scoped fresh-thread notices | CARRIED (same sha) |
| 362 | 7aeaca02cd | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): preserve managed GitHub launchers for Pi RPC | CARRIED (same sha) |
| 363 | 3e342e599b | 2026-11-13 | smarty-fleet-write[bot] | Bound provider pack staging failures | CARRIED (same sha) |
| 364 | 28a09f5b2b | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): only a provider-defined stopped state restarts warm reuse, and a stopped syncIn fails as sandbox_stopped (REG-26) | CARRIED (same sha) |
| 365 | 425fc3d478 | 2026-11-13 | smarty-fleet-write[bot] | test(pi_rpc): the invalid-file lifecycle e2e kills the resident only when one is kept | CARRIED (same sha) |
| 366 | 863b967493 | 2026-11-13 | Pi task agent (pi-midstop) | fix(pi_rpc): recover settled mid-turn stops after lease retirement | CARRIED (same sha) |
| 367 | 2cde43db3f | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): expose warm Pi RPC timings in run span events | CARRIED (same sha) |
| 368 | 3b45d16c7c | 2026-11-13 | smarty-fleet-write[bot] | fix(ui): open an attachment review target in the task's preview, not as a download | CARRIED (same sha) |
| 369 | 297f6be561 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): start pending interaction addressees with request context | CARRIED (same sha) |
| 370 | 8cf648e803 | 2026-11-13 | smarty-fleet-write[bot] | Revert "Bound provider pack staging failures" | CARRIED (same sha) |
| 371 | 5e05909c2b | 2026-11-13 | smarty-fleet-write[bot] | Revert "fix(native-runtime): only a provider-defined stopped state restarts warm reuse, and a stopped syncIn fails as sandbox_stopped (REG-26)" | CARRIED (same sha) |
| 372 | 6988292887 | 2026-11-13 | smarty-fleet-write[bot] | Revert "fix(native-runtime): a warm runner is not reused after its sandbox restarted on resume (REG-26)" | CARRIED (same sha) |
| 373 | 5d9949aea4 | 2026-11-13 | smarty-fleet-write[bot] | Revert "fix(native-runtime): a stopped Boat sandbox fails fast as sandbox_stopped and is resumed once at command dispatch (REG-26)" | **CARRIED, adapted** (history: same sha; effect: see above) |
| 374 | 75a69a0401 | 2026-11-13 | smarty-fleet-write[bot] | fix(costs): price gateway-prefixed Anthropic/OpenAI models on the built-in card | CARRIED (same sha) |
| 375 | 1e1db18d32 | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): log each ingress connect attempt failure and keep its cause | CARRIED (same sha) |
| 376 | 62836d7113 | 2026-11-13 | smarty-fleet-write[bot] | fix: settle agent status with idle retained leases | CARRIED (same sha) |
| 377 | 73daaaa3da | 2026-11-13 | Smarty task agent | fix(pi_rpc): keep history-loss notices in the lasting task transcript | CARRIED (same sha) |
| 378 | 2697c597c9 | 2026-11-13 | Smarty task agent | fix(runner): restore absent cold-resume files from the verified checkpoint | CARRIED (same sha) |
| 379 | cd0a978510 | 2026-11-13 | Smarty task agent (J3) | fix(native-runtime): retain raw Pi conversation evidence permanently | CARRIED (same sha) |
| 380 | f946f8f3d1 | 2026-11-13 | smarty-fleet-write[bot] | fix(native): an idle warm Pi chat reopens its runner ingress before suspend, or retires a lost owner and continues the same conversation | CARRIED, one line adapted (see above) |
| 381 | 5b9a1e826b | 2026-11-13 | smarty-fleet-write[bot] | fix: authorize scoped agent lifecycle management | CARRIED (same sha) |
| 382 | c7c35bbc86 | 2026-11-13 | smarty-fleet-write[bot] | fix(server): authorize scoped agent recovery and work | CARRIED (same sha) |
| 383 | 3eb65bb992 | 2026-11-13 | smarty-fleet-write[bot] | fix: delegate bounded budget and permission edits to reporting leads | CARRIED (same sha) |
| 384 | 88823b06ec | 2026-11-13 | smarty-fleet-write[bot] | test: expect the self-lifecycle guard for self-targeted denials | CARRIED (same sha) |
| 385 | bfebe872ff | 2026-11-13 | smarty-fleet-write[bot] | fix(auth): serialize descendant mutations with reporting-tree updates (R2) | CARRIED (same sha) |
| 386 | d5c17cc403 | 2026-11-13 | smarty-fleet-write[bot] | fix(approvals): require a board user to reject pending hires (R5) | CARRIED (same sha) |
| 387 | f1755f4395 | 2026-11-13 | smarty-fleet-write[bot] | fix: keep secret bookkeeping off warm runtime turns | CARRIED (same sha) |
| 388 | ed50262eb3 | 2026-11-13 | smarty-fleet-write[bot] | fix: audit every environment secret handoff and bound deferred writes | CARRIED (same sha) |
| 389 | 64777af814 | 2026-11-13 | smarty-fleet-write[bot] | fix(native): attribute controller waits during warm startup | CARRIED (same sha) |
| 390 | f939a91c30 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): a clean retained Pi Stop hands its runner checkpoint writer a fenced retained-idle authority (REG-30) | CARRIED (same sha) |
| 391 | d58b1a9ba3 | 2026-11-13 | smarty-fleet-write[bot] | Revert "feat(ui): snooze and restore decisions in the Coordinator inbox" | CARRIED (same sha) |
| 392 | 9fdec15776 | 2026-11-12 | smarty-fleet-write[bot] | perf(pi): reuse prepared admission and trace logical requests | CARRIED (same sha) |
| 393 | ab0edf3015 | 2026-11-13 | smarty-fleet-write[bot] | fix(wake-queue): a plugin-requested wake runs after a running same-issue turn instead of merging into it | CARRIED (same sha) |
| 394 | 32fdb5fed9 | 2026-11-13 | smarty-fleet-write[bot] | fix: redact credentials from environment probe responses | CARRIED (same sha) |
| 395 | 75b4e49293 | 2026-11-13 | Smarty task agent | fix(native): restrict retained-idle authority to checkpoint maintenance | **CARRIED, signature adapted** (history: same sha; effect: see above) |
| 396 | 783cd08626 | 2026-11-13 | smarty-fleet-write[bot] | fix(auth): enforce strict reporting-subtree lifecycle and work control | CARRIED (same sha) |
| 397 | 94d99d5e51 | 2026-11-13 | smarty-fleet-write[bot] | fix(pi-rpc): preserve message accounting across compaction | CARRIED (same sha) |
| 398 | f26353b8c6 | 2026-11-13 | paul | fix(accounting): retain measured Pi usage when a turn ends on a summary | CARRIED (same sha) |
| 399 | ecac1c1c06 | 2026-11-13 | Paul | fix(pi-rpc): preserve missing summary usage through run receipts | CARRIED (same sha) |
| 400 | 0c9debc3fb | 2026-11-13 | Paperclip | fix(accounting): preserve measured turn usage after incomplete terminal receipts | CARRIED (same sha) |
| 401 | c466ad5de1 | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): never log raw ingress transport prose; keep only a machine reason code | CARRIED (same sha) |
| 402 | f32b084792 | 2026-11-13 | smarty-fleet-write[bot] | fix: preserve deferred secret audits after reference deletion | CARRIED (same sha) |
| 403 | 6b56875ac9 | 2026-11-13 | smarty-fleet-write[bot] | Revert "fix(native-runtime): start pending interaction addressees with request context" | CARRIED (same sha) |
| 404 | 977ff69b38 | 2026-11-13 | Smarty task agent | fix(pi): recover idle conversations after runner state loss | CARRIED (same sha) |
| 405 | 19d285c51d | 2026-11-13 | Smarty task agent | test(pi): publish fresh-thread private recall after root recovery | CARRIED (same sha) |
| 406 | 4d8758e271 | 2026-11-13 | Smarty Pi task agent | fix(runner): re-read issue context after Pi history loss (product + proxy test; e2e hunks left on the F8 line) | CARRIED (same sha) |
| 407 | b1e0f55bff | 2026-11-13 | smarty-fleet-write[bot] | feat(native-runtime): remoteRunnerGenerationLost, the shared prior-owner-proven-gone predicate (helper only) | CARRIED (same sha) |
| 408 | 56bcb30e72 | 2026-11-13 | smarty-fleet-write[bot] | test(pi): scripted models read the native envelope after the recovery cold-start directive | CARRIED (same sha) |
| 409 | d2feae2918 | 2026-11-13 | smarty-fleet-write[bot] | fix: isolate deleted-company audits and bound failed batch retries | CARRIED (same sha) |
| 410 | 91e811ea9b | 2026-11-13 | smarty-fleet-write[bot] | test(wake-queue): five plugin wakes during one running turn give exactly one follow-up run | CARRIED (same sha) |
| 411 | eef1c8a850 | 2026-11-13 | smarty-fleet-write[bot] | fix(server): allowlist ingress diagnostics | CARRIED (same sha) |
| 412 | 7eec533a37 | 2026-11-13 | smarty-fleet-write[bot] | fix(server): keep failureCause on the execution-failure log line | CARRIED (same sha) |
| 413 | 6b4a5eef6d | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): batch Pi timing diagnostics after turn startup | CARRIED (same sha) |
| 414 | 8d1570b85e | 2026-11-13 | smarty-fleet-write[bot] | test(pi): match handled prompt spans to warm reattach admission | CARRIED (same sha) |
| 415 | 4aa2aafeeb | 2026-11-13 | smarty-fleet-write[bot] | test(pi): count the batched runner timing diagnostic separately from warm reattach's request instant | CARRIED (same sha) |
| 416 | a6dbffc4e2 | 2026-11-13 | smarty-fleet-write[bot] | fix(pi): bound idle timing retention and preserve every diagnostic span | CARRIED (same sha) |
| 417 | 785432ee22 | 2026-11-13 | smarty-fleet-write[bot] | fix(runtime): bound remote runner probes and reuse audited config | CARRIED (same sha) |
| 418 | 9c0a846d39 | 2026-11-13 | smarty-fleet-write[bot] | fix(runtime): poll remote runner liveness every 5 s | CARRIED (same sha) |
| 419 | fbcfdc14b4 | 2026-11-13 | smarty-fleet-write[bot] | fix(ui): preserve focused task search draft | CARRIED (same sha) |
| 420 | 0696522ba8 | 2026-11-13 | smarty-fleet-write[bot] | fix(ui): ignore stale search draft echoes | CARRIED (same sha) |
| 421 | d198a795ba | 2026-11-13 | Smarty task agent | fix(native): require affirmative pre-spawn proof before bypassing failed owner | CARRIED (same sha) |
| 422 | 70e591d0f9 | 2026-11-13 | Smarty task agent | fix(native): keep admitted failures without a checkpoint behind the same proof | CARRIED (same sha) |
| 423 | f691388d0d | 2026-11-13 | Smarty task agent | fix(pi): walk legacy identity only over affirmative pre-spawn failures | CARRIED (same sha) |
| 424 | 55c3748ec4 | 2026-11-13 | Smarty task agent | test(pi): prove legacy pre-spawn cold ladder and first context reads | CARRIED (same sha) |
| 425 | ad8a7602e6 | 2026-11-13 | Smarty task agent | gate failed native predecessors on exact generation loss or complete no-start proof | CARRIED (same sha) |
| 426 | ffb539cbe8 | 2026-11-13 | Smarty task agent | test(pi): exercise claimed terminal-complete legacy failures through the cold ladder | CARRIED (same sha) |
| 427 | 30bf975065 | 2026-11-13 | Smarty task agent | fix(native): ship the failed-predecessor gate with P2 only (P1 switch off) | CARRIED (same sha) |
| 428 | 79e3c25b67 | 2026-11-13 | smarty-fleet-write[bot] | fix(wake-payload): a plugin wake with no comment ids sets fallbackFetchNeeded so the follow-up reads the thread | CARRIED (same sha) |
| 429 | 6b41da4756 | 2026-11-13 | smarty-fleet-write[bot] | feat(native-runtime): remoteRunnerGenerationLost reads the provider's own record of the predecessor's sandbox (RFL ruling) | CARRIED (same sha) |
| 430 | 3f77b87bdc | 2026-11-13 | smarty-fleet-write[bot] | feat(plugin-sdk): optional stoppedAt, lastRebootAt and observedAt on PluginEnvironmentLeaseObservation | CARRIED (same sha) |
| 431 | 27bc907803 | 2026-11-13 | smarty-fleet-write[bot] | feat(environment-runtime): a fresh provider read of the predecessor's sandbox for the proven-gone predicate | CARRIED (same sha) |
| 432 | 4fe04e0e39 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): a provider-restarted sandbox retires its dead warm Runner by authority rotation and resumes the same conversation (REG-26) | CARRIED (same sha) |
| 433 | fa32571350 | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): a fresh Pi open over a restarted sandbox's dead Runner rotates the same proven-lost authority (REG-26) | CARRIED (same sha) |
| 434 | cd3d5964c4 | 2026-11-13 | smarty-fleet-write[bot] | test(native-pi): a fresh open after Core closed the warm Runner continues the same conversation (I-8j PRP identity, RED) | CARRIED (same sha) |
| 435 | b8cfb144a8 | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): a fresh Pi open after Core closed the warm Runner rotates its suspended authority (I-8j PRP identity) | CARRIED (same sha) |
| 436 | 82d7492fc7 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): carry the restarted-sandbox signal that the REG-26 owner retirement reads | CARRIED (same sha) |
| 437 | d78daabf12 | 2026-11-13 | smarty-fleet-write[bot] | test(native-pi): a fresh open never rotates a live owner whose close did not succeed (RFL F1 negative) | CARRIED (same sha) |
| 438 | f72aae6e41 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): a restarted label only triggers the check; retire the prior Runner only on proven process-generation loss (RFL F1) | CARRIED (same sha) |
| 439 | c20836dd69 | 2026-11-13 | smarty-fleet-write[bot] | test(native-pi): Clone L executor route: Core's idle close, then an idle or archived resume of the same box (skipped until idle5m) | CARRIED (same sha) |
| 440 | 7ea3f1ad75 | 2026-11-13 | smarty-fleet-write[bot] | test(native-runtime): restarted-sandbox follow-up admission proves the prior Runner's process generation is gone (RFL F1) | CARRIED (same sha) |
| 441 | d13e26cc53 | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): finish an interrupted external Pi open rotation on retry; never let a completed older epoch retire a newer owner (RFL F1) | CARRIED (same sha) |
| 442 | f5daaf8292 | 2026-11-13 | smarty-fleet-write[bot] | docs(native-runtime): a resume from a stopped state is a trigger, never proof that the machine restarted (RFL F4) | CARRIED (same sha) |
| 443 | 640d9eca33 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): the proven-gone predicate accepts only the neutral stopped state and strict ISO instants (helper check) | CARRIED (same sha) |
| 444 | ad253b7b72 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): the provider branch of the proven-gone predicate fails closed and probes only the predecessor's own box (RFL) | CARRIED (same sha) |
| 445 | f905d98f45 | 2026-11-13 | smarty-fleet-write[bot] | test(native-pi): the alive legs keep the live owner reachable; strict runner-state byte equality kept | CARRIED (same sha) |
| 446 | 76039d50af | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): publish deadline failures in the task thread | CARRIED (same sha) |
| 447 | 86e97ee4d2 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): retire proven-lost idle remote owners before warm reuse | CARRIED (same sha) |
| 448 | 58ee1b2e51 | 2026-11-13 | smarty-fleet-write[bot] | test(native-runtime): seed a valid reset conversation for deadline notice fences | CARRIED (same sha) |
| 449 | a4469a6e33 | 2026-11-13 | smarty-fleet-write[bot] | fix(github): webhook recovery admits automatic pull_request events (opened/synchronize/reopened/ready_for_review) | CARRIED (same sha) |
| 450 | 53fd4dba14 | 2026-11-13 | smarty-fleet-write[bot] | test(github): narrow pull_request fixtures in recovery integration tests (RFL F1: TS2339) | CARRIED (same sha) |
| 451 | c2bbf1519d | 2026-11-13 | smarty-fleet-write[bot] | fix(agent-chat): stop chat-reply deadlock with concurrent run writes | CARRIED (same sha) |
| 452 | b025b45ddd | 2026-11-13 | smarty-fleet-write[bot] | fix(native): park a response_wake with no admitted response instead of self-waking (upstream #20935, response_wake park only) | CARRIED (same sha) |
| 453 | ee22527c69 | 2026-11-13 | Smarty task agent | fix(native): keep the legacy history-loss notice typed and visible; a recorded process blocks no-start proof (RFL F1, F2) | CARRIED (same sha) |
| 454 | ae2ad81ad3 | 2026-11-13 | Smarty task agent | Skip lost-owner probes for connected resumed warm runners | CARRIED (same sha) |
| 455 | 6c33985542 | 2026-11-13 | Smarty task agent | Require fresh authenticated runner generation before skipping resume probes | CARRIED (same sha) |
| 456 | 1850e9980c | 2026-11-13 | Smarty task agent | test(native-runtime): the free-signal probe rows model a connected owner as fresh liveness from its generation | CARRIED (same sha) |
| 457 | bd71070e5a | 2026-11-13 | Smarty task agent | test(native-pi): the lease-change fixture forwards exactly the requested ingress path (honest preview proxy) | CARRIED (same sha) |
| 458 | d58ac77628 | 2026-11-13 | Smarty task agent | fix(native-pi): verify warm runner ownership over authenticated PRP | CARRIED (same sha) |
| 459 | bb50d7f2dc | 2026-11-13 | Smarty task agent | Fix fresh warm runner identity admission after native claim | CARRIED (same sha) |
| 460 | cdc956d46f | 2026-11-13 | Smarty task agent | chore: keep the builder working note out of the repository NOTE.md | CARRIED (same sha) |
| 461 | bd123070ff | 2026-11-13 | smarty-fleet-write[bot] | fix: retain sole-copy Pi setup and live eval raw evidence | CARRIED (same sha) |
| 462 | d35bd77549 | 2026-11-13 | smarty-fleet-write[bot] | fix: log retained runtime evidence and fail closed for every setup provider | CARRIED (same sha) |
| 463 | 831065a4de | 2026-11-13 | smarty-fleet-write[bot] | fix: bind setup cleanup and Pi context reads to their owners | CARRIED (same sha) |
| 464 | a78489ff6a | 2026-11-13 | smarty-fleet-write[bot] | fix: verify remote checkpoint completeness before cleanup | CARRIED (same sha) |
| 465 | cfea32683f | 2026-11-13 | smarty-fleet-write[bot] | fix: preserve local provider traces and detect raw Pi history | CARRIED (same sha) |
| 466 | beb4209fde | 2026-11-13 | smarty-fleet-write[bot] | fix: fsync retained native Pi evidence moves | CARRIED (same sha) |
| 467 | 0dd93dc36d | 2026-11-13 | smarty-fleet-write[bot] | fix: only a Pi session record marks renamed raw history; ordinary readable files are cleaned | CARRIED (same sha) |
| 468 | 7ec1852bfd | 2026-11-13 | smarty-fleet-write[bot] | fix: read classifier prefixes fully over short reads; strip a leading BOM | CARRIED (same sha) |
| 469 | 646cfb2d19 | 2026-11-13 | smarty-fleet-write[bot] | fix: exclude setup scopes from backup discovery | CARRIED (same sha) |
| 470 | cb95e7ebb3 | 2026-11-13 | smarty-fleet-write[bot] | test: scope finish observer to live transport | CARRIED (same sha) |
| 471 | ae42492d2f | 2026-11-13 | smarty-fleet-write[bot] | test: retain validated finish receipt snapshot | CARRIED (same sha) |
| 472 | dbc85fc8bf | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): one run-write lock order in the shared native helper; bounded retry at DB-only owners | CARRIED (same sha) |
| 473 | 4c31990ad0 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): receipt retry is an allowlist; withTransactionRetry refuses a tx-bound db | CARRIED (same sha) |
| 474 | a3c22fb7df | 2026-11-13 | Smarty task agent | docs(native-runtime): the warm-owner probe skip is a runner.identity answer, not inbound freshness (RFL) | CARRIED (same sha) |
| 475 | f8948ac84e | 2026-11-13 | Smarty task agent | docs(native-runtime): say what claimedStopCleanup means at the idle-owner check (fork-lead N2) | CARRIED (same sha) |
| 476 | c804fd7073 | 2026-11-13 | smarty-fleet-write[bot] | test: reproduce REG-03 Stop then archived same-box Pi resume | CARRIED (same sha) |
| 477 | d537d18d8b | 2026-11-13 | smarty-fleet-write[bot] | fix: reuse reviewed Stop owner retirement fence (1/3) | CARRIED (same sha) |
| 478 | ef023a0ab3 | 2026-11-13 | smarty-fleet-write[bot] | fix: reuse reviewed Stop owner retirement fence (2/3) | CARRIED (same sha) |
| 479 | 71475bcc25 | 2026-11-13 | smarty-fleet-write[bot] | fix: reuse reviewed Stop owner retirement fence (3/3) | CARRIED (same sha) |
| 480 | a7aec5eaae | 2026-11-13 | smarty-fleet-write[bot] | fix: hold recovery and never reuse a proven-lost warm Runner | CARRIED (same sha) |
| 481 | d77333b196 | 2026-11-13 | smarty-fleet-write[bot] | test: parameterize REG-03 delay after acknowledged Stop | CARRIED (same sha) |
| 482 | ceb8377420 | 2026-11-13 | smarty-fleet-write[bot] | fix: recover a clean user-Stopped retained Pi conversation | CARRIED (same sha) |
| 483 | bbff827441 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): a conversation held behind a dead failed predecessor is never a silent stuck loop (Clone L) | CARRIED (same sha) |
| 484 | 67115b9669 | 2026-11-13 | smarty-fleet-write[bot] | fix(chat): do not offer a message when a recovered chat's continuation was refused | CARRIED (same sha) |
| 485 | da24392e1e | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): pending Runner maintenance in a user-Stopped source is ignored only when its Runner is proven dead on the box | CARRIED (same sha) |
| 486 | 3ac5586264 | 2026-11-13 | smarty-fleet-write[bot] | test(native-runtime): Clone L, idle-loss and managed-instruction e2e; REG-03 through the real sandbox lifecycle | CARRIED (same sha) |
| 487 | 7c41cf631f | 2026-11-13 | smarty-fleet-write[bot] | fix: authorize tool assignments against current recipient deltas | CARRIED (same sha) |
| 488 | b2b61616d1 | 2026-11-13 | smarty-fleet-write[bot] | fix: isolate tool assignment effects and retain principal reach | CARRIED (same sha) |
| 489 | 207558db43 | 2026-11-13 | smarty-fleet-write[bot] | test: drain secret writes before tool fixture cleanup | CARRIED (same sha) |
| 490 | 92091d7db3 | 2026-11-13 | smarty-fleet-write[bot] | fix: keep tool assignments inside agent reporting subtrees | CARRIED (same sha) |
| 491 | 63ce3cd638 | 2026-11-13 | smarty-fleet-write[bot] | test(native-runtime): managed-instructions agents by default; the box archived under an idle warm owner (RED) | CARRIED (same sha) |
| 492 | 1a378760a0 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): a quarantined prior session or an unconfirmed Runner termination holds the conversation visibly | CARRIED (same sha) |
| 493 | ee1da6d8f1 | 2026-11-13 | Smarty task agent | docs(native-runtime): the warm-owner probe skip is a runner.identity answer, not inbound freshness (RFL) | CARRIED (same sha) |
| 494 | 3fdf14274d | 2026-11-13 | Smarty task agent | docs(native-runtime): say what claimedStopCleanup means at the idle-owner check (fork-lead N2) | CARRIED (same sha) |
| 495 | b5a11b410a | 2026-11-13 | Smarty task agent | fix(native): check managed warm owners during current-run preparation | CARRIED (same sha) |
| 496 | ba038e98e9 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): a warm attachment to an exited predecessor Runner holds visibly; REG-03 real-journal binding cases | CARRIED (same sha) |
| 497 | 9822e1d334 | 2026-11-13 | Smarty task agent | fix(native): check managed warm owners during current-run preparation | CARRIED (same sha) |
| 498 | 79ec5099f4 | 2026-11-13 | smarty-fleet-write[bot] | fix(chat): a recovered chat shows the held conversation's notice, from one wording | CARRIED (same sha) |
| 499 | 1ef926af60 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): one held notice per hold, deduplicated only against a notice that still stands | CARRIED (same sha) |
| 500 | 09b37e7e70 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): the legacy migration fence's prior-owner refusal also holds visibly (RFL F2) | CARRIED (same sha) |
| 501 | af069c5432 | 2026-11-13 | Smarty task agent | test(native-pi): declare the lost-owner path double marker read as a pinned expected value (smarty-code#3266) | CARRIED (same sha) |
| 502 | a58ba9b01f | 2026-11-13 | smarty-fleet-write[bot] | test(native-pi): declare the lost-owner path double marker read as a pinned expected value (smarty-code#3266) | CARRIED (same sha) |
| 503 | 1c51fbd135 | 2026-11-13 | smarty-fleet-write[bot] | fix(github recovery): treat deliveries with no HTTP status (null/0) as lost | CARRIED (same sha) |
| 504 | fddce5db8e | 2026-11-13 | smarty-fleet-write[bot] | fix(github recovery): a status-only list/detail change is transient; never cancel an admitted original | CARRIED (same sha) |
| 505 | 984750dae5 | 2026-11-13 | smarty-fleet-write[bot] | fix(github): decide webhook recovery from fresh delivery detail | CARRIED (same sha) |
| 506 | e36123e96a | 2026-11-13 | smarty-fleet-write[bot] | fix(github): defer time-based recovery states instead of tombstoning them | CARRIED (same sha) |
| 507 | c1862e4eb8 | 2026-11-13 | smarty-fleet-write[bot] | fix(github): deferred recovery reads do not consume the decision budget | CARRIED (same sha) |
| 508 | 03a22562ca | 2026-11-13 | smarty-fleet-write[bot] | Merge c-final-wip (a58ba9b0) into dev-lead's C7i c1862e4e | CARRIED (same sha) |
| 509 | 610f259b88 | 2026-11-13 | smarty-fleet-write[bot] | test(native): model terminal warm predecessor in REG-03 fixture | CARRIED (same sha) |
| 510 | 3950a80cfb | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): break the executor import cycle the banner's notice text introduced | CARRIED (same sha) |
| 511 | 1c99ce4432 | 2026-11-13 | smarty-fleet-write[bot] | fix(chat): every held refusal shows the notice, and a standing notice withholds Retry | CARRIED (same sha) |
| 512 | ad2371a7c9 | 2026-11-13 | smarty-fleet-write[bot] | fix: avoid parent lock in secret audit recovery | CARRIED (same sha) |
| 513 | 573b97d2df | 2026-11-13 | smarty-fleet-write[bot] | Merge upstream master ef2a49b6 into production C8 | **CARRIED, touched test declaration adapted** (history: same sha; effect: see above) |
| 514 | 95b94afcc5 | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): build the Pi thinking defaults from the Runner's own inputs | CARRIED (same sha) |
| 515 | 6b07269dc5 | 2026-11-13 | smarty-fleet-write[bot] | test(runner): give upstream's runner-upgrade attachment test our Pi launch profile field | CARRIED (same sha) |
| 516 | 7c0d1b098f | 2026-11-13 | smarty-fleet-write[bot] | test(adapter-utils): fail when the Runner's Pi thinking copy drifts | CARRIED (same sha) |
| 517 | f628df8f22 | 2026-11-13 | smarty-fleet-write[bot] | fix(server): name the Pi thinking catalog type at the runner shim | CARRIED (same sha) |
| 518 | 1fad83bcc5 | 2026-11-13 | smarty-fleet-write[bot] | fix(recovery): preserve response-wake park-only scope after merge | CARRIED (same sha) |
| 519 | 80152dbaa3 | 2026-11-13 | smarty-fleet-write[bot] | fix(recovery): use admission-safe recovered-work guidance | CARRIED (same sha) |
| 520 | acc11a9e31 | 2026-11-13 | smarty-fleet-write[bot] | test(recovery): reconcile safe recovery wording with held notices | CARRIED (same sha) |
| 521 | f090850461 | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): adopt native Pi without rebuilding launch profiles | CARRIED (same sha) |
| 522 | 56ddcfba3f | 2026-11-13 | smarty-fleet-write[bot] | test: keep the judge's single-provider restart adoption as a regression | CARRIED (same sha) |
| 523 | b4af3fc5ec | 2026-11-13 | Paperclip Agent | fix(runtime): verify remote runner exit on channel loss | CARRIED (same sha) |
| 524 | d49d4f3e22 | 2026-11-13 | smarty-fleet-write[bot] | fix: bound all lifecycle verification host failures | CARRIED (same sha) |
| 525 | 7a46ade419 | 2026-11-13 | smarty-fleet-write[bot] | fix: fence lifecycle startup by explicit stop markers | CARRIED (same sha) |
| 526 | cd874276ff | 2026-11-13 | smarty-fleet-write[bot] | fix: bound confirmed-absent sandbox creation recovery | CARRIED (same sha) |
| 527 | 672c3ec17c | 2026-11-13 | smarty-fleet-write[bot] | fix: back off and park stalled lifecycle stop work | CARRIED (same sha) |
| 528 | aa54a87507 | 2026-11-13 | smarty-fleet-write[bot] | fix: retain cleanup ownership after late creation evidence | CARRIED (same sha) |
| 529 | db280c079c | 2026-11-13 | smarty-fleet-write[bot] | fix: surface legacy parked Stop diagnostics during recovery | CARRIED (same sha) |
| 530 | d61693e1cb | 2026-11-13 | smarty-fleet-write[bot] | fix: remove automatic retry promise from Stop guidance | CARRIED (same sha) |
| 531 | 1df246fa48 | 2026-11-13 | smarty-fleet-write[bot] | fix: preserve late cleanup after creation key replacement | CARRIED (same sha) |
| 532 | f00086e01a | 2026-11-13 | smarty-fleet-write[bot] | test(native-pi): expect the merged restart-close result's failures list in the two e2e assertions | CARRIED (same sha) |
| 533 | db5af52bda | 2026-11-13 | smarty-fleet-write[bot] | fix(opencode): preserve gateway query, idle deadline and safe auth after merge | CARRIED (same sha) |
| 534 | e2c028e00c | 2026-11-13 | smarty-fleet-write[bot] | fix: recognize first-turn queued input when admitting questions | CARRIED (same sha) |
| 535 | 2fefb372cf | 2026-11-13 | smarty-fleet-write[bot] | fix(costs): add Claude Sonnet 5.5 and Fable 5.2 to the built-in Anthropic rate card | CARRIED (same sha) |
| 536 | 0964d52e62 | 2026-11-13 | smarty-fleet-write[bot] | fix(issues): enforce task access on live runs and feedback votes | CARRIED (same sha) |
| 537 | 6155608146 | 2026-11-13 | smarty-fleet-write[bot] | fix(environments): bound warm sandbox stop deadline by provider expiry | CARRIED (same sha) |
| 538 | 709a354ace | 2026-11-14 | Paperclip | fix(server): reuse preinstalled runnerd for Pi setup probes | CARRIED (same sha) |
| 539 | b6800e5c51 | 2026-11-13 | smarty-fleet-write[bot] | fix(recovery): the execution blocker follows a standing deadline notice (C9, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 540 | e06b6c7b4b | 2026-11-13 | smarty-fleet-write[bot] | fix(chat): the task card reads the standing notice; Retry only where a retry can work (C9 G1) | CARRIED (same sha) |
| 541 | 25cd83ca10 | 2026-11-13 | smarty-task-agent | fix(native-runtime): retry 40P01 at the workspace-operation, run/lease and run-event owners (smarty-dev#20454, #20455) | CARRIED (same sha) |
| 542 | cc008d0e0b | 2026-11-13 | smarty-fleet-write[bot] | fix(tasks): Coordinator Tasks search uses IssueSearchInput's draft (#20378) | CARRIED (same sha) |
| 543 | 047e6d4eb8 | 2026-11-13 | smarty-fleet-write[bot] | fix(workspaces): reject temporary roots and exclude archive staging | CARRIED (same sha) |
| 544 | 5a078d7024 | 2026-11-13 | Smarty task agent | fix(workspaces): validate referenced roots and preserve nested archive data | CARRIED (same sha) |
| 545 | ba56f268d4 | 2026-11-13 | Smarty task agent | fix(workspaces): resolve physical sources before root validation and sync | CARRIED (same sha) |
| 546 | d5be605025 | 2026-11-14 | Smarty task agent | test(workspaces): keep RFL's root and archive judges as regressions | CARRIED (same sha) |
| 547 | 0375473581 | 2026-11-13 | smarty-fleet-write[bot] | fix(wake-queue): stranded-queue recovery promotes a deferred plugin wake (stuck after a response_wake park) | CARRIED (same sha) |
| 548 | e592abf45c | 2026-11-13 | smarty-fleet-write[bot] | fix(wake-queue): plugin-wake recovery admits only a live plugin's own requestWakeup, once (RFL F1-F3) | CARRIED (same sha) |
| 549 | ae4580e202 | 2026-11-13 | smarty-fleet-write[bot] | test(wake-queue): F1-F3 regressions for plugin-wake recovery (missing/disabled/errored/company-disabled plugin cancelled; non-plugin or foreign-requester wake not promoted; same idempotency key coalesces) | CARRIED (same sha) |
| 550 | affe814dfb | 2026-11-13 | smarty-fleet-write[bot] | fix(wake-queue): check plugin wakes on the receipt the release consumes (RFL r4a2 F1/F3) | CARRIED (same sha) |
| 551 | 3930fabec4 | 2026-11-14 | smarty-fleet-write[bot] | test(wake-queue): type the judge fixture's plugin status (tsc only, no assertion change) | CARRIED (same sha) |
| 552 | 322d3bc3c7 | 2026-11-13 | smarty-fleet-write[bot] | fix(native-runtime): start pending interaction addressees with request context | CARRIED (same sha) |
| 553 | 6dd5474bd1 | 2026-11-13 | smarty-fleet-write[bot] | fix(server): authorize native addressed confirmation turns | CARRIED (same sha) |
| 554 | bc1eb523af | 2026-11-13 | smarty-fleet-write[bot] | fix(native): derive addressed-card staging from persisted origins | CARRIED (same sha) |
| 555 | 077797b74a | 2026-11-13 | smarty-fleet-write[bot] | fix(native): revalidate addressed staging across asynchronous work | CARRIED (same sha) |
| 556 | e9480e28f5 | 2026-11-13 | smarty-fleet-write[bot] | W1 F3 + F3-1 fix (unaudited; whole/delta audit pending 11-14) | CARRIED (same sha) |
| 557 | ce0a1df032 | 2026-11-13 | smarty-fleet-write[bot] | test(native): cover real addressed wake and card-owned staging | CARRIED (same sha) |
| 558 | a93e060eca | 2026-11-13 | smarty-fleet-write[bot] | fix(heartbeat): reuse the pending-card admission receipt on redelivery | CARRIED (same sha) |
| 559 | 4f537d5fe2 | 2026-11-14 | smarty-fleet-write[bot] | style(runner): cargo fmt the merged runner-core sources | CARRIED (same sha) |
| 560 | b1057f2ba9 | 2026-11-13 | Smarty task agent | fix(runner): a changed Pi runtime context refreshes the process instead of refusing the durable run | CARRIED (same sha) |
| 561 | 7230245aa7 | 2026-11-13 | Smarty task agent | fix: authorize native backup stamps from verified lease history | CARRIED (same sha) |
| 562 | 970ea2be2f | 2026-11-13 | Smarty task agent | fix(native-runtime): authorize only the newest backup stamp in the verified chain (RFL) | CARRIED (same sha) |
| 563 | 09350ae22e | 2026-11-13 | Smarty task agent | fix(native-runtime): choose the backup stamp by latest completedAt across the verified chain (RFL) | CARRIED (same sha) |
| 564 | 5de820a769 | 2026-11-14 | Smarty task agent | test(native-runtime): the owner-order case now proves latest-completedAt authorization; add the held counter-cases (RFL) | CARRIED (same sha) |
| 565 | d145450a21 | 2026-11-14 | Smarty task agent | test(native-runtime): a later stamp from a different runner instance keeps the backup held | CARRIED (same sha) |
| 566 | b07e3dcf3a | 2026-11-13 | smarty-fleet-write[bot] | fix(runnerd): keep every generation's launch evidence alongside the bounded stderr log | CARRIED (same sha) |
| 567 | 98be0b7322 | 2026-11-13 | smarty-fleet-write[bot] | fix(runnerd): re-read the launch identity through a plugin RPC stall without relaunching | CARRIED (same sha) |
| 568 | 6ff4ff07e0 | 2026-11-13 | smarty-fleet-write[bot] | test(runner): load the producer tree hash from upstream's extracted helper | CARRIED (same sha) |
| 569 | 3b6ec2199e | 2026-11-13 | smarty-fleet-write[bot] | test(native-runtime): hold the restarted-sandbox owner refusals through upstream's fresh-sandbox fallback | CARRIED (same sha) |
| 570 | 85f157fad6 | 2026-11-14 | smarty-fleet-write[bot] | fix(runnerd): keep each generation's whole stderr in its own file beside the trimmed shared log | CARRIED (same sha) |
| 571 | 4f1ed9afc1 | 2026-11-13 | smarty-fleet-write[bot] | How Paperclip intends it: reattach_remote_runner authorizes reconnection only to the claimed remote Runner (server/src/services/native-runtime/native-restart-recovery.ts:95-107; doc/execution-semantics.md:3594-3606). The lease system records replacement and its predecessor/kept-replacement relationship (doc/execution-semantics.md:1470-1488; server/src/services/environment-runtime.ts:2259-2260,2318-2327; server/src/services/reusable-sandbox-resume-replacement.ts:223-239). Once those records prove the claimed provider lease was replaced, abandon reattachment; keep the normal cold restore for conversations and bootstrap the verification run once. | CARRIED (same sha) |
| 572 | 54b53598e1 | 2026-11-14 | smarty-fleet-write[bot] | Keep remote restart claim fenced on cold fallback | CARRIED (same sha) |
| 573 | af5418fc01 | 2026-11-14 | smarty-fleet-write[bot] | test(runnerd): fail before exec when generation stderr cannot open | CARRIED (same sha) |
| 574 | 64cb83d4f7 | 2026-11-13 | Smarty task agent | fix(runner): a new run over settled durable state adopts its own completion contract | CARRIED (same sha) |
| 575 | dbb7f64080 | 2026-11-14 | Smarty task agent | fix(runner): attach settled legacy state and refresh reopened Pi runs | CARRIED (same sha) |
| 576 | 5b069059eb | 2026-11-13 | Paperclip | fix: accept runner ingress independently of connect ticks | CARRIED (same sha) |
| 577 | 828964d763 | 2026-11-13 | Paperclip | fix: admit runner controllers through replenished ingress backlogs | CARRIED (same sha) |
| 578 | 8f7cc598a2 | 2026-11-14 | Paperclip | fix: protect authenticated runner listener before response send | CARRIED (same sha) |
| 579 | 4f6ea16318 | 2026-11-13 | smarty-fleet-write[bot] | fix(recovery): a person's message that nothing answers gets one visible notice (C9, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 580 | 8957fcde1d | 2026-11-13 | smarty-fleet-write[bot] | fix(recovery): the unanswered-message notice is quiet when the agent answered with a card, an approval wait or a declared blocker (C9, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 581 | 94b13e1af0 | 2026-11-13 | smarty-fleet-write[bot] | test(e2e): Clone L idle-archived checks C9's notice for the failed first message (Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 582 | 1b9ce5fcef | 2026-11-13 | smarty-fleet-write[bot] | fix(recovery): the unanswered-message notice is decided under the issue fence, uses Paperclip's per-turn response rule, and fits the sweep's query budget (C9, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 583 | 5ceb031195 | 2026-11-13 | smarty-fleet-write[bot] | test(recovery): RFL's independent unanswered-message safety judge (verbatim) (C9, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 584 | 4abf179651 | 2026-11-13 | smarty-fleet-write[bot] | test(e2e): C9 G2 real-runner row: the first real refusal after a committed good turn gets one visible notice (Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 585 | aa841fc815 | 2026-11-13 | smarty-fleet-write[bot] | test(chat): app-lead's v2 chat render test for the C9 unanswered-message notice, byte-unchanged (C9, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 586 | 5e197a32ed | 2026-11-13 | smarty-fleet-write[bot] | fix(recovery): the fenced recheck is the same predicate, and only the message's own failed wake takes the fast path (B' for M1, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 587 | de94fae59b | 2026-11-13 | smarty-fleet-write[bot] | fix(recovery): attribute an answer by what the run carried, and a declared blocker counts only when published (B' for M1, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 588 | cfc5bd2406 | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): deferring to the native repair is bounded by a durable T0, and an open obligation never ages out of scope (B' for M1, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 589 | f9f70f1086 | 2026-11-14 | Smarty task agent | test(runner): an open issue's next comment after a lost warm entry or a skill change prepares cold and answers | CARRIED (same sha) |
| 590 | 595027ffd9 | 2026-11-14 | smarty-fleet-write[bot] | test(runner): cover turn-start attachment retention | CARRIED (same sha) |
| 591 | 807f2db197 | 2026-11-13 | smarty-fleet-write[bot] | fix(runner): reacquire same-box ingress after connection failures | CARRIED (same sha) |
| 592 | f6ac2442d9 | 2026-11-14 | smarty-fleet-write[bot] | fix(server): count ingress dials and fence expired lease refreshes | CARRIED (same sha) |
| 593 | 0b046bf260 | 2026-11-14 | smarty-fleet-write[bot] | fix(server): compare jittered ingress spacing with remaining budget | CARRIED (same sha) |
| 594 | c1dea0db25 | 2026-11-14 | smarty-fleet-write[bot] | fix: retain stale-state fence diagnostics per generation | CARRIED (same sha) |
| 595 | 8beca96009 | 2026-11-14 | smarty-fleet-write[bot] | fix(runner): bound adopted supervision and invalidate probe config on writes | CARRIED (same sha) |
| 596 | 43967addbf | 2026-11-14 | smarty-fleet-write[bot] | test(server): support transactions in delayed environment write fixture | CARRIED (same sha) |
| 597 | cbdb950f41 | 2026-11-14 | Paperclip agent | fix(runner): coalesce adopted process verification wakes | CARRIED (same sha) |
| 598 | eb4cf32621 | 2026-11-14 | Paperclip agent | test(runner): keep RFL's adopted-watcher judges as regressions | CARRIED (same sha) |
| 599 | 4267bc813e | 2026-11-14 | smarty-fleet-write[bot] | test: wait for quiet local work before the quiet-plugin assertion | CARRIED (same sha) |
| 600 | 412ae46ddb | 2026-11-14 | smarty-fleet-write[bot] | fix: preserve assigned work while an in-flight pause resumes | CARRIED (same sha) |
| 601 | 950112c288 | 2026-11-14 | smarty-fleet-write[bot] | fix: stage sandbox runtime assets concurrently | CARRIED (same sha) |
| 602 | f961185747 | 2026-11-14 | smarty-fleet-write[bot] | test: type the concurrent staging mock with vi.mocked (tsc TS2339/TS7031) | CARRIED (same sha) |
| 603 | d2ed3899a0 | 2026-11-14 | Paperclip task agent | fix: copy preinstalled runnerd for strict setup cleanup | CARRIED (same sha) |
| 604 | ed363276b1 | 2026-11-14 | smarty-fleet-write[bot] | Fix retained native transport diagnostic ownership on warm reuse | CARRIED (same sha) |
| 605 | 2f907bb98d | 2026-11-14 | smarty-fleet-write[bot] | Preserve native transport diagnostic output streams on warm reuse | CARRIED (same sha) |
| 606 | 3a6eb8679a | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): every wait for a further attempt is bounded by a durable T0, except a turn in progress (B' M1.1, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 607 | a94b1852b4 | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): only a running turn waits unbounded; a queued run that carries the message gets a "waiting to start" note after the bound (B' M1.1, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 608 | cde7aea6cc | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): the waiting note stays true: after 10 min the same note becomes the failure text, and it carries no failure code (B' M1.1, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 609 | 9f7b40448b | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): the execution banner never names a Retry the person cannot press (upstream #21348 copy) | CARRIED (same sha) |
| 610 | fa62e64983 | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): when Retry is not offered the banner names the new-task action, never "send a message" (upstream #21348 copy) | CARRIED (same sha) |
| 611 | 74c768a6ed | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): a deadline notice with Retry not offered never lets a stored Retry instruction reach the banner (B' M1.1 restack, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 612 | 9775a54305 | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): the deadline-notice test reads the recovered-work Retry text from its source constant | CARRIED (same sha) |
| 613 | 7d2c547961 | 2026-11-14 | smarty-fleet-write[bot] | Fix plugin job invocation isolation from event notifications | CARRIED (same sha) |
| 614 | 19c873f27a | 2026-11-14 | Smarty task agent | fix(runner): a reopened finished task's next run prepares on a resumed box | CARRIED (same sha) |
| 615 | 89374fee5c | 2026-11-14 | Smarty task agent | test(runner): reproduce preparation after idle suspension | CARRIED (same sha) |
| 616 | 1bbf9f6087 | 2026-11-14 | Smarty task agent | fix(runner): a reopened task prepares over a suspended runner state | CARRIED (same sha) |
| 617 | 027e8ed913 | 2026-11-14 | Smarty task agent | fix(runner): preserve replay coverage for Pi agent-home rebinding | CARRIED (same sha) |
| 618 | cd7e0f0032 | 2026-11-14 | smarty-fleet-write[bot] | fix: retry complete runtime MCP preparation on lock contention | CARRIED (same sha) |
| 619 | 1275bce5eb | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): stop refused fresh continuations and bound their source chain | CARRIED (same sha) |
| 620 | 5b5897b34d | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): reset person-turn fallback budget and explain terminal successor | CARRIED (same sha) |
| 621 | 7599a9d46a | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): cover immediately resolved watchdog fallback chains | CARRIED (same sha) |
| 622 | 4bb64997b1 | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): a paused agent's chat gets a note that says it is paused and who can resume it, never "sending again is safe" (B' M1.1, Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 623 | 878abba19e | 2026-11-14 | Smarty task agent | fix: queue controller upgrades until listener admission is free | CARRIED (same sha) |
| 624 | 1da71d1fcf | 2026-11-14 | smarty-fleet-write[bot] | test(judge): RFL listener503 judge harness + verdict (F1/F2), for the fix | CARRIED (same sha) |
| 625 | b0de8ed641 | 2026-11-14 | Task Agent | fix(runner): drop disconnected listener waiters | CARRIED (same sha) |
| 626 | 46540914d6 | 2026-11-14 | Paperclip Task Agent | test(runner): cover abandoned upgrade floods | CARRIED (same sha) |
| 627 | 144f4bed23 | 2026-11-14 | smarty-fleet-write[bot] | test(runner): flood-first ordering for the abandoned-upgrade regression (RFL correction) | CARRIED (same sha) |
| 628 | 372ee151a1 | 2026-11-13 | Dotta | perf(workspaces): inspect only hinted workspaces after a scoped commit (#21519) | CARRIED (same sha) |
| 629 | 176de6f67b | 2026-11-14 | smarty-fleet-write[bot] | fix(workspaces): keep terminal inspection backoff for the whole candidate rotation | CARRIED (same sha) |
| 630 | 476cee46b4 | 2026-11-14 | Smarty task agent | fix(agents): working-copy cleanup stops retrying when its source is gone | CARRIED (same sha) |
| 631 | b1cd4d8c41 | 2026-11-13 | smarty-fleet-write[bot] | fix: make recovery Try again atomic | CARRIED (same sha) |
| 632 | 99ca0d5b16 | 2026-11-14 | smarty-fleet-write[bot] | fix: persist recovery Try again refusal | CARRIED (same sha) |
| 633 | 5e33a92e67 | 2026-11-14 | smarty-fleet-write[bot] | fix: refresh stale Try again recovery card | CARRIED (same sha) |
| 634 | 21bc6d57a4 | 2026-11-14 | smarty-fleet-write[bot] | Fix stale-run Try again from refreshed recovery card | CARRIED (same sha) |
| 635 | 989673fcfa | 2026-11-14 | smarty-fleet-write[bot] | fix: refresh stale Try again evidence without side effects | CARRIED (same sha) |
| 636 | 2ea009578e | 2026-11-14 | smarty-fleet-write[bot] | fix(ui): show the refreshed Try again recovery card after a reload | CARRIED (same sha) |
| 637 | 725e57b7e9 | 2026-11-14 | smarty-fleet-write[bot] | test: run try-again judge probes without evidence env | CARRIED (same sha) |
| 638 | a37b8ff56b | 2026-11-14 | Smarty task agent | fix(db): make the working-copy receipt index migration idempotent | CARRIED (same sha) |
| 639 | d3d1076f00 | 2026-11-14 | smarty-fleet-write[bot] | Revert "fix(db): make the working-copy receipt index migration idempotent" | CARRIED (same sha) |
| 640 | 560bf15e8a | 2026-11-14 | smarty-fleet-write[bot] | Revert "fix(agents): working-copy cleanup stops retrying when its source is gone" | **CARRIED, adapted** (history: same sha; effect: see above) |
| 641 | 4d30b7f17a | 2026-11-14 | smarty-fleet-write[bot] | Fix configured-company access inside plugin job invocations | CARRIED (same sha) |
| 642 | 1fd66ec30d | 2026-11-14 | smarty-fleet-write[bot] | feat(adapter-utils): let the execution target set the callback bridge poll interval | CARRIED (same sha) |
| 643 | 8636812729 | 2026-11-14 | Task Agent | fix(ui): contain inbox menus and phone headers | CARRIED (same sha) |
| 644 | 6fdc212fcc | 2026-11-14 | smarty-fleet-write[bot] | fix(runner): refresh settled Codex instructions across runs | CARRIED (same sha) |
| 645 | a3f3cd08aa | 2026-11-14 | smarty-fleet-write[bot] | fix(runner): adopt edited instructions before the first thread | CARRIED (same sha) |
| 646 | ba5668519f | 2026-11-14 | smarty-fleet-write[bot] | test: hide refused task retry | CARRIED (same sha) |
| 647 | 97bd1044e4 | 2026-11-14 | smarty-fleet-write[bot] | fix(ui): respect refused continuation retry eligibility | CARRIED (same sha) |
| 648 | 91d774b002 | 2026-11-14 | smarty-fleet-write[bot] | test(server): reproduce refused addressed-card terminal and reason lifecycle | CARRIED (same sha) |
| 649 | 7f3f81ad6e | 2026-11-14 | smarty-fleet-write[bot] | fix(server): report refused addressed cards once per captured reason | CARRIED (same sha) |
| 650 | da3951be3d | 2026-11-14 | Dotta | fix(instructions): back off working copies that cannot make progress (#21586) | **CARRIED, extended** (history: same sha; effect: see above) |
| 651 | 0bafa1954e | 2026-11-14 | Task Agent | test: do not overlap a timed-out plugin job whose worker is still alive | CARRIED (same sha) |
| 652 | d1f9ead32d | 2026-11-14 | Task Agent | fix: restart a plugin worker whose job timed out before settling the run | CARRIED (same sha) |
| 653 | 6152b2425c | 2026-11-14 | smarty-fleet-write[bot] | fix(lifecycle): prioritize agent resumes in worker sweep | CARRIED (same sha) |
| 654 | 592ad029f0 | 2026-11-14 | smarty-fleet-write[bot] | fix(lifecycle): prioritize only resumes that return to ready | CARRIED (same sha) |
| 655 | a656eb1a7b | 2026-11-14 | smarty-fleet-write[bot] | test(server): pin current-document admission and durable addressed decisions | CARRIED (same sha) |
| 656 | 969aee77a7 | 2026-11-14 | smarty-fleet-write[bot] | test(server): make the missing-document refusal fixture schema-valid | CARRIED (same sha) |
| 657 | bede7b78d6 | 2026-11-14 | smarty-fleet-write[bot] | fix(server): admit current document cards and retain recorded response settlement | CARRIED (same sha) |
| 658 | ef36f7a7af | 2026-11-14 | smarty-fleet-write[bot] | test: reproduce stale plugin company authority across hosts | CARRIED (same sha) |
| 659 | e16f72cadf | 2026-11-14 | smarty-fleet-write[bot] | fix: verify plugin job company authority against stored configuration | CARRIED (same sha) |
| 660 | 252cb03397 | 2026-11-14 | smarty-fleet-write[bot] | fix(plugins): replay stored company config after worker respawn | CARRIED (same sha) |
| 661 | cb5f995c62 | 2026-11-14 | smarty-fleet-write[bot] | fix(plugins): fence config replay by revision and worker generation | CARRIED (same sha) |
| 662 | cc00c49b1d | 2026-11-14 | smarty-fleet-write[bot] | test(plugins): apply RFL's 07:35Z config replay ruling | CARRIED (same sha) |
| 663 | 86eb204aff | 2026-11-14 | smarty-fleet-write[bot] | test(plugins): preserve unchanged RFL round 2 regressions | CARRIED (same sha) |
| 664 | 1107591f73 | 2026-11-14 | smarty-fleet-write[bot] | fix(plugins): bound pending company config deliveries | CARRIED (same sha) |
| 665 | 0ce7bb431b | 2026-11-14 | smarty-fleet-write[bot] | test: apply F1 settlement property per RFL 09:08Z ruling | CARRIED (same sha) |
| 666 | d6c4d8f1fc | 2026-11-14 | smarty-fleet-write[bot] | test: bound F2 observations per RFL 09:08Z ruling | CARRIED (same sha) |
| 667 | c829e38035 | 2026-11-14 | smarty-fleet-write[bot] | fix(plugins): fence config settlement and retire timed-out workers | CARRIED (same sha) |
| 668 | c67d32de8a | 2026-11-14 | app-lead turn-steps r2 | fix(task-chat): let More run output reach every saved turn's steps in one click | CARRIED (same sha) |
| 669 | 5221b95aef | 2026-11-14 | Smarty task agent | fix(native): a positively pre-dispatch failure is not a resume barrier | **CARRIED** (history: same sha; effect: see above) |
| 670 | a2cc002998 | 2026-11-14 | Smarty task agent | docs(native): correct the run-failure-cause comment | CARRIED (same sha) |
| 671 | d003cc26d5 | 2026-11-14 | smarty-fleet-write[bot] | test: expose silent addressed review-verdict provider failures | CARRIED (same sha) |
| 672 | e835a0028e | 2026-11-14 | smarty-fleet-write[bot] | fix: report addressed review-verdict provider failures to the card owner | CARRIED (same sha) |
| 673 | a5782b1b25 | 2026-11-14 | smarty-fleet-write[bot] | test(adapter-utils): RED: callback bridge must pause when its run is released | CARRIED (same sha) |
| 674 | a6f3248198 | 2026-11-14 | smarty-fleet-write[bot] | fix(adapter-utils,native-runtime): pause the callback bridge when no run is attached | CARRIED (same sha) |
| 675 | 3cd33586b6 | 2026-11-14 | smarty-fleet-write[bot] | fix(native-runtime): bind queued bridge requests to run generation | CARRIED (same sha) |
| 676 | 800ea66b2c | 2026-11-14 | smarty-fleet-write[bot] | fix(native-runtime): fence github bridge generations across transports | CARRIED (same sha) |
| 677 | ee7d6f0add | 2026-11-14 | smarty-fleet-write[bot] | fix(adapter-utils): preserve ordinary file bridge availability | CARRIED (same sha) |
| 678 | cbca811637 | 2026-11-14 | Task Agent | feat(ui): add opt-in inline task reasoning | CARRIED (same sha) |
| 679 | 176496803d | 2026-11-14 | Smarty Task Agent | How Paperclip intends it: extend transcriptPresentation.liveReasoningView in ui/src/adapters/types.ts, following its registry-resolved use in IssueChatThread.tsx:1287-1294 | CARRIED (same sha) |
| 680 | e5da283e1f | 2026-11-14 | Smarty Task Agent | test(ui): assert inline reasoning is visible in the live phase | CARRIED (same sha) |
| 681 | 1f01cd923e | 2026-11-14 | Task Agent | How Paperclip intends it: consume adapter reasoning view in task chat | CARRIED (same sha) |
| 682 | 6fb91ae552 | 2026-11-14 | Task Agent | How Paperclip intends it: hand the resolved reasoning display to the native turn renderer | CARRIED (same sha) |
| 683 | 98ca50896d | 2026-11-14 | smarty-fleet-write[bot] | test(pi): reproduce core tool loss in d981's 151-tool catalog (RED) | CARRIED (same sha) |
| 684 | 1aefbac748 | 2026-11-14 | smarty-fleet-write[bot] | fix(pi): preserve all Messages tools and budget Chat by measured total | CARRIED (same sha) |
| 685 | 79d41cdf64 | 2026-11-14 | smarty-fleet-write[bot] | test(pi): freeze delivered catalog regression for 200 connections (RED) | CARRIED (same sha) |
| 686 | 1761d28792 | 2026-11-14 | smarty-fleet-write[bot] | fix(pi): register measured Chat selection and retain bounded failure causes | CARRIED (same sha) |
| 687 | 0eef1900d8 | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): preserve imported work during its safety pause | CARRIED (same sha) |
| 688 | bd4ee4d061 | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): retain import pause admission race regressions | CARRIED (same sha) |
| 689 | 00f47b5a1a | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): fence initial import admission under the issue lock | CARRIED (same sha) |
| 690 | 034dcecc5d | 2026-11-14 | smarty-fleet-write[bot] | test: use exact RFL 09:07Z import-pause peer helper | CARRIED (same sha) |
| 691 | a688254bbc | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): reproduce imported blocked task admission on resume | CARRIED (same sha) |
| 692 | ef30505ddd | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): preserve imported waits during resume admission | CARRIED (same sha) |
| 693 | e140fc8079 | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): retain unchanged RFL lock-door acceptance | CARRIED (same sha) |
| 694 | 3e63982072 | 2026-11-14 | smarty-fleet-write[bot] | test(import): verify paused monitor PATCH and process Stop fencing | CARRIED (same sha) |
| 695 | 43fdbb90c4 | 2026-11-14 | app-lead task agent | fix(ui): a docked pending card on a phone scrolls inside itself and keeps Send on screen | CARRIED (same sha) |
| 696 | 043a9ef27c | 2026-11-14 | app-lead task agent | How Paperclip intends it: on a phone the docked card gets only the height the composer leaves free | CARRIED (same sha) |
| 697 | 9edb70e252 | 2026-11-14 | smarty-fleet-write[bot] | fix: recovery continuations carry the parent's wake comments | CARRIED (same sha) |
| 698 | 33ba066d85 | 2026-11-14 | Smarty task agent | test(runner): import fork-lead unsafe skill-refresh REDs unchanged | CARRIED (same sha) |
| 699 | 2f279dee3b | 2026-11-14 | Smarty task agent | fix(runner): carry decision-neutral specific prepare refusal codes | CARRIED (same sha) |
| 700 | 6a8d9d4f6a | 2026-11-14 | Smarty task agent | fix(native): gate fresh history on proven stop and latest settlement | CARRIED (same sha) |
| 701 | 065ebb50d1 | 2026-11-14 | Smarty task agent | fix(native): D10 designed-end fixes (RFL 12:36Z) | CARRIED (same sha) |
| 702 | 6578c7081d | 2026-11-14 | Smarty task agent | test(native): retain independent D10 round-5 judge probes unchanged | CARRIED (same sha) |
| 703 | 9efa45006d | 2026-11-14 | Smarty task agent | fix(native): D10 round 4 (RFL 12:52Z F0/F2/F6/F9 + positive no-owner read) | CARRIED (same sha) |
| 704 | fe87e3c69e | 2026-11-14 | Smarty task agent | fix(native): keep refused follow-up pending after earlier step completion | CARRIED (same sha) |
| 705 | 5b70e5b274 | 2026-11-14 | Smarty task agent | fix(native): make fresh-thread boundary inspection read-only | CARRIED (same sha) |
| 706 | 72f7eb804c | 2026-11-14 | Smarty task agent | fix(native): end unavailable stop proof truthfully and recheck on Retry | CARRIED (same sha) |
| 707 | e5a6ba6c1e | 2026-11-14 | Smarty task agent | docs(native): register the strict stop boundary and its plugin limits | CARRIED (same sha) |
| 708 | d32b4d0585 | 2026-11-14 | Smarty task agent | fix(native): narrow persisted stop-proof fixture types | CARRIED (same sha) |
| 709 | 50c7d007e3 | 2026-11-14 | smarty-fleet-write[bot] | style(runner): cargo fmt the D10 round-5 runner files (format only) | CARRIED (same sha) |
| 710 | 44f325bc2e | 2026-11-14 | app-lead task agent | How Paperclip intends it: a signed-in user changes their password with Better Auth's documented change-password call (RED) | CARRIED (same sha) |
| 711 | 2c32ca8eff | 2026-11-14 | app-lead task agent | How Paperclip intends it: Settings > Profile changes the password through Better Auth's documented change-password call, signing out other devices | CARRIED (same sha) |
| 712 | 8434ee2077 | 2026-11-14 | smarty-fleet-write[bot] | RFL judge-d10-extra: type-only fix (authorized) | CARRIED (same sha) |
| 713 | 8232f37f04 | 2026-11-14 | smarty-fleet-write[bot] | RFL-ordered assertion flips (D10, classes 1-7) | CARRIED (same sha) |
| 714 | 2467b7ee7b | 2026-11-14 | Smarty Task Agent | How Paperclip intends it: keep mobile announcements off chat composers | CARRIED (same sha) |
| 715 | 086a8896f9 | 2026-11-14 | Smarty Task Agent | test(e2e): cover the agent chat route for mobile announcements | CARRIED (same sha) |
| 716 | 2c71925dfb | 2026-11-14 | smarty-fleet-write[bot] | test: reproduce D10b archived-chat refusal dead ends | CARRIED (same sha) |
| 717 | e9f52db90e | 2026-11-14 | smarty-fleet-write[bot] | fix: route archived-chat refusals through D10 proven-stop recovery | CARRIED (same sha) |
| 718 | d0c2e62c5d | 2026-11-14 | smarty-fleet-write[bot] | test(judge): write RFL judge probe logs to RFL_JUDGE_LOG_DIR or the OS temp dir | CARRIED (same sha) |
| 719 | 74daf39700 | 2026-11-14 | smarty-fleet-write[bot] | test(native): import RFL round-5 judge probes R5-1/R5-3 unchanged (RED) | CARRIED (same sha) |
| 720 | 78ef47937c | 2026-11-14 | smarty-fleet-write[bot] | fix(native): D10 R5-1 remote absence is not proof; R5-3 neutral wording for generic prepare refusal | CARRIED (same sha) |
| 721 | 9c025694ce | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): assert SMAA-143's notice metadata explicitly (RFL ruling) | CARRIED (same sha) |
| 722 | dbe021ddac | 2026-11-14 | smarty-fleet-write[bot] | test: preserve unchanged RFL R5 seed-A judges | CARRIED (same sha) |
| 723 | 9055a552c0 | 2026-11-14 | smarty-fleet-write[bot] | RFL judge-r5-extra: log path (authorized) | CARRIED (same sha) |
| 724 | 685162c1af | 2026-11-14 | smarty-fleet-write[bot] | test(native): assert no stale blocker after D10's designed end (RFL, authorized) | CARRIED (same sha) |
| 725 | 99ddbc6eaf | 2026-11-14 | smarty-fleet-write[bot] | test(native): RFL class-2 rows for D10's waiting blocker in execution-blocker-read | CARRIED (same sha) |
| 726 | aa0365ec0d | 2026-11-14 | smarty-fleet-write[bot] | test: prove explicit import comment authorship fails closed | CARRIED (same sha) |
| 727 | 1956a7201d | 2026-11-14 | smarty-fleet-write[bot] | test: prove taskPeople import attribution and complete coverage | CARRIED (same sha) |
| 728 | 0783b85846 | 2026-11-14 | smarty-fleet-write[bot] | test: prove read-only import authorship previews and visibility | CARRIED (same sha) |
| 729 | 6dddfb2688 | 2026-11-14 | smarty-fleet-write[bot] | test: correct Slack sender metadata in authorship fixture | CARRIED (same sha) |
| 730 | 024bf2c6db | 2026-11-14 | smarty-fleet-write[bot] | fix: preserve verified import people and preview attribution | CARRIED (same sha) |
| 731 | 9abd9c880a | 2026-11-14 | smarty-fleet-write[bot] | test(native): import RFL R513 judge probes unchanged (RED; log path per authorized pattern) | CARRIED (same sha) |
| 732 | 5a4b97bc55 | 2026-11-14 | smarty-fleet-write[bot] | RFL judge-r513-probes: runner import by package name (path-only) | CARRIED (same sha) |
| 733 | be8ed7edb4 | 2026-11-14 | smarty-fleet-write[bot] | fix(native): R513-3 skill-change wording for typed instruction refresh; generic prepare refusal stays neutral | CARRIED (same sha) |
| 734 | 331d8752dd | 2026-11-14 | smarty-fleet-write[bot] | test: reproduce warm-box retirement and resumed state refusal chain | CARRIED (same sha) |
| 735 | b78a335ec4 | 2026-11-14 | smarty-fleet-write[bot] | fix: settle warm retirement setup and preserve resumed refusal authority | **CARRIED** (history: same sha; effect: see above) |
| 736 | a5c317c190 | 2026-11-14 | smarty-fleet-write[bot] | fix(native): R513-3 round 2: instruction-refresh codes come from the runner | CARRIED (same sha) |
| 737 | d7f7090bd0 | 2026-11-14 | smarty-fleet-write[bot] | test(native): restore the diagnostic message assertion beside the typed code (RFL TL08 F3) | CARRIED (same sha) |
| 738 | ef034f70b2 | 2026-11-14 | Smarty task agent | test(native): keep the cold-restore regressions (D10), code name per the line (RFL-authorized) | CARRIED (same sha) |
| 739 | bff832baa3 | 2026-11-14 | smarty-fleet-write[bot] | fix(native): D10 R513-1/R513-2 classify remote location from all durable evidence before local proof | CARRIED (same sha) |
| 740 | 1c2e0228df | 2026-11-14 | Smarty task agent | test: preserve F1 receipt, wake, and unchanged RFL RED probes | CARRIED (same sha) |
| 741 | 1cb12ac016 | 2026-11-14 | Smarty task agent | test: extend frozen F1 replay to receipt arrival on observed owner | CARRIED (same sha) |
| 742 | c8fac32849 | 2026-11-14 | Smarty task agent | fix: preserve stopped lease proof and retire stranded observed owners | CARRIED (same sha) |
| 743 | e6a8946999 | 2026-11-14 | Smarty task agent | test: reproduce released SEED-B proof gap and retained provider age-stop | CARRIED (same sha) |
| 744 | 7c4e027398 | 2026-11-14 | Smarty task agent | fix: inspect ended warm allocations before fresh-thread admission | CARRIED (same sha) |
| 745 | aa0050be1e | 2026-11-14 | Smarty task agent | test: replay the actual SEED-B stop receipts at follow-up acquisition | CARRIED (same sha) |
| 746 | 8ffa338a35 | 2026-11-14 | Smarty task agent | fix: preserve completed stop receipts during obsolete-source acquisition | CARRIED (same sha) |
| 747 | 7dfac2b727 | 2026-11-14 | Smarty task agent | test: import RFL F1 judge REDs unchanged | CARRIED (same sha) |
| 748 | d0605e5a06 | 2026-11-14 | Smarty task agent | test: RFL-authorized bad-time wording (cannot confirm stop) | CARRIED (same sha) |
| 749 | c0b3d7d360 | 2026-11-14 | Smarty task agent | RFL judge-f1-person: type-only fix (authorization requested) | CARRIED (same sha) |
| 750 | 50d3c0db1a | 2026-11-14 | Smarty task agent | fix: request bounded historical stops only after provider inspection | CARRIED (same sha) |
| 751 | 59d0befe27 | 2026-11-14 | Smarty task agent | RFL judge-f1-person: type-only fix (RFL-authorized 20:21Z) | CARRIED (same sha) |
| 752 | 03d1cfbf13 | 2026-11-14 | Smarty task agent | test: RFL ruling 20:21Z: tl07-idle expects the TL07 answer, no waiting note | CARRIED (same sha) |
| 753 | 381a8710fb | 2026-11-14 | Smarty task agent | RFL judge-f1-person: type-only fix (RFL-authorized 20:21Z) | CARRIED (same sha) |
| 754 | 1910d6cc80 | 2026-11-14 | Smarty task agent | fix: route settled native-owner holds to the waiting refused follow-up | CARRIED (same sha) |
| 755 | 7b23aa7a54 | 2026-11-14 | Smarty task agent | test: restore tl07-idle's original D10 expectation (RFL ruling 21:27Z supersedes 20:21Z) | CARRIED (same sha) |
| 756 | 493d0867f7 | 2026-11-14 | Smarty task agent | RFL-authorized: J-TL08 fixture code spelling (native_execution_ownership_unverified) | CARRIED (same sha) |
| 757 | 98481c7e47 | 2026-11-14 | Smarty task agent | RFL-authorized: row5 non-proof read expects cannot-confirm wording | CARRIED (same sha) |
| 758 | 2a57db83f7 | 2026-11-14 | Smarty task agent | fix: uses an authorized fresh continuation after start-intent without an eager notice | CARRIED (same sha) |
| 759 | c7104b0901 | 2026-11-14 | Smarty task agent | fix: J-TL08 history and later resend answer (observed) | CARRIED (same sha) |
| 760 | 2c9669a7d9 | 2026-11-14 | Smarty task agent | test: F1-1 ended source GET binding bar (target E) | CARRIED (same sha) |
| 761 | 6e0454bbb5 | 2026-11-14 | Smarty task agent | fix: coalesce uncommitted system-owned fresh-thread notices | CARRIED (same sha) |
| 762 | 0c1a55358b | 2026-11-14 | Smarty task agent | fix: require positive running GET before historical stop ownership (F1-1 E) | CARRIED (same sha) |
| 763 | 258bf362be | 2026-11-14 | Smarty task agent | fix: preserve notice redaction while coalescing uncommitted rows | CARRIED (same sha) |
| 764 | 101eac6428 | 2026-11-14 | Smarty task agent | RFL-authorized 22:14Z: start-intent unconfirmed-stop expects the designed wait without a positive read | CARRIED (same sha) |
| 765 | d40262317b | 2026-11-14 | Smarty task agent | RFL ruling 23:08Z (B): tl07-idle waits with one note, then a later positive read wakes it | CARRIED (same sha) |
| 766 | 0c0dca1d3f | 2026-11-14 | Smarty task agent | RFL-authorized 22:57Z (3): ended-stop-owner error/absent expect the unchanged row | CARRIED (same sha) |
| 767 | e1126e7462 | 2026-11-14 | Smarty task agent | RFL 22:57Z (2): restore the complete ended row after its single confirmed stop | CARRIED (same sha) |
| 768 | 6218b54ecf | 2026-11-14 | Smarty task agent | test: read ended evidence from the typed metadata boundary | CARRIED (same sha) |
| 769 | 1a28a17f0e | 2026-11-14 | Smarty task agent | RFL 22:57Z (2): make ended-stop follow-up sweeps read-only after one stop | CARRIED (same sha) |
| 770 | 3e83359b69 | 2026-11-14 | Smarty task agent | RFL judge-f1 derivatives: type-only fix (RFL-authorized) | CARRIED (same sha) |
| 771 | 81b4606c75 | 2026-11-14 | Smarty task agent | test: F1 stranded owner admits a successor with real timers | CARRIED (same sha) |
| 772 | 65b8872d52 | 2026-11-14 | Smarty task agent | test: F1 automatic successor submits pending text and fresh history | CARRIED (same sha) |
| 773 | a39793929d | 2026-11-14 | Smarty task agent | test: keep F1 flow support in the test-only tree | CARRIED (same sha) |
| 774 | 1cabc1ce03 | 2026-11-14 | Smarty task agent | test: bind F1 resolved-hold assertions to the stranded owner | CARRIED (same sha) |
| 775 | 884ec8db2b | 2026-11-14 | Smarty task agent | RFL-authorized: per-case teardown in person files | CARRIED (same sha) |
| 776 | 87b8449972 | 2026-11-14 | smarty-fleet-write[bot] | test: reproduce TL07 open-task skill refresh regression | CARRIED (same sha) |
| 777 | 02dd35737f | 2026-11-14 | smarty-fleet-write[bot] | fix(runner): admit idle instruction refresh after close | CARRIED (same sha) |
| 778 | 09bcbed51a | 2026-11-14 | smarty-fleet-write[bot] | test(runner): a failed idle close keeps the refresh_fresh refusal (RFL TL07 ruling, close-fails case) | CARRIED (same sha) |
| 779 | 20b8a75bde | 2026-11-14 | smarty-fleet-write[bot] | fix(test): TL07 test imports the runner by package name; cargo fmt the TL07 runner change | CARRIED (same sha) |
| 780 | 5901709f83 | 2026-11-13 | Dotta | Start follow-up runs normally when a warm sandbox's window ends during its idle close (#21504) | **FLAG: history CARRIED (same sha); lease-status-only release behavior DROPPED / reversed by upstream #21782 (see above)** |
| 781 | 07e0383282 | 2026-11-14 | smarty-fleet-write[bot] | test: the fork's provider-expiry cap test includes upstream #21504's idle-close margin | CARRIED (same sha) |
| 782 | c77efb90af | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): RED: the re-wake loop. A continuation must never re-present a person comment that already has a published agent answer; r6's unanswered carry must stay (org 19:48Z, gate TES-144; RFL 20:03Z; M1.4b; Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 783 | 77fa27afb5 | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): RED: a run-less agent comment newer than the person's comment answers it (RFL's edge, 20:06Z; M1.4b; Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 784 | d111930358 | 2026-11-14 | smarty-fleet-write[bot] | RFL r6 continuation test: parent's own published reply answers (authorized) | CARRIED (same sha) |
| 785 | 6bc2b96f72 | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery): a continuation carries only person comments with no published agent answer, so the sweep never re-presents an answered comment (the re-wake loop; RFL ruling (1), 20:06Z; M1.4b; Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 786 | 2c7ded6266 | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): RED: a run-less agent comment (the Muse shape) never answers a person's comment, in the carry and in B's notice (RFL ruling 20:22Z; M1.4b; Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 787 | b0294de680 | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): correct OUR row (e) to RFL's ruling 20:22Z: a run-less agent comment does NOT answer a person's comment (M1.4b; Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 788 | e6095c6871 | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): RED: imported person comments are history (never carried, never noticed), keyed on a per-task arrival record written by the import (org decision 20:29Z / FINAL 20:35Z, .local/IMPORT-ARRIVAL.md R1-R6; M1.4b; Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 789 | 6ae295bb04 | 2026-11-14 | smarty-fleet-write[bot] | import-pause test: the paused-note message is live, not imported history (authorized) | CARRIED (same sha) |
| 790 | b9a1a1b53f | 2026-11-14 | smarty-fleet-write[bot] | fix(recovery,import): a per-task import arrival record; imported person comments are history and a run-less agent comment never answers, in ONE shared definition for the carry and B's notice (RFL 20:22Z; org 20:29Z / FINAL 20:35Z; M1.4b; Smarty fork, TEMPORARY) | CARRIED (same sha) |
| 791 | b46823e146 | 2026-11-14 | smarty-fleet-write[bot] | fix(native): the turn-waiting note names a pending skill change only on a typed instruction refresh (RFL B rows) | CARRIED (same sha) |
| 792 | 0dea6890ac | 2026-11-14 | Smarty task agent | fix: chat shows only the current note when a waiting note is superseded | CARRIED (same sha) |
| 793 | 7622639f87 | 2026-11-14 | smarty-fleet-write[bot] | test(judge): TL08 active-turn fixture carries the runner's typed refusal (RFL-authorized fixture validity) | CARRIED (same sha) |
| 794 | cc465dd71e | 2026-11-14 | smarty-fleet-write[bot] | test(recovery): guard the company.imported fallback: the company's FIRST import row, and only its own (R7; review-fleet-2 21:05Z) | CARRIED (same sha) |
| 795 | 80aeeeb7de | 2026-11-14 | smarty-fleet-write[bot] | perf(recovery): the company.imported fallback reads only the company's own import row, through activity_log_company_entity_created_idx (review-fleet-2 21:05Z) | CARRIED (same sha) |
| 796 | fcc61fef4c | 2026-11-14 | smarty-fleet-write[bot] | fix(native): B rows: narrow the skill-change waiting wording to provider_active_turn (RFL 21:4xZ) | CARRIED (same sha) |
| 797 | 35739016ff | 2026-11-14 | smarty-fleet-write[bot] | test: add RFL retained checkpoint probes | CARRIED (same sha) |
| 798 | 1059652e0d | 2026-11-14 | smarty-fleet-write[bot] | fix(runner): retain superseded refresh checkpoint | CARRIED (same sha) |
| 799 | 42b168ebaa | 2026-11-14 | smarty-fleet-write[bot] | test: exercise TL07 through the refreshed Runner session | CARRIED (same sha) |
| 800 | 5d79b2e0a4 | 2026-11-14 | smarty-fleet-write[bot] | test(runner): RFL TL07 retention probe writes its artifacts to TL07_JUDGE_ARTIFACTS or a temp dir (path-only) | CARRIED (same sha) |
| 801 | 4b22900283 | 2026-11-14 | smarty-fleet-write[bot] | RFL TL07 causal M1.4a control (judge rfl-tl07r2) | CARRIED (same sha) |
| 802 | 0360aea115 | 2026-11-14 | Smarty task agent | test: notes a person must read are written open (RED) | CARRIED (same sha) |
| 803 | 4cb02d268c | 2026-11-14 | Smarty task agent | fix: notes a person must read are written open (detailsDefaultOpen: true) | CARRIED (same sha) |
| 804 | b04095f19f | 2026-11-14 | Smarty task agent | test: notes written open: update three assertions of the old folded value | CARRIED (same sha) |
| 805 | 9c46c34740 | 2026-11-15 | smarty-fleet-write[bot] | server build: exclude colocated judge-f1-person tests (they import ui/src); still typechecked by the layered tests layer | CARRIED (same sha) |
| 806 | 5f0d3bf2d9 | 2026-11-15 | Smarty task agent | RFL ruling 00:13Z: unsettled routing case uses an owner without physical proof; human-decision hold never routed past | CARRIED (same sha) |
| 807 | 40f92fea6a | 2026-11-15 | Smarty task agent | test: import RFL c1 receipt finding RED unchanged | CARRIED (same sha) |
| 808 | 3f361627b4 | 2026-11-15 | Smarty task agent | fix: preserve bound historical stop receipts regardless of cleanup status | CARRIED (same sha) |
| 809 | 7ae41e067c | 2026-11-15 | Smarty task agent | fix: inspect historical acquisition sources before reusing the bounded stop owner | CARRIED (same sha) |
| 810 | 8959352b8c | 2026-11-15 | Smarty task agent | RFL-authorized 00:35Z: tl08-started unavailable handoff follows upstream #21504 (null after retirement, no second owner) | CARRIED (same sha) |
| 811 | 95e4d95235 | 2026-11-15 | smarty-fleet-write[bot] | types: map the stale row through toEnvironmentLeaseSnapshot for inspectLeaseResource (identity mapper; no runtime change); test reads endedLeaseEvidence via a typed view | CARRIED (same sha) |
| 812 | 74ccf17092 | 2026-11-13 | Dotta | fix(recovery): continue a failed continuation again instead of escalating it to the board (#21394) | **CARRIED, extended** (history: same sha; effect: see above) |
| 813 | 641d46e257 | 2026-11-15 | smarty-fleet-write[bot] | test(native-runtime): RED - runtime launch assets are staged one remote transfer per asset | CARRIED (same sha) |
| 814 | 49abb9f866 | 2026-11-15 | smarty-fleet-write[bot] | native-runtime: stage changed runtime launch assets as ONE archive transfer + one installer exec | CARRIED (same sha) |
| 815 | e25309f316 | 2026-11-15 | Smarty Agent | test(ui): RED - coordinator More lists Goals only when enableGoalsSidebarLink is on | CARRIED (same sha) |
| 816 | 46949afeaf | 2026-11-15 | Smarty Agent | feat(ui): show Goals in the coordinator More flyout when enableGoalsSidebarLink is on | CARRIED (same sha) |
| 817 | 93be19c66f | 2026-11-15 | Smarty Agent | test(e2e): Goals in coordinator More opens the goals page at 1440 and 390 | CARRIED (same sha) |
| 818 | e53867c3e1 | 2026-11-15 | smarty-fleet-write[bot] | test: a plugin RPC timeout during host verification is classified as transient (RED; dl-hirefix) | CARRIED (same sha) |
| 819 | e33e5251c0 | 2026-11-15 | smarty-fleet-write[bot] | fix: classify plugin RPC timeouts in lifecycle verification as transient PLUGIN_RPC_TIMEOUT (was unclassified) | CARRIED (same sha) |
| 820 | d45f56306a | 2026-11-15 | Smarty task agent | test: reproduce Pi raw trace admission without a native trace channel | CARRIED (same sha) |
| 821 | f19e7fb9d9 | 2026-11-15 | Smarty task agent | fix: skip unsupported Pi RPC raw provider tracing | CARRIED (same sha) |
| 822 | b9b9edfcb7 | 2026-11-15 | Smarty task agent | test: reproduce stale superseded warm-copy status holders | CARRIED (same sha) |
| 823 | 8a1130ffc0 | 2026-11-15 | Smarty task agent | fix: settle handed-off superseded instruction-copy aliases | CARRIED (same sha) |
| 824 | 771fc5602a | 2026-11-15 | app-lead task agent | feat(projects): the project pill follows its tasks; row shows open counts | CARRIED (same sha) |
| 825 | 69dc77a339 | 2026-11-15 | smarty-fleet-write[bot] | test: cover blocked chat handoff delivery before implementation | CARRIED (same sha) |
| 826 | 434258c5ea | 2026-11-15 | smarty-fleet-write[bot] | fix: report blocked chat handoffs through the completion outbox | CARRIED (same sha) |
| 827 | 2b3621f9d2 | 2026-11-15 | Cost Dash Task Agent | test(ui): require temporary cost figure placeholder (RED) | CARRIED (same sha) |
| 828 | cae0aab865 | 2026-11-15 | Cost Dash Task Agent | fix(ui): temporarily hide estimated cost figures behind one flag | CARRIED (same sha) |
| 829 | aa04a39d66 | 2026-11-15 | smarty-fleet-write[bot] | test: specify per-session Pi home package inheritance | CARRIED (same sha) |
| 830 | 9ff96f8ae2 | 2026-11-15 | smarty-fleet-write[bot] | fix: reuse Pi home settings and npm packages per session | CARRIED (same sha) |
| 831 | 8d4d7d81de | 2026-11-15 | Smarty task agent | test(ui): reproduce raw waiting markers in system notices | CARRIED (same sha) |
| 832 | ba187b9dab | 2026-11-15 | Smarty task agent | fix(ui): show waiting notice markers in plain words | CARRIED (same sha) |
| 833 | 2989d90d71 | 2026-11-15 | Smarty task agent | test: retake final request-changes RED on c2; preserve original approval regression | CARRIED (same sha) |
| 834 | 53be657c91 | 2026-11-15 | Smarty task agent | fix: apply saved reviewer request-changes at native finish (unchanged production patch) | CARRIED (same sha) |
| 835 | 0f40061f99 | 2026-11-15 | Smarty task agent | test: stale reviewer cannot request changes even when the stop path succeeds | CARRIED (same sha) |
| 836 | 7640325ad2 | 2026-11-15 | Smarty task agent | fix: reject native review decisions from a run without the issue lock | CARRIED (same sha) |
| 837 | 2f003be752 | 2026-11-15 | Smarty task agent | test: cover reviewer failure report and no-report process loss after saved changes | CARRIED (same sha) |
| 838 | 8e94e5f698 | 2026-11-15 | Smarty task agent | fix: saved review changes outrank subsequent provider failure at native arbitration | CARRIED (same sha) |
| 839 | 0fd4dd7a4c | 2026-11-15 | smarty-fleet-write[bot] | test: mark C3-1 as a known after-the-move gap with it.fails (dev-lead integration ask) | CARRIED (same sha) |
| 840 | 03e68e4aa0 | 2026-11-15 | Smarty task agent | test: cover unowned and terminal native review locks | CARRIED (same sha) |
| 841 | db5cd162a5 | 2026-11-15 | Smarty task agent | fix: fence native review decisions only behind live lock owners | CARRIED (same sha) |
| 842 | dc4c23aadc | 2026-11-15 | Smarty task agent | test: type heartbeat mock identifiers without changing assertions | CARRIED (same sha) |
| 843 | d2fae144cc | 2026-11-15 | Smarty task agent | perf(pi): log session-open sub-step timings | CARRIED (same sha) |
| 844 | fafd103de1 | 2026-11-15 | smarty-fleet-write[bot] | test: specify manager control of runner reports and budgets | CARRIED (same sha) |
| 845 | 4a3b336de1 | 2026-11-15 | smarty-fleet-write[bot] | fix: allow managers to configure runner report environments and budgets | CARRIED (same sha) |
| 846 | aa19160d7f | 2026-11-15 | smarty-fleet-write[bot] | test: reject agent report daily cost caps of zero | CARRIED (same sha) |
| 847 | 5d8cf89cf1 | 2026-11-15 | smarty-fleet-write[bot] | fix: refuse zero heartbeat daily cost caps from agent actors | CARRIED (same sha) |
| 848 | a70249cbff | 2026-11-15 | smarty-fleet-write[bot] | test(db): prove runtime grant migration reruns are unchanged | CARRIED (same sha) |
| 849 | a22492b89d | 2026-11-15 | smarty-fleet-write[bot] | docs(db): record fork migration renumbering policy | CARRIED (same sha) |
| 850 | fd351cf2e0 | 2026-11-15 | smarty-fleet-write[bot] | docs: name runtime-grant revocation for one hire and all agents | CARRIED (same sha) |
| 851 | a28002e646 | 2026-11-15 | Task Agent | test(hidden-tasks): RED - Unhide on the hidden banner and menu, Show hidden tasks filter, includeHidden list param | CARRIED (same sha) |
| 852 | c59f9b691a | 2026-11-15 | Task Agent | feat(tasks): un-hide a hidden task and show hidden tasks in task lists | CARRIED (same sha) |
| 853 | 1ae8cc3e83 | 2026-11-15 | Task Agent | test(tasks): specify hidden-only task views (RED) | CARRIED (same sha) |
| 854 | 436cb5d23b | 2026-11-15 | Task Agent | feat(tasks): add Hidden-only task views across workspaces | CARRIED (same sha) |
| 855 | a1286225ba | 2026-11-15 | Smarty Task Agent | test: require hidden task badges to fit mobile rows | CARRIED (same sha) |
| 856 | cc50ad96a8 | 2026-11-15 | Smarty Task Agent | fix: fit task title columns and hidden badges within narrow lists | CARRIED (same sha) |
| 857 | a7b6f9d588 | 2026-11-15 | smarty-fleet-write[bot] | test: reject agent zero daily caps on both create routes | CARRIED (same sha) |
| 858 | 9dd206f7c8 | 2026-11-15 | smarty-fleet-write[bot] | fix: share agent zero daily cap validation with hire preparation | CARRIED (same sha) |
| 859 | 3bc88eceda | 2026-11-15 | app-lead task agent | test(ui,server): RED - instance default shows agent-created tasks in task lists | CARRIED (same sha) |
| 860 | 89068cbc69 | 2026-11-15 | app-lead task agent | feat(ui,server): instance setting to show agent-created tasks in task lists by default | CARRIED (same sha) |
| 861 | c2c38228ec | 2026-11-15 | smarty-fleet-write[bot] | test(native): RED, the first follow-up on a replaced warm box must answer (n-fallback E2E, deployed 562da3cc) | CARRIED (same sha) |
| 862 | 4e2d6597c3 | 2026-11-15 | smarty-fleet-write[bot] | fix(native-runtime): D-B1, a failed remote runner-state read is a plain error again (deletion toward upstream) | CARRIED (same sha) |
| 863 | 4290b5298b | 2026-11-15 | smarty-fleet-write[bot] | fix(runner): D-B2, delete the runner-side interception of controller restore refusals (deletion toward upstream) | CARRIED (same sha) |
| 864 | 2704e912a6 | 2026-11-15 | smarty-fleet-write[bot] | test(native): RED for D-B4, only a definite absence of runner-state.json is "resume state unavailable" (RFL conditions) | CARRIED (same sha) |
| 865 | b72c48c68a | 2026-11-15 | smarty-fleet-write[bot] | fix(native): D-B4, a replaced box with no runner-state.json takes the classified resume-unavailable route | CARRIED (same sha) |
| 866 | 7aa255163a | 2026-11-15 | smarty-fleet-write[bot] | test(native): RED for D-B5, a warm rebind gives the same replacement policy as the durable rebind | CARRIED (same sha) |
| 867 | 1a39131fa6 | 2026-11-15 | smarty-fleet-write[bot] | fix(native): D-B5, the warm controller rebind computes the replacement policy as the durable rebind does | CARRIED (same sha) |
| 868 | 65c1d6629e | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): the Codex warm row checks the answer where this executor-level row can see it | CARRIED (same sha) |
| 869 | 75a5cca815 | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): fix the Codex warm row's types for the server's layered typecheck | CARRIED (same sha) |
| 870 | abef3c8d55 | 2026-11-15 | Smarty task agent | test(runner): expose dropped Pi thinking on the production turn path | CARRIED (same sha) |
| 871 | b3460ecb75 | 2026-11-15 | Smarty task agent | fix(runner): include Pi thinking in production reasoning items | CARRIED (same sha) |
| 872 | 72b8fff6ec | 2026-11-15 | smarty-fleet-write[bot] | test: require insert-time provenance for imported comments | CARRIED (same sha) |
| 873 | ca75930c04 | 2026-11-15 | smarty-fleet-write[bot] | fix: mark company-import comments at insertion | CARRIED (same sha) |
| 874 | 65ef621330 | 2026-11-15 | smarty-fleet-write[bot] | test: guard imported comment display and task context | CARRIED (same sha) |
| 875 | c8dc48d7e1 | 2026-11-15 | smarty-fleet-write[bot] | test: add getWorker to plugin manager fixtures | CARRIED (same sha) |
| 876 | d08422184b | 2026-11-15 | smarty-fleet-write[bot] | test: accept config replay revision in bundled registration (fork cb5f995c6 adds revision; masked by the stale getWorker mock) | CARRIED (same sha) |
| 877 | f88d9f0f61 | 2026-11-15 | smarty-fleet-write[bot] | test: assert the exact config replay revision (row updatedAt) in bundled registration (RFL tightening) | CARRIED (same sha) |
| 878 | 3af1393b01 | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): the runner no longer preserves the typed code (D-B2, deletion toward upstream); designed end unchanged | CARRIED (same sha) |
| 879 | e01e540e9f | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): the F2 row5 remote-read rows end at upstream's outcome (D-B1 + D-B2, deletions toward upstream) | CARRIED (same sha) |
| 880 | ec7d5247d3 | 2026-11-15 | smarty-fleet-write[bot] | test(native): type the Pi replaced-box row's rebind assignment (real server typecheck) | CARRIED (same sha) |
| 881 | 2353a9f12a | 2026-11-15 | smarty-fleet-write[bot] | test(runner): D10b refusal rows end at upstream's outcome (D-B2, deletion toward upstream) | CARRIED (same sha) |
| 882 | 712bf2580e | 2026-11-15 | smarty-fleet-write[bot] | test(native): declared deviation (D-B5) from upstream e3bc4ca7's warm intent, in the filesystem-independence row | CARRIED (same sha) |
| 883 | 12c1a45f16 | 2026-11-15 | Smarty task agent | test(workspaces): reproduce nested cwd from echoing retained providers | CARRIED (same sha) |
| 884 | f5dd253307 | 2026-11-15 | Smarty task agent | fix(workspaces): join new allocations onto their sandbox base | CARRIED (same sha) |
| 885 | b55e209a19 | 2026-11-15 | smarty-fleet-write[bot] | test(native): RED for D-B6, a governed-wait warm follow-up on a created box must answer; same-box cold resume unchanged | CARRIED (same sha) |
| 886 | f706369c25 | 2026-11-15 | smarty-fleet-write[bot] | test(native): type the Pi replaced-box row's rebind assignment (real server typecheck) | CARRIED (same sha) |
| 887 | ba702583cf | 2026-11-15 | smarty-fleet-write[bot] | test(native): D-B6 KEEP control, a warm rebind that records no new box keeps the prior cursor | CARRIED (same sha) |
| 888 | c007534c9d | 2026-11-15 | smarty-fleet-write[bot] | fix(native): D-B6, a warm rebind onto a known NEW box starts the new run's journal at zero | CARRIED (same sha) |
| 889 | b4a6982bab | 2026-11-15 | smarty-fleet-write[bot] | test(native): every answer row asserts HISTORY PRESENT in the model request (RFL 12:31Z) | CARRIED (same sha) |
| 890 | a2dbd83cfd | 2026-11-15 | smarty-fleet-write[bot] | test(native): RED for D-B8 v2, a governed-wait follow-up on a truly replaced box answers, honestly | CARRIED (same sha) |
| 891 | a0384b3af3 | 2026-11-15 | smarty-fleet-write[bot] | fix(runner): D-B8, on a governed wait a replaced box's definite absence of Runner state lets the Pi cold-resume ladder start | CARRIED (same sha) |
| 892 | f6ec44cca1 | 2026-11-15 | Task Agent | test(reasoning): RED - plain inline look, no per-chat switch, paperclip_runner inline by default (look-only) | CARRIED (same sha) |
| 893 | a76ef2a88e | 2026-11-15 | Task Agent | fix(reasoning): plain inline reasoning, no per-chat switch, paperclip_runner inline by default (UI only) | CARRIED (same sha) |
| 894 | 8f2589e05f | 2026-11-15 | Task Agent | test(e2e): look-only reasoning on a seeded paperclip_runner/pi_rpc native run | CARRIED (same sha) |
| 895 | 1173bda320 | 2026-11-15 | Task Agent | test(reasoning): compare real answer typography in task and Coordinator chats | CARRIED (same sha) |
| 896 | aece18a1eb | 2026-11-15 | Task Agent | fix(reasoning): share answer typography tokens across chat renderers | CARRIED (same sha) |
| 897 | 530c801e95 | 2026-11-15 | smarty-fleet-write[bot] | test(recovery): reproduce assigned-work rewaking an accepted response wait | CARRIED (same sha) |
| 898 | 7dae45575f | 2026-11-15 | smarty-fleet-write[bot] | fix(recovery): honor a current accepted response-wake wait in assigned work | CARRIED (same sha) |
| 899 | 5258c1be50 | 2026-11-15 | smarty-fleet-write[bot] | test(recovery): reproduce input swallowed during response-wake finalization | CARRIED (same sha) |
| 900 | c088889485 | 2026-11-15 | smarty-fleet-write[bot] | fix(recovery): revoke response waits from accepted result time | CARRIED (same sha) |
| 901 | 59eeb93f0e | 2026-11-15 | smarty-fleet-write[bot] | test(recovery): clean portable preparation fixtures before later global sweeps | CARRIED (same sha) |
| 902 | ed6313f2ba | 2026-11-15 | smarty-fleet-write[bot] | test: reproduce person input lost before response-wake result | CARRIED (same sha) |
| 903 | 46d18b5369 | 2026-11-15 | smarty-fleet-write[bot] | fix: revoke response wait on input since producing run start | CARRIED (same sha) |
| 904 | af2cef40e8 | 2026-11-15 | smarty-fleet-write[bot] | test: guard agent confirmation response wait across a full day | CARRIED (same sha) |
| 905 | 84d8d1cd18 | 2026-11-15 | smarty-fleet-write[bot] | test(runner): include Pi child bridge in proof bundles | CARRIED (same sha) |
| 906 | 931ff67107 | 2026-11-15 | smarty-fleet-write[bot] | test(runner): bind Pi proof bundle integrity manifests | CARRIED (same sha) |
| 907 | 13537d2a71 | 2026-11-15 | smarty-fleet-write[bot] | test(native-runtime): provision restart fixture integration prerequisites | CARRIED (same sha) |
| 908 | 5ab85094bd | 2026-11-15 | Smarty task agent | test(runner): track provider-started Pi turn identity | CARRIED (same sha) |
| 909 | e8f338f7e1 | 2026-11-15 | smarty-fleet-write[bot] | test(runner): resident-authority keeps the single-bootstrap-turn intent (RFL) | CARRIED (same sha) |
| 910 | 7df1c4c6f8 | 2026-11-15 | open-span-allowlist | test: catch dropped Pi open performance spans | CARRIED (same sha) |
| 911 | de46b791a9 | 2026-11-15 | open-span-allowlist | fix(runner): preserve Pi open performance spans | CARRIED (same sha) |
| 912 | 980606006b | 2026-11-15 | smarty-fleet-write[bot] | chore(runner): regenerate the capability contract after the SKILL.md edit | CARRIED (same sha) |
| 913 | 7ca2a99400 | 2026-11-15 | smarty-fleet-write[bot] | test(recovery): RED for follow-Paperclip Cuts A + B: A-5's two provider cases, B-5's one-note owner, B-2's one bound (RFL verdict 04:5xZ; spec fp-FINAL-WITH-RFL-FIXES) | CARRIED (same sha) |
| 914 | afe07a426a | 2026-11-15 | smarty-fleet-write[bot] | test(recovery): RED for RFL's A-5 condition: no verified custody, no destroy, the lease is kept; A-5 rebuilt on the real same-task follow-up (RFL 05:51Z) | CARRIED (same sha) |
| 915 | ec8c1a4472 | 2026-11-15 | smarty-fleet-write[bot] | fix(environment): Cut A: an obsolete reusable source is destroyed through upstream's guarded destroy ONLY with its native session in verified custody, otherwise stopped and kept as before (follow-Paperclip; RFL 04:5xZ A-1/A-5, 05:51Z condition, 06:21Z ruling (A)) | CARRIED (same sha) |
| 916 | 1a9cc0193f | 2026-11-15 | smarty-fleet-write[bot] | test(environment): RED: the custody guard fails closed on an unknown adapter (RFL 06:33Z) | CARRIED (same sha) |
| 917 | 87d176fda4 | 2026-11-15 | smarty-fleet-write[bot] | fix(environment): the obsolete-lease custody guard fails closed: only a lease recorded with a KNOWN non-native adapter skips custody (RFL 06:33Z) | CARRIED (same sha) |
| 918 | 11eb1ba2d0 | 2026-11-15 | smarty-fleet-write[bot] | test(environment): fixture moved to known non-native; null covered by b706daba (RFL ruling 06:51Z, option (b)) | CARRIED (same sha) |
| 919 | 928c3f8021 | 2026-11-15 | smarty-fleet-write[bot] | fix(recovery): Cut B: the typed refusal family follows upstream's fresh-continuation fallback; the stop-gate and notice-read-back web is removed (follow-Paperclip; RFL 04:5xZ B-1..B-5, 05:51Z, 07:06Z) | CARRIED (same sha) |
| 920 | b6d55d2f16 | 2026-11-15 | smarty-fleet-write[bot] | test(recovery): the K=2 bound's one note reads RFL's ruled text: follow-paperclip-cuts B-2 + watchdog-chain (#20662) (RFL 05:51Z B-2) | CARRIED (same sha) |
| 921 | ebbb61689b | 2026-11-15 | smarty-fleet-write[bot] | fix(native): exactly one note: the fresh-thread notice written at session selection supersedes the held-conversation notice (follow-Paperclip Cut B; hard line "exactly one note", RFL 07:41Z) | CARRIED (same sha) |
| 922 | 1346a3a76e | 2026-11-15 | smarty-fleet-write[bot] | test(run-completion): Cut B fallout, labelled flips/deletions, R7 completion (RFL ruling 07:41Z) | CARRIED (same sha) |
| 923 | 1da1dc603e | 2026-11-15 | smarty-fleet-write[bot] | test(fresh-thread-stop-gate-refresh-codes): Cut B fallout, labelled flips/deletions, R2 started-note at selection (RFL ruling 07:41Z) | CARRIED (same sha) |
| 924 | 426b13efc8 | 2026-11-15 | smarty-fleet-write[bot] | test(f1-ended-inspection-bar): Cut B fallout, labelled flips/deletions, R5 inspection rehomed to the cleanup owner (RFL ruling 07:41Z) | CARRIED (same sha) |
| 925 | bf8049b9d2 | 2026-11-15 | smarty-fleet-write[bot] | test(f1-ended-stop-owner): Cut B fallout, labelled flips/deletions, R5 stop owner rehomed (RFL ruling 07:41Z) | CARRIED (same sha) |
| 926 | 2f9c3562ea | 2026-11-15 | smarty-fleet-write[bot] | test(execution-blocker-read): Cut B fallout, labelled flips/deletions, R4 blocker read (RFL ruling 07:41Z) | CARRIED (same sha) |
| 927 | d3cb3572e0 | 2026-11-15 | smarty-fleet-write[bot] | test(execution-blocker-deadline-notice): Cut B fallout, labelled flips/deletions, R4 deadline notice is output only (RFL ruling 07:41Z) | CARRIED (same sha) |
| 928 | 611e561198 | 2026-11-15 | smarty-fleet-write[bot] | test(task-interruption-standing-notice): Cut B fallout, labelled flips/deletions, R8 standing notice is output only (RFL ruling 07:41Z) | CARRIED (same sha) |
| 929 | ea83e8a93b | 2026-11-15 | smarty-fleet-write[bot] | test(execution-projection): Cut B fallout, labelled flips/deletions, R4 projection ignores notices (RFL ruling 07:41Z) | CARRIED (same sha) |
| 930 | 67f7509df1 | 2026-11-15 | smarty-fleet-write[bot] | test(execution-projection-recovery): Cut B fallout, labelled flips/deletions, R4 recovery projection (RFL ruling 07:41Z) | CARRIED (same sha) |
| 931 | 2299e9a889 | 2026-11-15 | smarty-fleet-write[bot] | test(f1-seed-b): Cut B fallout, labelled flips/deletions, R5 gate call replaced by the read-only proof (RFL ruling 07:41Z) | CARRIED (same sha) |
| 932 | 3f2fcc3858 | 2026-11-15 | smarty-fleet-write[bot] | test(f1-stopped-owner-routing): Cut B fallout, labelled flips/deletions, R1/R2/R5 routing kept (RFL ruling 07:41Z) | CARRIED (same sha) |
| 933 | fa2f8bb475 | 2026-11-15 | smarty-fleet-write[bot] | test(unanswered-person-message): Cut B fallout, labelled flips/deletions, R8 B' typed defer removed (RFL ruling 07:41Z) | CARRIED (same sha) |
| 934 | afd50218e4 | 2026-11-15 | smarty-fleet-write[bot] | test(runtime-selection): Cut B fallout, labelled flips/deletions, R1/R2/R8 session selection (RFL ruling 07:41Z) | CARRIED (same sha) |
| 935 | bbb14cd5b7 | 2026-11-15 | smarty-fleet-write[bot] | test(fresh-continuation-fallback): Cut B fallout, labelled flips/deletions, R1/R2/R3/R5/R8 fallback (RFL ruling 07:41Z) | CARRIED (same sha) |
| 936 | 1d58d5e7d8 | 2026-11-15 | smarty-fleet-write[bot] | test(judge-f1-bad-time-contract): Cut B fallout, labelled flips/deletions, R1/R2/R3/R5/R8, RFL's judge file (RFL ruling 07:41Z) | CARRIED (same sha) |
| 937 | 33091b6ff2 | 2026-11-15 | smarty-fleet-write[bot] | S 01-RED-tests: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 938 | 23784adcda | 2026-11-15 | smarty-fleet-write[bot] | S 02-S-fix: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 939 | 35b0f9eddf | 2026-11-15 | smarty-fleet-write[bot] | S 03-RED-duplex-choke-gap: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 940 | a897d8863f | 2026-11-15 | smarty-fleet-write[bot] | S 04-S-duplex-guard: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 941 | 27aaae5aa7 | 2026-11-15 | smarty-fleet-write[bot] | S 05-inventory-test: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 942 | f1b42d746e | 2026-11-15 | smarty-fleet-write[bot] | S 06-six-reds-i-auth-projection: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 943 | aad1b00c6e | 2026-11-15 | smarty-fleet-write[bot] | S 06-six-reds-ii-key-only-stamp: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 944 | 85e7e9f4b9 | 2026-11-15 | smarty-fleet-write[bot] | S 06-six-reds-iii-lost-claim: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 945 | 327e668dc0 | 2026-11-15 | smarty-fleet-write[bot] | S 07-TL08b-RED: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 946 | 2be2f82ccb | 2026-11-15 | smarty-fleet-write[bot] | S 08-TL08b: applied byte-for-byte from the s-build patch set | CARRIED (same sha) |
| 947 | 5ff385b436 | 2026-11-15 | smarty-fleet-write[bot] | test(types): Cut A/B test files typecheck clean (types only; no assertion or behaviour change) | CARRIED (same sha) |
| 948 | faace2939d | 2026-11-15 | smarty-fleet-write[bot] | test(native): Cut B deletes the stopping note; pin each route's exact system-note set instead | CARRIED (same sha) |
| 949 | 49ba09f1e1 | 2026-11-15 | smarty-fleet-write[bot] | S 09-F1: inventory covers raw manager .call and aliases (test-only; RFL F1) | CARRIED (same sha) |
| 950 | 457ab365e3 | 2026-11-15 | smarty-fleet-write[bot] | test(native): x-red-with-backup rows: a Pi follow-up on a replaced box with a failover backup answers, or explains itself once | CARRIED (same sha) |
| 951 | 3975fa787f | 2026-11-15 | smarty-fleet-write[bot] | test(native): x-red-tl08 rows: a message after DONE's terminal teardown answers with history, never silently | CARRIED (same sha) |
| 952 | 35a1bfb332 | 2026-11-15 | smarty-fleet-write[bot] | test(native): real heartbeat entry rows for a governed-wait follow-up on a replaced box | CARRIED (same sha) |
| 953 | 8bbd45d6f6 | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): judge flips per RFL 16:43Z/17:14Z/17:34Z (judge-tl08-independent.test.ts): Cut B removed notes / base reds from 2a57db83, 6e0454bb, upstream 4363a311; the unconfirmed-stop NOT-FLIP stays red | CARRIED (same sha) |
| 954 | b2cdceea9f | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): judge flips per RFL 16:43Z/17:14Z/17:34Z (judge-r5-seed-history.test.ts): Cut B removed notes / base reds from 2a57db83, 6e0454bb, upstream 4363a311; the unconfirmed-stop NOT-FLIP stays red | CARRIED (same sha) |
| 955 | 6dd6fcdd92 | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): judge flips per RFL 16:43Z/17:14Z/17:34Z (runtime-selection.test.ts): Cut B removed notes / base reds from 2a57db83, 6e0454bb, upstream 4363a311; the unconfirmed-stop NOT-FLIP stays red | CARRIED (same sha) |
| 956 | 1c615e27e0 | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): unconfirmed-stop start-intent rows follow the production successor (TL05: reconcileStrandedAssignedIssues; SEED02: production delivery default, not caller_owns): harness gap, no product change (RFL pending) | CARRIED (same sha) |
| 957 | 469f31e521 | 2026-11-15 | smarty-fleet-write[bot] | test(heartbeat): keep the literal SEED02 caller_owns case as a labelled record (RFL 18:28Z) | CARRIED (same sha) |
| 958 | ee7d1f741b | 2026-11-08 | everlastingcrown | feat(github): add custom App installation credentials | CARRIED (same sha) |
| 959 | 2bdd327bf8 | 2026-11-08 | everlastingcrown | fix(github): preserve App permissions on wizard reconnect | CARRIED (same sha) |
| 960 | b201b5dff3 | 2026-11-15 | Paperclip | port fix: server/src/services/tool-access/catalog/discovery.ts | CARRIED (same sha) |
| 961 | d97418c969 | 2026-11-15 | Paperclip | port fix: server/src/services/tool-access/catalog/health.ts | CARRIED (same sha) |
| 962 | 5b0145ab4c | 2026-11-15 | smarty-fleet-write[bot] | test: cover person-authored Git work without an agent (RF2) | CARRIED (same sha) |
| 963 | 452a2632db | 2026-11-15 | Task Agent | test: cover safe lifecycle error details | CARRIED (same sha) |
| 964 | 5e2b09b598 | 2026-11-15 | Task Agent | fix: log bounded lifecycle error details | CARRIED (same sha) |
| 965 | 9a35b9c2ab | 2026-11-15 | Smarty task agent | test: require sandbox callback idle backoff wiring and bound idle list calls | CARRIED (same sha) |
| 966 | 206a104993 | 2026-11-15 | Smarty task agent | fix: back off idle sandbox callback polling (idleBackoffMaxMs 1000 ms default) | CARRIED (same sha) |
| 967 | 140e68fac8 | 2026-11-15 | status-commit-monitor | test: reproduce native status monitor stall | CARRIED (same sha) |
| 968 | 429eb3f137 | 2026-11-15 | status-commit-monitor | fix: clear native monitor on invalid status | CARRIED (same sha) |
| 969 | 60dca6f7ac | 2026-11-15 | Paul | test: require native monitor clear activity | CARRIED (same sha) |
| 970 | 84950cdff6 | 2026-11-15 | Paul | fix: log native monitor clear activity | CARRIED (same sha) |
| 971 | c1a68c724d | 2026-11-15 | runner-death-log | test: specify remote runner exit run-log evidence | CARRIED (same sha) |
| 972 | 6639dbe0e3 | 2026-11-15 | runner-death-log | fix: append truthful remote runner exit evidence to run log | CARRIED (same sha) |
| 973 | 3b64b02a60 | 2026-11-15 | Task Agent | test: cover safe HttpError lifecycle detail | CARRIED (same sha) |
| 974 | 0603f0ca48 | 2026-11-15 | Task Agent | fix: retain safe HttpError lifecycle diagnostics | CARRIED (same sha) |
| 975 | c5e89c300a | 2026-11-15 | Smarty task agent | test: cover sandbox callback bridge long polling | CARRIED (same sha) |
| 976 | 9fbf1eb770 | 2026-11-15 | Smarty task agent | fix: long-poll sandbox callback requests | CARRIED (same sha) |
| 977 | 0e842ded02 | 2026-11-15 | Smarty task agent | test: require prompt sandbox callback long-poll shutdown | CARRIED (same sha) |
| 978 | 6f4f138feb | 2026-11-15 | Smarty task agent | fix: stop sandbox callback long-polls on run-state change | CARRIED (same sha) |
| 979 | 2c4cb98898 | 2026-11-15 | n1-final | fix: bridge long-poll waits 5 s and never spins on integer-only sleep | CARRIED (same sha) |
| 980 | f6656a99ff | 2026-11-15 | Smarty task agent | test: bridge long-poll must not lose a request at the iteration-timeout edge | CARRIED (same sha) |
| 981 | e7960a4f96 | 2026-11-15 | Task Agent | test: cover parallel warm session restart close | CARRIED (same sha) |
| 982 | f70a59d976 | 2026-11-15 | Task Agent | fix: close warm native sessions concurrently on restart | DROPPED (code effect; see above) |
| 983 | 369d12ec36 | 2026-11-15 | Smarty Task Agent | test: verify restart close concurrency and shared budget | CARRIED (same sha) |
| 984 | da0e8ce423 | 2026-11-15 | Smarty Task Agent | test: model restart close time and remaining shutdown budget | CARRIED (same sha) |
| 985 | 1aa37d83d3 | 2026-11-15 | Smarty Task Agent | fix: bound restart warm closes to five workers | DROPPED (code effect; see above) |
| 986 | c96c17e636 | 2026-11-15 | Smarty Task Agent | fix: restart warm closes use the judged four workers | DROPPED (code effect; see above) |
| 987 | 29ef485ea4 | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): native setup probe waits up to 60 s to prove retirement (P0 arm bud60) | CARRIED (same sha) |
| 988 | 560c9200be | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): setup-check sandbox lease outlives the 60 s retirement budget (P0 arm bud60) | CARRIED (same sha) |
| 989 | b28db0b106 | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): Pi probe retirement uses the 60 s native probe budget, not a fixed 10 s (P0 arm bud60) | CARRIED (same sha) |
| 990 | 7060d1fc2b | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): setup probe remote-root removal shares the 60 s retirement budget (P0 arm bud60) | CARRIED (same sha) |
| 991 | ff95cf9964 | 2026-11-16 | hel-fold (task agent) | diag: DIAGNOSTIC ONLY: gate 2, never fresh; log lines only | CARRIED (same sha) |
| 992 | c51b845481 | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): setup-check sandbox lease 600 s, a margin over the worst-case probe + retirement under load (P0 image M) | CARRIED (same sha) |
| 993 | 9731e27f43 | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): setup probe copies out records only; the staged runner binary and Node compile cache get a size+sha256 manifest (P0 M2) | CARRIED (same sha) |
| 994 | cdc43a43b0 | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): probe manifest custody (judges 01:37-01:45Z): binary excluded only on sha match with the staged local runnerd, expected/found/match + count line, server validates every line and fails closed | CARRIED (same sha) |
| 995 | e246aafac2 | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): compare the probe's runnerd sha as hex (cachedFileSha256 returns 'sha256:<hex>'); without it the binary never matched and was always kept | CARRIED (same sha) |
| 996 | 44a6cfdc50 | 2026-11-16 | smarty-fleet-write[bot] | diag(pi_rpc): DIAGNOSTIC ONLY, log lines only: setup probe cleanup step timings (ms per step, static bytes, runnerd match) and forward the fixed-format cleanup-step lines (no behavior change) | CARRIED (same sha) |
| 997 | ee70a0b18b | 2026-11-16 | smarty-fleet-write[bot] | diag: DIAGNOSTIC ONLY, log line only: the cleanup-pending warning names its teardown steps (fixed-template messages only, else the error class) and the agentId | CARRIED (same sha) |
| 998 | a763d193f8 | 2026-11-16 | smarty-fleet-write[bot] | fix(pi_rpc): a setup probe with no configured PI_CODING_AGENT_DIR gives Pi a per-probe private agent dir beside (not inside) the synced root, removed with it (P0 no-env first-start deaths) | CARRIED (same sha) |
