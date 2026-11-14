import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, companies, completionContracts, controllerInstances, createDb, environmentLeases, environments, executionWorkspaces, executionWorkspaceRuntimeLeases,
  sandboxCreationOperations, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints, nativeRunResults, toolInvocations, issueRecoveryActions, workspaceOperations, issueThreadInteractions, issueQuestionResponseDeliveries, issueComments,
} from "@paperclipai/db";
import { DurablePrpControlPlane, type NativeSession, type NativeSessionBackend, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { materializeNativeInteractionResponses } from "./native-interaction-bridge.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter, restoreNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { createNativeControllerRecovery, resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { currentControllerProcessStamp } from "../controller-process-identity.js";
import * as controllerProcessIdentity from "../controller-process-identity.js";
import { logger } from "../../middleware/logger.js";
import * as controllerLease from "../controller-instance-lease.js";
import { proveControllerInstance, registerControllerInstanceLeaseWork, resetControllerInstanceLeaseForTests,
  tickControllerInstanceLease } from "../controller-instance-lease.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { lockSourceRecoveryCoordinators } from "./native-source-recovery-ownership.js";
import { planNativeLifecycleSettlement } from "./native-lifecycle-command-settlement.js";
import { noControllerOwnedRecordsSql, OWNABLE_KINDS, resolveFenceHolders } from "../recovery/ownership-registry.js";
import { waitForCondition } from "../../__tests__/helpers/native-restart.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../question-response-delivery.js";
import {
  buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget,
} from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import {
  findNativePredecessorRetirementUnproven, NATIVE_PREDECESSOR_RETIREMENT_UNPROVEN_CODE, NativePredecessorRetirementUnprovenError,
} from "./predecessor-retirement.js";

const toolDefinitions = vi.hoisted(() => vi.fn());
vi.mock("../../runtime-api.js", async importOriginal => ({ ...await importOriginal<typeof import("../../runtime-api.js")>(), resolveLocalRuntimeApiUrl: () => "http://127.0.0.1:43219" }));
vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    readonly binding = {};
    definitions() { return toolDefinitions(); }
    close() {}
  },
}));
vi.mock("./current-wake-comments.js", async importOriginal => ({
  ...await importOriginal<typeof import("./current-wake-comments.js")>(),
  resolveCurrentWakeCommentsBinding: async () => null,
  assertCurrentWakeCommentsRead: async () => undefined,
}));
import { buildNativeHarnessBackupManifest, createRunnerdBackend, executePaperclipNativeSession, inspectFinishedPerTurnRunnerdOwner, quarantinedBootstrapOfOwnerHeldNoProviderWork, resolveNativeHarnessPersistenceProfile,
  scopedRunnerdStateRoot } from "./native-session-executor.js";

// Durable-root admission is the boundary under test. Reaching the run's tool
// authority proves admission passed; no provider or runner process starts.
const ADMITTED = "follow-up admission reached tool authority";
const STRANDED = "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate";
/** The held follow-up names the retirement proof that failed. */
const stranded = (refused: string) => `${STRANDED}; retirement_refused=${refused}`;

