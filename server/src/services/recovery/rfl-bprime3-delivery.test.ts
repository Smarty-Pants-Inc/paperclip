import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, agentWakeupRequests } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { claimFirstTurnQueuedInput } from "../native-runtime/first-turn-queued-input.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { QUEUED_MESSAGES_DELIVERED_REASON } from "../../modules/wake-queue/index.js";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("RFL Bprime3 delivered first-turn messages", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("rfl-bprime3-delivery-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture(age = 180_000) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), messageId = randomUUID(), userId = "delivery-person";
    const messageAt = new Date(Date.now() - age);
    await db.insert(companies).values({ id: companyId, name: "Delivery regression", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "First-turn follow-up", status: "blocked", assigneeAgentId: agentId });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Include the staging report too.", createdAt: messageAt, updatedAt: messageAt });
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId, commentId: messageId, _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_commented",
        source: "issue.comment", wakeCommentId: messageId, wakeCommentIds: [messageId] } } }).returning();
    const sweep = () => heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId,
      skipRelatedRecovery: true, skipExternalConversationSettlement: true });
    const notices = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(row => !(row.metadata as Record<string, unknown> | null)?.supersededBy) // RFL 10:14Z: CURRENT notes (never-delete part 1);
    return { companyId, agentId, issueId, messageId, messageAt, userId, wakeId: wake!.id, sweep, notices };
  }

  for (const outcome of ["answers", "fails", "ends without answer"] as const) {
    it(`delivered first-turn input: carrying run ${outcome}`, async () => {
      const f = await fixture();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "native",
        nativeIssueId: f.issueId, responsibleUserId: f.userId, createdAt: new Date(f.messageAt.getTime() - 1_000),
        startedAt: new Date(f.messageAt.getTime() - 1_000), contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } }).returning();
      await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, f.issueId));
      expect(await claimFirstTurnQueuedInput(db, { ...f, runId: run!.id })).toContain(f.messageId);
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: run!.id, agentId: f.agentId,
        eventType: "turn.accepted", stream: "system", level: "info", message: "turn accepted" });
      expect([...await deliveredQueuedCommentIds(db, { ...f, commentIds: [f.messageId] })]).toEqual([f.messageId]);
      // Exact production cancellation marker: this is delivery, not abandonment.
      await db.update(agentWakeupRequests).set({ status: "cancelled", error: QUEUED_MESSAGES_DELIVERED_REASON,
        finishedAt: new Date(), updatedAt: new Date() }).where(eq(agentWakeupRequests.id, f.wakeId));
      await f.sweep(); expect(await f.notices()).toHaveLength(0);
      await db.update(heartbeatRuns).set({ status: outcome === "fails" ? "failed" : "succeeded", finishedAt: new Date(Date.now() - 30_000),
        errorCode: outcome === "fails" ? "adapter_failed" : null }).where(eq(heartbeatRuns.id, run!.id));
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
      if (outcome === "answers") await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "agent", authorAgentId: f.agentId, createdByRunId: run!.id, body: "Here is the staging report." });
      await f.sweep(); await f.sweep();
      const notices = await f.notices();
      expect(notices).toHaveLength(outcome === "answers" ? 0 : 1);
      if (outcome !== "answers") {
        expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${f.messageId}`);
        expect(notices[0]!.body).toBe(outcome === "fails"
          ? "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task."
          : "This run finished without a reply to your message. Sending it again is safe.");
      }
    });
  }

  it("non-delivery cancellation with no carrying run: quiet before grace, one notice after grace despite unrelated timer success", async () => {
    const f = await fixture(5_000);
    await db.update(agentWakeupRequests).set({ status: "cancelled", error: "operator_cancelled", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, f.wakeId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId, wakeReason: "heartbeat_timer" }, finishedAt: new Date() });
    await f.sweep(); expect(await f.notices()).toHaveLength(0);
    const later = new Date(f.messageAt.getTime() + 120_001);
    await settleUnansweredPersonMessage(db, { ...f, now: later });
    await settleUnansweredPersonMessage(db, { ...f, now: later });
    expect(await f.notices()).toHaveLength(1);
    expect((await f.notices())[0]!.body).toContain("no run started for it");
  });

  it("F4 attribution: an unrelated failed wake cannot remove a new message's 120s grace", async () => {
    const f = await fixture(5_000);
    await db.update(agentWakeupRequests).set({ status: "cancelled", error: "operator_cancelled", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, f.wakeId));
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "heartbeat_timer", status: "failed", updatedAt: new Date(), finishedAt: new Date(), payload: { issueId: f.issueId } });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId, wakeReason: "heartbeat_timer" }, finishedAt: new Date() });
    await f.sweep();
    expect(await f.notices()).toHaveLength(0);
  });
});
