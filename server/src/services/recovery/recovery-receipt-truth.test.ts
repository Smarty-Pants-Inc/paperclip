import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { executionProjectionForRun } from "../execution-projection.js";
import { admitExplicitNativeContinuation } from "../explicit-native-continuation.js";
import { UNRESTORED_FILES_NEXT_ACTION } from "../legacy-execution-recovery.js";
import { requestTaskRetry } from "../task-retry.js";

// Keep reason: recorded gate-1 incidents 9165feb0 (Boat network_error before
// any tool) and 076e7441 (board cancel mid-command, no standing HELD notice).
// Exercise the actual card, batched transcript and HTTP recovery-detail reads,
// then the real admission gate for the one action advertised after board Stop.
describe("live recovery receipt truths", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("recovery-receipt-truth-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  function app() {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "board" };
      next();
    });
    result.use("/api", issueRoutes(db, {} as never));
    result.use(errorHandler);
    return result;
  }

  async function seed(status: "failed" | "cancelled") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recorded recovery incident", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Daily work", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status,
      startedAt: new Date("2026-11-14T02:00:00Z"), finishedAt: new Date("2026-11-14T02:01:00Z"),
      // A runner can start before its provider session. Both settled sources
      // have independent dead-process evidence for continuation admission.
      processPid: 999999999,
      errorCode: status === "failed" ? "native_session_interrupted" : "operator_interrupted",
      contextSnapshot: { issueId }, resultJson: status === "cancelled" ? { cancelledByActorType: "board", cancelledByUserId: "board",
        cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "board" },
          reason: "Stopped by board", recordedAt: "2026-11-14T02:00:30Z" } } : {} });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure",
      failureCode: status === "failed" ? "native_session_interrupted" : "native_session_cancelled",
      failureDetail: status === "failed" ? { originalFailureCode: "network_error", providerSessionEstablished: false,
        providerEventsExist: false, checkpointExists: false, recoveryMode: "ambiguous_state" } : {} });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_continuation_requires_reconciliation", status: "resolved", outcome: "blocked", ownerType: "board",
      fingerprint: `native-workspace:${runId}`, resolvedAt: new Date(), nextAction: UNRESTORED_FILES_NEXT_ACTION,
      evidence: { runId, continuationDelivery: "invalidated", automaticRecovery: { policy: "preserve_without_replay_v1",
        runId, replay: "blocked", actionOutcome: "unknown" }, workspaceRecovery: { schema: "paperclip.workspace-recovery.v1",
        runId, status: "recovered", stage: "saving_receipts", attempt: 1, requestIds: [] } } }).returning();
    return { companyId, agentId, issueId, runId, actionId: action.id };
  }

  it("9165feb0: the card does not invent saved work before a provider session or tool started", async () => {
    const f = await seed("failed");
    const card = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(card).toMatchObject({ runId: f.runId, canRetry: true, savedMessageCount: 0 });
    expect(card?.nextAction).toBe("This run stopped before any work was saved. Press Retry to start it again.");
    expect(card?.workspaceRecovery?.message).toBe(card?.nextAction);
  });

  it.each(["transcript", "detail", "inspected detail"])("9165feb0: %s gives the same no-work Retry instruction as the card", async surface => {
    const f = await seed("failed");
    const expected = "This run stopped before any work was saved. Press Retry to start it again.";
    if (surface === "transcript") {
      expect((await executionProjectionForRun(db, f.companyId, f.runId))?.nextAction).toBe(expected);
    } else {
      const query = surface === "detail" ? {} : { inspectSourceRunId: f.runId, inspectSourceActionId: f.actionId };
      const detail = await request(app()).get(`/api/issues/${f.issueId}/recovery-actions`).query(query);
      expect(detail.status).toBe(200);
      expect(detail.body.actions.find((action: { id: string }) => action.id === f.actionId)?.nextAction).toBe(expected);
    }
  });

  it("9165feb0: the advertised Retry is accepted by actual task-Retry and continuation admission", async () => {
    const f = await seed("failed");
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    expect(receipt).toMatchObject({ accepted: true, stale: false });
    const continued = await db.transaction(tx => admitExplicitNativeContinuation({ db: tx as unknown as Db, ...f,
      actorType: "user", actorId: "board", reason: "task_retry", taskRetryRequestId: receipt.requestId!,
      commentId: null, successorRunId: randomUUID() }));
    expect(continued).toMatchObject({ previousRunId: f.runId, taskRetryRequestId: receipt.requestId });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]?.status).toBe("failed");
  });

  it.each([
    { label: "missing evidence", failureDetail: {} },
    { label: "only an absent session", failureDetail: { providerSessionEstablished: false } },
    { label: "provider events", failureDetail: { providerSessionEstablished: false, providerEventsExist: true } },
    { label: "established session", failureDetail: { providerSessionEstablished: true, providerEventsExist: false } },
  ])("zero saved messages and $label do not establish that nothing was saved", async ({ failureDetail }) => {
    const f = await seed("failed");
    await db.update(nativeRunFinalizations).set({ failureDetail }).where(eq(nativeRunFinalizations.runId, f.runId));
    const card = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(card).toMatchObject({ savedMessageCount: 0, canRetry: true, nextAction: "Saved work recovered. Retry continues from it." });
  });

  it("a no-work source with Retry unavailable names a new task without inventing saved work", async () => {
    const f = await seed("failed");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const expected = "This run stopped before any work was saved. Assign this agent a new task to continue.";
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: false, nextAction: expected });
    expect((await executionProjectionForRun(db, f.companyId, f.runId))?.nextAction).toBe(expected);
  });

  it("076e7441: settled board Stop with no HELD notice names a new message on card, transcript and recovery detail, never Retry", async () => {
    const f = await seed("cancelled");
    const expected = "Saved work recovered. Send a message to continue.";
    const card = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(card).toMatchObject({ runId: f.runId, canRetry: false, nextAction: expected });
    expect((await executionProjectionForRun(db, f.companyId, f.runId))?.nextAction).toBe(expected);
    for (const query of [{}, { inspectSourceRunId: f.runId, inspectSourceActionId: f.actionId }]) {
      const detail = await request(app()).get(`/api/issues/${f.issueId}/recovery-actions`).query(query);
      expect(detail.status).toBe(200);
      const action = detail.body.actions.find((entry: { id: string }) => entry.id === f.actionId);
      expect(action?.nextAction).toBe(expected);
      expect(action?.nextAction).not.toMatch(/Retry|new workspace/);
    }
  });

  it("076e7441: the advertised new message passes actual continuation admission; replaying the cancelled run does not", async () => {
    const f = await seed("cancelled"), commentId = randomUUID(), successorRunId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Continue with the next step.", createdAt: new Date() });
    const waits: string[] = [];
    const retry = await db.transaction(tx => admitExplicitNativeContinuation({ db: tx as unknown as Db, ...f,
      actorType: "user", actorId: "board", reason: "retry_failed_run", failedRunId: f.runId,
      commentId: null, successorRunId, dryRun: true, onBlocked: reason => waits.push(reason) }));
    expect(retry).toBeNull();
    expect(waits).toEqual(["cancelled_by_operator"]);
    const continued = await db.transaction(tx => admitExplicitNativeContinuation({ db: tx as unknown as Db, ...f,
      actorType: "user", actorId: "board", reason: "issue_commented", commentId, successorRunId }));
    expect(continued).toMatchObject({ previousRunId: f.runId, commentId });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]?.status).toBe("cancelled");
  });
});
