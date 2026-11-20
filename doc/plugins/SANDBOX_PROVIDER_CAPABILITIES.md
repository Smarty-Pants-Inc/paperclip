# Sandbox provider capability contract

A sandbox provider plugin declares an environment driver with
`kind: "sandbox_provider"`. Each driver can declare a set of optional sandbox
capabilities. This document is the contract for a third-party provider author.
It states what to declare, which worker methods each capability needs, what an
omitted key means, and when the host narrows or denies a capability.

Read [Sandbox file-sync lifecycle hooks](./SANDBOX_FILE_SYNC_HOOKS.md) for the
native file-transfer hooks. Read the driver declaration shape in
[the plugin specification](./PLUGIN_SPEC.md).

## Fresh lease acquisition timeout

A driver can declare `defaultAcquireTimeoutMs` as a positive integer of at most
86,400,000 milliseconds. The host uses it for `environmentAcquireLease` when the
resolved config has no positive finite numeric `timeoutMs`. A positive numeric
`bridgeRequestTimeoutMs` can extend that budget. The host adds 30 seconds for RPC
overhead. This applies to both sandbox providers and generic plugin drivers.

Daytona declares 300,000 milliseconds, and its host RPC can therefore wait 330
seconds instead of the worker's normal 30 seconds. The worker itself caps one
fresh acquisition at 180 seconds. Creation, workspace setup, shell detection,
expiry setup, and inline failure cleanup share that cap. A create that has not
returned after 90 seconds is looked up once by its creation name: a sandbox that
has started is adopted and setup continues, one still preparing its snapshot
keeps waiting within the cap, and any other state ends the attempt. On timeout
the provider returns the attempt's scoped cleanup record and an acquisition
diagnostic whose elapsed time has reached the expired budget. The host treats
that diagnostic as a transient provider failure (`environment_provider_unavailable`),
so the run is retried with the bounded bootstrap budget while the creation
reconciler removes the abandoned allocation. Late SDK results cannot admit the
lease or start the next setup phase, and a late SDK failure never deletes an
adopted sandbox.
Drivers that omit the declaration keep the existing fallback. The host does not
infer this budget from config-schema defaults: a field named `timeoutMs` can
describe sandbox lifetime instead of the time needed to acquire it.

For reusable sandbox acquisition, the host also uses this budget for
`environmentResumeLease`, with the same explicit-config precedence, bridge
extension, and RPC margin. Resume attempts and transient retries share one
deadline. Without a configured or declared budget, resume keeps its one-minute
host default. Generic plugin-driver resume keeps its existing behavior.

This declaration does not change provider config, lease expiry, or other
lifecycle calls. Providers must still enforce their operation timeouts and
report uncertain allocations for cleanup. A bundled plugin must bump its
manifest version when adding the field so existing installations receive it.

## Snapshot identity for qualification

An explicit platform probe requests `resolveSnapshotIdentity: true` during lease
acquisition. A provider that boots from `config.snapshot` returns the resolved
identity in `lease.metadata.snapshotIdentity`:

```ts
snapshotIdentity: {
  provider: "my-provider",              // exactly config.provider
  requestedRef: "runner-snapshot",       // exactly config.snapshot
  id: "snap_01JEXAMPLE",                 // immutable provider snapshot ID
  name: "runner-snapshot",
  organizationId: "provider-account",    // provider account or namespace
  createdAt: "2026-11-12T00:00:00.000Z",
}
```

The lease provider and identity provider must both exactly match the selected
provider. `requestedRef` must equal either `id` or `name`. The ID must be nonempty,
contain no whitespace, and be at most 256 characters. Daytona retains its existing
UUID ID requirement. `name` and `organizationId` must be nonempty, and `createdAt`
must be a valid ISO date. The lease metadata also returns `snapshot` equal to the
requested snapshot reference.

Resolve the reference and boot from that immutable ID, not a later name lookup.
After qualification, the host supplies the saved ID as `config.snapshot` for
native execution. A missing ID must fail rather than fall back to a replacement
with the same name.

Snapshot qualification requires a nonempty provider and snapshot, no competing
`image`, `template` or `templateRef`, and either no captured template or a snapshot
template bound to `snapshot`. The host records company- and configuration-bound
platform proof only after measurement and verified owned lease cleanup. This
handshake does not grant other sandbox capabilities or replace the separate
immutable OCI image qualification path.

