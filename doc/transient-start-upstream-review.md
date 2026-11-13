# Transient start recovery: upstream comparison

## How Paperclip intends it

This is a repair of existing recovery, not a plugin or a second scheduler.
`AGENTS.md:90-103,180-188` keeps behavior with its owner and requires a behavioral
RED/GREEN. `doc/execution-semantics.md:1331-1367` separates committed model-capacity
failures from pre-turn bootstrap. `doc/DEVELOPING.md:733-736` documents the two
capacity retries, not a general permission to replay a turn.

- `heartbeat/retries.ts:508-576,815-856` owns scheduled retries, their reason,
  maximum attempts, admission and transactional predecessor/successor claim.
- `execution-recovery-attempt.ts:12-20,104-133` separates uncharged resource waits
  and interrupted preparation from the failed-turn budget.
- `native-runtime/native-startup-retry.ts:100-142` plans the existing same-run
  bootstrap coordinator's next deadline. It is not a new retry owner.
- `native-runtime/native-provider-capacity-retry.ts:21-72` owns the narrower
  committed Codex capacity continuation, with a fresh session and no consumed
  input replay. It is inappropriate for an ambiguous startup or arbitrary 4xx.
- Run-dispatch's `scheduledRetryReason` gates recheck task/owner/pause/dependency
  authority at promotion and claim. Recovery never borrows authority from a wait.
- `doc/execution-semantics.md:2080-2120,2160-2167` describes liveness/stranded
  sweeps: one bounded continuity repair, then a board-owned
  `issue_recovery_actions` hold, preserving the assignee. Native coordinator
  exhaustion produces the existing `active_run_watchdog` recovery action;
  stranded work uses `stranded_assigned_issue`. A notice is not a continuer.
- `doc/DEVELOPING.md:1120-1136` keeps cleanup, owner proof and durable recovery
  separate. No new timer, loop, table, or recovery owner is needed for this fix.

## Upstream already does

Upstream master was fetched from `https://github.com/paperclipai/paperclip.git`
(the initial shared-object fetch failed; an isolated shallow fetch succeeded).
The inspected tip is `12aa08721c8a9e343f2e311cfec841a9eba6d3d0`.

1. [`22c9300da`](https://github.com/paperclipai/paperclip/commit/22c9300dace1d5f295d9ef9567a99f6ff2ec3cc5)
   types a *provider launch-artifact gate* failure as
   `native_failed_before_provider_turn`. Only the runner ledger's positive
   no-turn proof admits it. The executor quarantines its session root and the
   existing predecessor-retirement fallback marks the reusable lease
   `replaceBeforeReuse`, then uses **`interrupted_preparation`**, capped at 12.
   It preserves abandoned files instead of claiming they are unchanged.
   Scope: remote OpenCode/controller-persistence gate. It does **not** classify
   a CREATE 429, native transport-closed startup, session.open 503, or a fresh
   ingress that never authenticated. Do not cherry-pick a broad ledger exception
   into those unrelated paths without equivalent evidence.
2. [`566843820`](https://github.com/paperclipai/paperclip/commit/566843820c61215aecab62fbc84c9e64aadd1b70)
   continues recent (24-hour) **board-owned `stranded_assigned_issue`** holds
   under the assigned-work sweep's existing per-task cap/spacing. Closed
   restart-class codes and bootstrap-only setup failures qualify;
   `environment_provider_unavailable` and typed transient saved-sandbox resume
   failures are included. It also lifts a recovery-owned block behind a live
   continuation, never a person's block, and improves notices. It does not
   introduce an indefinite pre-allocation message wait or a three-start cost cap;
   it does not replace the native `active_run_watchdog` owner.
3. [`c73087297`](https://github.com/paperclipai/paperclip/commit/c730872974550a4319c9600e1ba1e4bc3f4327c9)
   preserves committed chat finalization and reads the durable conversation wait
   so a completed turn awaiting the person is not restarted. Our startup work
   must never treat that wait as stranded.
4. [`5ede64f24`](https://github.com/paperclipai/paperclip/commit/5ede64f24)
   settles an older run's saved-work hold. Keep upstream's saved-work and owner
   proof; a retry does not make unsaved files disposable. The plain-word notices
   in #21336/#21348/#21406 belong to that recovery/presentation work, not an
   alternate start scheduler.

### Merge-down deletion/adoption list

- **Adopt upstream unchanged** for its launch-artifact gate classification,
  session-root quarantine, `replaceBeforeReuse` cleanup/preservation proof,
  `interrupted_preparation` continuation and queued-task presentation. No
  equivalent implementation of that class exists in `bed3b63e`; nothing to
  delete for that exact class.
- **Adopt upstream unchanged** for recent stranded-hold continuation, block
  attribution/release, and recovery notice wording. Do **not** add a second
  stranded sweep or duplicate that class in `transient_start_wait`.
- **Delete `bed3b63e`'s native no-cap waivers**, rather than carry them into
  merge-down: the failure disposition, admitted-attempt guard and restart
  classifier all must retain the native three-attempt ceiling. This task fixes
  those waivers now because they spend starts.
- **Delete `bed3b63e`'s fixed five-minute class-(i) schedule** in favor of the
  requested 15s -> 300s backoff. Keep its existing scheduled retry owner, durable
  message identity and `scheduled_retry` marker. Upstream's later stranded
  recovery is a safety net, not a reason to escalate free pre-allocation waits.
- Keep native same-run classification only for its existing positively proven
  bootstrap scope; do not relabel an unproven remote session.open rejection.
  When merge-down generalizes the upstream ledger-based fresh-box mechanism to
  a proven transport failure, prefer it and remove the overlapping local
  classifier/coordinator special case. That generalization is **not** claimed
  to be in these upstream commits, and is not silently implemented tonight.
- Fresh ingress recovery should use the existing bounded
  **`interrupted_preparation`** lane and normal lease replacement/cleanup, not a
  new lane. Its scope must prove fresh allocation and no provider turn; unknown,
  retained, authenticated, and productive failures keep their existing fences.

## Missing classifications at the input revision

| Failure | Existing intended owner | Input-revision gap |
| --- | --- | --- |
| Acquire refused before any allocation, structured 429/5xx/errno/deadline | Scheduled bootstrap retry; human-message `transient_start_wait` | Fixed 300s instead of 15s ramp; needs free/paid split and class/attempt evidence |
| Exact startup transport close; typed local startup 503 | Native same-run bootstrap coordinator | `bed3b63e` waives all three-attempt guards; remove the waivers |
| Fresh allocation whose ingress never authenticates | Existing interrupted-preparation scheduled successor + normal lease cleanup | Not classified as a safe fresh-box failure; ingress loop uses wall budget alone |
| Mid-turn provider error after tool work | Provider-owned retry of the failed request in the same session; otherwise exact-checkpoint recovery with side-effect reconciliation | Inventory only; generic model-capacity replay is not safe or sufficiently general |

Previous-release state remains readable. Older native human-message waits lose
only their unsafe budget waiver; no identity or checkpoint is reset. Unknown
saved state and unproven remote ownership remain permanent/held as before.
