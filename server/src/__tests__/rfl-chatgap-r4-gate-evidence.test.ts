import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { agents, activityLog, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { ensureFreshContinuation } from "../services/fresh-continuation-fallback.js";
import { conversationRunsForLastMessages } from "../services/agent-conversations.js";
import { recoveryService } from "../services/recovery/service.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// Independent ROUND 2 acceptance. The real heartbeat registration installs the
// production recovery workers and dispatcher on a real coordinator + PostgreSQL.
// A local process adapter performs a controlled reply via the real issue service;
// it is NOT evidence of a live Boat/model/provider run.
describeIssueRecovery("RFL round 2 registered production sweep", () => {
  const state = issueRecoveryFixture();
  const listeners: Server[] = [];
  afterEach(async () => {
    for (const listener of listeners.splice(0)) {
      listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  });
  function personFacingApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "local_implicit" }; next(); });
    app.use("/api", issueRoutes(state.db, {} as any));
    app.use(errorHandler);
    return app;
  }
  async function seed(status: string, answered = false) {
    const f = await state.fixture();
    await instanceSettingsService(state.db).updateExperimental({ enableAgentChat: true });
    const issueId = randomUUID(), runId = randomUUID(), messageId = randomUUID();
    const at = (h: number) => new Date(Date.now() - h * 3_600_000);
    await state.db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Last person message must receive an answer",
      status, assigneeAgentId: f.agentId, responsibleUserId: "recovery-user", conversationAgentId: f.agentId,
      conversationUserId: "recovery-user", conversationState: "waiting", createdAt: at(6), updatedAt: at(3) });
    await state.db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId,
      authorUserId: "recovery-user", authorType: "user", body: "What is the result?", createdAt: at(5), updatedAt: at(5) });
    await state.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, issueId,
      runtimeMode: "native", nativeIssueId: issueId, status: "succeeded", responsibleUserId: "recovery-user",
      createdAt: at(4.9), startedAt: at(4.8), finishedAt: at(4),
      contextSnapshot: { issueId, taskId: issueId, wakeCommentId: messageId } });
    if (answered) await state.db.insert(issueComments).values({ companyId: f.companyId, issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: runId, origin: "comment", body: "The result is ready.", createdAt: at(3) });
    return { ...f, issueId, runId, messageId, at };
  }
  type F = Awaited<ReturnType<typeof seed>>;
  async function replyProcess(f: F) {
    const failures: unknown[] = [];
    const listener = createServer(async (request, response) => {
      try {
        let body = ""; for await (const chunk of request) body += chunk;
        const { runId } = JSON.parse(body) as { runId: string };
        const [run] = await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, f.companyId)));
        if (!run || run.contextSnapshot?.issueId !== f.issueId) throw new Error("Unknown fixture run");
        await issueService(state.db).addComment(f.issueId, "Controlled continuation answers the person's question.", { agentId: f.agentId, runId });
        response.end("ok");
      } catch (error) { failures.push(String(error)); response.statusCode = 500; response.end("controlled reply failed"); }
    });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve)); listeners.push(listener);
    const port = (listener.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/reply", {method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok)throw new Error(await r.text());console.log("controlled-chat-answer")}).catch(e=>{console.error(e);process.exitCode=1})`;
    await state.db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd: process.cwd() } }).where(eq(agents.id, f.agentId));
    return failures;
  }
  async function flush() {
    await new Promise(resolve => setTimeout(resolve, 1800));
    await Promise.allSettled([...state.passes]);
    await state.heartbeat.drainActiveRunExecutions();
  }
  async function receipt(f: F, name: string) {
    const runs = await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
    const comments = await state.db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const actions = await state.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.issueId)));
    const recovery = await state.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const [issue] = await state.db.select({ status: issues.status, state: issues.conversationState }).from(issues).where(eq(issues.id, f.issueId));
    const successors = runs.filter(r => r.id !== f.runId);
    const data = { name, issue, successors: successors.map(r => ({ id: r.id, status: r.status, code: r.errorCode, context: { issueId: r.contextSnapshot?.issueId,
      source: r.contextSnapshot?.source, wakeCommentId: r.contextSnapshot?.wakeCommentId, commentId: r.contextSnapshot?.commentId,
      firstTurnQueuedInput: r.contextSnapshot?.firstTurnQueuedInput, previousRunId: r.contextSnapshot?.previousRunId,
      forceFreshSession: r.contextSnapshot?.forceFreshSession } })),
      replies: comments.filter(c => c.authorAgentId).map(c => ({ runId: c.createdByRunId, body: c.body })),
      activities: actions.map(a => ({ action: a.action, details: a.details })), recovery: recovery.map(r => ({ cause: r.cause, status: r.status })),
      sweep: state.worker?.assignedWork?.reconciliationSnapshot() };
    console.log("RFL_REGISTERED", JSON.stringify(data));
    appendFileSync(`${process.env.TASK_OUT}/registered-receipts.jsonl`, JSON.stringify(data) + "\n");
    return { successors, comments, actions, recovery, issue };
  }
  it.each(["in_progress", "in_review"])("a SUCCEEDED unanswered %s chat gets exactly one answering continuation via registration", async status => {
    const f = await seed(status); const failures = await replyProcess(f);
    await state.start(); await flush();
    const result = await receipt(f, `succeeded-unanswered-${status}`);
    expect(failures).toEqual([]);
    expect(result.successors).toHaveLength(1);
    expect(result.successors[0].status).toBe("succeeded");
    expect(result.comments.filter(c => c.authorAgentId === f.agentId && c.createdByRunId === result.successors[0].id)).toHaveLength(1);
    state.worker.assignedWork!.refresh(); await flush();
    expect((await receipt(f, `second-pass-${status}`)).successors).toHaveLength(1);
  });
  it("an ANSWERED chat gets no continuation through the full registration", async () => {
    const f = await seed("in_progress", true); await replyProcess(f);
    await state.start(); await flush();
    expect((await receipt(f, "answered")).successors).toHaveLength(0);
  });
  it("two registered sweep instances admit only ONE answering continuation", async () => {
    const f = await seed("in_progress"); await replyProcess(f);
    await state.start(); await state.compete(); await flush();
    const result = await receipt(f, "two-registered-workers");
    expect(result.successors).toHaveLength(1);
    expect(result.comments.filter(c => c.authorAgentId === f.agentId)).toHaveLength(1);
  });
  it.each(["paused", "budget", "stopped"])("a genuine %s gate wins and remains durably identifiable", async gate => {
    const f = await seed("in_progress");
    if (gate === "paused" || gate === "budget") await state.db.update(agents).set({ status: "paused", pauseReason: gate === "budget" ? "budget_exceeded" : "manual" }).where(eq(agents.id, f.agentId));
    else await state.db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_interrupted",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "recovery-user", cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "recovery-user" }, reason: "Stop requested", recordedAt: f.at(4).toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    await state.start(); await flush();
    const result = await receipt(f, `gate-${gate}`);
    const [gateEvidence] = gate === "stopped"
      ? await state.db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))
      : await state.db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, f.agentId));
    const app = personFacingApp();
    const issueRead = await request(app).get(`/api/issues/${f.issueId}`).expect(200);
    const commentsRead = await request(app).get(`/api/issues/${f.issueId}/comments?order=asc`).expect(200);
    const visibleCommentBodies = commentsRead.body.map((comment: { body: string }) => comment.body);
    if (gate === "paused" || gate === "budget") {
      expect(issueRead.body.status).toBe("blocked");
      expect(visibleCommentBodies).toContain("Recovery process can't run right now, so Paperclip stopped this task instead of retrying it. It is still assigned to them. To continue, resume or fix the agent, or assign the task to someone else.");
    } else {
      expect(issueRead.body.interruption).toMatchObject({ state: "failed", canRetry: true });
      const visibleStopNotice = issueRead.body.interruption.retryWait?.message
        ?? (issueRead.body.interruption.state === "failed" ? "Couldn’t finish this attempt. Your message is saved." : null);
      expect(visibleStopNotice).toBe("Couldn’t finish this attempt. Your message is saved.");
      expect(visibleCommentBodies).toContain("What is the result?");
    }
    const p = issueRead.body.interruption;
    appendFileSync(`${process.env.TASK_OUT}/gate-api-selected.jsonl`, JSON.stringify({ gate, gateEvidence,
      issue: {id: issueRead.body.id, status: issueRead.body.status, interruption: p ? { state:p.state, responsibility:p.responsibility,
        userAction:p.userAction, canRetry:p.canRetry, retryWait:p.retryWait, sourceRunIds:p.sourceRunIds, observedRunId:p.observedRunId } : null },
      comments: visibleCommentBodies }) + "\n");
    appendFileSync(`${process.env.TASK_OUT}/registered-receipts.jsonl`, JSON.stringify({ name: `gate-evidence-${gate}`, gateEvidence }) + "\n");
    expect(result.successors).toHaveLength(0);
    if (gate === "paused") expect(gateEvidence).toMatchObject({ status: "paused", pauseReason: "manual" });
    else if (gate === "budget") expect(gateEvidence).toMatchObject({ status: "paused", pauseReason: "budget_exceeded" });
    else expect(gateEvidence).toMatchObject({ status: "cancelled", errorCode: "operator_interrupted", resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "recovery-user", cancellation: { source: "operator", expected: true,
        initiator: { type: "user", id: "recovery-user" }, reason: "Stop requested" },
    } });
  });
  it.each(["running", "queued"])("a chat with a %s run gets no duplicate", async status => {
    const f = await seed("in_progress");
    await state.db.update(heartbeatRuns).set({ status, finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    // Register the real recovery workers without consuming this queued fixture in dispatch.
    state.coordinator = createDeliveryWorkCoordinator({ owner: state.db, canRun: () => true, onError: error => state.errors.push(error) });
    state.worker = state.heartbeat.registerIssueStateRecoveryWork(state.coordinator, () => true);
    await state.worker.ready; await flush();
    expect((await receipt(f, `live-${status}`)).successors).toHaveLength(0);
    expect(await recoveryService(state.db, { enqueueWakeup: state.heartbeat.wakeup }).assignedWork.listSuspects({ companyId: f.companyId }, null, 100)).toEqual([]);
  });
  it("agent-to-agent channel with no person message is not selected", async () => {
    const f = await seed("in_progress");
    await state.db.update(issues).set({ conversationAgentId: null, conversationUserId: null, conversationState: null, originKind: "chat_channel" }).where(eq(issues.id, f.issueId));
    await state.db.update(issueComments).set({ authorUserId: null, authorAgentId: f.agentId, authorType: "agent", createdByRunId: f.runId }).where(eq(issueComments.id, f.messageId));
    expect(await recoveryService(state.db, { enqueueWakeup: state.heartbeat.wakeup }).assignedWork.listSuspects({ companyId: f.companyId }, null, 100)).toEqual([]);
  });
  it("the reply of a real recovery successor must remain attributable to the person's message", async () => {
    const f = await seed("in_progress"); await replyProcess(f);
    await state.start(); await flush();
    const result = await receipt(f, "recovery-reply-attribution");
    expect(result.successors).toHaveLength(1);
    expect(result.comments.filter(c => c.authorAgentId === f.agentId)).toHaveLength(1);
    const carriers = await conversationRunsForLastMessages(state.db, { companyId: f.companyId, issues: [{ issueId: f.issueId, agentId: f.agentId }] });
    appendFileSync(`${process.env.TASK_OUT}/registered-receipts.jsonl`, JSON.stringify({ name: "recovery-reply-carriers", carriers }) + "\n");
    expect(carriers.some(row => row.runId === result.successors[0].id && row.hasReply)).toBe(true);
  });
  it("SUCCEEDED is not rescued by calling the existing fresh fallback", async () => {
    const f = await seed("in_review");
    const result = await ensureFreshContinuation(state.db, { companyId: f.companyId, runId: f.runId, trigger: "recovery_refused" });
    console.log("RFL_FALLBACK_SUCCEEDED", JSON.stringify(result));
    expect(result).toMatchObject({ kind: "continued" });
  });
  it("message 1's late reply is NOT an answer for unanswered message 2", async () => {
    const f = await seed("in_progress");
    const second = randomUUID();
    await state.db.insert(issueComments).values({ id: second, companyId: f.companyId, issueId: f.issueId,
      authorUserId: "recovery-user", authorType: "user", body: "And my second question?", createdAt: f.at(3.5), updatedAt: f.at(3.5) });
    await state.db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: f.runId, origin: "comment", body: "Answer only to the first question.", createdAt: f.at(3) });
    const secondRun = randomUUID();
    await state.db.insert(heartbeatRuns).values({ id: secondRun, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runtimeMode: "native", nativeIssueId: f.issueId, status: "succeeded", responsibleUserId: "recovery-user",
      createdAt: f.at(3.4), startedAt: f.at(3.3), finishedAt: f.at(2), contextSnapshot: { issueId: f.issueId, wakeCommentId: second } });
    expect(await conversationRunsForLastMessages(state.db, { companyId: f.companyId, issues: [{ issueId: f.issueId, agentId: f.agentId }] }))
      .toEqual([{ issueId: f.issueId, runId: secondRun, lastPersonCommentId: second, hasReply: false }]);
    await replyProcess(f); await state.start(); await flush();
    const result = await receipt(f, "two-messages-first-answer-only");
    expect(result.successors.filter(r => r.id !== secondRun)).toHaveLength(1);
  });
});
