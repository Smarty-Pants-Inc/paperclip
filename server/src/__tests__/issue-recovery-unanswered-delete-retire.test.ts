import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { UNANSWERED_MESSAGE_TEXT } from "../services/recovery/unanswered-person-message.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

// Keep (never-OK rule: no "wasn't answered" note stays on a thread about a message its author DELETED). rf-5 m9
// finding 2, RETIRE-ON-DELETE, chat AND task; the same class as app-lead's f9d45d53d on tB2 (al/norun-lossguard-2c),
// here for the group notice shape too.
// REAL (RULING-FIXTURES-FROM-REAL-PRODUCER-1118): the person's message is the real POST /api/issues/:id/comments;
// the run that carries it is the one the real route's own wake queued, and it fails for REAL (the agent's process
// exits 1); the note is written and retired by the REAL recovery worker as the server registers it; the delete is
// the AUTHOR's real DELETE /api/issues/:id/comments/:commentId; every outcome is read from the real
// GET /api/issues/:id/comments.
// PLANTED (named where done): the task / chat row, the agent's failing command, and the CLOCK (the message, its run
// and its wake are moved 20 minutes into the past so the sweep's grace has elapsed; no state is invented).
describeIssueRecovery("an unanswered-message note retires when its message is deleted (real routes, real worker)", () => {
  const state = issueRecoveryFixture();
  const USER = "recovery-user";

  async function seed(kind: "chat" | "task") {
    const f = await state.fixture();
    const db = state.db;
    // PLANTED: the agent's command fails, so the run the real route queues ends failed by itself.
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "process.exit(1)"], cwd: process.cwd() } })
      .where(eq(agents.id, f.agentId));
    // PLANTED: the task / the chat row.
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: kind === "chat" ? "Chat with Recovery process" : "A task",
      status: "in_progress", assigneeAgentId: f.agentId, createdAt: new Date(Date.now() - 30 * 60_000),
      ...(kind === "chat" ? { conversationAgentId: f.agentId, conversationUserId: USER, conversationState: "active" } : {}) })
      .returning({ id: issues.id });
    const issueId = task!.id;
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: USER, companyIds: [f.companyId],
        memberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {})); app.use(errorHandler);
    /** The REAL worker, as the server registers it (a fresh one each time: it sweeps on start). It runs until
     * `until` holds; with none, long enough for a pass that has nothing to do. */
    const worker = async (until?: () => Promise<void>) => {
      if (state.worker) await state.restart(); else await state.start();
      if (until) await vi.waitFor(until, { timeout: 30_000, interval: 250 });
      else await new Promise(resolve => setTimeout(resolve, 2_500));
    };
    /** REAL: the person's message through the comment route. */
    const post = async (body: string) => {
      const response = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response.body.id as string;
    };
    /** REAL: the runs the route's wakes queued run and fail by themselves (the real dispatch, the real process). */
    const runsEnd = async () => {
      await worker(async () => {
        const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
        expect(runs.length, "the route's wake queued a run").toBeGreaterThan(0);
        expect(runs.filter(run => ["queued", "running", "scheduled_retry"].includes(run.status))).toHaveLength(0);
      });
    };
    /** PLANTED: the CLOCK only. Everything this task has so far happened 20 minutes ago. */
    const age = async () => {
      await db.execute(sql`update ${issueComments} set created_at = created_at - interval '20 minutes', updated_at = updated_at - interval '20 minutes'
        where issue_id = ${issueId} and author_type = 'user'`);
      await db.execute(sql`update ${heartbeatRuns} set created_at = created_at - interval '20 minutes', started_at = started_at - interval '20 minutes',
        finished_at = finished_at - interval '20 minutes', updated_at = updated_at - interval '20 minutes' where company_id = ${f.companyId}`);
      await db.execute(sql`update ${agentWakeupRequests} set requested_at = requested_at - interval '20 minutes',
        finished_at = finished_at - interval '20 minutes', updated_at = updated_at - interval '20 minutes' where company_id = ${f.companyId}`);
    };
    /** REAL: what the thread's reader gets. */
    const thread = async () => {
      const response = await request(app).get(`/api/issues/${issueId}/comments`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body as Array<{ id: string; body: string; authorType: string; deletedAt?: string | null;
        metadata: Record<string, unknown> | null }>;
    };
    const notes = async () => (await thread()).filter(comment => !comment.deletedAt &&
      String(comment.metadata?.authorizationReason ?? "").startsWith("unanswered_message:"));
    /** REAL: the author deletes the message. */
    const remove = async (commentId: string) => {
      const response = await request(app).delete(`/api/issues/${issueId}/comments/${commentId}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    };
    /** Every note row ever written for this task, retired ones too (never re-posted = never a second row). */
    const everWritten = () => db.select({ id: issueComments.id, deletedAt: issueComments.deletedAt, metadata: issueComments.metadata })
      .from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"),
        sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
    return { ...f, db, issueId, post, runsEnd, age, worker, thread, notes, remove, everWritten };
  }

  it.each(["chat", "task"] as const)("%s: M noticed -> the author deletes M -> the next sweep retires the note (GET), never re-posted", async kind => {
    const f = await seed(kind);
    const m = await f.post("Is the release out?");
    await f.runsEnd();
    await f.age();
    await f.worker(async () => expect(await f.notes()).toHaveLength(1));
    const noticed = await f.notes();
    expect(noticed.map(note => note.metadata?.authorizationReason), "the real sweep wrote ONE note citing M").toEqual([`unanswered_message:${m}`]);
    expect(noticed[0]!.body, "the 'wasn't answered' note").toContain(UNANSWERED_MESSAGE_TEXT);

    await f.remove(m);
    expect((await f.thread()).filter(comment => comment.id === m && !comment.deletedAt), "M is deleted on the thread").toEqual([]);
    await f.worker(async () => expect(await f.notes(), "the note about the deleted message retired at the next sweep").toEqual([]));
    await f.worker(); await f.worker();
    expect(await f.notes(), "and it is never re-posted").toEqual([]);
    const rows = await f.everWritten();
    expect(rows.map(row => row.id), "the one note row, retired (no second note)").toEqual([noticed[0]!.id]);
    expect(rows[0]!.deletedAt).not.toBeNull();
  });

  it("task, a GROUP note: deleting one member drops it from the note; deleting the last retires the note", async () => {
    const f = await seed("task");
    // Two messages one failed run carried make ONE group note. The REAL route queues one run per message here, so
    // the run INPUT that names BOTH is PLANTED on those real failed runs (the shape of the neighbouring any-status row, issue-recovery-unanswered-
    // any-status-retire.test.ts "(a) MIXED group notice"), beside the real-route single-message row above.
    const m1 = await f.post("First question");
    const m2 = await f.post("Second question");
    await f.runsEnd();
    const real = await f.db.select({ id: heartbeatRuns.id, context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId));
    expect(real.map(run => run.context?.issueId), "the real runs of the two messages, both failed").toEqual(real.map(() => f.issueId));
    for (const run of real) await f.db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: {
      issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: m2, wakeCommentIds: [m1, m2] } }).where(eq(heartbeatRuns.id, run.id));
    await f.age();
    await f.worker(async () => expect(await f.notes()).toHaveLength(1));
    const [group] = await f.notes();
    expect(group?.metadata, "ONE group note for the two messages").toMatchObject({ unansweredMessageIds: [m1, m2],
      authorizationReason: `unanswered_message:${m2}` });

    await f.remove(m2);
    await f.worker(async () => expect((await f.notes())[0]?.metadata, "the note drops the deleted member").toMatchObject({ unansweredMessageIds: [m1] }));
    const shrunk = await f.notes();
    expect(shrunk.map(note => note.id), "a still-owed member: the SAME note stays").toEqual([group!.id]);
    expect(shrunk[0]!.metadata, "and it names only the message that is still there").toMatchObject({ unansweredMessageIds: [m1],
      authorizationReason: `unanswered_message:${m1}` });

    await f.remove(m1);
    await f.worker(async () => expect(await f.notes(), "every member deleted: the note retired").toEqual([]));
    await f.worker();
    expect((await f.everWritten()).map(row => row.deletedAt === null), "never a second note").toEqual([false]);
  });
});
