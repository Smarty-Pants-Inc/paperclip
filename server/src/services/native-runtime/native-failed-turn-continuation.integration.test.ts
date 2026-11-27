import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import express from "express";
import request from "supertest";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueComments, issueAttachments, assets, issues, nativeRunFinalizations, statusDecisions, heartbeatRunEvents, environmentLeases, authUsers } from "@paperclipai/db";
import { buildNativeModelEnvelope, executeNativeSession, HarnessDriverBackend, type PersistedNativeSession, type NativeSession, type ControlPlanePort, type NativeExecutionInputV1, type PrpEvent, type PrpTerminalState } from "@paperclipai/paperclip-runner";
import { CodexAcpxDriver } from "../../../../packages/paperclip-runner/dist/drivers/acpx/codex-acpx-driver.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn(), backendOptions: {} as Record<string, unknown>, transport: {} as Record<string, unknown>, onBackendCreate: undefined as (() => void) | undefined }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
  createNativeSessionBackend: vi.fn((_execution, options) => { provider.backendOptions = options; provider.onBackendCreate?.(); return {}; }),
  createRunnerdCodexTransport: vi.fn(options => { provider.transport = options; return { transport: {} }; }),
}));
vi.mock("../../runtime-api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../runtime-api.js")>(), resolveLocalRuntimeApiUrl: () => "http://127.0.0.1:3100",
}));
vi.mock("./paperclip-runner-tool-authority.js", () => ({ PaperclipRunnerToolAuthority: class {
  readonly binding = {};
  async definitions() { return []; }
  close() {}
} }));

import { buildNativeHarnessBackupManifest, createRunnerdBackend, executePaperclipNativeSession, providerSessionIdentityFromDurableProviderState, scopedRunnerdStateRoot, verifyNativeHarnessBackupStreamed } from "./native-session-executor.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";
import { QUALIFIED_ACPX_PROFILES, QUALIFIED_ACPX_VERSION } from "../../vendor/paperclip-runner/index.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { readNativeContinuationSource } from "./native-continuation-delivery.js";
import { NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } from "./status-arbiter.js";
import { heartbeatService } from "../heartbeat.js";
import { requestTaskRetry } from "../task-retry.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { buildPaperclipWakePayload, createHeartbeatRunPreparation } from "../heartbeat/run-preparation.js";
import { prepareHeartbeatTaskContext } from "../heartbeat/task-context.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeExecutionWithCheckpoint, nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import * as controllerRecovery from "./native-controller-recovery.js";

type FailureCode = "opencode_server_exited" | "opencode_empty_response";
type RetryStateSource = "older_backup" | "current_backup" | "unknown_cursor" | "own_box" | "reinvoked_backup" | "missing_state" | "unreadable_state" | "other_turn_end" | "other_turn_message_completed" | "callsite_backup";
type SourceOutcome = "completed" | "error" | "cancel" | "history_submit_fails" | "turn_completed";

/** Real server backup verification, file restore and pre-parse retry fence.
 * The remote command/file boundary is local and the provider pack is controlled.
 */
