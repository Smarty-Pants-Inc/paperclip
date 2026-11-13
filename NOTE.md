# Pi warm reattach: step one, not a PRP shortcut

> Historical implementation/proof notes from source commit `48c7bf23` (base
> `5a7c02f8`), retained as provenance. The rebase onto `8cf648e8` preserves the
> line's quarantine, midturn Stop, notices and `runner.pi.*` timing path. Its
> fresh read-only claim/input admission checks use that same timing mechanism;
> no second request-span route was added. The historical measurements below
> are **not** fresh qualification of the rebased revision. Fresh commands,
> before/after counts and raw evidence are delivered separately with the task.

Tracking: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/4605

## Implemented scope

A prepared resident binding no longer repeats full Pi model/thinking admission
at every same-epoch attach. A genuinely new epoch still binds and fully admits;
cold creation, direct providers, explicit reconnect, terminal capability
revocation, and uncertain-acknowledgement fences are unchanged. Post-claim and
pre-prompt each perform a fresh, read-only native-state proof. They refuse busy
or malformed state, changed native session/model, or drift from the **previously
acknowledged effective** thinking level; they do not silently repair it. A valid
`max` selection previously lowered by Pi to `xhigh` remains valid.

The measured warm path changes from five five-RPC admission batches (25 RPCs)
to one full batch plus those two read-only proofs (7 RPCs): **72% fewer admission
RPCs**. Model and thinking writes fall from five each to one each. This reuses
validated selection, not run authority or a terminal native capability.

The common managed/native Pi extension also observes `before_provider_request`.
It captures wall time inside the hook, reads no request payload, returns no
replacement, and appends an owned, content-free custom entry. Append failures
are fail-open and cannot substitute a model error or leak error contents.
`pi.request.sent` travels through the existing Pi projector, provider diagnostic,
closed TS/Rust timing contracts, and committed-event observer to a deferred
`run.performance.span` under `provider.runtime`. Only runner-origin events for
the observer's captured Pi admission qualify; payload identity claims cannot
authorize them, and an old observer cannot adopt a successor trace. Existing
OpenCode duration spans retain their no-duplicate-write behavior.

**Meaning:** this is a zero-duration **logical pre-dispatch** instant. It is not
confirmation of bytes on the wire, provider success, or one instant for every
internal HTTP retry. A missing hook produces no invented sample. Multiple
invocations in one millisecond remain distinct; this instrumentation does add
one existing-session append operation per observed invocation.

## Identical local before/after proof

Both runs used real runnerd → source proxy → real Pi 1.5.2 → an owned loopback
Messages peer, with one initial and **two** warm turns. The proof, Pi CLI and
Node hashes are identical; source proxy/extension and rebuilt runnerd differ
intentionally. Each run completed all three turns, retained runner/proxy/Pi
process-birth and native-session identity across its warm turns, verified exact
run ownership, durable terminal settlement, and physical retirement. This is a
local fixture qualification, not a remote SMAA or production latency forecast.

Milliseconds, **before → after**, from the same frozen proof:

| Warm turn | Attach | Turn/start return | Attach + turn/start |
| --- | ---: | ---: | ---: |
| warm-1 | 743.4 → 1132.6 | 668.3 → 494.6 | 1411.7 → 1627.2 |
| warm-2 | 1728.3 → 925.5 | 919.2 → 402.3 | 2647.5 → 1327.8 |

Both measured warm turns have 25 → 7 admission RPCs, one private bind and one
begin-turn acknowledgement, and **one PRP authentication callback per warm
attach before and after**. The timing outcome is mixed: one combined warm path
is slower and the other faster. Two single trials do **not** establish a
consistent end-to-end latency reduction; the RPC reduction is directly proved.
The initial candidate turn likewise retains full admission followed by fresh
claim/input proofs; it is not a cold-start shortcut.

The six actual candidate hook entries reached durable runner PRP as six Pi
instants (two for each exact run), preserving original zero-duration timestamps
and only the four allowed span fields. Server run-log persistence and immutable
provider/old-observer attribution are separately exercised through the real
trace writer and installed executor observer, not inferred from the PRP rows.

Private reproducibility receipts are under
`.local/warm-reattach-parent/`: `candidate-pins-v1.json`, `focused-red-job/`,
`proof-before-job-v5/`, `proof-before-v5/`, `verify-rust-job/`, `proof-after-job/`,
`proof-after/`, `request-span-native-validation.json`, and
`before-after-comparison.json`. Raw protocol/session artifacts stay private;
these are not public artifact URLs. The unchanged proof SHA-256 is
`be05634b964513e8b2ebadeff75a10c6f1380dfc14abd6909085fb59a7d93ce2`.

## Next step: a real same-channel PRP contract

**Not implemented or approved as a protocol design in this change.** Keeping a
socket while ignoring the changed run authority is not an optimization. Today
`runnerd-codex-transport.ts` attachment, `durable/runner.rs`
`next_authority_config`, and `durable/transport.rs` correctly require new run
identity/authentication/activation. This step deliberately preserves that path.
See also `doc/plans/2026-11-07-warm-follow-up-ttft.md` and
`packages/paperclip-runner/runner/DURABLE_TRANSPORT.md`.

The next separately designed/reviewed contract must cover the whole transition:

1. Distinguish a retained, company/session-authenticated channel from its
   **per-run** authority. Every successor needs a fresh validated claim/proof;
   an old token, an open socket, or a payload-supplied run ID cannot grant it.
2. Make the activation carry the expected prior identity/generation, exact next
   run/session/turn context and fresh authority. Validate ownership and an idle,
   durably settled predecessor, then atomically install and durably acknowledge
   the new identity. Include an idempotency/reconciliation identity; do not
   interpret a lost acknowledgement as permission to resubmit a prompt.
3. Keep the required native epoch bind and its exact acknowledgement, full
   admission on genuine new epochs, and fresh claim/input state proofs. A stable
   PRP channel alone does not make native binding or validation unnecessary.
4. Attribute every subsequent command/event to the activated run/generation.
   Reject stale callbacks, stale acknowledgements and previous-run work; retain
   durable source-sequence/replay rules, terminal settlement, immediate native
   capability revocation, and physical cleanup. An idle retained channel grants
   no permission to perform work.
5. Reconnect must reauthenticate and reconstruct/prove exact current authority,
   not spend a prior native acknowledgement. Uncertain transitions must reconcile
   authoritative durable state or refuse. Preserve existing cold/config/context,
   released-session and transport-failure behavior; other providers keep their
   current contract. Never silently weaken the existing path for compatibility.
6. Prove the new path with initial plus multiple warm turns, unchanged process
   and native-session identity, correct distinct run attribution, durable and
   physical cleanup, negative stale/lost-ACK cases and allowed legitimate
   lowering/reconnect cases. A warm authentication count of zero must follow
   from the new authorization contract, not suppression of its measurement.

**Saving estimate, not a promise:** candidate provider-facade `run.attach`
round trips were 37, 40 ms. Snapshot-aligned wall/monotonic timestamps put
roughly **555–669 ms per warm turn** between that native-attach
response and the authenticated-connection observer. That observed window is a
useful roughly 0.6-second local opportunity to investigate; it includes
activation/transport/scheduling and is **not an isolated authentication span**.
A retained-channel activation still has required work, so actual savings may be
smaller and are unmeasured. Do not subtract a cold authentication measurement
from production warm latency or promise to remove the reported 1560 ms resume.
Strict submit-only warm behavior needs its own native-authority contract too;
this commit does not claim it.
