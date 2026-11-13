# Optional Node compile caches in remote environments

Node's compile cache is an optimization, not a prerequisite for a remote task.
A bootstrap process must not depend on a shared `$TMPDIR/node-compile-cache`
directory being writable or belonging to the task user.

## Use the existing command contract

Sandbox commands already pass through `environmentExecute`, as documented in
[the file-sync lifecycle](SANDBOX_FILE_SYNC_HOOKS.md#sandbox-file-sync-lifecycle-hooks)
(lines 3–6). The existing
[`PluginEnvironmentExecuteParams`](../../packages/plugins/sdk/src/protocol.ts)
contract accepts `command`, optional `args`, and optional `env` (lines 762–767).
No plugin API or provider-specific escape hatch is needed.

**Never add an env object to a command whose caller supplied none.** Boat creates
an env file for a nonempty env map and requires a private directory outside the
workspace; bootstrap/probe commands do not yet have that directory. For absent
or undefined caller env, dispatch `command: "env"` with args
`["NODE_DISABLE_COMPILE_CACHE=1", originalCommand, ...originalArgs]`, retaining
the absent/undefined env. If the caller already supplies an env map (including
`{}`), merge the policy into that map without mutating it. This does not bypass
Boat's private-directory requirement for a caller's actual env.

The policy is defined in
[`remote-command-environment.ts`](../../packages/adapter-utils/src/remote-command-environment.ts)
and applied by the environment runtime and the SSH command runner. Duplex has
an argv contract and uses the same `env` prefix, without a shell or argument
reconstruction. The executable and each argument retain their original bytes.
This covers pre-run pack probes, verifiers, file helpers and runner launch
commands as well as the actual run. An omitted caller env is not an opt-out;
neither is an arbitrary `NODE_COMPILE_CACHE` path, whose remote ownership and
permissions the controller cannot verify.

The Boat implementation is not tracked in this checkout; the verified boundary
is the SDK command/args contract and host forwarding to `environmentExecute`,
plus a Boat-shaped rejecting driver executing real argv. This is not proof of
Boat's own argv quoting or a deployed production run.

## Propagate before profiles, not only before the final command

Boxd, Daytona and SSH source login profiles to discover the image's PATH.
A profile can itself launch Node. When caller env carries the policy, Boxd and
Daytona expose that flag before sourcing profiles, then reapply caller env to
the final command. SSH prefixes its outer command too, so the flag reaches
profiles even with no caller env. Other caller variables retain their existing
post-profile ordering; this does not expose task credentials earlier. An
argv-only sandbox command establishes the policy at its executable boundary,
not before provider-owned profile setup.

The rule does not change the selected UID, switch to root, repair shared cache
permissions, delete other users' caches, or relax sandbox/SSH confinement.
It applies to whichever UID the selected image or execution transport uses.

## Environment-clearing child owners

A parent flag cannot survive an explicit replacement of the child's environment.
Those owners must preserve the policy at the launch boundary:

- Rust's provider supervisor keeps the runner-owned keys across `env_clear`.
- Verified assigned stdio MCP launches disable caching **after** applying the
  binding's env; that boundary does not verify private cache paths.
- Verified ACPX/probe launches use the existing runner cache-policy helper even
  with a minimal env. Credential-free guardian watchdogs carry the same flag.
- GitHub launchers and executable shims preserve the launch env in descendants.

## Native Pi's private-cache exception is unchanged

The native Pi process owner may enable caching only after its existing local
check confirms a real, current-UID-owned, mode-0700 writable cache directory.
If that check fails, the launch continues with caching disabled. Its stdio MCP
children inherit the private path or the disabled fallback. Per-server env
overrides and arbitrary user commands can change inherited env; the launch
policy is not a security boundary against a command deliberately resetting it.

An error mentioning a compile-cache file is not, by itself, proof of a specific
creator UID or launch path. Capture the actual failing stack and process identity
before attributing an incident. In particular, a cache API returning `FAILED`
is not the same as a process throwing a fatal `EACCES`.

## Focused regression checks

Run one Vitest file per invocation, with `--maxWorkers=2`:

- `packages/adapter-utils/src/remote-command-environment.test.ts`
- `packages/adapter-utils/src/ssh-command-managed.test.ts`
- `server/src/services/native-runtime/remote-node-compile-cache.integration.test.ts`
- `server/src/services/native-runtime/remote-node-compile-cache.boat.test.ts`
- `packages/plugins/sandbox-providers/boxd/src/plugin.test.ts`
- `packages/plugins/sandbox-providers/daytona/src/node-compile-cache.test.ts`
- `packages/paperclip-runner/src/drivers/acpx/node-compile-cache-launch.test.ts`

The native Pi proof is
`packages/paperclip-runner/src/drivers/pi/pi-compile-cache.native.test.ts`.
It requires `PI_TEST_BINARY` pointing to Pi 1.5.2 and an unprivileged POSIX user.
It performs real RPC turns against a controlled loopback model, reads the native
cache API inside Pi and its actual stdio MCP child, and verifies retirement.
It is not a live-provider or production-lease acceptance check.

The Rust `process_supervisor::tests::verified_stdio_children_disable_optional_node_cache`
regression crosses the verified artifact / `env_clear` / spawn boundary.
Unprivileged permission fixtures assert genuine `EACCES` before exercising
Node. The Boat-shaped test also runs as root to prove the policy reaches UID 0,
without claiming that mode-0555 fixtures prevent root from writing. Other
permission-sensitive suites skip as root rather than accepting a writable fixture.