async function prepareRetryState(db: ReturnType<typeof createDb>, execution: ReturnType<typeof buildNativeExecutionInput>,
  sourceRunId: string, stateSource: RetryStateSource) {
  const root = await mkdtemp(join(tmpdir(), "retry-state-source-"));
  const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  process.env.PAPERCLIP_RUNNER_STATE_DIR = join(root, "controller");
  try {
    const sha = `sha256:${"a".repeat(64)}`;
    const artifacts = Object.fromEntries(Object.entries({ grokLauncher: "dist/providers/grok/launcher.cjs",
      nodeCommand: "node_modules/node/bin/node", productionLock: "pnpm-lock.yaml", opencodeCommand: "node_modules/.bin/opencode",
      opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe", opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs",
      acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs" }).map(([name, path]) => [name, { path, sha256: sha }]));
    const payload = { compatibility: { opencode: 1, acpx: 1, pi_rpc: 1 }, contractDigest: sha,
      target: { platform: "linux", architecture: "x64" }, runnerSourceRevision: "a".repeat(40),
      pins: { nodeMinimum: "24.11.0", codex: QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion, opencode: "1.18.34",
        acpx: QUALIFIED_ACPX_VERSION, grok: QUALIFIED_ACPX_PROFILES.grok.agentRuntimeVersion,
        claudeAcp: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion, codexAcp: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion },
      acpxProfileDigests: Object.fromEntries(["grok", "claude", "codex"].map(agent =>
        [agent, QUALIFIED_ACPX_PROFILES[agent as "grok" | "claude" | "codex"].commandDigest])),
      artifacts, distDigest: sha, bridgeDigest: `sha256:${createHash("sha256").update(`${sha}\n${sha}\n${sha}`).digest("hex")}` };
    const pack = { schema: "paperclip-runner/remote-provider-pack/v1", payload,
      digest: `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}` };
    await writeFile(join(root, "provider-pack.json"), JSON.stringify(pack));
    const binary = join(root, "fixture-runnerd");
    const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.writeUInt16LE(62, 18);
    await writeFile(binary, elf);
    const remoteCwd = join(root, "remote");
    const sessionId = execution.session.normalizedSessionId!;
    const remoteSession = join(remoteCwd, ".paperclip-runtime/paperclip-runner/sessions", createHash("sha256").update(sessionId).digest("hex"));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
    // Even the older backup has the SAME run/provider identity: it was captured
    // before that run's terminal event. Identity alone must not admit compact.
    const runnerState = { schema: "paperclip.runner.durable.state.v1", runId: sourceRunId,
      normalizedSessionId: sessionId, runnerInstanceId: source.runnerInstanceId, lifecycle: "suspended",
      nextSourceSeq: stateSource === "unknown_cursor" ? undefined : stateSource === "current_backup" ? 4 : ["other_turn_end", "other_turn_message_completed"].includes(stateSource) ? 6 : 3,
      ackedSourceSeq: 0, outbox: [], pendingTerminalDelivery: null };
    const providerState = { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "prepared", threadId: "saved-provider-conversation",
      providerSessionId: null, activeProviderTurnId: null, config: { provider: "pi_rpc", driver: "pi_rpc" } };
    const backupRoot = join(scopedRunnerdStateRoot(execution), "failover-backups/current");
    const inPlace = ["own_box", "missing_state", "unreadable_state"].includes(stateSource);
    const sourceRoot = inPlace ? remoteSession : join(root, "staged-backup");
    await mkdir(join(sourceRoot, "runner"), { recursive: true });
    await writeFile(join(sourceRoot, "runner/runner-state.json"), JSON.stringify(runnerState));
    await writeFile(join(sourceRoot, "runner/codex-provider-state.json"), JSON.stringify(providerState));
    const [receipt] = (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, sourceRunId))
      .orderBy(asc(heartbeatRunEvents.sourceSeq)))
      .filter(event => event.eventType === "turn.started");
    expect(receipt.sourceSeq).toBe(1);
    const [terminal] = (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, sourceRunId)))
      .filter(event => ["turn.failed", "turn.interrupted"].includes(event.eventType));
    expect(terminal.sourceSeq).toBe(3);
    const completedAt = stateSource === "older_backup" ? new Date(terminal.createdAt.getTime() - 1).toISOString() : new Date().toISOString();
    if (stateSource === "older_backup") expect(Date.parse(completedAt)).toBeLessThan(terminal.createdAt.getTime());
    if (!inPlace) await writeFile(join(sourceRoot, "manifest.json"), JSON.stringify(buildNativeHarnessBackupManifest({
      backupRoot: sourceRoot, execution, runnerInstanceId: source.runnerInstanceId!, sourceProviderLeaseId: "previous-box", completedAt,
      providerSessionIdentity: providerSessionIdentityFromDurableProviderState({ execution, providerState }),
    })));
    let restoredFiles = 0;
    const copy = async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string }> }>) => {
      for (const operation of operations) for (const file of operation.files) {
        await mkdir(dirname(file.targetPath), { recursive: true });
        await cp(file.sourcePath, file.targetPath, { recursive: true });
        if (file.sourcePath.startsWith(backupRoot)) restoredFiles++;
      }
    };
    const runner = { syncIn: copy, syncOut: copy, async execute(command: { command: string; args?: string[] }) {
      if (command.args?.[0] === "--build-metadata") return { exitCode: 0, timedOut: false, stderr: "", stdout: JSON.stringify({
        schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd", packageName: "@paperclipai/paperclip-runner",
        binaryContractVersion: 2, durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"], prpTransportModes: ["listen_ws"],
        providerPacks: [{ root: "/opt/paperclip-runner/provider-pack", manifest: pack, immutable: true }],
      }) };
      if (command.args?.[1]?.includes("base64")) {
        try { return { exitCode: 0, timedOut: false, stderr: "", stdout: execFileSync("sh", command.args, { encoding: "utf8" }) }; }
        catch { return { exitCode: 1, timedOut: false, stderr: "", stdout: "" }; }
      }
      return { exitCode: 0, timedOut: false, stderr: "", stdout: "" };
    } };
    const [lease] = await db.insert(environmentLeases).values({ companyId: execution.binding.companyId,
      issueId: execution.binding.issueId, heartbeatRunId: execution.binding.runId, provider: "fixture",
      providerLeaseId: "replacement-box", metadata: {} }).returning();
    const backendInput = { db, execution, runnerInstanceId: source.runnerInstanceId!,
      runnerRemoteBinaryPath: binary, runnerRemoteProviderPackPath: root, runnerIngressAuthorized: true,
      restartRecovery: { kind: "bootstrap_incomplete", runId: execution.binding.runId, leaseOwner: "controlled-controller",
        controllerGeneration: 1, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null },
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd, environmentId: randomUUID(),
        leaseId: lease.id, providerKey: "fixture", effectiveCapabilities: { runnerWebSocketIngress: true }, runner,
        sandboxLeaseAcquisition: { outcome: inPlace ? "resumed" : "replacement", providerLeaseId: "replacement-box" },
      } as never };
    // Keep the discriminated restart input exact for both the direct hook and
    // the stock executor call-site row.
    backendInput.restartRecovery.kind = "bootstrap_incomplete" as const;
    backendInput.restartRecovery.restartKind = "hard" as const;
    const backend = stateSource === "callsite_backup" ? null
      : await createRunnerdBackend(backendInput as Parameters<typeof createRunnerdBackend>[0]);
    if (!inPlace && stateSource !== "callsite_backup") {
      // Stage the durable backup after bootstrap admission, before the actual
      // harness source selection/verification/restore used by this probe.
      await mkdir(dirname(backupRoot), { recursive: true });
      await cp(sourceRoot, backupRoot, { recursive: true });
      expect(await verifyNativeHarnessBackupStreamed({ root: scopedRunnerdStateRoot(execution), execution,
        runnerInstanceId: source.runnerInstanceId! })).not.toBeNull();
    }
    // On v3 this is the production pre-parse call, without constructing the
    // provider transport first. For the SAME row on v2, force its real restore
    // (normally called by transport recovery) before observing the old input.
    let prepared = execution;
    if (stateSource === "missing_state" || stateSource === "unreadable_state") {
      (provider.backendOptions.codexTransportFactory as () => unknown)();
      await (provider.transport.prepareExternalRunnerState as () => Promise<void>)();
      if (stateSource === "missing_state") await rm(join(remoteSession, "runner/runner-state.json"));
      else await writeFile(join(remoteSession, "runner/runner-state.json"), "not JSON");
    }
    if (!execution.continuationPrompt && !["missing_state", "unreadable_state"].includes(stateSource)) {
      (provider.backendOptions.codexTransportFactory as () => unknown)();
      await (provider.transport.prepareExternalRunnerState as () => Promise<void>)();
    }
    if (stateSource === "callsite_backup") {
      await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: execution.binding.issueId,
        nativeSessionId: sessionId, runnerInstanceId: source.runnerInstanceId }).where(eq(heartbeatRuns.id, execution.binding.runId));
      await db.update(issues).set({ executionRunId: execution.binding.runId }).where(eq(issues.id, execution.binding.issueId));
      await db.insert(nativeRunFinalizations).values({ runId: execution.binding.runId, companyId: execution.binding.companyId,
        issueId: execution.binding.issueId, phase: "observed" });
      let reached = false;
      provider.execute.mockImplementationOnce(async (options: { input: typeof execution }) => {
        reached = true;
        prepared = options.input;
        throw new Error("callsite model-bound input captured");
      });
      // This row isolates the stock pre-parse call site, not cross-controller
      // migration admission. Its source checkpoint is the controlled driver
      // checkpoint above, not a durable controller checkpoint authority.
      const admission = vi.spyOn(controllerRecovery, "resolveNativeControllerRecovery")
        .mockResolvedValue({ kind: "no_prior_execution" });
      // Seed only after the real executor's fresh controller admission. Creating
      // a second half-initialized controller root would itself be invalid.
      provider.onBackendCreate = () => {
        mkdirSync(dirname(backupRoot), { recursive: true });
        cpSync(sourceRoot, backupRoot, { recursive: true });
      };
      try {
        await expect(executePaperclipNativeSession({ ...backendInput, restartRecovery: undefined, useRunnerd: true } as Parameters<typeof executePaperclipNativeSession>[0]))
          .rejects.toThrow("callsite model-bound input captured");
      } finally { admission.mockRestore(); provider.onBackendCreate = undefined; }
      expect(reached).toBe(true);
      expect(prepared.continuationPrompt).toBeFalsy();
      process.stdout.write(JSON.stringify({ proof: "stock-executor-pre-parse-callsite", sourceRunId,
        retryRunId: execution.binding.runId, restoredFiles, full: !prepared.continuationPrompt }) + "\n");
    } else if (backend?.prepareRetryInput) prepared = await backend.prepareRetryInput(execution) as typeof execution;
    else {
      (provider.backendOptions.codexTransportFactory as () => unknown)();
      await (provider.transport.prepareExternalRunnerState as () => Promise<void>)();
    }
    if (stateSource === "reinvoked_backup") {
      // The first invocation restores but never launches Runner or rewrites its
      // state. The new backend sees a resumed lease and reuses those same files.
      expect(prepared.continuationPrompt).toBeFalsy();
      const [recordedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(recordedLease.metadata?.nativeHarnessBackup).toBeTruthy();
      const resumedTarget = { ...(backendInput.runnerExecutionTarget as object),
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "replacement-box" } };
      const second = await createRunnerdBackend({ ...backendInput, runnerExecutionTarget: resumedTarget } as Parameters<typeof createRunnerdBackend>[0]);
      prepared = await second.prepareRetryInput!(execution) as typeof execution;
    }
    const absent = ["missing_state", "unreadable_state"].includes(stateSource);
    const restored = absent ? runnerState : JSON.parse(await readFile(join(remoteSession, "runner/runner-state.json"), "utf8"));
    if (!absent) expect(restored).toEqual(JSON.parse(JSON.stringify(runnerState)));
    expect(restoredFiles).toBe(inPlace ? 0 : 1);
    process.stdout.write(JSON.stringify({ proof: "retry-state-source", stateSource, retryRunId: execution.binding.runId, sourceRunId,
      completedAt, recordedRunId: restored.runId, recordedNextSourceSeq: restored.nextSourceSeq ?? null,
      sourceReceiptSeq: receipt.sourceSeq, sourceReceiptCreatedAt: receipt.createdAt.toISOString(),
      sourceTerminalSeq: terminal.sourceSeq, sourceTerminalCreatedAt: terminal.createdAt.toISOString(),
      restoredFiles, noRestoreRan: restoredFiles === 0, compact: "continuationPrompt" in prepared && !!prepared.continuationPrompt }) + "\n");
    return prepared;
  } finally {
    if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
    else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
    await rm(root, { recursive: true, force: true });
  }
}

