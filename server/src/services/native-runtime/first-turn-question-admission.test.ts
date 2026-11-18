import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issueComments, issueThreadInteractions } from "@paperclipai/db";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import { claimFirstTurnQueuedInput } from "./first-turn-queued-input.js";

// SMAA-1637: queue consumption already knew the provider received the message,
// but request_human_input still refused its follow-up question as unread input.
describe("first-turn queued input question admission", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => { server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); });

  async function seed() {
    return server.fixture({ connectionScenario: "fresh", disableWakeOnDemand: true,
      contextSnapshot: { paperclipWake: { comments: [] } } });
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  async function queueMessage(f: Fixture, body = "Please ask me which report format to use.") {
    const [comment] = await server.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body }).returning();
    await server.db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_execution_deferred",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: f.userId,
      payload: { issueId: f.issueId, commentId: comment!.id, _paperclipWakeContext: {
        issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", source: "issue.comment",
        wakeCommentId: comment!.id, wakeCommentIds: [comment!.id],
      } } });
    return comment!;
  }

  const accept = (f: Fixture, runId = f.runId, eventType = "turn.accepted") => appendHeartbeatRunEvent(server.db, {
    companyId: f.companyId, agentId: f.agentId, runId, eventType, stream: "system", level: "info",
    message: "provider accepted first turn",
  });
  const question = (f: Fixture) => f.authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: {
    idempotencyKey: "report-format-question", interactionKind: "questions", title: "Report format",
    prompt: "Which report format should I use?", continuationPolicy: "wake_assignee",
    payload: { version: 1, questionSet: { schema: "paperclip.question_set.v1",
      questions: [{ id: "format", prompt: "Report format?", answerMode: "text", required: true }] } },
  } });
  const cards = (f: Fixture) => server.db.select().from(issueThreadInteractions)
    .where(eq(issueThreadInteractions.issueId, f.issueId));
  const notDelivered = (commentIds: string[]) => ({ status: 409,
    details: { reason: "newer_comment_not_delivered", commentIds } });

  it.each(["turn.accepted", "turn.started"])("accepts request_human_input after queued first-turn delivery (%s)", async eventType => {
    const f = await seed();
    const comment = await queueMessage(f);
    const input = await claimFirstTurnQueuedInput(server.db, f);
    expect(input).toContain(comment.body);
    expect(input).toContain(comment.id);
    await accept(f, f.runId, eventType);
    // Existing queue consumption and interaction admission must agree.
    expect([...await deliveredQueuedCommentIds(server.db, { ...f, commentIds: [comment.id] })]).toEqual([comment.id]);
    expect(await question(f)).toMatchObject({ disposition: "applied", interaction: {
      kind: "ask_user_questions", status: "pending", sourceRunId: f.runId,
    } });
    expect(await cards(f)).toMatchObject([{ kind: "ask_user_questions", status: "pending", sourceRunId: f.runId }]);
  });

  it("still blocks a human message that arrived after the first-turn seal", async () => {
    const f = await seed();
    const delivered = await queueMessage(f);
    expect(await claimFirstTurnQueuedInput(server.db, f)).toContain(delivered.id);
    await accept(f);
    const unseen = await queueMessage(f, "Wait, use the revised scope before asking.");
    expect(await claimFirstTurnQueuedInput(server.db, f)).not.toContain(unseen.id);
    await expect(question(f)).rejects.toMatchObject(notDelivered([unseen.id]));
    expect(await cards(f)).toEqual([]);
  });

  it("does not count a seal as delivery before the provider accepted the turn", async () => {
    const f = await seed();
    const comment = await queueMessage(f);
    expect(await claimFirstTurnQueuedInput(server.db, f)).toContain(comment.id);
    expect([...await deliveredQueuedCommentIds(server.db, { ...f, commentIds: [comment.id] })]).toEqual([]);
    await expect(question(f)).rejects.toMatchObject(notDelivered([comment.id]));
    expect(await cards(f)).toEqual([]);
  });

  it("does not count another run's accepted receipt, even when copied into this run", async () => {
    const f = await seed();
    const comment = await queueMessage(f);
    const otherRunId = randomUUID();
    const receipt = { schema: "paperclip.first-turn-queued-input.v1", runId: otherRunId,
      commentIds: [comment.id], wakeupRequestIds: [], claimedAt: new Date().toISOString() };
    const contextSnapshot = { issueId: f.issueId, paperclipWake: { comments: [] }, firstTurnQueuedInput: receipt };
    await server.db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot });
    await accept(f, otherRunId);
    await server.db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, f.runId));
    await accept(f);
    // The queue's task-wide fact must not become proof of this run's context.
    expect([...await deliveredQueuedCommentIds(server.db, { ...f, commentIds: [comment.id] })]).toEqual([comment.id]);
    await expect(question(f)).rejects.toMatchObject(notDelivered([comment.id]));
    expect(await cards(f)).toEqual([]);
  });

  it("does not count an edit made after the first-turn seal as read", async () => {
    const f = await seed();
    const comment = await queueMessage(f);
    expect(await claimFirstTurnQueuedInput(server.db, f)).toContain(comment.id);
    await accept(f);
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const receipt = run!.contextSnapshot!.firstTurnQueuedInput as { claimedAt: string };
    await server.db.update(issueComments).set({ body: "Actually, do not ask until you read the revised scope.",
      updatedAt: new Date(new Date(receipt.claimedAt).getTime() + 1_000) }).where(eq(issueComments.id, comment.id));
    await expect(question(f)).rejects.toMatchObject(notDelivered([comment.id]));
    expect(await cards(f)).toEqual([]);
  });
});
