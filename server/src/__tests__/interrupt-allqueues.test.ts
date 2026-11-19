import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { heartbeatService } from "../services/heartbeat.js";
import { unansweredPersonMessageCommentCondition } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-interrupt-allqueues2: in Agent Chat each message typed during a live
// turn gets its OWN waiting wake (queue.ts allowRunCoalescing=false for chats),
// and the chat view lists them all under one Interrupt / Send. One Interrupt
// (the same route as the Stop bar's Send) must send ALL of them, in order, once.
// Real comment route (the person types), real Stop route, real Interrupt route
// called exactly as the bar calls it (issuesApi.interruptLatestQueuedComments:
// GET the queue, POST its head queueId/revision/targetRunId), real cancelRun,
// real resumeQueuedCommentInterrupt and admission. The live turn is a seeded
// row; its provider teardown and the successor's reply are seeded (as
// interrupt-rows.test.ts).
const support = await getEmbeddedPostgresTestSupport();

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!support.supported)("Interrupt sends ALL of the person's held chat messages", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "iaq-person";
  const otherUserId = "iaq-other";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-allqueues-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values([[userId, "Person"], [otherUserId, "Other"]].map(([id, name]) => ({ id: id!, name: name!,
      email: `${id}@example.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.IAQ_EVIDENCE) await fs.appendFile(process.env.IAQ_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  /** A chat (or task) whose live turn was started by the person's message M0. */
  async function seedLiveTurn(kind: "chat" | "task" = "chat") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const liveRunId = randomUUID(), m0 = randomUUID();
    const issuePrefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "IAQ", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values([userId, otherUserId].map(principalId => ({ companyId,
      principalType: "user" as const, principalId, status: "active" as const, membershipRole: "owner" as const })));
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } },
      permissions: {} });
    const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000);
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "running", runtimeMode: "native", startedAt: t(3), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeCommentId: m0, commentId: m0, wakeCommentIds: [m0], responsibleUserId: userId } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: `${issuePrefix}-1`, issueNumber: 1, title: "Chat",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId, responsibleUserId: userId, executionRunId: liveRunId,
      executionLockedAt: t(3), startedAt: t(2),
      ...(kind === "chat" ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}) });
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId, issueId }).where(eq(heartbeatRuns.id, liveRunId));
    await db.insert(issueComments).values({ id: m0, companyId, issueId, authorType: "user", authorUserId: userId, body: "M0",
      createdAt: t(2), updatedAt: t(2) });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: liveRunId, phase: "observed" });
    // Keeps every successor in the ordinary queue (no provider launch).
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    const clientFor = (actorUserId: string) => {
      const client = express();
      client.use(express.json());
      client.use((req, _res, next) => {
        (req as any).actor = { type: "board", source: "session", userId: actorUserId, companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
        next();
      });
      client.use("/api", issueRoutes(db, {} as any, {}));
      client.use("/api", agentRoutes(db, {}));
      client.use(errorHandler);
      return client;
    };
    return { kind, companyId, agentId, issueId, liveRunId, m0, client: clientFor(userId), other: clientFor(otherUserId) };
  }
  type F = Awaited<ReturnType<typeof seedLiveTurn>>;

  const deferredWakes = async (f: F) => (await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"))))
    .map(w => ({ id: w.id, by: w.requestedByActorId, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds as string[] ?? [] }))
    .filter(w => w.ids.length > 0);

  /** The person types `bodies` into the composer during the live turn (real comment route). */
  async function type(f: F, bodies: string[], client = f.client) {
    const ids: string[] = [];
    for (const body of bodies) {
      const before = (await deferredWakes(f)).flatMap(w => w.ids);
      const posted = await request(client).post(`/api/issues/${f.issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(posted.status, JSON.stringify(posted.body)).toBe(201);
      ids.push(posted.body.id);
      await waitFor(async () => (await deferredWakes(f)).flatMap(w => w.ids).length > before.length);
    }
    return ids;
  }

  /** Exactly the bar's call: issuesApi.interruptLatestQueuedComments(issueId, runId). */
  async function barInterrupt(f: F, expectedTargetRunId: string | null, client = f.client) {
    const queue = (await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
    if (!queue.queueId || (queue.targetRunId && queue.targetRunId !== expectedTargetRunId)) {
      throw new Error(`The queued messages changed: ${JSON.stringify(queue)}`);
    }
    const pressed = await request(client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: queue.targetRunId });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    return { queueId: queue.queueId as string, listed: (queue.entries as any[]).map(e => e.comment.id as string),
      targetRunId: queue.targetRunId as string | null, after: pressed.body };
  }

  /** The runner acknowledges the cancel and teardown ends (the executor's terminal write, seeded). */
  async function acknowledge(f: F, runId: string) {
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, processGroupId: null, resultJson: { ...stopped.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: "intent", acknowledgementAuditId: "ack" } } }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null })
      .where(eq(nativeRunFinalizations.runId, runId));
  }

  /** The receipt worker resumes every saved Interrupt (its pass, without the age gate). */
  async function resumeInterrupts(f: F) {
    const heartbeat = heartbeatService(db);
    for (let pass = 0; pass < 2; pass += 1) {
      const saved = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).filter(w => (w.payload as any)?.queuedCommentInterrupt);
      for (const wake of saved) await heartbeat.resumeQueuedCommentInterrupt(f.companyId, wake.id);
    }
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.contextSnapshot?.issueId === f.issueId && run.status !== "cancelled");
  }

  async function successorAnswers(f: F, runId: string) {
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
  }
  async function answeredBy(f: F, id: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "agent")));
    return runs.filter(run => run.status === "succeeded" && ((run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(id)
      && replies.some(reply => reply.createdByRunId === run.id)).map(run => run.id);
  }
  async function unanswered(f: F, ids: string[]) {
    return (await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.issueId, f.issueId), inArray(issueComments.id, ids), unansweredPersonMessageCommentCondition())))
      .map(row => row.id);
  }
  async function leftWaiting(f: F) {
    const queued = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      inArray(heartbeatRuns.status, ["queued", "running"])))).filter(run => run.contextSnapshot?.issueId === f.issueId);
    return { wakes: await deferredWakes(f), runs: queued.map(r => r.id) };
  }
  async function heldList(f: F) {
    const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
    return { state: queue.state as string, ids: (queue.entries as any[] ?? []).map(e => e.comment.id as string) };
  }

  /** One successor carries `expected` in order, each once, answers them, and nothing is left. */
  async function expectAllSentOnce(f: F, label: string, expected: string[], extra: Record<string, unknown>) {
    const runs = await resumeInterrupts(f);
    const snapshot = { ...extra, runs: runs.map(r => ({ id: r.id, status: r.status, ids: r.contextSnapshot?.wakeCommentIds })),
      waiting: await leftWaiting(f) };
    await evidence(label, snapshot);
    expect(runs, JSON.stringify(snapshot)).toHaveLength(1);
    const successor = runs[0]!;
    expect(successor.contextSnapshot?.wakeCommentIds, `${label}: in order, each once`).toEqual(expected);
    await successorAnswers(f, successor.id);
    for (const id of expected) expect(await answeredBy(f, id), `${id} answered once, by the successor`).toEqual([successor.id]);
    expect(await unanswered(f, expected)).toEqual([]);
    const after = await leftWaiting(f);
    const held = await heldList(f);
    await evidence(`${label}:after-reply`, { after, held });
    expect(after.wakes, "nothing left waiting").toEqual([]);
    expect(after.runs).toEqual([]);
    expect(held.ids, "the chat's held list is empty").toEqual([]);
    return successor;
  }

  it("RED-1: chat, H1-H3 typed during a live turn (3 queues); the bar's Interrupt sends M0 (carry), H1, H2, H3, each once, in order", async () => {
    const f = await seedLiveTurn();
    const held = await type(f, ["H1", "H2", "H3"]);
    const wakes = await deferredWakes(f);
    // The product path: one waiting wake per typed chat message.
    expect(wakes.map(w => w.ids)).toEqual(held.map(id => [id]));
    const click = await barInterrupt(f, f.liveRunId);
    expect(click.listed, "the view lists all three under the one Interrupt").toEqual(held);
    expect(click.targetRunId).toBe(f.liveRunId);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    expect(stopped.status).toBe("cancelled");
    await acknowledge(f, f.liveRunId);
    await expectAllSentOnce(f, "RED-1", [f.m0, ...held], { click, wakesBefore: wakes });
  }, 120_000);

  it("R2-chatq: chat, H1-H3 typed during a live turn, the person's real Stop (acknowledged), then the Stop bar's Send: all 3 once, in order, by ONE successor", async () => {
    const f = await seedLiveTurn();
    const held = await type(f, ["H1", "H2", "H3"]);
    const stop = await request(f.client).post(`/api/heartbeat-runs/${f.liveRunId}/cancel`).send({});
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    await acknowledge(f, f.liveRunId);
    const afterStop = { wakes: await deferredWakes(f), held: await heldList(f) };
    expect(afterStop.held.ids, "Stop sends nothing; all three stay listed").toEqual(held);
    // The Stop bar's Send: the same interruptLatestQueuedComments; no live run, so the queue's targetRunId.
    const click = await barInterrupt(f, null);
    expect(click.listed).toEqual(held);
    await expectAllSentOnce(f, "R2-chatq", held, { afterStop, click });
  }, 120_000);

  it("control: a task (coalesced, one queue) is unchanged: its one queue stays whole for the live run's first turn", async () => {
    const f = await seedLiveTurn("task");
    const held = await type(f, ["H1", "H2", "H3"]);
    const wakes = await deferredWakes(f);
    expect(wakes.map(w => w.ids), "a task coalesces into one queue").toEqual([held]);
    // A task's live run that has not shown a provider turn takes its one queue into that turn (firstTurnRunId):
    // the Interrupt leaves that ONE queue whole for it, and pulls in nothing else.
    const click = await barInterrupt(f, f.liveRunId);
    expect(click.listed).toEqual(held);
    const after = await deferredWakes(f);
    const [live] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    await evidence("control-task", { m0: f.m0, held, wakesBefore: wakes, wakesAfter: after, liveRun: live.status,
      executionWait: click.after.executionWait });
    expect(after.map(w => ({ id: w.id, ids: w.ids }))).toEqual(wakes.map(w => ({ id: w.id, ids: w.ids })));
    expect(live.status).toBe("running");
    expect(click.after.executionWait?.reason).toBe("first_turn_pending");
  }, 120_000);

  it("control: another user's queued message is NOT pulled in (a second user cannot post to the chat: 403; their saved wake stays theirs)", async () => {
    const f = await seedLiveTurn();
    const denied = await request(f.other).post(`/api/issues/${f.issueId}/comments`).send({ body: "OTHER", clientRequestId: randomUUID() });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    const [h1] = await type(f, ["H1"]);
    // Another user's waiting wake on the same chat/agent (seeded: the route refuses them), then the person's H2, H3.
    const otherComment = randomUUID(), otherWake = randomUUID();
    await db.insert(issueComments).values({ id: otherComment, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: otherUserId, body: "OTHER" });
    await db.insert(agentWakeupRequests).values({ id: otherWake, companyId: f.companyId, agentId: f.agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: otherUserId, payload: { issueId: f.issueId, commentId: otherComment,
        _paperclipWakeContext: { commentId: otherComment, wakeCommentId: otherComment, wakeCommentIds: [otherComment] } } });
    const later = await type(f, ["H2", "H3"]);
    await barInterrupt(f, f.liveRunId);
    await acknowledge(f, f.liveRunId);
    const runs = await resumeInterrupts(f);
    const waiting = await leftWaiting(f);
    await evidence("control-other-user", { runs: runs.map(r => ({ id: r.id, ids: r.contextSnapshot?.wakeCommentIds })), waiting });
    expect(runs).toHaveLength(1);
    const sent = runs[0]!.contextSnapshot?.wakeCommentIds as string[];
    expect(sent).not.toContain(otherComment);
    expect(sent.slice(0, 2)).toEqual([f.m0, h1]);
    expect(waiting.wakes.find(w => w.id === otherWake)?.ids, "the other user's wake still holds only their message").toEqual([otherComment]);
    void later;
  }, 120_000);

  it("control: Interrupt twice: each message once, in order", async () => {
    const f = await seedLiveTurn();
    const held = await type(f, ["H1", "H2"]);
    await barInterrupt(f, f.liveRunId);
    await acknowledge(f, f.liveRunId);
    const [run2] = await resumeInterrupts(f);
    expect(run2!.contextSnapshot?.wakeCommentIds).toEqual([f.m0, ...held]);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(), runtimeMode: "native", nativeIssueId: f.issueId })
      .where(eq(heartbeatRuns.id, run2!.id));
    await db.update(issues).set({ executionRunId: run2!.id }).where(eq(issues.id, f.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: run2!.id, phase: "observed" });
    const more = await type(f, ["H3", "H4"]);
    await barInterrupt(f, run2!.id);
    await acknowledge(f, run2!.id);
    await expectAllSentOnce(f, "control-twice", [f.m0, ...held, ...more], { run2: run2!.contextSnapshot?.wakeCommentIds });
  }, 120_000);
});
