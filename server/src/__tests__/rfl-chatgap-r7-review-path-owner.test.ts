import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

type RecoveryEnqueueWakeup = NonNullable<Parameters<typeof recoveryService>[1]["enqueueWakeup"]>;

// Keep: the recorded RFL duplicate-successor incident crosses two independently
// registered recovery owners. Exercise their durable ownership signal through
// the production selector/checker against PostgreSQL.
describeIssueRecovery("RFL round 7 review-path ownership", () => {
  const state = issueRecoveryFixture();
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  async function seed(sourceContext: Record<string, unknown> = {}) {
    const f = await state.fixture();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const messageId = randomUUID();
    await state.db.insert(issues).values({
      id: issueId, companyId: f.companyId, title: "Unanswered channel message", status: "in_review",
      assigneeAgentId: f.agentId, responsibleUserId: "recovery-user", originKind: "chat_channel",
      conversationAgentId: null, conversationUserId: null, conversationState: null,
      createdAt: ago(6), updatedAt: ago(3),
    });
    await state.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId,
      authorUserId: "recovery-user", authorType: "user", body: "Please answer this message.",
      createdAt: ago(5), updatedAt: ago(5) });
    await state.db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
      issueId, status: "succeeded", responsibleUserId: "recovery-user", createdAt: ago(4.9),
      startedAt: ago(4.8), finishedAt: ago(4), contextSnapshot: { issueId, wakeCommentId: messageId, ...sourceContext } });
    return { ...f, issueId, sourceRunId, messageId };
  }

  it("yields to the latest issue_review_path_lost run and leaves it as the sole successor", async () => {
    const f = await seed();
    const recoveryRunId = randomUUID();
    await state.db.insert(heartbeatRuns).values({ id: recoveryRunId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, status: "succeeded", responsibleUserId: "recovery-user", createdAt: ago(2),
      startedAt: ago(1.9), finishedAt: ago(1.8), contextSnapshot: {
        issueId: f.issueId, taskId: f.issueId, source: "heartbeat.review_path_disposition",
        wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1,
      } });

    const enqueueWakeup = vi.fn<RecoveryEnqueueWakeup>(async () => ({ id: randomUUID() } as never));
    const assignedWork = recoveryService(state.db, { enqueueWakeup }).assignedWork;
    const suspects = await assignedWork.listSuspects({ companyId: f.companyId }, null, 100);
    const check = await assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId });
    const successors = await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.sourceRunId}`));

    expect(suspects.map(row => row.id)).not.toContain(f.issueId);
    expect(check).toMatchObject({ outcome: "ok", verdict: { kind: "ok", clause: "pending_intent", intent: "review_path_recovery" } });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ id: recoveryRunId, contextSnapshot: {
      wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1,
    } });
  }, 60_000);

  it("yields to a queued upstream review-path wake before it becomes a run", async () => {
    const f = await seed();
    await state.db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_review_path_lost",
      payload: { issueId: f.issueId, taskId: f.issueId, reviewPathRecoveryAttempt: 1 },
      idempotencyKey: `issue_review_path_lost:${f.issueId}:fixture` });

    const enqueueWakeup = vi.fn<RecoveryEnqueueWakeup>(async () => ({ id: randomUUID() } as never));
    const assignedWork = recoveryService(state.db, { enqueueWakeup }).assignedWork;
    const suspects = await assignedWork.listSuspects({ companyId: f.companyId }, null, 100);
    const check = await assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId });
    const wakeRows = await state.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.idempotencyKey, `issue_review_path_lost:${f.issueId}:fixture`)));

    expect(suspects.map(row => row.id)).not.toContain(f.issueId);
    expect(check).toMatchObject({ outcome: "ok", verdict: { kind: "ok", clause: "pending_intent", intent: "review_path_recovery" } });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(wakeRows).toHaveLength(1);
    expect(wakeRows[0].status).toBe("queued");
  }, 60_000);

  it("continues a NULL-channel unanswered chat when no review-path owner signal exists", async () => {
    const f = await seed();
    const enqueueWakeup = vi.fn<RecoveryEnqueueWakeup>(async () => ({ id: "one-chat-gap-successor" } as never));
    const assignedWork = recoveryService(state.db, { enqueueWakeup }).assignedWork;
    const suspects = await assignedWork.listSuspects({ companyId: f.companyId }, null, 100);
    const check = await assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId });
    const reviewPathWakes = await state.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`));

    expect(suspects.map(row => row.id)).toContain(f.issueId);
    expect(reviewPathWakes).toHaveLength(0);
    expect(check).toMatchObject({ outcome: "repaired", verdict: { kind: "violation", reason: "no_pending_path" } });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(f.agentId, expect.objectContaining({
      reason: "issue_continuation_needed",
      payload: { issueId: f.issueId, mutation: "assigned_work_invariant" },
    }));
  }, 60_000);
});
