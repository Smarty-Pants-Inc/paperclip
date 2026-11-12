# Native Pi managed model metadata

The native driver resolves `paperclip/<id>` capabilities before it creates the
first broker and writes the agent home's `models.json`. It captures the runner's
original Pi config path before overriding `PI_CODING_AGENT_DIR` for the child.

Resolution order:

1. The agent home's snapshot: an exact-id entry in `providers.paperclip.models`,
   otherwise an exact-id entry on another provider in the same file, in file
   order. This supports connections named, for example, `cliproxyapi-anthropic`.
2. Missing capability fields and thinking-map keys come from the original user's
   `models.json`: the runner's inherited `PI_CODING_AGENT_DIR`, if set, otherwise
   its original `HOME/.pi/agent` (with `os.homedir()` as the HOME fallback). The
   same exact-id/provider precedence applies within this file. This optional
   source is read-only; missing, unreadable, oversized or invalid user config is
   skipped with one bounded diagnostic, not a startup refusal. Agent-snapshot
   validation remains strict. Routing, authentication and other user settings
   are never imported into the managed home.
3. Remaining capabilities come from the selected Pi 1.5.2 installation's bundled
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
settled turns through the real native driver. It also reproduces the original
HOME-only layout with no runner `PI_CODING_AGENT_DIR`: the cap exists only under
`HOME/.pi/agent/models.json`, with a separate managed agent home. A launch hook
adds `--thinking max` to observe Pi's first state before admission; the driver
requests the supported effective effort (`xhigh` with the cap, `max` without).
Both cases retain their capabilities after warm attach/rebind and leave the
user file unchanged. Driver turns use a local loopback protocol peer, not an
upstream account or a simulated Pi runtime.
