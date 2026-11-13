# Reacquire the route on the same sandbox before giving up

The existing endpoint refresh is the feature to use first. In
`server/src/services/environment-runtime.ts:3032-3097`, `acquire()` calls the
sandbox plugin's `environmentRunnerIngressEndpoint` RPC and the returned
endpoint exposes `refresh: acquire`. Recalling it re-registers the route for
that same provider lease; it does not start, resume or allocate another box.

Before this fix, `server/src/realtime/runner-prp-outbound.ts` refreshed only
HTTP 401/403 credentials. A timed-out or refused handshake retried the stale
route. The connection-error path now refreshes after a jittered backoff with
a 1-second minimum base (instead of 250/500 ms), rising to 5 seconds, before
the next handshake. This spaces out repairs to avoid feeding a serial listener's
backlog. One refresh is allowed per
failed connection attempt, within the unchanged startup/recovery deadline.
It also applies to reconnecting an already-authenticated warm session without
replacing its authority or conversation. Authentication and lease-expiry
failures do not enter the new transport-refresh branch. Refresh does not reset
the deadline. A stalled refresh terminates at that deadline.

This change remains under 40 production-line changes, independently
of the initial readiness attempt-floor change. It needs no fresh-box machinery.
RED: a fake same-box route times out/refuses while only a refresh can repair it;
both new cold-route tests fail with `runner_ingress_unavailable` before the
change (34 existing tests pass). GREEN: cold and warm timeout/refusal cases
authenticate after one refresh; the stalled-refresh negative stays bounded.
These are mocked transport tests, not evidence from an actual sandbox plugin
or a daily-work conversation.

This is only step 1 of ADDENDUM9/10. It does not implement fresh-box retirement,
three-paid-start accounting across replacements, or checkpoint cold restore
of a fenced warm session. Those remain separate acceptance gates. In particular,
this commit must not be presented as a complete fresh-box replacement fix.
