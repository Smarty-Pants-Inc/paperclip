import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  assets, heartbeatRuns, issueAttachments, issueComments, issues,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { answeredPersonMessageIds } from "../services/person-message-answer.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import {
  settleUnansweredPersonMessages, UNANSWERED_CARRIED_STEER_FAILED_TEXT, UNANSWERED_MESSAGE_NO_RUN_TEXT,
  UNANSWERED_MESSAGE_REASON_PREFIX,
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

  // rf-4's B' row (adopt-lead + rf-4, 10:09Z): cut A's carried-steer notice and sweep-every2's older cards in ONE
  // pass. m was steered into a run that ended without answering it (restored), and the next turn carrying m FAILED
  // before answering; M0 (seed's M1) is older and never reached the agent. Exactly ONE card for m (A's notice) and
  // ONE for M0; further passes add nothing (never two for m).
  it("row B': steered m whose carrying turn FAILED + older never-reached M0 => ONE card each, never two for m", async () => {
    const f = await seed();
    const m0 = f.m1;
    const t = (m: number) => new Date(Date.now() - (30 - m) * 60_000);
    const m = randomUUID();
    await db.insert(issueComments).values({ id: m, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "m, steered mid-turn", createdAt: t(4), updatedAt: t(4) });
    // The turn m was steered into ended without reading it: its run end restored m (restoreUnansweredSteersAtRunEnd).
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "succeeded", runtimeMode: "native", startedAt: t(3.5), finishedAt: t(4.5),
      responsibleUserId: userId, nativeIssueId: f.issueId, issueId: f.issueId,
      contextSnapshot: { issueId: f.issueId, steeredCommentIds: [], responsibleUserId: userId },
      resultJson: { restoredSteeredCommentIds: [m] } });
    // The next turn carried m and FAILED before answering it.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "failed", runtimeMode: "native", startedAt: t(5), finishedAt: t(5.5),
      error: "adapter_failed: the provider exited", errorCode: "adapter_failed",
      responsibleUserId: userId, nativeIssueId: f.issueId, issueId: f.issueId,
      contextSnapshot: { issueId: f.issueId, wakeCommentId: m, commentId: m, wakeCommentIds: [m], responsibleUserId: userId } });
    const swept = await sweep(f);
    const cards = await allCards(f);
    await evidence("rowBprime", { m0, m, m2: f.m2, swept, cards });
    const forM = cards.filter(c => c.message === m), forM0 = cards.filter(c => c.message === m0);
    expect(forM, `exactly one card for m: ${JSON.stringify({ swept, cards })}`).toHaveLength(1);
    expect(forM[0]!.body, "m's card is cut A's carried-steer notice").toBe(UNANSWERED_CARRIED_STEER_FAILED_TEXT);
    expect(forM0, `exactly one card for M0: ${JSON.stringify({ swept, cards })}`).toHaveLength(1);
    expect(forM0[0]!.body).toBe(UNANSWERED_MESSAGE_NO_RUN_TEXT);
    expect(cards.filter(c => c.message === f.m2), "none for the answered M2").toEqual([]);
    expect(cards.every(c => !c.deleted)).toBe(true);
    // A second pass adds nothing: never two for m, never two for M0.
    const again = await sweep(f);
    const after = await allCards(f);
    await evidence("rowBprime-second-pass", { again, after });
    expect(after.map(c => c.message).sort(), JSON.stringify(after)).toEqual([m, m0].sort());
  }, 120_000);

  // G1 (rf-4 B' verdict, 25, never-told): m was carried (steered) into a run that FAILED with no reply; a LATER
  // message M3 was answered. The ONE answered rule says m is owed (L1b, failed carrier), so the person gets exactly
  // ONE card for m, and a second pass adds nothing. Controls: the same m carried by a LIVE run gets no card while it
  // is live; carried by a SUCCEEDED run that answered it, no card.
  async function g1(carrier: "failed" | "running" | "succeeded") {
    const f = await seed();
    const t = (n: number) => new Date(Date.now() - (30 - n) * 60_000);
    const m = randomUUID(), m3 = randomUUID();
    await db.insert(issueComments).values({ id: m, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "m, steered mid-turn", createdAt: t(4), updatedAt: t(4) });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: carrier, runtimeMode: "native", startedAt: t(3.5),
      finishedAt: carrier === "running" ? null : t(5), errorCode: carrier === "failed" ? "process_lost" : null,
      responsibleUserId: userId, nativeIssueId: f.issueId, issueId: f.issueId,
      contextSnapshot: { issueId: f.issueId, wakeCommentIds: [m], steeredCommentIds: [m],
        ...(carrier === "succeeded" ? { answeredSteeredCommentIds: [m] } : {}), responsibleUserId: userId } }).returning();
    if (carrier === "succeeded") await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorAgentId: f.agentId, authorType: "agent", createdByRunId: run!.id, origin: "comment", body: "answer to m", createdAt: t(5) });
    await db.insert(issueComments).values({ id: m3, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "M3", createdAt: t(6), updatedAt: t(6) });
    const [run3] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "succeeded", runtimeMode: "native", startedAt: t(7), finishedAt: t(8),
      responsibleUserId: userId, nativeIssueId: f.issueId, issueId: f.issueId,
      contextSnapshot: { issueId: f.issueId, wakeCommentId: m3, commentId: m3, wakeCommentIds: [m3], responsibleUserId: userId } }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: run3!.id, origin: "comment", body: "answer to M3 only", createdAt: t(9) });
    const answered = await answeredPersonMessageIds(db, { companyId: f.companyId, issueId: f.issueId, commentIds: [m, m3] });
    const first = await sweep(f), afterFirst = (await allCards(f)).filter(c => c.message === m);
    const second = await sweep(f), afterSecond = (await allCards(f)).filter(c => c.message === m);
    // Every run that ever carried m (a re-send would add one).
    const carriersOfM = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(r => JSON.stringify(r.contextSnapshot ?? {}).includes(m)).map(r => r.id);
    await evidence(`g1-${carrier}`, { m, m3, runId: run!.id, answered: [...answered], first, afterFirst, second, afterSecond, carriersOfM });
    return { m, m3, runId: run!.id, answered, first, afterFirst, second, afterSecond, carriersOfM, all: await allCards(f) };
  }

  // SUPERSEDE-G1-CARRIED-FAILED-FLOOR-B-1119 (adopt-lead, 11-19): G1 is re-pinned. m was carried, its carrier
  // failed, then a LATER succeeded replying run started after it: the chat moved on (the floor, option B), so the
  // late sweep posts NO card for m and nothing re-sends m. The person was told AT THE FAILURE instead: the failed
  // carrier's own failure card names m (row G1-naming below). Supersedes the earlier "exactly ONE card for m" pin.
  it("row G1 (SUPERSEDE-G1-CARRIED-FAILED-FLOOR-B-1119): carried, failed, then a later succeeded replying run started after it => no card, no re-send", async () => {
    const r = await g1("failed");
    expect(r.answered.has(r.m), "m stays unanswered by the one predicate (L1b)").toBe(false);
    expect(r.answered.has(r.m3)).toBe(true);
    expect(r.afterFirst, `no late sweep card for m: ${JSON.stringify(r)}`).toEqual([]);
    expect(r.afterSecond, "a second pass adds nothing").toEqual([]);
    expect(r.carriersOfM, "no re-send: only the failed carrier ever carried m").toEqual([r.runId]);
    expect(r.all.filter(c => c.message === r.m3), "none for the answered M3").toEqual([]);
  }, 120_000);

  // G1-naming (adopt-g1-naming, SUPERSEDE-G1-CARRIED-FAILED-FLOOR-B-1119): AT THE FAILURE, the failed carrier's own
  // failure card ("Couldn't finish this attempt. Your message is saved." + Retry) names the person messages that
  // run carried, quoted short, oldest first. Real Postgres, the real projection the card renders.
  async function failedCarrier(carried: "m1m2" | "nothing") {
    const f = await seed();
    const t = (n: number) => new Date(Date.now() - (30 - n) * 60_000);
    const a = randomUUID(), b = randomUUID();
    // Saved in this order: a (older) then b; the run lists them newest first, the card still quotes oldest first.
    await db.insert(issueComments).values({ id: a, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "Please rename the billing export to invoices.csv", createdAt: t(4), updatedAt: t(4) });
    await db.insert(issueComments).values({ id: b, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "Also add a total row at the bottom of the sheet, with the currency in every cell, "
        + "and keep the old file for a week so the finance team can compare", createdAt: t(5), updatedAt: t(5) });
    const agentNote = randomUUID();
    await db.insert(issueComments).values({ id: agentNote, companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.agentId, body: "an agent note", createdAt: t(5.2), updatedAt: t(5.2) });
    // adopt-naming-words: an attachment-only person message (empty body + a file) is named "(attachment)"; an
    // empty body with no file is not a message.
    const file = randomUUID(), blank = randomUUID();
    await db.insert(issueComments).values({ id: file, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "", createdAt: t(5.1), updatedAt: t(5.1) });
    await db.insert(issueComments).values({ id: blank, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "  ", createdAt: t(5.15), updatedAt: t(5.15) });
    const [asset] = await db.insert(assets).values({ companyId: f.companyId, provider: "local_disk", objectKey: `nw/${file}`,
      contentType: "image/png", byteSize: 1, sha256: "0".repeat(64), originalFilename: "screen.png" }).returning();
    await db.insert(issueAttachments).values({ companyId: f.companyId, issueId: f.issueId, assetId: asset!.id, issueCommentId: file });
    const ids = carried === "m1m2" ? [blank, file, b, a] : [agentNote];
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "failed", runtimeMode: "native", startedAt: t(6), finishedAt: t(6.5),
      error: "adapter_failed: the provider exited", errorCode: "adapter_failed",
      responsibleUserId: userId, nativeIssueId: f.issueId, issueId: f.issueId,
      contextSnapshot: { issueId: f.issueId, wakeCommentId: ids[0], commentId: ids[0], wakeCommentIds: ids, responsibleUserId: userId } })
      .returning();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const presentation = await taskInterruptionPresentation(db, issue!);
    await evidence(`g1-naming-${carried}`, { a, b, runId: run!.id, presentation });
    return { a, b, file, presentation };
  }

  it("row G1-naming: a run carrying M1+M2 FAILS => its failure card quotes M1, M2 (oldest first)", async () => {
    const { a, b, file, presentation } = await failedCarrier("m1m2");
    expect(presentation?.state, JSON.stringify(presentation)).toBe("failed");
    expect(presentation?.responsibility).toBe("system");
    expect(presentation?.canRetry).toBe(true);
    expect(presentation?.carriedMessages, JSON.stringify(presentation)).toEqual([
      { id: a, quote: "Please rename the billing export to invoices.csv" },
      // adopt-naming-words: the person's own text, cut at ~60 characters with '…'.
      { id: b, quote: "Also add a total row at the bottom of the sheet, with the…" },
      { id: file, quote: "", attachmentOnly: true },
    ]);
  }, 120_000);

  it("row G1-naming control: a failed run carrying nothing person-authored => card unchanged (names nothing)", async () => {
    const { presentation } = await failedCarrier("nothing");
    expect(presentation?.state, JSON.stringify(presentation)).toBe("failed");
    expect(presentation?.canRetry).toBe(true);
    expect(presentation && "carriedMessages" in presentation, JSON.stringify(presentation)).toBe(false);
  }, 120_000);

  it("control G1-live: m carried by a LIVE (running) run => no card for m while it is live", async () => {
    const r = await g1("running");
    expect(r.afterSecond, JSON.stringify(r)).toEqual([]);
  }, 120_000);

  it("control G1-succeeded: m carried by a SUCCEEDED run that answered it => no card for m", async () => {
    const r = await g1("succeeded");
    expect(r.answered.has(r.m)).toBe(true);
    expect(r.afterSecond, JSON.stringify(r)).toEqual([]);
  }, 120_000);

  it("control: M1 and M2 both answered => no card", async () => {
    const f = await seed({ m1Answered: true });
    const swept = await sweep(f);
    const cards = await allCards(f);
    await evidence("control", { swept, cards });
    expect(cards).toEqual([]);
  }, 120_000);
});
