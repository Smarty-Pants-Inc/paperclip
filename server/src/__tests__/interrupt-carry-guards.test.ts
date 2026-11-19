import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
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

describe.skipIf(!support.supported)("carry guards: answered GET filter, carry first, A4 read steer", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "ia-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-carry-guards-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "interrupt-carry-guards-home-"));
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

  // Seeded rows (interrupt-answered's seedLiveTurn shape): a live turn on HELD1
  // with two steers S1, S2 in its custody, and HELD2 in the held list.
  async function seed(options: { readS1?: boolean; systemHeld?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const liveRunId = randomUUID(), wakeId = randomUUID();
    const [held1, held2, s1, s2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const issuePrefix = `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "CG", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000);
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "running", runtimeMode: "native", startedAt: t(3), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeCommentId: held1, commentId: held1, wakeCommentIds: [held1], responsibleUserId: userId,
        steeredCommentIds: [s1, s2] } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: `${issuePrefix}-1`, title: "Chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", responsibleUserId: userId, executionRunId: liveRunId });
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId }).where(eq(heartbeatRuns.id, liveRunId));
    await db.insert(issueComments).values([[held1, "HELD1", 2], [s1, "S1", 3.2], [s2, "S2", 3.4], [held2, "HELD2", 4]].map(([id, body, m]) => ({
      id: id as string, companyId, issueId, authorType: "user" as const, authorUserId: userId, body: body as string,
      createdAt: t(m as number), updatedAt: t(m as number) })));
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution",
      // systemHeld: the held queue began as a system wake (an outbox-saved wake; run-control resumeSavedComments).
      requestedByActorType: options.systemHeld ? "system" : "user", requestedByActorId: options.systemHeld ? "outbox" : userId,
      requestedAt: t(4), payload: { issueId, commentId: held2,
        _paperclipWakeContext: { commentId: held2, wakeCommentId: held2, wakeCommentIds: [held2] } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: liveRunId, phase: "observed" });
    if (options.readS1) {
      // A4: Pi's userMessage for S1 was ingested BEFORE the press: S1 was READ by the cut turn (no answer text).
      const events = [
        { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
        { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${s1}` },
        { eventType: "item.started", kind: "userMessage", itemId: "turn-1:read" },
      ];
      await db.insert(heartbeatRunEvents).values(events.map((event, index) => ({
        companyId, runId: liveRunId, agentId, seq: index + 1, eventType: event.eventType, sourceEventId: randomUUID(),
        payload: { prpEvent: { turnId: "turn-1", itemId: event.itemId, payload: { kind: event.kind } } } })));
      await db.update(heartbeatRuns).set({ nextEventSeq: events.length + 1 }).where(eq(heartbeatRuns.id, liveRunId));
    }
    // Keeps the successor in the ordinary queue (no provider launch).
    const [blocker] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
      contextSnapshot: { issueId: randomUUID() } }).returning();
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use(errorHandler);
    return { companyId, agentId, issueId, liveRunId, wakeId, held1, held2, s1, s2, blockerId: blocker!.id, client, t };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  async function press(f: Seed) {
    const queue = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    const pressed = await request(f.client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.body.queueId ?? f.wakeId, targetRunId: f.liveRunId, revision: queue.body.revision });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    return pressed;
  }

  async function ackCut(f: Seed) {
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, processGroupId: null, resultJson: { ...stopped!.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.liveRunId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: "intent", acknowledgementAuditId: "ack" } } }).where(eq(heartbeatRuns.id, f.liveRunId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null })
      .where(eq(nativeRunFinalizations.runId, f.liveRunId));
  }

  const carriedIds = (ctx: any): string[] => [...new Set([...(ctx?.wakeCommentIds ?? []), ctx?.wakeCommentId, ctx?.commentId]
    .filter(Boolean))] as string[];

  it("G1: two unread steers, Interrupt, the successor answers both: the GET shows an empty bar", async () => {
    const f = await seed();
    await press(f);
    await ackCut(f);
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, f.wakeId);
    const [successor] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.id !== f.liveRunId && run.contextSnapshot?.issueId === f.issueId && run.status !== "cancelled");
    expect(successor, "one successor").toBeTruthy();
    expect(carriedIds(successor!.contextSnapshot)).toEqual(expect.arrayContaining([f.s1, f.s2]));
    // The successor's turn ran and answered both steers (its published agent reply).
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, successor!.id));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: successor!.id, origin: "comment", body: "answers S1 and S2" });
    // Another producer's wake born later still lists the two (now answered) steers.
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: userId, payload: { issueId: f.issueId, commentId: f.s2,
        _paperclipWakeContext: { commentId: f.s2, wakeCommentId: f.s2, wakeCommentIds: [f.s1, f.s2] } } });
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    const bar = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    await evidence("G1", { s: [f.s1, f.s2], entries: bar.body.entries, state: bar.body.state });
    const shown = (bar.body.entries ?? []).map((e: any) => e.comment?.id);
    expect(shown, JSON.stringify(bar.body)).not.toContain(f.s1);
    expect(shown, JSON.stringify(bar.body)).not.toContain(f.s2);
    expect(shown, "an empty bar").toEqual([]);
  }, 120_000);

  it("A4: a steer READ before the press (Pi userMessage ingested) is not adopted by the Interrupt", async () => {
    const f = await seed({ readS1: true });
    await press(f);
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    await evidence("A4", { s1: f.s1, s2: f.s2, carried: cut!.resultJson?.interruptCarriedSteeredCommentIds });
    expect(cut!.resultJson?.interruptCarriedSteeredCommentIds, "only the unread S2 is adopted; READ S1 is not")
      .toEqual([f.s2]);
  }, 120_000);

  it("C1: a carry wake on remote_cleanup and a later single-comment wake: the carry runs first, the later wake carries nothing twice", async () => {
    const f = await seed();
    await press(f);
    const wakesAfterPress = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(w => ({ id: w.id, status: w.status, wait: (w.payload as any)?.executionWait?.reason,
        interrupt: (w.payload as any)?.queuedCommentInterrupt != null, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    const carry = wakesAfterPress.find(w => w.interrupt && w.status === "deferred_issue_execution");
    expect(carry, JSON.stringify(wakesAfterPress)).toBeTruthy();
    // Force the carry's hold to remote_cleanup (the box is not yet free).
    await db.update(agentWakeupRequests).set({ payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{executionWait}',
      ${JSON.stringify({ reason: "remote_cleanup", message: "Waiting for the stopped run's sandbox to finish cleaning up." })}::jsonb)` })
      .where(eq(agentWakeupRequests.id, carry!.id));
    // A LATER wake on the same task from another producer, holding one comment the carry already holds.
    const later = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: later, companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "system",
      requestedByActorId: "outbox", requestedAt: new Date(), payload: { issueId: f.issueId, commentId: f.held2,
        _paperclipWakeContext: { commentId: f.held2, wakeCommentId: f.held2, wakeCommentIds: [f.held2] } } });
    // The box frees: the cut run's teardown ends and the unrelated running run completes.
    await ackCut(f);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.blockerId));
    const heartbeat = heartbeatService(db);
    await heartbeat.releaseIssueExecutionAndPromote({ id: f.liveRunId, companyId: f.companyId }).catch(() => undefined);
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, carry!.id);
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))
      .orderBy(heartbeatRuns.createdAt))
      .filter(run => run.id !== f.liveRunId && run.id !== f.blockerId && run.contextSnapshot?.issueId === f.issueId);
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(w => ({ id: w.id, status: w.status, runId: w.runId, error: w.error, wait: (w.payload as any)?.executionWait?.reason,
        interrupt: (w.payload as any)?.queuedCommentInterrupt != null, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    const view = runs.map(run => ({ id: run.id, status: run.status, wake: run.wakeupRequestId, ids: carriedIds(run.contextSnapshot) }));
    await evidence("C1", { f: { held1: f.held1, held2: f.held2, s1: f.s1, s2: f.s2, carry: carry!.id, later }, wakesAfterPress, view, wakes });
    const live = view.filter(run => run.status !== "cancelled");
    expect(live.length, JSON.stringify({ view, wakes })).toBeGreaterThan(0);
    expect(live[0]!.ids, "the carry (made at the press) is admitted first").toEqual(expect.arrayContaining([f.held1, f.held2]));
    for (const id of [f.held1, f.s1, f.s2, f.held2])
      expect(live.filter(run => run.ids.includes(id)).length, `${id} carried once`).toBe(1);
    const laterWake = wakes.find(w => w.id === later)!;
    if (!live.some(run => run.wake === later))
      expect(laterWake.status, "nothing left: coalesced").toBe("coalesced");
  }, 120_000);

  it("C2: the carry (on a held wake a system producer began) is admitted before a LATER person wake on the same task", async () => {
    const f = await seed({ systemHeld: true });
    await press(f);
    const wakesAfterPress = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(w => ({ id: w.id, status: w.status, wait: (w.payload as any)?.executionWait?.reason,
        interrupt: (w.payload as any)?.queuedCommentInterrupt != null, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    const carry = wakesAfterPress.find(w => w.interrupt && w.status === "deferred_issue_execution");
    expect(carry, JSON.stringify(wakesAfterPress)).toBeTruthy();
    // Force the carry's hold to remote_cleanup (the box is not yet free).
    await db.update(agentWakeupRequests).set({ payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{executionWait}',
      ${JSON.stringify({ reason: "remote_cleanup", message: "Waiting for the stopped run's sandbox to finish cleaning up." })}::jsonb)` })
      .where(eq(agentWakeupRequests.id, carry!.id));
    // A LATER wake on the same task from another producer, holding one comment the carry already holds.
    const later = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: later, companyId: f.companyId, agentId: f.agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: userId, requestedAt: new Date(), payload: { issueId: f.issueId, commentId: f.held2,
        _paperclipWakeContext: { commentId: f.held2, wakeCommentId: f.held2, wakeCommentIds: [f.held2] } } });
    // The box frees: the cut run's teardown ends and the unrelated running run completes.
    await ackCut(f);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.blockerId));
    const heartbeat = heartbeatService(db);
    await heartbeat.releaseIssueExecutionAndPromote({ id: f.liveRunId, companyId: f.companyId }).catch(() => undefined);
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, carry!.id);
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))
      .orderBy(heartbeatRuns.createdAt))
      .filter(run => run.id !== f.liveRunId && run.id !== f.blockerId && run.contextSnapshot?.issueId === f.issueId);
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(w => ({ id: w.id, status: w.status, runId: w.runId, error: w.error, wait: (w.payload as any)?.executionWait?.reason,
        interrupt: (w.payload as any)?.queuedCommentInterrupt != null, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }));
    const view = runs.map(run => ({ id: run.id, status: run.status, wake: run.wakeupRequestId, ids: carriedIds(run.contextSnapshot) }));
    await evidence("C2", { f: { held1: f.held1, held2: f.held2, s1: f.s1, s2: f.s2, carry: carry!.id, later }, wakesAfterPress, view, wakes });
    const live = view.filter(run => run.status !== "cancelled");
    expect(live.length, JSON.stringify({ view, wakes })).toBeGreaterThan(0);
    expect(live[0]!.ids, "the carry (made at the press) is admitted first").toEqual(expect.arrayContaining([f.held1, f.held2]));
    for (const id of [f.held1, f.s1, f.s2, f.held2])
      expect(live.filter(run => run.ids.includes(id)).length, `${id} carried once`).toBe(1);
    const laterWake = wakes.find(w => w.id === later)!;
    if (!live.some(run => run.wake === later))
      expect(laterWake.status, "nothing left: coalesced").toBe("coalesced");
  }, 120_000);
});
