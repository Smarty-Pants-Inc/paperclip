import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys, agents, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases,
  heartbeatRuns, issues, nativeRunFinalizations, principalPermissionGrants, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PersistedNativeSession, PrpEvent } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";

// Fork c7c35bbc lets an authorized managing agent Stop a run in its reporting
// subtree (POST /heartbeat-runs/:runId/cancel). That Stop must settle like the
// person's Stop button: a cancelled native turn with no semantic result is an
// intentional Stop, never failed/native_session_interrupted with a same-run
// retry (cancel-retry-read.md section 5). Real bearer authentication, lifecycle
// authority, cancel route, native executor, Stop ACK and Postgres. Only the
// provider process is replaced; it never reaches a real model.
const provider = vi.hoisted(() => ({ execute: vi.fn() }));
const stopGate = vi.hoisted(() => ({ afterAck: null as null | (() => Promise<void>) }));
vi.mock("../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
// Holds the route's Stop after its native ACK, so the executor's cancellation
// recovery can settle first (the second settlement order).
vi.mock("../services/native-runtime/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/index.js")>();
  return { ...actual, cancelNativeSession: (async (...args: Parameters<typeof actual.cancelNativeSession>) => {
    const result = await actual.cancelNativeSession(...args);
    if (stopGate.afterAck) await stopGate.afterAck();
    return result;
  }) as typeof actual.cancelNativeSession };
});
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";
import { executePaperclipNativeSession, NativeCancellationPendingRecoveryError } from "../services/native-runtime/native-session-executor.js";
import { buildNativeCompletionContract } from "../services/native-runtime/completion-contracts.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { claimNativeSessionResumptions } from "../services/native-runtime/native-finalization-reconciler.js";
import { executionProjectionForRun } from "../services/execution-projection.js";
import { acknowledgedNativeStopExecutionHasStopped, hasAcknowledgedNativeStopIntent, isAcknowledgedNativeStop } from "../services/acknowledged-native-stop.js";

