// SUPERSEDE-LOSTDOUBLE-PER-BATCH-TO-PER-MESSAGE-1119 (RFL): one failed run lost M1 AND M2 => TWO cards, in thread
// order, each NAMING its message; Retry on one card re-sends ONLY that message; deleting one retires only its card.
// Boundary: real PG + the real sweep (settleUnansweredPersonMessage) + the real routes (wakeup Retry, comment Delete).
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_REASON_PREFIX } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("G1 per-message cards (SUPERSEDE-LOSTDOUBLE-PER-BATCH-TO-PER-MESSAGE-1119)", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const userId = randomUUID();
  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("g1-permsg-"); db = createDb(pg.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Paul", email: `${userId}@example.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await pg?.cleanup(); });

  async function seed(chat: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), m1 = randomUUID(), m2 = randomUUID();
    const time = (n: number) => new Date(Date.now() - 300_000 + n * 1000);
    await db.insert(companies).values({ id: companyId, name: "Per message", issuePrefix: `P${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle", adapterType: "paperclip_runner", adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Two lost messages", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: userId, createdAt: time(0),
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active", conversationSessionGeneration: 0 } : {}) });
    await db.insert(issueComments).values([
      { id: m1, companyId, issueId, authorType: "user", authorUserId: userId, body: "Please rename the report to Q3 totals", createdAt: time(1) },
      { id: m2, companyId, issueId, authorType: "user", authorUserId: userId, body: "And email it to Dana when done", createdAt: time(2) }]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native", nativeIssueId: issueId, issueId,
      startedAt: time(3), createdAt: time(3), finishedAt: time(4), updatedAt: time(4), errorCode: "process_lost", responsibleUserId: userId,
      contextSnapshot: { issueId, wakeCommentId: m2, commentId: m2, wakeCommentIds: [m1, m2], responsibleUserId: userId, ...(chat ? { conversationSessionGeneration: 0 } : {}) } });
    // An unrelated running run fills the agent's one slot, so the Retry's successor stays queued (no provider needed).
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    const client = express(); client.use(express.json());
    client.use((req, _res, next) => { (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false }; next(); });
    client.use("/api", issueRoutes(db, {} as any, {})); client.use("/api", agentRoutes(db, {})); client.use(errorHandler);
    return { companyId, agentId, issueId, runId, m1, m2, client };
  }
  const cards = async (f: { issueId: string }) => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  const messageOf = (card: any) => String(card.metadata?.authorizationReason ?? "").slice(UNANSWERED_MESSAGE_REASON_PREFIX.length);
  const quoteOf = (card: any) => card.metadata?.sections?.find((s: any) => s.title === "Your message")?.rows?.[0]?.value;

  for (const chat of [true, false]) {
    it(`${chat ? "chat" : "task"}: two lost messages => two cards in thread order, each naming its message; a second sweep adds none`, async () => {
      const f = await seed(chat);
      await settleUnansweredPersonMessage(db, f); await settleUnansweredPersonMessage(db, f);
      const notices = await cards(f);
      expect(notices.map(messageOf)).toEqual([f.m1, f.m2]);
      expect(notices.map(quoteOf)).toEqual(["\u201cPlease rename the report to Q3 totals\u201d", "\u201cAnd email it to Dana when done\u201d"]);
    }, 120_000);

    it(`${chat ? "chat" : "task"}: Retry on M1's card re-sends ONLY M1; a message the run never carried is refused`, async () => {
      const f = await seed(chat);
      await settleUnansweredPersonMessage(db, f);
      const stranger = randomUUID();
      const refused = await request(f.client).post(`/api/agents/${f.agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual",
        reason: "retry_failed_run", failedRunId: f.runId, messageId: stranger });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      const retry = await request(f.client).post(`/api/agents/${f.agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual",
        reason: "retry_failed_run", failedRunId: f.runId, messageId: f.m1 });
      expect(retry.status, JSON.stringify(retry.body)).toBe(202);
      const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.body.id));
      expect(next!.contextSnapshot?.wakeCommentIds).toEqual([f.m1]);
      expect(next!.contextSnapshot?.wakeCommentId).toBe(f.m1);
    }, 120_000);

    // RETRY-DEDUP-PER-MESSAGE (rf-4 F1): retry ownership is (failedRunId, the selected message ids).
    const retryOne = (f: Awaited<ReturnType<typeof seed>>, messageId: string) => request(f.client).post(`/api/agents/${f.agentId}/wakeup`)
      .send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: f.runId, messageId });
    const successors = async (f: { runId: string }) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId));
    const carriedCounts = (runs: any[]) => {
      const counts: Record<string, number> = {};
      for (const run of runs) for (const id of new Set<string>(run.contextSnapshot?.wakeCommentIds ?? [])) counts[id] = (counts[id] ?? 0) + 1;
      return counts;
    };

    it(`${chat ? "chat" : "task"}: Retry M1 then Retry M2 => both carried (thread order), each by exactly one successor`, async () => {
      const f = await seed(chat);
      await settleUnansweredPersonMessage(db, f);
      const first = await retryOne(f, f.m1);
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      const second = await retryOne(f, f.m2);
      expect(second.status, JSON.stringify(second.body)).toBe(202);
      const runs = await successors(f);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot?.wakeCommentIds).toEqual([f.m1, f.m2]);
      expect(runs[0]!.contextSnapshot?.wakeCommentId).toBe(f.m2);
      expect(carriedCounts(runs)).toEqual({ [f.m1]: 1, [f.m2]: 1 });
    }, 120_000);

    it(`${chat ? "chat" : "task"}: Retry M2 then Retry M1 => one successor carrying both in thread order`, async () => {
      const f = await seed(chat);
      await settleUnansweredPersonMessage(db, f);
      expect((await retryOne(f, f.m2)).status).toBe(202);
      expect((await retryOne(f, f.m1)).status).toBe(202);
      const runs = await successors(f);
      expect(runs.map(run => run.contextSnapshot?.wakeCommentIds)).toEqual([[f.m1, f.m2]]);
    }, 120_000);

    it(`${chat ? "chat" : "task"}: Retry M1 twice => one successor (dedup kept)`, async () => {
      const f = await seed(chat);
      await settleUnansweredPersonMessage(db, f);
      const first = await retryOne(f, f.m1), again = await retryOne(f, f.m1);
      expect(first.status).toBe(202); expect(again.status).toBe(202);
      expect(again.body.id).toBe(first.body.id);
      const runs = await successors(f);
      expect(runs.map(run => run.contextSnapshot?.wakeCommentIds)).toEqual([[f.m1]]);
    }, 120_000);

    it(`${chat ? "chat" : "task"}: Retry M2 after M1's successor STARTED and ended => M2 carried by a NEW run; M1 not re-sent`, async () => {
      const f = await seed(chat);
      await settleUnansweredPersonMessage(db, f);
      const first = await retryOne(f, f.m1);
      expect(first.status).toBe(202);
      await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() }).where(eq(heartbeatRuns.id, first.body.id));
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
      const second = await retryOne(f, f.m2);
      expect(second.status, JSON.stringify(second.body)).toBe(202);
      expect(second.body.id).not.toBe(first.body.id);
      const runs = await successors(f);
      expect(runs).toHaveLength(2);
      expect(runs.find(run => run.id === first.body.id)!.contextSnapshot?.wakeCommentIds).toEqual([f.m1]);
      expect(runs.find(run => run.id === second.body.id)!.contextSnapshot?.wakeCommentIds).toEqual([f.m2]);
      expect(carriedCounts(runs)).toEqual({ [f.m1]: 1, [f.m2]: 1 });
      const replay = await retryOne(f, f.m2);
      expect(replay.body.id).toBe(second.body.id);
      expect(await successors(f)).toHaveLength(2);
    }, 120_000);

    it(`${chat ? "chat" : "task"}: Retry M2 while M1's successor RUNS => M2 waits in ONE deferred wake of its own (not M1's run)`, async () => {
      const f = await seed(chat);
      await settleUnansweredPersonMessage(db, f);
      const first = await retryOne(f, f.m1);
      expect(first.status).toBe(202);
      await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, first.body.id));
      const second = await retryOne(f, f.m2);
      expect(second.body.id).not.toBe(first.body.id);
      await retryOne(f, f.m2);
      const runs = await successors(f);
      expect(runs.map(run => run.contextSnapshot?.wakeCommentIds)).toEqual([[f.m1]]);
      const deferred = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")));
      expect(deferred.map(row => (row.payload as any)?._paperclipWakeContext?.wakeCommentIds)).toEqual([[f.m2]]);
    }, 120_000);

    it(`${chat ? "chat" : "task"}: deleting M1 retires only M1's card`, async () => {
      const f = await seed(chat);
      await settleUnansweredPersonMessage(db, f);
      const del = await request(f.client).delete(`/api/issues/${f.issueId}/comments/${f.m1}`).send({});
      expect(del.status, JSON.stringify(del.body)).toBeLessThan(300);
      await settleUnansweredPersonMessage(db, f);
      expect((await cards(f)).map(messageOf)).toEqual([f.m2]);
    }, 120_000);
  }
});
