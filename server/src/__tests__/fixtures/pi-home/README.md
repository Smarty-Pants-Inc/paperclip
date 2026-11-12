# Opt-in full-server native Pi gate

Normal CI leaves `PAPERCLIP_PI_FULL_SERVER_E2E` unset; both real-process tests
are skipped. The gate is Linux-only (`/proc` PID/environment evidence), uses a
loopback scripted model and embedded PostgreSQL, and needs no paid model or keys.
It models an existing-ready agent, not fresh-agent onboarding or a sandbox.

## Reproduce from a committed checkout

Install the repository's pinned Node/pnpm/Rust prerequisites and dependencies
(`pnpm install --frozen-lockfile`, normal lifecycle scripts enabled). Then:

```sh
umask 0022
export PAPERCLIP_PI_GATE_OUT=/absolute/scratch/pi-gate
export TMPDIR="$PAPERCLIP_PI_GATE_OUT/tmp"
export CARGO_TARGET_DIR="$PAPERCLIP_PI_GATE_OUT/cargo-target"
bash scripts/pi-rpc-full-server-gate.sh "$(git rev-parse HEAD)" candidate
```

The script requires a clean checkout at the requested full SHA, builds runnerd
with `--locked -j 4`, runner TypeScript, plugin SDK/shared and server TypeScript,
and runs the official provider-pack lifecycle. It hardens the pack's write
permissions, verifies the fixture's SHA256SUMS, and runs the committed full-server
test via Vitest source aliases. `artifacts.json` binds the exact head, script,
tests, helper, runner binary, server dist, provider pack and fixture manifest.
`latest-run.txt` names the evidence directory with build/gate logs, phases, exit
code and receipt. Evidence remains outside Git; review it before sharing.

`PAPERCLIP_PI_GATE_LOCK` can select a shared build-and-gate lock file (default:
`$PAPERCLIP_PI_GATE_OUT/build-and-gate.lock`). Lock waits report every 30 seconds.
Optional `PAPERCLIP_PI_GATE_DEPENDENCY_SEED` reuses node_modules, rebinding local
workspace links to this checkout. Optional `PAPERCLIP_PI_GATE_CARGO_SEED` copies
compiler caches; the candidate runner is still built, never run from the seed.
Neither seed is necessary on a normally installed CI checkout.

Set `PAPERCLIP_PI_GATE_INCLUDE_STOP=1` to run the independent Stop flow too. Its
session-ID assertion is intentionally the original contract; a Stop-history
product change must update it in that change, not weaken it here. `baseline`
and `part1` modes retain the earlier runner's diagnostic environment switches;
only `candidate` is full strict qualification.

## Fixture decisions (public repository boundary)

* **pi-subagents:** public npm `pi-subagents@0.88.0`. The staged package's 799
  published files were byte-compared to that version's registry tarball. The
  builder verifies its pinned SHA-512 and installs integrity-locked public
  dependencies, omitting optional Pi peers resolved by the native loader.
* **langfuse-pi:** the wrapper contains only public dependencies. Its actual
  plugin's four published files match public npm
  `@langfuse/pi-observability-plugin@0.1.2`. The builder uses that exact package,
  OTel API `1.9.1` and exporter base `0.221.0`, plus the committed integrity lock.
  The wrapper is not an extension; the helper selects the plugin's declared
  entry. LANGFUSE_* keys are removed, and native evidence checks no export POST.
* **tool-cap/index.ts and redact-secrets.ts:** org-internal sources, not in
  this public repository. **Not copied, embedded, downloaded or committed.**
  Without them the full-server test logs an explicit skipped tool-cap
  large-output-persistence leg (300 KB and 1.5 MB); it still tests finish,
  empty durable pending calls and warm turns. This is not full tool-cap proof.
* **agent/settings.json, README.md, SHA256SUMS:** generated from this public
  builder, not copied from a user's home. No auth.json, models.json, provider
  secrets, sandbox settings, client data or private repository bytes are used.

By default the gate calls `scripts/build-pi-e2e-home-fixture.sh NEW_DIRECTORY`.
The builder needs Python 3.12+, npm and public registry access. Every dependency
is pinned by version and integrity in the committed locks; lifecycle scripts
are disabled for fixture-only npm installs (not the official provider pack).
The generated SHA256SUMS includes settings, public packages and dependencies.

To qualify **all** legs with an authorized, externally provisioned home, set
`PAPERCLIP_PI_E2E_HOME_FIXTURE=/absolute/fixture`. Its layout must contain
`agent/settings.json`, `README.md`, `SHA256SUMS` and `pi-packages/{pi-subagents,
langfuse-pi,tool-cap}`; tool-cap requires `redact-secrets.ts`. Package paths in
settings must reference that fixture. Keep private source and evidence outside
this public repository. The gate checks every manifest entry and records the
manifest SHA-256, so the supplied fixture is identifiable without publishing it.