## How the host resolves an effective capability

The host never trusts a declaration alone. For every run it resolves each
capability as the intersection of three inputs:

```
effective = verified ∩ declared ∩ narrowing
```

- **verified** — the methods the live worker advertised in
  `InitializeResult.supportedMethods`. The host maps each capability to the
  worker methods it needs (see the table below). A capability is verified only
  when the worker advertises every required method. An empty or missing method
  list verifies nothing, so every capability resolves `false`.
- **declared** — the values in the driver declaration. A declared key is
  optional (see the next section).
- **narrowing** — a per-run restriction from the lease policy or the resolved
  provider config. A narrowing can only remove a capability, never add one.

A capability is effective only when all three allow it. A declaration therefore
never grants a capability that the worker did not verify.

## The declaration is optional and partial

Declare capabilities through the nested `sandboxCapabilities` object on the
driver declaration:

```ts
environmentDrivers: [
  {
    driverKey: "my-provider",
    kind: "sandbox_provider",
    displayName: "My Provider",
    configSchema: { type: "object", properties: {} },
    sandboxCapabilities: {
      reusableLeases: true,
      nativeSyncIn: true,
      nativeSyncOut: true,
      persistentProcessSessions: false,
      independentControlCommands: false,
      incrementalSessionOutput: false,
    },
  },
]
```

Every key is optional. For a valid, identified provider each key has one of three
states:

- **Omitted** — the host defers to verified worker discovery. The capability is
  effective when the worker advertises the required methods and no narrowing
  removes it. Omission is the correct default for a provider that follows the
  standard method contract. `reusableLeases` and `incrementalSessionOutput` are
  the two exceptions: an omitted key never grants either capability. Both are
  opt-in (see the next two sections).
- **`false`** — the host narrows the capability to off. The capability is never
  effective, even when the worker advertises the required methods.
- **`true`** — the host still requires the verified prerequisites. A `true`
  value never grants a capability without them. It documents intent and lets the
  host present the capability, but the worker must still advertise the required
  methods.

## Reusable leases need an explicit opt-in

Reusable leases are the exception to the omission rule above. The host grants
reusable-lease acquisition only when the declaration sets `reusableLeases` to
`true`. The provider opts in through one of two fields:

- the nested `sandboxCapabilities.reusableLeases: true`, or
- the legacy `supportsReusableLeases: true`.

An omitted key leaves `reusableLeases` unset. An unset key does not make the
provider eligible for reusable-lease acquisition, and it does not advertise
provider-level reusable support. The host then always creates an ephemeral lease.

The opt-in never removes the other prerequisites. The worker must still verify
all three lifecycle methods, `environmentResumeLease`, `environmentReleaseLease`,
and `environmentDestroyLease`, and per-run narrowing still applies.

The two opt-in fields have a fixed precedence. The host keeps the legacy
`supportsReusableLeases` field for backward compatibility, and it folds the field
into `sandboxCapabilities.reusableLeases`.

- When only `supportsReusableLeases` is present, the host reads it as
  `reusableLeases`.
- When both `supportsReusableLeases` and `sandboxCapabilities.reusableLeases` are
  present, the nested value wins.

A manifest with legacy `true` and nested `false` therefore resolves to `false`.
Prefer the nested `sandboxCapabilities.reusableLeases` in a new manifest.

## Incremental session output needs an explicit opt-in

Incremental session output is the second exception to the omission rule. The host
selects the session-output streaming path only when the declaration sets
`incrementalSessionOutput` to `true`. An omitted key resolves the capability to
`false`, so the host keeps the output-file poll path.

The reason is that this key is a behavioral guarantee, not a worker-method
property. A generic one-shot provider can keep persistent process sessions and run
independent control commands, yet it never emits incremental stdout and stderr
from a live session. The two broad capabilities do not imply incremental output,
so the host requires the provider to declare the behavior. A provider that streams
incremental session output declares `sandboxCapabilities.incrementalSessionOutput:
true`; every other provider omits the key and keeps the poll path.

