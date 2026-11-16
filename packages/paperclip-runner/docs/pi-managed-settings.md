# Managed Pi settings

A run without a user-configured `PI_CODING_AGENT_DIR` still receives a
server-selected per-session directory. When the original home equals that
managed home and it has **no settings file**, the driver reads the image's
`join(homedir(), ".pi", "agent", "settings.json")` at session-open time. This
uses the box process's home, not the HOME projected into the child process.
Runs and setup probes share this driver path.

Only `packages`, when present, is inherited from that image file. Its `npm:`
declarations are rewritten to already-installed absolute package roots under
the image agent home's `npm/node_modules`; other package entries and resource
filters retain their existing meaning. A missing npm package fails startup with
`pi_managed_package_not_installed`, before writing session settings, rather than
silently installing from a registry. The image file is never written.

No image compaction, retry, startup-provider/model defaults, or other keys are
copied. The managed compaction reserve remains the smaller of 100,000 tokens
and one quarter of the selected model's context window. Model selection and
provider routing remain owned by the driver's explicit `--model` argument,
managed `models.json`, and existing admission logic, not image defaults.

An existing per-session settings file remains authoritative, including `{}` or a
compaction-only file. This does not migrate existing sessions. An explicitly
selected, distinct original home keeps the existing settings-copy and explicit
reserve precedence. A same-home run with existing image settings keeps those
bytes and its npm declarations unchanged.

## Regression evidence

`pi-managed-settings-open.test.ts` drives run and hello-probe opens with a
non-default process HOME and a different projected child HOME. It uses Pi
1.5.2's real resource loader against four fixture package roots, forbids network
access, compares the loaded packages with a same-home control, and verifies that
the image settings bytes are unchanged. It asserts the complete no-env managed
settings object: only resolved packages and managed compaction. It does not
claim live-image deployment or functional acceptance of tracing/subagents.

The additional `pi-managed-settings.test.ts` cases prove that a missing installed
package or malformed image settings fails before any session settings write.
The unchanged model-source tests keep their exact window-safe compaction
expectations for 32k, 128k, and 1M context windows.
