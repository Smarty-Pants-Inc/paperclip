# Native Pi managed model metadata

The native driver resolves `paperclip/<id>` capabilities before it creates the
first broker and writes the agent home's `models.json`. The source file is the
snapshot in `PI_CODING_AGENT_DIR`, not a controller home or an ambient credential
store.

Resolution order:

1. An exact-id entry in `providers.paperclip.models` in that snapshot.
2. Otherwise, an exact-id entry on another provider in the same file, in file
   order. This supports snapshots whose connection is named, for example,
   `cliproxyapi-anthropic` rather than `paperclip`.
3. Missing capabilities come from the selected Pi 1.5.2 installation's bundled
   `@earendil-works/pi-ai/providers/all` catalog. All exact-id matches must agree
   on context window, output limit and reasoning support. A thinking-level map
   key is inherited only when every match agrees on that key; snapshot map keys
   override catalog keys, including explicit `null` caps.
4. Unresolved fields use `contextWindow: 128000`, `maxTokens: 8192`, and
   `reasoning: false`, with one bounded diagnostic at initial resolution.

Only `thinkingLevelMap`, `contextWindow`, `maxTokens` and `reasoning` cross from
the snapshot/catalog into the broker descriptor. API, URL and key always come
from the active managed connection/broker, never from the snapshot model or
catalog provider. Names, input types and costs keep Pi's existing registration
defaults. Non-managed snapshot providers and top-level settings remain intact.

The driver retains the resolved descriptor for the resident session. Warm binds
rotate the revocable broker capability, not the model capabilities. The bind
extension passes those same fields into Pi's in-memory registration.

A requested thinking level never constructs a capability map, and no model or
provider family is capped in code. Pi interprets the capability map itself. The
native driver's existing exact-effort admission remains unchanged: it refuses
an unsupported requested effort. The CLI normalization proof (`--thinking max`
with `max: null`) and the driver admission proof therefore use different paths;
the latter requests the supported effective level.

## Focused checks

From `packages/paperclip-runner`:

```sh
pnpm exec vitest run src/drivers/pi src/drivers/acpx/pi-provider-loopback.test.ts src/drivers/acpx/pi-provider-loopback-host.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

The real dependency proof is opt-in and requires an installed pinned Pi 1.5.2
CLI plus a retained evidence directory:

```sh
PI_TEST_BINARY=/absolute/path/to/pi-coding-agent/dist/bundle/cli.js \
PI_MANAGED_MODEL_OUT=/absolute/path/to/evidence \
pnpm exec vitest run src/drivers/pi/pi-managed-model.native.test.ts
```

It checks real `get_state` before any model reset and after a private warm bind,
snapshot caps, catalog limits, explicit overrides, unknown defaults, and two
settled turns through the real native driver. The last leg uses a local
loopback protocol peer, not an upstream account or a simulated Pi runtime.
