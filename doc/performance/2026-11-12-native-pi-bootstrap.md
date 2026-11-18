# Native Pi bootstrap: cache/readiness changes and the remaining auth gap

This is an implementation handoff, **not a claim that the cold-start target is met**. The 2026-11-12 22:12Z builder brief gives 9.3 s overall, `runner.transport.ready` 4.4 s, `runner.prp.authenticate` 1.25 s, runtime-context staging 2.9 s and `runner.ingress.wait_for_process` 3.1 s. Those spans are nested/overlapping, not independent costs to add or subtract.

## What is actually awaited

1. `server/src/services/native-runtime/native-runner-execution-driver.ts:313` awaits `input.processStarted`, not a health-check interval. `runner.transport.ready` also awaits that activation, then PRP authentication (`:340-350`).
2. `server/src/services/native-runtime/native-session-executor.ts:16221` creates that promise. The remote launcher resolves it through `onRunnerProcessSpawned` (`:17295`).
3. The launcher first awaits `ensureArtifact` (`:15007-15016`), which calls `ensureRemoteRunner` (`:17290`) and stages the context through `stageRemoteLaunchAssets` (`:16955`). Only then does it publish the dispatch event (`:15034`). Thus the reported 3.1 s wait can include the 2.9 s staging cost; it is not evidence of a 3 s health poll.
4. A **different** readiness check, `waitForRemoteRunnerProcessIdentity` (`:14868`), previously launched a remote `sh`/`cat` every 100 ms until the exact launch marker appeared. This check gates exact process ownership, including the optional Linux generation fingerprint. Subsequent process supervision is separate and is unchanged.

## (a) Runtime-context content comparison — implemented

`remote-launch-assets.ts:147-173` collects instruction bundles, each selected skill bundle and `runtime-context.json`. `remote-runtime-assets.ts` computes local SHA-256 fingerprints and obtains all remote fingerprints in **one command invocation**, independent of the number of bundles/files. Only mismatching assets go through the existing upload callbacks.

Local filesystem reads are asynchronous and sequential within the hash walk, avoiding synchronous filesystem work on the server event loop and keeping only one file's bytes per walk. The remote walk runs synchronously in its dedicated command process. Fingerprints cover actual contents, relative paths, empty directories and executable bits. A standalone context file also has to retain its explicit private mapping mode. Archive-normalized directory/write modes do not cause permanent false misses. A symlink, absent/changed file, invalid result or unavailable hash command is not a cache hit. If local hashing is unsupported or remote comparison fails, the existing upload path remains authoritative.

Authentication/configuration files, CA material, writable provider homes and Codex's isolated discovery projection are deliberately **not** put in this cache. They retain their existing staging and cleanup contracts. The existing concurrent sandbox staging path remains available.

Expected after, conditional on a retained exact copy: one remote hash invocation plus local/remote hashing and uploads of just the changed assets; unchanged bundles upload zero bytes. There is no measured remote duration in this task. An empty first-use filesystem still needs the full upload and pays one comparison command: this change alone cannot establish a <=5 s truly empty cold start.

## (c) Exact process-identity publication — implemented, distinct from dispatch

`remote-runner-readiness.ts` subscribes to the identity directory before its initial read and wakes on the launch writer's atomic rename. The controller makes one remote wait invocation rather than repeatedly opening remote commands. The watcher is closed on success/error/deadline, and a final read at the existing 20 s deadline handles publication at the boundary. If notifications cannot be installed or fail, the initial/error read can still accept an exact marker; otherwise the bounded final read remains the safety net. That degraded path may take the full deadline, but does not falsely reject an already-published valid marker merely because the watcher is unavailable. There is no recurring readiness interval. The event test publishes only after subscription and the initial read, with the process timeout shorter than the final-read deadline, so the final read cannot masquerade as event readiness.

The marker is rechecked for launch nonce, positive safe PID, start time, exact Runner ID and the required generation fingerprint; symlinks/nonregular/oversized markers are refused. The server's existing parser validates the result again. Process-identity readiness does not replace PRP authentication or authorize a provider command.

Expected after: the event wait removes repeated command round trips and 100 ms quantization when marker publication is delayed. It is **not** an independent 3.1 s saving. The dispatch span's expected benefit is principally the same staging saving described in (a), and must not be counted twice. Local filesystem-notification tests are not qualification of every remote filesystem or a deployed latency measurement.

## (b) Pi/auth overlap — NOT implemented

The current path is serial by construction:

- `packages/paperclip-runner/runner/crates/runner-core/src/durable/runner.rs:572-764` establishes and authenticates the PRP transport before executing controller commands.
- `packages/paperclip-runner/runner/crates/runner-core/src/native_provider_backend.rs:278-333` chooses the Pi local facade from the authenticated `run.prepare` provider descriptor. It does not expose an unbound pre-auth Pi executor.
- `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:7291` waits for registration readiness. `run.prepare` and `session.open` are authenticated PRP commands, even when queued earlier (`:6319-6320`).
- `packages/paperclip-runner/src/cli/pi-rpc-app-server-proxy.ts:568` handles `initialize` with metadata only. Starting that proxy is **not** starting Pi. The real driver is constructed by `open()` (`:452-527`).
- `packages/paperclip-runner/src/drivers/pi/pi-rpc-driver.ts:180-207` creates the provider broker/model configuration and a file containing session/run/turn binding before `new PiRpcTransport` (`:235`). That transport performs the actual spawn (`pi-rpc-transport.ts:157`).
- The owned extension currently requires a valid initial binding when its private bind socket is selected (`extension/index.ts`, `installPiBindExtension` and default entry point). Moving today's `openSession` earlier would deliver the very binding/provider material that the brief forbids before authentication.

No unsafe early-open or proxy-only pseudo-prestart is included. A genuine solution needs an admitted **unbound Pi startup/adoption boundary** spanning runnerd selection, proxy ownership and extension/home bootstrap, with authenticated attachment to the same warmed PID. The next implementation must test the actual process boundary, not merely `Promise.all` over callbacks:

1. Pi exists while authentication is still unresolved.
2. Its argv, environment, inherited descriptors and reachable bootstrap files contain no provider credential or real session/run/turn binding.
3. Authentication success precedes provider/binding creation and first prompt.
4. The bound process is the same warmed process, with the correct cwd, selected skills, model, thinking effort and session recovery identity.
5. Authentication rejection/cancellation retires that process, sockets and descriptors without granting authority.

That ordering guarantee has **not** been supplied by this change. Expected after for this requirement is therefore unchanged/unmeasured, not an invented latency reduction.

## Snapshot/adoption boundary

The event-readiness route above is the chosen in-repo change; no pre-started snapshot daemon is claimed. A generic running `paperclip-runnerd` cannot be placed into an image and adopted by PID: its durable PRP identity and ticket are per execution. The existing sandbox guardian boundary uses `/usr/local/libexec/paperclip-runner-guardian client --protocol 1 --runner-id <id>` and a private fd-4 socketpair (`sandbox-runner-retention.ts:8,82,227`). Its resident daemon socket path/service CLI is **not defined in this repository**, and eligibility currently excludes Pi (`native-session-executor.ts:16137`). There is no truthful existing process/user/socket/server-adoption recipe for an unbound Pi snapshot here.

Cluster-lead should not snapshot a live authenticated Pi/Runner or invent a compatible socket path from this note. Bake the verified binaries and immutable assets, not credentials, tickets or a different company's session. An unbound snapshot service would require the same missing ownership/attachment contract as (b), followed by an explicit process/user/private-socket/adoption specification and qualification; it is not delivered or enabled by this patch.
