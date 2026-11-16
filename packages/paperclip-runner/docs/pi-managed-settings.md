# Managed Pi settings

For a fresh managed Pi home, the driver copies the original home's settings into
its per-session `settings.json`, applies managed compaction, and resolves `npm:`
package declarations to their already-installed absolute roots. Missing packages
fail startup with `pi_managed_package_not_installed`; startup must not silently
lose extensions because a registry is unavailable.

A run without a user-configured `PI_CODING_AGENT_DIR` still receives a
server-selected per-session directory. In that case the process's "original"
home equals the managed home. If that home has **no settings file**, the settings
base comes from `join(homedir(), ".pi", "agent")`, resolved when opening the
session. This uses the box process's home, not an environment projected into the
child. The image's settings are read-only: only the per-session settings file is
written. Runs and setup probes share this driver path.

An existing per-session settings file remains authoritative, including `{}` or a
compaction-only file. This is not a migration of existing sessions. An explicitly
configured original home continues to supply the base as before. When the
managed home is the original image home, the existing same-home behavior remains:
package declarations are not rewritten.

When inheriting a base for a managed `paperclip/<model>` selection,
`defaultProvider` and `defaultModel` are set to that managed provider and model,
not the image's startup defaults. Provider routing remains owned by the driver's
existing managed `models.json` and admission logic. Other base settings survive.
The existing compaction precedence is unchanged: session-specific reserve,
original model-specific/global reserve, then the managed context-window reserve.

## Pi 1.5.2 references

Paths and line numbers below refer to the **installed 1.5.2 npm package**, not a
mutable main-branch document:

- `docs/configuration.md:3,9-13` and `docs/environment-variables.md:81`: default
  agent directory, override, and ownership of user settings/package declarations.
- `dist/config.js:510-515`: Pi's default directory uses `homedir()` at call time.
- `docs/settings.md:13-14,73-80,151-155`: startup provider/model defaults,
  compaction settings, and resource paths/package declarations.
- `docs/packages.md:19,37-44,61-77,112,118-143`: installation failure can skip
  resources; local roots load without copying or installation; package manifests
  and resource filters retain their meaning.
- `docs/environment-variables.md:84` and `docs/cli.md:243-244`: offline mode
  disables automatic network activity.
- `docs/sdk.md:98-108` and `examples/sdk/06-extensions.ts:26-38`: the standard
  resource loader used by the regression test loads the resulting settings.

`pi-managed-settings-open.test.ts` reproduces the no-env server injection with a
non-default process HOME, drives run and hello-probe opens, and uses Pi's real
resource loader against four fixture package roots while network access is
forbidden. It compares the loaded list with the same-home control and compares
image settings bytes before/after. It does not claim live-image deployment or
functional acceptance of tracing/subagents themselves.
