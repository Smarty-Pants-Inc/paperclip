import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-interrupt-answered: the person presses the held list's 'Interrupt'
// ("Interrupt the active turn and send queued messages") while a turn that a
// person's message started is live. The interrupted turn's OWN message must be
// answered by the successor (first, then the queued ones, each once). Real chat
// route, real Stop route, real Interrupt route (queued-comments/interrupt), real
// heartbeat admission/dispatch. Scripted provider only (as optS-dd-f3): a busy
// turn runs the row's hook and then the executor's settle-then-throw after an
// acknowledged cancel; every other turn saves one agent reply and succeeds.
const fixture = vi.hoisted(() => ({
  calls: [] as { runId: string; ok: boolean }[],
  busy: [] as Array<(input: { runId: string }) => Promise<void>>,
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    // Provider edge of a cancel: the run-only abort reached the live session (dispatched).
    cancelNativeSession: (async (runId: string, reason: string, options?: Parameters<typeof actual.cancelNativeSession>[2]) => {
      const result = await actual.cancelNativeSession(runId, reason, options!);
      if (!options || !fixture.calls.some(call => call.runId === runId) || typeof result !== "object") return result;
      const { db } = options;
      const { heartbeatRuns } = await import("@paperclipai/db");
      const { eq, sql } = await import("drizzle-orm");
      await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson},
        '{nativeCancellation,dispatched}', 'true'::jsonb)` }).where(eq(heartbeatRuns.id, runId));
      return { ...result, dispatched: true };
    }) as typeof actual.cancelNativeSession,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      const hook = fixture.busy.shift();
      if (hook) {
        fixture.calls.push({ runId, ok: false });
        await hook({ runId });
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      fixture.calls.push({ runId, ok: true });
      const { issueComments } = await import("@paperclipai/db");
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!support.supported)("Interrupt: the interrupted turn's own message is answered", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "ia-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-answered-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "interrupt-answered-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "ia@example.invalid", emailVerified: true,
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
    if (process.env.IA_EVIDENCE) await fs.appendFile(process.env.IA_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  async function chat() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "IA", issuePrefix, defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active",
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    fixture.calls = []; fixture.busy = [];
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use("/api", agentRoutes(db, {}));
    client.use(errorHandler);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const post = (body: string) => request(client).post(`/api/issues/${issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    const cancelled = (runId: string) => waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
      return value?.dispatchState === "acknowledged" && row?.status === "cancelled";
    });
    const clicked: unknown[] = [];
    const pressInterrupt = async (targetRunId: string) => {
      const queue = await request(client).get(`/api/issues/${issueId}/queued-comments`).expect(200);
      clicked.push({ queueId: queue.body.queueId ?? queue.body.id, entries: (queue.body.entries ?? []).map((e: any) => e.id ?? e.commentId),
        steering: queue.body.steeringDisposition });
      return request(client).post(`/api/issues/${issueId}/queued-comments/interrupt`)
        .send({ queueId: queue.body.queueId ?? queue.body.id, targetRunId, revision: queue.body.revision });
    };
    const pump = async () => { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); };
    // The deferred-receipt worker's pass over a saved Interrupt (resumeDeferredExecutionReceipts
    // after its 30 s age gate): the same heartbeat.resumeQueuedCommentInterrupt, without the wait.
    const sweepInterrupts = async () => {
      const saved = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")));
      for (const wake of saved) if ((wake.payload as any)?.queuedCommentInterrupt)
        await heartbeat.resumeQueuedCommentInterrupt(companyId, wake.id);
    };
    const settle = async (ms = 4_000) => {
      const t0 = Date.now();
      do { await pump(); await sweepInterrupts(); await pump(); await new Promise(r => setTimeout(r, 150)); }
      while (Date.now() - t0 < ms);
    };
    return { companyId, agentId, issueId, client, heartbeat, clicked, post, cancelled, pressInterrupt, pump, settle };
  }
  type Chat = Awaited<ReturnType<typeof chat>>;

  const carried = (ctx: any): string[] => [...new Set([...(ctx?.wakeCommentIds ?? []), ctx?.wakeCommentId, ctx?.commentId]
    .filter(Boolean))];
  async function persisted(c: Chat, skip: string[]) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, c.companyId))
      .orderBy(heartbeatRuns.createdAt);
    const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, c.issueId),
      eq(issueComments.authorType, "agent"))).orderBy(issueComments.createdAt);
    const perRun = runs.filter(run => !skip.includes(run.id)).map(run => ({ id: run.id, status: run.status,
      errorCode: run.errorCode, ids: carried(run.contextSnapshot),
      replies: replies.filter(reply => reply.createdByRunId === run.id).map(reply => reply.body) }));
    const answeredBy = (id: string) => perRun.filter(run => run.status === "succeeded" && run.replies.length > 0 &&
      run.ids.includes(id)).map(run => run.id);
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, c.companyId)))
      .map(w => ({ id: w.id, status: w.status, reason: w.reason, wait: (w.payload as any)?.executionWait,
        ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds, interrupt: (w.payload as any)?.queuedCommentInterrupt != null }));
    const all = runs.map(run => ({ id: run.id, status: run.status, errorCode: run.errorCode, error: run.error?.slice(0, 200),
      ids: carried(run.contextSnapshot) }));
    return { perRun, answeredBy, replies, wakes, all };
  }

  // R1/R2 seed the live turn and its held queue as rows (the queued-comments
  // route tests' seedQueue shape), then press the REAL Interrupt route. The
  // successor is held in the ordinary queue (maxConcurrentRuns 1 behind an
  // unrelated running run) so its exact input is read without a provider.
  async function seedLiveTurn(stopBefore: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const liveRunId = randomUUID(), wakeId = randomUUID();
    const [held1, held2, held3] = [randomUUID(), randomUUID(), randomUUID()];
    const issuePrefix = `J${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "IA seeded", issuePrefix, requireBoardApprovalForNewAgents: false });
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
    if (stopBefore) {
      // The person's Stop before HELD1: an earlier turn, cancelled by that person.
      const m0 = randomUUID();
      await db.insert(issueComments).values({ id: m0, companyId, issueId, authorType: "user", authorUserId: userId,
        body: "M0", createdAt: t(0), updatedAt: t(0) });
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment", status: "cancelled",
        runtimeMode: "native", startedAt: t(0), finishedAt: t(1), errorCode: "cancelled", error: "Cancelled by a board operator",
        resultJson: { cancelledByActorType: "user", cancelledByUserId: userId },
        contextSnapshot: { issueId, wakeCommentId: m0, wakeCommentIds: [m0] } });
    }
    await db.insert(issueComments).values([[held1, "HELD1", 2], [held2, "HELD2", 4], [held3, "HELD3", 5]].map(([id, body, m]) => ({
      id: id as string, companyId, issueId, authorType: "user" as const, authorUserId: userId, body: body as string,
      createdAt: t(m as number), updatedAt: t(m as number) })));
    // HELD2 and HELD3: the held list behind the live turn.
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: userId, payload: { issueId, commentId: held3,
        _paperclipWakeContext: { commentId: held3, wakeCommentId: held3, wakeCommentIds: [held2, held3] } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: liveRunId, phase: "observed" });
    // Keeps the successor in the ordinary queue (no provider launch).
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

  async function interruptLiveTurn(f: Awaited<ReturnType<typeof seedLiveTurn>>) {
    const queue = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    const pressed = await request(f.client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.body.queueId ?? f.wakeId, targetRunId: f.liveRunId, revision: queue.body.revision });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    expect(stopped.status).toBe("cancelled");
    // The runner acknowledged the cancel and its teardown ended (as the
    // queued-comments route test "starts one successor for an interrupted native turn").
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, processGroupId: null, resultJson: { ...stopped.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.liveRunId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: "intent", acknowledgementAuditId: "ack" } } }).where(eq(heartbeatRuns.id, f.liveRunId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null })
      .where(eq(nativeRunFinalizations.runId, f.liveRunId));
    const heartbeat = heartbeatService(db);
    // The deferred-receipt worker's passes (and a restart's repeat) over the saved Interrupt.
    await Promise.all(Array.from({ length: 3 }, () => heartbeat.resumeQueuedCommentInterrupt(f.companyId, f.wakeId)));
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, f.wakeId);
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.id !== f.liveRunId && run.contextSnapshot?.issueId === f.issueId && run.status !== "cancelled");
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(w => ({ id: w.id, status: w.status, wait: (w.payload as any)?.executionWait?.reason,
        ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    return { runs, wakes };
  }

  it("R1: after a person's Stop, a typed message's live turn is Interrupted: its successor takes the interrupted message first, then the held ones, once each", async () => {
    const f = await seedLiveTurn(true);
    const { runs, wakes } = await interruptLiveTurn(f);
    await evidence("R1", { f: { ...f, client: undefined }, runs: runs.map(r => ({ id: r.id, status: r.status, ctx: r.contextSnapshot })), wakes });
    expect(runs, JSON.stringify({ wakes })).toHaveLength(1);
    expect(runs[0]!.contextSnapshot?.wakeCommentIds, "the interrupted message first, then the held ones")
      .toEqual([f.held1, ...f.held]);
  }, 120_000);

  it("R2: an Interrupt with no person's Stop before it: the same rule", async () => {
    const f = await seedLiveTurn(false);
    const { runs, wakes } = await interruptLiveTurn(f);
    await evidence("R2", { f: { ...f, client: undefined }, runs: runs.map(r => ({ id: r.id, status: r.status, ctx: r.contextSnapshot })), wakes });
    expect(runs, JSON.stringify({ wakes })).toHaveLength(1);
    expect(runs[0]!.contextSnapshot?.wakeCommentIds, "the interrupted message first, then the held ones")
      .toEqual([f.held1, ...f.held]);
  }, 120_000);

  it("R2b: an interrupted turn that already saved its reply is not answered again", async () => {
    const f = await seedLiveTurn(false);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: f.liveRunId, origin: "comment", body: "partial answer" });
    const { runs } = await interruptLiveTurn(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot?.wakeCommentIds).toEqual(f.held);
  }, 120_000);

  it("R3a: a Send with no live run (after a person's Stop) carries only the held messages, not the stopped turn's", async () => {
    const c = await chat();
    let firstRunId = "";
    const held: string[] = [];
    let stopping: Promise<unknown> | undefined;
    fixture.busy.push(async ({ runId }) => {
      firstRunId = runId;
      for (const body of ["M1 held", "M2 held"]) held.push((await c.post(body).expect(201)).body.id);
      stopping = request(c.client).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      void stopping.catch(() => undefined);
      await c.cancelled(runId);
    });
    const m0 = await issueService(db).addComment(c.issueId, "M0 start", { userId }, { clientRequestId: randomUUID() });
    await deliverConversationComments(db, { id: c.issueId, companyId: c.companyId, conversationAgentId: c.agentId },
      c.heartbeat.wakeup);
    await c.pump();
    expect((await stopping as { status: number }).status).toBe(200);
    const sent = await c.pressInterrupt(firstRunId);
    await c.settle();
    const a = await persisted(c, [firstRunId]);
    await evidence("R3a", { m0: m0.id, held, sent: sent.status, perRun: a.perRun });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(a.perRun, JSON.stringify({ clicked: c.clicked, all: a.all, wakes: a.wakes })).toHaveLength(1);
    expect(a.perRun[0]!.ids).toEqual(held);
    expect(a.answeredBy(m0.id), "a Stopped turn's message is not re-answered by Send").toHaveLength(0);
  }, 120_000);

  it("R3b: a message typed with no live run starts its own turn and is answered once (unchanged)", async () => {
    const c = await chat();
    const typed = (await c.post("plain").expect(201)).body.id as string;
    await c.settle(2_000);
    const a = await persisted(c, []);
    await evidence("R3b", { typed, perRun: a.perRun });
    expect(a.perRun, JSON.stringify({ clicked: c.clicked, all: a.all, wakes: a.wakes })).toHaveLength(1);
    expect(a.perRun[0]!.ids).toEqual([typed]);
    expect(a.answeredBy(typed)).toHaveLength(1);
  }, 120_000);
});
