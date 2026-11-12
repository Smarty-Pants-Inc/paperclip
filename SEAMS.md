# Seam register

This fork (`Smarty-Pants-Inc/paperclip`) tracks upstream `paperclipai/paperclip`. A
**seam** is a deliberate change to Paperclip's core that this fork carries because
Paperclip has no documented or existing way to do the job. Anything that Paperclip's
own features, settings, plugins, adapters or skills can do is built there instead,
not here. Our own extensions are built **on top of** a seam, never into it.

Every seam follows the `paperclip-extend` process:

1. **No existing way.** Record what was searched (docs, API reference, plugin SDK,
   skills, adapters, settings, roadmap, upstream issues and pull requests, source at
   the pinned commit) and why each candidate falls short.
2. **Existing seams first.** Extend or merge into a seam below before adding one.
3. **The Paperclip way.** Match Paperclip's plugin and extension shape (naming,
   configuration, packaging, permissions, docs and tests). Generalise where it costs
   little. Keep the core change as small as possible.
4. **Design review.** A design pair (designer and challenger) reviews the design
   before it is built. The record is linked from the seam's entry.
5. **Build** with Paperclip's own tests and docs, written as if offered upstream.
6. **Extensions** go on top of the seam.
7. **Independent check** on the real path.

Design records for a seam are kept in this repository under `doc/seams/`. Links to
`Smarty-Pants-Inc/smarty-dev` point to private planning issues that only the fork's
maintainers can open.

Each seam lives on its own branch, `seam/<name>`, kept rebased on upstream, and is
merged into this fork's `master`. Offering a seam upstream needs the product
owner's approval of the exact text.

## Upgrades

The fork follows every upstream stable release (the `latest` npm dist-tag and the
`vYYYY.MDD.P` release tags in `paperclipai/paperclip`):

1. A weekly routine opens an upgrade issue when upstream has a new stable release.
2. Each seam branch is rebased onto the new release tag, in the order of the table
   below. A conflict is fixed in the seam, not worked around in a new seam.
3. Each seam's own tests and its real-path check run again on the rebased build.
   A seam that no longer passes blocks the upgrade until it is fixed or dropped.
4. Before rebasing, each seam is checked against the release notes. If upstream now
   does the job, the seam is dropped and its extensions move to the upstream way.
5. `master` is rebuilt as the release tag plus the fork's own commits (this register
   and the rebased seams), and the fork's release image is built from it.

To keep upgrades cheap, a seam changes as few core files as it can, keeps its
configuration and contracts in one declaration, and puts everything else in plugins,
adapters or skills.

Until upstream's next stable release, the seam branches are based on upstream
`master`. From then on, they are based on release tags.

## Seams

