VERDICT: NOT OK — unauthenticated waiters can deny the legitimate reconnect, and a disconnected waiter can occupy the next controller slot.

## Decision and identity

**Do not cut this candidate unchanged.** The basic 503-to-wait fix is real, but acceptance check (3) fails in two independently reproduced ways. Neither failure has an agreed v3 waiver or a verified fix, so this is not `OK WITH FIXES`.

- Candidate: [`6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f`](https://github.com/Smarty-Pants-Inc/paperclip/commit/6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f), branch `cl/runnerd-listener-m1.1`.
- Exact parent: deployed M1 [`c1dea0db254645755e7a3c818d0f6e0076aeb34e`](https://github.com/Smarty-Pants-Inc/paperclip/commit/c1dea0db254645755e7a3c818d0f6e0076aeb34e). **One commit**, not a C8-based item.
- Independent judge on `ryzen3`. Public source reads and local tests only; no production reads/writes, credentials, SSH, GitHub writes, builder contact, or agents spawned.
- Initial NOT OK verdict was written at **05:07Z on 2026-11-14**, before the 05:50Z deadline. This revision incorporates completed verification.

## 0. Home, Paperclip intent, and upstream check

**Home: the existing native Runner extension package, not Paperclip server core.** The only production implementation change is in `packages/paperclip-runner/runner/crates/runner-core/src/durable/transport/listener.rs`. The other five files are its tests, test include, and transport documentation. No plugin surface is bypassed in favor of a server-core patch.

The basis is upstream's existing listener-mode durable transport: [entry point and recovery, lines 3–12](https://github.com/paperclipai/paperclip/blob/67652580ee4e0444f504c3a979b215187b0af82d/packages/paperclip-runner/runner/DURABLE_TRANSPORT.md#L3-L12), and [disconnect/replay/reconnect contract, lines 39–50](https://github.com/paperclipai/paperclip/blob/67652580ee4e0444f504c3a979b215187b0af82d/packages/paperclip-runner/runner/DURABLE_TRANSPORT.md#L39-L50). The applicable extension guidance is upstream's [create-runner-adapter](https://github.com/paperclipai/paperclip/blob/67652580ee4e0444f504c3a979b215187b0af82d/.agents/skills/create-runner-adapter/SKILL.md), not a parallel recovery service. This item repairs the existing listener/mutex/condition-variable path in that package. Its documented 15-second limit is grounded in the existing [server handshake constant](https://github.com/Smarty-Pants-Inc/paperclip/blob/c1dea0db254645755e7a3c818d0f6e0076aeb34e/server/src/realtime/runner-prp-outbound.ts#L15) and [WebSocket caller](https://github.com/Smarty-Pants-Inc/paperclip/blob/c1dea0db254645755e7a3c818d0f6e0076aeb34e/server/src/realtime/runner-prp-outbound.ts#L251-L302).

I fetched upstream master at **`67652580ee4e0444f504c3a979b215187b0af82d`**, inspected its transport source/docs and transport history, and searched related changes. Its listener remains inline in `transport.rs`; there is **no equivalent M1 queued-listener admission fix to adopt** in the inspected master. Related `ad861a7f9` concerns bounded **post-authentication welcome**, not this HTTP-upgrade wait. Evidence: [upstream-inspection.txt](upstream-inspection.txt), [upstream-listener-source.txt](upstream-listener-source.txt), [upstream-related-welcome.txt](upstream-related-welcome.txt).

**Rules 1–3:** (1) the existing documented transport mechanism is used; (2) behavior remains in its native Runner extension home, consistent with the applicable upstream skill; (3) no new core seam or core patch requires an exception. Builder evidence does not establish that the author actually invoked/read that skill; source conformity is verified, workflow invocation is not. This is a transport repair, not a new harness requiring a new adapter integration campaign. **Home/cardinal gate: met.**

## 1. Required findings

### F1 — Unauthenticated waiters deny a legitimate reconnect

**Required for v2: yes. Likelihood 3 × impact 4 = 12.** Source step: admission policy/implementation and missing adversarial acceptance test.

Two independent reproductions exercise the real listener and real PRP authentication:

1. **The requested order: flood waiters, then reconnect.** A is mutually authenticated and live. Fifteen credential-free, complete HTTP upgrade requests queue first; legitimate B arrives next. A releases. The test keeps attempting actual PRP authentication, rather than leaving the ready slot idle. **B fails with HTTP 503 in all 3 trials**, after eight failed unauthenticated admission/authentication attempts per trial. No replenishing flood is needed. Test completion is at 16,473 / 16,481 / 16,481 ms, including the final in-progress failed authentication; these are observation/completion times, not a separate measurement of the exact wire refusal instant. Evidence: [prefilled-waiters.log](prefilled-waiters.log), [judge_prefilled_waiters.rs](judge_prefilled_waiters.rs).
2. **Replenishment during the controller wait.** B is already legitimately waiting behind live A. Thirty-two complete, credential-free HTTP upgrades arrive. B is evicted with `Handshake not finished`, while A still sends encrypted traffic. Evidence: [private-head-independent.log](private-head-independent.log), test `independent_waiting_reconnect_survives_unauthenticated_valid_request_flood`, in [judge_listener.rs](judge_listener.rs).

The implementation validates the HTTP path/query/extensions, **not a credential**, before entering the long wait. Waiters remain `upgrading=true`, participate in oldest-unfinished eviction, and can subsequently consume the sole ready/authentication slot. The wait is excluded from their short unauthenticated I/O budget. Relevant source: [cap/eviction, lines 143–158](https://github.com/Smarty-Pants-Inc/paperclip/blob/6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f/packages/paperclip-runner/runner/crates/runner-core/src/durable/transport/listener.rs#L143-L158), [HTTP validation and admission wait, lines 319–359](https://github.com/Smarty-Pants-Inc/paperclip/blob/6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f/packages/paperclip-runner/runner/crates/runner-core/src/durable/transport/listener.rs#L319-L359), and [ready handover/deadline, lines 377–416](https://github.com/Smarty-Pants-Inc/paperclip/blob/6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f/packages/paperclip-runner/runner/crates/runner-core/src/durable/transport/listener.rs#L377-L416).

This is **not merely the inherited N2 exception for a slow HTTP upgrade under a continuously replenished flood**. The first reproduction uses a finite set of already-complete requests, then releases A, and still denies B while runner-side authentication is being serviced. The second extends eviction exposure to an ordinary fast HTTP reconnect that must wait for A.

**Required correction:** resolve unauthenticated-waiter starvation and eviction of a legitimate controller wait without relaxing the cap or displacing the live writer. Retain both real-auth regressions. If this requires a broader admission/protocol design than the cut permits, return it to the lead for an explicit scope decision; do not treat the existing flood suite as proof of this requirement.

### F2 — A client disconnected during the wait is published into admission

**Required for v2: yes. Likelihood 3 × impact 2 = 6.** Source step: waiter cancellation/ready publication and missing disconnect regression.

A is genuinely authenticated. B sends its complete HTTP upgrade, disconnects while A remains live, and is gone before A releases. On candidate, `endpoint.open` then returns B's dead socket: **`dead_waiter_published=true`**. On M1, the identical test reports **`false` and passes**. The test drops that dead slot and proves a new C can authenticate; it does not claim a permanent leak.

Evidence: [private-head-independent.log](private-head-independent.log), [private-base-disconnect.log](private-base-disconnect.log), test `independent_disconnected_waiter_does_not_claim_released_admission` in [judge_listener.rs](judge_listener.rs).

The condition-variable wait observes stopping, cancellation, generation and timeout, **not TCP disconnect**. After A releases, a local HTTP response write can succeed even though B has already closed; B is then published as ready. The guard releases a reservation when the worker exits, not when the waiting peer disconnects. Source: [reservation guard, lines 274–291](https://github.com/Smarty-Pants-Inc/paperclip/blob/6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f/packages/paperclip-runner/runner/crates/runner-core/src/durable/transport/listener.rs#L274-L291) and [wait/publication, lines 330–390](https://github.com/Smarty-Pants-Inc/paperclip/blob/6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f/packages/paperclip-runner/runner/crates/runner-core/src/durable/transport/listener.rs#L330-L390).

**Required correction:** cancel or revalidate an abandoned waiter before publishing admission, and retain this base-pass/head-fail regression. Preserve the reservation's identity-scoped release. The demonstrated impact is a dead controller admission/extra failed connection attempt or ready-slot delay, **not** two authenticated controllers or an unbounded reservation leak.

## 2. Acceptance inventory and independent verification

| Requested check | Result and evidence |
|---|---|
| Own RED → GREEN on deployed M1 | **Met.** Same independent tests: base **0/2**, both HTTP 503 while A stays live for 300 ms / 2 s; head **2/2**, B authenticates at **342 / 2,041 ms**. A sends encrypted data while B waits. [Base](private-base-independent.log), [head](private-head-independent.log), [identical harness bytes](harness-identity.txt). |
| Candidate's new tests RED on M1 | **Met.** All four waiter tests fail on base: two early HTTP 503 handovers, shutdown/rotation tests because B never waits. They pass in the unmodified candidate suites. [Base](private-base-builder-red.log), [head](head-transport.log). |
| Never two live controllers: A release vs B admission vs C arrival | **Met in 100 actual-auth trials.** B first 97, C first 3. Other upgrade remains pending; only one Runner socket is returned; both subsequent controllers authenticate sequentially and carry encrypted frames. [Log](private-head-independent.log). |
| A never releases | **Met.** B receives **HTTP 503 at 15,000 ms**, not a hang; A sends encrypted frames throughout and afterward. [Log](private-head-independent.log). |
| Unauthenticated flood cannot block legitimate reconnect | **NOT MET — F1**, including finite pre-filled waiters followed by B, and later replenishment after B. |
| Disconnect mid-wait frees admission | **NOT MET — F2.** A disconnected B is promoted into the only ready/controller slot. |
| B does not displace a live writer | **Met at the transport boundary.** Authenticated A remains capable of encrypted traffic during waits, both flood reproductions, and after the 15-second refusal. This is live transport traffic, not a claimed full provider turn. |
| Shutdown and rotation with waiters | **Met.** Independent tests cancel/join **15 waiters** promptly. Rotation rejects **32 old-path requests**, preserves A until release, then admits the new path. [Log](private-head-independent.log), [tests](judge_waiter_lifecycle.rs). |
| Cap, short silent/partial budgets, auth-before-response | **Retained by source and relevant existing checks.** Pending vector is capped at 16 and eviction joins before replacement. Existing total-budget, partial/silent flood and 240-trial deadline-edge tests pass. This does **not** override F1's new waiting-state starvation. |
| Home / minimal / separable on M1 | **Met.** Runner package only; six files, 353 insertions / 46 deletions. Exact one-commit M1 application reproduces the candidate tree without conflicts. |

### Suites, formatting, and typecheck rerun here

Counts are nested, **not additive**: transport contains listener/waiter/flood/deadline checks and is included in durable.

| Check | Result | Evidence |
|---|---:|---|
| Unmodified candidate transport | **45 passed / 0 failed**, including **12 listener tests** | [head-transport.log](head-transport.log) |
| Unmodified candidate durable | **148 passed / 0 failed** | [head-durable.log](head-durable.log) |
| runnerd binary tests | **10 passed / 0 failed** | [head-runnerd.log](head-runnerd.log) |
| `pnpm … typecheck:rust` on candidate | **exit 0**; profile checks, whole Rust workspace fmt, Cargo workspace check | [head-native-typecheck.log](head-native-typecheck.log) |
| Same native typecheck on pristine M1 | **exit 0** | [base-native-typecheck.log](base-native-typecheck.log) |
| Separate Cargo workspace check / edited-file rustfmt | **exit 0 / exit 0** | [head-cargo-check.log](head-cargo-check.log), [head-scoped-fmt.log](head-scoped-fmt.log) |
| Independent eight-test head suite | **6 passed / 2 failed** | [private-head-independent.log](private-head-independent.log) |
| Added finite pre-filled-waiter test | **0 passed / 1 failed; B denied in 3/3 internal trials** | [prefilled-waiters.log](prefilled-waiters.log) |

The original partial/silent replenishment checks admit an initially free controller in **4 / 2 ms** in the transport run. The two unchanged deadline-edge tests each execute **120 trials**, with no ambiguous authentication outcome. Their intentional losing-handshake helper-thread errors and existing compiler warnings remain visible in logs; this is not a zero-warning or zero-helper-panic claim.

## 3. Audit of deleted or weakened assertions

I inspected **every changed test file** and the test include: [test-assertion-audit.diff](test-assertion-audit.diff), [complete patch](change.patch).

- `tests/listener_waiter.rs` is new; its four regressions were copied unchanged to M1 and run RED.
- `listener_tests.rs` replaces the old immediate-rejection test with an authenticated-A test requiring **503 between 15 and 17 seconds**, no second Runner socket, and a successful later retry. This is a deliberate contract replacement, not evidence that old immediate-503 behavior is retained.
- Its stale-handle test replaces immediate 503 with a **pending/Interrupted** upgrade at 100 ms, matching the new contract.
- **`tests/listener_admission.rs` is weakened in specificity:** timeout 1 s → 100 ms, exact HTTP 503 → **any error** for a second connection under flood. It still rejects a second successful upgrade and checks A's encrypted liveness, but it does **not** prove B survives and later reconnects. This omission is part of F1, not a separate score. The new no-flood waiter tests do not fill that gap.
- The existing deadline-edge tests are unchanged. No independent failing acceptance assertion was removed or relaxed to obtain a candidate pass. The disconnected-base harness tolerated `shutdown(NotConnected)` only because M1 had already refused B; the tested no-dead-admission assertion is identical on both revisions.

## 4. Safety predicates and limits

- **False or duplicate notices:** no notice/comment/activity path changes. This item cannot substantiate broader C9 notice-delivery claims.
- **Stale restore/rewind:** no durable restore/lease selection/state journal changes. F2 concerns a stale **socket**, not restored state.
- **Another live owner / proven-gone predicate:** no stop/archive receipt or time-since-stop predicate is introduced. A is not evicted by a waiter; admission requires `active`, `ready`, and `reserved` all absent under one mutex, with a reservation before HTTP 101. The 100 race trials support that invariant.
- **Secret leakage:** no redactor, credential proof, payload logging, or secret-bearing service configuration changes. The common redaction examples are outside this diff; no new redaction claim is made. All added refusal responses are fixed protocol responses, not reflected credentials.
- **Duplicate Paperclip effects:** no command/executor/journal path changes. Existing durable replay/deduplication tests pass, and no simultaneous live controllers were observed. This is bounded transport proof, not universal production certification.
- Authentication protection remains before response send at [transport.rs lines 1041–1081](https://github.com/Smarty-Pants-Inc/paperclip/blob/6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f/packages/paperclip-runner/runner/crates/runner-core/src/durable/transport.rs#L1041-L1081).

## 5. Separability, evidence provenance, and handoff

- **On M1:** zero conflict paths; applying the exact patch to a clean M1 index yields the candidate's exact tree. **On C8 `ad2371a7…`: five conflict paths** (transport docs, admission tests, transport include, listener implementation and listener tests). This is not an M1 separability failure: the item explicitly names deployed M1, and depends on its existing listener. [separability.txt](separability.txt), [c8-cherry-pick.log](c8-cherry-pick.log).
- [Builder RESULT6](builder-RESULT6.md) names local commit `f6fc21c3…`, not the reviewed `6b7ffb02…`; no builder claim is treated as acceptance evidence. All reported checks were rerun against the fetched parent/head.
- An initial shared-target attempt exposed stale cross-worktree Cargo artifacts and was discarded. It is retained under `superseded-cache-attempt/`. Subsequent runs explicitly cleaned the root crate; the final independent checks were repeated in **separate worktree targets**, each root-cleaned before compilation. [Reproduction and provenance](REPRODUCE.md).
- Reusable deliverables: [head harness patch](judge-head-harness.patch), [base harness patch](judge-base-harness.patch), [harness apply checks](harness-apply-check.txt), [machine-readable results](evidence-summary.json), source files and logs linked above. Harness patches modify tests only; the original candidate checkout stayed clean.
- **Not performed:** production Boat replay, a real provider turn, release-image build/deploy, cross-platform qualification, or monorepo TypeScript checks (no TypeScript changes). No claim is made that the hire issue or other C9 items are fixed. These limits do not weaken the reproduced NOT OK result.
- Build/worktree output is removed from scratch after evidence capture; only the kept artifact directory remains. See [cleanup receipt](cleanup.log).
