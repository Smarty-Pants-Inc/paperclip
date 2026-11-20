import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues,
  subscribeDatabaseWork,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueRoutes } from "../../routes/issues.js";
import { agentRoutes } from "../../routes/agents.js";
import { errorHandler } from "../../middleware/index.js";
import { heartbeatService } from "../heartbeat.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../agent-lifecycle.js";
import { createLifecycleDriver } from "../agent-lifecycle-driver.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { unansweredPersonMessageCommentCondition, unansweredPersonMessageCondition } from "./unanswered-person-message.js";

// resumefix (gate 2, 11-20): a message sent while paused is answered after Resume even when the
// paged recovery sweep has not reached (noted) it yet. The sweep is NOT run on its own here: the
// ONLY visits are the ones Resume hands to the stranded sweep's per-issue entry (recovery/work.ts
// strandedAssignments hint -> load scoped to the issue -> batched flagged query -> owner.stranded).
const support = await getEmbeddedPostgresTestSupport();
const EVIDENCE = process.env.RESUMEFIX_EVIDENCE_FILE;
const log = (row: Record<string, unknown>) => { if (EVIDENCE) appendFileSync(EVIDENCE, `${JSON.stringify(row)}\n`); };

describe.skipIf(!support.supported)("resumefix: Resume answers every message sent while paused", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("resumefix-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(label: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `RF ${label}`, defaultResponsibleUserId: userId, issuePrefix: `R${label.toUpperCase()}` });
    await db.insert(authUsers).values({ id: userId, name: "Paul", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat with Managed Pi", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    // The answered first turn ('Reply exactly READY.'), as on the gate.
    const t0 = Date.now() - 120_000;
    const [first] = await db.insert(issueComments).values({ companyId, issueId, body: "Reply exactly READY.", authorType: "user",
      authorUserId: userId, createdAt: new Date(t0) }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId,
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: first!.id }, createdAt: new Date(t0 + 1000),
      finishedAt: new Date(t0 + 20_000) }).returning();
    await db.insert(issueComments).values({ companyId, issueId, body: "READY", authorType: "agent", authorAgentId: agentId,
      createdByRunId: run!.id, createdAt: new Date(t0 + 19_000) });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: true,
      memberships: [{ companyId, status: "active", membershipRole: "owner" }] }; next(); });
    app.use("/api", issueRoutes(db, {} as any, {})); app.use("/api", agentRoutes(db)); app.use(errorHandler);
    const driver = createLifecycleDriver(db, {} as never);
    const onReadyCalls: unknown[] = [];
    // lifecycle.on = false holds the agent in 'resuming' (no background step), so the hand-off at the resume
    // transition is visited deterministically BEFORE ready; then the worker reaches ready (onReady).
    const lifecycleGate = { on: true };
    const worker = configureAgentLifecycle(db, { ...driver, requiredPluginIds: async () => [], runPlugin: async () => "complete",
      onReady: async agent => {
        try { await driver.onReady!(agent); onReadyCalls.push("ok"); } catch (error) { onReadyCalls.push(String(error)); throw error; }
      } }, () => lifecycleGate.on);
    const post = async (body: string) => {
      const res = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      log({ label, step: "comment", status: res.status, id: res.body?.id });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const pause = async () => {
      // What POST /api/agents/:id/pause does (routes/agents.ts:6098-6111), minus the route's auth.
      await createAgentLifecycle(db).pauseAgent(agentId);
      await heartbeatService(db).cancelActiveForAgent(agentId);
      await worker.process(agentId);
    };
    // The hints Resume itself hands to recovery/work.ts's strandedAssignments queue (at commit).
    const capture = async (work: () => Promise<unknown>) => {
      const hints: string[] = [];
      const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.strandedAssignments, (event, set) => {
        if (event === "settled") hints.push(...(set ?? []));
      });
      // NOTIFY is delivered after commit, asynchronously: let it arrive before reading the hints.
      try { await work(); await new Promise(r => setTimeout(r, 400)); } finally { unsubscribe(); }
      return hints.filter(h => h !== "*").map(h => JSON.parse(h) as { companyId: string; issueId?: string })
        .filter(h => h.companyId === companyId && h.issueId === issueId);
    };
    // The recovery worker's own per-issue visit (recovery/work.ts register load + check): the page row filter,
    // the batched flagged query, then heartbeat.reconcileStrandedAssignedIssues with its scope.
    const workerVisit = async () => {
      const [row] = await db.select({ status: issues.status, hiddenAt: issues.hiddenAt, assigneeUserId: issues.assigneeUserId })
        .from(issues).where(eq(issues.id, issueId));
      const loaded = ["todo", "in_progress", "in_review"].includes(row!.status) && !row!.hiddenAt && !row!.assigneeUserId;
      const flagged = (await db.select({ id: issueComments.id }).from(issueComments)
        .where(and(inArray(issueComments.issueId, [issueId]), unansweredPersonMessageCommentCondition()))).length > 0;
      if (loaded) await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId, unanswered: flagged,
        skipExternalConversationSettlement: true, skipRelatedRecovery: true, onDeferredDeadline: () => {} } as never);
      return { loaded, flagged };
    };
    const visitHints = async (hints: unknown[]) => { const out = []; for (const _ of hints) out.push(await workerVisit()); return out; };
    const resumeStepwise = async () => {
      // What POST /api/agents/:id/resume does (routes/agents.ts:6129-6145): the resume transition commits
      // (paused -> resuming; its hint is processed at once, while the agent is still 'resuming'), then the
      // lifecycle worker reaches ready (onReady, agent-lifecycle-driver.ts) and its hint is processed.
      lifecycleGate.on = false;
      const atResuming = await capture(() => createAgentLifecycle(db).resumeAgent(agentId));
      const agentAtResuming = await agentRow();
      const visitsAtResuming = await visitHints(atResuming);
      const wakesAfterResumingVisit = (await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason,
        source: agentWakeupRequests.source, runId: agentWakeupRequests.runId, payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
        .map(w => ({ ...w, commentId: (w.payload as Record<string, unknown> | null)?.commentId, payload: undefined }));
      lifecycleGate.on = true;
      const atReady = await capture(() => worker.process(agentId));
      const visitsAtReady = await visitHints(atReady);
      const candidateAtReady = (await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, issueId), unansweredPersonMessageCondition(issues.id, issues.companyId)))).length;
      return { onReadyCalls: [...onReadyCalls], candidateAtReady, agentAtReady: await agentRow(), atResuming: atResuming.length, agentAtResuming, visitsAtResuming, wakesAfterResumingVisit, atReady: atReady.length, visitsAtReady };
    };
    const agentRow = async () => (await db.select({ status: agents.status, lifecycleState: agents.lifecycleState, holds: agents.lifecycleHolds,
      pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, agentId)))[0];
    const state = async () => ({
      agent: await agentRow(),
      wakes: (await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, reason: agentWakeupRequests.reason,
        error: agentWakeupRequests.error, runId: agentWakeupRequests.runId, payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)).orderBy(asc(agentWakeupRequests.createdAt))),
      runs: (await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, error: heartbeatRuns.errorCode, context: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).orderBy(asc(heartbeatRuns.createdAt))).slice(1),
      notes: (await db.select({ body: issueComments.body, deletedAt: issueComments.deletedAt }).from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")))).map(n => `${n.deletedAt ? "[deleted] " : ""}${n.body}`),
    });
    // Runs STARTED for the message (its own issue_commented wake). The fixture has no runner, so a started run
    // fails (controller_lease_lost) and Paperclip queues a continuation (retryOfRunId) carrying it: not a second start.
    const runsFor = async (commentId: string) => (await state()).runs
      .filter(r => (r.context as Record<string, unknown> | null)?.wakeCommentId === commentId
        && (r.context as Record<string, unknown>).wakeReason === "issue_commented");
    const wakesFor = async (commentId: string) => (await state()).wakes
      .filter(w => (w.payload as Record<string, unknown> | null)?.commentId === commentId && w.reason === "issue_commented");
    return { companyId, agentId, issueId, userId, app, lifecycleGate, post, pause, capture, workerVisit, visitHints, resumeStepwise, state, runsFor, wakesFor, worker };
  }

  it("RED row: pause -> message -> Resume BEFORE any sweep pass (no paused note) -> Resume hands the issue -> a run starts for the message", async () => {
    const f = await fixture("red");
    try {
      await f.pause();
      const commentId = await f.post("note test");
      const before = await f.state();
      log({ row: "red", step: "paused + message, no sweep", commentId, ...before });
      expect(before.notes, "no sweep pass yet: no paused note").toEqual([]);
      const resumed = await f.resumeStepwise();
      const after = await f.state();
      const runs = await f.runsFor(commentId), wakes = await f.wakesFor(commentId);
      log({ row: "red", step: "after Resume (only Resume's hand-offs visited)", resumed, runsForMessage: runs, wakesForMessage: wakes, ...after });
      expect(resumed.atResuming + resumed.atReady, "Resume hands the issue to the sweep's per-issue entry").toBeGreaterThan(0);
      expect(wakes, "wake issue_commented with the message").toHaveLength(1);
      expect(runs, "a run carrying wakeCommentId = the message").toHaveLength(1);
    } finally { await f.worker.stop(); }
  }, 60_000);

  it("control: note-first (sweep at +16 s writes the paused note, then Resume) runs exactly once", async () => {
    const f = await fixture("nf");
    try {
      await f.pause();
      const start = Date.now();
      const commentId = await f.post("note test");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start + 16_000);
      await f.workerVisit();
      const noted = await f.state();
      log({ row: "note-first", step: "+16 s sweep", ...noted });
      expect(noted.notes.some(n => /is paused/.test(n))).toBe(true);
      vi.setSystemTime(start + 240_000);
      const resumed = await f.resumeStepwise();
      // And the ordinary sweep pass reaching it afterwards too: still one run.
      await f.workerVisit(); await f.workerVisit();
      const runs = await f.runsFor(commentId), wakes = await f.wakesFor(commentId);
      log({ row: "note-first", step: "after Resume + 2 more visits", resumed, runsForMessage: runs.length, wakesForMessage: wakes.length, ...(await f.state()) });
      expect(wakes).toHaveLength(1);
      expect(runs).toHaveLength(1);
    } finally { await f.worker.stop(); }
  }, 60_000);

  it("control: an already-answered message is not re-run by Resume", async () => {
    const f = await fixture("ans");
    try {
      await f.pause();
      const resumed = await f.resumeStepwise();
      await f.workerVisit();
      const end = await f.state();
      log({ row: "answered", resumed, ...end });
      expect(resumed.atResuming + resumed.atReady, "nothing owed: Resume hands nothing").toBe(0);
      expect(end.wakes, "no wake").toEqual([]);
      expect(end.runs, "no run").toEqual([]);
    } finally { await f.worker.stop(); }
  }, 60_000);

  it("control: busy run -> message (deferred) -> pause (cancelled) -> Resume: pausewake's card OR a run, never both", async () => {
    const f = await fixture("busy");
    try {
      const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
        contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented" }, startedAt: new Date() }).returning();
      await db.update(issues).set({ executionRunId: busy!.id, executionAgentNameKey: "managed pi", executionLockedAt: new Date() }).where(eq(issues.id, f.issueId));
      const start = Date.now();
      const commentId = await f.post("pw test");
      log({ row: "busy", step: "after comment", ...(await f.state()) });
      await f.pause();
      log({ row: "busy", step: "after pause", ...(await f.state()) });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start + 30_000);
      const resumed = await f.resumeStepwise();
      log({ row: "busy", step: "after Resume", resumed, ...(await f.state()) });
      vi.setSystemTime(start + 30_000 + 125_000);
      await f.workerVisit();
      vi.setSystemTime(start + 30_000 + 11 * 60_000);
      await f.workerVisit();
      const end = await f.state();
      const runs = (await f.runsFor(commentId)).filter(r => r.id !== busy!.id);
      const card = end.notes.filter(n => !n.startsWith("[deleted]") && /paused before it answered/.test(n));
      log({ row: "busy", step: "+125 s and +11 m", runsForMessage: runs.length, card, ...end });
      expect(runs.length > 0 || card.length > 0, "a run or the card").toBe(true);
      expect(runs.length > 0 && card.length > 0, "never both").toBe(false);
    } finally { await f.worker.stop(); }
  }, 60_000);

  it.each([[true, "s1"], [false, "s0"]] as const)("STEER: the SAME user pauses (POST /api/agents/:id/pause) and posts 'note test'; Resume by that user (sweep at +16 s: %s)", async (sweepFirst, label) => {
    const f = await fixture(label);
    try {
      const paused = await request(f.app).post(`/api/agents/${f.agentId}/pause`).send({});
      log({ row: "same-user", sweepFirst, step: "POST pause", status: paused.status, error: paused.body?.error });
      if (paused.status !== 200) {
        // Route refused in this fixture: the same lifecycle call + its activity row with the user as actor.
        await createAgentLifecycle(db).pauseAgent(f.agentId);
        await heartbeatService(db).cancelActiveForAgent(f.agentId);
        await db.insert(activityLog).values({ companyId: f.companyId, actorType: "user", actorId: f.userId, action: "agent.paused",
          entityType: "agent", entityId: f.agentId });
      }
      await f.worker.process(f.agentId);
      const pausedBy = await db.select({ actorType: activityLog.actorType, actorId: activityLog.actorId }).from(activityLog)
        .where(and(eq(activityLog.entityId, f.agentId), eq(activityLog.action, "agent.paused")));
      const start = Date.now();
      const commentId = await f.post("note test");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start + 16_000);
      if (sweepFirst) await f.workerVisit();
      const noted = await f.state();
      log({ row: "same-user", sweepFirst, step: "+16 s sweep", pausedBy, sameUser: pausedBy.some(p => p.actorId === f.userId), ...noted });
      vi.setSystemTime(start + 240_000);
      f.lifecycleGate.on = false;
      const atResume = await f.capture(async () => {
        const res = await request(f.app).post(`/api/agents/${f.agentId}/resume`).send({});
        log({ row: "same-user", step: "POST resume", status: res.status, error: res.body?.error });
        if (res.status !== 200) await createAgentLifecycle(db).resumeAgent(f.agentId);
      });
      const visitsAtResuming = await f.visitHints(atResume);
      f.lifecycleGate.on = true;
      const atReady = await f.capture(() => f.worker.process(f.agentId));
      const visitsAtReady = await f.visitHints(atReady);
      const runs = await f.runsFor(commentId);
      log({ row: "same-user", sweepFirst, step: "after Resume", handed: { atResuming: atResume.length, visitsAtResuming, atReady: atReady.length, visitsAtReady },
        runsForMessage: runs.length, ...(await f.state()) });
      expect(noted.notes.some(n => /is paused/.test(n)), "paused note at +16 s only when the sweep ran").toBe(sweepFirst);
      expect(runs, "a run for the message after Resume").toHaveLength(1);
    } finally { await f.worker.stop(); }
  }, 60_000);
});
