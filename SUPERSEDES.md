# Superseded Stop rows

Authority for **every row below**: **RFL 08:27Z 11-16 ruling 1**. Upstream [#21788](https://github.com/paperclipai/paperclip/pull/21788), commit `f71aa135a0d52a1f86b81bb2a1f3e10db6bf4cde`, stands: pending Stop work records a named reason and keeps retrying, never automatically parks. These eight rows are **SUPERSEDED BY REPLACEMENT**, not waived. No production Stop code changed.

| Original file / exact expanded test name | Disposition / replacement |
| --- | --- |
| `stop-retry.test.ts`: `backs off pausing pending Stop then parks across restart until explicit Retry` | Removed. Replaced by upstream `pending-backoff.test.ts`: `records why termination is waiting and spaces out its passes` and `finishes a stop at once when its blocker clears, without waiting out the backoff` (11 passes, capped backoff, automatic completion). |
| `stop-retry.test.ts`: `backs off terminating pending Stop then parks across restart until explicit Retry` | Removed; same upstream replacement. |
| `stop-retry.test.ts`: `backs off cleaning_up pending Stop then parks across restart until explicit Retry` | Removed; same upstream replacement; retained plugin row below also exercises cleaning_up through 11 passes and automatic completion. |
| `stop-retry.test.ts`: `bounds a legacy pausing loop with 235 prior claims even without a saved Stop budget` | Removed; same upstream replacement; old claim counts do not impose an automatic park. |
| `stop-retry.test.ts`: `bounds a legacy terminating loop with 42 prior claims even without a saved Stop budget` | Removed; same upstream replacement. |
| `stop-retry.test.ts`: `names the real blocking invocation in a parked Stop error, without treating cancellation as proof` | Adjusted to `names the unproven stop reason while retrying, without treating cancellation as proof`: 11 passes, `legacy_stop_unproven`, no retryRequired, still pending, cancelled status alone is insufficient; acknowledged cancellation completes without operator Retry. |
| `stop-retry.test.ts`: `bounds a required cleanup plugin without replaying a completed host stop` | Adjusted to `retries a required cleanup plugin without replaying a completed host stop`: 11 passes, `plugin_step_pending`, no retryRequired, host called exactly once; plugin completion automatically reaches terminated. |
| `driver-scope.test.ts`: `pauses only the requested agent without loading its company peers` | Adjusted only the obsolete `onPending` callback expectation. Retains target-only stop, exact one update, preserved deferred work and no peer lookup. Upstream returns its named blocker instead. |

Paths above are under `server/src/modules/agent-lifecycle/__tests__/`. All other rows in these files are unchanged, including explicit operator parks, old-park diagnostics, thrown-failure secret safety, stale-result fencing and deferred-work checks. Only automatic parking of a pending Stop is superseded.

Fresh receipts: task artifacts `tests/red-stop/` (7+1 failures before changes), `tests/item1/` and `tests/item1-final/`. Upstream #21788's `pending-backoff.test.ts`, `heartbeat-lease-release-before-runner-attach.test.ts`, and `heartbeat-terminate-pending-native-retry.test.ts` are unedited and green. The first adjusted invocation test attempt expected an invocation string; observed upstream reason was `legacy_stop_unproven`. That failed attempt is retained in `tests/item1/`; final assertions use the named upstream reason, retaining the cancellation proof check.
