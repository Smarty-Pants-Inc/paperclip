import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { activityLog, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("RFL round 8 NULL-channel answer provenance", () => {
  const state = issueRecoveryFixture();
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  it("counts the first successor's answer for a NULL-state channel message", async () => {
    const f = await state.fixture();
    const issueId = randomUUID(), sourceRunId = randomUUID(), messageId = randomUUID();
    await state.db.insert(issues).values({ id: issueId, companyId: f.companyId,
      title: "NULL-state channel message", status: "in_progress", assigneeAgentId: f.agentId,
      responsibleUserId: "recovery-user", originKind: "chat_channel", conversationAgentId: null,
      conversationUserId: null, conversationState: null, createdAt: ago(360), updatedAt: ago(180) });
    await state.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId,
      authorUserId: "recovery-user", authorType: "user", body: "Please answer this channel message.",
      createdAt: ago(300), updatedAt: ago(300) });
    // Legacy/null-channel source: the person's message exists, but this run did
    // not record wakeCommentId, so only the recovery successor can establish the
    // existing direct message-provenance contract.
    await state.db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
      issueId, status: "succeeded", responsibleUserId: "recovery-user", createdAt: ago(294),
      startedAt: ago(288), finishedAt: ago(240), contextSnapshot: { issueId, taskId: issueId } });

    type EnqueueWakeup = Parameters<typeof recoveryService>[1]["enqueueWakeup"];
    const enqueueWakeup = vi.fn(async (..._args: Parameters<EnqueueWakeup>) =>
      ({ id: randomUUID() } as Awaited<ReturnType<EnqueueWakeup>>));
    const assignedWork = recoveryService(state.db, { enqueueWakeup }).assignedWork;
    const firstCheck = await assignedWork.checkIssue({ companyId: f.companyId, issueId });
    expect(firstCheck).toMatchObject({ outcome: "repaired", verdict: { kind: "violation", reason: "no_pending_path" } });
    if (!firstCheck) throw new Error("first assigned-work check returned no result");
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const firstWake = enqueueWakeup.mock.calls[0]?.[1];
    if (!firstWake) throw new Error("first continuation did not capture wakeup options");

    const successorRunId = randomUUID();
    await state.db.insert(heartbeatRuns).values({ id: successorRunId, companyId: f.companyId, agentId: f.agentId,
      issueId, status: "succeeded", responsibleUserId: "recovery-user", createdAt: ago(3), startedAt: ago(3),
      finishedAt: ago(3), contextSnapshot: firstWake.contextSnapshot });
    await issueService(state.db).addComment(issueId, "Controlled continuation answered the person's message.", {
      agentId: f.agentId, runId: successorRunId,
    });
    // Let the existing per-task continuation spacing elapse; the second pass
    // should be stopped by answer provenance, not by a timing guard.
    await state.db.update(activityLog).set({ createdAt: ago(3) }).where(and(
      eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.continued_automatically")));

    const secondCheck = await assignedWork.checkIssue({ companyId: f.companyId, issueId });
    const successors = await state.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId));
    const replies = await state.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const receipt = { issueId, messageId, sourceRunId,
      firstSuccessor: { id: successorRunId, contextSnapshot: firstWake.contextSnapshot },
      checkOutcomes: [firstCheck.outcome, secondCheck?.outcome],
      enqueueCount: enqueueWakeup.mock.calls.length,
      successors: successors.map(run => ({ id: run.id, status: run.status, source: run.contextSnapshot?.source,
        previousRunId: run.contextSnapshot?.previousRunId, wakeCommentId: run.contextSnapshot?.wakeCommentId })),
      replies: replies.filter(comment => comment.authorAgentId).map(comment => ({ runId: comment.createdByRunId, body: comment.body })) };
    if (process.env.TASK_OUT) appendFileSync(`${process.env.TASK_OUT}/r8-null-channel-receipts.jsonl`, JSON.stringify(receipt) + "\n");
    console.log("RFL_R8_NULL_CHANNEL", JSON.stringify(receipt));
    expect(secondCheck).toMatchObject({ outcome: "ok", verdict: { kind: "ok", clause: "waiting", reason: "conversation" } });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(firstWake.contextSnapshot).toMatchObject({ source: "issue.assigned_work_invariant", wakeCommentId: messageId });
    expect(successors).toHaveLength(2);
  }, 60_000);
});
