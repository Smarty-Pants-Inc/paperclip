# Real hire / Boat HTTP row

## Boundary

`hire-port-real-boat-http.test.ts` uses the real Express hire route, its real
lifecycle coordinator/timers, embedded PostgreSQL, the real plugin loader and
worker manager, and a separately built Boat plugin. No plugin call, environment
service, lifecycle effect, or ready agent is substituted. The external Boat and
model APIs are loopback stand-ins. Guest commands, runnerd, Pi, TLS and WebSockets
run for real. The worker entry wrapper only selects Boat's exported test-only
URL-authority file seam, trusts the disposable TLS certificate, and records actual
JSON-RPC error responses without changing the bytes delivered to Core.

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

## Reading evidence and qualification limits

- `REAL_HIRE_HEALTHY`: real A/B state, selected grant, hello count and plugin ID.
- `REAL_BOAT_RPC_LEASE_GONE`: observed real worker error responses, **not** an
  assertion that the worker returned the exact closed-admission-gate message.
- `REAL_HIRE_FAULT`: A/B states, actual harness-cache fields, own lease/receipt,
  provider calls and worker PID before/after. The call assertion starts after
  A's initial release, not at the first earlier ingress RPC failure.

This first real-boundary fixture injects HTTP 503 at A's private-preview endpoint.
The real worker reports JSON-RPC `-32002` with `Runner connection endpoint could
not be acquired (HTTP 503).` It is **not yet the exact** live retirement failure
`Boat sandbox lease is no longer active.` Do not claim exact-case certification
from a green run of this fixture. Capturing that later closed-gate retirement
failure and moving the no-mutation observation boundary to it remains required.

Boat supplies no immutable image identity in this fixture. Core deliberately
records `harnessVerifiedAt = null` / `harnessVerifiedDigest = null`; readiness and
the real model hello prove the test passed, not a reusable harness-cache receipt.
The never-hide control preserves the old baseline's null first-deferral line;
the ported implementation emits the true cleanup-pending sentence. Both must
remain verifying, create no B probe box and write no retirement receipt.
