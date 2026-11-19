import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  settleUnansweredPersonMessage, unansweredPersonMessageCommentCondition,
} from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-interrupt-rows (review-fleet-5): on 2b WITH the no-card gate
// (unanswered-person-message.ts: a person's own Stop explains a held message
// away, but NOT a queued-comment Interrupt). Real Interrupt route
// (POST /issues/:id/queued-comments/interrupt), real cancelRun, real
// resumeQueuedCommentInterrupt and admission. The live turn and its held queue
// are seeded rows (the queued-comments route tests' seedQueue shape).
// IR_NO_CARRY=1 removes the carry (the mutation): the route's helper returns [].
vi.mock("../services/interrupted-turn-input.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/interrupted-turn-input.js")>();
  return {
    ...actual,
    interruptedTurnUnansweredCommentIds: (async (...args: Parameters<typeof actual.interruptedTurnUnansweredCommentIds>) =>
      process.env.IR_NO_CARRY ? [] : actual.interruptedTurnUnansweredCommentIds(...args)) as typeof actual.interruptedTurnUnansweredCommentIds,
  };
});

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("Interrupt rows (review-fleet-5): gate, answered, twice", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "ir-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-rows-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "ir@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.IR_EVIDENCE) await fs.appendFile(process.env.IR_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  async function seedLiveTurn() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const liveRunId = randomUUID(), wakeId = randomUUID();
    const [held1, held2, held3] = [randomUUID(), randomUUID(), randomUUID()];
    const issuePrefix = `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "IR", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000);
    // HELD1's own turn: live, its input is HELD1.
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "running", runtimeMode: "native", startedAt: t(3), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeCommentId: held1, commentId: held1, wakeCommentIds: [held1], responsibleUserId: userId } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: `${issuePrefix}-1`, title: "Chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", responsibleUserId: userId, executionRunId: liveRunId });
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId }).where(eq(heartbeatRuns.id, liveRunId));
    await db.insert(issueComments).values([[held1, "HELD1", 2], [held2, "HELD2", 4], [held3, "HELD3", 5]].map(([id, body, m]) => ({
      id: id as string, companyId, issueId, authorType: "user" as const, authorUserId: userId, body: body as string,
      createdAt: t(m as number), updatedAt: t(m as number) })));
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: userId, payload: { issueId, commentId: held3,
        _paperclipWakeContext: { commentId: held3, wakeCommentId: held3, wakeCommentIds: [held2, held3] } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: liveRunId, phase: "observed" });
    // Keeps every successor in the ordinary queue (no provider launch).
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use(errorHandler);
    return { companyId, agentId, issueId, liveRunId, wakeId, held1, held: [held2, held3], client };
  }
  type F = Awaited<ReturnType<typeof seedLiveTurn>>;

  /** The person's real Interrupt click on the live turn `targetRunId`. */
  async function press(f: F, targetRunId: string) {
    const queue = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    const pressed = await request(f.client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.body.queueId, targetRunId, revision: queue.body.revision });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, targetRunId));
    expect(stopped.status).toBe("cancelled");
    return { queueId: queue.body.queueId as string, stopped };
  }

  /** The runner acknowledges the cancel, teardown ends, the receipt worker resumes the Interrupt. */
  async function settleInterrupt(f: F, targetRunId: string, queueId: string) {
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, targetRunId));
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, processGroupId: null, resultJson: { ...stopped.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: targetRunId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: "intent", acknowledgementAuditId: "ack" } } }).where(eq(heartbeatRuns.id, targetRunId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null })
      .where(eq(nativeRunFinalizations.runId, targetRunId));
    const heartbeat = heartbeatService(db);
    await Promise.all(Array.from({ length: 3 }, () => heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId)));
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.contextSnapshot?.issueId === f.issueId && run.status !== "cancelled");
  }

  /** The successor answers: one agent reply saved by that run, the run succeeds (seeded provider outcome). */
  async function successorAnswers(f: F, runId: string) {
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
  }

  /** The person messages the product's own per-message predicate still counts as unanswered. */
  async function unanswered(f: F, ids: string[]) {
    return (await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.issueId, f.issueId), inArray(issueComments.id, ids), unansweredPersonMessageCommentCondition())))
      .map(row => row.id);
  }
  /** Each message: carried by a run that saved a reply. */
  async function answeredBy(f: F, id: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "agent")));
    return runs.filter(run => run.status === "succeeded" && ((run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(id)
      && replies.some(reply => reply.createdByRunId === run.id)).map(run => run.id);
  }
  async function cards(f: F) {
    return (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "system")))).map(c => ({ body: c.body,
      reason: (c.metadata as Record<string, unknown> | null)?.authorizationReason, deleted: !!c.deletedAt }));
  }

  it("A1: the no-card gate never 'explains' a message away after a queued-comment Interrupt (the interrupted turn is a person-cancelled run with queuedCommentInterruptQueueId)", async () => {
    const f = await seedLiveTurn();
    const { queueId } = await press(f, f.liveRunId);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    // Exactly the gate's inputs: a person's cancel, by the same person who wrote
    // the messages, saved after them; only queuedCommentInterruptQueueId differs from a Stop.
    expect(stopped.resultJson).toMatchObject({ cancelledByActorType: "user", cancelledByUserId: userId,
      queuedCommentInterruptQueueId: queueId });
    const outcome = await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId });
    await evidence("A1", { outcome, resultJson: stopped.resultJson });
    expect(outcome.kind, JSON.stringify(outcome)).not.toBe("explained");
  }, 120_000);

  it("A2: through the real Interrupt route the interrupted message is answered by the next turn (once), and the gate/card sweep sees it answered", async () => {
    const f = await seedLiveTurn();
    const { queueId } = await press(f, f.liveRunId);
    const runs = await settleInterrupt(f, f.liveRunId, queueId);
    expect(runs).toHaveLength(1);
    const successor = runs[0]!;
    await successorAnswers(f, successor.id);
    const all = [f.held1, ...f.held];
    const by = Object.fromEntries(await Promise.all(all.map(async id => [id, await answeredBy(f, id)])));
    const outcome = await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId });
    const open = await unanswered(f, all);
    await evidence("A2", { ids: successor.contextSnapshot?.wakeCommentIds, by, outcome, open, cards: await cards(f),
      noCarry: !!process.env.IR_NO_CARRY });
    // HELD1 is answered by the turn that carried it, never only "by time".
    expect(by[f.held1], "HELD1 answered by a turn that carried it").toEqual([successor.id]);
    for (const id of f.held) expect(by[id]).toEqual([successor.id]);
    expect(open).toEqual([]);
    expect(outcome.kind).toBe("answered");
  }, 120_000);

  it("A3: with the carry removed, does the interrupted message's true card show? (it must be carried, or carded)", async () => {
    const f = await seedLiveTurn();
    const { queueId } = await press(f, f.liveRunId);
    const runs = await settleInterrupt(f, f.liveRunId, queueId);
    expect(runs).toHaveLength(1);
    await successorAnswers(f, runs[0]!.id);
    const outcome = await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId });
    const open = await unanswered(f, [f.held1]);
    const carried = (await answeredBy(f, f.held1)).length > 0;
    const shown = (await cards(f)).filter(card => !card.deleted && card.reason === `unanswered_message:${f.held1}`);
    await evidence("A3", { noCarry: !!process.env.IR_NO_CARRY, ids: runs[0]!.contextSnapshot?.wakeCommentIds,
      outcome, held1StillUnansweredByPredicate: open, held1Carried: carried, held1Cards: shown });
    expect(carried || shown.length > 0, JSON.stringify({ outcome, open, ids: runs[0]!.contextSnapshot?.wakeCommentIds }))
      .toBe(true);
  }, 120_000);

  it("B: Interrupt TWICE in a row: each interrupted message is answered once, in order, no duplicate", async () => {
    const f = await seedLiveTurn();
    const first = await press(f, f.liveRunId);
    const [run2] = await settleInterrupt(f, f.liveRunId, first.queueId);
    expect(run2!.contextSnapshot?.wakeCommentIds).toEqual([f.held1, ...f.held]);
    // run2 starts (claimed, live provider turn) and HELD4 arrives while it runs.
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(), runtimeMode: "native", nativeIssueId: f.issueId })
      .where(eq(heartbeatRuns.id, run2!.id));
    await db.update(issues).set({ executionRunId: run2!.id }).where(eq(issues.id, f.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: run2!.id, phase: "observed" });
    const held4 = randomUUID(), wake2 = randomUUID();
    await db.insert(issueComments).values({ id: held4, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "HELD4" });
    await db.insert(agentWakeupRequests).values({ id: wake2, companyId: f.companyId, agentId: f.agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: userId, payload: { issueId: f.issueId, commentId: held4,
        _paperclipWakeContext: { commentId: held4, wakeCommentId: held4, wakeCommentIds: [held4] } } });
    const second = await press(f, run2!.id);
    const runs = await settleInterrupt(f, run2!.id, second.queueId);
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(w => ({ id: w.id, status: w.status, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    await evidence("B", { first: first.queueId, second: second.queueId, run2: run2!.contextSnapshot?.wakeCommentIds,
      runs: runs.map(r => ({ id: r.id, status: r.status, ids: r.contextSnapshot?.wakeCommentIds })), wakes });
    expect(runs, JSON.stringify({ wakes })).toHaveLength(1);
    const run3 = runs[0]!;
    const all = [f.held1, ...f.held, held4];
    expect(run3.contextSnapshot?.wakeCommentIds, "in order, each once").toEqual(all);
    await successorAnswers(f, run3.id);
    for (const id of all) expect(await answeredBy(f, id), `${id} answered exactly once`).toEqual([run3.id]);
    expect(await unanswered(f, all)).toEqual([]);
    // Nothing still waits to deliver any of them again.
    const pending = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"))));
    expect(pending.map(w => (w.payload as any)?._paperclipWakeContext?.wakeCommentIds)).toEqual([]);
    const queued = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      inArray(heartbeatRuns.status, ["queued", "running"])))).filter(run => run.contextSnapshot?.issueId === f.issueId);
    expect(queued).toEqual([]);
  }, 120_000);
});
