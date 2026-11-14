import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { chatConversations, chatEndpoints, chatPublications, heartbeatRuns, issueComments, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

// RFL round 12 independent judge check (not builder code). Question: after the
// r12 seam skips the run-completion disposition for an ANSWERED NULL-channel
// chat, does the OTHER caller of the block+note (the stranded sweep,
// recovery/service.ts ~4874-4885) still block the answered task?
describeIssueRecovery("RFL round 12 sweep call site", () => {
  const state = issueRecoveryFixture();
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  const record = (name: string, data: unknown) => { if (process.env.TASK_OUT) appendFileSync(`${process.env.TASK_OUT}/rfl12-sweep-receipts.jsonl`, JSON.stringify({ name, data }) + "\n"); };
  async function channel(companyId: string, agentId: string, issueId: string) {
    const [application] = await state.db.insert(toolApplications).values({ companyId, name: `RFL channel ${randomUUID()}`, type: "mcp_http" }).returning();
    const [connection] = await state.db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "RFL channel", uid: randomUUID(),
      transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [endpoint] = await state.db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id, assignedAgentId: agentId,
      provider: "slack", publicId: randomUUID(), status: "active" }).returning();
    const [conversation] = await state.db.insert(chatConversations).values({ companyId, endpointId: endpoint!.id, issueId,
      externalConversationId: randomUUID(), externalLabel: "RFL channel" }).returning();
    return { endpoint: endpoint!, conversation: conversation! };
  }

  it.each(["answered-by-review-path-repair-run", "unanswered-control", "answered-by-assigned-work-continuation"] as const)("stranded sweep on a NULL-channel in_review chat: %s", async kind => {
    const f = await state.fixture();
    const issueId = randomUUID(), sourceRunId = randomUUID(), messageId = randomUUID(), repairRunId = randomUUID();
    await state.db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Channel message", status: "in_review",
      assigneeAgentId: f.agentId, responsibleUserId: "recovery-user", originKind: "chat_channel",
      conversationAgentId: null, conversationUserId: null, conversationState: null, createdAt: ago(6), updatedAt: ago(3) });
    await state.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId, authorUserId: "recovery-user", authorType: "user",
      body: "Please answer this message.", createdAt: ago(5), updatedAt: ago(5) });
    const bound = await channel(f.companyId, f.agentId, issueId);
    await state.db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId, issueId, status: "succeeded",
      responsibleUserId: "recovery-user", createdAt: ago(4.9), startedAt: ago(4.8), finishedAt: ago(4), contextSnapshot: { issueId, wakeCommentId: messageId } });
    await state.db.insert(heartbeatRuns).values({ id: repairRunId, companyId: f.companyId, agentId: f.agentId, issueId, status: "succeeded",
      responsibleUserId: "recovery-user", createdAt: ago(2), startedAt: ago(1.9), finishedAt: ago(1.8), contextSnapshot: kind === "answered-by-assigned-work-continuation"
        ? { issueId, taskId: issueId, source: "issue.assigned_work_invariant", previousRunId: sourceRunId }
        : { issueId, taskId: issueId, source: "heartbeat.review_path_disposition", wakeReason: "issue_review_path_lost", reviewPathRecoveryAttempt: 1 } });
    if (kind !== "unanswered-control") {
      const [reply] = await state.db.insert(issueComments).values({ companyId: f.companyId, issueId, authorType: "agent", authorAgentId: f.agentId,
        createdByRunId: repairRunId, origin: "comment", body: "Here is the answer.", createdAt: ago(1.85), updatedAt: ago(1.85) }).returning();
      await state.db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId: reply!.id } } }).where(eq(heartbeatRuns.id, repairRunId));
      await state.db.insert(chatPublications).values({ companyId: f.companyId, endpointId: bound.endpoint.id, conversationId: bound.conversation.id,
        issueId, commentId: reply!.id, idempotencyKey: `rfl12-sweep:${reply!.id}`, state: "published", providerMessageId: randomUUID(),
        publishedAt: ago(1.84), payload: { text: "Here is the answer." } });
    }
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const result = await recoveryService(state.db, { enqueueWakeup: enqueueWakeup as never })
      .reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId, skipRelatedRecovery: true } as never);
    const [issue] = await state.db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    const comments = await state.db.select({ authorType: issueComments.authorType, body: issueComments.body, presentation: issueComments.presentation })
      .from(issueComments).where(eq(issueComments.issueId, issueId));
    const notes = comments.filter(c => c.authorType === "system");
    record(kind, { result, status: issue?.status, wakeCalls: enqueueWakeup.mock.calls.length, comments: comments.length,
      systemNotes: notes.map(n => ({ body: n.body.slice(0, 220), presentation: n.presentation })) });
    if (kind !== "unanswered-control") {
      // Paul's bar + the r12 seam's own claim: an answered channel chat is not blocked for a board decision and gets no note.
      expect(issue?.status).toBe("in_review");
      expect(notes).toHaveLength(0);
    } else {
      expect(typeof issue?.status).toBe("string");
    }
  }, 120_000);
});
