# Native Pi managed model metadata

The native driver resolves `paperclip/<id>` capabilities before it creates the
first broker and writes the agent home's `models.json`. It captures the runner's
original Pi config path before overriding `PI_CODING_AGENT_DIR` for the child.

Resolution order:

1. The agent home's snapshot: an exact-id entry in `providers.paperclip.models`,
   otherwise an exact-id entry on another provider in the same file, in file
   order. This supports connections named, for example, `cliproxyapi-anthropic`.
2. Missing capability fields and thinking-map keys come from the original user's
   `models.json`: the explicit original `PI_CODING_AGENT_DIR`, if set, otherwise
   the original `HOME/.pi/agent` (with the process HOME / `os.homedir()` fallback).
   Capture these paths before managed-home projection. The
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
   `reasoning: true`, with one bounded diagnostic at initial resolution. The
   existing all-level thinking-map fallback applies only when the catalog is
   unresolved AND the configured limits/reasoning tuple is incomplete; complete
   explicit configurations do not acquire synthetic map entries.

`compat` follows the same exact-id config selection but has its own API guard:
`model.api ?? provider.api` must equal the API selected by the actual managed
connection protocol (`messages` -> `anthropic-messages`, `chat` ->
`openai-completions`, `responses` -> `openai-responses`). A mismatch skips only
compat, with a bounded diagnostic, and preserves all other capabilities.
Provider/model compat uses Pi 1.5.2's shallow per-field override and its one-level
merges for `openRouterRouting`, `vercelGatewayRouting`, `chatTemplateKwargs` and
`chatTemplateArgs`. No other nested value is recursively blended. Across config
sources, the resulting agent compat wins as a WHOLE field over original-HOME
compat, including `{}`; configured compat similarly replaces catalog compat.

Catalog compat comes only from the exact-id, matching-API model of the canonical
API owner: `anthropic` for Messages; `openai` for Completions and Responses. The
whole object is copied, never a union, intersection, anonymous consensus or the
first provider's flags. Other providers cannot contribute or suppress compat.
Absent canonical id/API/compat is diagnosed and skipped. Copying fallback emits
a bounded diagnostic naming the canonical provider. This does not change the
cross-provider consensus policy for limits, reasoning or thinking-map keys.

Only `thinkingLevelMap`, `contextWindow`, `maxTokens`, `reasoning` and the whole
validated `compat` object cross from the snapshot/catalog into the broker descriptor. API, URL and key always come
from the active managed connection/broker, never from the snapshot model or
catalog provider. Names, input types and top-level costs keep Pi's existing
registration defaults. Compat has no flag allowlist: false, nested null, arrays
and nested cost metadata survive. A shared plain-JSON validator rejects
non-JSON/nonplain values and cycles at configuration and private bind boundaries.
Strict agent config errors refuse startup; optional original-HOME errors skip
that source without altering it. Non-managed snapshot providers and top-level
settings remain intact. The defensive snapshot reread uses the incoming managed
API, so mismatched compat cannot be reintroduced during models.json merging.

The driver retains the resolved descriptor for the resident session. Warm binds
rotate the revocable broker capability, not the model capabilities. The bind
extension passes those same fields into Pi's in-memory registration. Startup
resolution and the defensive reread emit at most one bounded nonleaking line;
warm broker rotation does not reread sources or repeat startup diagnostics.

The ACPX child bootstrap uses this same capability builder with the original
pre-projection environment, even when the caller supplies only model/environment.
It serializes the entire resolved model, not just its id. This legacy ACPX path
has no selected 1.5.2 catalog handoff (its selected Pi is 1.0.0); it uses allowed
original config and documented defaults, never an ambient Pi installation or an
unverified SDK. Catalog-only compat on that legacy path remains unproven and is
not synthesized from model families, URLs, requested effort or another runtime.

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

## Managed compaction reserve

Native `pi_rpc` startup writes `compaction.reserveTokens` to the managed Pi
`settings.json` when no explicit reserve exists. The default is
`min(100000, floor(contextWindow * 0.25))`: 100,000 tokens for a 1M window,
32,000 for the 128k fallback window. Other Pi compaction defaults are unchanged.
An explicit managed-home reserve (including an exact `provider/model` override)
wins; otherwise the original user Pi home's explicit reserve is honored. Only
that token value is imported, not unrelated user settings. Project settings
continue to override agent-directory settings through Pi's normal resolution.