The opt-in never removes the prerequisites. The worker must still verify
`environmentExecute`, and per-run narrowing still applies. A config-resolution
failure narrows the capability to off (see [Failure behavior](#failure-behavior)).

## The capabilities and their worker-method prerequisites

| Capability | Required worker methods | Meaning |
| --- | --- | --- |
| `reusableLeases` | `environmentResumeLease`, `environmentReleaseLease`, **and** `environmentDestroyLease` | The host retains a provider lease and resumes it across runs. |
| `nativeSyncIn` | `environmentSyncIn` | The host transfers files into the sandbox through the native inbound hook. |
| `nativeSyncOut` | `environmentSyncOut` | The host transfers files out of the sandbox through the native outbound hook. |
| `persistentProcessSessions` | `environmentExecute` | The provider keeps a persistent process session open across commands. |
| `independentControlCommands` | `environmentExecute` | The provider runs a one-shot control command beside a long-lived command. |
| `incrementalSessionOutput` | `environmentExecute` | The provider streams incremental stdout and stderr from a live session. Opt-in: an omitted key resolves `false`. |

Reusable leases need all three lifecycle methods. The host resumes a lease with
`environmentResumeLease`, ends it with `environmentReleaseLease`, and tears down a
stale lease with `environmentDestroyLease`. The reuse path destroys a stale lease
when a resume fails, so a provider that cannot destroy a lease would strand it. A
worker that omits any of the three methods never gets reusable leases, even with a
positive declaration. The host then always creates an ephemeral lease.

The host advertises and consumes the two native sync methods as a pair. Define
both or neither. See [Sandbox file-sync lifecycle hooks](./SANDBOX_FILE_SYNC_HOOKS.md).

## Target and config narrowing

A narrowing removes a capability that the provider verified and declared but that
this run cannot use.

- **Ephemeral lease policy.** A lease that the host does not retain never reuses.
  The host narrows `reusableLeases` to off for an ephemeral lease and keeps it on
  only for a reuse-by-environment lease.
- **Kubernetes Job backend.** A Job-backed lease, or a lease the host marked as
  unable to run native file sync, disables native sync. The host narrows
  `nativeSyncIn` and `nativeSyncOut` to off and keeps the base64-over-exec
  fallback.

## Failure behavior

The host fails closed on two failure states. It never grants a capability from an
unknown state.

- **Config-resolution failure.** A provider whose config the host cannot resolve
  is untrusted. The host narrows `persistentProcessSessions` and
  `incrementalSessionOutput` to off instead of allowing either through an empty
  config.
- **Exact-plugin identity failure.** A retained lease pins the exact plugin that
  acquired it. When that plugin is absent, or when it no longer declares this
  provider key with the `sandbox_provider` kind, the host cannot establish the
  declaration. It resolves every effective capability to `false`, no matter what
  methods a stale worker still advertises. An omitted `sandboxCapabilities`
  object on a valid, identified plugin is a different state; the host defers to
  verified discovery for that case.

## Concurrent sync operations need an explicit opt-in

Declare `sandboxCapabilities.concurrentSyncOperations: true` only when the
provider can safely run native file transfers concurrently, including transfers
in both directions at once. This is a behavioral guarantee, not something the
host can infer from method discovery. An omitted key or `false` denies the
capability. The host requires **both** `environmentSyncIn` and
`environmentSyncOut` in the live worker's verified methods; one direction alone
is insufficient. The declaration cannot override missing methods, static driver
restrictions, or per-run narrowing. See the
[provider contract](../../packages/shared/src/types/plugin.ts#L166-L175) and
[capability resolver](../../server/src/services/environment-runtime.ts#L155-L225).

When the effective capability is `true`, the host carries it to the native sync
client as `allowConcurrentSyncOperations`. This enables:

- **Concurrent inbound and outbound sync work.** The workspace coordinator uses
  the permission for both its inbound uploads and outbound restores, with at most
  four operations active per scheduler invocation. It waits for all started
  operations to settle before crossing the startup or restore barrier and reports
  required failures in stable input order. This does not overlap startup with
  copyback or remove either barrier. See the
  [scheduler and limit](../../packages/adapter-utils/src/sync-operation-schedule.ts#L1-L79),
  [inbound barrier](../../packages/adapter-utils/src/sandbox-managed-runtime.ts#L1960-L1987),
  and [outbound barrier](../../packages/adapter-utils/src/sandbox-managed-runtime.ts#L2380-L2401).
- **Parallel launch-asset staging.** For sandbox transport, launch-state
  materialization and runtime-context staging may overlap. Selected Codex skills
  are prepared first, and the CA bundle is staged afterward. Both parallel
  branches settle before a failure is raised. See
  [launch-asset staging](../../server/src/services/native-runtime/remote-launch-assets.ts#L188-L204).
- **Eligible runner/harness preparation overlap.** Runner preparation can overlap
  discovery and verification of preinstalled Codex when there is no explicit
  Codex binary or npm installation request. See
  [runner preparation](../../server/src/services/native-runtime/native-session-executor.ts#L18256-L18264).

Without the opt-in, the native sync path and these capability-gated preparation
paths remain serial. The generic base64-over-exec sync fallback is different: it
already permits concurrency independently of a provider declaration. See
[permission propagation](../../server/src/services/environment-execution-target.ts#L522-L527)
and [native versus fallback selection](../../packages/adapter-utils/src/command-managed-runtime.ts#L517-L540).

GitHub preparation also overlaps eligible native runnerd setup, but at this
revision it is **not gated** by `concurrentSyncOperations`. The native executor
selects that path for managed GitHub access on remote Codex/OpenCode runnerd runs,
with no explicit backend and excluding execution schemas v6/v8. GitHub environment
preparation can then overlap assigned-MCP preparation; failures are awaited and
GitHub access is activated before the prepared environment is handed on. Heartbeat
preparation defers configured native GitHub access to the session supervisor. The
capability does not bypass GitHub activation or authorize arbitrary command
batching. See [heartbeat deferral](../../server/src/services/heartbeat-github-launchers.ts#L24-L29),
[native GitHub preparation](../../server/src/services/native-runtime/native-session-executor.ts#L11617-L11641),
and [preparation barrier](../../server/src/services/native-runtime/native-session-executor.ts#L15444-L15460).

Before opting in, a provider must isolate per-call scratch state in both sync
directions: use distinct host temporary directories, remote archive/list names,
and publication staging paths. Concurrent operations must have disjoint
publication destinations; this capability does not make same-target replacement
transactional. Lease release, stop, destroy, and worker shutdown must drain active
sync calls, including their cleanup, before tearing down their resources. Fence
new work during teardown and fail closed if the drain cannot be confirmed; a
timeout is not successful teardown. The coordinator's settle-all barrier does not
replace these provider-side guarantees. See the
[Daytona declaration and guarantees](../../packages/plugins/sandbox-providers/daytona/src/manifest.ts#L48-L65)
and [Boat sync lifecycle contract](../../packages/plugins/sandbox-providers/boat/README.md#L3-L22).

The bundled Daytona provider declares this capability (added in 0.1.4). Boat
also declares it from `0.1.17-spare.12c1` (unreleased at this revision); older Boat
manifests do not gain it from method discovery alone. See
[Daytona version history](../../packages/plugins/sandbox-providers/daytona/src/manifest.ts#L13-L18)
and [Boat manifest](../../packages/plugins/sandbox-providers/boat/src/manifest.ts#L3-L38).
`concurrentSyncAndExec` remains unsupported: it is not an alias or an additional
permission, and the [strict validator](../../packages/shared/src/validators/plugin.ts#L158-L172)
rejects it as an unknown key.

### Preserving an unexported workspace

Native export recovery requires the separately discovered `environmentStopLease` RPC (`onEnvironmentStopLease`). It stops the exact allocation and preserves files regardless of its normal release policy. A failed or unconfirmed stop must throw and must never fall back to deletion. The host uses the recorded plugin ID and defers when that worker does not advertise the hook; a generic release method is insufficient evidence of stop-only support. Normal successful ephemeral release remains destructive after verified copyback.

Daytona stop-only preservation disables provider auto-delete and refreshes the provider record to confirm the disabled policy before stopping. An unavailable or unconfirmed policy leaves cleanup pending; it never falls back to stop or delete. The original ephemeral destroy policy applies only after exact accepted-result copyback and commitment.

A provider can refuse Stop while the allocation is in a provider error state. A stop-only hook may run one bounded provider recovery and then stop. When it cannot stop the allocation, it throws `PluginEnvironmentStopError` with a closed reason. The host treats `resource_unrecoverable` and `recovery_failed` as terminal: it escalates the pending cleanup at once and retries at its slowest interval. Deletion is never a fallback.
