# Real hire / Boat HTTP row

## Boundary

`hire-port-real-boat-http.test.ts` uses the real Express hire route, its real
lifecycle coordinator/timers, embedded PostgreSQL, the real plugin loader and
worker manager, and a separately built Boat plugin. No plugin call, environment
service, lifecycle effect, or ready agent is substituted. The external Boat and
model APIs are loopback stand-ins. Guest commands, runnerd, Pi, TLS and WebSockets
run for real. The worker entry wrapper only selects Boat's exported test-only
URL-authority file seam, trusts the disposable TLS certificate, and observes actual
JSON-RPC requests/errors without changing protocol bytes delivered to Core or Boat.

## Prerequisites / command

Use Linux with `sudo -n`, `unshare`, `ip`, `sysctl`, `setpriv`, `openssl`, and Node
24. Build the application dependencies, plugin SDK and paperclip-runner package.
Build Boat commit `85a00a62f7d36c3e3b43f08d2fade414d0da3647`
(`0.1.17-spare.6`) in a separate checkout following its README/package scripts.
No provider account or real Boat key is used: the saved fixture secret contains
only `stand-in-only` and the managed AI connection uses loopback/no authentication.

Build runnerd and a provider pack from this application checkout:

```sh
cargo build --release --locked \
  --manifest-path packages/paperclip-runner/runner/Cargo.toml \
  -p paperclip-runner-core --bin paperclip-runnerd
node packages/paperclip-runner/scripts/build-provider-pack.mjs "$PACK"
# Executable binding refuses group/world-writable artifact directories.
chmod -R go-w "$PACK"
```

Set absolute artifact paths (do not substitute paths into tracked files):

```sh
export TMPDIR="$(mktemp -d)"
export PAPERCLIP_HIRE_BOAT_PACKAGE="$BOAT_CHECKOUT/packages/plugins/sandbox-providers/boat"
export PAPERCLIP_RUNNER_BINARY="$RUNNER_TARGET/release/paperclip-runnerd"
export PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH="$PACK"
cd server
bash src/__tests__/fixtures/hire-boat-namespace.sh \
  ../node_modules/.bin/vitest run src/__tests__/hire-port-real-boat-http.test.ts \
  --retry=0 --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

The launcher creates disposable mount, network and PID namespaces, preserves the
caller's user identity, maps the private Boat preview hostname only inside that
namespace, and prevents its guest path or hosts-file changes touching the host.
PID-namespace teardown also removes any orphan guest process. Scratch data stays
under `TMPDIR`. Optional `PAPERCLIP_HIRE_BOAT_GUEST_ROOT` reuses prepared guest data.
The provider pack is preinstalled, but the normal runtime verifies its bytes and
stages the actual runner binary through the real Boat HTTP file protocol.

## Deterministic closed-gate row

The stand-in holds the first real evidence-manifest command response through the
probe's normal cleanup deadline. The test waits for an observed
`environmentReleaseLease` request for A's provider lease before returning a failed
command result. This prevents retirement completing before the real release.
Boat closes its own admission gate and drains that command before POST `/stop`.
The stand-in holds the stop response, so Core's database lease remains active
while Boat's gate is CLOSED. No plugin state or retained-cleanup entry is planted.

While that stop response is held, the test joins Core's real retained-cleanup
reconciler for A's grant. It retries the actual callback retained by A's probe;
no replacement callback, RPC, lease, or service is manufactured. The worker must
return exactly `{code:-32002,message:'Boat sandbox lease is no longer active.'}`
on `environmentExecute` for A's own provider lease. The observation window starts
at the worker's monotonic emission timestamp, not when the test notices it.
Only then is the already-issued stop allowed to finish. A real HTTP hire B on the
same grant must become ready without restarting the app or Boat worker. No new
mutation request for A's box is permitted after that rejection; read-only typed
inspection and completion of the already-issued stop response are permitted.

- `REAL_BOAT_RELEASE_BARRIER`: the real release request that opens the held
  command response barrier (not a fabricated plugin lifecycle transition).
- `REAL_BOAT_GATE_REJECTION`: exact real JSON-RPC error, request method, provider
  lease ID and monotonic receive/emission timestamps.
- `REAL_HIRE_HEALTHY`: real A/B state, selected grant, hello count and plugin ID.
- `REAL_BOAT_RPC_LEASE_GONE`: the separate ingress-503 controls, whose message is
  `Runner connection endpoint could not be acquired (HTTP 503).` They are not
  substitutes for the closed-gate row.
- `REAL_HIRE_FAULT`: mechanism, boundary timestamp, A/B states, actual
  harness-cache fields, own lease/receipt, provider calls and unchanged worker PID.

Each case owns a fresh real app/database/Boat worker. This prevents a previous
case's legitimate scheduled A retry from creating boxes inside another case's
never-hide window. A and B always share the same uninterrupted app/database and
worker within their case; the PID assertion enforces no A-to-B restart.

The whole file includes healthy A/B, stopped and ACTIVE closed-gate cases, and
both original ingress-503 controls. Run it three consecutive times at the fixed
head with zero retries. Copy these exact test/helper files to baseline `c3c15054`:
B must remain verifying in the stopped fault row (the ready assertion goes red),
while healthy and never-hide controls remain green. Disabling only the
`entry.proveRetired` branch in `retained-ai-credential-cleanup.ts` must likewise
leave B verifying and turn the stopped fault row red. Restore that mutation;
product source is not part of this test-only change.

Boat supplies no immutable image identity in this fixture. Core deliberately
records `harnessVerifiedAt = null` / `harnessVerifiedDigest = null`; readiness and
the real model hello prove the test passed, not a reusable harness-cache receipt.
The never-hide control preserves the old baseline's null first-deferral line;
the ported implementation emits the true cleanup-pending sentence. Both must
remain verifying, create no B probe box and write no retirement receipt.
