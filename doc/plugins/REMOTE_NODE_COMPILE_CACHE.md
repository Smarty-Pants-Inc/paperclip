# Optional Node compile caches in remote environments

Node's compile cache is an optimization, not a prerequisite for a remote task.
Use a directory owned by the calling uid, never a shared `/tmp/node-compile-cache`.
Do not disable caching on every successful launch.

## Use the existing command contract

Sandbox commands already pass through `environmentExecute`, documented in
[SANDBOX_FILE_SYNC_HOOKS.md, lines 3–6](SANDBOX_FILE_SYNC_HOOKS.md#sandbox-file-sync-lifecycle-hooks).
The existing [`PluginEnvironmentExecuteParams`](../../packages/plugins/sdk/src/protocol.ts)
contract (lines 762–767) accepts `command`, optional `args`, and optional `env`.
This is a launch bug fix on that existing boundary, not a new plugin API or seam;
prepare it using upstream's `.agents/skills/prepare-paperclip-pr/SKILL.md`.

**Never create or modify a provider env object.** Boat creates an env file for a
nonempty env map and requires a private directory outside the workspace, which
bootstrap/probe commands do not yet have. Always carry the cache selection in argv,
even when the caller supplies env. Pass any caller env through unchanged, by identity.
This does not bypass Boat's restriction for actual caller-provided env.

[`remoteCommandArgv`](../../packages/adapter-utils/src/remote-command-environment.ts)
returns `["sh", "-c", PRELUDE, "paperclip-node-cache", ...originalArgv]`:

```sh
if [ -z "${NODE_COMPILE_CACHE:-}" ]; then d="${XDG_CACHE_HOME:-${HOME:-/nonexistent}/.cache}/node-compile-cache"; if mkdir -p "$d" 2>/dev/null && [ -w "$d" ] && [ -O "$d" ]; then NODE_COMPILE_CACHE="$d"; export NODE_COMPILE_CACHE; unset NODE_DISABLE_COMPILE_CACHE; else NODE_DISABLE_COMPILE_CACHE=1; export NODE_DISABLE_COMPILE_CACHE; fi; fi; exec "$@"
```

A nonempty caller `NODE_COMPILE_CACHE` wins (including Pi's verified private cache).
Otherwise select `$XDG_CACHE_HOME/node-compile-cache` or
`$HOME/.cache/node-compile-cache`. If mkdir, writability, or current-uid ownership
fails, disable the optional cache and still execute the command. Never repair,
chown, or delete another user's cache. The fixed `$0` and `exec "$@"` retain every
original argument without shell interpolation or re-quoting. Execute and duplex
use the same wrapper. SSH applies it before sourcing login profiles; caller env
retains its existing post-profile ordering. An argv-only sandbox command cannot
change provider-owned profile setup before that command runs.

Node's `getCompileCacheDir()` returns a version/architecture/uid subdirectory of
`NODE_COMPILE_CACHE`, not the base directory itself. Both are owned by the uid.

## Environment-clearing child owners remain unchanged

The Rust provider supervisor retains the restored policy across `env_clear`.
Verified assigned stdio MCP launches and ACPX/probes keep their disabled-cache
fallbacks at their own environment-replacement boundaries. Native Pi keeps its
existing c648a414 policy: verify a private, current-uid-owned, mode-0700 writable
cache, or continue with caching disabled. No Pi policy change is made here.

## Evidence and scope

Run one Vitest file per invocation, with `--maxWorkers=2`:

- `packages/adapter-utils/src/remote-command-environment.test.ts`
- `packages/adapter-utils/src/ssh-command-managed.test.ts`
- `server/src/services/native-runtime/remote-node-compile-cache.boat.test.ts`
- `server/src/services/native-runtime/remote-node-compile-cache.integration.test.ts`
- `server/src/__tests__/environment-runtime.test.ts`
- `packages/paperclip-runner/src/drivers/acpx/node-compile-cache-launch.test.ts`

Run the Boat-shaped test as uid 1000 and uid 0. It executes real sh and Node,
checks uid ownership, populated cache files and reuse, literal argv, untouched env,
and an unwritable `/proc` HOME fallback that also fails for root. For the shared
cache EACCES case, set `REG12C_ROOT_SHARED=1` only in a private mount namespace
with a root-owned directory bind-mounted at `/tmp/node-compile-cache`, then run
as uid 1000. Never change the live shared cache to prepare this fixture.

The Boat implementation is not tracked in this checkout. These tests establish
the SDK forwarding boundary and a Boat-shaped rejecting driver's real execution;
they do not establish real Boat quoting, production lease, or sync-out acceptance.
A real-Boat check must separately exercise the same argv payloads on fresh boxes.
