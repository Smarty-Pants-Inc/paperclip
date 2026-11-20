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
provider can safely overlap file transfers into and out of the same sandbox,
including simultaneous inbound and outbound calls. This key is accepted by the
strict validator; `concurrentSyncAndExec` is not a supported key
([packages/shared/src/validators/plugin.ts:169](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/shared/src/validators/plugin.ts#L169-L173)).

This is an opt-in behavioral guarantee, not a discovery default. An omitted key
or `false` denies it. Even with `true`, the live worker must verify **both**
`environmentSyncIn` and `environmentSyncOut`; one direction alone is insufficient
([packages/shared/src/types/plugin.ts:167](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/shared/src/types/plugin.ts#L167-L175),
[server/src/services/environment-runtime.ts:219](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/environment-runtime.ts#L219-L224),
[server/src/services/environment-runtime.ts:243](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/environment-runtime.ts#L243)).
Static driver support and per-target narrowing can still deny it. Missing verified
methods, an unknown provider identity, or an unavailable effective snapshot must
fail closed, not become permission to overlap. The classifier intersects these
gates, and the sandbox execution target propagates only an effective `true` as
`runner.allowConcurrentSyncOperations === true`
([server/src/services/environment-runtime.ts:328](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/environment-runtime.ts#L328-L345),
[server/src/services/environment-execution-target.ts:542](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/environment-execution-target.ts#L542-L548)).

The shipping server at `088401bf237a55a61cbf9fd3dad63ba666b6276b` consumes the
permission in these paths:

- **GitHub preparation.** Heartbeat can defer managed, read-only GitHub context
  discovery on a direct sandbox runner only with the flag enabled, a deferral
  request, no host credentials, and no provider-owned runner task
  ([server/src/services/heartbeat-github-launchers.ts:22](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/heartbeat-github-launchers.ts#L22-L34)).
  The native executor can overlap GitHub environment/access preparation with
  Runner backend setup for `codex` and `opencode`; for `pi_rpc`, it additionally
  requires sandbox transport and the concurrent-sync flag. The common gates
  require GitHub preparation work, Runnerd, no supplied backend, a remote target,
  and an execution schema other than v6 or v8. The flag is **not** an additional
  gate on the `codex` / `opencode` branches
  ([server/src/services/native-runtime/native-session-executor.ts:13625](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/native-runtime/native-session-executor.ts#L13625-L13635)).
- **Runner and harness artifacts.** With the runner flag enabled, Runner
  preparation and discovery/verification/linking of a preinstalled Codex binary
  run together when a remote Codex binary is needed and neither an explicit
  binary nor an npm spec was selected. Both operations settle before failure is
  reported; otherwise preparation remains serial
  ([server/src/services/native-runtime/native-session-executor.ts:21984](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/native-runtime/native-session-executor.ts#L21984-L21991)).
- **Remote launch assets.** Only sandbox transport plus the runner flag enables
  this overlap
  ([server/src/services/native-runtime/remote-launch-assets.ts:109](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/native-runtime/remote-launch-assets.ts#L109)).
  Changed runtime-context assets use a supplied `stageAssets` batch when present;
  otherwise the concurrent path stages batches of at most four, settling each
  batch before reporting failure
  ([server/src/services/native-runtime/remote-launch-assets.ts:174](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/native-runtime/remote-launch-assets.ts#L174-L186)).
  After Codex-skills reset/staging, launch-state materialization and runtime-context
  staging may overlap and both settle. Recovery remains serial, and CA-bundle
  staging follows the barrier
  ([server/src/services/native-runtime/remote-launch-assets.ts:213](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/server/src/services/native-runtime/remote-launch-assets.ts#L213-L226)).
- **Workspace and asset transfers.** The managed sandbox coordinator uses the
  sync client's flag for both the inbound startup barrier and the outbound
  restore/teardown barrier
  ([packages/adapter-utils/src/sandbox-managed-runtime.ts:1999](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/adapter-utils/src/sandbox-managed-runtime.ts#L1999-L2001),
  [packages/adapter-utils/src/sandbox-managed-runtime.ts:2419](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/adapter-utils/src/sandbox-managed-runtime.ts#L2419-L2421)).
  Each schedule allows at most **four** active operations, or one at a time in
  input order when disabled. It waits for every started operation to settle;
  this is a per-schedule bound, not a global provider-wide limit
  ([packages/adapter-utils/src/sync-operation-schedule.ts:9](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/adapter-utils/src/sync-operation-schedule.ts#L9),
  [packages/adapter-utils/src/sync-operation-schedule.ts:31](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/adapter-utils/src/sync-operation-schedule.ts#L31-L35)).
  The command-managed sync client copies the verified flag for native hooks only
  when both hooks exist. Its generic base64 inbound fallback independently
  permits concurrency; that does not grant a provider capability or supply a
  generic outbound hook
  ([packages/adapter-utils/src/command-managed-runtime.ts:520](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/adapter-utils/src/command-managed-runtime.ts#L520-L531),
  [packages/adapter-utils/src/command-managed-runtime.ts:532](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/adapter-utils/src/command-managed-runtime.ts#L532-L534)).

Before opting in, guarantee per-call scratch isolation (including temporary host
files and remote archive names), safe transfers to disjoint destinations, and no
shared mutable transfer state that one call can remove while another is using it.
Normal teardown and worker shutdown must drain active sync calls before deleting
scratch or terminating their allocation. A Stop's command cancellation must not
wait behind the very command it must cancel: close new admission, cancel/stop
active work promptly, and retain safe ownership of unfinished cleanup. Daytona's
manifest documents isolated scratch and draining, and its release path separates
Stop cancellation from graceful draining
([packages/plugins/sandbox-providers/daytona/src/manifest.ts:48](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/plugins/sandbox-providers/daytona/src/manifest.ts#L48-L54),
[packages/plugins/sandbox-providers/daytona/src/plugin.ts:3331](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/plugins/sandbox-providers/daytona/src/plugin.ts#L3331-L3342)).
If these guarantees cannot be made, omit the key or declare `false`. This is not a
blanket permission for arbitrary sync/exec overlap or conflicting writes.

Daytona declares the capability (since 0.1.4)
([packages/plugins/sandbox-providers/daytona/src/manifest.ts:13](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/plugins/sandbox-providers/daytona/src/manifest.ts#L13),
[packages/plugins/sandbox-providers/daytona/src/manifest.ts:65](https://github.com/Smarty-Pants-Inc/paperclip/blob/088401bf237a55a61cbf9fd3dad63ba666b6276b/packages/plugins/sandbox-providers/daytona/src/manifest.ts#L65)).
The separately versioned Boat provider first declares the capability in
`0.1.17-spare.12c1`
([provider opt-in commit](https://github.com/Smarty-Pants-Inc/paperclip/commit/bcc3767e405d4527603430fee3ec378ea317de6b)),
but that version does NOT meet the Stop guarantee above (a Stop waits behind an
in-flight sync and the command can survive it); do not install it with the
capability on. Use the first Boat version that meets every guarantee in this
section: `0.1.17-spare.12c3` (Stop cancels at once during a sync, and the sync's
own temp file is still cleaned up). Its implementation is
not bundled in this server revision. Always use the
installed provider's declaration and verified methods, not its name or version
alone, to decide whether concurrency is effective.

### Preserving an unexported workspace

Native export recovery requires the separately discovered `environmentStopLease` RPC (`onEnvironmentStopLease`). It stops the exact allocation and preserves files regardless of its normal release policy. A failed or unconfirmed stop must throw and must never fall back to deletion. The host uses the recorded plugin ID and defers when that worker does not advertise the hook; a generic release method is insufficient evidence of stop-only support. Normal successful ephemeral release remains destructive after verified copyback.

Daytona stop-only preservation disables provider auto-delete and refreshes the provider record to confirm the disabled policy before stopping. An unavailable or unconfirmed policy leaves cleanup pending; it never falls back to stop or delete. The original ephemeral destroy policy applies only after exact accepted-result copyback and commitment.

A provider can refuse Stop while the allocation is in a provider error state. A stop-only hook may run one bounded provider recovery and then stop. When it cannot stop the allocation, it throws `PluginEnvironmentStopError` with a closed reason. The host treats `resource_unrecoverable` and `recovery_failed` as terminal: it escalates the pending cleanup at once and retries at its slowest interval. Deletion is never a fallback.
