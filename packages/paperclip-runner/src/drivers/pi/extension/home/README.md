# Native home admission

This module contributes `BindReceipt.homeDigest`. It does not commit a bind, admit
prompts, verify the provider/model readback, or replace the driver's error fence.

## Composition

Use the bind extension's existing registration seam; no upstream Pi hook or guard
package change is needed. In the extension factory, before `session_start`:

```ts
import { VERSION } from "@earendil-works/pi-coding-agent";
import { registerNativeHome } from "./home/register.js";

registerNativeHome(pi, registerHomeAdmission).configure({
  piVersion: VERSION,
  collect: collectNativeHomeForResident,
});
```

`collectNativeHomeForResident({sessionId, signal})` returns
`{manifest, required, environment}`. Build the manifest with
`computeNativeHomeManifest` inside the resident. Supply the launcher's approved,
immutable native package roots, exact versions, distribution digest, selected
resources, trust policy and sanitized native metadata. Do not guess npm roots or
use a Runner-side filesystem mirror. Pass `pi.getSettings().packages ?? []` and
`pi.getSettings().extensions ?? []` as `effectivePackages` and
`effectiveExtensions`. The registrar independently reads `pi.getSettings()` at
bind, so a collector cannot replace actual effective selection with a claim.
Only package source, extension selection and `autoload` are retained from those
settings; other settings are not copied into the receipt.

The exact seam type is:

```ts
registerHomeAdmission(fn: (input: {
  sessionId: string;
  epoch: number;
  runId: string;
  signal: AbortSignal;
}) => {digest: string} | Promise<{digest: string}>): () => void;
```

An unconfigured registration rejects. Collection happens at the initial native
`session_start`, after extension factories have loaded. Each bind builds fresh
in-process load facts for the current session and rechecks the startup manifest's
settings, package/dependency bytes and admitted model metadata. New/resume/fork sessions reuse
that startup identity, not a newly collected package identity attributed to old
factories. Session changes and cancellation during admission reject the result.
`/reload` requires restarting the resident: the initial CLI fatal-startup rule is
not evidence about nonfatal reloads. Quit/reload removes the old contributor;
`dispose()` is also available for factory-owner cleanup.

## Load proof

1. The receipt records `startup: {rule: "startup-fatal", piVersion: "1.5.2"}`.
   No other Pi version is accepted. In that CLI, an import/factory error exits
   before RPC starts.
2. Exactly one guard (`tool-context-guard` or `tool-cap`) and `pi-subagents` must
   match the declared roots and versions, effective settings and admitted file
   closure. Disabled, missing, duplicate, changed or unresolved selections reject.
3. `pi.getAllTools()` must expose exactly one `subagent` whose loader-owned
   `sourceInfo.baseDir` realpath equals the admitted pi-subagents root. Active-tool
   membership is irrelevant. The path-only fallback must itself resolve to that
   root; a familiar filename or substring does not establish ownership.
4. Pi 1.5.2 has no public in-process `extension_error` subscription. The receipt
   explicitly records `not observable in-process`. The driver must observe RPC
   errors from process birth, correlate required-package paths and fence admission
   on an error since session start. The arbitrary `pi.events` bus is not that
   runtime error stream.

Literal explicit package entries are supported. Wildcard/complex required-package
filters fail closed rather than duplicating Pi's resource resolver. Negative
non-builtin extension selectors must be native-resolved absolute paths. CLI
`--no-extensions`/`--no-packages` suppression rejects. The launcher still owns
immutable roots: filesystem rechecks detect ordinary drift, not hostile atomic
filesystem replacement. Legacy synthetic loader inventories are refused by named
admission errors; no persisted session or workspace is rewritten.

`admitNativeHome()` returns exactly `{digest}`, the lowercase 64-character SHA-256
of the `pi-native-home/v1` manifest, or throws. No load fact contains credentials. Explicit model thinking levels are validated
against the model's physical supported-level catalog. Native admission does not
impose a provider-family ceiling: Claude `max` metadata is admitted unchanged
when that installed model supports it.

## Checks

From `packages/paperclip-runner`:

```sh
pnpm exec vitest run src/drivers/pi/extension/home
pnpm exec vitest run src/drivers/pi
```

`native-load.test.ts` is opt-in with `PI_NATIVE_RUNTIME_ROOT` and
`PI_NATIVE_SUBAGENTS_ROOT`. It exercises actual Pi 1.5.2 and pi-subagents 0.88.0:
fatal factory exit before RPC, inactive-tool provenance and the exact digest,
and refusal of disabled guard selection. Its hook-only guard is a controlled
fixture, not proof of production guard behavior or daily-work/org acceptance.
Set `PI_NATIVE_TEST_OUT` to preserve native transcripts and admission results.
