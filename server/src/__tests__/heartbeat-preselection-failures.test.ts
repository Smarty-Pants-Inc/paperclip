// Keep reason: #20606 and D11's pre-dispatch failure path cannot cheaply be
// reached by a live user flow. Queue, claims, settlement and PostgreSQL are real.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { isTransientWorkspacePreparationCode } from "../services/heartbeat/retries.js";
import { nativeRestartFixture } from "./helpers/native-restart-fixture.js";

const fault = vi.hoisted(() => ({ phase: "none", reached: false, backendPid: 0 }));
vi.mock("../services/heartbeat/instruction-working-copy.js", async original => {
  const actual = await original<typeof import("../services/heartbeat/instruction-working-copy.js")>();
  return { ...actual, createHeartbeatInstructionWorkingCopy: (...args: Parameters<typeof actual.createHeartbeatInstructionWorkingCopy>) => {
    const copy = actual.createHeartbeatInstructionWorkingCopy(...args);
    const prepare = copy.prepare.bind(copy);
    copy.prepare = async input => {
      const result = await prepare(input);
      if (fault.phase === "instruction_prep") {
        fault.reached = true;
        throw new Error("d11d_instruction_copy_fault");
      }
      return result;
    };
    return copy;
  } };
});
vi.mock("../services/native-runtime/native-session-resume.js", async original => {
  const actual = await original<typeof import("../services/native-runtime/native-session-resume.js")>();
  return { ...actual, prepareNativeSessionBootstrapPersistence: async (...args: Parameters<typeof actual.prepareNativeSessionBootstrapPersistence>) => {
    const result = await actual.prepareNativeSessionBootstrapPersistence(...args);
    if (["selection_txn", "selection_disconnect"].includes(fault.phase)) {
      fault.reached = true;
      if (fault.phase === "selection_disconnect") {
        // The public bootstrap helper needs only select; this call is inside
        // the real selection transaction, whose full DB surface is available.
        const tx = args[0] as ReturnType<typeof createDb>;
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        fault.backendPid = backend!.pid;
        await tx.execute(sql`select pg_terminate_backend(pg_backend_pid())`);
      }
      throw new Error("d11d_selection_transaction_fault");
    }
    return result;
  } };
});
vi.mock("../services/fresh-workspace-continuation.js", async original => {
  const actual = await original<typeof import("../services/fresh-workspace-continuation.js")>();
  return { ...actual, readFreshWorkspaceReadiness: async (...args: Parameters<typeof actual.readFreshWorkspaceReadiness>) => {
    const result = await actual.readFreshWorkspaceReadiness(...args);
    if (fault.phase === "workspace_prep" && args[1].contextSnapshot?.freshContinuationIsolation) {
      fault.reached = true;
      throw new Error("d11d_workspace_fault");
    }
    return result;
  } };
});

