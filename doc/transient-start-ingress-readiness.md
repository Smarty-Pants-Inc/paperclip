# Initial ingress readiness after delayed event-loop service

This is a narrow transport-readiness fix, not a fresh-computer recovery claim.

The default initial provider-ingress connection now waits for both the existing
60-second startup budget and at least three connection attempts before reporting
`runner_ingress_unavailable`. An event-loop stall can consume the time budget
before queued connection errors are delivered. Each owed attempt then gets a
15-second handshake window. The attempt constants live beside the 60-second
constant in `server/src/realtime/runner-prp-outbound.ts`.

Authentication rejection does not earn extra attempts. Explicit caller-supplied
hard deadlines (including retained-owner route reopening), cancellation, and
recovery after an authenticated connection remain fixed-budget. No allocation,
lease, process, provider session, retry lane or ownership rule changes here.

RED: the two delayed-event-loop cases in `runner-prp-outbound.test.ts` made only
one attempt on the prior code. GREEN: the third connection can authenticate;
a permanently unavailable route stops after the third delayed attempt. Existing
short-deadline, credential, cancellation, reconnect and liveness tests still run.

Still required for the full fresh-box ingress request: prove a genuinely fresh
allocation and never-issued provider commands, settle its remote workspace and
native ownership through the existing recovery/cleanup authorities, release the
failed box, and schedule a capped replacement which answers the original
message. This readiness fix alone does **not** implement or prove that flow.
