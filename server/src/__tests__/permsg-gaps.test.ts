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

describe.skipIf(!support.supported)("permsg gaps: the per-message cards after an Interrupt whose successor fails", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "iaq-person";
  const otherUserId = "iaq-other";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("permsg-gaps-");
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

  // adopt-permsg-gaps (RFL gate-3 frames + rf-4): Paul asks for six steps (M0, the WORK), queues '6 x 7?' and
  // 'France?', presses the row Interrupt; the successor FAILS. Real comment + Interrupt routes, real carry
  // (resumeQueuedCommentInterrupt), real sweep (settleUnansweredPersonMessage = the card writer).
  const allCards = async (f: F) => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
    eq(issueComments.authorType, "system")))).filter(c => !c.deletedAt &&
    String((c.metadata as any)?.authorizationReason ?? "").startsWith(UNANSWERED_MESSAGE_REASON_PREFIX))
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  const cardOf = (c: any) => {
    const sections = (c.metadata?.sections ?? []) as any[];
    const rows = sections.flatMap(s => (s.rows ?? []) as any[]);
    return { message: String(c.metadata.authorizationReason).slice(UNANSWERED_MESSAGE_REASON_PREFIX.length),
      quote: sections.find(s => s.title === "Your message")?.rows?.[0]?.value as string | undefined,
      code: rows.find(r => r.label === "Failure code")?.value as string | undefined, body: c.body as string,
      all: JSON.stringify(c.metadata) + c.body };
  };
  async function sweep(f: F) {
    for (const minutes of [30, 60]) await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId,
      now: new Date(Date.now() + minutes * 60_000) });
  }
  async function personCase(kind: "chat" | "task") {
    const f = await seedLiveTurn(kind);
    await db.update(issueComments).set({ body: "Do these six steps: 1 plan 2 draft 3 check 4 fix 5 test 6 report" })
      .where(eq(issueComments.id, f.m0));
    const [q1, q2] = await type(f, ["6 x 7?", "France?"]);
    await barInterrupt(f, f.liveRunId);
    await acknowledge(f, f.liveRunId);
    const successors = await resumeInterrupts(f);
    expect(successors, JSON.stringify(successors.map(r => r.contextSnapshot))).toHaveLength(1);
    return { f, q1: q1!, q2: q2!, successor: successors[0]! };
  }

  // The person case is Agent Chat ("start a new chat"). A task's Interrupt (no chat held list) is a separate flow.
  for (const kind of ["chat"] as const) {
    it(`PG1 ${kind}: the Interrupt carry owns the interrupted WORK message explicitly, FIRST (wakeCommentIds), then the queued ones in order`, async () => {
      const { f, q1, q2, successor } = await personCase(kind);
      await evidence(`PG1-${kind}`, { m0: f.m0, q1, q2, carried: successor.contextSnapshot?.wakeCommentIds, successor: successor.status,
        waiting: await leftWaiting(f), wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).map(w => ({ s: w.status, r: w.runId, p: w.payload })) });
      expect(successor.contextSnapshot?.wakeCommentIds).toEqual([f.m0, q1, q2]);
    }, 120_000);

    it(`PG2 ${kind}: successor FAILS ⇒ ONE card per owed message (WORK + 6x7 + France), each quoting it; code true; person's action words`, async () => {
      const { f, q1, q2, successor } = await personCase(kind);
      await failRun(successor.id);
      await sweep(f);
      const cards = (await allCards(f)).map(cardOf);
      await evidence(`PG2-${kind}`, cards);
      expect(cards.map(c => c.message), JSON.stringify(cards)).toEqual([f.m0, q1, q2]);
      expect(cards.map(c => c.quote)).toEqual(["\u201cDo these six steps: 1 plan 2 draft 3 check 4 fix 5 test 6 report\u201d",
        "\u201c6 x 7?\u201d", "\u201cFrance?\u201d"]);
      for (const card of cards) {
        // The code line is hidden or TRUE: never unclassified_failure for a run whose own code is shown.
        expect(card.all).not.toContain("unclassified_failure");
        if (card.code !== undefined) expect(card.code).toBe("native_predecessor_retirement_unproven");
        // The action is the person's: send again or start a new chat, never 'assign this agent a new task'.
        expect(card.all).not.toMatch(/assign this agent a new task/i);
        expect(card.body).toMatch(/send (it|your message) again|start a new chat/i);
      }
    }, 120_000);

    it(`PG3 ${kind}: successor SUCCEEDS (answers) ⇒ no cards`, async () => {
      const { f, successor } = await personCase(kind);
      await successorAnswers(f, successor.id);
      await sweep(f);
      expect((await allCards(f)).map(cardOf)).toEqual([]);
    }, 120_000);
  }

  it("PG4: the person's own Stop of the WORK run ⇒ no card for the stopped work (the person ended it)", async () => {
    const f = await seedLiveTurn("chat");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: userId } }).where(eq(heartbeatRuns.id, f.liveRunId));
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    await sweep(f);
    expect((await allCards(f)).map(cardOf).map(c => c.message)).not.toContain(f.m0);
  }, 120_000);
});
