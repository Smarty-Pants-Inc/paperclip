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