describe("managing-agent native Stop settles as an intentional Stop", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  beforeAll(async () => {
    home = createIsolatedTestHome();
    vi.stubEnv("PAPERCLIP_HOME", home.home);
    database = await startEmbeddedPostgresTestDatabase("managing-agent-native-stop-");
    db = createDb(database.connectionString);
    // Accepted work is fenced durably; no adapter or background job launches.
    closeProcessRunAdmission();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    resetProcessRunAdmissionForTests();
    home?.cleanup();
    vi.unstubAllEnvs();
  });

  async function fixture(grant: "configure" | "suggest" = "configure") {
    const companyId = randomUUID(), userId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const ids = { manager: randomUUID(), lead: randomUUID(), worker: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Managed Stop", issuePrefix: `M${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Board owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    for (const name of ["manager", "lead", "worker"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId, name, role: "engineer", status: "idle", lifecycleState: "ready",
        reportsTo: name === "lead" ? ids.manager : name === "worker" ? ids.lead : null,
        ...(name === "worker"
          ? { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model", cwd: home.home } }
          : { adapterType: "process" }),
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...Object.values(ids).map(principalId => ({ companyId, principalType: "agent" as const, principalId,
        membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(principalPermissionGrants).values([
      ...["agents:configure", "agents:create", "agents:read", "agent:wake"].map(permissionKey => ({
        companyId, principalType: "user" as const, principalId: userId, permissionKey })),
      { companyId, principalType: "agent", principalId: ids.lead, permissionKey: "agents:read" },
      { companyId, principalType: "agent", principalId: ids.lead,
        permissionKey: grant === "suggest" ? "agents:suggest-changes" : "agents:configure", scope: { subtreeRootAgentId: ids.lead } },
    ]);
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: ids.lead, name: "Lead key", responsibleUserId: userId,
      keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express(); api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentRoutes(db)); api.use(errorHandler);

    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Worker task", status: "in_progress",
      assigneeAgentId: ids.worker, responsibleUserId: userId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ids.worker, status: "running",
      runtimeMode: "native", nativeIssueId: issueId, issueId, scopeKind: "issue", contextSnapshot: { issueId },
      invocationSource: "on_demand" }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId: ids.worker, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Work the task.", workMode: "standard" },
      workspace: { cwd: home.home, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const cancel = () => request(api).post(`/api/heartbeat-runs/${runId}/cancel`).set("Authorization", `Bearer ${token}`).send({});
    return { companyId, userId, issueId, runId, ids, native, execution, cancel };
  }

  const readRun = (runId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]!);
  const readOwner = (runId: string) => db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).then(rows => rows[0]!);

  /** The provider turn opens, receives the run-scope Stop, reports
   * turn.cancelled and ends without paperclip_finish. */
  function cancelledTurn(f: Awaited<ReturnType<typeof fixture>>, endTurn: () => Promise<void>) {
    const cancelled = vi.fn(() => ({ cleanup: Promise.resolve() }));
    let opened!: () => void, stopped!: () => void;
    const sessionOpen = new Promise<void>(resolve => { opened = resolve; });
    const stopDelivered = new Promise<void>(resolve => { stopped = resolve; });
    const event = (eventType: string, sourceSeq: number, payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1", runId: f.runId, normalizedSessionId: f.native.normalizedSessionId, turnId: f.native.turnId,
      sourceInstanceId: f.native.runnerInstanceId, sourceEventId: `managed-stop-${sourceSeq}`, sourceSeq,
      sourceKind: "runner", eventType, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload,
    } as PrpEvent);
    provider.execute.mockReset().mockImplementationOnce(async (options: {
      controlPlane: ControlPlanePort; onSession: (session: unknown) => Promise<void>;
    }) => {
      await options.controlPlane.openRun({ identity: { companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        agentId: f.ids.worker, sessionId: f.native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: f.native.runnerInstanceId });
      await options.controlPlane.appendEvent(event("turn.started", 1, {}));
      // Attempt 1 has a valid same-session checkpoint, so an unrecognized Stop
      // would be classified as a resumable interruption (retry_scheduled).
      await options.controlPlane.checkpointSession?.({ backendKind: "mock", sessionId: f.native.normalizedSessionId,
        identity: { companyId: f.companyId, issueId: f.issueId, runId: f.runId, agentId: f.ids.worker, sessionId: f.native.normalizedSessionId },
        providerSessionId: "provider-thread", activeTurnId: f.native.turnId, pendingRuntimeRequests: [], goal: null,
        semanticResult: null, terminal: null } as PersistedNativeSession);
      await options.onSession({ cancel: (...args: unknown[]) => { stopped(); return (cancelled as (...a: unknown[]) => unknown)(...args); },
        close: async () => {} });
      opened();
      await stopDelivered;
      await endTurn();
      await options.controlPlane.appendEvent(event("turn.cancelled", 2, { status: "cancelled" }));
      throw new Error("native_finalization_missing: session returned no semantic result");
    });
    const unexpected = async () => { throw new Error("Unexpected real provider access"); };
    const running = executePaperclipNativeSession({ db, execution: f.execution, runnerInstanceId: f.native.runnerInstanceId,
      backend: { descriptor: unexpected, openSession: unexpected } }).then(() => null, (error: unknown) => error);
    return { running, sessionOpen, cancelled };
  }

  /** heartbeat.ts recovers a durable native cancellation exactly like this when
   * the executor ends with NativeCancellationPendingRecoveryError. */
  async function recoverCancellation(runId: string) {
    return heartbeatService(db).cancelRun(runId, "Recovered durable native run cancellation", { recoverRecordedCancellation: true } as never);
  }

  async function expectIntentionalManagedStop(f: Awaited<ReturnType<typeof fixture>>) {
    const run = await readRun(f.runId);
    // 1. cancelled / operator_interrupted, attributed to the managing agent; no fabricated user.
    expect(run).toMatchObject({ status: "cancelled", errorCode: "operator_interrupted" });
    expect(run.resultJson).toMatchObject({ cancelledByActorType: "agent", cancelledByAgentId: f.ids.lead,
      cancellation: { initiator: { type: "agent", id: f.ids.lead }, reason: "Cancelled by a managing agent" } });
    expect(run.resultJson).not.toHaveProperty("cancelledByUserId");
    expect(run.resultJson?.nativeCancellation).toMatchObject({ runId: f.runId, issueId: f.issueId, companyId: f.companyId,
      scope: "run", dispatchState: "acknowledged", dispatched: true });
    expect(hasAcknowledgedNativeStopIntent(run)).toBe(true);
    // 2. The coordinator settles the Stop; nothing promises a retry.
    expect(await readOwner(f.runId)).toMatchObject({ phase: "terminal_failure", failureCode: "native_retry_cancelled", nextAttemptAt: null });
    const projection = await executionProjectionForRun(db, f.companyId, f.runId);
    expect(projection).toBeTruthy();
    expect(projection?.phase).not.toBe("retry_scheduled");
  }

  async function expectNoContinuation(f: Awaited<ReturnType<typeof fixture>>) {
    const before = await readOwner(f.runId);
    // 3. Later native recovery passes start no second provider turn, create no
    // successor and spend no attempt; no rolling retry promise is written.
    for (const hours of [1, 2]) {
      expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "later-recovery", runIds: [f.runId],
        now: new Date(Date.now() + hours * 3_600_000), deferIneligible: true })).toEqual([]);
    }
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.ids.worker), ne(heartbeatRuns.id, f.runId)))).toEqual([]);
    expect(await readOwner(f.runId)).toMatchObject({ attempt: before.attempt, nextAttemptAt: null, failureCode: "native_retry_cancelled" });
    expect((await readRun(f.runId)).status).toBe("cancelled");
  }

  it("order 1: the route's Stop finalizer settles before native cancellation recovery", async () => {
    const f = await fixture();
    const turn = cancelledTurn(f, async () => {
      await expect.poll(async () => (await readRun(f.runId)).status, { timeout: 10_000 }).toBe("cancelled");
    });
    await turn.sessionOpen;
    const response = await f.cancel();
    expect(response.status, response.text).toBe(200);
    expect(turn.cancelled).toHaveBeenCalledOnce();
    const outcome = await turn.running;
    expect(outcome).toBeInstanceOf(NativeCancellationPendingRecoveryError);
    await recoverCancellation(f.runId);
    await expectIntentionalManagedStop(f);
    await expectNoContinuation(f);
  }, 30_000);

  it("order 2: native cancellation recovery settles before the route's Stop finalizer", async () => {
    const f = await fixture();
    let releaseRoute!: () => void;
    const routeHeld = new Promise<void>(resolve => { releaseRoute = resolve; });
    let ackLanded!: () => void;
    const acked = new Promise<void>(resolve => { ackLanded = resolve; });
    // Hold only the route's Stop; the recovery call below must pass.
    stopGate.afterAck = async () => { stopGate.afterAck = null; ackLanded(); await routeHeld; };
    try {
      const turn = cancelledTurn(f, async () => { await acked; });
      await turn.sessionOpen;
      const response = f.cancel().then(result => result);
      const outcome = await turn.running;
      expect(outcome).toBeInstanceOf(NativeCancellationPendingRecoveryError);
      await recoverCancellation(f.runId);
      expect((await readRun(f.runId)).status).toBe("cancelled");
      stopGate.afterAck = null;
      releaseRoute();
      expect((await response).status).toBe(200);
      await expectIntentionalManagedStop(f);
      await expectNoContinuation(f);
    } finally { stopGate.afterAck = null; releaseRoute(); }
  }, 30_000);

  it("PAUSED before the deadline: still no dispatch, no queued run and no retry promise", async () => {
    const f = await fixture();
    const turn = cancelledTurn(f, async () => {
      await expect.poll(async () => (await readRun(f.runId)).status, { timeout: 10_000 }).toBe("cancelled");
    });
    await turn.sessionOpen;
    expect((await f.cancel()).status).toBe(200);
    expect(await turn.running).toBeInstanceOf(NativeCancellationPendingRecoveryError);
    await recoverCancellation(f.runId);
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.ids.worker));
    await expectIntentionalManagedStop(f);
    await expectNoContinuation(f);
  }, 30_000);

  it("an unauthorized manager's Stop is refused and records no Stop authority", async () => {
    const f = await fixture("suggest");
    const response = await f.cancel();
    expect(response.status).toBe(403);
    const run = await readRun(f.runId);
    expect(run.status).toBe("running");
    expect(run.resultJson ?? {}).not.toHaveProperty("managementStop");
    expect(run.resultJson ?? {}).not.toHaveProperty("cancellation");
    // Even a forged agent attribution plus a bound ACK is not an intentional Stop.
    expect(hasAcknowledgedNativeStopIntent({ ...run, resultJson: { cancelledByActorType: "agent", cancelledByAgentId: f.ids.lead,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: "intent", acknowledgementAuditId: "ack" } } })).toBe(false);
  }, 30_000);

  it("records durable management authority, and unfinished cleanup still holds physical Stop proof", async () => {
    const f = await fixture();
    const turn = cancelledTurn(f, async () => {
      await expect.poll(async () => (await readRun(f.runId)).status, { timeout: 10_000 }).toBe("cancelled");
    });
    await turn.sessionOpen;
    expect((await f.cancel()).status).toBe(200);
    expect(await turn.running).toBeInstanceOf(NativeCancellationPendingRecoveryError);
    const run = await readRun(f.runId);
    expect(run.resultJson?.managementStop).toMatchObject({ schema: "paperclip.management-stop.v1", companyId: f.companyId,
      runId: f.runId, targetAgentId: f.ids.worker, actorAgentId: f.ids.lead });
    // The Stop is intentional, yet a still-held execution lease (cleanup
    // unfinished) or failed cleanup keeps the physical-Stop hold.
    expect(isAcknowledgedNativeStop(run)).toBe(true);
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "local", status: "active", leasePolicy: "ephemeral" });
    expect(await acknowledgedNativeStopExecutionHasStopped(db, run)).toBe(false);
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "failed" })
      .where(eq(environmentLeases.heartbeatRunId, f.runId));
    expect(await acknowledgedNativeStopExecutionHasStopped(db, run)).toBe(false);
  }, 30_000);

  it("lease-release teardown that beats the finalizer keeps the managing agent's Stop and its code", async () => {
    const f = await fixture();
    const fenced = { cancelledByActorType: "agent", cancelledByAgentId: f.ids.lead,
      managementStop: { schema: "paperclip.management-stop.v1", companyId: f.companyId, runId: f.runId,
        targetAgentId: f.ids.worker, actorAgentId: f.ids.lead, authorizedAt: new Date().toISOString() },
      cancellation: { source: "control_plane", expected: true, initiator: { type: "agent", id: f.ids.lead },
        reason: "Cancelled by a managing agent", recordedAt: new Date().toISOString() },
      startupCancellation: { requestedAt: new Date().toISOString(), errorCode: "operator_interrupted", beforeNativeSelection: false },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } };
    const [running] = await db.update(heartbeatRuns).set({ resultJson: fenced }).where(eq(heartbeatRuns.id, f.runId)).returning();
    const terminal = await heartbeatService(db).terminalizeRunOnLeaseRelease(running!);
    expect(terminal).toMatchObject({ status: "cancelled", errorCode: "operator_interrupted" });
    expect(terminal.resultJson).toMatchObject({ cancelledByActorType: "agent", cancelledByAgentId: f.ids.lead,
      cancellation: { initiator: { type: "agent", id: f.ids.lead } } });
    expect(terminal.resultJson).not.toHaveProperty("cancelledByUserId");
  }, 30_000);

  it("heartbeat recovers a durable native cancellation with its recorded code and provenance", () => {
    const source = readFileSync(fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)), "utf8");
    const branch = source.slice(source.indexOf("if (err instanceof NativeCancellationPendingRecoveryError) {"));
    expect(branch.slice(0, branch.indexOf("return;"))).toMatch(/cancelRunInternal\([\s\S]*recoverRecordedCancellation: true/);
  });
});
