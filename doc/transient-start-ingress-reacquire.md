# Reacquire the route on the same sandbox before giving up

## Use the existing provider feature first

The SDK already documents `onEnvironmentRunnerIngressEndpoint`: “Return an
authenticated private WebSocket ingress for runnerd”
([SDK declaration, lines 464–467](https://github.com/Smarty-Pants-Inc/paperclip/blob/30ec32178c9e64c6cdf89c0566c2d6bb14dc33c2/packages/plugins/sdk/src/define-plugin.ts#L464-L467)).
The existing endpoint contract exposes `refresh()`
([lines 11–18](https://github.com/Smarty-Pants-Inc/paperclip/blob/30ec32178c9e64c6cdf89c0566c2d6bb14dc33c2/packages/adapter-utils/src/runner-connectivity.ts#L11-L18)).
The runtime's `acquire()` calls `environmentRunnerIngressEndpoint` with the
captured company, environment, provider lease, port and path, and returns
`refresh: acquire`
([runtime, lines 3152–3217](https://github.com/Smarty-Pants-Inc/paperclip/blob/30ec32178c9e64c6cdf89c0566c2d6bb14dc33c2/server/src/services/environment-runtime.ts#L3152-L3217)).
Use that closure; do not allocate a box to repair a route.

This is a genuine outbound-loop bug fix, not a new plugin seam. Upstream
`e82c4f0a318d979632550bb304547d134ff82d6d` still invokes `endpoint.refresh()` only
in its HTTP 401/403 branch. The existing feature is sufficient, but that loop
misses transport failures. Follow the upstream `prepare-paperclip-pr` skill
for the core fix; local commits are not an upstream PR or release qualification.

## Transport retries and the counted attempt floor

Timeouts, refusals and HTTP 5xx reacquire the route before another handshake.
The ordinary jittered base spacing is 1/1/1/2/5 seconds (actual jitter factor
0.75–1.25). When the extra 1-second base would consume the remaining budget,
retain the original 250/500ms cold-start cadence instead. This preserves the
existing real-TLS test: a route available at 200ms must be usable within its
750ms startup budget. Refresh never resets the original episode deadline.

Actual socket construction, not elapsed time or a synthetic retry counter,
counts toward the minimum. Normal 60-second startup and seven-minute recovery
budgets reserve three actual dial opportunities. Explicit shorter budgets
retain a smaller minimum:

`minimum = clamp(ceil(configuredBudgetMs / 15000), 1, 3)`

Thus the existing explicit 600ms logging and 1-second stalled-handshake fixtures
remain hard-budget checks, rather than silently becoming 30-second tests. The
minimum is a transport-dial policy, not an unconditional promise across every
failure class. Authentication failure, known connection-lease expiry,
cancellation, invalid endpoints, and a provider refresh that exhausts its own
operation deadline do not receive a missing-attempt extension. In particular,
a hung provider operation is not permission to start overlapping refreshes.

If an eligible dial or a backoff is overtaken by the original deadline before
the minimum has run, each missing attempt receives a 15-second repair/dial
window, without another catch-up sleep. A stall before socket construction
also cannot count an unmade attempt. The count is reset only after an
authenticated connection closes and a new recovery episode begins. At most two
additional dials/route repairs follow an already attempted dial. Each handshake
and refresh wait is capped at 15 seconds in this late floor; the count prevents
unbounded deadline renewal. A blocked JavaScript event loop still defeats any
strict elapsed-time upper bound, and can delay those timers. This is not a
claim of an inviolable wall-clock deadline or a global no-burst guarantee.

## Authentication and lease-expiry exclusions

The existing documented exclusion is preserved: “Authentication and lease-expiry
failures do not enter the new transport-refresh branch”
([previous document, lines 17–18](https://github.com/Smarty-Pants-Inc/paperclip/blob/30ec32178c9e64c6cdf89c0566c2d6bb14dc33c2/doc/transient-start-ingress-reacquire.md#L17-L18)).
Check the authority's known expiry at the failed attempt and again after
backoff, so learning of expiry while a timer is pending cannot initiate a route
refresh. Retain the named `runner_connection_lease_expired` terminal reason.
This does not treat Stop/ARCHIVED age or a lease-expiry notice as proof that a
different owner is gone. Known expiry also fences HTTP 401/403 credential
refreshes; the original credential-refresh behavior is otherwise unchanged.

## No-new-box regression and qualification limits

`runner-prp-outbound.provider.test.ts` exercises the real environment runtime's
capability gate and returned acquire/refresh closure, with a controlled external
plugin worker and transport. Cold and warm recovery both require:

- provider create = 0, start/resume = 0, route acquisition = 2;
- the exact same company, environment, issue, provider lease, port and path on
  both route calls;
- use of the repaired URL and authentication through the same PRP authority.

Injecting a forbidden `environmentAcquireLease` into that closure makes both
counter checks fail with create = 2 and start = 2. The endpoint itself is not
stubbed. This proves the host call boundary with the controlled provider, not
Boat's internal behavior or a real daily-work conversation. A provider hook may
start **the same** existing sandbox; for example Daytona calls
`ensureSandboxStarted`. Do not infer provider-side read-only behavior merely
from the RPC's name, or claim that this test qualifies a Boat image.

The original multi-attempt logging assertions are restored exactly: two records
and attempt numbers `[1, 2]`. The original real-TLS suite is unchanged. The
supplied independent judge retains every assertion and test body; only three
relative module references change. Vitest includes it in the normal server
suite from `ingress-regressions/`. It stays outside the product TypeScript
program because its supplied slow-refresh fixture has an existing
`Promise<unknown>` inference error. No previously checked product test is
excluded or its assertion weakened to accommodate it.

From `server/`, run each file separately with `--maxWorkers=2`:

```sh
pnpm exec vitest run src/realtime/runner-prp-outbound.test.ts --maxWorkers=2
pnpm exec vitest run src/realtime/runner-prp-outbound.native.test.ts --maxWorkers=2
pnpm exec vitest run src/realtime/runner-prp-outbound.retries.test.ts --maxWorkers=2
pnpm exec vitest run src/realtime/runner-prp-outbound.provider.test.ts --maxWorkers=2
pnpm exec vitest run ingress-regressions/judge-ingress.test.ts --maxWorkers=2
```

The existing refresh deadline race stops waiting; it does **not** cancel the
underlying provider operation. Existing immediate HTTP 401/403 retries and
multiple handles are not globally rate-limited. No fresh-box retirement,
replacement accounting, checkpoint restore, listener-capacity qualification,
live provider qualification or image build is included in this fix.
