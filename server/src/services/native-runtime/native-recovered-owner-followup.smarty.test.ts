// Fork-only regression ports; upstream intentionally deleted the stock suite.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations, nativeRunnerCheckpoints, nativeRunResults } from "@paperclipai/db";
import { DurablePrpControlPlane, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { createNativeControllerRecovery, resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeRunHasNoProviderWork, nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { createRunnerdBackend } from "./native-session-executor.js";

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

const ADMITTED = "follow-up admission reached tool authority";

const STRANDED = "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate";

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

  // Only the settled, per-turn ACPX owner is needed by these fork regressions.
  async function seedRecoveredPriorRun() {
    const issueId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue after recovery", assigneeAgentId: agentId, status: "in_progress" });
    const [row] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, contextSnapshot: { issueId } }).returning();
    const native = await prepareNativeHeartbeatRun({ db, run: row, issue: issueFields(issueId), environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const executionFor = (currentRunId: string) => buildNativeExecutionInput({
      companyId, agentId, runId: currentRunId, provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5",
      issue: { id: issueId, identifier: "ROF-1", title: "Continue after recovery", description: null, workMode: "standard" },
      taskPrompt: "Continue the conversation.",
      workspace: { id: workspaceId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: native.normalizedSessionId,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: contract.schemaVersion,
        contract: contract.contractJson as never },
    });
    const execution = executionFor(runId);
    const identity = { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
      environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId };
    const priorController = { bootId: randomUUID(), pid: 2_147_483_000,
      processStartedAt: new Date(Date.now() - 60_000) };
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: priorController.bootId, generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed",
      controllerBootId: owner.bootId, controllerGeneration: 1, controllerPid: priorController.pid,
      controllerProcessStartedAt: priorController.processStartedAt, leaseOwner: owner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    const scratch = await mkdtemp(join(tmpdir(), "native-recovered-owner-controller-"));
    const controller = new DurablePrpControlPlane({ stateDirectory: scratch, identity,
      expectedRunnerVersion: "recovered-owner-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"]) {
        Object.assign(controller.queueCommand(type), { status: "completed", result: { status: "completed" } });
      }
      controller.store.state.committedEvents.push({ sourceSeq: 2, sourceEventId: "recovered-terminal", eventType: "run.terminal",
        priority: 0, envelope: { ...identity }, deliveryCount: 1, logicalEffectCount: 1 });
      controller.store.state.ackedSourceSeq = 2;
      controller.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
      await controller.flushCheckpoint();
    } finally {
      await controller.stop();
      await rm(scratch, { recursive: true, force: true });
    }
    const snapshot: PersistedNativeSession = { backendKind: "runner", sessionId: native.normalizedSessionId,
      providerSessionId: "provider-session-before-recovery", activeTurnId: null, pendingRuntimeRequests: [],
      identity: { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId } };
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
      completionContractId: prepared.completionContractId!, serverFingerprint: "fixture", schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: "fixture" }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: {
      ...prepared.runnerProfileJson, nativeExecutionInput: execution, sessionCheckpoint: snapshot,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", execution.provider.kind),
      nativeControllerRecovery: createNativeControllerRecovery(snapshot,
        { configDigest: `sha256:${"b".repeat(64)}`, processConfigDigest: null },
        { runId, runnerInstanceId: native.runnerInstanceId, normalizedSessionId: native.normalizedSessionId }),
    } }).where(eq(heartbeatRuns.id, runId));
    return { issueId, runId, native, identity, executionFor };
  }

  async function admitFollowUp(prior: Awaited<ReturnType<typeof seedRecoveredPriorRun>>) {
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
    expect(admission.checkpoint).not.toBeNull();
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...current.runnerProfileJson, nativeExecutionInput: execution,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", execution.provider.kind),
      sessionCheckpoint: admission.checkpoint } }).where(eq(heartbeatRuns.id, runId));
    const environmentId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${runId}`;
    const remoteExecute = vi.fn(async (_request: unknown): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> => {
      throw new Error("admission must not reach the sandbox");
    });
    const start = () => createRunnerdBackend({
      db, execution, runnerInstanceId: next.runnerInstanceId, onLog: async () => {},
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId,
        leaseId, remoteCwd: "/workspace", reusableLeaseConfigured: true,
        runner: { execute: remoteExecute },
        sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } } as never,
    }).then(() => "constructed", (error: Error) => error.message);
    return { runId, start, native: next, selectedRunId: selected?.id ?? null };
  }

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
    return followUp.runId;
  }

  it.each([
    { count: 1, status: "failed" as const, error: "remote_warm_session_not_idle" },
    { count: 2, status: "failed" as const, error: "remote_warm_session_not_idle" },
    { count: 1, status: "cancelled" as const, error: "provider transport closed during startup" },
    { count: 1, status: "failed" as const, error: "environmentSyncIn timed out after 30000ms" },
  ])("skips $count $status startup(s) with a claimed controller: $error", async ({ count, status, error }) => {
    const prior = await seedRecoveredPriorRun();
    for (let index = 0; index < count; index++) {
      const failed = await failUnstartedFollowUp(prior);
      await db.update(heartbeatRuns).set({ status, processPid: 7, processGroupId: 7, processStartedAt: new Date(),
        error, usageJson: { budgetDispatch: { handedOffAt: new Date().toISOString() } } })
        .where(eq(heartbeatRuns.id, failed));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", controllerPid: 7,
        controllerBootId: randomUUID(), controllerGeneration: 1, leaseOwner: "startup-controller" })
        .where(eq(nativeRunFinalizations.runId, failed));
      // Source selection alone may disregard startup ownership; Stop must not.
      expect(await nativeRunHasNoProviderWork(db, { companyId, agentId, issueId: prior.issueId }, failed)).toBe(false);
    }
    const retry = await admitFollowUp(prior);
    expect(retry.selectedRunId).toBe(prior.runId);
    expect(retry.native.normalizedSessionId).toBe(prior.native.normalizedSessionId);
    const recovery = await resolveNativeControllerRecovery(db, { companyId, agentId, issueId: prior.issueId,
      normalizedSessionId: prior.native.normalizedSessionId, currentRunId: retry.runId });
    expect(recovery.kind).toBe("recoverable");
    if (recovery.kind === "recoverable") expect(recovery.snapshot.identity?.runId).toBe(prior.runId);
    expect(await retry.start()).toBe(ADMITTED);
  }, 60_000);

  it("carries the skipped startup's unanswered wake exactly once without replaying the committed owner's input", async () => {
    const prior = await seedRecoveredPriorRun();
    const [oldComment] = await db.insert(issueComments).values({ companyId, issueId: prior.issueId,
      authorType: "user", authorUserId: "board", body: "ALREADY_COMMITTED_WAKE" }).returning();
    const delivered = { id: oldComment.id, authorType: "user", authorId: "board", createdByRunId: null,
      body: oldComment.body, createdAt: oldComment.createdAt.toISOString(), updatedAt: oldComment.updatedAt.toISOString(),
      deleted: false, sourceTrust: oldComment.sourceTrust };
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: prior.issueId,
      executionContinuation: { messages: [delivered] } } }).where(eq(heartbeatRuns.id, prior.runId));
    const failed = await failUnstartedFollowUp(prior);
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: prior.issueId,
      authorType: "user", authorUserId: "board", body: "UNANSWERED_STARTUP_WAKE" }).returning();
    await db.update(heartbeatRuns).set({ processPid: 7, contextSnapshot: { issueId: prior.issueId,
      wakeReason: "issue_commented", wakeCommentId: comment.id, commentIds: [comment.id] } }).where(eq(heartbeatRuns.id, failed));
    await db.update(nativeRunFinalizations).set({ controllerPid: 7 }).where(eq(nativeRunFinalizations.runId, failed));
    const retry = await admitFollowUp(prior);
    expect(retry.selectedRunId).toBe(prior.runId);
    const continuation = await buildExecutionContinuation({ db, companyId, issueId: prior.issueId, agentId,
      context: { retryOfRunId: failed, wakeReason: "retry_failed_run" }, previousContextRunId: retry.selectedRunId,
      runId: retry.runId, summary: null, exposeLowTrustRaw: true });
    expect(continuation.originCommentIds).toEqual([comment.id]);
    expect(continuation.resumeDelta?.messages.map(message => message.id)).toEqual([comment.id]);
    const prompt = renderPaperclipWakePrompt({ executionContinuation: continuation }, { resumedSession: true });
    const previousRun = await findNativeSessionResumeRun(db, { companyId, agentId, issueId: prior.issueId,
      normalizedSessionId: prior.native.normalizedSessionId, currentRunId: retry.runId, beforeCreatedAt: new Date() });
    const execution = prior.executionFor(retry.runId);
    const resumed = buildNativeExecutionWithCheckpoint({ previousRun, normalizedSessionId: prior.native.normalizedSessionId,
      executionTargetKind: "remote", buildExecution: () => ({ ...execution, task: { ...execution.task, prompt } }) });
    expect(resumed.checkpoint).not.toBeNull();
    // The renderer also states the objective; delivery identity, not repeated
    // contextual prose, proves that this is one unanswered input.
    expect(resumed.execution.task.prompt).toContain(comment.body);
    expect(resumed.execution.task.prompt).not.toContain(oldComment.body);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, failed))).toHaveLength(0);
  }, 60_000);

  it.each(["session.started", "turn.started", "item.started", "item.delta", "item.completed", "turn.completed",
    "controller checkpoint", "provider work receipt", "provider phase", "result pointer", "active turn", "pending request",
    "run result", "different provider session", "own progress cursor"] as const)(
    "keeps a failed follow-up as the source with %s", async scenario => {
      const prior = await seedRecoveredPriorRun();
      const failed = await failUnstartedFollowUp(prior);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed));
      const checkpoint = run.runnerProfileJson!.sessionCheckpoint as Record<string, unknown>;
      await db.update(heartbeatRuns).set({ processPid: 7 }).where(eq(heartbeatRuns.id, failed));
      await db.update(nativeRunFinalizations).set({ controllerPid: 7 }).where(eq(nativeRunFinalizations.runId, failed));
      if (scenario === "session.started" || scenario.startsWith("turn.") || scenario.startsWith("item.")) {
        await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: failed, seq: 100, eventType: scenario,
          stream: "system", payload: {} });
      }
      if (scenario === "controller checkpoint") {
        await db.insert(nativeRunnerCheckpoints).values({ companyId, issueId: prior.issueId, runId: failed, part: "header", material: {} });
      }
      if (scenario === "provider work receipt") {
        await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } })
          .where(eq(heartbeatRuns.id, failed));
      }
      if (scenario === "provider phase") {
        await db.update(nativeRunFinalizations).set({ phase: "provider_session_started" }).where(eq(nativeRunFinalizations.runId, failed));
      }
      if (["active turn", "pending request"].includes(scenario)) {
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, sessionCheckpoint: {
          ...checkpoint,
          ...(scenario === "active turn" ? { activeTurnId: "started" } : {}),
          ...(scenario === "pending request" ? { pendingRuntimeRequests: [{ requestId: "pending" }] } : {}),
        } } }).where(eq(heartbeatRuns.id, failed));
      }
      if (scenario === "run result" || scenario === "result pointer") {
        const [result] = await db.insert(nativeRunResults).values({ companyId, issueId: prior.issueId, runId: failed,
          completionContractId: run.completionContractId!, serverFingerprint: "fixture", schemaStatus: "rejected",
          resultJson: {}, canonicalSha256: "fixture" }).returning();
        if (scenario === "result pointer") await db.update(nativeRunFinalizations).set({ resultId: result.id })
          .where(eq(nativeRunFinalizations.runId, failed));
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
});
