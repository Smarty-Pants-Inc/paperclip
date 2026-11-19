import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep (PERSON CASE, merged fold): after a person Resumes a paused agent, a message waiting for its run shows
// EXACTLY ONE true line (the run's header or the saved wake's panel line): never the stale '<agent> is paused' note
// beside it, never silence. While the message's OWN run is running the note says WORKING; if that run ends
// unanswered, the merged line's own words replace it IN PLACE (same id, one note).
// REAL: POST /api/agents/:id/pause, POST /api/issues/:id/comments, POST /api/agents/:id/resume; the REAL lifecycle
// worker (pausing -> paused, resuming -> ready); real admission, chat outbox delivery, claim and run creation on the
// native executor path (heartbeat.reconcileStrandedAssignedIssues / resumeQueuedRuns, as the server's workers call
// them); the REAL unanswered sweep (settleUnansweredPersonMessage, the worker's per-task entry) with a logical
// clock. Every outcome is read from the real GET /api/issues/:id/comments (+ queued-comments, heartbeat-runs).
// SCRIPTED EDGE ONLY (named): the provider turn (executePaperclipNativeSession). It can be HELD open per task (the run stays
// 'running') and then ends with an answer, or with no reply.
const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
  holds: {} as Record<string, Promise<"answer" | "silent">>,
}));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      fixture.calls.push(runId);
      const { issueComments, heartbeatRuns } = await import("@paperclipai/db");
      const { eq } = await import("drizzle-orm");
      const [run] = await (fixture.db as any).select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const issueId = (run?.contextSnapshot as { issueId?: string } | null)?.issueId ?? fixture.issueId;
      const outcome = await (fixture.holds[issueId] ?? Promise.resolve("answer" as const));
      if (outcome === "silent") return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "no reply" };
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { createLifecycleWorker } from "../modules/agent-lifecycle/application/worker.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
const NAME = "Managed Pi";
const PERSON = "mfold-person";
// Literals, deliberately independent of the production constants.
const PAUSED = "Managed Pi is paused. Your message is saved, and it will run when Managed Pi is resumed. "
  + "A board user or Managed Pi's manager can resume Managed Pi.";
const WORKING = "Managed Pi is working on your message.";
const NO_REPLY = "This run finished without a reply to your message. Sending it again is safe.";
const samples: unknown[] = [];

