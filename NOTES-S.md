# S — native Pi provider sweep

## Scope, versions and ownership

Builder: `dl-pi-sweep`, own ryzen4 worktree `/srv/scratch/paul/tasks/direct/dl-lane1c/paperclip-sweep`, branch `dl/pi-sweep`. Original base: `3bc2f233b`; remaining changes rebased onto dev-lead's combined integration heads as requested. Final parent and commit IDs are in the delivery section below.

All tests and typechecks ran on **ryzen4 over `ssh ryzen4-agent`**, never on R1. No push, GitHub changes, deployment, real paid provider request, or edits to `pi-rpc-driver.ts`. Local Pi executable/proxy artifact wiring remains L's work. The briefly assigned models.json/thinking issue was cancelled and returned to code-lead; no implementation was made by S. Agent `setupOnly` draft-model exception is C5b's reserved work and was not edited.

## Requirement / evidence map

1. Sweep provider switches, enums, unions, ternaries and lists in `server/`, `packages/shared`, `packages/adapter-utils`, `packages/paperclip-runner`: the line-by-line disposition tables below cover the 21 RFL sites plus the single-line and multiline candidate inventories. Raw grep hits containing provider names include fixtures, comments and tests; they are evidence inventories, not a claim that every occurrence is a production provider gate. Rust recovery/proxy exceptions are recorded separately.
2. Preserve the original six `native-pi-rpc-server-path.test.ts` cases: all six remain; two executor cases were added, one local and one remote sandbox. These invoke **`executePaperclipNativeSession`**, the real backend factory/native runtime/Codex facade driver, and a fake runnerd transport. Assertions require `providerWorkStarted=true`, a `turn.completed` event, successful native terminal result, exact `0.250000000` cost, complete usage and token counts. This proves the requested offline server/executor path, not a real Pi process or paid endpoint.
3. RED before sweep / GREEN after: `attempt-red.log` contains the two real executor attempts completing without the expected exact cost; `attempt-green.log` has 8/8 green after accounting inclusion. Earlier continuation proof RED/GREEN logs are retained. `planning-red.log` / `planning-green.log` cover the backend planning gate; `transport-planning-red.log` / `transport-planning-green.log` independently cover the runnerd transport's own planning mask. `metadata-red.log` covers Pi daemon command and runtime identity fallbacks. `pool-red.log` fails three missing pool/key behaviors; final test evidence covers the corrected implementations.
4. Spend/accounting: Pi uses per-turn aggregation, producer-owned remote runnerd usage delivery, provider/model billing and exact cost handling. Tests also repeat durable receipt/replay/lost-commit-response aggregation with a native Pi provider. Usage is delivered **if the runner emits it**; this does not claim to have verified a paid model's actual usage emission.
5. Schema changes were isolated: `48b05a7cf` changes only shared pool provider enum and matching OpenAPI enum, already integrated by dev-lead. No later shared-schema edits.
6. Plugin `runnerTask` and plugin setup/probe routes still reject Pi. Adding ordinary assigned-MCP relay does not opt Pi into plugin-owned process/task authority.

## Commits already delivered and integrated

- `48b05a7cf`: shared/OpenAPI pool enums (standalone schema commit).
- `5ba4e29e8`: continuation proof admits Pi only under existing exact stopped-run/ownership evidence; fail-closed cases remain. Tested independently before first interim.
- `9735d6371` (integrated as `6ed01d1e`): accounting/delivery/billing, MCP relay, Pi state persistence/root classification, identity/scope, prepared-state proof and cold admission timeout, plus two full executor attempts.
- `d2e142cb7` (integrated as `27e4a198`): Pi backend planning contract and correct `NativeProviderConfigV4` extraction (`pi_rpc`, not nonexistent `pi`).
- First interim R1 `pi-sweep-1.bundle`: SHA256 `2d578f56eea392cd05f6ad0adf3169bd40eb347c7730ded564e8092040c268ef`.
- Second interim R1 `pi-sweep-2.bundle`: SHA256 `984c44d0e2bcfc627160ffa30143e4eddba2a9fcccdbcbe96a77a8c3b21ea35d`.

## Exact check setup and commands

Worktree dependencies were linked using the sibling `paperclip-c5` layout. The first server typecheck could not resolve the runner package's declaration entrypoints because this new worktree had no runner `dist`. To satisfy that dependency, **I copied the ignored runner dist from paperclip-c5**. The exact successful setup/check sequence was:

```sh
ssh ryzen4-agent '
  cd /srv/scratch/paul/tasks/direct/dl-lane1c/paperclip-sweep
  cp -a ../paperclip-c5/packages/paperclip-runner/dist packages/paperclip-runner/
  export TMPDIR=/srv/scratch/paul/tasks/direct/dl-lane1c/tmp-rt
  cd server
  timeout 180 node ../scripts/run-tsc.mjs > /srv/scratch/paul/tasks/direct/dl-lane1c/sweep-evidence/typecheck.log 2>&1
'
```

Result: `TSC_EXIT=0`. This is a **server typecheck against that copied sibling runner declaration build**, not a newly rebuilt full runner distribution. No tracked integration files were changed to make it pass. `typecheck-final.log` / `.exit` record the repeat check after final changes, using the same ignored dist dependency. Runtime Vitest aliases resolve the runner source, not that copied dist.

Initial required complete run on `9735d6371`:

```sh
export TMPDIR=/srv/scratch/paul/tasks/direct/dl-lane1c/tmp-rt
export PATH=/home/paul/.cargo/bin:$PATH
cd /srv/scratch/paul/tasks/direct/dl-lane1c/paperclip-sweep/server
node ../node_modules/vitest/vitest.mjs run \
  src/services/native-runtime/native-session-executor.test.ts \
  src/services/native-runtime/native-usage-accounting.test.ts \
  src/services/native-runtime/native-usage-delivery.integration.test.ts \
  src/__tests__/native-pi-rpc-server-path.test.ts
```