describe.skipIf(!recoveryPostgresSupport.supported)("follow-up after a recovered per-turn native owner", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  let stateDirectory: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  const companyId = randomUUID(), agentId = randomUUID();

  beforeAll(async () => {
    home = createIsolatedTestHome();
    process.env.PAPERCLIP_HOME = home.home;
    database = await startRecoveryPostgres("native-recovered-owner-");
    db = createDb(database.connectionString);
    const current = await currentNativeControllerIdentity();
    await db.insert(controllerInstances).values({ bootId: current.bootId, processSpace: "settlement-test-current",
      pid: current.pid, startedAt: current.processStartedAt, leaseExpiresAt: new Date(Date.now() + 3_600_000) });
    await db.insert(companies).values({ id: companyId, name: "Recovered owner", issuePrefix: "ROF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "claude" } });
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
    home?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
  });
  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "native-recovered-owner-state-"));
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateDirectory;
    toolDefinitions.mockReset().mockRejectedValue(new Error(ADMITTED));
  });
  afterEach(async () => {
    if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
    else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
    await rm(stateDirectory, { recursive: true, force: true });
  });

  const issueFields = (issueId: string) => ({ id: issueId, title: "Continue after recovery", description: null, reviewPolicy: null });

  /** A per-turn sandbox turn whose post-turn checkpoint copy failed. Recovery
   * later committed its result and released the controller lease, but no
   * suspended Runner receipt or failover backup ever reached the controller.
   * Only the database controller checkpoint and recovery pointer survive. */
  async function seedRecoveredPriorRun(control: "settled" | "pending-command" | "unanswered-tool"
    | "failed-turn-start" | "rejected-turn-start" | "indeterminate-turn-start" | "unknown-outcome-turn-start"
    | "unsuperseded-unknown-outcome-turn-start" | "failed-suspend" | "pending-attach" | "pending-tool-result" = "settled",
    options: { controller?: { bootId: string; pid: number; processStartedAt: Date }; provider?: "codex" | "acpx" | "opencode" | "pi_rpc";
      lifecycle?: "warm"; governedWait?: boolean; connectionWait?: boolean; interruptedLifecycle?: boolean; activeAfterTerminal?: boolean;
      lifecycleIssuedAt?: string; stamped?: boolean; deliveryCount?: number } = {}) {
    const issueId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue after recovery", assigneeAgentId: agentId, status: "in_progress" });
    const [row] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, contextSnapshot: { issueId }, ...(options.connectionWait ? { responsibleUserId: "board-person" } : {}) }).returning();
    const native = await prepareNativeHeartbeatRun({ db, run: row, issue: issueFields(issueId), environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const executionFor = (currentRunId: string) => buildNativeExecutionInput({
      companyId, agentId, runId: currentRunId, provider: options.provider ?? "acpx", acpxAgent: "claude",
      model: options.provider === "codex" ? "gpt-6.1-sol"
        : options.provider === "pi_rpc" ? "paperclip/faux"
          : options.provider === "opencode" ? "openrouter/deepseek/deepseek-v4.1-flash-1017" : "claude-opus-5-5",
      issue: { id: issueId, identifier: "ROF-1", title: "Continue after recovery", description: null, workMode: "standard" },
      taskPrompt: "Continue the conversation.",
      workspace: { id: workspaceId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: native.normalizedSessionId,
      lifecyclePolicy: options.lifecycle === "warm" ? { mode: "warm", idleTimeoutMs: 900_000 } : { mode: "per_turn", idleTimeoutMs: null },
      runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: contract.schemaVersion,
        contract: contract.contractJson as never },
    });
    const execution = executionFor(runId);
    const identity = { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
      environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId };
    const priorController = options.controller ?? { bootId: randomUUID(), pid: 2_147_483_000,
      processStartedAt: new Date(Math.min(Date.now(), (await currentNativeControllerIdentity()).processStartedAt.getTime()) - 60_000) };
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: priorController.bootId, generation: 1, leaseOwner: randomUUID() };
    if (options.interruptedLifecycle && priorController.bootId !== (await currentNativeControllerIdentity()).bootId) {
      await db.insert(controllerInstances).values({ bootId: priorController.bootId, processSpace: "settlement-test-old",
        pid: priorController.pid, startedAt: priorController.processStartedAt, leaseExpiresAt: new Date(Date.now() - 30_000),
        ...(options.stamped ? { fencedAt: new Date() } : { stoppedAt: new Date() }) }).onConflictDoNothing();
    }
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed",
      controllerBootId: owner.bootId, controllerGeneration: 1, controllerPid: priorController.pid,
      controllerProcessStartedAt: priorController.processStartedAt, leaseOwner: owner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    const questionKey = options.connectionWait ? `connection-intent:${runId}:board-person:github` : `parked-question:${runId}`;
    const governedInteraction = options.connectionWait ? await issueThreadInteractionService(db).createConnectionIntent({ id: issueId, companyId }, {
      sourceRunId: runId, addresseeUserId: "board-person", idempotencyKey: questionKey,
      payload: { version: 1, serviceSlug: "github", serviceName: "GitHub", requestingAgentId: agentId,
        requestingAgentName: "Recovery agent", phase: "requested" },
    }) : options.governedWait ? await issueThreadInteractionService(db).create({ id: issueId, companyId }, {
      kind: "ask_user_questions", idempotencyKey: questionKey, sourceRunId: runId, continuationPolicy: "wake_assignee",
      payload: { version: 1, title: "Choose a color", questions: [{ id: "color", prompt: "Which color?", selectionMode: "single",
        required: true, options: [{ id: "green", label: "Green" }] }] },
    }, { agentId, runId }) : null;
    const scratch = await mkdtemp(join(tmpdir(), "native-recovered-owner-controller-"));
    const controller = new DurablePrpControlPlane({ stateDirectory: scratch, identity,
      expectedRunnerVersion: "recovered-owner-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      // Shape the file-backed journal first; the database checkpoint captures
      // it when persistence moves to the controller's external writer.
      const unknownOutcome = { status: "failed", result: { commandType: "turn.start", status: "failed",
        result: { code: "execution_indeterminate", message: "runner recovered after journaling this command; it will not execute twice" } } };
      const answers = {
        "failed-turn-start": { status: "failed", result: { status: "failed" } },
        "rejected-turn-start": { status: "rejected", result: { status: "rejected" } },
        "indeterminate-turn-start": { status: "indeterminate", result: { status: "indeterminate" } },
        "unknown-outcome-turn-start": unknownOutcome,
      } as const;
      const answered = answers as Record<string, unknown>;
      // A warm Runner stays ready after its turn: its controller sends no suspend.
      const commands = ["run.prepare", "session.open", ...(control in answered ? ["turn.start"] : []), "turn.start",
        ...(options.lifecycle === "warm" ? [] : ["runner.suspend"])].map(type => controller.queueCommand(type));
      for (const command of control === "pending-command" ? commands.slice(0, -1) : commands) {
        Object.assign(command, { status: "completed", result: { status: "completed" } });
      }
      if (control in answered) Object.assign(commands[2]!, answers[control as keyof typeof answers]);
      if (control === "unsuperseded-unknown-outcome-turn-start") {
        Object.assign(commands.find(command => command.type === "turn.start")!, unknownOutcome);
      }
      if (control === "failed-suspend") Object.assign(commands.at(-1)!, { status: "failed", result: { status: "failed" } });
      if (options.interruptedLifecycle) {
        Object.assign(controller.queueCommand("turn.interrupt"), { status: "completed", result: { status: "completed" } });
        if (options.stamped) controller.setCommandIssuer({ bootId: priorController.bootId, generation: 1 });
        for (const type of ["runner.drain", "runner.suspend"]) {
          const command = controller.queueCommand(type);
          command.issuedAt = options.lifecycleIssuedAt ?? new Date(priorController.processStartedAt.getTime() + 1_000).toISOString();
          if (options.deliveryCount !== undefined) controller.store.state.commandDeliveryCounts[command.commandId] = options.deliveryCount;
        }
      }
      // Staging PAP-4196 and PAP-3443: the controller journaled a delivery to the
      // per-turn Runner that the Runner never acknowledged before its sandbox was
      // destroyed after the turn.
      if (control === "pending-attach") controller.queueCommand("run.attach", { provider: "fixture" });
      const toolInput = control === "unanswered-tool" || control === "pending-tool-result";
      if (control === "pending-tool-result") controller.queueCommand("semantic_tool.result", { sourceEventId: "unanswered-tool-input" });
      const event = (sourceSeq: number, sourceEventId: string, eventType: string) => ({ sourceSeq, sourceEventId, eventType,
        priority: 0 as const, envelope: { ...identity, payload: { ...identity, payload: { semantic_tool: {
          schema: "paperclip.prp.semantic_tool.v1", operationId: options.connectionWait ? "connections_request" : options.governedWait ? "request_human_input" : "non_parked_tool",
          callId: sourceEventId, input: options.connectionWait ? { service: "github" } : { interactionKind: "questions", idempotencyKey: questionKey },
        } } } }, deliveryCount: 1, logicalEffectCount: 1 });
      controller.store.state.committedEvents.push(
        ...(toolInput ? [event(1, "unanswered-tool-input", "semantic_tool.input")] : []),
        ...(options.interruptedLifecycle ? [event(1, "interrupted-turn", "turn.interrupted")] : []),
        event(2, "recovered-terminal", "run.terminal"),
        ...(options.activeAfterTerminal ? [event(3, "active-successor-turn", "turn.started")] : []));
      controller.store.state.ackedSourceSeq = options.activeAfterTerminal ? 3 : 2;
      controller.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
      await controller.flushCheckpoint();
    } finally {
      await controller.stop();
      await rm(scratch, { recursive: true, force: true });
    }
    const snapshot: PersistedNativeSession = { backendKind: "runner", sessionId: native.normalizedSessionId,
      ...(options.provider === "pi_rpc" ? { driverKind: "pi_rpc" as const } : {}),
      providerSessionId: "provider-session-before-recovery", activeTurnId: null, pendingRuntimeRequests: [],
      identity: { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId } };
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
      completionContractId: prepared.completionContractId!, serverFingerprint: "fixture", schemaStatus: "accepted",
      // A turn parked on a request_human_input question commits this governed-wait result.
      resultJson: governedInteraction ? { result: { continuation: { kind: "response_wake", idempotencyKey: `interaction-response:${governedInteraction.id}` },
        artifacts: [{ kind: "issue_thread_interaction", ref: `interaction:${governedInteraction.id}` }] } } : {},
      canonicalSha256: "fixture" }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: {
      ...prepared.runnerProfileJson, nativeExecutionInput: execution, sessionCheckpoint: snapshot,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", execution.provider.kind),
      nativeControllerRecovery: createNativeControllerRecovery(snapshot,
        { configDigest: `sha256:${"b".repeat(64)}`, processConfigDigest: null },
        { runId, runnerInstanceId: native.runnerInstanceId, normalizedSessionId: native.normalizedSessionId }),
    } }).where(eq(heartbeatRuns.id, runId));
    return { issueId, runId, native, identity, executionFor, priorController, governedInteraction };
  }

  /** Mirrors runtime selection: the follow-up inherits the selected source's
   * provider checkpoint before the executor admits its durable root. */
  async function admitFollowUp(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>, expectBareBarrier = false) {
    const runId = randomUUID();
    const [row] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: prior.issueId, nativeSessionId: prior.native.normalizedSessionId, contextSnapshot: { issueId: prior.issueId } }).returning();
    const next = await prepareNativeHeartbeatRun({ db, run: row, issue: issueFields(prior.issueId), environmentLeaseId: randomUUID() });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: prior.issueId, runId, phase: "observed" });
    await db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, prior.issueId));
    const execution = prior.executionFor(runId);
    const selected = await findNativeSessionResumeRun(db, { companyId, agentId, issueId: prior.issueId,
      normalizedSessionId: prior.native.normalizedSessionId, currentRunId: runId, beforeCreatedAt: row.createdAt });
    const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: prior.native.normalizedSessionId,
      executionTargetKind: "remote", buildExecution: () => execution });
    if (expectBareBarrier) expect(admission.checkpoint).toBeNull();
    else expect(admission.checkpoint).not.toBeNull();
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...current.runnerProfileJson, nativeExecutionInput: execution,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", execution.provider.kind),
      sessionCheckpoint: admission.checkpoint } }).where(eq(heartbeatRuns.id, runId));
    const logs: string[] = [], environmentId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${runId}`;
    const remoteExecute = vi.fn(async (_request: unknown): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> => {
      throw new Error("admission must not reach the sandbox");
    });
    const failures: unknown[] = [];
    const start = (outcome: "created" | "replacement" | "resumed" = "created",
      restartRecovery?: Parameters<typeof createRunnerdBackend>[0]["restartRecovery"], restarted = false) => createRunnerdBackend({
      db, execution, runnerInstanceId: next.runnerInstanceId, onLog: async (_stream, chunk) => { logs.push(chunk); },
      ...(restartRecovery ? { restartRecovery } : {}),
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId,
        leaseId, remoteCwd: "/workspace", reusableLeaseConfigured: true,
        runner: { execute: remoteExecute },
        sandboxLeaseAcquisition: { outcome, providerLeaseId, ...(restarted ? { restarted: true } : {}) } } as never,
    }).then(() => "constructed", (error: Error) => { failures.push(error); return error.message; });
    // A local Runner keeps its controller root on this host between turns.
    const startLocal = (restartRecovery?: Parameters<typeof createRunnerdBackend>[0]["restartRecovery"]) => createRunnerdBackend({
      db, execution, runnerInstanceId: next.runnerInstanceId, onLog: async (_stream, chunk) => { logs.push(chunk); },
      ...(restartRecovery ? { restartRecovery } : {}),
    }).then(() => "constructed", (error: Error) => error.message);
    return { runId, logs, start, startLocal, failures, native: next, environmentId, leaseId, providerLeaseId, remoteExecute, selectedRunId: selected?.id ?? null };
  }

  /** The prior run's released lease on this same allocation: the evidence a
   * resumed sandbox's retained binding requires. */
  async function recordPriorLeaseOnSameSandbox(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>,
    followUp: Awaited<ReturnType<typeof admitFollowUp>>, generation: "lost" | "live" = "lost") {
    await db.insert(environments).values({ id: followUp.environmentId, name: `restarted-${followUp.environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId, issueId: prior.issueId,
      heartbeatRunId: prior.runId, provider: "daytona", providerLeaseId: followUp.providerLeaseId,
      status: "released", releasedAt: new Date(), metadata: { remoteCwd: "/workspace" } });
    // The restarted box still holds the dead Runner's last, unsuspended state.
    const deadRunnerState = Buffer.from(JSON.stringify({ schema: "paperclip.runner.durable.state.v1", lifecycle: "ready",
      runId: prior.runId })).toString("base64");
    // The box's launch marker names the prior Runner's process and start
    // generation. "lost": that process is gone (probe exit 45); "live": the
    // same machine came back with it still running (exit 0).
    const marker = `nonce1\n4242\n2026-11-13T10:00:00.000Z\n${prior.native.runnerInstanceId}\nlinux:0b5e6c2a-1111-4222-8333-944455556666:12345\n`;
    followUp.remoteExecute.mockImplementation(async (request: unknown) => {
      const text = JSON.stringify(request);
      if (text.includes("paperclip-runner-generation-marker")) return { exitCode: 0, timedOut: false, stdout: marker, stderr: "" };
      if (text.includes("paperclip-runner-generation-check")) return { exitCode: generation === "lost" ? 45 : 0, timedOut: false, stdout: "", stderr: "" };
      if (text.includes("runner-state.json")) return { exitCode: 0, timedOut: false, stdout: deadRunnerState, stderr: "" };
      throw new Error("admission must not reach the sandbox");
    });
  }

  const RESTARTED_OWNER_REFUSAL =
    "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; retirement_refused=restarted_sandbox_owner_unproven";

  /**
   * Upstream 566a97b88 (#20863): an unretirable owner on a resumed sandbox is a
   * typed fresh-sandbox fallback, not a raw failure. The fork's exact refusal
   * stays its cause, the fallback names this sandbox (the one to replace, never
   * reuse), and nothing beyond the read-only generation proof reached it: the
   * unproven owner is never retired by force and no Runner is launched there.
   */
  function expectFreshSandboxFallback(message: string, prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>,
    followUp: Awaited<ReturnType<typeof admitFollowUp>>) {
    expect(message).toBe(`The previous run's session on this sandbox could not be retired (${RESTARTED_OWNER_REFUSAL}). `
      + "The next attempt starts on a fresh sandbox.");
    const typed = findNativePredecessorRetirementUnproven(followUp.failures.at(-1));
    expect(typed).toBeInstanceOf(NativePredecessorRetirementUnprovenError);
    expect(typed!.code).toBe(NATIVE_PREDECESSOR_RETIREMENT_UNPROVEN_CODE);
    expect(typed!.predecessorRunId).toBe(prior.runId);
    expect(typed!.providerLeaseId).toBe(followUp.providerLeaseId);
    expect(typed!.cause).toBeInstanceOf(Error);
    expect((typed!.cause as Error).message).toBe(RESTARTED_OWNER_REFUSAL);
    expect(followUp.remoteExecute.mock.calls.every(([request]) =>
      /base64 <|paperclip-runner-generation-(marker|check)/.test(JSON.stringify(request)))).toBe(true);
    expect(followUp.remoteExecute.mock.calls.some(([request]) => JSON.stringify(request).includes("paperclip-runner-launch"))).toBe(false);
  }

  async function quarantined() {
    const path = join(stateDirectory, "quarantine");
    return existsSync(path) ? readdir(path) : [];
  }

  async function sessionRoot() {
    const roots = (await readdir(stateDirectory)).filter(name => /^[a-f0-9]{64}$/.test(name));
    expect(roots).toHaveLength(1);
    return join(stateDirectory, roots[0]!);
  }

  async function archivedOwners(root: string) {
    const parent = join(root, "continuity-breaks");
    if (!existsSync(parent)) return [];
    return Promise.all((await readdir(parent)).map(async name => {
      expect(name).toMatch(/^\d+-[0-9a-f-]{36}$/);
      return JSON.parse(await readFile(join(parent, name, "control-plane", "control-plane-state.json"), "utf8")).identity.runId as string;
    }));
  }

  async function seedSuccessorCheckpoint(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>) {
    const pending = await admitFollowUp(prior), runId = pending.runId, execution = prior.executionFor(runId);
    const identity = { ...prior.identity, runId, turnId: `turn-${runId}`, itemId: `item-${runId}` };
    const owner = { companyId, issueId: prior.issueId, runId, authorityRunId: runId,
      bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.update(heartbeatRuns).set({ runnerInstanceId: identity.runnerInstanceId }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId, controllerGeneration: 1,
      controllerPid: 2_147_483_000, controllerProcessStartedAt: new Date(Date.now() - 60_000), leaseOwner: owner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
    const scratch = await mkdtemp(join(tmpdir(), "native-successor-checkpoint-"));
    const controller = new DurablePrpControlPlane({ stateDirectory: scratch, identity,
      expectedRunnerVersion: "recovered-owner-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      controller.persistRunAttachTemplate({ provider: execution.provider, normalizedSessionId: identity.normalizedSessionId });
      for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"]) {
        Object.assign(controller.queueCommand(type), { status: "completed", result: { status: "completed" } });
      }
      controller.store.state.committedEvents.push({ sourceSeq: 2, sourceEventId: `terminal-${runId}`, eventType: "run.terminal",
        priority: 0, envelope: { ...identity }, deliveryCount: 1, logicalEffectCount: 1 });
      controller.store.state.ackedSourceSeq = 2;
      controller.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
      await controller.flushCheckpoint();
    } finally {
      await controller.stop();
      await rm(scratch, { recursive: true, force: true });
    }
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const snapshot: PersistedNativeSession = { backendKind: "runner", sessionId: prior.native.normalizedSessionId,
      providerSessionId: "provider-session-before-recovery", activeTurnId: null, pendingRuntimeRequests: [],
      identity: { companyId, agentId, issueId: prior.issueId, runId, sessionId: prior.native.normalizedSessionId } };
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId: prior.issueId, runId,
      completionContractId: prepared.completionContractId!, serverFingerprint: runId, schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: runId }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: {
      ...prepared.runnerProfileJson, nativeExecutionInput: execution, sessionCheckpoint: snapshot,
      nativeControllerRecovery: createNativeControllerRecovery(snapshot,
        { configDigest: `sha256:${"b".repeat(64)}`, processConfigDigest: null },
        { runId, runnerInstanceId: identity.runnerInstanceId, normalizedSessionId: identity.normalizedSessionId }),
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, runId));
    return { runId, execution, identity };
  }

  async function staleProjection(provider: "codex" | "acpx" = "codex", external = false) {
    const prior = await seedRecoveredPriorRun("settled", { provider });
    const latest = await seedSuccessorCheckpoint(prior), followUp = await admitFollowUp(prior);
    expect(followUp.selectedRunId).toBe(latest.runId);
    const root = scopedRunnerdStateRoot(latest.execution), backupRoot = join(root, "failover-backups", "current");
    const oldCheckpoint = await loadNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId });
    expect(oldCheckpoint).not.toBeNull();
    oldCheckpoint!.restoreSessionDirectory(root);
    const path = join(root, "control-plane", "control-plane-state.json");
    if (external) await writeFile(path, JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: prior.identity }));
    const originalBytes = await readFile(path, "utf8");
    const providerFiles = new Map<string, string>();
    for (const directory of resolveNativeHarnessPersistenceProfile(latest.execution).directories) {
      await mkdir(join(backupRoot, directory.name), { recursive: true });
      if (directory.name !== "runner") {
        const file = join(backupRoot, directory.name, "retained-conversation.txt"), bytes = `saved conversation for ${latest.runId}`;
        await writeFile(file, bytes);
        providerFiles.set(file, bytes);
      }
    }
    const runnerBytes = JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...latest.identity,
      lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, pendingProviderCleanup: null });
    await writeFile(join(backupRoot, "runner", "runner-state.json"), runnerBytes);
    const manifestBytes = JSON.stringify(buildNativeHarnessBackupManifest({ backupRoot, execution: latest.execution,
      runnerInstanceId: latest.identity.runnerInstanceId, sourceProviderLeaseId: `sandbox-${latest.runId}`,
      providerSessionIdentity: { providerSessionId: "provider-session-before-recovery", providerBackendSessionId: null,
        providerSessionIdentity: null } }));
    await writeFile(join(backupRoot, "manifest.json"), manifestBytes);
    const assertBackup = async () => {
      expect(await readFile(join(backupRoot, "manifest.json"), "utf8")).toBe(manifestBytes);
      expect(await readFile(join(backupRoot, "runner", "runner-state.json"), "utf8")).toBe(runnerBytes);
      for (const [file, bytes] of providerFiles) expect(await readFile(file, "utf8")).toBe(bytes);
    };
    return { prior, latest, followUp, root, path, backupRoot, originalBytes, assertBackup };
  }

  it.each([
    { provider: "codex" as const, external: false }, { provider: "acpx" as const, external: false },
    { provider: "codex" as const, external: true }, { provider: "acpx" as const, external: true },
  ])("keeps the newest $provider checkpoint paired with its suspended backup (external=$external)", async ({ provider, external }) => {
    const fixture = await staleProjection(provider, external);
    const { prior, latest, followUp, root, path } = fixture;
    expect(await followUp.start()).toBe(ADMITTED);
    expect(JSON.parse(await readFile(path, "utf8")).identity).toEqual(latest.identity);
    await fixture.assertBackup();
    expect(await archivedOwners(root)).toEqual([prior.runId]);
    const [archive] = await readdir(join(root, "continuity-breaks"));
    expect(await readFile(join(root, "continuity-breaks", archive!, "control-plane", "control-plane-state.json"), "utf8"))
      .toBe(fixture.originalBytes);
    expect(await readdir(join(root, "continuity-breaks", archive!))).toEqual(["control-plane"]);
    expect(await quarantined()).toEqual([]);
    expect(followUp.logs.join("")).not.toContain("starting a new runner for this conversation");
  }, 60_000);

  it("starts an unclaimed remote follow-up from the previous owner's external marker under a bootstrap claim", async () => {
    const fixture = await staleProjection("codex", true);
    expect(await fixture.followUp.start("created", { kind: "bootstrap_incomplete", runId: fixture.followUp.runId,
      leaseOwner: "successor", controllerGeneration: 1, providerAttempt: 0, restartKind: "hard", recoveryRequestId: null } as never))
      .toBe(ADMITTED);
    expect(JSON.parse(await readFile(fixture.path, "utf8")).identity).toEqual(fixture.latest.identity);
    await fixture.assertBackup();
    expect(await quarantined()).toEqual([]);
  }, 60_000);

  it("rehydrates a same-source external marker before reading the suspended resumed sandbox", async () => {
    const fixture = await staleProjection("codex", true), { latest, followUp, root, path } = fixture;
    await writeFile(path, JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: latest.identity }));
    await db.insert(environments).values({ id: followUp.environmentId, name: `retained-${followUp.environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId,
      issueId: fixture.prior.issueId, heartbeatRunId: latest.runId, provider: "daytona", providerLeaseId: followUp.providerLeaseId,
      status: "released", metadata: { remoteCwd: "/workspace" } });
    const runnerState = { schema: "paperclip.runner.durable.state.v1", ...latest.identity, lifecycle: "suspended", outbox: [],
      pendingTerminalDelivery: null, pendingProviderCleanup: null, warmTransition: null };
    followUp.remoteExecute.mockResolvedValueOnce({ exitCode: 0, timedOut: false,
      stdout: Buffer.from(JSON.stringify(runnerState)).toString("base64"), stderr: "" });
    expect(await followUp.start("resumed")).toBe(ADMITTED);
    expect(JSON.parse(await readFile(path, "utf8")).identity).toEqual(latest.identity);
    expect(JSON.parse(await readFile(join(root, "plugin-runner-state.json"), "utf8"))).toMatchObject(latest.identity);
    expect(followUp.remoteExecute).toHaveBeenCalledOnce();
    await fixture.assertBackup();
    expect(await archivedOwners(root)).toEqual([]);
    expect(await quarantined()).toEqual([]);
  }, 60_000);

  it("preserves a same-source marker with a different turn identity before any remote read", async () => {
    const fixture = await staleProjection("codex", true), { latest, followUp, root, path } = fixture;
    const marker = JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1",
      identity: { ...latest.identity, itemId: "foreign-item" } });
    await writeFile(path, marker);
    expect(await followUp.start("resumed")).toBe("native_runner_checkpoint_projection_held:prior_identity");
    expect(await readFile(path, "utf8")).toBe(marker);
    expect(followUp.remoteExecute).not.toHaveBeenCalled();
    await fixture.assertBackup();
    expect(await archivedOwners(root)).toEqual([]);
  }, 60_000);

  it.each(["codex", "opencode"] as const)("rehydrates the current %s run marker from its own checkpoint instead of an earlier turn", async provider => {
    const prior = await seedRecoveredPriorRun("settled", { provider }), followUp = await admitFollowUp(prior);
    const identity = { runId: followUp.runId, runnerInstanceId: followUp.native.runnerInstanceId,
      environmentLeaseId: followUp.native.environmentLeaseId, normalizedSessionId: followUp.native.normalizedSessionId,
      turnId: followUp.native.turnId, itemId: followUp.native.itemId };
    const root = scopedRunnerdStateRoot(prior.executionFor(followUp.runId));
    const owner = { companyId, issueId: prior.issueId, runId: followUp.runId, authorityRunId: followUp.runId,
      bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId, controllerGeneration: 1,
      leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, followUp.runId));
    const controller = new DurablePrpControlPlane({ stateDirectory: join(root, "control-plane"), identity,
      expectedRunnerVersion: "current-marker-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      const commands = [controller.queueCommand("run.prepare"), controller.queueCommand("session.open")];
      controller.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
      await controller.flushCheckpoint();
      const path = join(root, "control-plane", "control-plane-state.json");
      expect(JSON.parse(await readFile(path, "utf8")).schema).toBe("paperclip.runner.external-control-plane-state.v1");
      await mkdir(join(root, "runner"), { recursive: true });
      await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
        schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended" }));
      expect(await followUp.start()).toBe(ADMITTED);
      const restored = JSON.parse(await readFile(path, "utf8"));
      expect(restored.identity).toEqual(identity);
      expect(restored.commands.map((command: { commandId: string }) => command.commandId)).toEqual(commands.map(command => command.commandId));
      expect(await archivedOwners(root)).toEqual([]);
      expect(await quarantined()).toEqual([]);
    } finally { await controller.stop(); }
  }, 60_000);

  it("never substitutes an older checkpoint when the current run marker has no checkpoint", async () => {
    const prior = await seedRecoveredPriorRun(), followUp = await admitFollowUp(prior);
    const root = scopedRunnerdStateRoot(prior.executionFor(followUp.runId)), path = join(root, "control-plane", "control-plane-state.json");
    await mkdir(join(root, "control-plane"), { recursive: true });
    const marker = JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity: {
      runId: followUp.runId, runnerInstanceId: followUp.native.runnerInstanceId, environmentLeaseId: followUp.native.environmentLeaseId,
      normalizedSessionId: followUp.native.normalizedSessionId, turnId: followUp.native.turnId, itemId: followUp.native.itemId,
    } });
    await writeFile(path, marker);
    expect(await followUp.start()).toBe("native_runner_checkpoint_missing");
    expect(await readFile(path, "utf8")).toBe(marker);
    expect(await archivedOwners(root)).toEqual([]);
  }, 60_000);

  it.each(["unsettled journal", "old owner held", "selected owner held", "foreign scope", "selected parts missing", "selected parts tampered"] as const)(
    "preserves the stale projection and newer backup with %s", async scenario => {
      const fixture = await staleProjection(), { prior, latest, followUp, path, root } = fixture;
      if (scenario === "unsettled journal") {
        const state = JSON.parse(fixture.originalBytes);
        state.commands[0].status = "pending";
        await writeFile(path, JSON.stringify(state));
      }
      if (scenario === "old owner held" || scenario === "selected owner held") {
        await db.update(nativeRunFinalizations).set({ leaseOwner: "another-owner", leaseExpiresAt: new Date(Date.now() + 60_000) })
          .where(eq(nativeRunFinalizations.runId, scenario === "old owner held" ? prior.runId : latest.runId));
      }
      if (scenario === "foreign scope") {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, prior.runId));
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...row.runnerProfileJson, nativeExecutionInput: {
          ...prior.executionFor(prior.runId), binding: { ...prior.executionFor(prior.runId).binding, executionWorkspaceId: randomUUID() },
        } } }).where(eq(heartbeatRuns.id, prior.runId));
      }
      if (scenario === "selected parts missing") {
        await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, latest.runId));
      }
      if (scenario === "selected parts tampered") {
        await db.update(nativeRunnerCheckpoints).set({ material: { tampered: true } }).where(eq(nativeRunnerCheckpoints.runId, latest.runId));
      }
      const before = await readFile(path, "utf8");
      expect(await followUp.start()).not.toBe(ADMITTED);
      expect(await readFile(path, "utf8")).toBe(before);
      await fixture.assertBackup();
      expect(await archivedOwners(root)).toEqual([]);
      expect(await quarantined()).toEqual([]);
    }, 60_000);

  it("never replaces a newer local projection with the earlier selected checkpoint", async () => {
    const fixture = await staleProjection();
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, fixture.prior.runId));
    const before = await readFile(fixture.path, "utf8");
    expect(await fixture.followUp.start()).toBe("native_controller_recovery_missing_evidence:newer_progress_barrier");
    expect(await readFile(fixture.path, "utf8")).toBe(before);
    await fixture.assertBackup();
    expect(await archivedOwners(fixture.root)).toEqual([]);
  }, 60_000);

  it.each([false, true])("does not overwrite a current owner while waiting for its coordinator lock (external=%s)", async external => {
    const fixture = await staleProjection("codex", external);
    let release!: () => void, locked!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db.transaction(async tx => {
      await lockSourceRecoveryCoordinators(tx, companyId, [fixture.latest.runId]);
      locked();
      await hold;
    });
    await acquired;
    const pending = fixture.followUp.start();
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        const rows = await db.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
          and query like '%native_run_finalizations%' and query like '%for update%'
        ) as waiting`);
        waiting = rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const state = JSON.parse(fixture.originalBytes);
      state.identity.runId = fixture.followUp.runId;
      await writeFile(fixture.path, JSON.stringify(state));
      const currentBytes = await readFile(fixture.path, "utf8");
      release();
      await blocker;
      expect(await pending).toBe("native_runner_checkpoint_projection_held:journal_changed");
      expect(await readFile(fixture.path, "utf8")).toBe(currentBytes);
      await fixture.assertBackup();
      expect(await archivedOwners(fixture.root)).toEqual([]);
    } finally {
      release();
      await blocker;
      await pending;
    }
  }, 60_000);

  it.each(["created", "replacement"] as const)(
    "admits a fresh runner authority when the recovered owner is provably finished: %s sandbox", async outcome => {
      const prior = await seedRecoveredPriorRun();
      const followUp = await admitFollowUp(prior);
      expect(followUp.selectedRunId).toBe(prior.runId);
      expect(await followUp.start(outcome)).toBe(ADMITTED);
      expect(await quarantined()).toEqual([]);
      const root = await sessionRoot();
      // The prior authority is retained as continuity evidence, not active state.
      expect(existsSync(join(root, "control-plane"))).toBe(false);
      expect(await archivedOwners(root)).toEqual([prior.runId]);
      expect(followUp.logs.join("")).toContain(`Run ${prior.runId} finished without a saved runner checkpoint`);
    }, 60_000);

  it.each(["created", "replacement"] as const)(
    "bootstraps again when a restart cut the follow-up off after it retired the finished owner: %s sandbox", async outcome => {
      const prior = await seedRecoveredPriorRun();
      const followUp = await admitFollowUp(prior);
      expect(await followUp.start(outcome)).toBe(ADMITTED);
      const root = await sessionRoot();
      expect(existsSync(join(root, "control-plane"))).toBe(false);
      expect(await archivedOwners(root)).toEqual([prior.runId]);
      followUp.logs.length = 0;
      expect(await followUp.start(outcome, { kind: "bootstrap_incomplete", runId: followUp.runId, leaseOwner: "successor",
        controllerGeneration: 2, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null } as never)).toBe(ADMITTED);
      const [copy] = await quarantined();
      expect(copy).toMatch(/\.identity_indeterminate\./);
      expect(existsSync(join(stateDirectory, "quarantine", copy!, "continuity-breaks"))).toBe(true);
    }, 60_000);

  async function keepLocalRootWithoutPointer(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>,
    followUp: Awaited<ReturnType<typeof admitFollowUp>>) {
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    const [copy] = await quarantined();
    await rename(join(stateDirectory, "quarantine", copy!), join(stateDirectory, copy!.split(".")[0]!));
    await rm(join(stateDirectory, "quarantine"), { recursive: true, force: true });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, prior.runId));
    const { nativeControllerRecovery: _pointer, ...profile } = run.runnerProfileJson!;
    await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, prior.runId));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
  }

  it.each(["recovery pointer", "local journal only"] as const)(
    "admits a follow-up in the process that finished the owner: %s", async evidence => {
      const prior = await seedRecoveredPriorRun("settled", { controller: await currentNativeControllerIdentity() });
      const followUp = await admitFollowUp(prior);
      if (evidence === "local journal only") await keepLocalRootWithoutPointer(prior, followUp);
      expect(await followUp.start()).toBe(ADMITTED);
      expect(await quarantined()).toEqual([]);
      expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId]);
    }, 60_000);

  it("admits a local journal whose controller process has exited", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    await keepLocalRootWithoutPointer(prior, followUp);
    expect(await followUp.start()).toBe(ADMITTED);
  }, 60_000);

  it.each(["another live controller", "an earlier controller in this process"] as const)(
    "keeps a local journal held while %s may still own it", async scenario => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
      try {
        await new Promise(resolve => child.once("spawn", resolve));
        const self = await currentNativeControllerIdentity();
        const startedAt = await readProcessStartedAt(child.pid!);
        expect(startedAt).toBeTruthy();
        const controller = scenario === "another live controller"
          ? { bootId: randomUUID(), pid: child.pid!, processStartedAt: new Date(startedAt!) }
          : { ...self, bootId: randomUUID() };
        const prior = await seedRecoveredPriorRun("settled", { controller });
        const followUp = await admitFollowUp(prior);
        await keepLocalRootWithoutPointer(prior, followUp);
        expect(await followUp.start()).toMatch(/; retirement_refused=controller_/);
        expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
      } finally {
        child.kill("SIGKILL");
      }
    }, 60_000);

  /** Reshape a finished owner into the run a board Stop settled: cancelled,
   * native_retry_cancelled, no result, with the acknowledged user Stop receipt
   * (the one retainCancelledSession requires to keep a warm Pi owner). */
  async function stopSettledOwner(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>, options: {
    ack?: "own" | "none" | "other-run"; failureCode?: string; leaseOwner?: string;
    /** The owner's own committed provider events (PRP payloads). */
    events?: Array<{ eventType: string; payload: Record<string, unknown> }> } = {}) {
    const ack = options.ack ?? "own";
    for (const [index, event] of (options.events ?? []).entries()) {
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: prior.runId, seq: 800 + index, eventType: event.eventType,
        stream: "system", level: "info", payload: { prpEvent: { schema: "paperclip.prp.event.v1", runId: prior.runId,
          eventType: event.eventType, payload: event.payload } } });
    }
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", runId: ack === "other-run" ? randomUUID() : prior.runId,
      companyId, issueId: prior.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
      dispatched: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() };
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", resultJson: ack === "none" ? {}
      : { cancelledByActorType: "user", cancelledByUserId: "board-user", nativeCancellation } })
      .where(eq(heartbeatRuns.id, prior.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: options.failureCode ?? "native_retry_cancelled",
      resultId: null, ...(options.leaseOwner ? { leaseOwner: options.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) } : {}) })
      .where(eq(nativeRunFinalizations.runId, prior.runId));
  }

  // C6 (REG-03 after a Stop): the warm owner a board Stop retained can die
  // unsuspended. Its run is settled by the Stop, not by a result, so the
  // finished-owner proof accepts exactly that Stop and nothing looser.
  it("retires an owner settled by an acknowledged board Stop", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    // Ordinary diagnostics and a clean interrupt are not uncertainty.
    await stopSettledOwner(prior, { events: [
      { eventType: "harness.diagnostic", payload: { code: "provider_performance_spans", spans: [] } },
      { eventType: "harness.diagnostic", payload: { code: "provider_interrupt_requested", pendingCallIds: [] } },
    ] });
    expect(await followUp.start()).toBe(ADMITTED);
    expect(await quarantined()).toEqual([]);
    expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId]);
  }, 60_000);

  it.each([
    ["a cancelled run with no Stop acknowledgement", { ack: "none" as const }, stranded("owner_terminal_failure")],
    ["a Stop acknowledgement of a different run", { ack: "other-run" as const }, stranded("owner_terminal_failure")],
    ["another terminal failure code", { failureCode: "native_session_interrupted" }, stranded("owner_terminal_failure")],
    // The receipt says the user asked, not that the interrupt settled (code-lead):
    ["an escalated Pi abort", { events: [{ eventType: "harness.diagnostic",
      payload: { code: "pi_abort_escalated", message: "abort did not settle" } }] }, stranded("owner_stop_unsettled")],
    ["an uncertain tool side effect", { events: [{ eventType: "harness.diagnostic",
      payload: { code: "provider_side_effect_uncertain" } }] }, stranded("owner_stop_unsettled")],
    ["an interrupt with a pending tool call", { events: [{ eventType: "harness.diagnostic",
      payload: { code: "provider_interrupt_requested", pendingCallIds: ["call-bash"] } }] }, stranded("owner_stop_unsettled")],
    ["a failed turn", { events: [{ eventType: "turn.failed", payload: { status: "failed" } }] }, stranded("owner_stop_unsettled")],
    // A live lease holds the owner before any retirement proof is read.
    ["a live lease", { leaseOwner: "still-running-controller" }, "native_controller_recovery_waiting_for_owner"],
  ])("keeps a Stop-shaped owner held with %s", async (_label, options, refusal) => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    await stopSettledOwner(prior, options);
    expect(await followUp.start()).toBe(refusal);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  // check6: a remote owner whose sandbox lease ended elsewhere counts an
  // undelivered tool answer as settled only on a committed result. A
  // Stop-settled owner has none, so that answer keeps it held.
  it.each([
    { control: "pending-tool-result" as const, outcome: stranded("owner_stop_unsettled") },
    { control: "settled" as const, outcome: ADMITTED },
  ])("retires a remote-gone Stop-settled owner only with every tool answer delivered ($control)", async ({ control, outcome }) => {
    const prior = await seedRecoveredPriorRun(control, { provider: "opencode" });
    const followUp = await admitFollowUp(prior);
    await db.insert(environments).values({ id: followUp.environmentId, name: `ended-${followUp.environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId, issueId: prior.issueId,
      heartbeatRunId: prior.runId, provider: "daytona", providerLeaseId: `sandbox-${prior.runId}`,
      status: "expired", releasedAt: new Date(), metadata: { remoteCwd: "/workspace" } });
    await stopSettledOwner(prior);
    expect(await followUp.start()).toBe(outcome);
  }, 60_000);

  it("keeps a Stop-settled owner held while its controller is still running", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    try {
      await new Promise(resolve => child.once("spawn", resolve));
      const startedAt = await readProcessStartedAt(child.pid!);
      expect(startedAt).toBeTruthy();
      const prior = await seedRecoveredPriorRun("settled", { controller: { bootId: randomUUID(), pid: child.pid!,
        processStartedAt: new Date(startedAt!) } });
      const followUp = await admitFollowUp(prior);
      await keepLocalRootWithoutPointer(prior, followUp);
      await stopSettledOwner(prior);
      expect(await followUp.start()).toMatch(/; retirement_refused=controller_/);
      expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);

  /** The state left by a follow-up admitted before retirement existed. Its
   * admission quarantined the rebuilt projection and failed before provider
   * work; it keeps only the provider checkpoint inherited from the owner. */
  async function failUnstartedFollowUp(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>) {
    const followUp = await admitFollowUp(prior);
    const error = await (async () => {
      await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
      try {
        return await followUp.start();
      } finally {
        await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
      }
    })();
    expect(error).toBe(stranded("owner_observed"));
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", error, finishedAt: new Date(),
      nativePhase: "observed", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
      .where(eq(heartbeatRuns.id, followUp.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_continuation_requires_reconciliation" })
      .where(eq(nativeRunFinalizations.runId, followUp.runId));
    await db.update(issues).set({ executionRunId: null, status: "blocked" }).where(eq(issues.id, prior.issueId));
    await recordMeasured(followUp.runId);
    return followUp.runId;
  }

  async function recordMeasured(runId: string) {
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId,
      seq: sql`(select coalesce(max(seq), 0) + 1 from heartbeat_run_events where run_id = ${runId})`,
      eventType: "lifecycle", stream: "system", message: "task.run.measured",
      payload: { phase: "task.run.measured", outcome: "failed", durableSettlement: true } });
  }

  it("retries from the committed owner after a follow-up failed before provider work", async () => {
    const prior = await seedRecoveredPriorRun();
    await failUnstartedFollowUp(prior);
    const retry = await admitFollowUp(prior);
    expect(await retry.start()).toBe(ADMITTED);
    expect(retry.selectedRunId).toBe(prior.runId);
    expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId]);
  }, 60_000);

  // Staging shape: a warm Codex owner committed under a controller that a
  // deploy then replaced. The next run got a newly created sandbox, so the
  // prior Runner (left `ready` in its own retained sandbox) can never be
  // adopted here. The follow-up failed with
  // `prior_owner_terminal_state_indeterminate` and the task stayed blocked.
  it.each(["created", "replacement"] as const)(
    "retires a finished warm owner left behind by a restart when this run's sandbox is %s", async outcome => {
      const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
      const followUp = await admitFollowUp(prior);
      expect(await followUp.start(outcome)).toBe(ADMITTED);
      expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId]);
      expect(await quarantined()).toEqual([]);
      expect(followUp.logs.join("")).toContain("finished without a saved runner checkpoint; starting a new runner");
      expect(followUp.remoteExecute).not.toHaveBeenCalled();
    }, 60_000);

  it("keeps a finished warm owner for live adoption when this run resumed its sandbox", async () => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
    const followUp = await admitFollowUp(prior);
    // A resumed sandbox still holds that Runner; its own recovery path reads it.
    expect(await followUp.start("resumed")).not.toBe(ADMITTED);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  // Marker-generation proof coverage lives in the shared P1/P2 gate suite.
  // Part 1 intentionally leaves resumed-sandbox rotation to the separate
  // adoption lane; a provider restart label alone never relaxes this fence.
  // REG-26 (I-8h run 90a2d958): the provider stopped the box under the idle
  // warm Runner. The resume alone proves nothing; here the box's generation
  // probe proves that Runner's process gone, so the owner is lost, not live:
  // admission keeps its journal in place for the backend's authority
  // rotation, which archives its unsuspended state and resumes the same
  // conversation (native-pi-rpc-restarted-sandbox.e2e).
  it("admits a settled warm owner of a resumed sandbox whose provider restarted it, leaving its journal for rotation", async () => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
    const followUp = await admitFollowUp(prior);
    await recordPriorLeaseOnSameSandbox(prior, followUp);
    expect(await followUp.start("resumed", undefined, true)).toBe(ADMITTED);
    expect(await archivedOwners(await sessionRoot())).toEqual([]);
    expect(await quarantined()).toEqual([]);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
    expect(followUp.logs.join("")).not.toContain("not retired");
    // Admission only read the box's Runner state and probed its process
    // generation; it changed nothing there.
    expect(followUp.remoteExecute.mock.calls.every(([request]) =>
      /base64 <|paperclip-runner-generation-(marker|check)/.test(JSON.stringify(request)))).toBe(true);
    expect(followUp.remoteExecute.mock.calls.some(([request]) => JSON.stringify(request).includes("paperclip-runner-generation-check"))).toBe(true);
  }, 60_000);

  it.each(["cancelled", "cancelled-code", "open recovery", "resolved without receipt", "settled recovery", "real failure", "failed run",
    "unknown failure", "unacknowledged Stop", "lease held", "recovery state", "live generation", "committed"] as const)(
    "REG-03 cancelled predecessor retirement: %s", async scenario => {
      const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
      const followUp = await admitFollowUp(prior);
      await keepLocalRootWithoutPointer(prior, followUp);
      followUp.logs.length = 0;
      await recordPriorLeaseOnSameSandbox(prior, followUp, scenario === "live generation" ? "live" : "lost");
      if (scenario !== "committed") {
        await db.update(heartbeatRuns).set({ status: scenario === "failed run" ? "failed" : "cancelled", resultJson: {
          cancelledByActorType: "user", cancelledByUserId: "board-user",
          nativeCancellation: { schema: "paperclip.native-cancellation.v1", companyId, issueId: prior.issueId,
            runId: prior.runId, scope: "run", reasonCode: "cancellation_run_only", dispatched: true,
            dispatchState: scenario === "unacknowledged Stop" ? "pending" : "acknowledged",
            intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() },
        } }).where(eq(heartbeatRuns.id, prior.runId));
        await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", resultId: null,
          failureCode: scenario === "unknown failure" ? "native_execution_indeterminate"
            : scenario === "real failure" ? "adapter_failed" : scenario === "cancelled-code" ? "cancelled" : "native_retry_cancelled",
          ...(scenario === "lease held" ? { leaseOwner: "active-controller", leaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
          ...(scenario === "recovery state" ? { recoveryState: "awaiting_evidence" } : {}),
        }).where(eq(nativeRunFinalizations.runId, prior.runId));
        await db.delete(nativeRunResults).where(eq(nativeRunResults.runId, prior.runId));
      }
      if (["open recovery", "resolved without receipt", "settled recovery"].includes(scenario)) {
        const actionId = randomUUID(), savedId = randomUUID();
        await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: prior.issueId,
          kind: "active_run_watchdog", cause: "native_execution_requires_reconciliation", fingerprint: actionId,
          nextAction: "Preserve the cancelled run's workspace", status: scenario === "open recovery" ? "active" : "resolved", evidence: {
            runId: prior.runId, automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", runId: prior.runId },
            systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, sourceRunId: prior.runId,
              state: "complete", preservationOperationIds: [savedId] },
            workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: prior.runId, status: "recovered" },
          } });
        if (scenario === "settled recovery") {
          await db.insert(workspaceOperations).values([
            { id: savedId, companyId, issueId: prior.issueId, heartbeatRunId: prior.runId, phase: "workspace_recovery_snapshot",
              status: "succeeded", metadata: { recoveryActionId: actionId } },
            { companyId, issueId: prior.issueId, heartbeatRunId: prior.runId, phase: "workspace_finalize", status: "succeeded",
              metadata: { owningService: "workspace_recovery", preservationOperationIds: [savedId] } },
          ]);
        }
      }
      const admitted = ["cancelled", "settled recovery", "committed"].includes(scenario);
      const outcome = await inspectFinishedPerTurnRunnerdOwner({ db, root: await sessionRoot(), identity: prior.identity,
        execution: prior.executionFor(followUp.runId), runnerExecutionTarget: { kind: "remote", transport: "sandbox",
          environmentId: followUp.environmentId, leaseId: followUp.leaseId, remoteCwd: "/workspace", runner: { execute: followUp.remoteExecute },
          sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: followUp.providerLeaseId, restarted: true } } as never });
      expect(outcome.finished).toBe(admitted);
      if (outcome.finished) expect(await outcome.recheck()).toBeNull();
      else expect(outcome.refused).toBe(scenario === "live generation" ? "restarted_sandbox_runner_generation_not_lost"
        : scenario === "lease held" ? "owner_lease_held" : scenario === "recovery state" ? "owner_recovery_awaiting_evidence"
        : ["open recovery", "resolved without receipt"].includes(scenario) ? "owner_recovery_action_pending" : "owner_terminal_failure");
      expect(followUp.remoteExecute.mock.calls.some(([request]) => JSON.stringify(request).includes("paperclip-runner-generation-check"))).toBe(true);
      expect(followUp.remoteExecute.mock.calls.every(([request]) =>
        /base64 <|paperclip-runner-generation-(marker|check)/.test(JSON.stringify(request)))).toBe(true);
    }, 60_000);

  // RFL F1: Boat may resume the same machine with its programs running. The
  // restarted label alone never retires an owner whose process is still live.
  it("keeps a settled warm owner held on a restarted sandbox while its process generation is still live", async () => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
    const followUp = await admitFollowUp(prior);
    await recordPriorLeaseOnSameSandbox(prior, followUp, "live");
    expectFreshSandboxFallback(await followUp.start("resumed", undefined, true), prior, followUp);
    expect(followUp.logs.join("")).toMatch(/restarted sandbox owner \S+ not retired: restarted_sandbox_runner_generation_not_lost/);
    // As for every refused prior owner, the controller root is kept aside, not rotated.
    expect(await quarantined()).toHaveLength(1);
    expect(followUp.remoteExecute.mock.calls.every(([request]) =>
      /base64 <|paperclip-runner-generation-(marker|check)/.test(JSON.stringify(request)))).toBe(true);
  }, 60_000);

  // The restart proves only that the process is gone. A journal with work
  // still owed (a pending command, an unanswered tool or its undelivered
  // answer) keeps the owner held.
  it.each(["pending-command", "unanswered-tool", "pending-tool-result"] as const)(
    "keeps the owner of a restarted sandbox held when its journal is unsettled (%s)", async control => {
      const prior = await seedRecoveredPriorRun(control, { provider: "codex", lifecycle: "warm" });
      const followUp = await admitFollowUp(prior);
      await recordPriorLeaseOnSameSandbox(prior, followUp);
      expectFreshSandboxFallback(await followUp.start("resumed", undefined, true), prior, followUp);
      expect(followUp.logs.join("")).toMatch(/restarted sandbox owner \S+ not retired: journal_/);
      // As for every refused prior owner, the controller root is kept aside, not rotated.
      expect(await quarantined()).toHaveLength(1);
    }, 60_000);

  it.each(["pending-command", "unanswered-tool"] as const)(
    "keeps a warm owner held when its journal is unsettled (%s), even on a new sandbox", async control => {
      const prior = await seedRecoveredPriorRun(control, { provider: "codex", lifecycle: "warm" });
      const followUp = await admitFollowUp(prior);
      expect(await followUp.start("created")).toMatch(/^runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; retirement_refused=journal_/);
      expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
    }, 60_000);

  it("keeps a warm owner held while its controller still holds the finalization lease", async () => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "codex", lifecycle: "warm" });
    await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, prior.runId));
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start("created")).not.toBe(ADMITTED);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  it.each(["empty", "inherited"] as const)("holds a Pi follow-up with launch intent but no affirmative launch-failure proof (%s process)", async processMode => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "pi_rpc", lifecycle: "warm" });
    const failed = await failUnstartedFollowUp(prior);
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed));
    const checkpoint = row.runnerProfileJson!.sessionCheckpoint as Record<string, unknown>;
    const processIdentity = processMode === "inherited" ? { processPid: 42_424, processGroupId: 42_424, processStartedAt: new Date(1_000) } : {};
    if (processMode === "inherited") await db.update(heartbeatRuns).set(processIdentity).where(eq(heartbeatRuns.id, prior.runId));
    await db.update(heartbeatRuns).set({ ...processIdentity, resultJson: {},
      error: "native_session_recovery_failed: NativeRunnerResumeStateUnavailableError: PRP provider resume state is unavailable",
      runnerProfileJson: { ...row.runnerProfileJson, inheritedProcessIdentityRunId: processMode === "inherited" ? prior.runId : undefined,
        sessionCheckpoint: { ...checkpoint, driverKind: "pi_rpc" } } }).where(eq(heartbeatRuns.id, failed));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, prior.runId));
    const sourceCheckpoint = { ...(source.runnerProfileJson!.sessionCheckpoint as Record<string, unknown>), driverKind: "pi_rpc" };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, sessionCheckpoint: sourceCheckpoint,
      nativeControllerRecovery: createNativeControllerRecovery(sourceCheckpoint as unknown as PersistedNativeSession,
        { configDigest: `sha256:${"b".repeat(64)}`, processConfigDigest: null },
        { runId: prior.runId, runnerInstanceId: prior.native.runnerInstanceId, normalizedSessionId: prior.native.normalizedSessionId }) } })
      .where(eq(heartbeatRuns.id, prior.runId));
    // A failed recovery may have claimed/released its controller, but never
    // opened a runner, emitted provider events, accepted a result or tool call.
    await db.update(nativeRunFinalizations).set({ controllerPid: 42_425 }).where(eq(nativeRunFinalizations.runId, failed));
    // Observed in the full-server RED: this intent is emitted before recovery
    // discovers that the replacement computer has no runner state.
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: failed, seq: 100,
      eventType: "native.process_start_requested", stream: "system", payload: {} });
    const retry = await admitFollowUp(prior);
    expect(retry.selectedRunId).toBe(failed);
    expect((await resolveNativeControllerRecovery(db, { companyId, agentId, issueId: prior.issueId,
      normalizedSessionId: prior.native.normalizedSessionId, currentRunId: retry.runId })).kind).not.toBe("recoverable");
    expect(await retry.start()).not.toBe(ADMITTED);
  }, 60_000);

  // Keep reason: F2 is a data-safety boundary. A live process plus lost spawn
  // telemetry must never be confused with a run that did not dispatch.
  it.each([
    { launchIntent: false, inheritedCheckpoint: true }, { launchIntent: true, inheritedCheckpoint: true },
    { launchIntent: false, inheritedCheckpoint: false }, { launchIntent: true, inheritedCheckpoint: false },
  ])("holds RFL's live-child lost-telemetry shape (%j)", async ({ launchIntent, inheritedCheckpoint }) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      const prior = await seedRecoveredPriorRun("settled", { provider: "pi_rpc", lifecycle: "warm" });
      const failed = await failUnstartedFollowUp(prior);
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed));
      await db.update(heartbeatRuns).set({ resultJson: {}, runnerProfileJson: { ...row.runnerProfileJson,
        sessionCheckpoint: inheritedCheckpoint ? { ...(row.runnerProfileJson!.sessionCheckpoint as object), driverKind: "pi_rpc" } : null } })
        .where(eq(heartbeatRuns.id, failed));
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, failed));
      await db.update(nativeRunFinalizations).set({ attempt: 1, controllerGeneration: 1, controllerPid: child.pid! })
        .where(eq(nativeRunFinalizations.runId, failed));
      if (launchIntent) await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: failed, seq: 100,
        eventType: "native.process_start_requested", stream: "system", payload: {} });
      expect((await admitFollowUp(prior, !inheritedCheckpoint)).selectedRunId).toBe(failed);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  }, 60_000);

  it.each([
    { scenario: "pre-claim", inheritedCheckpoint: true }, { scenario: "claimed", inheritedCheckpoint: true },
    { scenario: "launch-intent", inheritedCheckpoint: true }, { scenario: "pre-claim", inheritedCheckpoint: false },
    { scenario: "claimed", inheritedCheckpoint: false }, { scenario: "launch-intent", inheritedCheckpoint: false },
  ] as const)("requires affirmative pre-spawn proof (%j)", async ({ scenario, inheritedCheckpoint }) => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "pi_rpc", lifecycle: "warm" });
    const failed = await failUnstartedFollowUp(prior);
    if (!inheritedCheckpoint) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed));
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...row.runnerProfileJson, sessionCheckpoint: null } }).where(eq(heartbeatRuns.id, failed));
    }
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, failed));
    await db.update(nativeRunFinalizations).set({ attempt: scenario === "claimed" ? 1 : 0,
      controllerGeneration: scenario === "claimed" ? 1 : 0, controllerPid: null })
      .where(eq(nativeRunFinalizations.runId, failed));
    await recordMeasured(failed);
    if (scenario === "launch-intent") await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: failed, seq: 100,
      eventType: "native.process_start_requested", stream: "system", payload: {} });
    // A claim is not a start: both pre-claim and claimed, terminal-complete
    // rows now pass P2. Only launch evidence remains held.
    expect((await admitFollowUp(prior, !inheritedCheckpoint && scenario === "launch-intent")).selectedRunId)
      .toBe(scenario === "launch-intent" ? failed : prior.runId);
  }, 60_000);

  it.each(["own process", "recorded process", "provider event", "sourced event", "tool invocation", "controller checkpoint", "run result",
    "active turn", "pending request", "own cursor", "active goal", "provider work receipt", "live lease"] as const)(
    "keeps Pi's failed-recovery barrier with %s", async scenario => {
      const prior = await seedRecoveredPriorRun("settled", { provider: "pi_rpc", lifecycle: "warm" });
      const failed = await failUnstartedFollowUp(prior);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed));
      const checkpoint = { ...(run.runnerProfileJson!.sessionCheckpoint as Record<string, unknown>), driverKind: "pi_rpc" };
      const changes = scenario === "active turn" ? { activeTurnId: "uncertain-turn" }
        : scenario === "pending request" ? { pendingRuntimeRequests: [{ id: "uncertain-tool" }] }
        : scenario === "own cursor" ? { cursor: { sourceSeq: 1 } }
        : scenario === "active goal" ? { goal: { status: "active" } } : {};
      await db.update(heartbeatRuns).set({ resultJson: scenario === "provider work receipt"
        ? { executionRecovery: { providerWorkStarted: true } } : {},
        ...(scenario === "own process" ? { processPid: 42_424 } : {}),
        runnerProfileJson: { ...run.runnerProfileJson, sessionCheckpoint: { ...checkpoint, ...changes } } }).where(eq(heartbeatRuns.id, failed));
      if (scenario === "recorded process") await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: failed,
        seq: 100, stream: "system", payload: {}, eventType: "native.process_identity_recorded" });
      if (scenario === "provider event" || scenario === "sourced event") await db.insert(heartbeatRunEvents).values({
        companyId, agentId, runId: failed, seq: 100, stream: "system", payload: {},
        eventType: scenario === "provider event" ? "session.started" : "harness.diagnostic",
        ...(scenario === "sourced event" ? { sourceInstanceId: "another-runner", sourceEventId: "another:event:1", sourceSeq: 1 } : {}) });
      if (scenario === "tool invocation") await db.insert(toolInvocations).values({ companyId, agentId, runId: failed,
        toolName: "paperclip_get_issue", riskLevel: "read", status: "succeeded" } as never);
      if (scenario === "controller checkpoint") await db.insert(nativeRunnerCheckpoints).values({ companyId,
        issueId: prior.issueId, runId: failed, part: "header", material: {} });
      if (scenario === "run result") await db.insert(nativeRunResults).values({ companyId, issueId: prior.issueId,
        runId: failed, completionContractId: run.completionContractId!, serverFingerprint: randomUUID(), schemaStatus: "accepted",
        resultJson: {}, canonicalSha256: "b".repeat(64) });
      if (scenario === "live lease") await db.update(nativeRunFinalizations).set({ leaseOwner: "still-owned" })
        .where(eq(nativeRunFinalizations.runId, failed));
      expect((await admitFollowUp(prior)).selectedRunId).toBe(failed);
    }, 60_000);

  it("skips every unstarted follow-up after repeated failed retries", async () => {
    const prior = await seedRecoveredPriorRun();
    const failed = await failUnstartedFollowUp(prior);
    const retry = await admitFollowUp(prior);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date(),
      error: "native_controller_recovery_unsupported:metadata_format",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, retry.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, retry.runId));
    await recordMeasured(retry.runId);
    const next = await admitFollowUp(prior);
    expect([failed, retry.runId]).not.toContain(next.selectedRunId);
    expect(next.selectedRunId).toBe(prior.runId);
    expect(await next.start()).toBe(ADMITTED);
  }, 60_000);

  it.each(["process identity", "provider event", "controller checkpoint", "provider work receipt", "claimed coordinator",
    "run result", "different provider session", "own progress cursor"] as const)(
    "keeps a failed follow-up as the source with %s", async scenario => {
      const prior = await seedRecoveredPriorRun();
      const failed = await failUnstartedFollowUp(prior);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed));
      const checkpoint = run.runnerProfileJson!.sessionCheckpoint as Record<string, unknown>;
      if (scenario === "process identity") {
        await db.update(heartbeatRuns).set({ processPid: 4_242 }).where(eq(heartbeatRuns.id, failed));
      }
      if (scenario === "provider event") {
        await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: failed, seq: 100, eventType: "session.started",
          stream: "system", payload: {} });
      }
      if (scenario === "controller checkpoint") {
        await db.insert(nativeRunnerCheckpoints).values({ companyId, issueId: prior.issueId, runId: failed, part: "header", material: {} });
      }
      if (scenario === "provider work receipt") {
        await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } })
          .where(eq(heartbeatRuns.id, failed));
      }
      if (scenario === "claimed coordinator") {
        await db.update(nativeRunFinalizations).set({ controllerPid: 4_242 }).where(eq(nativeRunFinalizations.runId, failed));
      }
      if (scenario === "run result") {
        await db.insert(nativeRunResults).values({ companyId, issueId: prior.issueId, runId: failed,
          completionContractId: run.completionContractId!, serverFingerprint: "fixture", schemaStatus: "rejected",
          resultJson: {}, canonicalSha256: "fixture" });
      }
      if (scenario === "different provider session" || scenario === "own progress cursor") {
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, sessionCheckpoint: {
          ...checkpoint, ...(scenario === "own progress cursor" ? { cursor: { sourceSeq: 1 } } : { providerSessionId: "another-provider-session" }) } } })
          .where(eq(heartbeatRuns.id, failed));
      }
      const retry = await admitFollowUp(prior);
      expect(retry.selectedRunId).toBe(failed);
      expect(await retry.start()).toBe("native_controller_recovery_unsupported:metadata_format");
    }, 60_000);

  // Keep: SMA-122 restart regression; exercise the real encrypted DB checkpoint
  // and file-backed journal boundary, not a synthetic settlement predicate.
  it("stale-restore: never resurrects pending lifecycle from an older checkpoint over a settled same-owner journal", async () => {
    const prior = await seedRecoveredPriorRun("pending-command");
    const root = scopedRunnerdStateRoot(prior.executionFor(prior.runId));
    const binding = { companyId, issueId: prior.issueId, runId: prior.runId };
    const checkpoint = await loadNativeRunnerCheckpoint(db, binding);
    checkpoint!.restoreSessionDirectory(root);
    const path = join(root, "control-plane", "control-plane-state.json");
    const local = JSON.parse(await readFile(path, "utf8"));
    const drain = local.commands.at(-1);
    expect(drain.status).toBe("pending");
    Object.assign(drain, { status: "completed", result: { status: "completed" } });
    await writeFile(path, JSON.stringify(local));
    await restoreNativeRunnerCheckpoint(db, binding, root);
    const restored = JSON.parse(await readFile(path, "utf8"));
    expect(restored.commands.at(-1).controllerSeq).toBe(drain.controllerSeq);
    expect(restored.commands.at(-1).status).toBe("completed");
  }, 60_000);

  it("SMA-122 RED: continues an interrupted terminal warm owner after controller restart with drain/suspend pending", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true });
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(ADMITTED);
  }, 60_000);

  it("SMA-122 stamped command: fenced issuer settles without timestamp inference and keeps its immutable stamp", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true, stamped: true,
      lifecycleIssuedAt: new Date().toISOString() });
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(ADMITTED);
    const root = await sessionRoot();
    const [archive] = await readdir(join(root, "continuity-breaks"));
    const state = JSON.parse(await readFile(join(root, "continuity-breaks", archive!, "control-plane", "control-plane-state.json"), "utf8"));
    for (const command of state.commands.filter((value: { type: string }) => ["runner.drain", "runner.suspend"].includes(value.type))) {
      expect(command).toMatchObject({ status: "rejected", issuer: { bootId: prior.priorController.bootId, generation: 1 },
        abandonment: { disposition: "ABANDONED" } });
    }
    expect(followUp.logs.join("")).not.toContain("native_legacy_lifecycle_abandoned");
  }, 60_000);

  it("stamped command: a recorded graceful issuer stop settles without legacy timestamp inference", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true, stamped: true,
      lifecycleIssuedAt: new Date().toISOString() });
    await db.update(controllerInstances).set({ fencedAt: null, stoppedAt: new Date() })
      .where(eq(controllerInstances.bootId, prior.priorController.bootId));
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(ADMITTED);
    const checkpoint = await loadNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId });
    for (const type of ["runner.drain", "runner.suspend"]) {
      const command = [...checkpoint!.records.values()].map(bytes => JSON.parse(bytes)).find(value => value.type === type);
      expect(command).toMatchObject({ status: "rejected", issuer: { bootId: prior.priorController.bootId, generation: 1 },
        abandonment: { disposition: "ABANDONED" } });
    }
    expect(followUp.logs.join("")).not.toContain("native_legacy_lifecycle_abandoned");
  }, 60_000);

  it.each(["expired", "missing", "live"] as const)("stamped negative: an issuer with %s but no recorded close remains decisive", async state => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true, stamped: true });
    if (state === "missing") await db.delete(controllerInstances).where(eq(controllerInstances.bootId, prior.priorController.bootId));
    else await db.update(controllerInstances).set({ fencedAt: null, stoppedAt: null,
      leaseExpiresAt: new Date(Date.now() + (state === "live" ? 60_000 : -360_000)) })
      .where(eq(controllerInstances.bootId, prior.priorController.bootId));
    try {
      expect(await (await admitFollowUp(prior)).start()).toBe(stranded("journal_commands_unsettled(runner.drain.pending,runner.suspend.pending)"));
    } finally {
      await db.update(controllerInstances).set({ stoppedAt: new Date() }).where(eq(controllerInstances.bootId, prior.priorController.bootId));
    }
  }, 60_000);

  it.each(["delivered", "active_journal", "active_snapshot"] as const)(
    "gracefully stopped issuer still refuses a non-idle session: %s", async state => {
      const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true, stamped: true,
        ...(state === "delivered" ? { deliveryCount: 1 } : {}),
        ...(state === "active_journal" ? { activeAfterTerminal: true } : {}) });
      await db.update(controllerInstances).set({ fencedAt: null, stoppedAt: new Date() })
        .where(eq(controllerInstances.bootId, prior.priorController.bootId));
      const followUp = await admitFollowUp(prior);
      if (state === "active_snapshot") {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, prior.runId));
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson,
          sessionCheckpoint: { ...(run.runnerProfileJson!.sessionCheckpoint as object), activeTurnId: "still-active" } } })
          .where(eq(heartbeatRuns.id, prior.runId));
      }
      const root = scopedRunnerdStateRoot(prior.executionFor(prior.runId));
      const checkpoint = (await loadNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }))!;
      checkpoint.restoreSessionDirectory(root);
      const path = join(root, "control-plane", "control-plane-state.json"), bytes = await readFile(path, "utf8");
      expect(await planNativeLifecycleSettlement({ db, root, bytes, identity: prior.identity, companyId, agentId,
        issueId: prior.issueId, currentRunId: followUp.runId })).toBeNull();
      expect(await readFile(path, "utf8")).toBe(bytes);
      expect([...(await loadNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }))!.records])
        .toEqual([...checkpoint.records]);
    }, 60_000);

  async function lifecyclePlan(stamped: boolean) {
    const boot = await currentNativeControllerIdentity();
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true, stamped,
      lifecycleIssuedAt: new Date(boot.processStartedAt.getTime() - 6_000).toISOString() });
    const followUp = await admitFollowUp(prior);
    const root = scopedRunnerdStateRoot(prior.executionFor(prior.runId));
    const binding = { companyId, issueId: prior.issueId, runId: prior.runId };
    const checkpoint = (await loadNativeRunnerCheckpoint(db, binding))!;
    checkpoint.restoreSessionDirectory(root);
    const path = join(root, "control-plane", "control-plane-state.json");
    const bytes = await readFile(path, "utf8");
    const plan = await planNativeLifecycleSettlement({ db, root, bytes, identity: prior.identity, companyId, agentId,
      issueId: prior.issueId, currentRunId: followUp.runId });
    expect(plan).not.toBeNull();
    return { plan: plan!, prior, followUp, root, path, bytes, binding, checkpoint };
  }

  it.each([false, true])("settlement lock order: a bounded coordinator wait never stalls another boot's lease renewal (stamped=%s)", async stamped => {
    const fixture = await lifecyclePlan(stamped);
    const tag = `settlement-${randomUUID()}`;
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await lockSourceRecoveryCoordinators(tx, companyId, [fixture.prior.runId]);
      locked(); await gate;
    });
    await ready;
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(callback => transaction(async tx => {
      await tx.execute(sql`select set_config('application_name', ${tag}, true)`);
      await tx.execute(sql`set local statement_timeout = '3s'`);
      return callback(tx);
    }));
    const settlement = fixture.plan.commit().then(value => ({ value }), error => ({ error }));
    try {
      await waitForCondition("settlement waiting on coordinator", async () => {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where application_name = ${tag} and wait_event_type = 'Lock'`);
        return rows.length === 1;
      }, 2_000);
      await db.transaction(async tx => {
        await tx.execute(sql`set local statement_timeout = '500ms'`);
        await tx.update(controllerInstances).set({ renewedAt: new Date() })
          .where(eq(controllerInstances.bootId, (await currentNativeControllerIdentity()).bootId));
      });
      expect(await settlement).toMatchObject({ error: { message: "native_lifecycle_settlement_lock_timeout" } });
      expect(await readFile(fixture.path, "utf8")).toBe(fixture.bytes);
      expect([...(await loadNativeRunnerCheckpoint(db, fixture.binding))!.records]).toEqual([...fixture.checkpoint.records]);
    } finally { release(); await holder; await settlement; spy.mockRestore(); }
  }, 15_000);

  it("stamped-only settlement skips the controller table SHARE lock while a lease renewal is in flight", async () => {
    const fixture = await lifecyclePlan(true);
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.update(controllerInstances).set({ renewedAt: new Date() })
        .where(eq(controllerInstances.bootId, (await currentNativeControllerIdentity()).bootId));
      locked(); await gate;
    });
    await ready;
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(callback => transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '2s'`);
      return callback(tx);
    }));
    try { await expect(fixture.plan.commit()).resolves.toContain("ABANDONED"); }
    finally { release(); await holder; spy.mockRestore(); }
  }, 15_000);

  it("legacy settlement lock timeout refuses with a reason and leaves DB and local journal unchanged", async () => {
    const fixture = await lifecyclePlan(false);
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.update(controllerInstances).set({ renewedAt: new Date() })
        .where(eq(controllerInstances.bootId, (await currentNativeControllerIdentity()).bootId));
      locked(); await gate;
    });
    await ready;
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(callback => transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '3s'`);
      return callback(tx);
    }));
    try {
      expect(await inspectFinishedPerTurnRunnerdOwner({ db, root: fixture.root, identity: fixture.prior.identity,
        execution: fixture.prior.executionFor(fixture.followUp.runId), runnerExecutionTarget: {
          kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute: fixture.followUp.remoteExecute },
          sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: fixture.followUp.providerLeaseId },
        } as never })).toMatchObject({ finished: false, refused: "lifecycle_settlement_lock_timeout" });
      expect(await readFile(fixture.path, "utf8")).toBe(fixture.bytes);
      const after = (await loadNativeRunnerCheckpoint(db, fixture.binding))!;
      expect([...after.records]).toEqual([...fixture.checkpoint.records]);
    } finally { release(); await holder; spy.mockRestore(); }
    await expect(fixture.plan.commit()).resolves.toContain("ABANDONED");
  }, 15_000);

  it("SMA-122 B1 negative: a second unfenced controller keeps legacy lifecycle pending", async () => {
    const other = randomUUID();
    await db.insert(controllerInstances).values({ bootId: other, processSpace: "other-live-controller", pid: process.pid,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    try {
      const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true });
      const followUp = await admitFollowUp(prior);
      expect(await followUp.start()).toBe(stranded("journal_commands_unsettled(runner.drain.pending,runner.suspend.pending)"));
    } finally { await db.delete(controllerInstances).where(eq(controllerInstances.bootId, other)); }
  }, 60_000);

  // Keep: recorded production catch, stale boot 4f539509 (settlepred4).
  // Use the documented controller-instance fence rather than weakening B1:
  // an expired lease, even on this process space, is not a recorded close.
  it.each(["settlement-test-current", "another-host-space", "unknown"])(
    "B1 stale boot in %s stays refused until the existing mutating prover fences it", async processSpace => {
      const current = await currentNativeControllerIdentity();
      const [boot] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, current.bootId));
      const stale = randomUUID(), recent = randomUUID(), leaseId = randomUUID();
      const renewedAt = new Date(current.processStartedAt.getTime() - 2 * 86_400_000);
      await db.insert(controllerInstances).values([
        { bootId: stale, epoch: boot!.epoch - 1, processSpace, pid: 7,
          startedAt: new Date(renewedAt.getTime() - 3_000_000), renewedAt,
          leaseExpiresAt: new Date(renewedAt.getTime() + 90_000) },
        { bootId: recent, processSpace: "recent-stopped-boot", pid: 7,
          startedAt: new Date(current.processStartedAt.getTime() - 60_000),
          leaseExpiresAt: new Date(current.processStartedAt.getTime() - 1_000), stoppedAt: current.processStartedAt },
      ]);
      const [owned] = await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: null,
        status: "active", leasePolicy: "ephemeral", provider: "fake", providerLeaseId: `sandbox://fake/${leaseId}`,
        updatedAt: renewedAt, metadata: { leaseController: { bootId: stale, pid: 7, hostHash: processSpace,
          processStartedAt: new Date(renewedAt.getTime() - 3_000_000).toISOString() } } }).returning();
      // The real lease renewal installs this boot's epoch. No background worker
      // is needed: the test drives the production renewal explicitly.
      const coordinator = { register: () => ({ ready: Promise.resolve(), wake: () => {}, stop: async () => {} }) } as unknown as
        ReturnType<typeof createDeliveryWorkCoordinator>;
      let work: ReturnType<typeof registerControllerInstanceLeaseWork> | undefined;
      try {
        const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true });
        const followUp = await admitFollowUp(prior);
        const root = scopedRunnerdStateRoot(prior.executionFor(prior.runId));
        const binding = { companyId, issueId: prior.issueId, runId: prior.runId };
        const checkpoint = (await loadNativeRunnerCheckpoint(db, binding))!;
        checkpoint.restoreSessionDirectory(root);
        const path = join(root, "control-plane", "control-plane-state.json"), bytes = await readFile(path, "utf8");
        const plan = () => planNativeLifecycleSettlement({ db, root, bytes, identity: prior.identity, companyId, agentId,
          issueId: prior.issueId, currentRunId: followUp.runId });
        expect(await plan()).toBeNull();
        expect(await proveControllerInstance(db, stale, owned!.updatedAt, { readOnly: true })).toBe("expired");
        // An unbound proof cannot fence, even in a mutating pass.
        expect(await proveControllerInstance(db, stale, null)).toBe("expired");
        const [unfenced] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
        expect(unfenced).toMatchObject({ stoppedAt: null, fencedAt: null, fencedByEpoch: null });
        expect(await plan()).toBeNull();
        expect(await readFile(path, "utf8")).toBe(bytes);
        expect([...(await loadNativeRunnerCheckpoint(db, binding))!.records]).toEqual([...checkpoint.records]);
        // Without a registered serving lease B1 remains closed. The explicit
        // owned-record route remains supported alongside B1's ownerless route.
        work = registerControllerInstanceLeaseWork(db, coordinator);
        currentControllerProcessStamp();
        await tickControllerInstanceLease();
        expect(await proveControllerInstance(db, stale, owned!.updatedAt)).toBe("fenced");
        const [fenced] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
        expect(fenced).toMatchObject({ stoppedAt: null, fencedByEpoch: boot!.epoch });
        expect(fenced!.fencedAt).toBeInstanceOf(Date);
        expect(await plan()).not.toBeNull();
        expect(await followUp.start()).toBe(ADMITTED);
        expect(followUp.logs.join("")).toContain("native_legacy_lifecycle_abandoned count=2");
      } finally {
        await work?.stop();
        resetControllerInstanceLeaseForTests();
        await db.delete(environmentLeases).where(eq(environmentLeases.id, leaseId));
        await db.delete(controllerInstances).where(eq(controllerInstances.bootId, stale));
        await db.delete(controllerInstances).where(eq(controllerInstances.bootId, recent));
      }
    }, 60_000);

  // Keep: settlepred5 RFL's real recent-owned-write regression. This helper
  // and the two JUDGE regressions below are retained verbatim from the judge.
  async function judgeBoot(fixture: Awaited<ReturnType<typeof lifecyclePlan>>, shape: string) {
    const current = await currentNativeControllerIdentity();
    const [serving] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, current.bootId));
    const stale = randomUUID();
    if (shape === "equal") await db.execute(sql`drop index controller_instances_epoch_idx`);
    const epoch = shape === "newer" ? Math.max(...(await db.select().from(controllerInstances)).map(row => row.epoch)) + 1
      : shape === "equal" ? serving!.epoch : serving!.epoch - 1;
    await db.insert(controllerInstances).values({ bootId: stale, epoch, pid: 7, processSpace: "judge-foreign-process-space",
      startedAt: sql`now() - interval '3 days'`,
      renewedAt: shape === "write-grace" ? sql`now() - interval '95 seconds'` : sql`now() - interval '2 days'`,
      leaseExpiresAt: shape === "live" ? sql`now() + interval '1 minute'`
        : shape === "lease-grace" ? sql`now() - interval '5 seconds'` : sql`now() - interval '2 days'` });
    const coordinator = { register: () => ({ ready: Promise.resolve(), wake: () => {}, stop: async () => {} }) } as unknown as
      ReturnType<typeof createDeliveryWorkCoordinator>;
    const work = shape === "unregistered" ? null : registerControllerInstanceLeaseWork(db, coordinator);
    if (work) { currentControllerProcessStamp(); await tickControllerInstanceLease(); }
    const plan = () => planNativeLifecycleSettlement({ db, root: fixture.root, bytes: fixture.bytes,
      identity: fixture.prior.identity, companyId, agentId, issueId: fixture.prior.issueId, currentRunId: fixture.followUp.runId });
    return { stale, serving: serving!, coordinator, plan, cleanup: async () => {
      await work?.stop(); resetControllerInstanceLeaseForTests();
      await db.delete(controllerInstances).where(eq(controllerInstances.bootId, stale));
      if (shape === "equal") await db.execute(sql`create unique index controller_instances_epoch_idx on controller_instances (epoch)`);
    } };
  }

  it("JUDGE recent owned write after idle lapse must retain its documented grace", async () => {
    const fixture = await lifecyclePlan(false);
    const f = await judgeBoot(fixture, "expired");
    const leaseId = randomUUID();
    const [owned] = await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: null,
      status: "active", leasePolicy: "ephemeral", provider: "fake", providerLeaseId: `judge://${leaseId}`,
      updatedAt: sql`now()`, metadata: { leaseController: { bootId: f.stale, pid: 7,
        hostHash: "judge-foreign-process-space", processStartedAt: null } } }).returning();
    try {
      expect(await proveControllerInstance(db, f.stale, owned!.updatedAt)).toBe("grace");
      const plan = await f.plan();
      const [after] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale));
      console.log("JUDGE recent-owned-write evidence", JSON.stringify({
        ownedUpdatedAt: owned!.updatedAt, leaseRenewedAt: after!.renewedAt,
        leaseExpiresAt: after!.leaseExpiresAt, fencedAt: after!.fencedAt,
        settlementAdmitted: plan !== null,
      }));
      expect.soft(plan).toBeNull();
      expect.soft(after!.fencedAt).toBeNull();
      expect(await proveControllerInstance(db, f.stale, owned!.updatedAt)).toBe("grace");
    } finally { await db.delete(environmentLeases).where(eq(environmentLeases.id, leaseId)); await f.cleanup(); }
  }, 60_000);

  it.each([false, true])("JUDGE real second controller fence behavior (recent ownership=%s)", async recent => {
    const fixture = await lifecyclePlan(false);
    const child = spawn(process.execPath, ["--import", new URL("../../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url).pathname,
      new URL("./rfl-lease-child.ts", import.meta.url).pathname], {
      stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, RFL_TEST_DB: database.connectionString },
    });
    const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
    const message = () => new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("judge child message deadline")), 15_000);
      child.once("message", value => { clearTimeout(timer); resolve(value as Record<string, any>); });
    });
    const request = (payload: Record<string, unknown>) => { const next = message(); child.send(payload); return next; };
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.stdout!.resume();
    let stale: string | undefined;
    let work: ReturnType<typeof registerControllerInstanceLeaseWork> | undefined;
    const leaseId = randomUUID();
    try {
      const ready = await message(); expect(ready.kind).toBe("ready"); stale = ready.bootId as string;
      const current = await currentNativeControllerIdentity();
      const [serving] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, current.bootId));
      await db.insert(controllerInstances).values({ bootId: stale, epoch: serving!.epoch - 1, pid: ready.pid,
        processSpace: ready.processSpace, startedAt: sql`now() - interval '3 days'`,
        renewedAt: sql`now() - interval '2 days'`, leaseExpiresAt: sql`now() - interval '2 days'` });
      const coordinator = { register: () => ({ ready: Promise.resolve(), wake: () => {}, stop: async () => {} }) } as unknown as
        ReturnType<typeof createDeliveryWorkCoordinator>;
      work = registerControllerInstanceLeaseWork(db, coordinator); currentControllerProcessStamp(); await tickControllerInstanceLease();
      let ownedWrite: Date | null = null;
      if (recent) {
        const owned = await request({ action: "own", companyId, leaseId });
        expect(owned.kind).toBe("owned"); expect(owned.wakes).toBe(1); expect(owned.lost).toEqual([]);
        ownedWrite = new Date(owned.updatedAt);
        expect(await proveControllerInstance(db, stale, ownedWrite)).toBe("grace");
      }
      expect(child.exitCode).toBeNull();
      const plan = await planNativeLifecycleSettlement({ db, root: fixture.root, bytes: fixture.bytes,
        identity: fixture.prior.identity, companyId, agentId, issueId: fixture.prior.issueId, currentRunId: fixture.followUp.runId });
      const [after] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
      const renewed = await request({ action: "renew" }); expect(renewed.kind).toBe("renewed");
      const [afterRenew] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
      console.log("JUDGE second process evidence", JSON.stringify({ recent, pid: ready.pid, ownedWrite,
        fencedAt: after!.fencedAt, planReturned: plan !== null, laterRenewalLost: renewed.lost,
        rowUnchangedAfterRenewal: JSON.stringify(after) === JSON.stringify(afterRenew) }));
      if (recent) {
        expect.soft(plan).toBeNull(); expect.soft(after!.fencedAt).toBeNull();
        expect.soft(renewed.lost).toEqual([]);
        expect(await proveControllerInstance(db, stale, ownedWrite)).toBe("live");
      } else {
        expect(plan).not.toBeNull(); expect(after!.fencedAt).toBeInstanceOf(Date);
        expect(renewed.lost).toEqual(["fenced"]); expect(afterRenew).toEqual(after);
        await expect(plan!.commit()).resolves.toContain("ABANDONED");
      }
    } finally {
      if (child.connected) child.send({ action: "quit" });
      const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      const code = await exited; clearTimeout(kill);
      await work?.stop(); resetControllerInstanceLeaseForTests();
      await db.delete(environmentLeases).where(eq(environmentLeases.id, leaseId));
      if (stale) await db.delete(controllerInstances).where(eq(controllerInstances.bootId, stale));
      expect(code, stderr).toBe(0);
    }
  }, 60_000);

  // Keep: data-safety boundary. The spy schedules a REAL independent PG
  // transaction after the inventory proved empty, before the real prover's
  // UPDATE. No ownership query, proof, or write result is mocked.
  it.each(["insert", "update"])("B1 concurrent ownership %s committed before the fence UPDATE prevents fencing", async shape => {
    const fixture = await lifecyclePlan(false), f = await judgeBoot(fixture, "expired");
    const leaseId = randomUUID(), real = controllerLease.proveControllerInstance;
    const lease = { id: leaseId, companyId, heartbeatRunId: null, status: "active", leasePolicy: "ephemeral",
      provider: "fake", providerLeaseId: `b1-race://${leaseId}` };
    const metadata = { leaseController: { bootId: f.stale, pid: 7, hostHash: "judge-foreign-process-space", processStartedAt: null } };
    if (shape === "update") await db.insert(environmentLeases).values(lease);
    let committed = false, entered = 0;
    const prover = vi.spyOn(controllerLease, "proveControllerInstance").mockImplementation(async (...args) => {
      if (args[1] !== f.stale) return real(...args);
      entered++;
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '500ms'`);
        if (shape === "insert") await tx.insert(environmentLeases).values({ ...lease, metadata, updatedAt: sql`now()` });
        else await tx.update(environmentLeases).set({ metadata, updatedAt: sql`now()` }).where(eq(environmentLeases.id, leaseId));
      });
      committed = true;
      expect(args[3]?.ownedRecordRecheck).toBeDefined();
      const proof = await real(...args);
      expect(proof).toBe("expired");
      return proof;
    });
    try {
      expect(await f.plan()).toBeNull();
      expect(entered).toBe(1); expect(committed).toBe(true);
      const [after] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale));
      expect(after).toMatchObject({ fencedAt: null, fencedByEpoch: null });
      console.log("B1 UPDATE snapshot evidence", JSON.stringify({ shape, committed, inventoryPassed: entered === 1, fencedAt: after!.fencedAt }));
      expect(await readFile(fixture.path, "utf8")).toBe(fixture.bytes);
      expect([...(await loadNativeRunnerCheckpoint(db, fixture.binding))!.records]).toEqual([...fixture.checkpoint.records]);
    } finally {
      prover.mockRestore();
      await db.delete(environmentLeases).where(eq(environmentLeases.id, leaseId)); await f.cleanup();
    }
  }, 60_000);

  it.each(["teardown-process", "teardown-token", "shutdown-process", "shutdown-legacy", "sandbox", "agent",
    "workspace-runtime", "workspace-finalize", "workspace-command", "workspace-save", "legacy-run", "startup-token", "startup-holder",
    "executor", "restart", "awaiting-evidence", "finalizer", "cleanup", "accepted-local", "accepted-remote",
    "copyback", "observed-token", "observed-holder", "runtime-lease"])(
    "B1 atomic recheck matches the inventory for a concurrent %s owner", async shape => {
      const fixture = await lifecyclePlan(false), f = await judgeBoot(fixture, "expired");
      const id = randomUUID(), runId = randomUUID(), workspaceId = randomUUID(), resultId = randomUUID();
      const stamp = { bootId: f.stale, pid: 7, hostHash: "judge-foreign-process-space", processStartedAt: null };
      const real = controllerLease.proveControllerInstance;
      let entered = 0;
      const [prior] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.prior.runId));
      const cleanup = async () => {
        await db.update(agents).set({ lifecycleOperation: null }).where(eq(agents.id, agentId));
        await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, id));
        await db.delete(environmentLeases).where(eq(environmentLeases.id, id));
        await db.delete(workspaceOperations).where(eq(workspaceOperations.id, id));
        await db.delete(sandboxCreationOperations).where(eq(sandboxCreationOperations.id, id));
        await db.delete(executionWorkspaceRuntimeLeases).where(eq(executionWorkspaceRuntimeLeases.id, id));
        await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
        await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
        await db.delete(nativeRunResults).where(eq(nativeRunResults.id, resultId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      };
      const prover = vi.spyOn(controllerLease, "proveControllerInstance").mockImplementation(async (...args) => {
        if (args[1] !== f.stale) return real(...args);
        entered++;
        // This transaction commits after the fallback's empty inventory, not
        // before preflight. Every source below is real PostgreSQL storage.
        await db.transaction(async tx => {
          await tx.execute(sql`set local lock_timeout = '500ms'`);
          await tx.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: fixture.prior.issueId,
            status: "succeeded", completionContractId: prior!.completionContractId });
          const nrf = { companyId, issueId: fixture.prior.issueId, runId, phase: "committed" };
          if (["executor", "restart", "awaiting-evidence", "finalizer", "cleanup", "accepted-local", "accepted-remote"].includes(shape)) {
            const accepted = shape.startsWith("accepted-");
            if (accepted) await tx.insert(nativeRunResults).values({ id: resultId, companyId, issueId: fixture.prior.issueId,
              runId, completionContractId: prior!.completionContractId!, serverFingerprint: "b1-parity",
              schemaStatus: "accepted", resultJson: {}, canonicalSha256: "b1-parity" });
            if (shape === "accepted-remote") await tx.update(heartbeatRuns).set({ runnerProfileJson: { remoteWorkspace: {} } })
              .where(eq(heartbeatRuns.id, runId));
            const token = shape === "finalizer" ? `native-finalizer:${id}` : shape === "cleanup" ? `native-cleanup:${id}`
              : shape === "accepted-remote" ? f.stale : `executor:${id}`;
            await tx.insert(nativeRunFinalizations).values({ ...nrf, phase: shape === "cleanup" ? "committed" : "observed",
              controllerBootId: shape === "accepted-remote" ? "other-controller" : f.stale,
              leaseOwner: token, leaseExpiresAt: sql`now() + interval '1 minute'`,
              resultId: accepted ? resultId : null,
              recoveryState: shape === "restart" ? "resuming_session" : shape === "awaiting-evidence" ? "awaiting_evidence" : null,
              leaseHolder: ["finalizer", "cleanup"].includes(shape) ? { token, ...stamp } : null });
          } else if (shape.startsWith("teardown-") || shape.startsWith("shutdown-")) {
            await tx.insert(environmentLeases).values({ id, companyId, status: "pending_cleanup", leasePolicy: "ephemeral",
              metadata: shape.startsWith("teardown-") ? { pendingCleanupInFlight: true, pendingCleanupAttemptId: shape === "teardown-token" ? f.stale : id,
                ...(shape === "teardown-process" ? { pendingCleanupController: { ...stamp, attemptId: id } } : {}) }
                : { legacyShutdownWorkspaceSettlement: { state: "pending", ...(shape === "shutdown-process" ? { controller: stamp } : { controllerBootId: f.stale }) } } });
          } else if (shape === "sandbox") {
            await tx.insert(sandboxCreationOperations).values({ id, companyId, originalEnvironmentId: workspaceId, runId,
              provider: "fake", driverKey: "fake", config: {}, metadata: { creationController: stamp }, nextAttemptAt: new Date() });
          } else if (shape === "agent") {
            await tx.update(agents).set({ lifecycleOperation: { id, hostComplete: false, completedPluginIds: [], attempts: 1,
              leaseOwner: id, leaseHolder: stamp, leaseUntil: new Date(Date.now() + 60_000).toISOString() } }).where(eq(agents.id, agentId));
          } else if (shape.startsWith("workspace-")) {
            const phase = shape === "workspace-finalize" ? "workspace_finalize" : shape === "workspace-command" ? "worktree_prepare"
              : shape === "workspace-save" ? "remote_workspace_snapshot" : "runtime_control";
            const metadata = shape === "workspace-finalize" ? { finalizeOwner: stamp } : shape === "workspace-command" ? { commandOwner: stamp }
              : shape === "workspace-save" ? { saveWork: { activeIds: [id], owners: { [id]: stamp } } }
                : { runtimeControlOwner: { ownerId: id, ...stamp } };
            await tx.insert(workspaceOperations).values({ id, companyId, phase, status: "running", metadata });
          } else if (shape === "legacy-run") {
            await tx.update(heartbeatRuns).set({ status: "running", runtimeMode: "legacy", controllerBootId: f.stale,
              controllerLeaseExpiresAt: sql`now() + interval '1 minute'` }).where(eq(heartbeatRuns.id, runId));
          } else if (shape.startsWith("startup-")) {
            await tx.update(heartbeatRuns).set({ status: "running", runnerProfileJson: { nativeStartupContext: {
              leaseOwner: shape === "startup-token" ? f.stale : "old-holder" } } }).where(eq(heartbeatRuns.id, runId));
            if (shape === "startup-holder") await tx.insert(nativeRunFinalizations).values({ ...nrf, leaseOwner: f.stale });
          } else if (shape === "runtime-lease") {
            await tx.insert(executionWorkspaces).values({ id: workspaceId, companyId, mode: "isolated", strategyType: "test", name: "B1 parity" });
            await tx.insert(executionWorkspaceRuntimeLeases).values({ id, companyId, executionWorkspaceId: workspaceId,
              ownerKey: f.stale, lastAction: "test", expiresAt: new Date() });
          } else {
            if (shape === "observed-holder") await tx.insert(nativeRunFinalizations).values({ ...nrf, leaseOwner: f.stale });
            await tx.insert(issueRecoveryActions).values({ id, companyId, sourceIssueId: fixture.prior.issueId,
              kind: "b1-parity", cause: "b1-parity", fingerprint: id, nextAction: "wait",
              // Resolved observed fences are STILL in the inventory.
              resolvedAt: shape.startsWith("observed-") ? new Date() : null,
              evidence: shape === "copyback" ? { workspaceOwnerRecovery: { state: "operator_required",
                owner: { hostname: "old-host", pid: 7, processStartedAt: "old-start", controllerBootId: f.stale } } }
                : { observedWorkspacePreservation: { runId, state: "stop_pending", leaseOwner: shape === "observed-token" ? f.stale : "old-holder" } } });
          }
        });
        const owners: string[] = [];
        for (const kind of OWNABLE_KINDS) {
          if (!kind.listInProgress) continue;
          const listed = await kind.listInProgress(db, 2_000, 0);
          expect(listed.truncated).toBe(false);
          await resolveFenceHolders(db, listed.records);
          if (listed.records.some(({ owner }) => owner.kind === "process" ? owner.stamp.bootId === f.stale
            : owner.kind === "fence" && (owner.stamp.fenceToken === f.stale || owner.fence.currentFenceToken === f.stale))) owners.push(kind.id);
        }
        expect(owners.length, shape).toBeGreaterThan(0);
        const [check] = await db.execute(sql`select ${noControllerOwnedRecordsSql(f.stale)} as ownerless`);
        expect(check!.ownerless, owners.join(",")).toBe(false);
        const proof = await real(...args);
        expect(proof).toBe("expired");
        console.log("B1 registry parity evidence", JSON.stringify({ shape, owners, ownerless: check!.ownerless, proof }));
        return proof;
      });
      try {
        expect(await f.plan()).toBeNull(); expect(entered).toBe(1);
        expect((await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale)))[0]!.fencedAt).toBeNull();
      } finally {
        prover.mockRestore(); await cleanup(); await f.cleanup();
      }
    }, 60_000);

  it.each(["active-run-lease", "superseded-teardown", "lost-sandbox", "finished-operation", "inactive-save-stamp", "mixed-save-stamps",
    "expired-agent-lease", "terminal-coordinator", "superseded-token-holder", "malformed-stamp"])(
    "B1 atomic predicate does not mistake %s for a boot owner", async shape => {
      const fixture = await lifecyclePlan(false), f = await judgeBoot(fixture, "expired");
      const id = randomUUID(), runId = randomUUID();
      const stamp = { bootId: f.stale, pid: 7, hostHash: "judge-foreign-process-space", processStartedAt: null };
      try {
        await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: fixture.prior.issueId, status: "running" });
        if (shape === "active-run-lease" || shape === "superseded-teardown" || shape === "malformed-stamp") {
          await db.insert(environmentLeases).values({ id, companyId, status: shape === "superseded-teardown" ? "pending_cleanup" : "active",
            heartbeatRunId: shape === "active-run-lease" ? runId : null, leasePolicy: "ephemeral",
            metadata: shape === "superseded-teardown" ? { pendingCleanupInFlight: true, pendingCleanupAttemptId: "new-attempt",
              pendingCleanupController: { ...stamp, attemptId: "old-attempt" } }
              : { leaseController: { ...stamp, ...(shape === "malformed-stamp" ? { pid: "7" } : {}) } } });
        } else if (shape === "lost-sandbox") {
          await db.insert(sandboxCreationOperations).values({ id, companyId, originalEnvironmentId: randomUUID(), runId,
            provider: "fake", driverKey: "fake", config: {}, metadata: { creationController: stamp, creationControllerLost: true }, nextAttemptAt: new Date() });
        } else if (shape === "expired-agent-lease") {
          await db.update(agents).set({ lifecycleOperation: { id, hostComplete: false, completedPluginIds: [], attempts: 1,
            leaseOwner: id, leaseHolder: stamp, leaseUntil: new Date(Date.now() - 60_000).toISOString() } }).where(eq(agents.id, agentId));
        } else if (shape === "terminal-coordinator" || shape === "superseded-token-holder") {
          await db.insert(nativeRunFinalizations).values({ companyId, issueId: fixture.prior.issueId, runId,
            phase: shape === "terminal-coordinator" ? "committed" : "observed", controllerBootId: f.stale,
            leaseOwner: shape === "terminal-coordinator" ? null : `native-finalizer:${id}`,
            leaseExpiresAt: sql`now() + interval '1 minute'`, leaseHolder: { ...stamp, token: "superseded-token" } });
        } else {
          await db.insert(workspaceOperations).values({ id, companyId, phase: shape === "finished-operation" ? "workspace_finalize" : "remote_workspace_snapshot",
            status: shape === "finished-operation" ? "succeeded" : "running", metadata: shape === "finished-operation" ? { finalizeOwner: stamp }
              : { saveWork: { activeIds: shape === "inactive-save-stamp" ? [] : ["one", "two"],
                owners: { one: stamp, two: { ...stamp, pid: 8 } } } } });
        }
        for (const kind of OWNABLE_KINDS) {
          if (!kind.listInProgress) continue;
          const listed = await kind.listInProgress(db, 2_000, 0); expect(listed.truncated).toBe(false);
          await resolveFenceHolders(db, listed.records);
          expect(listed.records.some(({ owner }) => owner.kind === "process" ? owner.stamp.bootId === f.stale
            : owner.kind === "fence" && (owner.stamp.fenceToken === f.stale || owner.fence.currentFenceToken === f.stale)), kind.id).toBe(false);
        }
        const [check] = await db.execute(sql`select ${noControllerOwnedRecordsSql(f.stale)} as ownerless`);
        expect(check!.ownerless).toBe(true);
        expect(await f.plan()).not.toBeNull();
        expect((await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale)))[0]!.fencedAt).toBeInstanceOf(Date);
      } finally {
        await db.update(agents).set({ lifecycleOperation: null }).where(eq(agents.id, agentId));
        await db.delete(environmentLeases).where(eq(environmentLeases.id, id));
        await db.delete(workspaceOperations).where(eq(workspaceOperations.id, id));
        await db.delete(sandboxCreationOperations).where(eq(sandboxCreationOperations.id, id));
        await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId)); await f.cleanup();
      }
    }, 60_000);

  it.each([201, 2_001])("B1 fails closed on a later owned page or capped inventory (%s records)", async count => {
    const fixture = await lifecyclePlan(false), f = await judgeBoot(fixture, "expired");
    const prefix = `b1-inventory://${randomUUID()}/`;
    const rows = Array.from({ length: count }, (_, index) => ({ companyId, heartbeatRunId: null, status: "active",
      leasePolicy: "ephemeral", provider: "fake", providerLeaseId: `${prefix}${index}`,
      id: index === count - 1 ? "ffffffff-ffff-4fff-afff-ffffffffffff" : `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      metadata: index === count - 1 && count === 201 ? { leaseController: { bootId: f.stale, pid: 7,
        hostHash: "judge-foreign-process-space", processStartedAt: null } } : {} }));
    try {
      for (let index = 0; index < rows.length; index += 200) await db.insert(environmentLeases).values(rows.slice(index, index + 200));
      expect(await f.plan()).toBeNull();
      expect((await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale)))[0]!.fencedAt).toBeNull();
      await db.delete(environmentLeases).where(sql`${environmentLeases.providerLeaseId} like ${prefix + "%"}`);
      expect(await f.plan()).not.toBeNull();
    } finally {
      await db.delete(environmentLeases).where(sql`${environmentLeases.providerLeaseId} like ${prefix + "%"}`); await f.cleanup();
    }
  }, 60_000);

  it("B1 leaves even old owned boots to the documented record-driven path", async () => {
    const fixture = await lifecyclePlan(false), f = await judgeBoot(fixture, "expired");
    const leaseId = randomUUID();
    const [owned] = await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: null,
      status: "active", leasePolicy: "ephemeral", provider: "fake", providerLeaseId: `b1-old-owned://${leaseId}`,
      updatedAt: sql`now() - interval '2 days'`, metadata: { leaseController: { bootId: f.stale, pid: 7,
        hostHash: "judge-foreign-process-space", processStartedAt: null } } }).returning();
    try {
      expect(await f.plan()).toBeNull();
      expect((await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale)))[0]!.fencedAt).toBeNull();
      expect(await proveControllerInstance(db, f.stale, owned!.updatedAt)).toBe("fenced");
      const plan = await f.plan(); expect(plan).not.toBeNull();
      await expect(plan!.commit()).resolves.toContain("ABANDONED");
    } finally { await db.delete(environmentLeases).where(eq(environmentLeases.id, leaseId)); await f.cleanup(); }
  }, 60_000);

  it("B1 also refuses an inventory fence that names the boot without a process stamp", async () => {
    const fixture = await lifecyclePlan(false), f = await judgeBoot(fixture, "expired"), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy",
      controllerBootId: f.stale, controllerLeaseExpiresAt: sql`now() + interval '1 minute'`, controllerProcess: null });
    try {
      expect(await f.plan()).toBeNull();
      expect((await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale)))[0]!.fencedAt).toBeNull();
    } finally { await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId)); await f.cleanup(); }
  }, 60_000);

  it("B1 uses reconciliation's resolved coordinator holder as well as the stored fence token", async () => {
    const fixture = await lifecyclePlan(false), f = await judgeBoot(fixture, "expired"), runId = randomUUID(), actionId = randomUUID();
    try {
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: fixture.prior.issueId, status: "completed" });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId: fixture.prior.issueId, runId, phase: "committed",
        leaseOwner: f.stale, controllerGeneration: 7, leaseExpiresAt: sql`now() + interval '1 minute'` });
      await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: fixture.prior.issueId,
        kind: "b1-resolved-fence-test", cause: "b1-resolved-fence-test", fingerprint: actionId, nextAction: "wait",
        evidence: { observedWorkspacePreservation: { runId, state: "stop_pending", leaseOwner: "previous-holder", controllerGeneration: 6 } } });
      expect(await f.plan()).toBeNull();
      expect((await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale)))[0]!.fencedAt).toBeNull();
      // Neither the original token nor a process stamp names this boot. Only
      // resolveFenceHolders joins the current coordinator's holder into it.
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
      expect(await f.plan()).not.toBeNull();
    } finally {
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
      await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId)); await f.cleanup();
    }
  }, 60_000);

  it.each(["agents", "environment_leases", "execution_workspace_runtime_leases", "heartbeat_runs", "issue_recovery_actions",
    "native_run_finalizations", "sandbox_creation_operations", "workspace_operations"])("B1 unrelated writer on ownership source %s does not block fencing", async table => {
    const fixture = await lifecyclePlan(false), f = await judgeBoot(fixture, "expired");
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const writer = db.transaction(async tx => {
      // A real UPDATE takes ROW EXCLUSIVE even when no rows match. A B1
      // table SHARE lock would block here; the statement recheck must not.
      const key = table === "native_run_finalizations" ? "run_id" : "id";
      await tx.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(key)} = ${sql.identifier(key)} where false`);
      ready(); await gate;
    });
    await locked;
    try {
      expect(await f.plan()).not.toBeNull();
      expect((await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, f.stale)))[0]!.fencedAt).toBeInstanceOf(Date);
      expect(await readFile(fixture.path, "utf8")).toBe(fixture.bytes);
      expect([...(await loadNativeRunnerCheckpoint(db, fixture.binding))!.records]).toEqual([...fixture.checkpoint.records]);
    } finally { release(); await writer; await f.cleanup(); }
  }, 60_000);

  // Keep: ownerless production boot 4f539509; real PG/checkpoint safety boundary.
  it.each(["expired", "lease-grace", "write-grace", "live", "equal", "newer"] as const)(
    "B1 ownerless boot: %s uses only an older epoch past both grace windows", async shape => {
      const fixture = await lifecyclePlan(false);
      const current = await currentNativeControllerIdentity();
      const [boot] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, current.bootId));
      const stale = randomUUID(), old = new Date(Date.now() - 2 * 86_400_000);
      const renewedAt = shape === "write-grace" ? new Date(Date.now() - 95_000) : old;
      const leaseExpiresAt = shape === "live" ? new Date(Date.now() + 60_000)
        : shape === "lease-grace" ? new Date(Date.now() - 5_000) : new Date(old.getTime() + 90_000);
      // Equal epochs are excluded by the production unique index. Deliberately
      // model that defensive/corrupt-state case in this isolated real PG only.
      if (shape === "equal") await db.execute(sql`drop index controller_instances_epoch_idx`);
      const epoch = shape === "newer" ? Math.max(...(await db.select().from(controllerInstances)).map(row => row.epoch)) + 1
        : boot!.epoch + (shape === "equal" ? 0 : -1);
      await db.insert(controllerInstances).values({ bootId: stale, pid: 7, processSpace: "ownerless-production-shape",
        epoch,
        startedAt: new Date(old.getTime() - 3_000_000), renewedAt, leaseExpiresAt });
      const coordinator = { register: () => ({ ready: Promise.resolve(), wake: () => {}, stop: async () => {} }) } as unknown as
        ReturnType<typeof createDeliveryWorkCoordinator>;
      const work = registerControllerInstanceLeaseWork(db, coordinator);
      const fenceLog = vi.spyOn(logger, "info");
      try {
        currentControllerProcessStamp(); await tickControllerInstanceLease();
        const [servingBefore] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, current.bootId));
        const plan = await planNativeLifecycleSettlement({ db, root: fixture.root, bytes: fixture.bytes,
          identity: fixture.prior.identity, companyId, agentId, issueId: fixture.prior.issueId, currentRunId: fixture.followUp.runId });
        const [after] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
        const [servingAfter] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, current.bootId));
        expect(servingAfter).toEqual(servingBefore);
        if (shape === "expired") {
          expect(plan).not.toBeNull();
          expect(after).toMatchObject({ fencedByEpoch: boot!.epoch, stoppedAt: null, renewedAt });
          expect(after!.fencedAt).toBeInstanceOf(Date);
          expect(fenceLog).toHaveBeenCalledWith(expect.objectContaining({ bootId: stale, epoch: boot!.epoch - 1,
            lastRenewedAt: renewedAt, fencingEpoch: boot!.epoch }), "controller instance fenced");
          expect(await fixture.followUp.start()).toBe(ADMITTED);
          expect(fixture.followUp.logs.join("")).toContain("native_legacy_lifecycle_abandoned count=2");
          // The late old boot uses the REAL renewal, not a hand-written SQL imitation.
          await work.stop(); resetControllerInstanceLeaseForTests();
          const identity = vi.spyOn(controllerProcessIdentity, "currentControllerBootId").mockReturnValue(stale);
          const onLost = vi.fn();
          const late = registerControllerInstanceLeaseWork(db, coordinator, { onLost });
          try {
            currentControllerProcessStamp(); await tickControllerInstanceLease();
            expect(onLost).toHaveBeenCalledExactlyOnceWith("fenced");
            const [held] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
            expect(held).toEqual(after);
          } finally { await late.stop(); identity.mockRestore(); }
        } else {
          expect(plan).toBeNull();
          expect(after).toMatchObject({ fencedAt: null, fencedByEpoch: null, stoppedAt: null, renewedAt, leaseExpiresAt });
          expect(await readFile(fixture.path, "utf8")).toBe(fixture.bytes);
          expect([...(await loadNativeRunnerCheckpoint(db, fixture.binding))!.records]).toEqual([...fixture.checkpoint.records]);
        }
      } finally {
        await work.stop(); resetControllerInstanceLeaseForTests(); fenceLog.mockRestore();
        await db.delete(controllerInstances).where(eq(controllerInstances.bootId, stale));
        if (shape === "equal") await db.execute(sql`create unique index controller_instances_epoch_idx on controller_instances (epoch)`);
      }
    }, 60_000);

  it("B1 ownerless fence is idempotent across two racing settlements and never upgrades a SHARE lock", async () => {
    const fixtures = [await lifecyclePlan(false), await lifecyclePlan(false)];
    const current = await currentNativeControllerIdentity();
    const [boot] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, current.bootId));
    const stale = randomUUID(), old = new Date(Date.now() - 2 * 86_400_000);
    await db.insert(controllerInstances).values({ bootId: stale, epoch: boot!.epoch - 1, pid: 7,
      processSpace: "ownerless-racing", startedAt: old, renewedAt: old, leaseExpiresAt: old });
    const coordinator = { register: () => ({ ready: Promise.resolve(), wake: () => {}, stop: async () => {} }) } as unknown as
      ReturnType<typeof createDeliveryWorkCoordinator>;
    const work = registerControllerInstanceLeaseWork(db, coordinator);
    const fenceLog = vi.spyOn(logger, "info");
    const realProver = controllerLease.proveControllerInstance;
    let release!: () => void, entrants = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const verdicts: unknown[] = [];
    // Scheduling barrier only: both planners must enter the real mutating
    // prover before either can fence. No proof or database result is mocked.
    const prover = vi.spyOn(controllerLease, "proveControllerInstance").mockImplementation(async (...args) => {
      if (args[1] !== stale || args[3]?.readOnly) return realProver(...args);
      if (++entrants === 2) release();
      await gate;
      const verdict = await realProver(...args);
      verdicts.push(verdict);
      return verdict;
    });
    try {
      currentControllerProcessStamp(); await tickControllerInstanceLease();
      const plans = await Promise.all(fixtures.map(fixture => planNativeLifecycleSettlement({ db,
        root: fixture.root, bytes: fixture.bytes, identity: fixture.prior.identity, companyId, agentId,
        issueId: fixture.prior.issueId, currentRunId: fixture.followUp.runId })));
      expect(plans.every(Boolean)).toBe(true);
      expect(verdicts).toEqual(["fenced", "fenced"]);
      const [fenced] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
      expect(fenced).toMatchObject({ fencedByEpoch: boot!.epoch });
      expect(fenced!.fencedAt).toBeInstanceOf(Date);
      expect(fenceLog.mock.calls.filter(([fields, message]) => message === "controller instance fenced"
        && (fields as { bootId?: string }).bootId === stale)).toHaveLength(1);
      expect(await Promise.all(plans.map(plan => plan!.commit()))).toEqual([
        expect.stringContaining("ABANDONED"), expect.stringContaining("ABANDONED")]);
      expect(await realProver(db, stale, old)).toBe("fenced");
      const [after] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
      expect(after).toEqual(fenced);
    } finally {
      release(); prover.mockRestore();
      await work.stop(); resetControllerInstanceLeaseForTests(); fenceLog.mockRestore();
      await db.delete(controllerInstances).where(eq(controllerInstances.bootId, stale));
    }
  }, 60_000);

  it("B1 transaction recheck refuses a newly arrived stale boot without mutating under SHARE", async () => {
    const fixture = await lifecyclePlan(false);
    const current = await currentNativeControllerIdentity();
    const [boot] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, current.bootId));
    const stale = randomUUID(), old = new Date(Date.now() - 2 * 86_400_000);
    await db.insert(controllerInstances).values({ bootId: stale, epoch: boot!.epoch - 1, pid: 7,
      processSpace: "arrived-after-plan", startedAt: old, renewedAt: old, leaseExpiresAt: old });
    const coordinator = { register: () => ({ ready: Promise.resolve(), wake: () => {}, stop: async () => {} }) } as unknown as
      ReturnType<typeof createDeliveryWorkCoordinator>;
    const work = registerControllerInstanceLeaseWork(db, coordinator);
    try {
      currentControllerProcessStamp(); await tickControllerInstanceLease();
      await expect(fixture.plan.commit()).rejects.toThrow("native_lifecycle_settlement_proof_changed");
      const [after] = await db.select().from(controllerInstances).where(eq(controllerInstances.bootId, stale));
      expect(after).toMatchObject({ fencedAt: null, fencedByEpoch: null, stoppedAt: null });
      expect(await readFile(fixture.path, "utf8")).toBe(fixture.bytes);
      expect([...(await loadNativeRunnerCheckpoint(db, fixture.binding))!.records]).toEqual([...fixture.checkpoint.records]);
      const fresh = await planNativeLifecycleSettlement({ db, root: fixture.root, bytes: fixture.bytes,
        identity: fixture.prior.identity, companyId, agentId, issueId: fixture.prior.issueId, currentRunId: fixture.followUp.runId });
      expect(fresh).not.toBeNull();
      await expect(fresh!.commit()).resolves.toContain("ABANDONED");
    } finally {
      await work.stop(); resetControllerInstanceLeaseForTests();
      await db.delete(controllerInstances).where(eq(controllerInstances.bootId, stale));
    }
  }, 60_000);

  it.each([{ offset: -1, admitted: true }, { offset: 0, admitted: false }, { offset: 1, admitted: false }])(
    "SMA-122 B2 strict skew boundary offset=$offset", async ({ offset, admitted }) => {
      const boot = await currentNativeControllerIdentity();
      const issuedAt = new Date(boot.processStartedAt.getTime() - 5_000 + offset).toISOString();
      const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true, lifecycleIssuedAt: issuedAt });
      const followUp = await admitFollowUp(prior);
      expect(await followUp.start()).toBe(admitted ? ADMITTED : stranded("journal_commands_unsettled(runner.drain.pending,runner.suspend.pending)"));
      expect(followUp.logs.join("").includes("native_legacy_lifecycle_abandoned count=2")).toBe(admitted);
    }, 60_000);

  it("SMA-122 B3 negative: another in-flight session run keeps legacy lifecycle pending", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true });
    const followUp = await admitFollowUp(prior);
    const [active] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: prior.issueId, nativeSessionId: prior.native.normalizedSessionId }).returning();
    try {
      const root = scopedRunnerdStateRoot(prior.executionFor(prior.runId));
      (await loadNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }))!.restoreSessionDirectory(root);
      const proof = await inspectFinishedPerTurnRunnerdOwner({ db, root, identity: prior.identity, execution: prior.executionFor(followUp.runId),
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute: followUp.remoteExecute },
          sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: followUp.providerLeaseId } } as never });
      expect(proof).toMatchObject({ finished: false, refused: "journal_commands_unsettled(runner.drain.pending,runner.suspend.pending)" });
      expect(await followUp.start()).toBe("native_controller_recovery_missing_evidence:newer_progress_barrier");
    } finally { await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, active!.id)); }
  }, 60_000);

  it("SMA-122 B3 negative: the current startup reservation cannot hide already-dispatched provider work", async () => {
    const prior = await seedRecoveredPriorRun("settled", { provider: "opencode", lifecycle: "warm", interruptedLifecycle: true });
    const followUp = await admitFollowUp(prior);
    const root = scopedRunnerdStateRoot(prior.executionFor(followUp.runId));
    await restoreNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }, root);
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: followUp.runId, seq: 100,
      eventType: "turn.started", stream: "system", level: "info", message: "current turn already dispatched", payload: {} });
    expect(await inspectFinishedPerTurnRunnerdOwner({ db, root, identity: prior.identity, execution: prior.executionFor(followUp.runId),
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute: followUp.remoteExecute },
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: followUp.providerLeaseId } } as never,
    })).toMatchObject({ finished: false, refused: "journal_commands_unsettled(runner.drain.pending,runner.suspend.pending)" });
  }, 60_000);

  it("SMA-122 B4 negative: never abandons a stale drain already released to runnerd", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true, deliveryCount: 1 });
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(stranded("journal_commands_unsettled(runner.drain.pending,runner.suspend.pending)"));
  }, 60_000);

  it("SMA-122 B4: durably abandons old drain/suspend before admitting and never requeues them after checkpoint restore", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true });
    const followUp = await admitFollowUp(prior);
    const root = scopedRunnerdStateRoot(prior.executionFor(prior.runId));
    (await loadNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }))!.restoreSessionDirectory(root);
    const proof = await inspectFinishedPerTurnRunnerdOwner({ db, root, identity: prior.identity, execution: prior.executionFor(followUp.runId),
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute: followUp.remoteExecute },
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: followUp.providerLeaseId } } as never });
    expect(proof.finished).toBe(true);
    const checkpoint = (await loadNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }))!;
    const restoredRoot = await mkdtemp(join(tmpdir(), "abandoned-drain-replay-"));
    try {
      checkpoint.restoreSessionDirectory(restoredRoot);
      const core = new DurablePrpControlPlane({ stateDirectory: join(restoredRoot, "control-plane"), identity: prior.identity,
        expectedRunnerVersion: checkpoint.runnerVersion, expectedRunnerDigest: checkpoint.runnerDigest });
      try {
        const abandoned = core.store.state.commands.filter(command => ["runner.drain", "runner.suspend"].includes(command.type));
        expect(abandoned).toHaveLength(2);
        for (const command of abandoned) {
          expect(command).toMatchObject({ status: "rejected", abandonment: { disposition: "ABANDONED" } });
          expect(core.queueCommand(command.type, command.payload, command.commandId).status).toBe("rejected");
        }
        const turn = core.queueCommand("turn.start", { text: "new work after abandonment" });
        expect(core.store.state.commands.filter(command => command.status === "pending").map(command => command.commandId)).toEqual([turn.commandId]);
      } finally { await core.stop(); }
      expect(await followUp.start()).toBe(ADMITTED);
    } finally { await rm(restoredRoot, { recursive: true, force: true }); }
  }, 60_000);

  it("SMA-145 control: continues a plain terminal warm owner after controller restart", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm" });
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(ADMITTED);
  }, 60_000);

  it("SMA-122 negative: a pending delivery remains decisive after controller restart", async () => {
    const prior = await seedRecoveredPriorRun("pending-attach", { lifecycle: "warm" });
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(stranded("journal_commands_unsettled(run.attach.pending)"));
  }, 60_000);

  it("SMA-122 negative: an active journal turn remains decisive after controller restart", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", activeAfterTerminal: true });
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(stranded("journal_terminal_unsettled"));
  }, 60_000);

  it("SMA-122 negative: same controller boot keeps pending lifecycle commands decisive", async () => {
    const prior = await seedRecoveredPriorRun("settled", { lifecycle: "warm", interruptedLifecycle: true,
      controller: await currentNativeControllerIdentity() });
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(stranded("journal_commands_unsettled(runner.drain.pending,runner.suspend.pending)"));
  }, 60_000);

  it.each([
    { control: "failed-turn-start", outcome: ADMITTED },
    { control: "rejected-turn-start", outcome: ADMITTED },
    { control: "indeterminate-turn-start", outcome: ADMITTED },
    { control: "unknown-outcome-turn-start", outcome: ADMITTED },
    { control: "unsuperseded-unknown-outcome-turn-start", outcome: stranded("journal_commands_unsettled(turn.start.failed)") },
    { control: "failed-suspend", outcome: stranded("journal_commands_unsettled(runner.suspend.failed)") },
  ] as const)("retires a finished owner whose journal holds an answered $control command", async ({ control, outcome }) => {
    const prior = await seedRecoveredPriorRun(control);
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(outcome);
  }, 60_000);

  it("starts a follow-up whose own bootstrap never reached its root from the previous owner's settled root", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    expect(await followUp.start("created", { kind: "bootstrap_incomplete", runId: followUp.runId, leaseOwner: "successor",
      controllerGeneration: 2, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null } as never)).toBe(ADMITTED);
    expect(await quarantined()).toEqual([]);
    expect(await archivedOwners(root)).toEqual([prior.runId]);
  }, 60_000);

  it.each([
    { label: "ended on another sandbox", status: "expired", sameSandbox: false, recorded: true, outcome: ADMITTED },
    { label: "released on another sandbox", status: "released", sameSandbox: false, recorded: true, outcome: ADMITTED },
    { label: "still retained", status: "retained", sameSandbox: false, recorded: true,
      outcome: stranded("journal_commands_unsettled(runner.suspend.pending)") },
    { label: "ended on this sandbox", status: "expired", sameSandbox: true, recorded: true,
      outcome: stranded("journal_commands_unsettled(runner.suspend.pending)") },
    { label: "not recorded", status: "expired", sameSandbox: false, recorded: false,
      outcome: stranded("journal_commands_unsettled(runner.suspend.pending)") },
  ])("retires a finished remote owner whose suspend never finished when its sandbox lease is $label", async ({ status, sameSandbox, recorded, outcome }) => {
    const prior = await seedRecoveredPriorRun("pending-command");
    const followUp = await admitFollowUp(prior);
    if (recorded) {
      await db.insert(environments).values({ id: followUp.environmentId, name: `ended-${followUp.environmentId}`, driver: "sandbox" });
      await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId, issueId: prior.issueId,
        heartbeatRunId: prior.runId, provider: "daytona", providerLeaseId: sameSandbox ? followUp.providerLeaseId : `sandbox-${prior.runId}`,
        status, releasedAt: status === "retained" ? null : new Date(), metadata: { remoteCwd: "/workspace" } });
    }
    expect(await followUp.start()).toBe(outcome);
  }, 60_000);

  it("retires the exact parked question after the standing same-box exit-45 generation-loss proof", async () => {
    const prior = await seedRecoveredPriorRun("unanswered-tool", { provider: "opencode", lifecycle: "warm", governedWait: true });
    const followUp = await admitFollowUp(prior);
    await recordPriorLeaseOnSameSandbox(prior, followUp);
    expect(await followUp.start("resumed")).toBe(ADMITTED);
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, prior.governedInteraction!.id));
    expect(card.status).toBe("pending");
    expect(followUp.remoteExecute.mock.calls.some(([request]) => JSON.stringify(request).includes("paperclip-runner-generation-check"))).toBe(true);
  }, 60_000);

  it.each(["live", "timeout", "throws"] as const)("a parked question never treats a %s generation probe as gone", async mode => {
    const prior = await seedRecoveredPriorRun("unanswered-tool", { provider: "opencode", lifecycle: "warm", governedWait: true });
    const followUp = await admitFollowUp(prior);
    await recordPriorLeaseOnSameSandbox(prior, followUp, "live");
    const execute = followUp.remoteExecute.getMockImplementation()!;
    followUp.remoteExecute.mockImplementation(async request => {
      if (JSON.stringify(request).includes("paperclip-runner-generation-check")) {
        if (mode === "throws") throw new Error("no answer from box");
        return { exitCode: mode === "timeout" ? 45 : 0, timedOut: mode === "timeout", stdout: "", stderr: "" };
      }
      return execute(request);
    });
    const root = scopedRunnerdStateRoot(prior.executionFor(followUp.runId));
    await restoreNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }, root);
    expect(await inspectFinishedPerTurnRunnerdOwner({ db, root, identity: prior.identity, execution: prior.executionFor(followUp.runId),
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute: followUp.remoteExecute },
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: followUp.providerLeaseId } } as never,
    })).toMatchObject({ finished: false, generationLost: false, refused: "restarted_sandbox_runner_generation_not_lost" });
  }, 60_000);

  it.each(["pending-tool-result", "pending-attach"] as const)("a parked input never settles a %s on the same box", async control => {
    const prior = await seedRecoveredPriorRun(control, { provider: "opencode", lifecycle: "warm", governedWait: true });
    const followUp = await admitFollowUp(prior);
    await recordPriorLeaseOnSameSandbox(prior, followUp);
    const root = scopedRunnerdStateRoot(prior.executionFor(followUp.runId));
    await restoreNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }, root);
    expect(await inspectFinishedPerTurnRunnerdOwner({ db, root, identity: prior.identity, execution: prior.executionFor(followUp.runId),
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute: followUp.remoteExecute },
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: followUp.providerLeaseId } } as never,
    })).toMatchObject({ finished: false, generationLost: true,
      refused: `journal_commands_unsettled(${control === "pending-tool-result" ? "semantic_tool.result" : "run.attach"}.pending)` });
  }, 60_000);

  it.each([
    { restarted: true, inputKind: "card" }, { restarted: false, inputKind: "card" },
    { restarted: true, inputKind: "message" }, { restarted: false, inputKind: "message" },
    { restarted: false, inputKind: "plain-control" },
    { restarted: true, inputKind: "connection-message" },
  ] as const)("the person's $inputKind survives and the controlled next-generation agent acts (restart=$restarted)", async ({ restarted, inputKind }) => {
    const prior = await seedRecoveredPriorRun(inputKind === "plain-control" ? "settled" : "unanswered-tool",
      { provider: "opencode", lifecycle: "warm", governedWait: inputKind !== "plain-control", connectionWait: inputKind === "connection-message" });
    const followUp = await admitFollowUp(prior);
    if (restarted) {
      await recordPriorLeaseOnSameSandbox(prior, followUp);
      expect(await followUp.start("resumed")).toBe(ADMITTED);
    }
    const card = prior.governedInteraction;
    const [currentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, followUp.runId));
    if (inputKind === "card") {
      await issueThreadInteractionService(db).answerQuestions({ id: prior.issueId, companyId, status: "in_progress" }, card!.id,
        { answers: [{ questionId: "color", optionIds: ["green"] }] }, { userId: "board-person" });
      const wakeup = vi.fn(async (_agentId: string, _options: unknown) => currentRun);
      await questionResponseDeliveryService(db, { heartbeat: { wakeup, cancelRun: async () => null } as never }).deliver(card!.id);
      expect(wakeup).toHaveBeenCalledOnce();
      expect(wakeup.mock.calls[0]![1]).toMatchObject({ payload: { interactionId: card!.id, interactionStatus: "answered" } });
    } else {
      await db.insert(issueComments).values({ companyId, issueId: prior.issueId, authorUserId: "board-person", body: "Please paint blue." });
    }
    const responses = await materializeNativeInteractionResponses({ db, companyId, agentId, issueId: prior.issueId,
      runId: followUp.runId, interactionIds: inputKind === "card" ? [card!.id] : [] });
    expect(responses).toHaveLength(inputKind === "card" ? 1 : 0);
    const execution = { ...prior.executionFor(followUp.runId), interactionResponses: responses };
    execution.session.lifecyclePolicy = { mode: "per_turn", idleTimeoutMs: null };
    // Real production delivery/materialization/runtime; only the provider is a
    // controlled test agent. The action artifact must be derived from the
    // submitted answer, not from a mocked admission or an expected call count.
    const action = join(stateDirectory, `agent-action-${restarted}-${inputKind}.txt`);
    const color = inputKind === "card" ? "green" : "blue";
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const identity = { companyId, agentId, issueId: prior.issueId, runId: followUp.runId, sessionId: prior.native.normalizedSessionId };
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const result = { schema: "paperclip.run_result.v1" as const, reportedWorkDisposition: "done" as const,
      summary: `Painted ${color} from the person's ${inputKind}.`, completionClaim: {
        contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
        criteria: execution.completionContract.contract.criteria.map(criterion => ({ criterionId: criterion.id, status: "satisfied" as const, evidenceRefs: [action] })), remainingWork: [] },
      evidence: [{ ref: action }], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1" as const, turnTerminalState: "completed" as const,
      runTerminalState: "succeeded" as const, reportedWorkDisposition: "done" as const };
    const session: NativeSession = { identity: () => identity, capabilities: async () => capabilities,
      startTurn: async request => {
        const submitted = JSON.parse(request.message.text);
        if (inputKind === "card") {
          const response = submitted.interactionResponses?.find((value: { interactionId: string }) => value.interactionId === card!.id);
          expect(JSON.stringify(response)).toContain("green");
          await writeFile(action, `paint:${response.response.result.answers[0].optionIds[0]}`);
        } else {
          const { PaperclipRunnerToolAuthority: RealToolAuthority } = await vi.importActual<typeof import("./paperclip-runner-tool-authority.js")>("./paperclip-runner-tool-authority.js");
          const authority = new RealToolAuthority(db, { ...identity, normalizedSessionId: identity.sessionId });
          try {
            const history = await authority.execute({ tool: "get_task_history", callId: "read-person-message", arguments: { limit: 10 } }) as { comments: { body: string }[] };
            const message = history.comments.at(-1)!.body;
            expect(message).toBe("Please paint blue.");
            await writeFile(action, `paint:${/paint (\w+)/.exec(message)![1]}`);
          } finally { authority.close(); }
        }
        began(); return { turnId: "answered-turn" };
      },
      async *events() { await started; yield { schema: "paperclip.prp.event.v1", sourceInstanceId: followUp.native.runnerInstanceId,
        sourceEventId: "answer-agent:1", sourceSeq: 1, sourceKind: "runner", runId: followUp.runId,
        normalizedSessionId: prior.native.normalizedSessionId, turnId: "answered-turn", eventType: "turn.completed",
        schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload: { status: "completed" } }; },
      result: async () => ({ result, terminal, turnId: "answered-turn" }),
      snapshot: async () => ({ backendKind: "mock", sessionId: identity.sessionId, identity, activeTurnId: null,
        pendingRuntimeRequests: [], cursor: "1", semanticResult: result }), close: async () => {},
    };
    const backend: NativeSessionBackend = { descriptor: async () => ({ kind: "mock", name: "card-answer-agent", version: "1", capabilities,
      runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }), openSession: async () => session };
    toolDefinitions.mockResolvedValue([]);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...currentRun.runnerProfileJson, sessionCheckpoint: null, nativeExecutionInput: execution } })
      .where(eq(heartbeatRuns.id, followUp.runId));
    await executePaperclipNativeSession({ db, execution, backend, runnerInstanceId: followUp.native.runnerInstanceId });
    expect(await readFile(action, "utf8")).toBe(`paint:${color}`);
    if (card) {
      const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(saved.status).toBe(inputKind === "card" ? "answered" : "pending");
      const deliveries = await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, card.id));
      if (inputKind === "card") expect(deliveries[0]!.status).toBe("fallback_queued");
      else expect(deliveries).toHaveLength(0);
    }
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, followUp.runId));
    expect((accepted.resultJson.result as { summary: string }).summary).toContain(`Painted ${color}`);
  }, 60_000);

  it.each(["duplicate", "unrelated"] as const)("does not exempt a %s unanswered input just because one question is parked", async kind => {
    const prior = await seedRecoveredPriorRun("unanswered-tool", { provider: "opencode", governedWait: true });
    const followUp = await admitFollowUp(prior);
    const root = scopedRunnerdStateRoot(prior.executionFor(followUp.runId));
    await restoreNativeRunnerCheckpoint(db, { companyId, issueId: prior.issueId, runId: prior.runId }, root);
    const path = join(root, "control-plane", "control-plane-state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.committedEvents.at(-1).sourceSeq = 3;
    const extra = structuredClone(state.committedEvents[0]);
    extra.sourceEventId = "another-unanswered-input"; extra.sourceSeq = 2;
    if (kind === "unrelated") extra.envelope.payload.payload.semantic_tool.operationId = "non_parked_tool";
    state.committedEvents.splice(1, 0, extra);
    state.ackedSourceSeq = 3;
    await writeFile(path, JSON.stringify(state));
    await db.insert(environments).values({ id: followUp.environmentId, name: `parked-${followUp.environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId, issueId: prior.issueId,
      heartbeatRunId: prior.runId, provider: "daytona", providerLeaseId: `old-${prior.runId}`, status: "expired", releasedAt: new Date() });
    expect(await inspectFinishedPerTurnRunnerdOwner({ db, root, identity: prior.identity, execution: prior.executionFor(followUp.runId),
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: { execute: followUp.remoteExecute },
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: followUp.providerLeaseId } } as never,
    })).toMatchObject({ finished: false, refused: "journal_tool_input_unanswered" });
  }, 60_000);

  // Staging PAP-4196 (run.attach) and PAP-3443 (semantic_tool.result): the
  // per-turn owner committed its result and its sandbox was destroyed after the
  // turn, but its journal still held a delivery that its Runner never
  // acknowledged. No process remains to receive it, so the follow-up retires
  // the owner. A Runner whose sandbox may still exist keeps the owner held.
  it.each([
    { control: "pending-attach", label: "ended on another sandbox", status: "expired", sameSandbox: false, recorded: true,
      outcome: ADMITTED },
    { control: "pending-tool-result", label: "ended on another sandbox", status: "expired", sameSandbox: false, recorded: true,
      outcome: ADMITTED },
    { control: "pending-attach", label: "still retained", status: "retained", sameSandbox: false, recorded: true,
      outcome: stranded("journal_commands_unsettled(run.attach.pending)") },
    { control: "pending-tool-result", label: "ended on this sandbox", status: "expired", sameSandbox: true, recorded: true,
      outcome: stranded("journal_commands_unsettled(semantic_tool.result.pending)") },
    { control: "pending-tool-result", label: "not recorded", status: "expired", sameSandbox: false, recorded: false,
      outcome: stranded("journal_commands_unsettled(semantic_tool.result.pending)") },
    { control: "unanswered-tool", label: "ended on another sandbox", status: "expired", sameSandbox: false, recorded: true,
      outcome: stranded("journal_tool_input_unanswered") },
    // Staging: the owner parked on a durable question, so that
    // question's tool input is unanswered by design. Its Runner is gone.
    { control: "unanswered-tool", governedWait: true, label: "ended on another sandbox after a governed-wait park",
      status: "expired", sameSandbox: false, recorded: true, outcome: ADMITTED },
    { control: "unanswered-tool", governedWait: true, label: "ended on this sandbox after a governed-wait park",
      status: "expired", sameSandbox: true, recorded: true, outcome: stranded("journal_tool_input_unanswered") },
  ] as const)("retires a finished remote owner with an unacknowledged $control when its sandbox lease $label",
    async ({ control, status, sameSandbox, recorded, outcome, ...rest }) => {
      const governedWait = "governedWait" in rest && rest.governedWait === true;
      const prior = await seedRecoveredPriorRun(control, { provider: "opencode", governedWait });
      const followUp = await admitFollowUp(prior);
      if (recorded) {
        await db.insert(environments).values({ id: followUp.environmentId, name: `ended-${followUp.environmentId}`, driver: "sandbox" });
        await db.insert(environmentLeases).values({ companyId, environmentId: followUp.environmentId, issueId: prior.issueId,
          heartbeatRunId: prior.runId, provider: "daytona", providerLeaseId: sameSandbox ? followUp.providerLeaseId : `sandbox-${prior.runId}`,
          status, releasedAt: status === "retained" ? null : new Date(), metadata: { remoteCwd: "/workspace" } });
      }
      expect(await followUp.start()).toBe(outcome);
      if (outcome === ADMITTED) expect(followUp.logs.join("")).toContain("finished without a saved runner checkpoint");
    }, 60_000);

  it("admits again when a retry rebuilds the same projection from the database", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    expect(await followUp.start()).toBe(ADMITTED);
    // Every admission restores the prior projection from the database. The
    // same proof must hold each time instead of rejecting the rebuilt root.
    expect(await followUp.start()).toBe(ADMITTED);
    expect(await quarantined()).toEqual([]);
    expect(await archivedOwners(await sessionRoot())).toEqual([prior.runId, prior.runId]);
  }, 60_000);

  it("admits a stranded task whose earlier attempts quarantined the same projection", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    expect(await quarantined()).toHaveLength(1);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(ADMITTED);
    expect(await quarantined()).toHaveLength(1);
  }, 60_000);

  it.each([
    { label: "an interrupted bootstrap that never opened its session", turnIssued: false, sessionOpened: false },
    { label: "a remote bootstrap that opened its session without a turn", turnIssued: false, sessionOpened: true },
    { label: "a bootstrap copy that already issued a turn", turnIssued: true, sessionOpened: false },
  ])("retires a finished owner past its own quarantined earlier bootstrap: $label", async ({ turnIssued, sessionOpened }) => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    const [copy] = await quarantined();
    const copyRoot = join(stateDirectory, "quarantine", copy!);
    const path = join(copyRoot, "control-plane", "control-plane-state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    const bootstrap = state.commands.filter((command: { type: string }) => command.type === "run.prepare" || command.type === "session.open"
      || (turnIssued && command.type === "turn.start"));
    for (const command of bootstrap) {
      command.status = command.type === "run.prepare" || (sessionOpened && command.type === "session.open") ? "completed" : "pending";
    }
    const opened = sessionOpened ? ["session.started", "session.capabilities.updated"].map((eventType, index) => ({
      sourceSeq: index + 1, sourceEventId: `opened-${index + 1}`, eventType, priority: 1, envelope: { ...prior.identity },
      deliveryCount: 1, logicalEffectCount: 1 })) : [];
    await writeFile(path, JSON.stringify({ ...state, commands: bootstrap, committedEvents: opened, ackedSourceSeq: opened.length }));
    await rm(join(copyRoot, "runner"), { recursive: true, force: true });
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(turnIssued
      ? stranded("quarantine_journal_commands_unsettled(session.open.pending,turn.start.pending)") : ADMITTED);
  }, 60_000);

  it("keeps an unsuspended Runner receipt decisive after a retry rebuilds the root", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    // Learn the scope key from a held attempt, then give the active root the
    // local evidence of an owner whose Runner never suspended.
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    const [copy] = await quarantined();
    const root = join(stateDirectory, copy!.split(".")[0]!);
    await rename(join(stateDirectory, "quarantine", copy!), root);
    await mkdir(join(root, "runner"));
    await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
      schema: "paperclip.runner.durable.state.v1", lifecycle: "ready", ...prior.identity }));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("runner_lifecycle_not_suspended"));
    expect(await quarantined()).toHaveLength(1);
    // The retry restores only the database journal. The quarantined receipt
    // must still hold it.
    expect(await followUp.start()).toBe(stranded("quarantine_runner_lifecycle_not_suspended"));
    expect(await quarantined()).toHaveLength(2);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  /** Learn the scope key from a held attempt and restore its root as the
   * live session root, as it stands after the prior turn finished. */
  async function restoreHeldRoot(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>,
    followUp: Awaited<ReturnType<typeof admitFollowUp>>) {
    await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    expect(await followUp.start()).toBe(stranded("owner_observed"));
    const [copy] = await quarantined();
    const root = join(stateDirectory, copy!.split(".")[0]!);
    await rename(join(stateDirectory, "quarantine", copy!), root);
    await rm(join(stateDirectory, "quarantine"), { recursive: true, force: true });
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
    return root;
  }

  // A continued turn's transport leaves these in the controller root: the
  // runtime context it wrote before launch, and the settled epoch it archived
  // when it rotated authority from the turn before it (S49: the third turn of
  // an ephemeral-lease task could never retire the second turn's owner).
  it("retires a finished owner whose continued turn left runtime context and an archived authority epoch", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    await writeFile(join(root, "runtime-context.json"), "{}\n", { mode: 0o600 });
    const epoch = join(root, "authority-epochs", "epoch-0123456789abcdef01234567");
    await mkdir(join(epoch, "control-plane"), { recursive: true, mode: 0o700 });
    await cp(join(root, "control-plane", "control-plane-state.json"), join(epoch, "control-plane", "control-plane-state.json"));
    await writeFile(join(epoch, "runner-state.json"), "{}\n", { mode: 0o600 });
    await mkdir(join(root, "diagnostics"), { mode: 0o700 });
    // The launch preparation saved for the retired identity.
    const preparation = JSON.stringify({ schema: "paperclip.runner.launch-preparation-store.v1", entries: [] });
    await writeFile(join(root, "launch-preparation.json"), preparation, { mode: 0o600 });
    expect(await followUp.start()).toBe(ADMITTED);
    expect(await archivedOwners(root)).toEqual([prior.runId]);
    // Archived epochs belong to the retired lineage; launch inputs stay.
    const [archive] = await readdir(join(root, "continuity-breaks"));
    expect(existsSync(join(root, "continuity-breaks", archive!, "authority-epochs", "epoch-0123456789abcdef01234567"))).toBe(true);
    expect(existsSync(join(root, "authority-epochs"))).toBe(false);
    expect(await readFile(join(root, "continuity-breaks", archive!, "launch-preparation.json"), "utf8")).toBe(preparation);
    expect(existsSync(join(root, "launch-preparation.json"))).toBe(false);
    expect(existsSync(join(root, "runtime-context.json"))).toBe(true);
    expect(followUp.logs.join("")).toContain(`Run ${prior.runId} finished without a saved runner checkpoint`);
  }, 60_000);

  it("keeps a finished owner held by an unclassified root entry and names it", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    await writeFile(join(root, "unrecognized-state"), "{}\n");
    expect(await followUp.start()).toBe(stranded("unexpected_root_entry(unrecognized-state)"));
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  it("keeps a finished owner held by a provider checkpoint and names it as held", async () => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    await mkdir(join(root, "cursor-cloud"), { mode: 0o700 });
    await writeFile(join(root, "unrecognized-state"), "{}\n");
    expect(await followUp.start()).toBe(stranded("held_root_entry(cursor-cloud)"));
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);

  /** A spawned process that stands in for the prior local Runner. */
  async function runnerProcess() {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    await new Promise(resolve => child.once("spawn", resolve));
    const startedAt = await readProcessStartedAt(child.pid!);
    expect(startedAt).toBeTruthy();
    return { child, pid: child.pid!, processStartedAt: new Date(startedAt!) };
  }

  async function stoppedRunnerProcess() {
    const runner = await runnerProcess();
    const exited = new Promise(resolve => runner.child.once("exit", resolve));
    runner.child.kill("SIGKILL");
    await exited;
    return runner;
  }

  /** The state a local per-turn Runner leaves when its result was accepted but
   * its suspend command never finished: the controller journal holds a pending
   * runner.suspend and the Runner's own receipt is still `ready`. */
  async function seedUnsuspendedLocalOwner(runner: { pid: number; processStartedAt: Date }, lifecycle?: "warm", provider?: "pi_rpc") {
    const prior = await seedRecoveredPriorRun(lifecycle === "warm" ? "pending-attach" : "pending-command", { lifecycle, provider });
    await db.update(heartbeatRuns).set({ processPid: runner.pid, processGroupId: runner.pid, processStartedAt: runner.processStartedAt })
      .where(eq(heartbeatRuns.id, prior.runId));
    const followUp = await admitFollowUp(prior);
    // Learn the scope key from a held attempt, then keep its root in place.
    expect(await followUp.start()).toMatch(/^runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate/);
    const [copy] = await quarantined();
    const root = join(stateDirectory, copy!.split(".")[0]!);
    await rename(join(stateDirectory, "quarantine", copy!), root);
    await rm(join(stateDirectory, "quarantine"), { recursive: true, force: true });
    if (lifecycle === "warm") {
      const path = join(root, "control-plane", "control-plane-state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      state.commands = state.commands.filter((command: { type: string }) => command.type !== "run.attach");
      await writeFile(path, JSON.stringify(state));
    }
    await mkdir(join(root, "runner"), { recursive: true });
    await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
      schema: "paperclip.runner.durable.state.v1", lifecycle: "ready", ...prior.identity }));
    return { prior, followUp, root };
  }

  it.each(["exited", "alive", "another owner"] as const)(
    "skips a local quarantined bootstrap that opened a session only when it is this owner's and its processes %s",
    async scenario => {
      const runner = scenario === "alive" ? await runnerProcess() : await stoppedRunnerProcess();
      const root = await mkdtemp(join(tmpdir(), "quarantined-opened-bootstrap-"));
      const identity = { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "owner-run",
        normalizedSessionId: "session-1", turnId: "turn-owner-run", itemId: "item-owner-run" };
      try {
        await mkdir(join(root, "control-plane"), { recursive: true, mode: 0o700 });
        await mkdir(join(root, "runner"), { recursive: true, mode: 0o700 });
        await writeFile(join(root, "control-plane", "control-plane-state.json"), JSON.stringify({
          schema: "paperclip.runner.durable.control-plane-state.v2", identity,
          bootstrapHistory: { schema: "paperclip.runner.bootstrap-history.v1", originIdentity: identity, credentialsIssued: 1, adopted: false },
          commands: [
            { commandId: "prepare", type: "run.prepare", status: "completed", result: { status: "prepared" } },
            { commandId: "open", type: "session.open", status: "completed", result: { result: { status: "started", processId: runner.pid } } },
          ],
          committedEvents: [{ sourceSeq: 1, sourceEventId: "opened-1", eventType: "session.started", priority: 1, envelope: identity }],
          ackedSourceSeq: 1, connectionCount: 1 }));
        await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1",
          ...identity, lifecycle: "ready", outbox: [], processedCommands: {
            prepare: { commandType: "run.prepare", status: "completed", result: { status: "prepared" } },
            open: { commandType: "session.open", status: "completed", result: { status: "started", processId: runner.pid } } } }));
        const owner = scenario === "another owner" ? { ...identity, runId: "another-run" } : identity;
        expect(quarantinedBootstrapOfOwnerHeldNoProviderWork(root, owner, true)).toBe(scenario === "exited");
      } finally {
        if (scenario === "alive") runner.child.kill("SIGKILL");
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  it.each([
    { label: "never delivered to a dead runner", connectionCount: 0, claim: true, admitted: true, archiveOnly: false },
    { label: "possibly delivered", connectionCount: 1, claim: true, admitted: false, archiveOnly: false },
    { label: "without a dead-runner claim", connectionCount: 0, claim: false, admitted: false, archiveOnly: false },
    { label: "cut off before its new control plane was written", connectionCount: 0, claim: true, admitted: true, archiveOnly: true },
    { label: "cut off before its new control plane, without a dead-runner claim", connectionCount: 0, claim: false, admitted: false,
      archiveOnly: true },
  ])("resumes from the previous turn when a warm attach rotation was $label", async ({ connectionCount, claim, admitted, archiveOnly }) => {
    const prior = await seedRecoveredPriorRun();
    const followUp = await admitFollowUp(prior);
    const root = await restoreHeldRoot(prior, followUp);
    const priorIdentity = JSON.parse(await readFile(join(root, "control-plane", "control-plane-state.json"), "utf8")).identity;
    const epoch = join(root, "authority-epochs",
      `epoch-${createHash("sha256").update(JSON.stringify(priorIdentity)).digest("hex").slice(0, 24)}`);
    await mkdir(epoch, { recursive: true, mode: 0o700 });
    await rename(join(root, "control-plane"), join(epoch, "control-plane"));
    await writeFile(join(epoch, "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...priorIdentity,
      lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, pendingProviderCleanup: null }));
    await mkdir(join(root, "runner"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "runner", "codex-provider-state.json"), "{}");
    const identity = { ...priorIdentity, runId: followUp.runId, turnId: `turn-${followUp.runId}`, itemId: `item-${followUp.runId}` };
    if (!archiveOnly) await mkdir(join(root, "control-plane"), { mode: 0o700 });
    const undelivered = JSON.stringify({ schema: "paperclip.runner.durable.control-plane-state.v2", identity,
      bootstrapHistory: { schema: "paperclip.runner.bootstrap-history.v1", originIdentity: identity, credentialsIssued: 0, adopted: false },
      runAttachTemplate: {}, tickets: {}, leases: {},
      commands: [{ commandId: "attach", controllerSeq: 1, type: "run.attach", status: "pending", payload: {} }],
      committedEvents: [], ackedSourceSeq: 0, connectionCount, commandDeliveryCounts: {} });
    if (!archiveOnly) await writeFile(join(root, "control-plane", "control-plane-state.json"), undelivered);
    const outcome = await followUp.startLocal(claim ? { kind: "resume_dead_runner", runId: followUp.runId, leaseOwner: "successor",
      controllerGeneration: 2, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null } as never : undefined);
    if (!admitted) {
      expect(outcome).toBe(archiveOnly ? "runner_state_identity_mismatch: durable_identity_unreadable"
        : "runner_state_identity_mismatch: authority_indeterminate");
      return;
    }
    expect(outcome).toBe(ADMITTED);
    expect(JSON.parse(await readFile(join(root, "control-plane", "control-plane-state.json"), "utf8")).identity).toEqual(priorIdentity);
    expect(existsSync(join(root, "authority-epochs"))).toBe(false);
    if (archiveOnly) {
      expect(existsSync(join(root, "continuity-breaks"))).toBe(false);
      expect(await quarantined()).toEqual([]);
      return;
    }
    const [archive] = await readdir(join(root, "continuity-breaks"));
    expect(await readFile(join(root, "continuity-breaks", archive!, "control-plane", "control-plane-state.json"), "utf8")).toBe(undelivered);
    expect(await quarantined()).toEqual([]);
    expect(followUp.logs.join("")).toContain("stopped before its runner received the session");
  }, 60_000);

  it.each([undefined, "warm"] as const)("retires a finished %s local owner whose Runner stopped before it proved suspension", async lifecycle => {
    const { prior, followUp, root } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess(), lifecycle);
    expect(await followUp.startLocal()).toBe(ADMITTED);
    expect(await quarantined()).toEqual([]);
    expect(existsSync(join(root, "runner"))).toBe(false);
    expect(await archivedOwners(root)).toEqual([prior.runId]);
    expect(followUp.logs.join("")).toContain(`Run ${prior.runId} finished without a saved runner checkpoint`);
  }, 60_000);

  it.each(["settled", "unsettled journal", "foreign session", "advanced history"] as const)(
    "revalidates a lost Pi owner's archived history before another admission (%s)", async scenario => {
      const { prior, followUp, root } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess(), "warm", "pi_rpc");
      const sessionFile = `${prior.native.normalizedSessionId}.jsonl`;
      await mkdir(join(root, "pi"));
      await writeFile(join(root, "pi", sessionFile), "private Pi history\n");
      expect(await followUp.startLocal()).toBe(ADMITTED);
      const [archive] = await readdir(join(root, "continuity-breaks"));
      const path = join(root, "continuity-breaks", archive!, "control-plane", "control-plane-state.json");
      if (scenario === "unsettled journal" || scenario === "foreign session") {
        const state = JSON.parse(await readFile(path, "utf8"));
        if (scenario === "unsettled journal") state.commands.find((command: { type: string }) => command.type === "turn.start").status = "pending";
        else state.identity.normalizedSessionId = randomUUID();
        await writeFile(path, JSON.stringify(state));
      }
      if (scenario === "advanced history") {
        await mkdir(join(root, "pi"));
        await writeFile(join(root, "pi", sessionFile), "advanced Pi history\n");
      }
      expect(await followUp.startLocal()).toBe(scenario === "settled" ? ADMITTED : "runner_state_identity_mismatch: durable_identity_unreadable");
      const preservedRoot = scenario === "settled" ? root : join(stateDirectory, "quarantine", (await quarantined())[0]!);
      expect(await readFile(join(preservedRoot, "continuity-breaks", archive!, "pi", sessionFile), "utf8")).toBe("private Pi history\n");
    }, 60_000);

  it.each([undefined, "warm"] as const)("keeps a finished %s local owner held while its recorded Runner process is alive", async lifecycle => {
    const runner = await runnerProcess();
    try {
      const { followUp } = await seedUnsuspendedLocalOwner(runner, lifecycle);
      expect(await followUp.startLocal()).toBe(stranded("runner_process_alive"));
      expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
    } finally {
      runner.child.kill("SIGKILL");
    }
  }, 60_000);

  it.each(["no identity", "no process group"] as const)("keeps a finished local owner held with %s", async scenario => {
    const { prior, followUp } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess());
    await db.update(heartbeatRuns).set(scenario === "no identity"
      ? { processPid: null, processGroupId: null, processStartedAt: null } : { processGroupId: null })
      .where(eq(heartbeatRuns.id, prior.runId));
    expect(await followUp.startLocal()).toBe(stranded("runner_process_identity_missing"));
  }, 60_000);

  it("retires a finished local owner from its saved stop receipt after settlement cleared the process fields", async () => {
    const runner = await stoppedRunnerProcess();
    const { prior, followUp, root } = await seedUnsuspendedLocalOwner(runner);
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: prior.runId, seq: 900, eventType: "native.local_process_stopped",
      stream: "system", payload: { processPid: runner.pid, processGroupId: runner.pid, processStartedAt: runner.processStartedAt.toISOString() } });
    await db.update(heartbeatRuns).set({ processPid: null, processGroupId: null, processStartedAt: null })
      .where(eq(heartbeatRuns.id, prior.runId));
    expect(await followUp.startLocal()).toBe(ADMITTED);
    expect(await archivedOwners(root)).toEqual([prior.runId]);
  }, 60_000);

  it.each([undefined, "warm"] as const)("keeps a stopped %s local owner held while a provider process from its run events is alive", async lifecycle => {
    const provider = await runnerProcess();
    try {
      const { prior, followUp } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess(), lifecycle);
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: prior.runId, seq: 901, eventType: "provider.event",
        stream: "system", payload: { prpEvent: { payload: { processId: provider.pid,
          processStartedAt: provider.processStartedAt.toISOString() } } } });
      expect(await followUp.startLocal()).toBe(stranded("provider_process_alive"));
    } finally {
      provider.child.kill("SIGKILL");
    }
  }, 60_000);

  it.each([undefined, "warm"] as const)("keeps a stopped %s local owner held by an unfinished non-lifecycle command", async lifecycle => {
    const { followUp, root } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess(), lifecycle);
    const path = join(root, "control-plane", "control-plane-state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.commands.find((command: { type: string }) => command.type === "turn.start").status = "pending";
    await writeFile(path, JSON.stringify(state));
    expect(await followUp.startLocal()).toBe(stranded("journal_commands_unsettled(turn.start.pending)"));
  }, 60_000);

  it("keeps a stopped local owner held by an unacknowledged run.attach", async () => {
    // Only a remote Runner whose sandbox lease ended elsewhere is gone by record.
    const { followUp, root } = await seedUnsuspendedLocalOwner(await stoppedRunnerProcess());
    const path = join(root, "control-plane", "control-plane-state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.commands.push({ ...state.commands.at(-1), commandId: "command_unacknowledged_attach",
      controllerSeq: state.commands.length + 1, type: "run.attach", status: "pending", result: null });
    await writeFile(path, JSON.stringify(state));
    expect(await followUp.startLocal()).toBe(stranded("journal_commands_unsettled(run.attach.pending)"));
  }, 60_000);

  it.each(["uncommitted result", "committed without result", "live controller lease", "unexpired controller lease", "recovery pending", "pending command",
    "unanswered tool input", "foreign quarantine"] as const)("keeps the prior owner held with %s", async scenario => {
    const prior = await seedRecoveredPriorRun(scenario === "pending command" ? "pending-command"
      : scenario === "unanswered tool input" ? "unanswered-tool" : "settled");
    const followUp = await admitFollowUp(prior);
    let expectedQuarantine = 1;
    if (scenario === "uncommitted result") {
      await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", resultId: null })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "committed without result") {
      await db.update(nativeRunFinalizations).set({ resultId: null }).where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "live controller lease") {
      await db.update(nativeRunFinalizations).set({ leaseOwner: "another-controller", leaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "unexpired controller lease") {
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "recovery pending") {
      await db.update(nativeRunFinalizations).set({ recoveryState: "resuming_session" })
        .where(eq(nativeRunFinalizations.runId, prior.runId));
    }
    if (scenario === "foreign quarantine") {
      // A copy of this projection is harmless; a different owner saved under
      // the same scope is unresolved evidence that must not be overtaken.
      await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
      expect(await followUp.start()).toBe(stranded("owner_observed"));
      const [copy] = await quarantined();
      const foreign = join(stateDirectory, "quarantine", copy!.replace(/\.[0-9a-f-]{36}$/, `.${randomUUID()}`));
      await cp(join(stateDirectory, "quarantine", copy!), foreign, { recursive: true });
      const path = join(foreign, "control-plane", "control-plane-state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...state, identity: { ...state.identity, runId: randomUUID() } }));
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, prior.runId));
      expectedQuarantine = 3;
    }
    const outcome = await followUp.start();
    // A live owner is still waited for before any projection is rebuilt. Every
    // other hold names its failed proof instead of one indeterminate state.
    expect(outcome).toBe({
      "uncommitted result": stranded("owner_retryable_failure"),
      "committed without result": stranded("owner_result_missing"),
      "live controller lease": "native_controller_recovery_waiting_for_owner",
      "unexpired controller lease": stranded("controller_remote_controller_lease_live"),
      "recovery pending": stranded("owner_recovery_resuming_session"),
      "pending command": stranded("journal_commands_unsettled(runner.suspend.pending)"),
      "unanswered tool input": stranded("journal_tool_input_unanswered"),
      "foreign quarantine": stranded("quarantine_journal_identity_mismatch"),
    }[scenario]);
    expect(await quarantined()).toHaveLength(scenario === "live controller lease" ? 0 : expectedQuarantine);
    expect(followUp.logs.join("")).not.toContain("finished without a saved runner checkpoint");
  }, 60_000);
});
