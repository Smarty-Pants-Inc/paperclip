import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { answeredPersonMessageIds } from "../services/person-message-answer.js";
import {
  settleUnansweredPersonMessages, UNANSWERED_MESSAGE_NO_RUN_TEXT, UNANSWERED_MESSAGE_REASON_PREFIX,
} from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-sweep-every2 (RFL 09:03Z, never-OK): the no-card sweep owes a TRUE card
// for EVERY owed person message, not only the newest. Plain chat: M1 never
// reached the agent (no run carried it), M2 was answered. The person gets ONE
// card for M1; Delete or Send-again on M1 retires it; an answered message never
// gets a card. Real Postgres, the real sweep (the recovery worker's pass:
// discovery + settle), the real comment routes (POST, DELETE).
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("the sweep cards every owed person message, not only the newest", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "sweep-every-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sweep-every-owed-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.invalid`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.SWEEP_EVIDENCE) await fs.appendFile(process.env.SWEEP_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  /** A plain chat. M1 was saved but never reached the agent (no run's input lists it); M2 was carried and answered. */
  async function seed(opts: { m1Answered?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), m1 = randomUUID(), m2 = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Every", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active",
      membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } },
      permissions: {} });
    const t = (m: number) => new Date(Date.now() - (30 - m) * 60_000);
    await db.insert(issues).values({ id: issueId, companyId, identifier: `${issuePrefix}-1`, issueNumber: 1, title: "Chat",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId, responsibleUserId: userId, startedAt: t(0),
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    await db.insert(issueComments).values({ id: m1, companyId, issueId, authorType: "user", authorUserId: userId, body: "M1",
      createdAt: t(1), updatedAt: t(1) });
    await db.insert(issueComments).values({ id: m2, companyId, issueId, authorType: "user", authorUserId: userId, body: "M2",
      createdAt: t(2), updatedAt: t(2) });
    const answer = async (ids: string[], at: number) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand",
        triggerDetail: "manual", status: "succeeded", runtimeMode: "native", startedAt: t(at), finishedAt: t(at + 0.5),
        responsibleUserId: userId, nativeIssueId: issueId, issueId,
        contextSnapshot: { issueId, wakeCommentId: ids.at(-1), commentId: ids.at(-1), wakeCommentIds: ids, responsibleUserId: userId } })
        .returning();
      await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId, authorType: "agent",
        createdByRunId: run!.id, origin: "comment", body: `answer to ${ids.join(",")}`, createdAt: t(at + 0.5) });
      return run!.id;
    };
    if (opts.m1Answered) await answer([m1], 1.5);
    await answer([m2], 3);
    // Keeps every new run in the ordinary queue (no provider launch), as the interrupt files do.
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
    return { companyId, agentId, issueId, m1, m2, client };
  }
  type F = Awaited<ReturnType<typeof seed>>;

  /** The recovery worker's sweep (discovery + settle), its clock past every grace and wait bound. */
  async function sweep(f: F) {
    const out = [];
    for (const minutes of [30, 60]) out.push(await settleUnansweredPersonMessages(db, { companyId: f.companyId, issueId: f.issueId,
      now: new Date(Date.now() + minutes * 60_000) }));
    return out;
  }
  const allCards = async (f: F) => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
    eq(issueComments.authorType, "system")))).filter(c =>
    String((c.metadata as any)?.authorizationReason ?? "").startsWith(UNANSWERED_MESSAGE_REASON_PREFIX))
    .map(c => ({ message: String((c.metadata as any).authorizationReason).slice(UNANSWERED_MESSAGE_REASON_PREFIX.length),
      body: c.body, deleted: !!c.deletedAt }));
  const liveCards = async (f: F) => (await allCards(f)).filter(c => !c.deleted);

  it("row 1: M1 never carried + M2 answered => ONE true card for M1, none for M2", async () => {
    const f = await seed();
    const swept = await sweep(f);
    const cards = await liveCards(f);
    await evidence("row1", { m1: f.m1, m2: f.m2, swept, cards });
    expect(cards.map(c => c.message), JSON.stringify({ swept, cards })).toEqual([f.m1]);
    expect(cards[0]!.body).toBe(UNANSWERED_MESSAGE_NO_RUN_TEXT);
    // Idempotent: further sweeps never post a second card.
    await sweep(f);
    expect((await allCards(f)).map(c => c.message)).toEqual([f.m1]);
  }, 120_000);

  it("row 2: Delete M1 (real route) => its card retires, and is never posted again", async () => {
    const f = await seed();
    await sweep(f);
    expect((await liveCards(f)).map(c => c.message)).toEqual([f.m1]);
    const deleted = await request(f.client).delete(`/api/issues/${f.issueId}/comments/${f.m1}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    const swept = await sweep(f);
    const cards = await allCards(f);
    await evidence("row2", { swept, cards });
    expect(cards.filter(c => !c.deleted), JSON.stringify(cards)).toEqual([]);
    expect(cards.map(c => c.message), "still exactly one card ever, now retired").toEqual([f.m1]);
  }, 120_000);

  it("row 3: Send-again M1 (real route) => one run carries it, answered once, M1's card retired", async () => {
    const f = await seed();
    await sweep(f);
    expect((await liveCards(f)).map(c => c.message)).toEqual([f.m1]);
    const posted = await request(f.client).post(`/api/issues/${f.issueId}/comments`).send({ body: "M1", clientRequestId: randomUUID() });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const m3 = posted.body.id as string;
    // The real wake path: the resend's wake/run carries it.
    const deadline = Date.now() + 15_000;
    let carriers: (typeof heartbeatRuns.$inferSelect)[] = [];
    for (;;) {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      carriers = runs.filter(r => ((r.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(m3)
        || r.contextSnapshot?.wakeCommentId === m3);
      if (carriers.length || Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(w => ({ id: w.id, status: w.status, runId: w.runId, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    expect(carriers, `one run carries the resend: ${JSON.stringify({ wakes })}`).toHaveLength(1);
    const run = carriers[0]!;
    expect(run.contextSnapshot?.wakeCommentIds, "the resend is carried once; M1 is not sent a second time").toEqual([m3]);
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: run.id, origin: "comment", body: "answer to the resend" });
    const swept = await sweep(f);
    const cards = await allCards(f);
    const answered = await answeredPersonMessageIds(db, { companyId: f.companyId, issueId: f.issueId, commentIds: [f.m1, f.m2, m3] });
    const replies = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "agent")))).filter(c => c.createdByRunId === run.id);
    await evidence("row3", { m3, run: { id: run.id, ctx: run.contextSnapshot }, wakes, swept, cards, answered: [...answered] });
    expect(replies, "answered once").toHaveLength(1);
    expect([...answered]).toContain(m3);
    expect(cards.filter(c => !c.deleted), JSON.stringify(cards)).toEqual([]);
    expect(cards.map(c => c.message), "no card for the answered resend; M1's one card retired").toEqual([f.m1]);
  }, 120_000);

  it("control: M1 and M2 both answered => no card", async () => {
    const f = await seed({ m1Answered: true });
    const swept = await sweep(f);
    const cards = await allCards(f);
    await evidence("control", { swept, cards });
    expect(cards).toEqual([]);
  }, 120_000);
});
