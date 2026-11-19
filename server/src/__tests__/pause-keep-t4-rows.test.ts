import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// rf-5 T4 round 2 (rf-4 C2, C3; RFL import-safety row). Real routes:
// POST /api/heartbeat-runs/:runId/cancel (a person's Stop), POST
// /api/agents/:id/pause, POST /api/issues/:id/comments, POST
// /api/agents/:id/resume, GET /api/issues/:id/queued-comments (the bar) and
// POST /api/issues/:id/queued-comments/interrupt (Send); the REAL lifecycle
// worker; real heartbeat admission, deferral, promotion, claim and run
// creation on the native path; the real company import with its safety pause.
// Scripted edge only: the provider turn (first held turn: busy until the
// person's Stop, then the executor's settle-then-throw after an acknowledged
// Stop, as optS-dd F3; every other turn answers with one agent reply from its
// run on the run's own task) and the provider ACK of the Stop.
const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    cancelNativeSession: (async (runId: string, reason: string, options?: Parameters<typeof actual.cancelNativeSession>[2]) => {
      const result = await actual.cancelNativeSession(runId, reason, options!);
      if (!options || !fixture.calls.includes(runId) || typeof result !== "object") return result;
      const { heartbeatRuns } = await import("@paperclipai/db");
      const { eq, sql } = await import("drizzle-orm");
      await options.db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson},
        '{nativeCancellation,dispatched}', 'true'::jsonb)` }).where(eq(heartbeatRuns.id, runId));
      return { ...result, dispatched: true };
    }) as typeof actual.cancelNativeSession,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      if (fixture.calls.length === 0 && fixture.onFirst) {
        fixture.calls.push(runId);
        await fixture.onFirst({ runId });
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      fixture.calls.push(runId);
      const { issueComments, heartbeatRuns } = await import("@paperclipai/db");
      const { eq } = await import("drizzle-orm");
      const [run] = await (fixture.db as any).select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const issueId = (run?.contextSnapshot as { issueId?: string } | null)?.issueId ?? fixture.issueId;
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { configureAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { createLifecycleWorker } from "../modules/agent-lifecycle/application/worker.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
const NAME = "Managed Pi";

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const carried = (ctx: any): string[] => [...new Set([ctx?.commentId, ctx?.wakeCommentId, ...(ctx?.wakeCommentIds ?? [])]
  .filter(Boolean))];

describe.skipIf(!support.supported)("adopt-fold2 A: a message sent while the agent is paused survives a TREE Pause too", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "t4r2-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pause-keep-t4-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "pause-defer-t4r2-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "t4r2@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    const writable = async (dir: string): Promise<void> => { const st = await fs.lstat(dir).catch(() => null); if (!st?.isDirectory() || st.isSymbolicLink()) return; await fs.chmod(dir, 0o700); for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }).catch(() => undefined); }
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.T4_EVIDENCE) await fs.appendFile(process.env.T4_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  /** Shared harness: real routes and worker for one company/agent. */
  function harness(companyId: string, agentId: string) {
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId;
    fixture.calls = [];
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use("/api", agentRoutes(db, {}));
    client.use("/api", issueTreeControlRoutes(db));
    client.use(errorHandler);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const worker = createLifecycleWorker(createLifecycleStore(db, createAgentLifecycleEffects()),
      createLifecycleDriver(db, {} as never), (_context, error) => { throw error; });
    const post = (issueId: string, body: string) => request(client).post(`/api/issues/${issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    const agentRow = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
    const pause = async () => {
      const res = await request(client).post(`/api/agents/${agentId}/pause`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await worker.process(agentId);
      expect(await agentRow()).toMatchObject({ lifecycleState: "paused", status: "paused" });
    };
    const resumeCall = async () => {
      const res = await request(client).post(`/api/agents/${agentId}/resume`).send({});
      return { status: res.status, lifecycleState: res.body?.lifecycleState, error: res.body?.error };
    };
    const wakes = async () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    const savedFor = async (commentId: string) => {
      const t0 = Date.now();
      let saved = [] as Awaited<ReturnType<typeof wakes>>;
      // The comment route's wake is fire-and-forget: wait (bounded) for its outcome.
      while (Date.now() - t0 < 5_000) {
        saved = (await wakes()).filter(w => (w.payload as { commentId?: string }).commentId === commentId);
        if (saved.length) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return saved;
    };
    const runs = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(heartbeatRuns.createdAt)).map(run => ({ id: run.id, status: run.status,
      issueId: (run.contextSnapshot as any)?.issueId as string | undefined, wakeReason: (run.contextSnapshot as any)?.wakeReason,
      ids: carried(run.contextSnapshot), order: ((run.contextSnapshot as any)?.wakeCommentIds ?? []) as string[], called: fixture.calls.includes(run.id) }));
    const replies = async (issueId: string) => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorAgentId, agentId)))).map(row => row.createdByRunId);
    const drive = async (issueIds: string[], until: () => Promise<boolean>, timeoutMs = 30_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        for (const issueId of issueIds) await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        if (await until()) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      // More passes: a second delivery would show here.
      for (let i = 0; i < 3; i++) {
        for (const issueId of issueIds) await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId });
        await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return Date.now() - t0;
    };
    return { client, heartbeat, worker, post, agentRow, pause, resumeCall, wakes, savedFor, runs, replies, drive };
  }

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), chatId = randomUUID(), taskId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "T4R2", issuePrefix, defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: NAME, role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    // Task A: the person's chat with the agent (where the three messages are held after Stop).
    await db.insert(issues).values({ id: chatId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active",
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    // Task B: a task of the agent that has never run (P goes here).
    await db.insert(issues).values({ id: taskId, companyId, title: "A task", status: "todo", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 2, identifier: `${issuePrefix}-2` });
    fixture.issueId = chatId;
    return { companyId, agentId, chatId, taskId, ...harness(companyId, agentId) };
  }

  /** The person's Stop with three held messages (optS-dd F3 shape) on the chat, through the real Stop route. */
  async function heldThenStop(s: Awaited<ReturnType<typeof seed>>) {
    const held: string[] = [];
    let firstRunId = "";
    let stopping: Promise<unknown> | undefined;
    fixture.onFirst = async ({ runId }) => {
      firstRunId = runId;
      for (const body of ["M1 held", "M2 held", "M3 held"]) held.push((await s.post(s.chatId, body).expect(201)).body.id);
      stopping = request(s.client).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        return value?.dispatchState === "acknowledged" && row?.status === "cancelled";
      });
    };
    try {
      await issueService(db).addComment(s.chatId, "M0 start", { userId }, { clientRequestId: randomUUID() });
      await deliverConversationComments(db, { id: s.chatId, companyId: s.companyId, conversationAgentId: s.agentId },
        s.heartbeat.wakeup);
      await s.heartbeat.resumeQueuedRuns();
      await s.heartbeat.drainActiveRunExecutions();
      const stopped = await stopping as { status: number } | undefined;
      expect(stopped?.status, "person Stop route").toBe(200);
    } finally { fixture.onFirst = undefined; }
    expect(firstRunId, "first turn reached the provider").not.toBe("");
    const accepted = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, firstRunId),
      eq(heartbeatRunEvents.message, "run.stop.accepted")));
    expect(accepted.map(row => (row.payload as any)?.kind), "the Stop route wrote the person_stop row").toEqual(["person_stop"]);
    const bar = async () => {
      const queue = await request(s.client).get(`/api/issues/${s.chatId}/queued-comments`).expect(200);
      return { queueId: queue.body.queueId ?? queue.body.id, revision: queue.body.revision, state: queue.body.state,
        ids: (queue.body.entries ?? []).map((entry: any) => entry.comment?.id ?? entry.commentId) as string[] };
    };
    const send = async () => {
      const queue = await bar();
      return request(s.client).post(`/api/issues/${s.chatId}/queued-comments/interrupt`)
        .send({ queueId: queue.queueId, targetRunId: firstRunId, revision: queue.revision });
    };
    return { held, firstRunId, bar, send };
  }

  // adopt-fold2 A (harness: pause-defer-wake-t4-r2's real routes + REAL lifecycle worker, copied unchanged above,
  // plus the real tree-hold routes). ONE pause-keep predicate: P's wake carries a person's message, so
  // BOTH Pauses keep it; the two Resumes run it once.
  it("A2: P sent while the agent is paused -> TREE Pause -> Resume both (agent Resume, tree release): P answered exactly once", async () => {
    const s = await seed();
    await s.pause();
    const P = (await s.post(s.taskId, "P while the agent is paused, then the tree is paused").expect(201)).body.id as string;
    const saved = await s.savedFor(P);
    await evidence("A2 saved", saved.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait })));
    expect(saved).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null })]);
    const held = await request(s.client).post(`/api/issues/${s.taskId}/tree-holds`).send({ mode: "pause", reason: "fold2 A2" });
    expect(held.status, JSON.stringify(held.body)).toBeLessThan(300);
    const afterTree = (await s.wakes()).filter(w => saved.some(x => x.id === w.id));
    await evidence("A2 after tree Pause", afterTree.map(w => ({ status: w.status, error: w.error, wait: (w.payload as any)?.executionWait })));
    expect(afterTree).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null })]);
    const resumed = await s.resumeCall();
    expect(resumed.status, JSON.stringify(resumed)).toBe(200);
    await s.worker.process(s.agentId);
    expect(await s.agentRow()).toMatchObject({ lifecycleState: "ready" });
    await request(s.client).post(`/api/issues/${s.taskId}/tree-holds/${held.body.hold.id}/release`).send({ reason: "fold2 A2 release" }).expect(200);
    await s.drive([s.taskId], async () => (await s.runs()).some(run => run.ids.includes(P) && run.status === "succeeded"));
    const all = await s.runs();
    await evidence("A2 after both Resumes", { P, runs: all, replies: await s.replies(s.taskId) });
    const pRuns = all.filter(run => run.ids.includes(P));
    expect(pRuns).toHaveLength(1);
    expect(pRuns[0]).toMatchObject({ status: "succeeded", ids: [P] });
    expect(all.filter(run => run.called && run.ids.includes(P))).toHaveLength(1);
  }, 180_000);

  const treePause = async (s: Awaited<ReturnType<typeof seed>>, issueId: string) => {
    const held = await request(s.client).post(`/api/issues/${issueId}/tree-holds`).send({ mode: "pause", reason: "fold2 tree pause" });
    expect(held.status, JSON.stringify(held.body)).toBeLessThan(300);
    return held.body.hold.id as string;
  };
  const treeRelease = async (s: Awaited<ReturnType<typeof seed>>, issueId: string, holdId: string) =>
    request(s.client).post(`/api/issues/${issueId}/tree-holds/${holdId}/release`).send({ reason: "fold2 release" }).expect(200);

  it("A1: Stop with 3 held -> AGENT Pause -> TREE Pause -> Resume both -> Send: each held message answered exactly once, in order", async () => {
    const s = await seed();
    const h = await heldThenStop(s);
    expect((await h.bar()).ids).toEqual(h.held);
    await s.pause();
    const holdId = await treePause(s, s.chatId);
    const barPaused = await h.bar();
    await evidence("A1 after both Pauses", { held: h.held, bar: barPaused,
      wakes: (await s.wakes()).map(w => ({ id: w.id, status: w.status, error: w.error, wait: (w.payload as any)?.executionWait?.reason,
        ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds })) });
    expect(barPaused.ids).toEqual(h.held);
    const resumed = await s.resumeCall();
    expect(resumed.status, JSON.stringify(resumed)).toBe(200);
    await s.worker.process(s.agentId);
    expect(await s.agentRow()).toMatchObject({ lifecycleState: "ready" });
    await treeRelease(s, s.chatId, holdId);
    await s.drive([s.chatId], async () => false, 2_000);
    for (const id of h.held) expect((await s.runs()).filter(run => run.ids.includes(id)), `${id} not run before Send`).toEqual([]);
    expect((await h.bar()).ids).toEqual(h.held);
    const sent = await h.send();
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await s.drive([s.chatId], async () => (await s.runs()).some(run => h.held.every(id => run.ids.includes(id)) && run.status === "succeeded"));
    const afterSend = (await s.runs()).filter(run => run.id !== h.firstRunId);
    await evidence("A1 after Send", { runs: afterSend, chatReplies: await s.replies(s.chatId) });
    const heldRuns = afterSend.filter(run => h.held.some(id => run.ids.includes(id)));
    expect(heldRuns).toHaveLength(1);
    expect(heldRuns[0]).toMatchObject({ status: "succeeded", issueId: s.chatId });
    expect(heldRuns[0]!.order).toEqual(h.held);
    for (const id of h.held) expect(afterSend.filter(run => run.called && run.ids.includes(id))).toHaveLength(1);
    expect(await s.replies(s.chatId)).toEqual([heldRuns[0]!.id]);
  }, 180_000);

  /** A system-only wake (no message) deferred under its OWN saved wait (remote_cleanup, not the pause's).
   * PLANTED row (the shape admission writes for a parked wake: deferred_issue_execution, runId null,
   * payload.issueId + a well-formed executionWait); the Pauses are the real routes and the real worker. */
  const plantSystemWake = async (s: Awaited<ReturnType<typeof seed>>) => {
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.agentId, source: "automation",
      triggerDetail: "system", reason: "fold2_system_control", status: "deferred_issue_execution", requestedByActorType: "system",
      payload: { issueId: s.taskId, executionWait: { reason: "remote_cleanup", trigger: "remote_stop",
        message: "Waiting for the previous environment to stop." } } }).returning();
    return wake!.id;
  };
  const wakeRow = async (s: Awaited<ReturnType<typeof seed>>, id: string) => (await s.wakes()).find(w => w.id === id)!;

  it("A3 agent: a SYSTEM wake with its own (non-pause) saved wait is CANCELLED by the AGENT Pause", async () => {
    const s = await seed();
    const id = await plantSystemWake(s);
    await s.pause();
    const row = await wakeRow(s, id);
    await evidence("A3 agent", { status: row.status, error: row.error });
    expect(row).toMatchObject({ status: "cancelled", runId: null });
  }, 180_000);

  it("A3 tree: a SYSTEM wake with its own (non-pause) saved wait is CANCELLED by the TREE Pause", async () => {
    const s = await seed();
    const id = await plantSystemWake(s);
    await treePause(s, s.taskId);
    const row = await wakeRow(s, id);
    await evidence("A3 tree", { status: row.status, error: row.error });
    expect(row).toMatchObject({ status: "cancelled", runId: null });
  }, 180_000);

  it("A3 control: P's wake (a person's message, deferred by the pause) is KEPT by the AGENT Pause and then the TREE Pause", async () => {
    const s = await seed();
    await s.pause();
    const P = (await s.post(s.taskId, "P control").expect(201)).body.id as string;
    const [saved] = await s.savedFor(P);
    await treePause(s, s.taskId);
    expect(await wakeRow(s, saved!.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
  }, 180_000);
});