describe("pre-selection failure settlement and unresolved runtime reasons", () => {
  const fixture = nativeRestartFixture({});
  async function restoredTask(db: ReturnType<typeof createDb>, heartbeat: ReturnType<typeof heartbeatService>, body = "Please continue my daily task.", delivery: "restored" | "person" = "restored") {
    const { companyId, agentId } = fixture.current;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const [issue] = await db.insert(issues).values({ companyId, title: "Continue after recovery", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active" }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id,
      authorType: "user", authorUserId: userId, body }).returning();
    if (delivery === "person") {
      const run = await heartbeat.wakeup(agentId, { source: "automation", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: userId,
        payload: { issueId: issue!.id, commentId: message!.id },
        contextSnapshot: { issueId: issue!.id, commentId: message!.id, wakeReason: "issue_commented" } });
      expect(run).toBeDefined();
      return { issueId: issue!.id, runId: run!.id };
    }
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id,
      invocationSource: "on_demand", status: "failed", errorCode: "process_lost", finishedAt: new Date(),
      contextSnapshot: { issueId: issue!.id, wakeCommentId: message!.id } }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue!.id,
      kind: "active_run_watchdog", status: "resolved", ownerType: "system", returnOwnerAgentId: agentId,
      cause: "process_lost", fingerprint: randomUUID(), nextAction: "Continue the task", outcome: "restored",
      evidence: { continuationDelivery: "pending", executionReconciliation: { runId: source!.id,
        providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "No provider process started." },
        freshContinuation: { isolation: "fresh_isolated_workspace", sourceRunId: source!.id } } });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source!.id));
    expect(run).toBeDefined();
    return { issueId: issue!.id, runId: run!.id };
  }

  it.each([
    ["instruction_prep", "instruction_preparation_failed"],
    ["selection_txn", "runtime_selection_failed"],
    ["selection_disconnect", "setup_connection_lost"],
  ])("settles %s on fresh owners, with a bounded retry and exactly one note", async (phase, code) => {
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const provider = vi.fn(() => { throw new Error("provider must not start before selection commits"); });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: provider });
    fault.phase = phase; fault.reached = false; fault.backendPid = 0;
    try {
      const { runId, issueId } = await restoredTask(db, heartbeat);
      await heartbeat.drainActiveRunExecutions();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [agent] = await db.select().from(agents).where(eq(agents.id, run!.agentId));
      const coordinators = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      const notes = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
      const observedNotes = await notes();
      console.info("D11D_FAILURE_PROOF", JSON.stringify({ phase, reached: fault.reached, backendPid: fault.backendPid,
        run: { id: runId, status: run?.status, errorCode: run?.errorCode, reason: run?.runtimeModeReason,
          mode: run?.runtimeMode, resolvedAt: run?.runtimeModeResolvedAt, result: run?.resultJson },
        claim: issue?.executionRunId, agentStatus: agent?.status, coordinatorCount: coordinators.length,
        successors: successors.map(row => ({ id: row.id, status: row.status, scheduledRetryAt: row.scheduledRetryAt })),
        notes: observedNotes.map(row => ({ id: row.id, body: row.body })) }));
      expect(fault.reached, "must reach the intended real preparation/transaction boundary").toBe(true);
      expect(provider).not.toHaveBeenCalled();
      expect(run).toMatchObject({ status: "failed", errorCode: code, runtimeMode: "legacy", runtimeModeResolvedAt: null,
        runtimeModeReason: `not_selected_run_ended_before_selection:${phase === "selection_disconnect" ? "selection_txn" : phase}`,
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
      expect(isTransientWorkspacePreparationCode(code)).toBe(true);
      expect(agent!.status).not.toBe("running");
      expect(issue!.checkoutRunId).toBeNull();
      expect(issue!.executionRunId).not.toBe(runId);
      expect(coordinators).toHaveLength(0); // transaction bootstrap must roll back
      expect(successors).toEqual([expect.objectContaining({ status: "scheduled_retry", scheduledRetryAt: expect.any(Date) })]);
      expect(observedNotes).toHaveLength(1);
      await settleUnansweredPersonMessage(db, { companyId: fixture.current.companyId, issueId });
      expect(await notes()).toHaveLength(1);
    } finally { fault.phase = "none"; await heartbeat.drainActiveRunExecutions(); await db.$client.end(); }
  }, 45_000);

  it("records workspace_prep for the existing outer setup-failure path", async () => {
    const db = createDb(fixture.current.temporary.connectionString);
    const heartbeat = heartbeatService(db);
    fault.phase = "workspace_prep"; fault.reached = false;
    try {
      const { runId } = await restoredTask(db, heartbeat);
      await heartbeat.drainActiveRunExecutions();
      expect(fault.reached).toBe(true);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run).toMatchObject({ status: "failed", runtimeMode: "legacy", runtimeModeResolvedAt: null,
        runtimeModeReason: "not_selected_run_ended_before_selection:workspace_prep" });
    } finally { fault.phase = "none"; await heartbeat.drainActiveRunExecutions(); await db.$client.end(); }
  });

  it("keeps the selection phase when real cancellation wins the native-selection fence", async () => {
    const db = createDb(fixture.current.temporary.connectionString);
    const provider = vi.fn(() => { throw new Error("provider must not start"); });
    let reachedSelection = false;
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: provider,
      beforeNativeRuntimeSelection: async runId => { reachedSelection = true; await heartbeat.cancelRun(runId); } });
    try {
      const { runId } = await restoredTask(db, heartbeat);
      await heartbeat.drainActiveRunExecutions();
      expect(reachedSelection).toBe(true);
      expect(await heartbeat.getRun(runId)).toMatchObject({ status: "cancelled", runtimeMode: "legacy",
        runtimeModeResolvedAt: null, runtimeModeReason: "not_selected_run_ended_before_selection:selection_txn" });
      expect(provider).not.toHaveBeenCalled();
      expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).toHaveLength(0);
    } finally { await heartbeat.drainActiveRunExecutions(); await db.$client.end(); }
  });

  it("explains a real successful conversation-reset no-op before workspace preparation", async () => {
    const db = createDb(fixture.current.temporary.connectionString);
    const provider = vi.fn(() => { throw new Error("provider must not start"); });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: provider });
    try {
      const { runId } = await restoredTask(db, heartbeat, "/new", "person");
      await heartbeat.drainActiveRunExecutions();
      expect(await heartbeat.getRun(runId)).toMatchObject({ status: "succeeded", runtimeMode: "legacy",
        runtimeModeResolvedAt: null, runtimeModeReason: "not_selected_run_ended_before_selection:workspace_prep",
        resultJson: { conversationReset: true } });
      expect(provider).not.toHaveBeenCalled();
    } finally { await heartbeat.drainActiveRunExecutions(); await db.$client.end(); }
  });

  it.each(["workspace_prep", "instruction_prep", "selection_txn"])("preserves %s on cancellation and a successful no-op without selecting legacy", async phase => {
    const db = createDb(fixture.current.temporary.connectionString);
    try {
      for (const status of ["cancelled", "succeeded"]) {
        const [run] = await db.insert(heartbeatRuns).values({ companyId: fixture.current.companyId, agentId: fixture.current.agentId,
          invocationSource: "on_demand", status: "running", runtimeModeReason: `not_selected_preparing:${phase}` }).returning();
        const ended = await terminalizeLegacyExecution({ db, run: run!, status, reconcileIfNeeded: true,
          patch: { finishedAt: new Date(), resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } } });
        expect(ended).toMatchObject({ status, runtimeMode: "legacy", runtimeModeResolvedAt: null,
          runtimeModeReason: `not_selected_run_ended_before_selection:${phase}` });
      }
    } finally { await db.$client.end(); }
  });

  it("gives an unclaimed cancellation a reason and does not rewrite a real direct choice", async () => {
    const db = createDb(fixture.current.temporary.connectionString);
    try {
      for (const resolvedAt of [null, new Date()]) {
        const [run] = await db.insert(heartbeatRuns).values({ companyId: fixture.current.companyId, agentId: fixture.current.agentId,
          invocationSource: "on_demand", status: "queued", runtimeModeReason: resolvedAt ? "direct_adapter" : null,
          runtimeModeResolvedAt: resolvedAt }).returning();
        const ended = await terminalizeLegacyExecution({ db, run: run!, status: "cancelled", reconcileIfNeeded: true,
          patch: { finishedAt: new Date(), resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } } });
        expect(ended).toMatchObject({ status: "cancelled", runtimeMode: "legacy", runtimeModeResolvedAt: resolvedAt,
          runtimeModeReason: resolvedAt ? "direct_adapter" : "not_selected_run_ended_before_selection:workspace_prep" });
      }
    } finally { await db.$client.end(); }
  });
});