/** Exercise real Runner checkpointing + HarnessDriverBackend + Pi driver recovery.
 * Only the ACP host transport is controlled; no model or credentials are used.
 */
function piRecoveryProbe(sessionId: string, submissions: string[], delayBeforeSubmit = false, sourceOutcome?: SourceOutcome) {
  let recoveries = 0;
  const driver = new CodexAcpxDriver({ agent: "pi", runtimeDirectory: "/tmp", model: "fixture/model",
    permissionMode: "approve-reads", providerPolicy: { readOnly: true } }, {
    async readRecoveryWorkspace() { recoveries++; return { path: "/tmp", assertHeld() {}, async close() {} }; },
    async openHost(options) {
      const identity = {
        schema: "paperclip.runner.acpx-identity.v2" as const, normalizedSessionId: sessionId,
        acpxRecordId: "record-proof", backendSessionId: "saved-provider-conversation", agentSessionId: "saved-provider-conversation",
        profileDigest: `sha256:${"a".repeat(64)}`, workspaceDigest: `sha256:${"b".repeat(64)}`,
        requestedModel: "fixture/model", effectiveModel: "fixture/model", permissionMode: "approve-reads" as const,
        providerLifetimeFenceCandidates: [60_001, 60_002, 60_003] as const,
      };
      if (options.expectedIdentity) expect(options.expectedIdentity).toEqual(expect.objectContaining({
        backendSessionId: identity.backendSessionId, normalizedSessionId: sessionId,
      }));
      return {
        identity: () => identity,
        binding: () => ({ normalizedSessionId: sessionId, workspacePath: "/tmp", workspaceDigest: identity.workspaceDigest,
          runtimeRoot: "/tmp", commandDigest: `sha256:${"c".repeat(64)}`, profileDigest: identity.profileDigest,
          requestedModel: "fixture/model", effectiveModel: "fixture/model", permissionMode: "approve-reads" as const,
          profileSessionKey: "paperclip-proof" }),
        async status() { if (delayBeforeSubmit) await new Promise(resolve => setTimeout(resolve, 50));
          return { agentSessionId: "saved-provider-conversation", models: { currentModelId: "fixture/model", availableModelIds: ["fixture/model"] } }; },
        startTurn(turn) {
          submissions.push(turn.text);
          if (!sourceOutcome) throw new Error("proof stops at provider submission");
          return { requestId: "source-provider-turn", promptStarted: Promise.resolve(),
            events: { async *[Symbol.asyncIterator]() {
              if (sourceOutcome === "history_submit_fails") {
                yield { type: "text_delta" as const, stream: "output" as const, tag: "agent_message_chunk",
                  messageId: `pi-history-message-${"a".repeat(64)}`, text: "Old assistant history, not this task.",
                  meta: { origin: "pi-history-assistant", source: "pi-session-history-v1", kind: "history" } };
                throw new Error("submit failed after buffered history replay");
              }
              const messageId = `pi-message-${"b".repeat(64)}`;
              const meta = { origin: "pi-native-assistant", source: "pi-rpc-message-v1" };
              yield { type: "text_delta" as const, stream: "output" as const, tag: "agent_message_chunk", messageId,
                text: "", meta: { ...meta, kind: "start" } };
              yield { type: "text_delta" as const, stream: "output" as const, tag: "agent_message_chunk", messageId,
                text: "I have inspected the assigned task.", meta: { ...meta, kind: "delta" } };
              yield { type: "text_delta" as const, stream: "output" as const, tag: "agent_message_chunk", messageId,
                text: "", meta: { ...meta, kind: `end:${sourceOutcome === "error" ? "error" : sourceOutcome === "cancel" ? "aborted" : "stop"}` } };
            } },
            result: Promise.resolve(sourceOutcome === "error" ? { status: "failed" as const, error: { message: "provider error after partial output" } }
              : sourceOutcome === "cancel" ? { status: "cancelled" as const, stopReason: "cancelled" }
                : { status: "completed" as const }),
            async cancel() {}, async closeStream() {} };
        },
        async interruptActiveTurn() {}, async close() {},
      };
    },
  });
  const backend = new HarnessDriverBackend(driver);
  const descriptor = backend.descriptor.bind(backend);
  // Runtime-context realization is outside this controlled transport probe.
  backend.descriptor = async () => ({ ...await descriptor(),
    runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } });
  return { backend, driver, submissions, recoveries: () => recoveries };
}

function probeControlPlane(onCheckpoint?: (snapshot: PersistedNativeSession) => void,
  onEvent?: (event: Parameters<ControlPlanePort["appendEvent"]>[0]) => void): ControlPlanePort {
  return { async openRun() {}, async checkpointSession(snapshot) { onCheckpoint?.(snapshot); }, async completeRun() {},
    async appendEvent(event) { onEvent?.(event); const seq = "sourceSeq" in event ? event.sourceSeq : 1;
      return { cursor: seq, highestContiguousSourceSeq: seq, disposition: "committed" }; },
    async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } };
}

