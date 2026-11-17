import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
  nativeRunFinalizations, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { UNRESTORED_FILES_NEXT_ACTION } from "../legacy-execution-recovery.js";
import { requestTaskRetry } from "../task-retry.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";

// retry-fold4 (rf-3 finding A, judge R8 general): the Retry API reads the ONE
// authority's decision. Every Retry the card does not offer, a fresh click OR
// an idempotent repeat, is refused with the card's one instruction; nothing
// is accepted that no run will follow. requestTaskRetry is what
// POST /api/issues/:id/retry calls (routes/issues.ts requestTaskRetry).
const HELD_NOTICE = "Your message and saved work are kept, but this conversation cannot continue. Assign this agent a new task to continue.";
const PAUSED = "This agent is paused. Resume this agent to continue. Your message and saved work are kept.";

describe("retry fold 4: the Retry API refuses every Retry the card does not offer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retry-fold4-api-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry fold 4", defaultResponsibleUserId: "board", issuePrefix: `G${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Daily work", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
      startedAt: new Date("2026-11-14T02:00:00Z"), finishedAt: new Date("2026-11-14T02:01:00Z"), processPid: 999999999,
      errorCode: "native_session_interrupted", contextSnapshot: { issueId }, resultJson: {} });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure",
      failureCode: "native_session_interrupted", failureDetail: { providerSessionEstablished: true, providerEventsExist: true } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_continuation_requires_reconciliation", status: "resolved", outcome: "blocked", ownerType: "board",
      fingerprint: `native-workspace:${runId}`, resolvedAt: new Date(), nextAction: UNRESTORED_FILES_NEXT_ACTION,
      evidence: { runId, continuationDelivery: "invalidated", automaticRecovery: { policy: "preserve_without_replay_v1",
        runId, replay: "blocked", actionOutcome: "unknown" }, workspaceRecovery: { schema: "paperclip.workspace-recovery.v1",
        runId, status: "recovered", stage: "saving_receipts", attempt: 1, requestIds: [] } } });
    const issue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    return { companyId, agentId, issueId, runId, issue };
  }
  const retry = (f: Awaited<ReturnType<typeof seed>>, idempotencyKey = randomUUID()) => requestTaskRetry({ db,
    companyId: f.companyId, issueId: f.issueId, actorId: "board", actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey });

  it("R8/A: a Retry while the assignee is PAUSED is refused with the card's one instruction (Resume), nothing saved", async () => {
    const f = await seed();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const card = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(card).toMatchObject({ canRetry: false, nextAction: PAUSED });
    const before = await db.select().from(agentWakeupRequests);
    await expect(retry(f)).rejects.toMatchObject({ status: 409,
      details: { code: "retry_not_available", reason: "agent_paused", userAction: "resume", nextAction: "Resume this agent to continue." } });
    expect(await db.select().from(agentWakeupRequests)).toEqual(before);
    const presentation = await taskInterruptionPresentation(db, await f.issue());
    expect(presentation).toMatchObject({ canRetry: false, userAction: "resume" });
  });

  it("R8/A: an idempotent REPEAT of an unrun Retry, after the conversation became held, is refused (no replayed 'accepted')", async () => {
    const f = await seed();
    const key = randomUUID();
    const first = await retry(f, key);
    expect(first).toMatchObject({ accepted: true });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wake?.runId ?? null).toBeNull();
    // The executor's durable HELD notice lands: the same thread meets the same fence.
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system", body: HELD_NOTICE,
      metadata: { version: 1, authorizationReason: `native_prior_owner_held:${randomUUID()}`,
        sections: [{ rows: [{ type: "run_link", runId: f.runId, agentId: f.agentId }] }] } });
    const card = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(card?.canRetry).toBe(false);
    await expect(retry(f, key)).rejects.toMatchObject({ status: 409,
      details: { code: "retry_not_available", reason: "conversation_held", userAction: "new_task",
        nextAction: "Assign this agent a new task to continue." } });
  });

  it("R8: an idempotent repeat of a Retry that already got its run still answers accepted (truthful replay)", async () => {
    const f = await seed();
    const key = randomUUID();
    expect(await retry(f, key)).toMatchObject({ accepted: true });
    expect(await retry(f, key)).toMatchObject({ accepted: true });
  });
});
