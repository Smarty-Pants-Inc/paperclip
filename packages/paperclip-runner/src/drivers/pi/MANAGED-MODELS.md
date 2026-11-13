# Native Pi managed model metadata

The native driver resolves `paperclip/<id>` capabilities before it creates the
first broker and writes the agent home's `models.json`. It captures the runner's
original Pi config path before overriding `PI_CODING_AGENT_DIR` for the child.

Resolution order:

1. The agent home's snapshot: an exact-id entry in `providers.paperclip.models`,
   otherwise an exact-id entry on another provider in the same file, in file
   order. This supports connections named, for example, `cliproxyapi-anthropic`.
2. Missing model-definition fields and thinking-map keys come from the original user's
   `models.json`: the explicit original `PI_CODING_AGENT_DIR`, if set, otherwise
   the original `HOME/.pi/agent` (with the process HOME / `os.homedir()` fallback).
   Capture these paths before managed-home projection. The
   same exact-id/provider precedence applies within this file. This optional
   source is read-only; missing, unreadable, oversized or invalid user config is
   skipped with one bounded diagnostic, not a startup refusal. Agent-snapshot
   validation remains strict. Routing, authentication and other user settings
   are never imported into the managed home.
3. Remaining fields come from the selected Pi 1.5.2 installation's bundled
   `@earendil-works/pi-ai/providers/all` catalog. Prefer the exact-id,
   matching-API entry of the canonical API owner (`anthropic` for Messages,
   `openai` for Completions/Responses), otherwise the first exact-id entry in
   Pi's catalog order. Copy the whole winning definition, not a synthesized
   cross-provider consensus. Snapshot thinking-map keys override catalog keys,
   including explicit `null` caps.
4. Unresolved fields use `contextWindow: 128000`, `maxTokens: 8192`, and
   `reasoning: true`, with one bounded diagnostic at initial resolution. The
   existing all-level thinking-map fallback applies only when the catalog is
   unresolved AND the configured limits/reasoning tuple is incomplete; complete
   explicit configurations do not acquire synthetic map entries. `input` comes
   from the selected model definition, then its source provider's explicit input,
   then the exact-id catalog capability. An unknown model with no declared image
   capability gets `["text"]` and an image-capability diagnostic in the same
   bounded initial-resolution line. No model-family guess enables images.

`compat` follows the same exact-id config selection but has its own API guard:
`model.api ?? provider.api` must equal the API selected by the actual managed
connection protocol (`messages` -> `anthropic-messages`, `chat` ->
`openai-completions`, `responses` -> `openai-responses`). A mismatch skips
`compat`, `samplingParams` and `samplingParamsByThinkingLevel`, with a bounded
diagnostic, and preserves API-neutral metadata.
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
a bounded diagnostic naming the canonical provider. Noncanonical catalog entries
supply only API-neutral fields.

The whole model definition crosses the broker and private bind boundaries.
There is no capability allowlist: `input`, names, costs (including tiers),
`inputLimits`, prompt-cache settings, thinking maps and future JSON metadata
survive. At every projection, model routing/auth fields (`provider`, `baseUrl`,
`headers`, `api`, `apiKey`, `authHeader`, `auth`, `oauth`) are removed. Provider
API, URL, key, headers and authentication are never copied; the managed provider
is built independently from the active connection and revocable broker token.
The model id remains the upstream id, selected under the `paperclip/<id>`
provider namespace. Registration defaults fill absent fields only. A shared
plain-JSON validator rejects non-JSON/nonplain values and cycles at configuration
and private bind boundaries.
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
pnpm exec vitest run src/drivers/pi/pi-managed-definition.test.ts --maxWorkers=2
pnpm exec vitest run src/drivers/pi/pi-managed-compat.test.ts --maxWorkers=2
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

The J1 image-loss regression exercises the real native driver, data-URL input
parser, staged attachment read, real Pi 1.5.2 and loopback broker. It captures the
outbound provider request and requires exactly one PNG image block (not merely
an image in the Pi RPC command). Both forms fail on the original text-only
projection. Run it separately on memory-constrained hosts:

```sh
PI_TEST_BINARY=/absolute/path/to/pi-coding-agent/dist/cli.js \
PI_MANAGED_IMAGES_OUT=/absolute/path/to/evidence \
pnpm exec vitest run src/drivers/pi/pi-managed-images.native.test.ts --maxWorkers=2
```