// Seen on a staging deployment: an OpenCode turn
// failed (its server was killed, or it ended without an answer). The accepted
// result kept the task in_progress and the arbiter scheduled a retry, but the
// dispatcher refused that wake (`chat_control_recovery_proof_unresolved`), so
// the task sat for hours with no owner and no queued work.
describe("native failed-turn continuation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-failed-turn-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native failed turn", issuePrefix: "NFT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "OpenCode agent", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "openrouter/test-model" } });
    await db.insert(authUsers).values({ id: "board-user", name: "Board", email: "board@example.invalid", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function failTurn(issueId: string, code: FailureCode, context: Record<string, unknown> = {}, dispatchedFrom?: string, nativeProvider?: "pi_rpc" | "codex", beforeSubmit = false, unseenInput = false, realDriver = false, hostSubmitFails = false, diagnostic = false, sourceOutcome: SourceOutcome = "completed", twoTurns = false, secondMessageCompleted = false) {
    const runId = randomUUID();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // A dispatched continuation carries the dispatcher's own receipt for its intent.
    const [receipt] = dispatchedFrom ? await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "issue_status_changed", status: "claimed", requestedByActorType: "system",
      requestedByActorId: `native-status-wake-dispatch:${dispatchedFrom}`, payload: { issueId } }).returning() : [];
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "automation", triggerDetail: "system", wakeupRequestId: receipt?.id ?? null, contextSnapshot: { issueId, ...context, skipIssueComment: true } }).returning();
    if (receipt) await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receipt.id));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Review the PR.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
      interactionResponses: [], credentialBindings: [],
    };
    const nativeExecution = nativeProvider ? buildNativeExecutionInput({
      companyId, agentId, runId, issue, taskPrompt: issue.description ?? issue.title,
      provider: nativeProvider, model: "fixture/model", normalizedSessionId: native.normalizedSessionId,
      wakePayload: await buildPaperclipWakePayload({ db, companyId, agentId, runId, contextSnapshot: { issueId, ...context } }),
      workspace: { id: "retry-workspace", cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      runtimeContext: nativeRuntimeContextFixture(), completionContract: execution.completionContract,
    }) : execution;
    let savedCheckpoint: PersistedNativeSession | undefined;
    const sourceDriverEvents: PrpEvent[] = [];
    if (beforeSubmit || realDriver || hostSubmitFails) {
      const probe = piRecoveryProbe(nativeExecution.session.normalizedSessionId!, [], hostSubmitFails);
      await expect(executeNativeSession({ input: nativeExecution, backend: probe.backend,
        controlPlane: probeControlPlane(snapshot => { savedCheckpoint = snapshot; }, event => { if ("eventType" in event) sourceDriverEvents.push(event); }),
        ...(beforeSubmit ? { prepareWakeAttachmentPrompt: async () => { throw new Error("attachment preparation failed before submission"); } } : {}),
        runnerInstanceId: "pre-submit-proof", controlPlaneInstanceId: "pre-submit-control", timeoutMs: 5_000,
        requireSessionCloseBeforeReturn: true,
      })).rejects.toThrow(beforeSubmit ? "attachment preparation failed before submission" : "proof stops at provider submission");
      expect(savedCheckpoint?.activeTurnId).toBeNull();
      expect(probe.submissions).toHaveLength(beforeSubmit ? 0 : 1);
      expect(savedCheckpoint?.providerSessionId).toBe("saved-provider-conversation");
      if (hostSubmitFails) {
        expect(sourceDriverEvents.some(event => event.eventType === "turn.started")).toBe(true);
        expect(sourceDriverEvents.some(event => event.eventType === "item.delta")).toBe(false);
        process.stdout.write(JSON.stringify({ proof: "host-submit-failed-source", runId,
          submissions: probe.submissions.length, events: sourceDriverEvents.map(event => event.eventType) }) + "\n");
      }
    }
    let providerOutput: PrpEvent | undefined;
    if (nativeProvider === "pi_rpc" && !beforeSubmit && !hostSubmitFails) {
      const probe = piRecoveryProbe(nativeExecution.session.normalizedSessionId!, [], false, sourceOutcome);
      const session = await probe.driver.openSession({ runId, normalizedSessionId: native.normalizedSessionId, workingDirectory: "/tmp" });
      try {
        await session.startTurn({ message: { role: "user", text: nativeExecution.task.prompt } });
        const observed: PrpEvent[] = [];
        for await (const observedEvent of session.events()) {
          observed.push(observedEvent);
          if (["turn.completed", "turn.failed", "turn.interrupted"].includes(observedEvent.eventType)) break;
        }
        providerOutput = sourceOutcome === "turn_completed" ? observed.find(event => event.eventType === "turn.completed")
          : observed.find(event => event.eventType === (sourceOutcome === "completed" ? "item.completed" : "item.delta") && event.payload.kind === "agentMessage" && typeof event.payload.text === "string" && !!event.payload.text.trim());
        expect(providerOutput).toBeDefined();
        if (!["completed", "turn_completed"].includes(sourceOutcome)) expect(observed.some(event => event.eventType === "item.completed")).toBe(false);
        process.stdout.write(JSON.stringify({ proof: "real-driver-source-events", runId, sourceOutcome, events: observed.map(event => event.eventType === "turn.submitted"
          ? { ...event, payload: { submittedBytes: Buffer.byteLength(String(event.payload.text)) } } : event) }) + "\n");
      } finally { await session.close({ reason: "source output captured for real PG ingestion" }); }
    }
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: nativeExecution,
      ...(savedCheckpoint ? { sessionCheckpoint: savedCheckpoint,
        nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local", nativeProvider) } : {}) } }).where(eq(heartbeatRuns.id, runId));
    // The person writes while this run is still running, after its immutable
    // input/coverage was saved and before the failure schedules its retry.
    const [unseenComment] = unseenInput ? await db.insert(issueComments).values({ companyId, issueId,
      authorUserId: "board-user", body: "Unseen direction: inspect the new requirement before finishing." }).returning() : [];
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "turn-terminal", sourceSeq: 1,
      sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: nativeProvider
        ? { status: "failed", error: { message: diagnostic
          ? `Provider disconnected token=sk-${"x".repeat(48)} ${"detail ".repeat(250)}\n    at privateStack (/private/source.ts:12:3)`
          : `${nativeProvider} stopped while the turn was running.` } }
        : code === "opencode_server_exited"
        ? { status: "failed", error: { code, message: "OpenCode stopped while the turn was running.", opencodeFailure: { kind: "server_exited", signal: "SIGKILL", connectionError: "ECONNREFUSED" } } }
        : { status: "failed", error: { code, message: "OpenCode ended without a final answer.", retryable: false } },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
    const openInput = { identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock" as const, sourceInstanceId: native.runnerInstanceId };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun(openInput);
      if (nativeProvider && !beforeSubmit) await options.controlPlane.appendEvent({ ...event,
        // Replay the concrete driver's observed early admission in the submit-
        // failure row, through the real bound PostgreSQL control-plane port.
        ...(hostSubmitFails ? sourceDriverEvents.find(event => event.eventType === "turn.started") : {}),
        runId, normalizedSessionId: native.normalizedSessionId, sourceInstanceId: native.runnerInstanceId,
        turnId: native.turnId, sourceEventId: "submitted-turn", sourceSeq: 1, eventType: "turn.started", payload: { status: "inProgress" } });
      if (nativeProvider && !beforeSubmit && !hostSubmitFails) await options.controlPlane.appendEvent({ ...event,
        ...(providerOutput ?? {}), runId, normalizedSessionId: native.normalizedSessionId, sourceInstanceId: native.runnerInstanceId,
        turnId: native.turnId, sourceEventId: "provider-output", sourceSeq: 2,
        eventType: providerOutput?.eventType ?? "item.completed", itemId: "source-answer",
        // Preserve the driver's final channel. skipIssueComment on the source
        // run prevents publication from settling the input before this retry
        // probe. Error/Stop also complete a display item, not the source turn.
        // The pinned Runner accepts "progress", not the newer "commentary";
        // install that persisted native shape below without changing Runner.
        ...(sourceOutcome === "error" || sourceOutcome === "cancel" ? { eventType: "item.completed" } : {}),
        payload: sourceOutcome === "error" || sourceOutcome === "cancel"
          ? { kind: "agentMessage", channel: "progress", text: sourceOutcome === "cancel" ? "Stopped." : "I have inspected the assigned task." }
          : providerOutput?.payload ?? { kind: "agentMessage", channel: "final", text: "I have inspected the assigned task." } });
      if (nativeProvider === "pi_rpc" && !beforeSubmit && !hostSubmitFails && ["error", "cancel"].includes(sourceOutcome)) {
        await db.update(heartbeatRunEvents).set({
          payload: sql`jsonb_set(${heartbeatRunEvents.payload}, '{prpEvent,payload,channel}', '"commentary"'::jsonb)`,
        }).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.sourceEventId, "provider-output")));
        const [stored] = await db.select().from(heartbeatRunEvents).where(and(
          eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.sourceEventId, "provider-output")));
        expect(stored.eventType).toBe("item.completed");
        expect((stored.payload?.prpEvent as PrpEvent).payload.channel).toBe("commentary");
        process.stdout.write(JSON.stringify({ proof: "persisted-nonfinal-completed-item", runId, sourceOutcome,
          event: stored.payload?.prpEvent, nativeDriverGenerated: false }) + "\n");
      }
      await options.controlPlane.appendEvent({ ...event, sourceSeq: nativeProvider && !beforeSubmit ? hostSubmitFails ? 2 : 3 : 1,
        ...(twoTurns ? { eventType: "turn.interrupted", payload: { status: "interrupted" } } : {}) });
      if (twoTurns) {
        await options.controlPlane.appendEvent({ ...event, turnId: `${native.turnId}-B`, sourceEventId: "B-start", sourceSeq: 4,
          eventType: "turn.started", payload: { status: "inProgress" } });
        await options.controlPlane.appendEvent({ ...event, turnId: `${native.turnId}-B`, sourceEventId: "B-output", sourceSeq: 5,
          eventType: secondMessageCompleted ? "item.completed" : "item.delta", itemId: "B-answer",
          payload: { kind: "agentMessage", channel: secondMessageCompleted ? "final" : "progress", text: "B partial answer" } });
      }
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-provider-session", driverKind: nativeExecution.session.driverKind, driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    await executePaperclipNativeSession({ db, execution: nativeExecution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(failedRun.status).toBe("failed");
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    return { runId, decision, execution: nativeExecution, failedRun, savedCheckpoint, unseenCommentId: unseenComment?.id };
  }

  const issueWakes = async (issueId: string) => (await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId);

  it.each(["opencode_server_exited", "opencode_empty_response"] as const)("continues the task once after %s, then hands it to Retry", async (code) => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Review a PR", status: "in_progress", workMode: "standard", assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const first = await failTurn(issueId, code);
    expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");

    const heartbeat = heartbeatService(db);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId })).toMatchObject({ dispatched: 1 });
    const wakes = await issueWakes(issueId);
    expect(wakes.filter(wake => wake.status === "skipped")).toEqual([]);
    const intent = wakes.find(wake => wake.requestedByActorId === "native-status-committer")!;
    expect(intent.payload).toMatchObject({ retryCause: "native_run_failed" });
    const [continuation] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(r => r.id !== first.runId && r.contextSnapshot?.issueId === issueId);
    expect(continuation?.contextSnapshot?.nativeStatusWakeIntentId).toBe(intent.id);
    expect(["queued", "running"]).toContain(continuation.status);
    // The continuation keeps the failed run as its conversation source.
    expect(await readNativeContinuationSource(db, { companyId, issueId, runId: continuation.id })).toBe(first.runId);
    // The fixture cannot launch a real runner; let the dispatched run settle.
    await heartbeat.drainActiveRunExecutions();
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.assigneeAgentId).toBe(agentId);

    // The continuation's own turn fails the same way: no second automatic
    // wake, and a board blocker whose Retry restarts the work.
    await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const before = (await issueWakes(issueId)).length;
    const second = await failTurn(issueId, code, { nativeStatusWakeIntentId: intent.id }, intent.id);
    expect(second.decision).toMatchObject({ reasonCode: "native_run_failed_continuation_exhausted", toStatus: "blocked" });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect((await issueWakes(issueId)).length).toBe(before + 1); // only the fixture dispatch receipt
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(blocked).toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board", action: NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } });
    // The visible Retry is accepted and starts a new run of the task.
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "board-user", actorSource: "session",
      idempotencyKey: randomUUID(), observedRunId: second.runId });
    expect(receipt).toMatchObject({ accepted: true, stale: false });
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const retried = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(r => r.contextSnapshot?.issueId === issueId && r.contextSnapshot?.taskRetryRequestId === receipt.requestId);
    expect(retried).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);

  it.each([
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false, stateSource: undefined },
    { nativeProvider: "codex" as const, beforeSubmit: false, unseenInput: false, stateSource: undefined },
    { nativeProvider: "pi_rpc" as const, beforeSubmit: true, unseenInput: false, stateSource: undefined },
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: true, stateSource: undefined },
    ...(["older_backup", "current_backup", "unknown_cursor", "own_box", "reinvoked_backup", "missing_state", "unreadable_state", "callsite_backup"] as const).map(stateSource =>
      ({ nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false, stateSource })),
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: true, stateSource: "own_box" as const },
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false, stateSource: undefined, hostSubmitFails: true },
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false, stateSource: undefined, diagnostic: true },
    ...(["error", "cancel", "history_submit_fails", "turn_completed"] as const).map(sourceOutcome =>
      ({ nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false, stateSource: undefined, sourceOutcome })),
    ...(["other_turn_end", "other_turn_message_completed"] as const).map(stateSource =>
      ({ nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false, stateSource })),
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false, stateSource: undefined, externalChat: true },
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false, stateSource: undefined, externalChat: true, sourceOutcome: "error" as const },
  ].map(row => ({ hostSubmitFails: false, diagnostic: false, sourceOutcome: "completed" as SourceOutcome, externalChat: false, ...row })))("stock failed-run retry $nativeProvider beforeSubmit=$beforeSubmit unseenInput=$unseenInput state=$stateSource hostSubmitFails=$hostSubmitFails diagnostic=$diagnostic source=$sourceOutcome externalChat=$externalChat", async ({ nativeProvider, beforeSubmit, unseenInput, stateSource, hostSubmitFails, diagnostic, sourceOutcome, externalChat }) => {
    const issueId = randomUUID();
    const taskText = "RETRY_TASK_MUST_SURVIVE_FRESH_BOOTSTRAP: inspect and finish the assigned work.";
    // Earlier failure rows can mark this shared fixture agent errored. Each
    // independent retry row starts with a runnable agent, not that residue.
    await db.update(agents).set({ status: "active", adapterConfig: { provider: nativeProvider, model: "fixture/model" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Continue the real failed run",
      description: taskText, status: "in_progress", workMode: "standard", assigneeAgentId: agentId,
      responsibleUserId: "board-user", ...(externalChat ? { originKind: "chat_channel" } : {}) }).returning();
    await db.insert(issueComments).values(Array.from({ length: 10 }, (_, i) => ({ companyId, issueId,
      authorAgentId: agentId, body: `Prior reply ${i}: ${"saved work ".repeat(300)}` })));
    const baseline = await buildExecutionContinuation({ db, companyId, issueId, agentId, context: {}, summary: null, exposeLowTrustRaw: false });
    const first = await failTurn(issueId, "opencode_empty_response", { executionContinuation: baseline }, undefined, nativeProvider, beforeSubmit, unseenInput, !!stateSource, hostSubmitFails, diagnostic, sourceOutcome, ["other_turn_end", "other_turn_message_completed"].includes(stateSource ?? ""), stateSource === "other_turn_message_completed");
    // Occupy the real agent's execution slot: dispatch the stock wake through PG,
    // but stop before a paid provider transport. All prompt builders stay real.
    const [blocker] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: {} }).returning();
    const heartbeat = heartbeatService(db);
    let retryRunId: string | undefined;
    try {
      expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
      expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId })).toMatchObject({ dispatched: 1 });
      const [retry] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .filter(run => run.id !== first.runId && run.contextSnapshot?.issueId === issueId);
      retryRunId = retry.id;
      expect(retry.status).toBe("queued");
      const sourceEvidence = retry.contextSnapshot?.nativeStatusRetry as Record<string, unknown>;
      expect(sourceEvidence.sourceTurnCompleted).toBe(!beforeSubmit && !hostSubmitFails && stateSource !== "other_turn_end" && ["completed", "turn_completed"].includes(sourceOutcome));
      if (!beforeSubmit) expect(sourceEvidence.sourceTurnId).toEqual(expect.any(String));
      process.stdout.write(JSON.stringify({ proof: "committed-source-completion", retryRunId: retry.id, sourceEvidence }) + "\n");
      if (hostSubmitFails) {
        const evidence = retry.contextSnapshot?.nativeStatusRetry as Record<string, unknown>;
        expect(evidence.turnSubmitted).toBe(true);
        expect(evidence.providerOutputObserved === true).toBe(false);
        process.stdout.write(JSON.stringify({ proof: "host-submit-failed-committed-evidence", retryRunId: retry.id,
          turnSubmitted: evidence.turnSubmitted, providerOutputObserved: evidence.providerOutputObserved ?? null }) + "\n");
      }
      expect(await readNativeContinuationSource(db, { companyId, issueId, runId: retry.id })).toBe(first.runId);
      const context = { ...retry.contextSnapshot, executionContinuation: await buildExecutionContinuation({
        db, companyId, issueId, agentId, runId: retry.id, context: retry.contextSnapshot!, previousContextRunId: first.runId,
        summary: null, exposeLowTrustRaw: false }) };
      const wakePayload = await buildPaperclipWakePayload({ db, companyId, agentId, runId: retry.id, contextSnapshot: context });
      const sessionId = first.execution.session.normalizedSessionId!;
      const args = { companyId, agentId, runId: retry.id, issue, taskPrompt: taskText,
        provider: nativeProvider, model: "fixture/model", wakePayload,
        previousTurn: { runId: first.runId, task: issue, nativeExecutionInput: first.execution },
        workspace: { id: "retry-workspace", cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
        runtimeContext: nativeRuntimeContextFixture(), completionContract: first.execution.completionContract };
      if (externalChat) {
        const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
        const issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(companyId, issueId);
        expect(issueContext).not.toBeNull();
        for (const agentChat of [false, true]) {
          const chatIssue = agentChat ? { ...issue, conversationAgentId: agentId, conversationUserId: "board-user" } : issue;
          const chatIssueContext = agentChat ? { ...issueContext!, conversationAgentId: agentId, conversationUserId: "board-user" } : issueContext;
          const chatContext = { ...context };
          const preparedContext = await prepareHeartbeatTaskContext(db, { run: retry, agent,
            task: { issueRef: chatIssue, issueContext: chatIssueContext,
              context: chatContext, taskSession: { lastRunId: first.runId } },
            policy: { trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
            services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null } });
          if (agentChat) expect(preparedContext.executionContinuation).toBeNull();
          else expect(preparedContext.executionContinuation?.resumeDelta?.baseRunId).toBe(first.runId);
          const chatInput = buildNativeExecutionInput({ ...args, issue: chatIssue, normalizedSessionId: sessionId, resumedSession: true,
            wakePayload: preparedContext.paperclipWakePayload });
          const envelope = buildNativeModelEnvelope(chatInput, { resumedSession: true });
          const compact = !agentChat && ["completed", "turn_completed"].includes(sourceOutcome);
          expect(envelope.schema === "paperclip.native-continuation.v1").toBe(compact);
          expect(JSON.stringify(envelope).includes(taskText)).toBe(!compact);
          process.stdout.write(JSON.stringify({ proof: agentChat ? "agent-chat-classifier" : "external-chat-channel",
            sourceOutcome, retryRunId: retry.id, compact, bytes: Buffer.byteLength(JSON.stringify(envelope)), taskPresent: !compact }) + "\n");
        }
      }
      const checkpoint = { backendKind: "runner", driverKind: first.execution.session.driverKind,
        sessionId: "saved-provider-conversation", providerSessionId: "saved-provider-conversation",
        identity: { runId: first.runId, sessionId, companyId, issueId, agentId } };
      const source = { ...first.failedRun, runnerProfileJson: { nativeExecutionInput: first.execution,
        nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local", nativeProvider), sessionCheckpoint: first.savedCheckpoint ?? checkpoint } };
      const buildExecution = (options: { normalizedSessionId: string; resumedSession: boolean }) => buildNativeExecutionInput({ ...args, ...options });
      const retained = buildNativeExecutionWithCheckpoint({ previousRun: source, normalizedSessionId: sessionId, buildExecution });
      expect(retained.normalizedSessionId).toBe(sessionId);
      expect(retained.checkpoint?.providerSessionId).toBe("saved-provider-conversation");
      if (stateSource) retained.execution = await prepareRetryState(db, retained.execution as ReturnType<typeof buildNativeExecutionInput>, first.runId, stateSource);
      const compactExpected = nativeProvider === "pi_rpc" && !beforeSubmit && !hostSubmitFails &&
        ["completed", "turn_completed"].includes(sourceOutcome) &&
        (!stateSource || ["current_backup", "own_box"].includes(stateSource));
      const warm = buildNativeModelEnvelope(retained.execution, { resumedSession: true });
      const replacement = buildNativeModelEnvelope(retained.execution);
      expect(replacement.task.prompt).toContain(taskText);
      expect(Buffer.byteLength(JSON.stringify(replacement))).toBeGreaterThan(30_000);
      const measurements = { sourceOutcome, externalChat, stateSource: stateSource ?? null, compactExpected, proof: diagnostic ? "diagnostic-redaction" : hostSubmitFails ? "host-submit-failed-retry" : beforeSubmit ? "F-before-submit" : unseenInput ? "D-unseen-person-delta" : "stock-retry-prompt", nativeProvider, failedRunId: first.runId, retryRunId: retry.id,
        sessionId, retainedSessionId: retained.normalizedSessionId, warmSchema: warm.schema,
        warmChars: JSON.stringify(warm).length, replacementChars: JSON.stringify(replacement).length,
        warmBytes: Buffer.byteLength(JSON.stringify(warm)), replacementBytes: Buffer.byteLength(JSON.stringify(replacement)),
        prompt: "events" in warm ? warm.events : null };
      process.stdout.write(JSON.stringify(measurements) + "\n");
      for (const failure of ["selection_reset", "missing_checkpoint", "unrebindable_checkpoint", "box_unavailable"] as const) {
        const unavailable = { ...source, ...(failure === "box_unavailable" ? { errorCode: "native_provider_state_incompatible" } : {}),
          runnerProfileJson: { ...source.runnerProfileJson,
            sessionCheckpoint: failure === "missing_checkpoint" ? null : failure === "unrebindable_checkpoint" ? { ...checkpoint, identity: {} } : checkpoint } };
        const fresh = buildNativeExecutionWithCheckpoint({ previousRun: failure === "selection_reset" ? null : unavailable, normalizedSessionId: sessionId, buildExecution });
        expect(fresh.checkpoint).toBeNull();
        expect(fresh.normalizedSessionId).not.toBe(sessionId);
        const envelope = buildNativeModelEnvelope(fresh.execution);
        expect(envelope.task.prompt).toContain(taskText);
        expect("continuationPrompt" in fresh.execution && fresh.execution.continuationPrompt).toBeFalsy();
        process.stdout.write(JSON.stringify({ proof: "stock-retry-fresh", nativeProvider, failure, retryRunId: retry.id,
          newSessionId: fresh.normalizedSessionId, chars: JSON.stringify(envelope).length,
          bytes: Buffer.byteLength(JSON.stringify(envelope)), taskPresent: envelope.task.prompt.includes(taskText) }) + "\n");
      }
      if (beforeSubmit || stateSource || hostSubmitFails) {
        // No recoverSession stub: both the native adapter and concrete Pi ACPX
        // driver's validation/workspace/identity recovery execute here.
        const sent: string[] = [];
        const probe = piRecoveryProbe(sessionId, sent);
        await expect(executeNativeSession({ input: retained.execution,
          // The concrete ACPX driver admits only same-session recovery. Tighten
          // the server's replacement permission; never replace in this row.
          persistedSession: { ...retained.checkpoint!, providerRecoveryPolicy: "same_session_only" },
          backend: probe.backend, controlPlane: probeControlPlane(), runnerInstanceId: "retry-proof",
          controlPlaneInstanceId: "retry-proof-control", timeoutMs: 5_000, requireSessionCloseBeforeReturn: true,
        })).rejects.toThrow("proof stops at provider submission");
        expect(probe.recoveries()).toBe(1);
        expect(sent).toHaveLength(1);
        process.stdout.write(JSON.stringify({ proof: hostSubmitFails ? "host-submit-failed-real-Pi-recovery" : stateSource ? "retry-state-real-Pi-recovery" : "F-real-Pi-recovery", stateSource,
          failedRunId: first.runId, retryRunId: retry.id, recoveries: probe.recoveries(), bytes: Buffer.byteLength(sent[0]),
          taskPresent: sent[0].includes(taskText), compactExpected }) + "\n");
        expect(sent[0].includes(taskText)).toBe(!compactExpected);
        expect(JSON.parse(sent[0]).schema).toBe(compactExpected ? "paperclip.native-continuation.v1" : "paperclip.native-model-envelope.v3");
      }
      if (nativeProvider === "pi_rpc" && !beforeSubmit) for (const resumed of [false, true]) {
        const identity = { runId: retry.id, sessionId, companyId, issueId, agentId };
        const providerSessionId = resumed ? "saved-provider-conversation" : "replacement-provider";
        const sent: string[] = [];
        const replacementSession: NativeSession = {
          identity: () => identity,
          async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() {},
          async startTurn(turn) { sent.push(turn.message.text); throw new Error("proof stops after turn.start"); },
          async result() { return null; },
          async snapshot() { return { backendKind: "runner", sessionId: providerSessionId, providerSessionId,
            identity, cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }; },
          async close() {},
        };
        let replacementOpened = false;
        await expect(executeNativeSession({
          input: retained.execution, persistedSession: retained.checkpoint!,
          backend: {
            async descriptor() { return { kind: "runner", name: "retry-proof", version: "1", capabilities: await replacementSession.capabilities(),
              runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
            async openSession() { throw new Error("expected the replacement hook"); },
            async recoverSession() { return resumed ? { recovered: true, session: replacementSession }
              : { recovered: false, reason: "saved box cannot be resumed" }; },
            async openReplacementSession() { replacementOpened = true; return replacementSession; },
          },
          controlPlane: { async openRun() {}, async checkpointSession() {}, async completeRun() {},
            async appendEvent(event) { const seq = "sourceSeq" in event ? event.sourceSeq : 1;
              return { cursor: seq, highestContiguousSourceSeq: seq, disposition: "committed" }; },
            async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } },
          getFreshSessionHandoff: async () => "FULL_FRESH_HANDOVER",
          runnerInstanceId: "retry-proof", controlPlaneInstanceId: "retry-proof-control", timeoutMs: 5_000,
          requireSessionCloseBeforeReturn: true,
        })).rejects.toThrow("proof stops after turn.start");
        expect(replacementOpened).toBe(!resumed);
        expect(sent).toHaveLength(1);
        const actual = JSON.parse(sent[0]);
        if (resumed) {
          expect(actual).toEqual(warm);
          if (unseenInput && compactExpected) {
            expect(sent[0]).toContain("Unseen direction: inspect the new requirement before finishing.");
            expect(sent[0].match(/Unseen direction/g)).toHaveLength(1);
            expect(sent[0]).not.toContain(taskText);
            expect(sent[0]).not.toContain("Prior reply");
          }
        }
        else {
          expect(actual.schema).toBe("paperclip.native-model-envelope.v3");
          expect(actual.task.prompt).toContain(taskText);
          expect(actual.task.prompt).toContain("FULL_FRESH_HANDOVER");
        }
        process.stdout.write(JSON.stringify({ proof: resumed ? "runner-retained" : "runner-replacement", retryRunId: retry.id,
          previousProviderSessionId: "saved-provider-conversation", newProviderSessionId: providerSessionId,
          chars: sent[0].length, bytes: Buffer.byteLength(sent[0]),
          taskPresent: sent[0].includes(taskText), handoverPresent: sent[0].includes("FULL_FRESH_HANDOVER") }) + "\n");
      }
      if (nativeProvider === "pi_rpc" && !beforeSubmit) {
        const guardedWakes = [
          { ...wakePayload, nativeStatusRetry: null },
          { ...wakePayload, nativeStatusRetry: { cause: "native_run_failed", summary: "Retry", sourceRunId: randomUUID() } },
          { ...wakePayload, truncated: true }, { ...wakePayload, fallbackFetchNeeded: true },
          { ...wakePayload, attachmentOmissions: [{}] }, { ...wakePayload, extraContext: "New context" },
          { ...wakePayload, mcpAppContext: "New selection" }, { ...wakePayload, chatCompletionUpdates: [{}] },
          { ...wakePayload, executionContinuation: { ...context.executionContinuation, resumeDelta: undefined } },
          { ...wakePayload, executionContinuation: { ...context.executionContinuation,
            resumeDelta: { baseRunId: randomUUID(), messages: [] } } },
          { ...wakePayload, nativeStatusRetry: { ...(wakePayload as Record<string, unknown>).nativeStatusRetry as object, turnSubmitted: false } },
          { ...wakePayload, nativeStatusRetry: { ...(wakePayload as Record<string, unknown>).nativeStatusRetry as object, sourceTurnCompleted: undefined } },
          { ...wakePayload, nativeStatusRetry: { ...(wakePayload as Record<string, unknown>).nativeStatusRetry as object, sourceTurnId: undefined } },
        ];
        for (const guarded of guardedWakes) {
          const input = buildNativeExecutionInput({ ...args, normalizedSessionId: sessionId, resumedSession: true, wakePayload: guarded });
          expect(JSON.stringify(buildNativeModelEnvelope(input, { resumedSession: true }))).toContain(taskText);
        }
        for (const overrides of [{ sessionContinuity: "paperclip" }, { resumedSession: false }, { previousTurn: null }, { issue: { ...issue, title: "Changed task" } }, { provider: "codex" as const, sessionContinuity: "continuous" }]) {
          const input = buildNativeExecutionInput({ ...args, normalizedSessionId: sessionId, resumedSession: true, ...overrides });
          expect(JSON.stringify(buildNativeModelEnvelope(input, { resumedSession: true }))).toContain(taskText);
        }
        process.stdout.write(JSON.stringify({ proof: "retry-guards", retryRunId: retry.id, fullTaskControls: guardedWakes.length + 5 }) + "\n");
      }
      // The standard task's person-comment delta stays byte-for-byte unchanged.
      // continued-session.test.ts also retains the exact bare-chat-body controls.
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "board-user", body: "Please continue exactly here." }).returning();
      for (const conversationMode of [false, true]) {
        const commentContext = { issueId, conversationMode, wakeReason: "issue_commented", wakeCommentId: comment.id,
          executionContinuation: await buildExecutionContinuation({ db, companyId, issueId, agentId,
            context: { wakeReason: "issue_commented", wakeCommentId: comment.id }, previousContextRunId: first.runId, summary: null, exposeLowTrustRaw: false }) };
        const personWake = await buildPaperclipWakePayload({ db, companyId, agentId, contextSnapshot: commentContext, retainFullCommentBodies: true });
        const person = buildNativeExecutionInput({ ...args, conversationMode, normalizedSessionId: sessionId, resumedSession: true, wakePayload: personWake });
        expect(person.continuationPrompt).toBe(nativeProvider === "codex" && conversationMode ? undefined
          : JSON.stringify({ messages: commentContext.executionContinuation!.resumeDelta!.messages }));
        process.stdout.write(JSON.stringify({ proof: "person-comment-control", nativeProvider, conversationMode, prompt: person.continuationPrompt }) + "\n");
      }
      if (compactExpected) {
        expect(Buffer.byteLength(JSON.stringify(warm))).toBeLessThan(diagnostic ? 2_500 : 1_000);
        expect(warm.schema).toBe("paperclip.native-continuation.v1");
        expect("events" in warm && warm.events).toContain("automatic retry");
        expect("events" in warm && warm.events).toContain("Status: in_progress");
        expect("events" in warm && warm.events).toContain(diagnostic ? "Provider disconnected" : "pi_rpc stopped while the turn was running.");
        if (diagnostic) {
          const summary = String((retry.contextSnapshot?.nativeStatusRetry as Record<string, unknown>)?.summary);
          expect(Array.from(summary).length).toBeLessThanOrEqual(1_500);
          expect(summary).not.toContain(`sk-${"x".repeat(48)}`);
          expect(summary).not.toContain("privateStack");
          expect(summary).not.toContain("\n");
        }
        expect("events" in warm && warm.events).not.toContain("without opening a second provider session");
        expect(JSON.stringify(warm)).not.toContain(taskText);
      } else {
        expect(warm.schema).not.toBe("paperclip.native-continuation.v1");
        expect(JSON.stringify(warm)).toContain(taskText);
      }
      if (unseenInput) {
        // Delta messages deliberately omit file descriptors. Even when the
        // status wake has no commentIds, their attachments must fence compact
        // plain-text projection rather than silently disappearing.
        const [asset] = await db.insert(assets).values({ companyId, provider: "local_disk", objectKey: `retry-proof/${randomUUID()}`,
          contentType: "text/plain", byteSize: 1, sha256: "a".repeat(64), originalFilename: "new-direction.txt" }).returning();
        await db.insert(issueAttachments).values({ companyId, issueId, issueCommentId: first.unseenCommentId!, assetId: asset.id });
        const attachedWake = await buildPaperclipWakePayload({ db, companyId, agentId, runId: retry.id, contextSnapshot: context });
        const attached = buildNativeExecutionInput({ ...args, normalizedSessionId: sessionId, resumedSession: true, wakePayload: attachedWake });
        const envelope = buildNativeModelEnvelope(attached, { resumedSession: true });
        expect(attached.continuationPrompt).toBeFalsy();
        expect(JSON.stringify(envelope)).toContain(taskText);
        process.stdout.write(JSON.stringify({ proof: "D-attached-delta-full", retryRunId: retry.id,
          bytes: Buffer.byteLength(JSON.stringify(envelope)), taskPresent: true }) + "\n");
      }
    } finally {
      if (retryRunId) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, retryRunId));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
      await heartbeat.drainActiveRunExecutions();
      await db.update(agents).set({ adapterConfig: { provider: "opencode", model: "openrouter/test-model" }, runtimeConfig: {} }).where(eq(agents.id, agentId));
    }
  }, 120_000);

  it("wakes a failed Pi run through the real person-comment route and sends the full unseen direction once", async () => {
    const issueId = randomUUID();
    const taskText = "COMMENT_ROUTE_OLD_TASK";
    const direction = "New direction from the real HTTP comment route: inspect every changed setting before finishing.";
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "fixture/model" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Resume after failure by comment", description: taskText,
      status: "in_progress", workMode: "standard", assigneeAgentId: agentId, responsibleUserId: "board-user" }).returning();
    const baseline = await buildExecutionContinuation({ db, companyId, issueId, agentId, context: {}, summary: null, exposeLowTrustRaw: false });
    const first = await failTurn(issueId, "opencode_empty_response", { executionContinuation: baseline }, undefined, "pi_rpc", false, false, true);
    const [blocker] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: {} }).returning();
    const heartbeat = heartbeatService(db);
    let retryRunId: string | undefined;
    try {
      const [{ issueRoutes }, { errorHandler }] = await Promise.all([import("../../routes/issues.js"), import("../../middleware/index.js")]);
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => {
        Object.assign(req, { actor: { type: "board", userId: "board-user", companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "member", status: "active" }], source: "cloud_tenant", isInstanceAdmin: false } }); next();
      });
      app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
      const response = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: direction, clientRequestId: randomUUID() });
      expect(response.status).toBe(201);
      expect(response.body.body).toBe(direction);
      let retry: typeof heartbeatRuns.$inferSelect | undefined;
      await vi.waitFor(async () => {
        retry = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
          .find(run => run.id !== first.runId && run.contextSnapshot?.issueId === issueId && run.status === "queued");
        expect(retry).toBeDefined();
      }, { timeout: 10_000, interval: 25 });
      retryRunId = retry!.id;
      const context = { ...retry!.contextSnapshot, executionContinuation: await buildExecutionContinuation({ db, companyId, issueId,
        agentId, runId: retry!.id, context: retry!.contextSnapshot!, previousContextRunId: first.runId, summary: null, exposeLowTrustRaw: false }) };
      const wakePayload = await buildPaperclipWakePayload({ db, companyId, agentId, runId: retry!.id, contextSnapshot: context, retainFullCommentBodies: true });
      expect(wakePayload?.reason).toBe("issue_commented");
      const retained = buildNativeExecutionWithCheckpoint({
        previousRun: { ...first.failedRun, runnerProfileJson: { nativeExecutionInput: first.execution,
          nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local", "pi_rpc"), sessionCheckpoint: first.savedCheckpoint } },
        normalizedSessionId: first.execution.session.normalizedSessionId!,
        buildExecution: options => buildNativeExecutionInput({ companyId, agentId, runId: retry!.id, issue, taskPrompt: taskText,
          provider: "pi_rpc", model: "fixture/model", ...options,
          previousTurn: { runId: first.runId, task: issue, nativeExecutionInput: first.execution }, wakePayload,
          workspace: { id: "retry-workspace", cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
          runtimeContext: nativeRuntimeContextFixture(), completionContract: first.execution.completionContract }),
      });
      expect(retained.normalizedSessionId).toBe(first.execution.session.normalizedSessionId);
      expect(retained.checkpoint).not.toBeNull();
      const sent: string[] = [];
      const probe = piRecoveryProbe(first.execution.session.normalizedSessionId!, sent);
      await expect(executeNativeSession({ input: retained.execution, persistedSession: { ...retained.checkpoint!, providerRecoveryPolicy: "same_session_only" },
        backend: probe.backend, controlPlane: probeControlPlane(), runnerInstanceId: "comment-retry-proof", controlPlaneInstanceId: "comment-control",
        timeoutMs: 5_000, requireSessionCloseBeforeReturn: true })).rejects.toThrow("proof stops at provider submission");
      expect(sent).toHaveLength(1);
      expect(sent[0].split(direction)).toHaveLength(2);
      expect(sent[0]).not.toContain(taskText);
      process.stdout.write(JSON.stringify({ proof: "real-comment-route-retry", failedRunId: first.runId, retryRunId,
        commentId: response.body.id, reason: wakePayload?.reason, bytes: Buffer.byteLength(sent[0]), taskPresent: false, directionCount: 1 }) + "\n");
    } finally {
      if (retryRunId) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, retryRunId));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
      await heartbeat.drainActiveRunExecutions();
      await db.update(agents).set({ adapterConfig: { provider: "opencode", model: "openrouter/test-model" }, runtimeConfig: {} }).where(eq(agents.id, agentId));
    }
  }, 120_000);

  it("does not treat a copied retry intent id as a used continuation", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Review another PR", status: "in_progress", workMode: "standard", assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const first = await failTurn(issueId, "opencode_empty_response");
    expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
    const intent = (await issueWakes(issueId)).find(wake => wake.requestedByActorId === "native-status-committer")!;
    // A real intent id copied into a run that the dispatcher did not start.
    await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const copied = await failTurn(issueId, "opencode_empty_response", { nativeStatusWakeIntentId: intent.id });
    expect(copied.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
  }, 120_000);
});