`required-tests.log`: **4 files, 1461 tests passed**, 189.03 seconds. An SSH wrapper hit its idle-output timeout at 180 seconds, but the remote run completed and its saved Vitest summary is the evidence; no test failure was waived. An earlier path-filter command accidentally selected only the server-path file; it was not counted as the full requested suite and was replaced by the correct services/native-runtime paths above.

`run-sweep-final.sh` records the final expanded command (executor, both usage files, server-path, six Pi sweep contract cases, runtime-mode, adapter registry, complete AI router suite), a separate server typecheck, then backend factory plus focused runnerd planning tests. Its `.exit` and final log summaries are the authoritative final outcomes. Final exact counts are appended after completion.

## 21 independently supplied RFL sites

These locations are **exactly the RFL `3e061089` coordinates**, deliberately not shifted to the final file. Each source line has a disposition. “added” can mean a Pi sibling case in the enclosing switch; directory names are `pi-agent`, not the provider token `pi_rpc`.

| Source site | Decision | Reason |
|---|---|---|
| server/src/services/native-runtime/native-usage-delivery.ts:117 | added | Pi turn reports need the same replay-safe per-turn aggregation as OpenCode/ACPX. |
| server/src/services/native-runtime/native-harness-filesystem-independence.ts:594 | added | Recognize `pi-agent` only when the declared Pi persistence profile owns it. |
| server/src/services/native-runtime/native-harness-filesystem-independence.ts:638 | added | Apply the same profile-bound directory check to the second migration/restore validation. |
| server/src/services/native-runtime/native-usage-accounting.ts:217 | added | Remote runnerd Pi must deliver producer usage receipts when emitted. |
| server/src/services/native-runtime/plugin-runner-probe.ts:33 | not needed because plugin setup remains intentionally unsupported for Pi | Plugin-owned launch preparation/ownership is not the ordinary sandbox runnerd path. |
| server/src/services/native-runtime/native-session-executor.ts:7359 | added | Add filesystem directory `pi-agent` to the persistence-directory union/profile. |
| server/src/services/native-runtime/native-session-executor.ts:10897 | added | Pi current-turn usage must become replay-safe aggregate run usage and exact cost. |
| server/src/services/native-runtime/native-session-executor.ts:13214 | added | Use Pi's explicit provider/model biller, not unknown/Codex billing. |
| server/src/services/native-runtime/native-session-executor.ts:15303 | added | Native Pi needs assigned Paperclip MCP relay over authenticated PRP. |
| server/src/services/native-runtime/native-session-executor.ts:15480 | not needed because plugin runnerTask must keep refusing Pi | No change to the explicitly unsupported plugin process/task authority boundary. |
| server/src/services/agent-identity.ts:87 | added | Native Pi is a recognized local harness identity; do not display an unknown/implicit Codex identity. |
| server/src/routes/openapi.ts:4225 | added | Match the shared pool profile provider enum; isolated schema commit. |
| packages/shared/src/ai-connection-router.ts:16 | added | Pool member profiles can name native Pi explicitly; isolated schema commit. |
| packages/paperclip-runner/src/live/live-session.ts:136 | not needed because this is the separately qualified CapabilityLiveSession mock-control-plane/eval API | Production native executor builds its provider config directly and does not consume this snapshot type. |
| packages/paperclip-runner/src/live/live-session.ts:329 | not needed because this is the separately qualified eval session input | Do not imply Pi eval qualification by changing a production provider sweep. |
| packages/paperclip-runner/src/live/live-session.ts:653 | not needed because checkpoint validation belongs to that eval-only provider set | Pi production recovery uses native execution checkpoints, not capability-live checkpoints. |
| packages/paperclip-runner/src/live/live-session.ts:654 | not needed because this is the matching eval checkpoint error text | Keep the diagnostic consistent with the intentionally unchanged eval schema. |
| packages/paperclip-runner/src/live/runnerd-codex-transport.ts:9056 | not needed because probeNativeRunnerEnvironment is used by the plugin setup/probe route | That route must continue rejecting Pi; do not broaden its input union. |
| packages/paperclip-runner/src/live/runnerd-codex-transport.ts:9070 | not needed because this is the same plugin probe result union | Retain the same restricted input/output provider contract. |
| packages/paperclip-runner/src/live/runnerd-codex-transport.ts:9419 | added | Pi gets the existing 60-second native facade cold-admission budget. |
| packages/paperclip-runner/src/cli/eval-provider-runtime.ts:7 | not needed because this helper belongs to isolated mock-control-plane eval campaigns | The production native path does not use this eval permission/timeout policy. |

## Additional audited production / recovery sites