| ID | Seam | Status | Branch | Design and review | Upstream |
| --- | --- | --- | --- | --- | --- |
| S1 | Runner Pi configuration: Pi version, thinking levels, named Pi packages | design review | `seam/runner-pi-1.2` | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not offered |
| S2 | Manager interrupts or steers a report's run | planned | | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not offered |
| S3 | Fork pipeline: upstream sync, CI, release image | planned | | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not applicable |
| S4 | Sandbox callback bridge admits the run-scoped tool gateway: 4 exact routes plus the gateway session-token header (no allow-all) | parked (agents use Paperclip's staged runtime MCP) | `seam/sandbox-tool-gateway` (fixes: `hotfix/2026-11-11` @ f31f080: UUID-anchored revoke, token log redaction, queue_v1 60 s budget; challenger re-check PASS) | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not offered (upstream [#18748](https://github.com/paperclipai/paperclip/issues/18748); the broader [#18949](https://github.com/paperclipai/paperclip/pull/18949) is not used) |
| S5 | Runner Pi extensions: operator-named extension list (`PAPERCLIP_PI_EXTENSIONS`) and native mode (`PAPERCLIP_PI_EXTENSIONS_MODE=native`: Pi's own settings, packages, project .pi and -e, owned extension first, private session dir) | built, in review | `hq/2026-11-11c` @ 877b6be5 + e2104449 | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | draft for the owner's approval |
| S6 | Runner Pi thinking: a Claude model's top level runs as Pi xhigh, never max; only an identified GPT model keeps max (fail closed) | in tonight's hq image (build in progress) | `hq/2026-11-11c` @ e4e01bb7 + d892d229 | independent review PASS | not offered |
| S7 | Managed custom gateways for Runner Pi: a protocol-generic runner loopback broker (Chat, Messages, Responses) plus a per-harness custom-protocol declaration | building | `seam/runner-provider-broker` | [smarty-dev#20018](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20018), review `doc/seams/runner-provider-broker.md` | not offered |
| S8 | Provider-generic sandbox snapshot qualification: any sandbox provider plugin qualifies its snapshot through the existing `resolveSnapshotIdentity` handshake (`lease.metadata.snapshotIdentity`), not only Daytona | built, in review | `seam/provider-snapshot-qualification` @ 9e2f6e77 | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045), research `SNAPQ-A` | not offered |
| S9 | Sandbox leases release and reclaim a resident Runner: the native park/claim protocol over a trusted in-sandbox guardian, plus `releaseResume` for sandbox-provider leases (today only plugin-task leases have it) | building | `seam/sandbox-runner-retention` | [smarty-dev#4605 design record](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/4605#issuecomment-6816930556), spec `S9-SPEC` | not offered |
| S10 | Native Runner Pi harness `pi_rpc`: an OpenCode-style facade on the Codex executor, Pi 1.5.2 RPC kept resident, its own distribution and `piRpcThinkingLevel` | building | `pi-native/integration` | [smarty-dev#4605 design record](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/4605#issuecomment-6816930556) | not offered |

S1's scope and whether it splits into separate seams are being settled by its design
review. This table is updated when the review result is recorded.

S4 follow-ups (all under 5, only if S4 is un-parked): N1 the issue-update helper's 30 s curl timeout can double-apply a PATCH behind a long queue_v1 call; N2 the long budget also slows dead-exec detection; N3 a caller forwardTimeoutMs under 70 s gives a retryable 502; N4 slow test; N5 stale comments.

### S7 Runner provider broker

- **Problem**: a Runner Pi agent cannot use an organization's managed Messages or Responses gateway connection. AI-CONNECTIONS.md L703 and L719 say "Pi custom gateways ... are not part of this implementation."
- **No existing way**:
  - The only AI-connection plugin hook is `onRouteAiConnection` (plugin-sdk `define-plugin.ts:379-380`). It selects a pool member from host-resolved candidates. It cannot change harness compatibility, hold a key in the runner, or change the sidecar environment.
  - Environment hooks are per environment, and could only write a key into the sandbox, which is forbidden.
  - The Rust sidecar environment allowlist is core.
  - Skills are prompt text.
  - No upstream issue or pull request covers it (design pair's step-0 search, 2026-11-12).
- **Design**: OpenCode's session-scoped loopback broker is extracted into `packages/paperclip-runner/src/drivers/provider-loopback/`, with per-protocol adapters.
  - Each harness declares the custom protocols it consumes. Runner Pi declares Messages and Responses; legacy Pi declares none.
  - The environment contract is `PAPERCLIP_AI_PROVIDER_{URL,KEY,PROTOCOL,AUTH}` (OpenCode's names plus two), and the model is `paperclip/<id>`.
  - The key stays in runner memory, and Pi gets a loopback URL and a session token.
  - The configuration digest covers only the stable route, and the hello probe goes through the broker.
- **Extensions built on it**: Paul's Smarty (Runner Pi) on our CLIProxyAPI Messages and Responses gateway.
- **Tests**:
  - the broker: Chat, Messages and Responses; auth headers; 3xx rejected; 413; revoke on close;
  - the OpenCode driver, for regressions;
  - the Pi consumer: no key in files or the environment;
  - the gate: Runner yes, legacy no;
  - the projection and the digest;
  - the hello outcome;
  - the Rust allowlist.
- **Upstream**: not offered. The PR text is drafted, and offering it needs the product owner's yes.

### S8 Provider snapshot qualification

- **Problem**: a Runner agent on a non-Daytona sandbox provider (Boat) that starts from a provider snapshot gets no platform qualification. Discovery offers only Legacy, and converting to the Runner throws `agent_runner_unavailable`.
- **No existing way**:
  - `isQualifiableDaytonaSnapshot` and the probe accept only `provider === "daytona"` (`sandbox-snapshot-qualification.ts` L14-41, `environment-probe.ts` L38-68 at e053f733).
  - Template capture hooks capture a reference but don't qualify it.
  - The OCI-digest route is generic, but only for providers that boot from an immutable image digest.
  - The managed-Cloud exception doesn't apply to self-hosted instances.
  - Upstream has not changed this since 76da2fec, and no open pull request covers it.
- **Design**: `readSnapshotIdentity(value, ref, provider)` and `isQualifiableSandboxSnapshot`, with a deprecated Daytona alias kept. Daytona keeps its UUID rule. The probe requires the selected provider, the lease provider and the identity provider to be the same. The identity sits inside the existing v2 proof, so there is no migration.
  - The plugin returns `{provider, requestedRef, id, name, organizationId, createdAt}` only when asked with `resolveSnapshotIdentity:true`.
  - A pinned id creates by that id or fails; it never resolves a replacement name.
- **Extensions built on it**: the Boat sandbox plugin (cluster-lead) for the native Runner Pi harness.
- **Tests**: `sandbox-snapshot-qualification.test.ts` and `environment-probe.test.ts`, red 7 and green 89/89. The `environment-runtime` and `agent-runner-selection` regressions pass.
- **Upstream**: not offered. It is written to be offered, and needs the product owner's yes.

## Upstream-pending carries

A **carry** is an open upstream pull request that this fork applies unchanged before
upstream merges it. A carry is not a seam: it has no design of our own. Each one is
cherry-picked with `-x`, keeps its original authors, and stays as its own group of
commits. When upstream merges the pull request, the next upgrade drops the group.
Each carry records its test result and whether it is deployed.

| ID | Upstream pull requests | Branch | Status | Evidence |
| --- | --- | --- | --- | --- |
| C1 | Pool starvation: [#18744](https://github.com/paperclipai/paperclip/pull/18744), [#17833](https://github.com/paperclipai/paperclip/pull/17833), [#18928](https://github.com/paperclipai/paperclip/pull/18928) (issue [#18700](https://github.com/paperclipai/paperclip/issues/18700)) | `carry/pool-starvation` on `canary/v2026.1111.0-canary.4` | Tested locally, not deployed. Pool size 10: the burst is accepted (80/80, against 0/80 without it). Pool size 40: no proven gain. `DATABASE_POOL_MAX=40` is used instead. | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) |
| C2 | Lock timeout in legacy execution terminalization: [#17846](https://github.com/paperclipai/paperclip/pull/17846) (issue [#16417](https://github.com/paperclipai/paperclip/issues/16417)) | `carry/c2-55p03` on `canary/v2026.1111.0-canary.4` | Tested locally, not deployed. A run whose work succeeded was marked `adapter_failed` (55P03) when a child row held a lock on its run row. Our regression test fails 3/3 without the carry and passes 3/3 with it; the touched suites pass 129/129. | [smarty-dev#20094](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20094) |
| C3 | Pi sandbox runs honor cancellation until execution settles: [#19205](https://github.com/paperclipai/paperclip/pull/19205) (commit c5f317db, unchanged) | `upstream-pick/pr-19205` @ 68149e49 (on the hq image e2104449) | its own tests 7/7, red 7/7 without it; ships to hq only on a passing cancel proof | without it, a cancelled pi_local run leaves its sandbox command and Boat lease running |

Both are verified on canary.12 (`hq-next/p4p5` @ 09809c30) and are not yet in the hq image.

## Fork fixes (no upstream pull request yet)

Small fixes of our own, carried until upstream has an equivalent; each is checked at every merge-down.

| ID | Fix | Branch | Status | Upstream |
| --- | --- | --- | --- | --- |
| F1 | Persisted run-log chunk cap settable by `PAPERCLIP_RUN_LOG_MAX_CHUNK_CHARS` (default unchanged; export matching infers historical caps) | `fix/run-log-cap` @ b1e2579; in hq image | in tonight's hq image (hq setting: 1 MiB) | issue draft for the owner's approval |
| F2 | Keep a reusable plugin sandbox when its ordinary release fails (stop-and-retain instead of destroy) | `hq/2026-11-11b` @ 417b15bd + 3b94d9bf | in tonight's hq image; independent review PASS | not offered |
| F3 | Routine and issue-ancestor resource visibility | `fix/routine-embed-visibility` (PR #6) | parked (dropped from the switch) | U9 draft |

## Merge-down and redundancy check

Every merge-down onto a new upstream canary rebases each seam, carry and fix. A redundancy check then compares each against upstream master and the newest canary, dropping any patch upstream now covers. The result is posted as a comment on the 'Fork patches' task in the hq Paperclip instance. The hq image is built from the merged head with the documented Docker build and the full commit as `PAPERCLIP_BUILD_COMMIT`.

## Extensions on Paperclip's own surfaces (no seam)

| Extension | Surface | Tracking |
| --- | --- | --- |
| Dynamic budgets | Paperclip plugin | [smarty-dev#20052](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20052) |
| Langfuse export (smarty-langfuse-export) | Paperclip plugin | [smarty-dev#18268](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/18268) |

## Entry template

For each seam, add a section with these headings:

- **Problem**: what an operator or agent cannot do today.
- **No existing way**: what was searched, with links, and why each candidate falls
  short.
- **Design**: the configuration, contract and files touched in core, with a link to
  the review record.
- **Extensions built on it**: what uses the seam.
- **Tests**: the tests that cover the seam.
- **Upstream**: offered or not, with a link.