describe.skipIf(!support.supported)("merged fold: after Resume a waiting message has ONE true line; WORKING only while its own run runs", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pause-resume-one-line-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "pause-resume-one-line-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: PERSON, name: "Person", email: "mfold@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    // To refresh ui/src/components/task-chat/fixtures/pause-resume-real-route.json: set MFOLD_CAPTURE_DIR.
    if (process.env.MFOLD_CAPTURE_DIR) {
      await fs.mkdir(process.env.MFOLD_CAPTURE_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.MFOLD_CAPTURE_DIR, "pause-resume-real-route.json"), JSON.stringify(samples, null, 2) + "\n");
    }
    fixture.holds = {};
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  async function seed(chat: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    // PLANTED (named): the company, the agent and its task / chat row. Nothing below is planted.
    await db.insert(companies).values({ id: companyId, name: "mfold", issuePrefix, defaultResponsibleUserId: PERSON,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: PERSON,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: NAME, role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: chat ? "Chat with Managed Pi" : "A task", status: chat ? "in_progress" : "todo",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 1, identifier: `${issuePrefix}-1`,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: PERSON, conversationState: "active" as const, startedAt: new Date() } : {}) });
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    fixture.calls = []; fixture.holds = {};
    // PLANTED (named): a second task of the same agent, to take its one slot with a real run.
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId, title: "Another task", status: "todo", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 2, identifier: `${issuePrefix}-2` });
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use("/api", agentRoutes(db, {}));
    client.use(errorHandler);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    // The REAL lifecycle worker (no simulated lifecycle write).
    const worker = createLifecycleWorker(createLifecycleStore(db, createAgentLifecycleEffects()),
      createLifecycleDriver(db, {} as never), (_context, error) => { throw error; });
    const agentRow = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
    /** REAL: the person's message through the comment route. */
    const post = async (body: string) => {
      const res = await request(client).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as string;
    };
    const postOther = async (body: string) => {
      const res = await request(client).post(`/api/issues/${otherIssueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as string;
    };
    /** REAL: the Pause route, then the lifecycle worker (pausing -> paused). */
    const pause = async () => {
      const res = await request(client).post(`/api/agents/${agentId}/pause`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await worker.process(agentId);
      expect(await agentRow()).toMatchObject({ lifecycleState: "paused", status: "paused" });
    };
    /** REAL: the Resume route alone: the agent is 'resuming' until the lifecycle worker runs. */
    const resumeRoute = async () => {
      const res = await request(client).post(`/api/agents/${agentId}/resume`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await agentRow()).toMatchObject({ lifecycleState: "resuming", status: "paused", lifecycleHolds: [], pauseReason: null });
    };
    /** REAL: the lifecycle worker finishes the resume (resuming -> ready). */
    const ready = async () => {
      await worker.process(agentId);
      expect(await agentRow()).toMatchObject({ lifecycleState: "ready" });
    };
    /** REAL GET: what the thread's reader gets. */
    const thread = async () => {
      const res = await request(client).get(`/api/issues/${issueId}/comments`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as Array<{ id: string; body: string; authorType: string; deletedAt?: string | null;
        metadata: Record<string, unknown> | null; presentation?: Record<string, unknown> | null }>;
    };
    /** The sweep's notes about a person's message that the REAL GET returns (live ones only). */
    const notes = async () => (await thread()).filter(comment => comment.authorType === "system" && !comment.deletedAt
      && /^(unanswered|retrying)_message:/.test(String(comment.metadata?.authorizationReason ?? "")))
      .map(comment => ({ id: comment.id, body: comment.body }));
    const queue = async () => (await request(client).get(`/api/issues/${issueId}/queued-comments`).expect(200)).body;
    /** REAL: the unanswered sweep's per-task entry at a logical time `ms` from now. */
    const sweep = (ms = 0) => settleUnansweredPersonMessage(db, { companyId, issueId, now: new Date(Date.now() + ms) });
    const runs = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .map(run => {
        const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
        const ids = [...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds as string[] : []),
          ...(typeof context.wakeCommentId === "string" ? [context.wakeCommentId] : []),
          ...(typeof context.commentId === "string" ? [context.commentId] : [])];
        return { id: run.id, status: run.status, commentIds: [...new Set(ids)] };
      });
    /** REAL GET of the run (its header's source). Two bulky fields the header never reads are left out of the
     * captured body: runnerProfileJson and contextSnapshot. */
    const runByGet = async (runId: string) => {
      const { runnerProfileJson: _profile, contextSnapshot: _context, ...run } = (await request(client).get(`/api/heartbeat-runs/${runId}`).expect(200)).body;
      return run;
    };
    const until = async (what: string, done: () => Promise<boolean>, step: () => Promise<unknown>, timeoutMs = 45_000) => {
      const t0 = Date.now();
      for (;;) {
        await step();
        if (await done()) return;
        if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ runs: await runs(), agent: (await agentRow()).lifecycleState })}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    };
    /** REAL: the chat outbox / deferred-receipt delivery the server's recovery worker runs. It queues M's run. */
    const deliver = () => heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
    const replies = async () => (await thread()).filter(comment => comment.authorType === "agent" && !comment.deletedAt).length;
    const everWritten = async () => (await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")))).map(row => row.id);
    const capture = async (state: string, surface: "chat" | "task", messageId: string, extra: Record<string, unknown> = {}) => samples.push({
      state, surface, messageId, readAt: new Date().toISOString(), comments: await thread(), queue: await queue(), ...extra });
    return { companyId, agentId, issueId, otherIssueId, postOther, client, heartbeat, agentRow, post, pause, resumeRoute, ready, thread, notes, queue,
      sweep, runs, runByGet, until, deliver, replies, everWritten, capture };
  }

  /** pause (real) -> M (real) -> the real sweep writes the paused note. Chat: M stays in the conversation outbox
   * while paused (no saved wake), so the note is M's one line. */
  async function pausedWithNote() {
    const s = await seed(true);
    await s.pause();
    const M = await s.post("M: are you there?");
    await s.sweep(2 * 60_000);
    const standing = await s.notes();
    expect(standing.map(note => note.body), "the real sweep wrote the paused note while the agent IS paused").toEqual([PAUSED]);
    return { ...s, M, pausedNoteId: standing[0]!.id };
  }

  it.each(["answer", "silent"] as const)("chat: paused note -> Resume ('resuming': the note retires) -> WAITING behind another run: exactly ONE true line (the run's header), no paused note -> its OWN run RUNNING: WORKING (same id) -> the run ends with %s", async ending => {
    const s = await pausedWithNote();
    await s.capture("paused", "chat", s.M);
    let release!: (outcome: "answer" | "silent") => void;
    let releaseOther!: (outcome: "answer" | "silent") => void;
    try {
      // The Resume route alone: 'resuming'. The agent is not paused any more, so the note that says it is goes.
      await s.resumeRoute();
      await s.sweep(0);
      expect(await s.notes(), "sampled during 'resuming': '<agent> is paused' is no longer true and is retired").toEqual([]);
      await s.ready();
      // The agent's ONE slot is taken by its run on ANOTHER task (real POST there, real dispatch; that turn is held).
      fixture.holds[s.otherIssueId] = new Promise(resolve => { releaseOther = resolve; });
      fixture.holds[s.issueId] = new Promise(resolve => { release = resolve; });
      const other = await s.postOther("Another task's message");
      await s.until("the other task's run running", async () => (await s.runs()).some(run => run.commentIds.includes(other) && run.status === "running"),
        () => s.heartbeat.resumeQueuedRuns());
      // WAITING: the outbox delivery queues M's run behind it; nothing has started it.
      await s.until("M's queued run", async () => (await s.runs()).some(run => run.commentIds.includes(s.M)), s.deliver);
      const [queued] = (await s.runs()).filter(run => run.commentIds.includes(s.M));
      expect(queued!.status, "M is merely waiting: its run is queued").toBe("queued");
      for (const ms of [0, 30_000, 2 * 60_000, 11 * 60_000]) {
        await s.sweep(ms);
        expect(await s.notes(), `waiting +${ms}: no stale paused note and no other note beside the run's header`).toEqual([]);
      }
      const header = await s.runByGet(queued!.id);
      expect(header.status, "the ONE line is the queued run's header (real GET)").toBe("queued");
      expect((await s.queue()).executionWait ?? null, "no second (panel) line").toBeNull();
      await s.capture("waiting", "chat", s.M, { run: header });

      // RUNNING: the other run ends, the dispatcher starts M's own run; its provider turn is held open.
      releaseOther("answer");
      await s.until("M's run running", async () => (await s.runs()).some(run => run.id === queued!.id && run.status === "running")
        && fixture.calls.includes(queued!.id), async () => { await s.heartbeat.resumeQueuedRuns(); });
      for (const ms of [0, 2 * 60_000, 10 * 60_000]) {
        await s.sweep(ms);
        expect(await s.notes(), `running +${ms}: the SAME note says WORKING`).toEqual([{ id: s.pausedNoteId, body: WORKING }]);
      }
      const working = (await s.thread()).find(comment => comment.id === s.pausedNoteId)!;
      expect(working.presentation).toMatchObject({ title: "Managed Pi is working on it" });
      expect(JSON.stringify(working.metadata)).not.toContain("Next action");
      await s.capture("working", "chat", s.M, { run: await s.runByGet(queued!.id) });

      // The run ENDS.
      release(ending);
      await s.until("M's run ended", async () => (await s.runs()).some(run => run.id === queued!.id
        && ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)), () => s.heartbeat.drainActiveRunExecutions());
      if (ending === "answer") {
        await s.sweep(0);
        expect(await s.notes(), "the answer supersedes the note").toEqual([]);
        expect(await s.replies()).toBe(1);
        await s.capture("answered", "chat", s.M, { run: await s.runByGet(queued!.id) });
      } else {
        // Unanswered: the merged line's own words replace the working note IN PLACE.
        await s.sweep(20_000);
        await s.sweep(3 * 60_000);
        expect(await s.notes(), "the run ended with no reply: the SAME note, the merged line's own words").toEqual([{ id: s.pausedNoteId, body: NO_REPLY }]);
        await s.sweep(11 * 60_000);
        expect(await s.notes()).toEqual([{ id: s.pausedNoteId, body: NO_REPLY }]);
        expect(await s.replies()).toBe(0);
        await s.capture("ended-unanswered", "chat", s.M, { run: await s.runByGet(queued!.id) });
      }
      expect(await s.everWritten(), "ONE note row for M, ever").toEqual([s.pausedNoteId]);
    } finally { releaseOther?.("answer"); release?.("answer"); fixture.holds = {}; }
  }, 180_000);

  it("control, chat: a message sent DURING 'resuming' (the Resume route alone) never gets the paused line; it is answered once", async () => {
    const s = await seed(true);
    await s.pause();
    await s.resumeRoute();
    const M = await s.post("M after the Resume");
    for (const ms of [0, 20_000, 60_000]) {
      await s.sweep(ms);
      expect(JSON.stringify(await s.notes()), `'resuming' +${ms}`).not.toMatch(/is paused|resume/i);
    }
    await s.ready();
    await s.until("M answered", async () => (await s.replies()) === 1, async () => {
      await s.deliver(); await s.heartbeat.resumeQueuedRuns(); await s.heartbeat.drainActiveRunExecutions();
    });
    await s.sweep(0); await s.sweep(11 * 60_000);
    expect(await s.notes()).toEqual([]);
    expect((await s.runs()).filter(run => run.commentIds.includes(M))).toHaveLength(1);
  }, 180_000);

  it("control, chat: while the agent IS paused the note stays, ONCE, at every sample (the real Pause holds)", async () => {
    const s = await pausedWithNote();
    for (const ms of [3 * 60_000, 10 * 60_000, 30 * 60_000]) {
      await s.sweep(ms);
      expect(await s.notes(), `paused +${ms}`).toEqual([{ id: s.pausedNoteId, body: PAUSED }]);
    }
  }, 180_000);
});
