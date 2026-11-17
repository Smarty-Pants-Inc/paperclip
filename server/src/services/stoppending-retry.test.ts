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
});