- `native-session-executor.ts:2131` (original base): **added** Pi provider-session scope case; preserve managed profile and ACPX-specific identity branches.
- `native-session-executor.ts:3247`: **added** Pi to restart-retire safe continuation proof, retaining every ownership, provider-state and stop-proof condition.
- `native-session-executor.ts:7401`: **added** a `pi-agent` filesystem persistence profile; sessions survive sandbox replacement, while auth, model routing and settings are re-materialized.
- `native-session-executor.ts:7641`: **added** Pi prepared/never-opened state proof using the facade checkpoint schema; ambiguous/active state remains rejected.
- `native-session-root-entries.ts:19`: **added** `pi-agent` as continuity-owned state, retired alongside the other session directories.
- `native-harness-filesystem-independence.ts:119`: **added** Pi to profile-bound migration fact checks; all terminal-run, lease, ownership, digest and checkpoint proofs remain required.
- `codex-native-backend.ts:135-138`: **added** Pi collaborative planning; actual read-only workspace and plan turn contract are tested, not just its descriptor.
- `runnerd-codex-transport.ts:4351-4354`: **added** Pi to the transport's `collaborationMode/list` mask. This is separate from the factory capability and nowhere near code-lead's run.attach retarget around line 572; their code is preserved.
- `contracts/native-execution.ts:163`: **added** `pi_rpc` to the inherited V4+ provider type; prior `pi` literal matched no `NativeProviderConfig` variant. Runtime parser already accepted Pi.
- `server/src/adapters/registry.ts:407`: **added** native Pi identity to the non-native coordinator-required error result instead of implicit Codex.
- `server/src/adapters/registry.ts:634-638`: **added** Pi's daemon-managed runtime command; no Codex npm detection/install command for native Pi.
- `server/src/services/native-runtime/runtime-mode.ts:257`: **added** Pi to fresh backward-compatible heartbeat metadata provider selection. The separately documented legacy persisted-selection contract is unchanged; the real new native path uses its richer backend/driver profile.
- `server/src/services/ai-connection-router.ts:18,32-64`: **added** native Pi member/runtime selection and `piRpcThinkingLevel`; validate via existing connection compatibility and native provider resolver. Model overrides stay in the selected member's explicit provider namespace. Invalid level/model overrides retain the member's default with the existing notes. A pinned non-Pi runtime clears stale Pi thinking keys.
- `server/src/routes/agents.ts:3211`: **not needed because** the native Pi model endpoint already has an earlier `pi_rpc` branch with a return at lines 3117-3148, using the selected authorized connection's model metadata. The later Codex fallback is unreachable for Pi. No redundant branch was added.
- `server/src/routes/agents.ts:2231`: **not needed in S because** C5b explicitly owns setupOnly drafts and agent setup/environment-test paths; S was instructed not to edit it.
- `server/src/routes/agents.ts:1912` and `company-portability.ts:5391`: **not needed because** native Pi maps to graduated `pi_local` harness identity in the existing next conjunct, and therefore is not blocked by the experimental provider list.
- `runnerd-codex-transport.ts:6398` (original snapshot): **not needed because** lost-predecessor source-integrity recovery still requires an advertised versioned recovery capability. Do not manufacture Pi source-recovery capability or bypass authority reconciliation merely to add a provider string.
- `native-session-executor.ts:10650,11398` (original-base vicinity): **not needed because** these paths bound retained plugin Codex/ACPX-Claude startup ownership, whose process/task contract remains unsupported for Pi.
- `native-session-executor.ts:11614`: **not needed because** this is an optional overlap optimization for GitHub preparation. All other providers still execute the same required preparation synchronously; it is not a launch/turn gate.
- `native-session-executor.ts:15758` (combined scan): **not needed because** OpenCode's provider executable/artifact backup is not Pi session-state persistence. Pi's profile-bound session directory is handled independently above.
- `native-provider-failure.ts:242`: **not needed because** the subsequent branches decode Codex-specific errors or OpenCode stream diagnostics, not generic runner failures. Generic structured `providerFailure` collection occurs before this restriction and remains available to Pi.
- `provider-profile.ts:728` and transport `:4165`: **not needed because** caller-owned preconfigured homes are qualified only for native Codex/ACPX Claude; Pi uses its isolated agent home and must not inherit their credential/home assumptions.
- `native-speed-budgets.ts:16,82-86`: **not needed because** these are measurement baselines for qualified historical Codex/Claude/OpenCode lanes, not an admission timeout; Pi's actual admission timeout is updated separately.
- `context-compaction.ts:61-62`, `runner-goals.ts:59,75,89`, transport `:1991-1994`: **not needed because** structured goal/compaction capabilities require a real provider protocol extension; do not advertise unsupported Pi controls based on a provider string.

### Rust cases deliberately retained

- `runner/crates/runner-core/src/provider_backend.rs:473`: **not needed because** restart-lost-turn continuation is explicitly qualified for local Codex/OpenCode process restart. Pi's resident bind/session reattachment must establish its own interruption/recovery proof before automatically retrying a vanished turn.
- Same file `:510`: **not needed because** `paperclip/runResult` accepts only verified OpenCode/Cursor proxy results. Pi completes through its native semantic tool/event path; accepting an unqualified proxy completion channel would weaken that boundary.
- Same file `:1730`: **not needed because** the durable lost-turn checkpoint path belongs to that same restricted restart contract, not normal warm Pi reattachment.
- Same file `:5914`: **already present** Pi facade/session identity recovery pair beside Codex; preserve code-lead's implementation.
- `runner/crates/runner-core/src/codex_provider.rs:255,636,1485,2317`: **already present** Pi in facade tools/identity/system-instruction/runtime-context branches; preserve the native implementation.

## Candidate-inventory disposition appendix

The following tables retain the scan coordinates. Nearby branches inside an already Pi-aware expression are recorded as **not needed because an explicit Pi branch already handles them**; they must not also receive Codex/ACPX-specific behavior. Eval/DevTools provider sets remain separately qualified and intentionally unchanged, as confirmed by dev-lead. These tables are a source audit ledger, not additional runtime compatibility claims.

