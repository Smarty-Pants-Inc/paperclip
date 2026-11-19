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
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_REASON_PREFIX, unansweredPersonMessageCommentCondition } from "../services/recovery/unanswered-person-message.js";
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

describe.skipIf(!support.supported)("Interrupt: a failed carrier never loses a message; an answered message is never sent twice", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "iaq-person";
  const otherUserId = "iaq-other";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-lostdouble-");
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

  // adopt-interrupt-lostdouble (Paul's live SMA-4 chain, 11-19 06:08-06:19Z).
  async function failRun(runId: string) {
    await db.update(heartbeatRuns).set({ status: "failed", startedAt: new Date(Date.now() - 30_000), finishedAt: new Date(),
      error: "native_predecessor_retirement_unproven: The previous run's session on this sandbox could not be retired",
      errorCode: "native_predecessor_retirement_unproven" }).where(eq(heartbeatRuns.id, runId));
  }
  /** "Whatever wake" answered `ids` (live: 55499099 carried MSG2 and replied). */
  async function otherRunAnswers(f: F, ids: string[]) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "succeeded", runtimeMode: "native", startedAt: new Date(), finishedAt: new Date(),
      responsibleUserId: userId, nativeIssueId: f.issueId, issueId: f.issueId,
      contextSnapshot: { issueId: f.issueId, wakeCommentId: ids.at(-1), commentId: ids.at(-1), wakeCommentIds: ids,
        responsibleUserId: userId } }).returning();
    await successorAnswers(f, run!.id);
    // Live: the deferred wake that carried them was coalesced into that run.
    for (const w of await deferredWakes(f)) {
      if (w.ids.every(id => ids.includes(id)) && !(await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, w.id)))[0]?.payload?.queuedCommentInterrupt) {
        await db.update(agentWakeupRequests).set({ status: "coalesced", runId: run!.id, finishedAt: new Date() })
          .where(eq(agentWakeupRequests.id, w.id));
      }
    }
    return run!.id;
  }
  const notices = async (f: F) => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
    eq(issueComments.authorType, "system")))).filter(c => !c.deletedAt &&
    String((c.metadata as any)?.authorizationReason ?? "").startsWith(UNANSWERED_MESSAGE_REASON_PREFIX))
    .map(c => String((c.metadata as any).authorizationReason).slice(UNANSWERED_MESSAGE_REASON_PREFIX.length));
  const carriedLater = async (f: F, id: string, after: string[]) => (await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => !after.includes(r.id) &&
      ((r.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(id) && r.status !== "failed").map(r => r.id);

  it("L1: chat, MSG1+MSG2 held in separate queues -> Interrupt -> the run carrying MSG1 FAILS before answering; MSG2 is answered by another wake ⇒ MSG1 is not silently lost (a retry carries it once, or ONE card PER owed message says it was not answered; SUPERSEDE-LOSTDOUBLE-PER-BATCH-TO-PER-MESSAGE-1119)", async () => {
    const f = await seedLiveTurn();
    const [msg1, msg2] = await type(f, ["MSG1", "MSG2"]);
    await barInterrupt(f, f.liveRunId);
    await acknowledge(f, f.liveRunId);
    const successors = await resumeInterrupts(f);
    expect(successors.length).toBeGreaterThan(0);
    const carrying = successors.find(r => ((r.contextSnapshot?.wakeCommentIds as string[]) ?? []).includes(msg1!))!;
    expect(carrying, "a successor carries MSG1").toBeTruthy();
    await failRun(carrying.id);
    // MSG2 answered via whatever wake still holds it (live: 6ec997ac -> 55499099), unless the failed run carried it too.
    const failedCarried = (carrying.contextSnapshot?.wakeCommentIds as string[]) ?? [];
    const answerer = failedCarried.includes(msg2!) ? null : await otherRunAnswers(f, [msg2!]);
    // Recovery: release drain + the stranded sweep (the card writer), clock past every grace.
    const heartbeat = heartbeatService(db);
    for (const w of (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"))))) {
      if ((w.payload as any)?.queuedCommentInterrupt) await heartbeat.resumeQueuedCommentInterrupt(f.companyId, w.id);
    }
    // The sweep records its bounded wait once (PENDING_WAIT_ACTION), then a later pass past the bound writes the card.
    const settled = [];
    for (const minutes of [30, 60]) settled.push(await settleUnansweredPersonMessage(db, { companyId: f.companyId,
      issueId: f.issueId, now: new Date(Date.now() + minutes * 60_000) }));
    const cards = await notices(f);
    const retried = await carriedLater(f, msg1!, [carrying.id, ...(answerer ? [answerer] : [])]);
    const snapshot = { msg1, msg2, carrying: { id: carrying.id, ids: failedCarried }, answerer, settled, cards, retried,
      answeredMsg1: await answeredBy(f, msg1!), unanswered: await unanswered(f, [msg1!, msg2!]) };
    await evidence("L1", snapshot);
    // SUPERSEDE-LOSTDOUBLE-PER-BATCH-TO-PER-MESSAGE-1119 (RFL): was 'ONE card per lost batch'. Now ONE card PER owed
    // message the failed run carried (in thread order), each re-owed once: by a retry carrying it OR by its own card.
    // adopt-permsg-gaps (1): the cut turn's own message M0 (the WORK) is carried FIRST by the Interrupt into the same
    // failed successor, so it is owed too and has its own card, first (it was silently dropped before).
    const owedCarried = [f.m0, msg1!, msg2!].filter(id => failedCarried.includes(id));
    expect(retried.length + cards.filter(id => id === msg1).length, `MSG1 re-owed once: ${JSON.stringify(snapshot)}`).toBe(1);
    if (retried.length === 0) expect(cards, `one card per owed message, in order: ${JSON.stringify(snapshot)}`).toEqual(owedCarried);
  }, 120_000);

  it("L1b (residual, live 06:15:44Z d2840901): after the failed carrier's card, the person types MSG3 and a run carrying ONLY MSG3 answers ⇒ MSG1 is still re-owed (not 'answered' by the later reply)", async () => {
    const f = await seedLiveTurn();
    const [msg1, msg2] = await type(f, ["MSG1", "MSG2"]);
    await barInterrupt(f, f.liveRunId);
    await acknowledge(f, f.liveRunId);
    const successors = await resumeInterrupts(f);
    const carrying = successors.find(r => ((r.contextSnapshot?.wakeCommentIds as string[]) ?? []).includes(msg1!))!;
    await failRun(carrying.id);
    for (const minutes of [30, 60]) await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId,
      now: new Date(Date.now() + minutes * 60_000) });
    const cardsBefore = await notices(f);
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    const msg3 = randomUUID();
    await db.insert(issueComments).values({ id: msg3, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "MSG3" });
    const answerer = await otherRunAnswers(f, [msg3]);
    await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(Date.now() + 90 * 60_000) });
    const cards = await notices(f);
    const retried = await carriedLater(f, msg1!, [carrying.id, answerer]);
    const snapshot = { msg1, msg2, msg3, carried: carrying.contextSnapshot?.wakeCommentIds, cardsBefore, cards, retried,
      unanswered: await unanswered(f, [msg1!, msg2!]) };
    await evidence("L1b", snapshot);
    // SUPERSEDE-LOSTDOUBLE-PER-BATCH-TO-PER-MESSAGE-1119 (RFL): was 'ONE card per lost batch'. Each owed message the
    // failed run carried keeps ITS OWN card (MSG3's answer retires neither), and none gains a second.
    const owedCarried = [msg1!, msg2!].filter(id => ((carrying.contextSnapshot?.wakeCommentIds as string[]) ?? []).includes(id));
    expect(retried.length + cards.filter(id => id === msg1).length, `MSG1 still re-owed once: ${JSON.stringify(snapshot)}`).toBe(1);
    if (retried.length === 0) expect(cards.filter(id => id === msg1 || id === msg2), `still one card per owed message: ${JSON.stringify(snapshot)}`).toEqual(owedCarried);
    expect(cardsBefore, "the second pass adds no card").toEqual(cards.filter(id => cardsBefore.includes(id)));
  }, 120_000);

  it("D1: chat, MSG1+MSG2 held in separate queues -> Interrupt -> both answered (via whatever wakes); the stale MSG2 queue the chat still lists is Interrupted ⇒ NO later run wakes on either again", async () => {
    const f = await seedLiveTurn();
    const [msg1, msg2] = await type(f, ["MSG1", "MSG2"]);
    await barInterrupt(f, f.liveRunId);
    await acknowledge(f, f.liveRunId);
    const successors = await resumeInterrupts(f);
    for (const run of successors) await successorAnswers(f, run.id);
    const carriedBySuccessors = successors.flatMap(r => (r.contextSnapshot?.wakeCommentIds as string[]) ?? []);
    // Live: MSG2's message wake 6ec997ac was coalesced into 55499099 (answered), its Interrupt queue 47003c5d stayed.
    if (!carriedBySuccessors.includes(msg2!)) await otherRunAnswers(f, [msg2!]);
    const answeredRuns = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map(r => r.id);
    const stale = await deferredWakes(f);
    const listed = await heldList(f);
    // The person sees MSG2 still held and presses Interrupt again (06:14:59Z); the worker resumes it.
    let pressed: unknown = null;
    if (listed.ids.length) pressed = await barInterrupt(f, null).catch(err => String(err));
    // Live 47003c5d: the Interrupt queue keyed to MSG2 (seeded when the route lists nothing to press).
    if (!stale.some(w => w.ids.includes(msg2!))) {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
        reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
        requestedByActorId: userId, payload: { issueId: f.issueId, commentId: msg2,
          _paperclipWakeContext: { issueId: f.issueId, commentId: msg2, wakeCommentId: msg2, wakeCommentIds: [msg2] },
          queuedCommentInterrupt: { actorId: userId, requestedAt: new Date().toISOString() } } });
    }
    await resumeInterrupts(f);
    const later = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(r => !answeredRuns.includes(r.id) && r.contextSnapshot?.issueId === f.issueId)
      .map(r => ({ id: r.id, status: r.status, ids: (r.contextSnapshot?.wakeCommentIds as string[]) ?? [] }));
    const snapshot = { msg1, msg2, stale, listed, pressed, later, waiting: await leftWaiting(f) };
    await evidence("D1", snapshot);
    expect(later.filter(r => r.ids.includes(msg1!) || r.ids.includes(msg2!)), `no double: ${JSON.stringify(snapshot)}`).toEqual([]);
    expect(snapshot.waiting.wakes.filter(w => w.ids.includes(msg1!) || w.ids.includes(msg2!)), "nothing left owing them").toEqual([]);
  }, 120_000);
});
