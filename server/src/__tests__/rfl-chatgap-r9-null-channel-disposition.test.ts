import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("RFL round 9 NULL-channel answer disposition", () => {
  const state = issueRecoveryFixture();

  it("completes only the channel-only review task answered by its assigned-work continuation", async () => {
    const f = await state.fixture();
    const issueId = randomUUID(), sourceRunId = randomUUID(), continuationRunId = randomUUID(), messageId = randomUUID();
    const messageAt = new Date(Date.now() - 60_000);
    await state.db.insert(issues).values({ id: issueId, companyId: f.companyId,
      title: "Answer the channel question", status: "in_review", assigneeAgentId: f.agentId,
      responsibleUserId: "recovery-user", originKind: "chat_channel", conversationAgentId: null,
      conversationUserId: null, conversationState: null });
    await state.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId,
      authorUserId: "recovery-user", authorType: "user", body: "Please answer this channel question.",
      createdAt: messageAt, updatedAt: messageAt });
    await state.db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
      issueId, status: "succeeded", contextSnapshot: { issueId, wakeCommentId: messageId } });
    await state.db.insert(heartbeatRuns).values({ id: continuationRunId, companyId: f.companyId, agentId: f.agentId,
      issueId, status: "running", contextSnapshot: { issueId, taskId: issueId,
        source: "issue.assigned_work_invariant", wakeReason: "issue_continuation_needed",
        previousRunId: sourceRunId, wakeCommentId: messageId } });

    await issueService(state.db).addComment(issueId, "Here is the answer.", { agentId: f.agentId, runId: continuationRunId });

    const [current] = await state.db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(current?.status).toBe("done");
  }, 60_000);
});