| Candidate site (scan coordinates) | Disposition |
|---|---|
| `packages/adapter-utils/src/agent-observability.ts:5` | not needed because provider-native OTEL/session telemetry here is qualified Codex/Claude/OpenCode configuration, not Pi usage admission; Pi billing/events use the native accounting path. |
| `packages/adapter-utils/src/agent-observability.ts:46` | not needed because provider-native OTEL/session telemetry here is qualified Codex/Claude/OpenCode configuration, not Pi usage admission; Pi billing/events use the native accounting path. |
| `packages/adapter-utils/src/paperclip-runner-permissions.ts:2` | not needed because the union and permission builder already have explicit Pi handling; retain Codex/ACPX-specific validation for their branches. |
| `packages/adapter-utils/src/paperclip-runner-permissions.ts:154` | not needed because the union and permission builder already have explicit Pi handling; retain Codex/ACPX-specific validation for their branches. |
| `packages/adapter-utils/src/paperclip-runner-permissions.ts:156` | not needed because the union and permission builder already have explicit Pi handling; retain Codex/ACPX-specific validation for their branches. |
| `packages/adapter-utils/src/paperclip-runner-permissions.ts:210` | not needed because the union and permission builder already have explicit Pi handling; retain Codex/ACPX-specific validation for their branches. |
| `packages/adapter-utils/src/paperclip-runner-permissions.ts:258` | not needed because the union and permission builder already have explicit Pi handling; retain Codex/ACPX-specific validation for their branches. |
| `packages/adapter-utils/src/server-utils.ts:4366` | not needed because the explicit native provider selection/profile path handles Pi; keep provider-specific legacy aliases or metadata branches distinct. |
| `packages/paperclip-runner/devtools/issue-thread/src/App.tsx:66` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/devtools/issue-thread/src/App.tsx:140` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/devtools/issue-thread/src/App.tsx:144` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/devtools/issue-thread/src/App.tsx:152` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/devtools/issue-thread/src/App.tsx:161` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/devtools/issue-thread/src/App.tsx:974` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/devtools/issue-thread/src/App.tsx:1153` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/devtools/issue-thread/src/live-client.ts:45` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/spec/evals/schemas/runner-workflow-eval-case.v1.schema.json:14` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/spec/evals/schemas/runner-workflow-eval-case.v1.schema.json:27` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/spec/evals/schemas/runner-workflow-observation.v1.schema.json:11` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/backends/codex-acpx-native-backend.ts:94` | not needed because this backend explicitly requires ACPX Codex; native Pi uses the Pi-aware facade backend. |
| `packages/paperclip-runner/src/backends/codex-native-backend.ts:75` | added Pi planning workspace/turn contract; facade identity and version/profile branches already explicitly handle Pi. |
| `packages/paperclip-runner/src/backends/codex-native-backend.ts:76` | added Pi planning workspace/turn contract; facade identity and version/profile branches already explicitly handle Pi. |
| `packages/paperclip-runner/src/backends/codex-native-backend.ts:78` | added Pi planning workspace/turn contract; facade identity and version/profile branches already explicitly handle Pi. |
| `packages/paperclip-runner/src/backends/codex-native-backend.ts:84` | added Pi planning workspace/turn contract; facade identity and version/profile branches already explicitly handle Pi. |
| `packages/paperclip-runner/src/backends/codex-native-backend.ts:86` | added Pi planning workspace/turn contract; facade identity and version/profile branches already explicitly handle Pi. |
| `packages/paperclip-runner/src/backends/codex-native-backend.ts:92` | added Pi planning workspace/turn contract; facade identity and version/profile branches already explicitly handle Pi. |
| `packages/paperclip-runner/src/backends/codex-native-backend.ts:131` | added Pi planning workspace/turn contract; facade identity and version/profile branches already explicitly handle Pi. |
| `packages/paperclip-runner/src/backends/codex-native-backend.ts:221` | added Pi planning workspace/turn contract; facade identity and version/profile branches already explicitly handle Pi. |
| `packages/paperclip-runner/src/backends/native-backend-factory.ts:121` | not needed because factory has an explicit native Pi facade selection branch. |
| `packages/paperclip-runner/src/cli/eval-gateway-runtime.ts:39` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-gateway-runtime.ts:47` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-observability-runtime.ts:69` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-observability-runtime.ts:75` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-provider-runtime.ts:7` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-provider-runtime.ts:18` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session-contract.ts:127` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session-contract.ts:230` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session-contract.ts:238` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session-contract.ts:254` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session-contract.ts:276` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session-contract.ts:285` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session-contract.ts:311` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session.ts:207` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session.ts:220` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session.ts:387` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session.ts:452` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/cli/eval-session.ts:505` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:128` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:161` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:163` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:478` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:594` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:602` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:614` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:623` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:632` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:1020` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:1024` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:1050` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/contracts/native-execution.ts:1073` | explicit Pi facade/environment/session branches already exist; preserve non-Pi defaults and provider-specific branches. |
| `packages/paperclip-runner/src/drivers/agent-observability.ts:8` | not needed because provider-native OTEL/session telemetry here is qualified Codex/Claude/OpenCode configuration, not Pi usage admission; Pi billing/events use the native accounting path. |
| `packages/paperclip-runner/src/drivers/codex/codex-session-server-requests.ts:313` | not needed because this is provider-specific Codex/ACPX server-request serialization; Pi completes using its native protocol. |
| `packages/paperclip-runner/src/eval/live-workflow-matrix.ts:204` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/eval/workflow-catalog.ts:8` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/eval/workflow-contracts.ts:23` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/eval/workflow-harness.ts:26` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/eval/workflow-harness.ts:34` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/issue-thread/live-projection.ts:757` | not needed because the explicit native provider selection/profile path handles Pi; keep provider-specific legacy aliases or metadata branches distinct. |
| `packages/paperclip-runner/src/live/live-session.ts:136` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:329` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:623` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:634` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:645` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:653` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:654` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:910` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:920` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:927` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:938` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:971` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:979` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:2159` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:2191` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/live-session.ts:2398` | not needed because this is a separately qualified DevTools/mock-control-plane eval provider set, not production native Pi admission. |
| `packages/paperclip-runner/src/live/runner-provider-launch.ts:142` | not needed because explicit native Pi provider/profile/driver handling already exists alongside the non-Pi branches. |
| `packages/paperclip-runner/src/live/runner-provider-launch.ts:222` | not needed because explicit native Pi provider/profile/driver handling already exists alongside the non-Pi branches. |
| `packages/paperclip-runner/src/live/runner-provider-launch.ts:228` | not needed because explicit native Pi provider/profile/driver handling already exists alongside the non-Pi branches. |
| `packages/paperclip-runner/src/live/runner-provider-launch.ts:230` | not needed because explicit native Pi provider/profile/driver handling already exists alongside the non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:1563` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:1991` | not needed because provider-native goal controls are not qualified for Pi; ordinary plan mode is enabled separately. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:3832` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4146` | not needed because caller-owned homes are only qualified for Codex/ACPX-Claude; Pi uses isolated agent home. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4152` | not needed because caller-owned homes are only qualified for Codex/ACPX-Claude; Pi uses isolated agent home. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4153` | not needed because caller-owned homes are only qualified for Codex/ACPX-Claude; Pi uses isolated agent home. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4154` | not needed because caller-owned homes are only qualified for Codex/ACPX-Claude; Pi uses isolated agent home. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4159` | not needed because caller-owned homes are only qualified for Codex/ACPX-Claude; Pi uses isolated agent home. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4163` | not needed because caller-owned homes are only qualified for Codex/ACPX-Claude; Pi uses isolated agent home. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4165` | not needed because caller-owned homes are only qualified for Codex/ACPX-Claude; Pi uses isolated agent home. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4267` | added Pi collaborationMode/list planning mask; underlying run.attach retarget remains untouched. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4270` | added Pi collaborationMode/list planning mask; underlying run.attach retarget remains untouched. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4272` | added Pi collaborationMode/list planning mask; underlying run.attach retarget remains untouched. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4345` | added Pi collaborationMode/list planning mask; underlying run.attach retarget remains untouched. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:4353` | added Pi collaborationMode/list planning mask; underlying run.attach retarget remains untouched. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:5204` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:5213` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:5874` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:5902` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:5929` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:5942` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:5984` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:5986` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:6000` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:6358` | not needed because lost-predecessor source recovery requires an advertised versioned recovery capability, not an unqualified Pi provider string. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:6398` | not needed because lost-predecessor source recovery requires an advertised versioned recovery capability, not an unqualified Pi provider string. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:6404` | not needed because lost-predecessor source recovery requires an advertised versioned recovery capability, not an unqualified Pi provider string. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:6412` | not needed because lost-predecessor source recovery requires an advertised versioned recovery capability, not an unqualified Pi provider string. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:6677` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:7012` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:8341` | not needed because explicit Pi facade/provider/session/environment branches already exist alongside these provider-specific non-Pi branches. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:9056` | added Pi cold facade admission timeout; plugin environment probe input/output unions intentionally stay restricted. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:9070` | added Pi cold facade admission timeout; plugin environment probe input/output unions intentionally stay restricted. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:9084` | added Pi cold facade admission timeout; plugin environment probe input/output unions intentionally stay restricted. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:9308` | added Pi cold facade admission timeout; plugin environment probe input/output unions intentionally stay restricted. |
| `packages/paperclip-runner/src/live/runnerd-codex-transport.ts:9419` | added Pi cold facade admission timeout; plugin environment probe input/output unions intentionally stay restricted. |
| `packages/paperclip-runner/src/native-session-runtime.ts:2902` | not needed because explicit native Pi provider/profile/driver handling already exists alongside the non-Pi branches. |
| `packages/shared/src/agent-runner.ts:13` | not needed because explicit native Pi provider/profile/driver handling already exists alongside the non-Pi branches. |
| `packages/shared/src/agent-runner.ts:18` | not needed because explicit native Pi provider/profile/driver handling already exists alongside the non-Pi branches. |
| `packages/shared/src/agent-runner.ts:32` | not needed because explicit native Pi provider/profile/driver handling already exists alongside the non-Pi branches. |
| `packages/shared/src/ai-connection-router.ts:16` | added Pi to shared pool profile provider enum in isolated schema commit. |
| `packages/shared/src/mcp-setup.ts:3` | not needed because this shared legacy MCP setup provider contract is separate from the native Pi assigned-MCP relay in the executor. |
| `packages/shared/src/mcp-setup.ts:19` | not needed because this shared legacy MCP setup provider contract is separate from the native Pi assigned-MCP relay in the executor. |
| `packages/shared/src/mcp-setup.ts:29` | not needed because this shared legacy MCP setup provider contract is separate from the native Pi assigned-MCP relay in the executor. |
| `server/src/adapters/registry.ts:407` | added Pi-specific coordinator error identity and daemon-managed runtime command; ordinary adapter listModels has a dedicated connection-backed Pi route before the legacy Codex fallback. |
| `server/src/adapters/registry.ts:415` | added Pi-specific coordinator error identity and daemon-managed runtime command; ordinary adapter listModels has a dedicated connection-backed Pi route before the legacy Codex fallback. |
| `server/src/adapters/registry.ts:634` | added Pi-specific coordinator error identity and daemon-managed runtime command; ordinary adapter listModels has a dedicated connection-backed Pi route before the legacy Codex fallback. |
| `server/src/routes/agents.ts:1904` | not needed because Pi resolves to graduated pi_local harness in the adjacent graduated-harness check. |
| `server/src/routes/agents.ts:1912` | not needed because Pi resolves to graduated pi_local harness in the adjacent graduated-harness check. |
| `server/src/routes/agents.ts:1957` | not needed because Pi resolves to graduated pi_local harness in the adjacent graduated-harness check. |
| `server/src/routes/agents.ts:1986` | not needed because Pi resolves to graduated pi_local harness in the adjacent graduated-harness check. |
| `server/src/routes/agents.ts:2230` | not needed in S because setupOnly agent drafts/environment tests are explicitly reserved to C5b. |
| `server/src/routes/agents.ts:3206` | not needed because the earlier native Pi model branch returns connection metadata before this legacy Codex/OpenCode fallback. |
| `server/src/routes/agents.ts:3211` | not needed because the earlier native Pi model branch returns connection metadata before this legacy Codex/OpenCode fallback. |
| `server/src/routes/agents.ts:3304` | not needed because the earlier native Pi model branch returns connection metadata before this legacy Codex/OpenCode fallback. |
| `server/src/routes/agents.ts:3580` | not needed because the earlier native Pi model branch returns connection metadata before this legacy Codex/OpenCode fallback. |
| `server/src/routes/openapi.ts:4225` | added Pi to matching pool profile enum in isolated schema commit. |
| `server/src/services/agent-identity.ts:87` | added native Pi local harness identity; provider-specific managed/Cursor identities remain distinct. |
| `server/src/services/agent-observability-launch.ts:5` | not needed because provider-native OTEL/session telemetry here is qualified Codex/Claude/OpenCode configuration, not Pi usage admission; Pi billing/events use the native accounting path. |
| `server/src/services/ai-connection-router.ts:32` | added Pi pool provider identity, compatible model override and piRpcThinkingLevel; retain provider-specific effort keys for non-Pi members. |
| `server/src/services/ai-connection-router.ts:56` | added Pi pool provider identity, compatible model override and piRpcThinkingLevel; retain provider-specific effort keys for non-Pi members. |
| `server/src/services/ai-connection-router.ts:59` | added Pi pool provider identity, compatible model override and piRpcThinkingLevel; retain provider-specific effort keys for non-Pi members. |
| `server/src/services/company-portability.ts:3654` | not needed because Pi resolves to graduated pi_local harness in the adjacent graduated-harness check. |
| `server/src/services/company-portability.ts:5384` | not needed because Pi resolves to graduated pi_local harness in the adjacent graduated-harness check. |
| `server/src/services/company-portability.ts:5391` | not needed because Pi resolves to graduated pi_local harness in the adjacent graduated-harness check. |
| `server/src/services/context-compaction.ts:58` | not needed because structured native goal/compaction controls need separately qualified provider protocols; Pi must not advertise them by string inclusion. |
| `server/src/services/environment-task-runtime.ts:443` | not needed because the explicit native provider selection/profile path handles Pi; keep provider-specific legacy aliases or metadata branches distinct. |
| `server/src/services/heartbeat/execution-configuration.ts:121` | not needed because the explicit native provider selection/profile path handles Pi; keep provider-specific legacy aliases or metadata branches distinct. |
| `server/src/services/native-runtime/native-agent-runtime-inheritance.ts:75` | not needed because managed profile inheritance is specifically claude_managed; Pi uses its own explicit provider profile. |
| `server/src/services/native-runtime/native-execution-input.ts:100` | not needed because explicit Pi conversion/validation precedes these non-Pi branches; do not assign Pi Codex/OpenCode/ACPX settings. |
| `server/src/services/native-runtime/native-execution-input.ts:120` | not needed because explicit Pi conversion/validation precedes these non-Pi branches; do not assign Pi Codex/OpenCode/ACPX settings. |
| `server/src/services/native-runtime/native-execution-input.ts:156` | not needed because explicit Pi conversion/validation precedes these non-Pi branches; do not assign Pi Codex/OpenCode/ACPX settings. |
| `server/src/services/native-runtime/native-execution-input.ts:315` | not needed because explicit Pi conversion/validation precedes these non-Pi branches; do not assign Pi Codex/OpenCode/ACPX settings. |
| `server/src/services/native-runtime/native-execution-input.ts:317` | not needed because explicit Pi conversion/validation precedes these non-Pi branches; do not assign Pi Codex/OpenCode/ACPX settings. |
| `server/src/services/native-runtime/native-execution-input.ts:327` | not needed because explicit Pi conversion/validation precedes these non-Pi branches; do not assign Pi Codex/OpenCode/ACPX settings. |
| `server/src/services/native-runtime/native-execution-input.ts:329` | not needed because explicit Pi conversion/validation precedes these non-Pi branches; do not assign Pi Codex/OpenCode/ACPX settings. |
| `server/src/services/native-runtime/native-execution-input.ts:366` | not needed because explicit Pi conversion/validation precedes these non-Pi branches; do not assign Pi Codex/OpenCode/ACPX settings. |
| `server/src/services/native-runtime/native-harness-filesystem-independence.ts:119` | added profile-bound Pi state migration and pi-agent directory handling with the original ownership/lease/digest proofs. |
| `server/src/services/native-runtime/native-harness-filesystem-independence.ts:586` | added profile-bound Pi state migration and pi-agent directory handling with the original ownership/lease/digest proofs. |
| `server/src/services/native-runtime/native-harness-filesystem-independence.ts:594` | added profile-bound Pi state migration and pi-agent directory handling with the original ownership/lease/digest proofs. |
| `server/src/services/native-runtime/native-harness-filesystem-independence.ts:630` | added profile-bound Pi state migration and pi-agent directory handling with the original ownership/lease/digest proofs. |
| `server/src/services/native-runtime/native-harness-filesystem-independence.ts:638` | added profile-bound Pi state migration and pi-agent directory handling with the original ownership/lease/digest proofs. |
| `server/src/services/native-runtime/native-provider-failure.ts:202` | not needed because these decode Codex/OpenCode-specific diagnostics; generic structured providerFailure handling runs before the restriction. |
| `server/src/services/native-runtime/native-provider-failure.ts:237` | not needed because these decode Codex/OpenCode-specific diagnostics; generic structured providerFailure handling runs before the restriction. |
| `server/src/services/native-runtime/native-provider-failure.ts:242` | not needed because these decode Codex/OpenCode-specific diagnostics; generic structured providerFailure handling runs before the restriction. |
| `server/src/services/native-runtime/native-provider-failure.ts:246` | not needed because these decode Codex/OpenCode-specific diagnostics; generic structured providerFailure handling runs before the restriction. |
| `server/src/services/native-runtime/native-session-executor.ts:1113` | added Pi missing-binding environment sanitization; do not promote ambient credentials into explicit company/provider input. |
| `server/src/services/native-runtime/native-session-executor.ts:2114` | added Pi sibling scope case; retain distinct managed/ACPX/Codex identity rules. |
| `server/src/services/native-runtime/native-session-executor.ts:2115` | added Pi sibling scope case; retain distinct managed/ACPX/Codex identity rules. |
| `server/src/services/native-runtime/native-session-executor.ts:2120` | added Pi sibling scope case; retain distinct managed/ACPX/Codex identity rules. |
| `server/src/services/native-runtime/native-session-executor.ts:2125` | added Pi sibling scope case; retain distinct managed/ACPX/Codex identity rules. |
| `server/src/services/native-runtime/native-session-executor.ts:2131` | added Pi sibling scope case; retain distinct managed/ACPX/Codex identity rules. |
| `server/src/services/native-runtime/native-session-executor.ts:3247` | added Pi only under existing stopped-run/ownership/lease/provider-state continuation proof. |
| `server/src/services/native-runtime/native-session-executor.ts:7359` | added profile-bound pi-agent persistence-directory union and filesystem profile. |
| `server/src/services/native-runtime/native-session-executor.ts:7465` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7466` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7467` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7468` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7470` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7472` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7473` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7504` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7573` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:7636` | added exact Pi prepared/never-opened provider-state proof; active or ambiguous state remains rejected. |
| `server/src/services/native-runtime/native-session-executor.ts:7639` | added exact Pi prepared/never-opened provider-state proof; active or ambiguous state remains rejected. |
| `server/src/services/native-runtime/native-session-executor.ts:7640` | added exact Pi prepared/never-opened provider-state proof; active or ambiguous state remains rejected. |
| `server/src/services/native-runtime/native-session-executor.ts:7641` | added exact Pi prepared/never-opened provider-state proof; active or ambiguous state remains rejected. |
| `server/src/services/native-runtime/native-session-executor.ts:9941` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:9943` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:9951` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:10221` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:10650` | not needed because these retained-context/startup routes belong to plugin Codex/ACPX-Claude process ownership, still unsupported for Pi. |
| `server/src/services/native-runtime/native-session-executor.ts:10653` | not needed because these retained-context/startup routes belong to plugin Codex/ACPX-Claude process ownership, still unsupported for Pi. |
| `server/src/services/native-runtime/native-session-executor.ts:10899` | added Pi per-turn usage aggregation and exact cost projection. |
| `server/src/services/native-runtime/native-session-executor.ts:10922` | added Pi per-turn usage aggregation and exact cost projection. |
| `server/src/services/native-runtime/native-session-executor.ts:10924` | added Pi per-turn usage aggregation and exact cost projection. |
| `server/src/services/native-runtime/native-session-executor.ts:10932` | added Pi per-turn usage aggregation and exact cost projection. |
| `server/src/services/native-runtime/native-session-executor.ts:11398` | not needed because these retained-context/startup routes belong to plugin Codex/ACPX-Claude process ownership, still unsupported for Pi. |
| `server/src/services/native-runtime/native-session-executor.ts:11614` | not needed because this only overlaps GitHub preparation for qualified providers; other providers still run required preparation synchronously. |
| `server/src/services/native-runtime/native-session-executor.ts:11622` | not needed because this only overlaps GitHub preparation for qualified providers; other providers still run required preparation synchronously. |
| `server/src/services/native-runtime/native-session-executor.ts:13172` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:13182` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:13207` | added Pi provider/model billing branch. |
| `server/src/services/native-runtime/native-session-executor.ts:13216` | added Pi provider/model billing branch. |
| `server/src/services/native-runtime/native-session-executor.ts:13225` | added Pi provider/model billing branch. |
| `server/src/services/native-runtime/native-session-executor.ts:13228` | added Pi provider/model billing branch. |
| `server/src/services/native-runtime/native-session-executor.ts:15305` | added Pi assigned Paperclip MCP relay; does not enable plugin runnerTask. |
| `server/src/services/native-runtime/native-session-executor.ts:15482` | not needed because plugin-owned runnerTask/process setup intentionally remains unsupported for Pi. |
| `server/src/services/native-runtime/native-session-executor.ts:15507` | not needed because plugin-owned runnerTask/process setup intentionally remains unsupported for Pi. |
| `server/src/services/native-runtime/native-session-executor.ts:15657` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:15723` | not needed because this is provider-specific executable/artifact handling, not Pi session persistence. |
| `server/src/services/native-runtime/native-session-executor.ts:15725` | not needed because this is provider-specific executable/artifact handling, not Pi session persistence. |
| `server/src/services/native-runtime/native-session-executor.ts:15756` | not needed because this is provider-specific executable/artifact handling, not Pi session persistence. |
| `server/src/services/native-runtime/native-session-executor.ts:15771` | not needed because this is provider-specific executable/artifact handling, not Pi session persistence. |
| `server/src/services/native-runtime/native-session-executor.ts:17203` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:17234` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:17273` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:17307` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-session-executor.ts:17355` | not needed because explicit native Pi launch/environment/binding handling already exists, or the branch is intentionally specific to managed Claude/Codex/ACPX; Pi receives its own profile/config. |
| `server/src/services/native-runtime/native-speed-budgets.ts:16` | not needed because these are qualified historical speed baselines, not a provider launch gate; actual Pi cold admission timeout is updated separately. |
| `server/src/services/native-runtime/native-speed-budgets.ts:82` | not needed because these are qualified historical speed baselines, not a provider launch gate; actual Pi cold admission timeout is updated separately. |
| `server/src/services/native-runtime/native-usage-accounting.ts:43` | added Pi producer-owned remote usage delivery; generic usage normalizers remain provider independent. |
| `server/src/services/native-runtime/native-usage-accounting.ts:217` | added Pi producer-owned remote usage delivery; generic usage normalizers remain provider independent. |
| `server/src/services/native-runtime/native-usage-delivery.ts:117` | added Pi replay-safe per-turn aggregation; provider-neutral normalization remains unchanged. |
| `server/src/services/native-runtime/native-usage-delivery.ts:192` | added Pi replay-safe per-turn aggregation; provider-neutral normalization remains unchanged. |
| `server/src/services/native-runtime/plugin-runner-probe.ts:33` | not needed because plugin-owned setup/probe intentionally rejects Pi. |
| `server/src/services/native-runtime/plugin-runner-probe.ts:48` | not needed because plugin-owned setup/probe intentionally rejects Pi. |
| `server/src/services/native-runtime/plugin-runner-probe.ts:59` | not needed because plugin-owned setup/probe intentionally rejects Pi. |
| `server/src/services/native-runtime/plugin-task-source-recovery.ts:19` | not needed because plugin-owned task/source-recovery protocols remain intentionally unqualified for native Pi. |
| `server/src/services/native-runtime/plugin-task-source-recovery.ts:27` | not needed because plugin-owned task/source-recovery protocols remain intentionally unqualified for native Pi. |
| `server/src/services/native-runtime/provider-profile.ts:50` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:60` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:72` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:87` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:100` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:538` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:554` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:659` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:724` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:728` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:734` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/provider-profile.ts:764` | not needed because caller-owned preconfigured homes are qualified Codex/ACPX-Claude only; Pi uses isolated agent home/settings. |
| `server/src/services/native-runtime/remote-provider-pack-verification.ts:43` | not needed because this is the generic non-Pi provider-pack identity mapping; native Pi uses its dedicated profile-bound facade packaging/verification path. |
| `server/src/services/native-runtime/remote-provider-pack-verification.ts:76` | not needed because this is the generic non-Pi provider-pack identity mapping; native Pi uses its dedicated profile-bound facade packaging/verification path. |
| `server/src/services/native-runtime/runtime-mode.ts:133` | added Pi fresh heartbeat provider metadata; native saved-selection resolver already has an explicit Pi branch, so non-Pi branches retain their own contracts. |
| `server/src/services/native-runtime/runtime-mode.ts:254` | added Pi fresh heartbeat provider metadata; native saved-selection resolver already has an explicit Pi branch, so non-Pi branches retain their own contracts. |
| `server/src/services/native-runtime/runtime-mode.ts:263` | added Pi fresh heartbeat provider metadata; native saved-selection resolver already has an explicit Pi branch, so non-Pi branches retain their own contracts. |
| `server/src/services/provider-trace-store.ts:30` | not needed because provider-native OTEL/session telemetry here is qualified Codex/Claude/OpenCode configuration, not Pi usage admission; Pi billing/events use the native accounting path. |
| `server/src/services/runner-goals.ts:54` | not needed because structured native goal/compaction controls need separately qualified provider protocols; Pi must not advertise them by string inclusion. |
| `server/src/services/runner-goals.ts:59` | not needed because structured native goal/compaction controls need separately qualified provider protocols; Pi must not advertise them by string inclusion. |
| `server/src/services/runner-goals.ts:67` | not needed because structured native goal/compaction controls need separately qualified provider protocols; Pi must not advertise them by string inclusion. |
| `server/src/services/runner-goals.ts:89` | not needed because structured native goal/compaction controls need separately qualified provider protocols; Pi must not advertise them by string inclusion. |

Inventory rows: **260** distinct production single-line/multiline candidate coordinates, plus the 21 exact RFL rows and separately described Rust sites above.

## Final delivery / latest evidence

Final code commit before adding this notes file: `362297a1d`, parent **`5a62891ee`**, clean rebase (no conflicts). Code-lead run.attach retarget is preserved: the only transport diff adds one Pi line at collaborationMode/list around L4359. Models/thinking driver files are untouched.

- Before rebase, full expanded server run: **8 files / 1574 tests passed**, 447.53s (`final-tests.log`, exit 0). This includes full executor and both usage suites.
- Before rebase, focused runner factory/native-Pi/planning run: **78 passed, 306 intentionally filtered skips**, exit 0.
- After rebase and the final missing-binding environment guard: **5 files / 120 tests passed**, 124.91s (`sweep-postrebase.log`); includes all eight server-path cases, seven Pi contract tests, complete AI router suite, runtime mode, registry.
- After rebase runner factory/native-Pi/planning: **78 passed, 306 intentionally filtered skips**, exit 0 (`sweep-postrebase-runner.log`).
- Server typecheck after rebase: **exit 0** (`sweep-postrebase-tsc.log`), with the copied sibling runner declaration dependency disclosed above.
- Last discovered credential fallback: `resolveNativeProviderEnvironment` now sanitizes a native Pi host environment if explicit company/provider bindings are absent, matching the candidate legacy Pi safety rule. `ambient-red.log` proves the old code promoted three ambient keys; the seven-case post-rebase contract file proves sanitization and preservation of explicit bindings. No real credentials were used.
- Full 1574-case run preceded the last one-line environment guard/rebase; it is not falsely represented as a full rerun on the final SHA. The affected guard and server path were rerun after both.

Logs are on ryzen4 under `sweep-evidence/` and `paperclip-sweep/sweep-postrebase*.log`; untracked log files are not part of the code commit. No paid provider / live production environment was exercised.
