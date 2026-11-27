// Fork-only regression ports; upstream intentionally deleted the stock suite.
import { findNativeSessionResumeRun } from "./native-session-resume.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { DurablePrpControlPlane, parseNativeExecutionInput, type NativeExecutionInput, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { createNativeControllerRecovery, importNativeControllerRecovery, resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { inspectRemoteWarmSessionRecovery } from "./remote-warm-session-recovery.js";
import { currentProcessSpaceHash } from "../controller-process-identity.js";



describe.skipIf(!recoveryPostgresSupport.supported)("native controller durable discovery and import", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;

  let db: ReturnType<typeof createDb>;

  let home: ReturnType<typeof createIsolatedTestHome>;

  let root: string;

  const previousHome = process.env.PAPERCLIP_HOME;

  const companyId = randomUUID(), agentId = randomUUID();

  const compatibility = { configDigest: `sha256:${"a".repeat(64)}`, processConfigDigest: null };

  beforeAll(async () => {
    home = createIsolatedTestHome();
    process.env.PAPERCLIP_HOME = home.home;
    root = await mkdtemp(join(tmpdir(), "native-controller-discovery-"));
    database = await startRecoveryPostgres("native-controller-discovery-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Controller discovery", issuePrefix: "NCD" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    home?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
  });

  async function seed(cursor?: string) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue retained execution", assigneeAgentId: agentId, status: "in_progress" });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId }).returning();
    const native = await prepareNativeHeartbeatRun({ db, run, issue: { id: issueId, title: "Continue retained execution", description: null, reviewPolicy: null }, environmentLeaseId: randomUUID() });
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: owner.bootId,
      controllerGeneration: 1, leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, runId),
      identity: { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
        environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId },
      expectedRunnerVersion: "discovery-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
    await core.flushCheckpoint();
    await core.stop();
    const snapshot: PersistedNativeSession = { backendKind: "mock", sessionId: native.normalizedSessionId,
      ...(cursor ? { cursor } : {}), identity: { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId } };
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
      completionContractId: prepared.completionContractId!, serverFingerprint: "fixture", schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: "fixture" }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
    const profile = { ...prepared.runnerProfileJson, sessionCheckpoint: snapshot };
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: profile }).where(eq(heartbeatRuns.id, runId));
    const scope = { companyId, agentId, issueId, runId, normalizedSessionId: native.normalizedSessionId };
    return { scope, native, profile, snapshot, owner,
      supervisor: { schema: "paperclip.native-session-supervisor.v1", ...compatibility, snapshot } };
  }

  it.each(["pre-dispatch", "staged", "handed-off-once", "handed-off-twice"] as const)("selects the committed idle session past %s Stop and failed admissions for two messages", async stage => {
    const handedOff = stage.startsWith("handed-off");
    const fixture = await seed(handedOff ? "14" : stage === "staged" ? "7" : undefined);
    if (handedOff) {
      Object.assign(fixture.snapshot, { backendKind: "runner", driverKind: "pi_rpc", providerSessionId: "retained-provider-session",
        activeTurnId: null, pendingRuntimeRequests: [] });
      await db.update(heartbeatRuns).set({ runnerProfileJson: fixture.profile }).where(eq(heartbeatRuns.id, fixture.scope.runId));
    }
    expect(await importNativeControllerRecovery(db, { ...fixture.scope,
      expectedConfigDigest: compatibility.configDigest, supervisor: fixture.supervisor })).toEqual({ kind: "imported" });
    const baseTime = Date.now();
    const statuses = handedOff ? Array<string>(stage === "handed-off-once" ? 1 : 2).fill("failed") : ["cancelled", "failed", "failed"];
    for (const [index, status] of statuses.entries()) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, nativeIssueId: fixture.scope.issueId,
        nativeSessionId: fixture.scope.normalizedSessionId, runtimeMode: "native", status,
        createdAt: new Date(baseTime + index * 10), finishedAt: new Date(baseTime + index * 10 + 1),
        runnerProfileJson: { ...fixture.profile, nativeControllerRecovery: undefined,
          nativeExecutionInput: { staged: true }, sessionCheckpoint: { ...fixture.snapshot,
          cursor: stage === "staged" ? fixture.snapshot.cursor : null,
          identity: { ...fixture.snapshot.identity, runId: id } } },
        resultJson: status === "cancelled" ? { nativeCancellation: { beforeStart: true } }
          : handedOff ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : {},
        ...(handedOff ? { usageJson: { budgetDispatch: { handedOffAt: new Date().toISOString() } },
          errorCode: "runner_state_identity_mismatch", error: "runner_state_identity_mismatch: journal_unsettled" } : {}),
      });
      if (handedOff) await db.insert(nativeRunFinalizations).values({ companyId, issueId: fixture.scope.issueId,
        runId: id, phase: "terminal_failure" });
    }
    for (let message = 0; message < 2; message++) {
      const currentRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: currentRunId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
        nativeSessionId: fixture.scope.normalizedSessionId, runtimeMode: "native", status: "running",
        createdAt: new Date(baseTime + 100 + message) });
      const barrier = await findNativeSessionResumeRun(db, { ...fixture.scope, currentRunId,
        beforeCreatedAt: new Date(baseTime + 100 + message) });
      expect(barrier?.id).toBe(fixture.scope.runId);
      const recovered = await resolveNativeControllerRecovery(db, { ...fixture.scope, currentRunId });
      expect(recovered.kind).toBe("recoverable");
      if (recovered.kind !== "recoverable") throw new Error(JSON.stringify(recovered));
      expect(recovered.metadata.checkpoint?.runId).toBe(fixture.scope.runId);
      expect(recovered.snapshot.sessionId).toBe(fixture.snapshot.sessionId);
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, currentRunId));
    }
  });

  async function seedWarmFollowUpOnOldServer(provider: NativeExecutionInput["provider"] = { kind: "codex", model: null }) {
    const fixture = await seed(), runId = randomUUID(), environmentId = randomUUID();
    const previous = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v1", provider,
      binding: { companyId, agentId, issueId: fixture.scope.issueId, runId: fixture.scope.runId, executionWorkspaceId: randomUUID() },
      task: { identifier: "NCD-9", title: "Answer the follow-up", description: null, prompt: "Continue.", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: fixture.scope.normalizedSessionId, driverKind: provider.kind === "pi_rpc" ? "pi_rpc" : "codex_app_server",
        protocolVersion: 1, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 600_000 } },
      completionContract: { id: randomUUID(), sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue.", criteria: [{ id: "objective", requirement: "Save the result." }] } },
      credentialBindings: [], interactionResponses: [],
    });
    const current = { ...previous, binding: { ...previous.binding, runId } };
    const checkpoint: PersistedNativeSession = { ...fixture.snapshot, driverKind: previous.session.driverKind,
      providerSessionId: "warm-provider-session", activeTurnId: null, pendingRuntimeRequests: [] };
    await db.update(heartbeatRuns).set({ finishedAt: new Date(), runnerProfileJson: { ...fixture.profile, nativeExecutionInput: previous,
      sessionCheckpoint: checkpoint, nativeControllerRecovery: createNativeControllerRecovery(checkpoint, compatibility,
        { runId: fixture.scope.runId, runnerInstanceId: fixture.native.runnerInstanceId, normalizedSessionId: fixture.scope.normalizedSessionId }) } })
      .where(eq(heartbeatRuns.id, fixture.scope.runId));
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
      nativeSessionId: fixture.scope.normalizedSessionId, status: "running", runtimeMode: "native",
      runnerProfileJson: { nativeExecutionInput: current, sessionCheckpoint: { ...checkpoint, identity: { ...checkpoint.identity, runId } } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: fixture.scope.issueId, runId, phase: "observed" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, fixture.scope.issueId));
    await db.insert(environments).values({ id: environmentId, name: `Warm ${environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId, issueId: fixture.scope.issueId,
      heartbeatRunId: fixture.scope.runId, provider: "daytona", providerLeaseId: "warm-sandbox", status: "released",
      metadata: { remoteCwd: "/workspace" } });
    const identity = { runId: fixture.scope.runId, normalizedSessionId: fixture.scope.normalizedSessionId,
      runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.native.environmentLeaseId,
      turnId: fixture.native.turnId, itemId: fixture.native.itemId };
    const inspect = (overrides: Partial<Parameters<typeof inspectRemoteWarmSessionRecovery>[0]> = {}) => inspectRemoteWarmSessionRecovery({ db, execution: current, identity,
      target: { kind: "remote", transport: "sandbox", environmentId, leaseId: randomUUID(), providerKey: "daytona",
        remoteCwd: "/workspace", sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "warm-sandbox" } } as never,
      readControlState: () => ({ identity, commands: [{ type: "turn.start", status: "completed" }],
        committedEvents: [{ eventType: "run.terminal", envelope: identity }] }),
      matchesExecution: saved => saved.binding.runId === fixture.scope.runId,
      loadCheckpoint: () => checkpoint, canReuseProcess: () => true, ...overrides,
    });
    const recordOwner = (owner: Partial<typeof nativeRunFinalizations.$inferInsert>) => db.update(nativeRunFinalizations)
      .set(owner).where(eq(nativeRunFinalizations.runId, fixture.scope.runId));
    return { fixture, runId, current, identity, checkpoint, inspect, recordOwner };
  }

  it.each([
    { kind: "pi_rpc", model: "example/model", conversationMode: true },
    { kind: "pi_rpc", model: "example/model" },
    { kind: "codex", model: null },
  ] as const)("requires a finalized Pi conversation to adopt a completed turn without a Runner terminal: %j", async provider => {
    const { fixture, identity, checkpoint, inspect, recordOwner } = await seedWarmFollowUpOnOldServer(provider);
    await recordOwner({ controllerPid: 2147483647, controllerHostHash: currentProcessSpaceHash(),
      controllerProcessStartedAt: new Date(Date.now() - 600_000) });
    const event = (eventType: string) => ({ eventType, envelope: { ...identity, payload: {
      schema: "paperclip.prp.event.v1", eventType, runId: identity.runId, normalizedSessionId: identity.normalizedSessionId,
      sourceInstanceId: identity.runnerInstanceId, sourceKind: "runner", payload: {},
    } } });
    const completed = event("turn.completed");
    const control = { identity, commands: [{ type: "turn.start", status: "completed" }], committedEvents: [completed] };
    const readControlState = () => control;
    const authorized = provider.kind === "pi_rpc" && "conversationMode" in provider;
    await expect(inspect()).resolves.not.toBeNull();
    if (!authorized) {
      await expect(inspect({ readControlState })).rejects.toThrow("warm_recovery_refused=journal_unsettled");
      return;
    }
    const recovered = await inspect({ readControlState });
    expect(recovered?.identity).toEqual(identity);
    expect(recovered?.checkpoint).toBe(checkpoint);
    expect(recovered?.reuseProcess).toBe(true);
    for (const unsettled of [
      { ...control, commands: [{ type: "turn.start", status: "pending" }] },
      { ...control, committedEvents: [completed, event("turn.started")] },
      { ...control, identity: { ...identity, runnerInstanceId: "other" } },
      { ...control, committedEvents: [{ ...completed, envelope: { ...completed.envelope, turnId: "other" } }] },
    ]) await expect(inspect({ readControlState: () => unsettled })).rejects.toThrow("warm_recovery_refused=journal_unsettled");
    for (const unsettled of [
      { ...checkpoint, activeTurnId: identity.turnId },
      { ...checkpoint, pendingRuntimeRequests: [{ requestId: "pending", requestKind: "user_input" as const, method: "input",
        turnId: identity.turnId, itemId: identity.itemId, status: "pending" as const, prompt: "Continue?", details: {} }] },
    ]) await expect(inspect({ readControlState, loadCheckpoint: () => unsettled })).rejects.toThrow("warm_recovery_refused=checkpoint_unsettled");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, fixture.scope.runId));
    await expect(inspect({ readControlState })).rejects.toThrow("warm_recovery_refused=owner_unsettled");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, fixture.scope.runId));
    await recordOwner({ resultId: null });
    await expect(inspect({ readControlState })).rejects.toThrow("warm_recovery_refused=owner_unsettled");
  });

  it.each([
    { conversationMode: true, completed: true, settled: true },
    { conversationMode: true, completed: false, settled: false },
    { conversationMode: false, completed: true, settled: false },
  ])("settles a held turn after an earlier Runner terminal only for a completed Pi conversation: %j", async row => {
    const { identity, checkpoint, inspect, recordOwner } = await seedWarmFollowUpOnOldServer({
      kind: "pi_rpc", model: "example/model", ...(row.conversationMode ? { conversationMode: true } : {}),
    });
    await recordOwner({ controllerPid: 2147483647, controllerHostHash: currentProcessSpaceHash(),
      controllerProcessStartedAt: new Date(Date.now() - 600_000) });
    const event = (eventType: string) => ({ eventType, envelope: { ...identity, payload: {
      schema: "paperclip.prp.event.v1", eventType, runId: identity.runId, normalizedSessionId: identity.normalizedSessionId,
      sourceInstanceId: identity.runnerInstanceId, sourceKind: "runner", payload: {},
    } } });
    const committedEvents = [event("run.terminal"), event("turn.started"),
      ...(row.completed ? [event("turn.completed")] : [])];
    const readControlState = () => ({ identity, commands: [{ type: "turn.start", status: "completed" }], committedEvents });
    if (!row.settled) {
      await expect(inspect({ readControlState })).rejects.toThrow("warm_recovery_refused=journal_unsettled");
      return;
    }
    const recovered = await inspect({ readControlState });
    expect(recovered?.identity).toEqual(identity);
    expect(recovered?.checkpoint).toBe(checkpoint);
    expect(recovered?.reuseProcess).toBe(true);
  });
});
