import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("RFL round 3 in_review assigned-work race", () => {
  const state = issueRecoveryFixture();
  const listeners: Server[] = [];
  afterEach(async () => {
    for (const listener of listeners.splice(0)) {
      listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });

  it("registered competing sweeps deliver exactly one answer for an unanswered in_review chat", async () => {
    const f = await state.fixture();
    await instanceSettingsService(state.db).updateExperimental({ enableAgentChat: true });
    const issueId = randomUUID(), runId = randomUUID(), messageId = randomUUID();
    const at = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    await state.db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "In-review person message",
      status: "in_review", assigneeAgentId: f.agentId, responsibleUserId: "recovery-user",
      conversationAgentId: f.agentId, conversationUserId: "recovery-user", conversationState: "waiting",
      createdAt: at(6), updatedAt: at(3) });
    await state.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId,
      authorUserId: "recovery-user", authorType: "user", body: "Please answer this question.", createdAt: at(5), updatedAt: at(5) });
    await state.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, issueId,
      status: "succeeded", responsibleUserId: "recovery-user", createdAt: at(4.9), startedAt: at(4.8), finishedAt: at(4),
      contextSnapshot: { issueId, taskId: issueId, wakeCommentId: messageId } });

    const failures: unknown[] = [];
    const listener = createServer(async (request, response) => {
      try {
        let body = ""; for await (const chunk of request) body += chunk;
        const { runId: executingRunId } = JSON.parse(body) as { runId: string };
        const [run] = await state.db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.id, executingRunId), eq(heartbeatRuns.agentId, f.agentId)));
        if (!run || run.contextSnapshot?.issueId !== issueId) throw new Error("Unknown controlled continuation run");
        await issueService(state.db).addComment(issueId, "Controlled continuation answers the person's question.", {
          agentId: f.agentId, runId: executingRunId,
        });
        response.end("ok");
      } catch (error) { failures.push(String(error)); response.statusCode = 500; response.end("controlled reply failed"); }
    });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve)); listeners.push(listener);
    const port = (listener.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/reply", {method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok)throw new Error(await r.text());console.log("controlled-chat-answer")}).catch(e=>{console.error(e);process.exitCode=1})`;
    await state.db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd: process.cwd() } })
      .where(eq(agents.id, f.agentId));

    await state.start();
    await state.compete();
    await new Promise(resolve => setTimeout(resolve, 1_800));
    await Promise.allSettled([...state.passes]);
    await state.heartbeat.drainActiveRunExecutions();
    const runs = await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`));
    const comments = await state.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const successors = runs.filter(run => run.id !== runId);
    const answerComments = comments.filter(comment => comment.authorAgentId === f.agentId && comment.createdByRunId !== runId);
    const receipt = { issueId, sourceRunId: runId, successors: successors.map(run => ({ id: run.id, status: run.status,
      source: run.contextSnapshot?.source, previousRunId: run.contextSnapshot?.previousRunId })),
      answerComments: answerComments.map(comment => ({ runId: comment.createdByRunId, body: comment.body })),
      failures: failures.map(String) };
    console.log("RFL_R3_IN_REVIEW_COMPETING", JSON.stringify(receipt));
    appendFileSync(`${process.env.TASK_OUT}/in-review-race-receipts.jsonl`, JSON.stringify(receipt) + "\n");
    expect(failures).toEqual([]);
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "succeeded", contextSnapshot: {
      source: "issue.assigned_work_invariant", previousRunId: runId,
    } });
    expect(answerComments).toHaveLength(1);
    expect(answerComments[0]?.createdByRunId).toBe(successors[0]?.id);
  }, 90_000);
});
