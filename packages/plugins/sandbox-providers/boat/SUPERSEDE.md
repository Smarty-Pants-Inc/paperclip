# Frozen8 409 supersede-by-replacement (rf2 record)

RFL 11:04Z ruling: replace the two retained old expectations in place; do not change production behavior or waive other failures. Shared helpers are invoked independently by each case through the public execute hook with the non-idempotent `charge-once` command. Keep: #20974 real incident and command replay/data-safety boundary.

## 409-A (formerly boat-409.test.ts:80)
- Old title: `409-A reads the fields nested under error too, and drops unknown or non-closed values`
- New title: `(superseded by replacement: frozen8 F-04D documented not-run recovery, Boat readiness.md:31, rf2 record) 409-A nested/unknown fields recover safely once and remain closed on a second 409`
- Boat doc: `boat-readiness.md:31` requires resume first for stopped/error refusal; :21–22 proves archiving/archived refuses commands; :29 separately authorizes resend for `sandbox_starting`.
- Old assertion: first nested machine-not-running or unknown 409 is surfaced immediately, with closed fields and no recovery.
- New assertion: documented nested not-run or unknown + GET-confirmed archived resumes, observes ready, and resends exactly once; second 409 is `boat_sandbox_state_transition` with only closed fields/no raw body or cause; unknown + GET-ready stays `boat_command_possibly_ran`, never blindly resent.

## 409-B (formerly boat-409.test.ts:153)
- Old title: `409-B machine_not_running with no resume of ours, or long after it, is surfaced without a resume`
- New title: `(superseded by replacement: frozen8 F-04D documented not-run recovery, Boat readiness.md:31, rf2 record) 409-B no/stale OUR resume still recovers safely once, with a named error on a second 409`
- Boat doc: readiness.md:31 (same supplied Boat readiness document) requires resume first without requiring any recent Paperclip-owned resume; :21–22 limits unknown-response recovery to GET-confirmed refusal.
- Old assertion: no prior resume or a resume older than six minutes means one command send, no recovery resume, and a surfaced 409.
- New assertion: independently for no/stale prior resume, documented not-run resumes, observes ready, and resends exactly once; a second 409 gives `boat_sandbox_state_transition` without looping; unknown + GET-ready remains `boat_command_possibly_ran` with one send and no recovery resume.

The supplied documentation input is `/srv/scratch/paul/briefs/boat-sup/boat-readiness.md`; line references above refer to that frozen input, not a claim that the live page is unchanged.

# SUPERSEDE-BOAT-U2-F2-STOPFAIL-1118: review-regressions F2 (Boat unit #2, adopt-boat-stopfail)

Record name requested by adopt-lead; RFL to confirm the name and the ruling. rf-4 U2 F4 asked for this record. Keep: Boat's refused-stop incident of 18 Nov (agents stuck "pausing", repeated POST /stop) and the no-false-receipt boundary.

## F2 (review-regressions.test.ts:42)
- Old title: `F2: a retrying failing stop is not a receipt; only completed settles`
- New title: `F2: a failing stop is not a receipt; Boat's failing stop record returns its refusal at once (PARITY rows 1+2)`
- Changed contract: the plugin used to wait through a `failing` stop until a later read showed `completed` (up to 120 s). It now reads Boat's own stop record (`GET /sandboxes/{id}/stops/{stopId}`, staged boat-llms-full.txt :1785-1789). If the record reads `failing`, it returns Boat's refusal at once. The refusal is the SDK's typed, non-terminal `PluginEnvironmentStopError("recovery_incomplete")`, and the stop is not resent inside a back-off. Boat: a failing stop "is retried until the sandbox archives ... Only a resume ends it early" (:1846-1856), so waiting proves nothing.
- Old assertion: POST /stop 202 `failing`, a GET showing `failing`, then a GET showing `completed` resolves `{state: "stopped"}` after exactly 3 requests.
- New assertion: POST /stop 202 `failing`, then GET /sandboxes/{id} `failing`, then the record reads `failing`. The release hook rejects with `PluginEnvironmentStopError`, whose message carries Boat's `stop.error`, after exactly these 3 requests in order: `POST .../stop`, `GET .../{id}`, `GET .../stops/stop_123`.
- Kept: a `failing` stop is never a receipt (old and new); the stop body is still `{}` (no force).
- Dropped: the old row's eventual `failing` then `completed` progression inside one call. It is now covered by `stop-refusal.test.ts` ROW-4 (pending then completed: same receipt) and ROW-4b (a completed stop after a refusal clears the back-off).
- Ruling: pending RFL confirmation of this record (adopt-lead asks RFL).

## J2 (rf-4's independent judge, `judge-stop-refusal.test.ts`; rf-4 U2b S3, gold 1 x 1)
- Old expectation: an unknown future stop status (`unexpected-future-status`) throws a plain Error whose message reads `... entered unexpected-future-status`.
- New expectation: the same plain Error (not a typed refusal, never a stopped receipt) reads `... entered unrecognised (unexpected-future-status)`. A status outside Boat's closed `[a-z_]` token shape now goes through the one redactor (`providerStatus`), so it is bounded, sanitised and marked unrecognised.
- In-repo row: `stop-refusal-rf4.test.ts` "J2 (superseded wording, SUPERSEDE-BOAT-U2-F2-STOPFAIL-1118)". The judge file itself is rf-4's; its owner updates its J2 string.
- Kept: no false receipt; the error is not `PluginEnvironmentStopError`.
- Ruling: pending RFL confirmation, under this same record.
