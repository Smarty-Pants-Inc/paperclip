// A person's Retry after a Stop must end in an answer or never be offered.
// Shapes (gate 1, d2badcf4/f9d12fa5d):
// A  a managing agent's cancel leaves an escalated execution_stop_pending
//    record (not a reconciliation cause), so admission's task-Retry refusal is
//    swallowed (no blocker) and the Retry dispatches ungated into a doomed run.
// C  a person's own Stop, Retry ~1 s later: the stopped run still holds the
//    task (no hold yet), so the Retry dispatches ungated; the hold written a
//    moment later cancels the queued successor and the Retry is consumed.
// The contract: while the previous run's Stop is unproven the Retry WAITS
// visibly (execution_settling); after a 5-minute bound it is retired with the
// one instruction "assign this agent a new task" (card = transcript), the API
// refuses further Retries with that reason and canRetry is false.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { requestTaskRetry } from "./task-retry.js";
import { recordTaskStopPending } from "./recovery/stop-pending.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { agentTaskSessions, environmentLeases, environments } from "@paperclipai/db";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { PI_CONVERSATION_KEY, selectPiConversation } from "./native-runtime/pi-conversation-record.js";

const SIX_MINUTES = 6 * 60_000;
const INSTRUCTION = "assign this agent a new task";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Retry after a Stop never dead-ends", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("stoppending-retry-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(shape: "A" | "C") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop then Retry", defaultResponsibleUserId: "board",
      issuePrefix: `S${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer the person", status: shape === "A" ? "blocked" : "in_progress",
      assigneeAgentId: agentId });
    const now = Date.now();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: shape === "A" ? "failed" : "cancelled", errorCode: shape === "A" ? "native_session_interrupted" : "cancelled",
      nativeSessionId: randomUUID(), contextSnapshot: { issueId }, createdAt: new Date(now - 180_000),
      startedAt: new Date(now - 170_000), finishedAt: new Date(now - 2_000),
      resultJson: shape === "C" ? { operatorInterrupted: true, interruptedByActorType: "user", interruptedByActorId: "board" } : {} });
    if (shape === "A") {
      // The same-run resume lane: the coordinator still owns the run.
      await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "retryable_failure", attempt: 1,
        recoveryMode: "exact_checkpoint_resume", nextAttemptAt: new Date(now + 30_000) } as typeof nativeRunFinalizations.$inferInsert);
      await db.transaction(tx => recordTaskStopPending(tx as unknown as typeof db, { companyId, issueId, runIds: [sourceRunId],
        source: "stale_lock_sweep" }, []));
    } else {
      // The person's Stop was requested; the run still holds the task while its
      // native stop settles, so no hold exists yet.
      await db.update(issues).set({ executionRunId: sourceRunId, executionLockedAt: new Date(now - 170_000) })
        .where(eq(issues.id, issueId));
    }
    return { companyId, agentId, issueId, sourceRunId };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;
  const press = (f: Fixture) => requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
    idempotencyKey: randomUUID(), observedRunId: f.sourceRunId });
  async function admit(f: Fixture, requestId: string) {
    let blockedWith: { reason: string; message: string } | null = null;
    const admitted = await admitExplicitNativeContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      actorType: "user", actorId: "board", reason: "task_retry", commentId: null, successorRunId: randomUUID(),
      taskRetryRequestId: requestId, onBlocked: (reason, message) => { blockedWith = { reason, message }; } });
    return { admitted, blockedWith: blockedWith as { reason: string; message: string } | null };
  }
  const age = async (f: Fixture, requestId?: string) => {
    const past = new Date(Date.now() - SIX_MINUTES);
    if (requestId) await db.update(agentWakeupRequests).set({ requestedAt: past }).where(eq(agentWakeupRequests.id, requestId));
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    if (action?.evidence.stopPending) await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence,
      stopPending: { ...(action.evidence.stopPending as object), checkedAt: past.toISOString() } } })
      .where(eq(issueRecoveryActions.id, action.id));
  };
  const notes = (f: Fixture) => db.select().from(issueComments)
    .where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));

  it.each(["A", "C"] as const)("%s: a Retry pressed while the previous run's Stop is unproven waits visibly, never dispatches ungated", async shape => {
    const f = await seed(shape);
    const receipt = await press(f);
    expect(receipt.accepted).toBe(true);
    const { admitted, blockedWith } = await admit(f, receipt.requestId!);
    expect(admitted).toBeNull();
    // Base: null with no onBlocked call = queue dispatches an ordinary run.
    expect(blockedWith?.reason).toBe("execution_settling");
  });

  it.each(["A", "C"] as const)("%s: when no Stop proof arrives within the bound, the waiting Retry is retired with the one instruction (card = transcript)", async shape => {
    const f = await seed(shape);
    const receipt = await press(f);
    await age(f, receipt.requestId!);
    const { admitted, blockedWith } = await admit(f, receipt.requestId!);
    expect(admitted).toBeNull();
    expect(blockedWith?.reason).toBe("execution_stop_unproven");
    expect(blockedWith?.message).toContain(INSTRUCTION);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    expect(wake!.status).toBe("failed");
    const said = (await notes(f)).filter(note => note.body === blockedWith!.message);
    expect(said).toHaveLength(1);
    // A replay of the admission does not add a second note.
    await admit(f, receipt.requestId!);
    expect((await notes(f)).filter(note => note.body === blockedWith!.message)).toHaveLength(1);
    // Card: the same words, no Retry offered.
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const card = await taskInterruptionPresentation(db, issue!);
    expect(card?.canRetry).toBe(false);
    expect(card?.retryWait?.message).toBe(blockedWith!.message);
  });

  it("A: past the bound with the Stop still unproven, the API refuses Retry with a reason and the card offers none", async () => {
    const f = await seed("A");
    await age(f);
    await expect(press(f)).rejects.toMatchObject({ status: 409, details: { code: "execution_stop_unproven" } });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const card = await taskInterruptionPresentation(db, issue!);
    expect(card?.canRetry).toBe(false);
    expect(card?.retryWait?.message).toContain(INSTRUCTION);
  });

  it("A: once the Stop is proved inside the bound, the waiting Retry is no longer held by the stop gate", async () => {
    const f = await seed("A");
    const receipt = await press(f);
    const { clearTaskStopPending } = await import("./recovery/stop-pending.js");
    await db.transaction(tx => clearTaskStopPending(tx as unknown as typeof db, { companyId: f.companyId, issueId: f.issueId,
      runIds: [f.sourceRunId] }, []));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", nextAttemptAt: null })
      .where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    const { blockedWith } = await admit(f, receipt.requestId!);
    expect(blockedWith?.reason).not.toBe("execution_settling");
    expect(blockedWith?.reason).not.toBe("execution_stop_unproven");
  });
  it("A: after the Stop is proved, a Retry that preparation (not admission) routes to a fresh isolated workspace opens a NEW provider thread, keeping saved history", async () => {
    const f = await seed("A");
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    const sessionId = source!.nativeSessionId!;
    // The old box was remote: nothing task-owned can be reused.
    const [environment] = await db.insert(environments).values({ name: `box-${f.sourceRunId}`, driver: "sandbox" }).returning();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId, environmentId: environment!.id,
      issueId: f.issueId, provider: "daytona", providerLeaseId: "sandbox-a", status: "released", leasePolicy: "ephemeral",
      releasedAt: new Date(), cleanupStatus: "success" });
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, adapterType: "paperclip_runner",
      taskKey: f.issueId, lastRunId: f.sourceRunId, sessionParamsJson: { sessionId, [PI_CONVERSATION_KEY]: {
        schema: "paperclip.pi-conversation.v1", id: sessionId, generation: 1, previousId: null, reason: "first_message",
        runId: f.sourceRunId, boundary: { provider: "pi_rpc", cwd: "/workspaces/old-box", remoteCwd: null, workspaceId: null, trust: "trust" } } } });
    const { clearTaskStopPending } = await import("./recovery/stop-pending.js");
    await db.transaction(tx => clearTaskStopPending(tx as unknown as typeof db, { companyId: f.companyId, issueId: f.issueId,
      runIds: [f.sourceRunId] }, []));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", nextAttemptAt: null })
      .where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    const receipt = await press(f);
    // No hold: admission has no explicit continuation and the queue starts an ordinary run for the Retry.
    const { admitted } = await admit(f, receipt.requestId!);
    expect(admitted).toBeNull();
    const successorRunId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: successorRunId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", invocationSource: "on_demand",
      contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry", forceFreshSession: true, previousRunId: f.sourceRunId,
        taskRetryRequestId: receipt.requestId } }).returning();
    await db.update(agentWakeupRequests).set({ status: "coalesced", runId: successorRunId })
      .where(eq(agentWakeupRequests.id, receipt.requestId!));
    expect(await readFreshWorkspaceReadiness(db, run!)).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.sourceRunId });
    const select = () => selectPiConversation(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: successorRunId, boundary: { provider: "pi_rpc", cwd: "/workspaces/new-box", remoteCwd: null, workspaceId: null, trust: "trust" } });
    const conversation = await select();
    // Base: the old id, restored into the new scope -> prior_owner_scope_mismatch.
    expect(conversation.id).not.toBe(sessionId);
    expect(conversation).toMatchObject({ previousId: sessionId, runId: successorRunId, generation: 2,
      reason: expect.stringMatching(/^fresh_continuation:/) });
    expect(await select()).toEqual(conversation);
    const fresh = (await notes(f)).filter(note => String(note.metadata?.authorizationReason ?? "").startsWith("fresh_provider_thread:"));
    expect(fresh).toHaveLength(1);
  }, 60_000);
  it("E-C01: a second Retry naming the cancelled never-started successor, after everything settled, never restores the old thread into a new box", async () => {
    const f = await seed("C");
    const now = Date.now();
    const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    const sessionId = original!.nativeSessionId!;
    // Everything settled: the person's Stop run released the task, its coordinator is terminal, its lease released.
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null, status: "blocked" }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ createdAt: new Date(now - 700_000), startedAt: new Date(now - 690_000),
      finishedAt: new Date(now - 600_000) }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(nativeRunFinalizations).values({ runId: f.sourceRunId, companyId: f.companyId, issueId: f.issueId,
      phase: "terminal_failure", attempt: 1 } as typeof nativeRunFinalizations.$inferInsert);
    const [environment] = await db.insert(environments).values({ name: `box-${f.sourceRunId}`, driver: "sandbox" }).returning();
    const identity = { id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.sourceRunId, provider: "daytona", providerLeaseId: "sandbox-c" };
    await db.insert(environmentLeases).values({ ...identity, environmentId: environment!.id,
      issueId: f.issueId, status: "released", leasePolicy: "ephemeral", releasedAt: new Date(now - 590_000), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId: "sandbox-c", state: "destroyed" }) } });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board", returnOwnerAgentId: f.agentId,
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${f.sourceRunId}`,
      evidence: { runId: f.sourceRunId, originalFailureCode: "cancelled" },
      nextAction: "The run stopped before it finished. Paperclip continues the task from its last saved work.", maxAttempts: 3 }).returning();
    // The automatic successor the hold cancelled before it started (dfe91312's shape).
    const staleId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: staleId, companyId: f.companyId, agentId: f.agentId, status: "cancelled",
      invocationSource: "automation", contextSnapshot: { issueId: f.issueId }, createdAt: new Date(now - 580_000),
      finishedAt: new Date(now - 570_000), errorCode: "execution_reconciliation_required", error: "held",
      resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
        executionWait: { issueId: f.issueId, recoveryActionId: hold!.id } } });
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, adapterType: "paperclip_runner",
      taskKey: f.issueId, lastRunId: f.sourceRunId, sessionParamsJson: { sessionId, [PI_CONVERSATION_KEY]: {
        schema: "paperclip.pi-conversation.v1", id: sessionId, generation: 1, previousId: null, reason: "first_message",
        runId: f.sourceRunId, boundary: { provider: "pi_rpc", cwd: "/workspaces/old-box", remoteCwd: null, workspaceId: null, trust: "trust" } } } });
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      idempotencyKey: randomUUID(), observedRunId: staleId });
    expect(receipt.accepted).toBe(true);
    const successorRunId = randomUUID();
    let blockedWith: string | null = null;
    const admitted = await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      const continuation = await admitExplicitNativeContinuation({ db: tx as unknown as typeof db, companyId: f.companyId,
        issueId: f.issueId, agentId: f.agentId, actorType: "user", actorId: "board", reason: "task_retry", commentId: null,
        successorRunId, taskRetryRequestId: receipt.requestId!, onBlocked: (reason, message) => { blockedWith = `${reason}: ${message}`; } });
      if (continuation || !blockedWith) await tx.insert(heartbeatRuns).values({ id: successorRunId, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, runtimeMode: "native", status: "queued", invocationSource: "on_demand",
        contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry", forceFreshSession: true, taskRetryRequestId: receipt.requestId,
          previousRunId: continuation?.previousRunId ?? staleId, ...(continuation ? { explicitUserContinuation: continuation } : {}) } });
      return continuation;
    });
    // A Retry that is held is a visible wait, never a dead end: the card names it.
    if (blockedWith) throw new Error(`E-C01 Retry held: ${blockedWith}`);
    await db.update(agentWakeupRequests).set({ status: "coalesced", runId: successorRunId }).where(eq(agentWakeupRequests.id, receipt.requestId!));
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successorRunId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorRunId));
    const readiness = admitted?.readiness ?? await readFreshWorkspaceReadiness(db, run!);
    const conversation = await selectPiConversation(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: successorRunId, boundary: { provider: "pi_rpc", cwd: "/workspaces/new-box", remoteCwd: null, workspaceId: null, trust: "trust" } });
    // In a new box the old provider thread is never restored (prior_owner_scope_mismatch); saved history moves with a recorded rotation.
    expect(readiness?.mode).toBe("fresh_isolated_workspace");
    expect(conversation.id).not.toBe(sessionId);
    expect(conversation).toMatchObject({ previousId: sessionId, generation: 2, reason: expect.stringMatching(/^fresh_continuation:/) });
  }, 60_000);
});
