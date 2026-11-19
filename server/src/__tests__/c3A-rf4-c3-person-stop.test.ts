import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRuns, heartbeatRunEvents, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Independent reviewer regression: real person HTTP Stop, real DB cancellation,
// real release/orchestrator/provider receipts and admission. No release or hold
// producer is mocked. Only native provider execution/cancel delivery is scripted.
const fixture = vi.hoisted(() => ({ calls: [] as string[], firstRun: "", onFirst: undefined as undefined | (() => Promise<void>), successorThrows: false,
  firstFails: false, onSuccessor: undefined as undefined | ((binding: { companyId: string; agentId: string; runId: string; issueId: string }) => Promise<void>) }));
vi.mock("../services/heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/runtime-selection.js")>();
  return { ...actual, prepareAndSelectHeartbeatRuntime: (async (db, input, deps) => actual.prepareAndSelectHeartbeatRuntime(db,
    { ...input, onProviderResourceDisposition: () => input.onProviderResourceDisposition("keep_running") }, deps)) as typeof actual.prepareAndSelectHeartbeatRuntime };
});
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual,
    cancelNativeSession: (async (runId, reason, options) => {
      const result = await actual.cancelNativeSession(runId, reason, options!);
      if (!options || runId !== fixture.firstRun || typeof result !== "object") return result;
      await options.db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCancellation,dispatched}', 'true'::jsonb)` })
        .where(eq(heartbeatRuns.id, runId));
      return { ...result, dispatched: true };
    }) as typeof actual.cancelNativeSession,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId; fixture.calls.push(runId);
      if (runId === fixture.firstRun && fixture.onFirst) {
        await fixture.onFirst();
        // P9-60 control: the first turn's provider FAILS (no Stop by anyone).
        if (fixture.firstFails) throw new Error("p960_first_provider_turn_failed");
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      if (fixture.successorThrows) throw new Error("rf4_successor_provider_turn_reached");
      if (fixture.onSuccessor) await fixture.onSuccessor(input.execution.binding as never);
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "rf4 successor answered" };
    }) as typeof actual.executePaperclipNativeSession };
});
import { heartbeatService } from "../services/heartbeat.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { agentWakeupRequests } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { hasConfirmedSandboxStopAndRetain } from "../services/sandbox-stop-and-retain.js";
import { executionProjectionsForRuns } from "../services/execution-projection.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { getSandboxProvider } from "../services/sandbox-provider-runtime.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { acknowledgedNativeStopExecutionHasStopped } from "../services/acknowledged-native-stop.js";
import { issueService } from "../services/issues.js";
import { answeredPersonMessageSql } from "../services/person-message-answer.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { PERSON_STOP_HELD_MESSAGE_NEXT_ACTION, PERSON_STOP_HELD_MESSAGE_TEXT, PERSON_STOP_HELD_MESSAGE_TITLE, settleUnansweredPersonMessage,
  UNANSWERED_MESSAGE_NO_RUN_TEXT } from "../services/recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
async function waitFor(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error("rf4 wait timed out"); await new Promise(r => setTimeout(r, 25)); }
}
describe.skipIf(!support.supported)("rf4 C3 product-only person Stop", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("rf4-c3-person-"); db = createDb(temp.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "rf4-c3-home-")); process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "rf4-person", name: "Person", email: "rf4@example.invalid", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 }); await temp?.cleanup();
    const writable = async (dir: string): Promise<void> => { const st = await fs.lstat(dir).catch(() => null); if (!st?.isDirectory() || st.isSymbolicLink()) return; await fs.chmod(dir, 0o700); for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }); }
  });
  // a8 (D2): opts.chat makes the task a chat and sends the message through the real chat
  // route POST /api/issues/:id/comments (routes/issues.ts:20130-20162).
  // P9-60: opts.messages sends that many messages through the real comment route
  // (POST /api/issues/:id/comments), on the chat and on a plain task alike;
  // mode "fails" sends them, then the first turn's provider fails (no Stop).
  async function exercise(mode: "waiting" | "mid_turn" | "fails", label: string, opts: { chat?: boolean; messages?: number; noMessages?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), wakeId = randomUUID();
    const providerLeaseId = `sandbox://fake/${runId}/${randomUUID()}`;
    const remoteCwd = path.join(home, runId); await fs.mkdir(remoteCwd); await fs.writeFile(path.join(remoteCwd, "notes.md"), "stopped edit\n");
    await db.insert(companies).values({ id: companyId, name: "Reviewer Stop", issuePrefix: `J${companyId.slice(0, 6)}`, defaultResponsibleUserId: "rf4-person", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "rf4-person", membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Daily path shape", status: "in_progress", priority: "medium", assigneeAgentId: agentId,
      responsibleUserId: "rf4-person", issueNumber: 1, identifier: `J${companyId.slice(0, 6)}-1` });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue", status: "queued", invocationSource: "assignment", wakeupRequestId: null,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "rf4-person", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use("/api", issueRoutes(db, {} as any, {})); app.use(errorHandler);
    let leaseId = "", stopMs = 0, stopResponse: unknown, waitingWakes: unknown;
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never, beforeNativeRuntimeSelection: async id => {
      if (id !== runId) return;
      // P9-60 control: a native turn with no sandbox workspace (no lease to preserve).
      if (mode === "fails") {
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativePhase: "observed" }).where(eq(heartbeatRuns.id, runId));
        await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
        return;
      }
      const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, provider: "fake", providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
        metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", reuseLease: true, reusableSandboxLease: true, remoteCwd, agentId } }).returning(); leaseId = lease.id;
      const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd, resourceDisposition: "keep_running" };
      await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativePhase: "observed", runnerProfileJson: { nativeWorkspaceSync: reference, nativeResourceDisposition: "keep_running" } }).where(eq(heartbeatRuns.id, runId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: -1, eventType: "tool.execution.started", stream: "system" });
    } });
    let commentId = randomUUID();
    const message = async () => {
      if (opts.messages) {
        if (opts.chat) {
          await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
          await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: "rf4-person", conversationState: "active" }).where(eq(issues.id, issueId));
        }
        for (let i = 1; i <= opts.messages; i += 1) {
          const sent = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: `Held message ${i}`, clientRequestId: randomUUID() });
          expect(sent.status, JSON.stringify(sent.body)).toBe(201); commentId = sent.body.id;
          await new Promise(r => setTimeout(r, 20));
        }
        return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      }
      if (opts.chat) {
        await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
        await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: "rf4-person", conversationState: "active" }).where(eq(issues.id, issueId));
        const sent = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Please answer next.", clientRequestId: randomUUID() });
        expect(sent.status, JSON.stringify(sent.body)).toBe(201); commentId = sent.body.id;
        return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      }
      await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "rf4-person", body: "Please answer next." });
      return heartbeat.wakeup(agentId, { source: "automation", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "rf4-person",
        payload: { issueId, commentId }, contextSnapshot: { issueId, commentId, wakeReason: "issue_commented" } });
    };
    fixture.firstRun = runId; fixture.calls = [];
    fixture.onFirst = async () => {
      if (mode === "fails") { if (!opts.noMessages) waitingWakes = await message(); return; }
      if (mode === "waiting") waitingWakes = await message();
      const start = Date.now();
      const result = await request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      stopMs = Date.now() - start; stopResponse = { status: result.status, body: result.body };
      expect(result.status).toBe(200); expect(result.body.status).toBe("cancelled");
      await waitFor(async () => ((await heartbeat.getRun(runId))?.resultJson?.nativeCancellation as { dispatchState?: string } | undefined)?.dispatchState === "acknowledged");
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled", leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      if (mode === "mid_turn") waitingWakes = await message();
    };
    const provider = getSandboxProvider("fake")!, stop = vi.spyOn(provider, "stopLease");
    try {
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      const admittedAt = Date.now();
      do { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); if (fixture.calls.length > 1) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() - admittedAt < 10_000);
      const [lease] = leaseId ? await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)) : [];
      const allLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
      const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), sql`(${heartbeatRuns.contextSnapshot}->>'commentId' = ${commentId} or ${heartbeatRuns.contextSnapshot}->'wakeCommentIds' ? ${commentId})`));
      const blocker = await getExecutionBlocker(db, companyId, issueId);
      const projection = (await executionProjectionsForRuns(db, companyId, [runId])).get(runId);
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      const interruption = await taskInterruptionPresentation(db, task);
      const evidence = { mode, opts, runId, companyId, agentId, issueId, commentId, lease, allLeases, holds, runs, calls: [...fixture.calls], blocker, projection, interruption,
        stopMs, stopResponse, waitingWakes, stopCalls: stop.mock.calls, observedMs: Date.now() - admittedAt, confirmed: lease ? hasConfirmedSandboxStopAndRetain(lease) : false };
      await fs.writeFile(path.join(process.env.TASK_OUT!, `own-${label}.json`), JSON.stringify(evidence, null, 2));
      return { ...evidence, app, heartbeat };
    } finally { fixture.onFirst = undefined; await heartbeat.drainActiveRunExecutions(); stop.mockRestore(); }
  }
  // RFL 05:07Z: a message waiting BEFORE the person's Stop is not run by itself
  // after that Stop. It stays HELD (the deferred wake the queued list shows with
  // Send) and is answered exactly once on Send or with the next new message.
  async function sweepRuns(r: { heartbeat: ReturnType<typeof heartbeatService>; issueId: string }, ms: number, stop?: (runs: { id: string; ctx: any }[]) => boolean) {
    const t0 = Date.now(); let runs: { id: string; status: string; ctx: any }[] = [];
    do { await r.heartbeat.resumeQueuedRuns(); await r.heartbeat.drainActiveRunExecutions();
      runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, ctx: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.issueId, r.issueId));
      if (stop?.(runs)) break; await new Promise(res => setTimeout(res, 250)); } while (Date.now() - t0 < ms);
    return { runs, ms: Date.now() - t0 };
  }
  const carries = (run: { ctx: any }, commentId: string) => [run.ctx?.commentId, ...(run.ctx?.wakeCommentIds ?? [])].includes(commentId);
  async function heldAfterStop(r: Awaited<ReturnType<typeof exercise>>) {
    // (i) held for 60 s after the Stop: zero runs, shown in the queued list with Send.
    const quiet = await sweepRuns(r, 50_000);
    const queue = (await request(r.app).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    expect.soft(r.confirmed, "released stop_and_retain receipt").toBe(true);
    expect.soft(r.stopMs).toBeLessThan(10_000);
    expect(r.runs, "M1 is not run by itself after the person's Stop").toHaveLength(0);
    expect(quiet.runs.filter(run => run.id !== r.runId), "zero runs for 60 s").toHaveLength(0);
    expect(r.calls).toEqual([r.runId]);
    expect.soft(r.blocker).toBeNull();
    expect(queue.state, "held").toBe("deferred");
    expect(queue.targetRunId, "the held list offers Send, not Interrupt").toBeNull();
    expect(queue.entries.map((e: any) => e.comment.id)).toEqual([r.commentId]);
    return queue;
  }
  it("Q1 person Stop BUTTON with one message waiting releases with receipt and holds it with Send (RFL 05:07Z), zero runs for 60 s", async () => {
    const r = await exercise("waiting", "q1");
    await heldAfterStop(r);
    await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q1-held.json"), JSON.stringify({ wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, r.agentId)) }, null, 2));
  }, 150_000);
  it("Q1 Send through the real held-list route answers the held message exactly once, never twice", async () => {
    const r = await exercise("waiting", "q1-send");
    const queue = await heldAfterStop(r);
    const t0 = Date.now();
    const send = await request(r.app).post(`/api/issues/${r.issueId}/queued-comments/interrupt`).send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    expect(send.status).toBe(200);
    const sent = await sweepRuns(r, 20_000, runs => runs.some(run => run.id !== r.runId) && fixture.calls.length > 1);
    const answeredMs = Date.now() - t0;
    // (iv) never twice: keep sweeping after the answer; M1 is not answered again.
    const later = await sweepRuns(r, 15_000);
    const m1Runs = later.runs.filter(run => run.id !== r.runId && carries(run, r.commentId));
    const after = (await request(r.app).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q1-send.json"), JSON.stringify({ send: { status: send.status, body: send.body }, answeredMs, calls: fixture.calls,
      runs: later.runs.map(run => ({ id: run.id, status: run.status, commentId: run.ctx?.commentId, wakeCommentIds: run.ctx?.wakeCommentIds })), after }, null, 2));
    expect(sent.runs.filter(run => run.id !== r.runId)).toHaveLength(1);
    expect(answeredMs).toBeLessThan(20_000);
    expect(m1Runs, "exactly one run carries M1").toHaveLength(1);
    expect(later.runs.filter(run => run.id !== r.runId), "no second answer").toHaveLength(1);
    expect(fixture.calls).toEqual([r.runId, m1Runs[0]!.id]);
    expect(after.entries ?? []).toHaveLength(0);
  }, 180_000);
  it("Q1 a new message instead of Send carries the held message: one run with M2 + M1", async () => {
    const r = await exercise("waiting", "q1-m2");
    await heldAfterStop(r);
    const m2 = randomUUID();
    await db.insert(issueComments).values({ id: m2, companyId: r.companyId, issueId: r.issueId, authorType: "user", authorUserId: "rf4-person", body: "And this too." });
    await r.heartbeat.wakeup(r.agentId, { source: "automation", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "rf4-person",
      payload: { issueId: r.issueId, commentId: m2 }, contextSnapshot: { issueId: r.issueId, commentId: m2, wakeReason: "issue_commented" } });
    await sweepRuns(r, 20_000, runs => runs.some(run => run.id !== r.runId) && fixture.calls.length > 1);
    const later = await sweepRuns(r, 15_000);
    const successors = later.runs.filter(run => run.id !== r.runId);
    await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q1-m2.json"), JSON.stringify({ m1: r.commentId, m2, calls: fixture.calls,
      runs: later.runs.map(run => ({ id: run.id, status: run.status, commentId: run.ctx?.commentId, wakeCommentIds: run.ctx?.wakeCommentIds })) }, null, 2));
    expect(successors, "one run").toHaveLength(1);
    expect(carries(successors[0]!, m2) && carries(successors[0]!, r.commentId), "it carries M2 + M1").toBe(true);
    expect(fixture.calls).toEqual([r.runId, successors[0]!.id]);
  }, 180_000);
  it("Q2 MID-TURN person Stop never silently withholds the next message behind prepared-workspace preservation", async () => {
    const r = await exercise("mid_turn", "q2");
    const executedOnce = r.runs.length === 1 && r.calls.includes(r.runs[0].id);
    const actionable = r.blocker?.canRetry === true && !!r.blocker.nextAction?.trim();
    expect.soft(r.confirmed).toBe(true);
    expect(executedOnce || actionable, `runs=${r.runs.length}; blocker=${JSON.stringify(r.blocker)}`).toBe(true);
  }, 60_000);
  // rf-4 06:20Z ruling (org 06:20-06:21Z: c3-stop ships with NO Stop note): after a person's
  // Stop the next answer arrives, and once the receipt lands the REAL chat read routes show
  // none of the stale stopping / recovery lines.
  it("Q5 after a person's Stop the next answer arrives and, once the receipt lands, the chat shows no stale stopping or recovery text", async () => {
    const r = await exercise("mid_turn", "q5", { chat: true });
    const later = await sweepRuns(r, 10_000);
    const successors = later.runs.filter(run => run.id !== r.runId);
    expect(r.confirmed, "the stop_and_retain receipt landed").toBe(true);
    expect(successors, "the next answer arrives: exactly one run").toHaveLength(1);
    expect(carries(successors[0]!, r.commentId), "it carries the person's next message").toBe(true);
    expect(fixture.calls).toEqual([r.runId, successors[0]!.id]);
    const reads: Record<string, unknown> = {};
    for (const route of ["", "/comments", "/queued-comments", "/recovery-actions", "/active-run", "/live-runs"]) {
      const res = await request(r.app).get(`/api/issues/${r.issueId}${route}`);
      expect(res.status, `GET /api/issues/:id${route}`).toBe(200); reads[route || "/"] = res.body;
    }
    await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q5-chat-reads.json"), JSON.stringify(reads, null, 2));
    const shown = JSON.stringify(reads);
    for (const stale of ["Stop pending", "Recovering your saved work", "will start automatically", "Recovery needed", "Waiting for execution recovery", "Waiting for the previous environment to stop"])
      expect(shown, `the chat shows "${stale}"`).not.toContain(stale);
  }, 60_000);
  it("Q5 control (RFL): a THROWING successor provider still gets its own true failure note", async () => {
    fixture.successorThrows = true;
    try {
      const r = await exercise("mid_turn", "q5-control");
      const failure = r.holds.filter(h => h.evidence?.runId !== r.runId && ["active", "escalated"].includes(h.status));
      await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q5-control-holds.json"), JSON.stringify({ holds: r.holds, blocker: r.blocker }, null, 2));
      expect(r.calls.length, "the provider was reached").toBe(2);
      expect(failure, "the successor's real failure has its own note").toHaveLength(1);
      expect(r.blocker?.runId, "the blocker names the failed successor, not the stopped run").toBe(r.runs[0]?.id);
    } finally { fixture.successorThrows = false; }
  }, 60_000);
  // a8 D2 (Fable, FABLE-RESULT.md): acknowledged-native-stop.ts demanded a sandbox
  // stop receipt from EVERY lease, the twin of the rule e39891d3 removed at
  // explicit-native-continuation.ts:573. Shape: a released LOCAL lease beside the
  // stopped sandbox lease (the real flow writes it); messages go in through the
  // real CHAT route.
  it("Q1 chat: the held list says the true Stop line, never a recovery or auto-start wait", async () => {
    const r = await exercise("waiting", "q1-line", { chat: true });
    await db.update(issues).set({ conversationAgentId: r.agentId, conversationUserId: "rf4-person", conversationState: "active" }).where(eq(issues.id, r.issueId));
    const queue = (await request(r.app).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, r.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
    await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q1-line.json"), JSON.stringify({ queue, wake, leases: r.allLeases }, null, 2));
    expect(r.allLeases.some(l => l.provider === "local" && !!l.releasedAt) && r.allLeases.some(l => l.provider === "fake"), "the real flow leaves a released local lease beside the sandbox lease").toBe(true);
    expect(queue.entries.map((e: any) => e.comment.id)).toEqual([r.commentId]); expect((wake.payload as any).executionWait ?? null, "no saved wait on a held message").toBeNull();
    expect(queue.executionWait).toEqual({ reason: "stopped_by_person", message: "Stopped. These messages are waiting: Send them, or delete any first." }); }, 60_000);
  it("Q1 chat (a): a message typed while the box is still stopping runs once after the receipt", async () => {
    const r = await exercise("mid_turn", "q1-stopping", { chat: true });
    const later = await sweepRuns(r, 10_000);
    const successors = later.runs.filter(run => run.id !== r.runId);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, r.agentId));
    await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q1-stopping.json"), JSON.stringify({ calls: fixture.calls, wakes, leases: r.allLeases,
      runs: later.runs.map(run => ({ id: run.id, status: run.status, commentId: run.ctx?.commentId, wakeCommentIds: run.ctx?.wakeCommentIds })) }, null, 2));
    expect(r.allLeases.some(l => l.provider === "local" && !!l.releasedAt) && r.allLeases.some(l => l.provider === "fake")).toBe(true);
    expect.soft(r.confirmed, "released stop_and_retain receipt").toBe(true);
    expect(successors, "exactly one run after the receipt").toHaveLength(1);
    expect(carries(successors[0]!, r.commentId), "it carries the message typed while stopping").toBe(true);
    expect(fixture.calls).toEqual([r.runId, successors[0]!.id]);
  }, 60_000);
  it("Q1 control: a REMOTE (sandbox) lease without its stop receipt still holds, local lease or not", async () => {
    const r = await exercise("waiting", "q1-remote-control", { chat: true });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.runId));
    const withReceipt = await acknowledgedNativeStopExecutionHasStopped(db, run);
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} - 'remoteExecutionTermination' - 'workspaceRecoveryCleanup'` })
      .where(and(eq(environmentLeases.heartbeatRunId, r.runId), sql`${environmentLeases.provider} <> 'local'`));
    const withoutReceipt = await acknowledgedNativeStopExecutionHasStopped(db, run);
    await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q1-remote-control.json"), JSON.stringify({ withReceipt, withoutReceipt, leases: r.allLeases }, null, 2));
    expect(withReceipt, "local released + sandbox receipt: the Stop is proven").toBe(true);
    expect(withoutReceipt, "sandbox lease with no stop receipt: the Stop is NOT proven").toBe(false);
  }, 60_000);
  // P9-60 (stack-lead's live row on c1): three messages held by a PERSON's Stop, NO Send for 5 min,
  // then Send. Built from the real producers: the messages through POST /api/issues/:id/comments,
  // the Stop through POST /api/heartbeat-runs/:runId/cancel (routes/agents.ts, the product's own
  // cancellation and acknowledgement), the Send through POST /api/issues/:id/queued-comments/interrupt,
  // the answer through issueService.addComment (the agent comment route's writer) inside the successor
  // turn, the task's done through PATCH /api/issues/:id. Sweeps: settleUnansweredPersonMessage (the
  // recovery worker's per-task entry) at simulated +1/+3/+5 min; after the answer, the REAL recovery
  // worker (heartbeat.registerIssueStateRecoveryWork). What the person sees: GET /api/issues/:id/comments.
  const unansweredNotes = (comments: any[]) => comments.filter(c => c.authorType === "system"
    && String(c.metadata?.authorizationReason ?? "").startsWith("unanswered_message:"));
  const answeredFlags = async (companyId: string, ids: string[]) => Promise.all(ids.map(async id => (await db.select({
    answered: answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) })
    .from(issueComments).where(and(eq(issueComments.companyId, companyId), eq(issueComments.id, id))))[0]!.answered));
  for (const surface of ["chat", "task"] as const) it(`P9-60 ${surface}: three held by a person's Stop get R3 (never no_run), and every note retires once answered`, async () => {
    const r = await exercise("waiting", `p960-${surface}`, { chat: surface === "chat", messages: 3 });
    const evidence: Record<string, unknown> = { holdsAfterStop: r.holds };
    // The real Stop leaves NO board-owned recovery action (the measured board hold was the harness's).
    expect(r.holds.filter(h => ["active", "escalated"].includes(h.status)), "the real Stop leaves no board hold").toEqual([]);
    // LIVE shape (stack-lead 22:12Z, live c1 captures): the card has no "Recovery action" row and
    // issue.activeRecoveryAction is null. Ordering: the person's Stop is acknowledged while the
    // executor still runs the turn (cancelNativeSession dispatch, then the executor ends the turn
    // with NativeCancellationPendingRecoveryError), so the release sees the acknowledged Stop
    // (wake-queue/adapters/postgres.ts isAcknowledgedNativeStop) and writes no hold.
    const issueRead = (await request(r.app).get(`/api/issues/${r.issueId}`).expect(200)).body;
    evidence.activeRecoveryAction = issueRead.activeRecoveryAction ?? null;
    expect(issueRead.activeRecoveryAction ?? null, "issue.activeRecoveryAction is null, like live").toBeNull();
    const messages = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, r.issueId), eq(issueComments.authorType, "user"))))
      .sort((a, b) => +a.createdAt - +b.createdAt);
    expect(messages.map(m => m.body)).toEqual(["Held message 1", "Held message 2", "Held message 3"]);
    const queue = (await request(r.app).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    expect(queue.state, "held").toBe("deferred");
    expect(queue.entries.map((e: any) => e.comment.id)).toEqual(messages.map(m => m.id));
    // NO Send for 5 min of product sweeps.
    const latest = messages.at(-1)!.createdAt.getTime();
    const sweeps: unknown[] = [];
    for (const minutes of [1, 3, 5]) {
      const outcome = await settleUnansweredPersonMessage(db, { companyId: r.companyId, issueId: r.issueId, now: new Date(latest + minutes * 60_000) });
      const shown = (await request(r.app).get(`/api/issues/${r.issueId}/comments`).expect(200)).body as any[];
      sweeps.push({ minutes, outcome, notes: unansweredNotes(shown).map(n => ({ reason: n.metadata.authorizationReason, body: n.body, title: n.presentation?.title })) });
      await fs.writeFile(path.join(process.env.TASK_OUT!, `own-p960-${surface}-sweeps.json`), JSON.stringify({ ...evidence, sweeps }, null, 2));
      if (minutes === 1) continue;
      const notes = unansweredNotes(shown);
      const all = JSON.stringify(shown);
      expect(all, "no no_run card").not.toContain(UNANSWERED_MESSAGE_NO_RUN_TEXT);
      expect(all, "never 'assign this agent a new task'").not.toContain("assign this agent a new task");
      expect(notes.length, `+${minutes} min: one note for the held set`).toBe(1);
      for (const note of notes) {
        expect(note.body, "R3 exactly").toBe(PERSON_STOP_HELD_MESSAGE_TEXT);
        expect(JSON.stringify(note)).toContain(PERSON_STOP_HELD_MESSAGE_TITLE);
        expect(JSON.stringify(note)).toContain(PERSON_STOP_HELD_MESSAGE_NEXT_ACTION);
        expect(messages.map(m => `unanswered_message:${m.id}`)).toContain(note.metadata.authorizationReason);
      }
    }
    evidence.sweeps = sweeps;
    // The person's Send; the successor answers with one reply.
    fixture.onSuccessor = async binding => { await issueService(db).addComment(binding.issueId, "Answered the held messages.",
      { agentId: binding.agentId, runId: binding.runId }); };
    try {
      const send = await request(r.app).post(`/api/issues/${r.issueId}/queued-comments/interrupt`).send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
      expect(send.status, JSON.stringify(send.body)).toBe(200);
      await sweepRuns(r, 20_000, runs => runs.some(run => run.id !== r.runId) && fixture.calls.length > 1);
      await sweepRuns(r, 3_000);
    } finally { fixture.onSuccessor = undefined; }
    const successors = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, r.issueId))).filter(run => run.id !== r.runId);
    const replies = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, r.issueId), eq(issueComments.authorType, "agent"))));
    evidence.successors = successors.map(run => ({ id: run.id, status: run.status, wakeCommentIds: (run.contextSnapshot as any)?.wakeCommentIds }));
    evidence.replies = replies.map(c => ({ id: c.id, runId: c.createdByRunId }));
    expect(successors, "one answer run").toHaveLength(1);
    for (const m of messages) expect(carries({ ctx: successors[0]!.contextSnapshot }, m.id), "the one run carries every held message").toBe(true);
    expect(replies.map(c => c.createdByRunId), "answered exactly once").toEqual([successors[0]!.id]);
    expect(await answeredFlags(r.companyId, messages.map(m => m.id)), "answeredPersonMessageSql: all three answered").toEqual([true, true, true]);
    if (surface === "task") {
      const done = await request(r.app).patch(`/api/issues/${r.issueId}`).send({ status: "done" });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    const [after] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, r.issueId));
    evidence.statusAfterAnswer = after?.status;
    // The REAL recovery worker, with no hint for this task: every note on the held messages retires.
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    const work = r.heartbeat.registerIssueStateRecoveryWork(coordinator, () => true);
    let retired = false;
    try {
      await work.ready;
      retired = await waitFor(async () => {
        work.wake();
        const live = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, r.issueId), eq(issueComments.authorType, "system"))))
          .filter(c => String((c.metadata as any)?.authorizationReason ?? "").startsWith("unanswered_message:") && !c.deletedAt);
        return live.length === 0;
      }, 20_000).then(() => true, () => false);
    } finally { await work.stop(); }
    const notesInDb = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, r.issueId), eq(issueComments.authorType, "system"))))
      .filter(c => String((c.metadata as any)?.authorizationReason ?? "").startsWith("unanswered_message:"));
    const shownAfter = (await request(r.app).get(`/api/issues/${r.issueId}/comments`).expect(200)).body as any[];
    evidence.notesAfterAnswer = notesInDb.map(c => ({ reason: (c.metadata as any).authorizationReason, deletedAt: c.deletedAt, body: c.body }));
    evidence.shownAfterAnswer = unansweredNotes(shownAfter).map(n => n.body);
    await fs.writeFile(path.join(process.env.TASK_OUT!, `own-p960-${surface}.json`), JSON.stringify(evidence, null, 2));
    expect(notesInDb.length, "the held set had a note").toBeGreaterThan(0);
    expect(retired, `every note retired (status ${after?.status})`).toBe(true);
    expect(notesInDb.every(c => c.deletedAt), "every note on them is deleted").toBe(true);
    expect(unansweredNotes(shownAfter), "the person sees no note").toEqual([]);
  }, 180_000);
  // P9-60 control (RFL 20:34Z): a REAL board hold with NO person Stop keeps its own card. Producer:
  // the first turn's provider fails (no Stop by anyone); the wake queue's release writes the board
  // active_run_watchdog hold (modules/wake-queue/adapters/postgres.ts recordNativeTerminalRecoveryIfNeeded).
  it("P9-60 control: a real board hold with no person Stop still shows its own card, never R3", async () => {
    fixture.firstFails = true;
    let r: Awaited<ReturnType<typeof exercise>>;
    try { r = await exercise("fails", "p960-control", { messages: 3 }); } finally { fixture.firstFails = false; }
    const hold = r.holds.find(h => ["active", "escalated"].includes(h.status));
    const messages = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, r.issueId), eq(issueComments.authorType, "user"))))
      .sort((a, b) => +a.createdAt - +b.createdAt);
    const latest = messages.at(-1)!.createdAt.getTime();
    const sweeps: unknown[] = [];
    for (const minutes of [1, 3, 5]) sweeps.push({ minutes, outcome: await settleUnansweredPersonMessage(db, { companyId: r.companyId, issueId: r.issueId, now: new Date(latest + minutes * 60_000) }) });
    const shown = (await request(r.app).get(`/api/issues/${r.issueId}/comments`).expect(200)).body as any[];
    const notes = unansweredNotes(shown);
    await fs.writeFile(path.join(process.env.TASK_OUT!, "own-p960-control.json"), JSON.stringify({ hold, holds: r.holds, sweeps, notes, runs: r.runs.map(run => run.status) }, null, 2));
    expect(hold?.ownerType, "a board hold exists").toBe("board");
    expect(hold?.kind).toBe("active_run_watchdog");
    expect(notes.length, "the board hold's own card").toBe(1);
    expect(notes[0].body, "its own card, unchanged: the no-run card with the hold's rows").toBe(UNANSWERED_MESSAGE_NO_RUN_TEXT);
    expect(notes[0].body).not.toBe(PERSON_STOP_HELD_MESSAGE_TEXT);
    expect(JSON.stringify(notes[0]), "the card names the board hold").toContain(hold!.id);
  }, 180_000);
  // A planted RUNNING native turn that no executor runs (as w1/stopnote/H2), then the REAL person
  // Stop route on it, then the runner's acknowledgement + terminal finalization (w1-measure's DB
  // write). The release ran BEFORE the acknowledgement, so the wake queue's release wrote the Stop's
  // OWN hold (recordNativeTerminalRecoveryIfNeeded: active_run_watchdog /
  // native_continuation_requires_reconciliation, evidence.runId = the stopped run). A person meets it
  // whenever the acknowledgement lands late.
  async function plantedTurnStop(r: { app: express.Express; companyId: string; agentId: string; issueId: string }) {
    const turnId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: turnId, companyId: r.companyId, agentId: r.agentId, issueId: r.issueId, scopeKind: "issue", status: "running",
      invocationSource: "assignment", runtimeMode: "native", nativeIssueId: r.issueId, startedAt: new Date(), contextSnapshot: { issueId: r.issueId, taskId: r.issueId } });
    await db.update(issues).set({ executionRunId: turnId, checkoutRunId: turnId }).where(eq(issues.id, r.issueId));
    await db.insert(nativeRunFinalizations).values({ runId: turnId, companyId: r.companyId, issueId: r.issueId, phase: "observed" });
    const send = async (n: number) => {
      const ids: string[] = [];
      for (let i = 1; i <= n; i += 1) {
        const sent = await request(r.app).post(`/api/issues/${r.issueId}/comments`).send({ body: `Held message ${i}`, clientRequestId: randomUUID() });
        expect(sent.status, JSON.stringify(sent.body)).toBe(201); ids.push(sent.body.id);
        await new Promise(res => setTimeout(res, 20));
      }
      // C1 (rf-5): the comment route answers 201 BEFORE it admits the message's wake
      // (routes/issues.ts: heartbeat.wakeup(...) is not awaited; its comment_wake_pending
      // marker is deleted after admission). A row that plants or reads wake state right
      // after the POSTs raced that admission; it lost under the whole file's load. Wait
      // until every intent is settled and every message sits on a held wake.
      await waitFor(async () => {
        const wakes = await db.select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, r.companyId), eq(agentWakeupRequests.agentId, r.agentId)));
        if (wakes.some(w => w.status === "comment_wake_pending")) return false;
        const held = wakes.filter(w => w.status === "deferred_issue_execution").map(w => JSON.stringify(w.payload));
        return ids.every(id => held.some(p => p.includes(id)));
      }, 20_000);
      return ids;
    };
    const stop = async () => {
      const res = await request(r.app).post(`/api/heartbeat-runs/${turnId}/cancel`).send({ cancellationRequestId: randomUUID() });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [src] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, turnId));
      await db.update(heartbeatRuns).set({ resultJson: { ...(src.resultJson ?? {}), nativeCancellation: { schema: "paperclip.native-cancellation.v1",
        runId: turnId, companyId: r.companyId, issueId: r.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
        dispatched: true, intentAuditId: "stop-intent", acknowledgementAuditId: "stop-ack" } } }).where(eq(heartbeatRuns.id, turnId));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null }).where(eq(nativeRunFinalizations.runId, turnId));
      return res;
    };
    return { turnId, send, stop };
  }
  async function seedPlain(surface: "chat" | "task") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Late ack", issuePrefix: `K${companyId.slice(0, 6)}`, defaultResponsibleUserId: "rf4-person", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "rf4-person", membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Late ack", status: "in_progress", priority: "medium", assigneeAgentId: agentId,
      responsibleUserId: "rf4-person", issueNumber: 1, identifier: `K${companyId.slice(0, 6)}-1`,
      ...(surface === "chat" ? { conversationAgentId: agentId, conversationUserId: "rf4-person", conversationState: "active" as const } : {}) });
    if (surface === "chat") await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "rf4-person", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use("/api", issueRoutes(db, {} as any, {})); app.use(errorHandler);
    return { app, companyId, agentId, issueId };
  }
  const STOPPED_BAR = { reason: "stopped_by_person", message: "Stopped. These messages are waiting: Send them, or delete any first." };
  // R2 (SECONDARY, the board-hold shape, H2-RESULT row (i) ordering): the acknowledgement lands AFTER
  // the release, so the Stop's OWN native_continuation_requires_reconciliation hold is active. The
  // person-Stop held state wins over it through the ONE reader (readPersonStopHold): R3, never no_run.
  for (const surface of ["chat", "task"] as const) it(`P9-60 late ack ${surface}: the Stop's OWN board hold does not turn R3 into no_run`, async () => {
    const r = await seedPlain(surface);
    const turn = await plantedTurnStop(r);
    const ids = await turn.send(3);
    await turn.stop();
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, r.issueId));
    const own = holds.find(h => ["active", "escalated"].includes(h.status));
    const header = (await request(r.app).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    const messages = (await db.select().from(issueComments).where(eq(issueComments.issueId, r.issueId))).filter(c => ids.includes(c.id));
    const latest = Math.max(...messages.map(m => m.createdAt.getTime()));
    const sweeps: unknown[] = [];
    let shown: any[] = [];
    for (const minutes of [1, 3, 5]) {
      const outcome = await settleUnansweredPersonMessage(db, { companyId: r.companyId, issueId: r.issueId, now: new Date(latest + minutes * 60_000) });
      shown = (await request(r.app).get(`/api/issues/${r.issueId}/comments`).expect(200)).body as any[];
      sweeps.push({ minutes, outcome, notes: unansweredNotes(shown).map(n => ({ body: n.body, title: n.presentation?.title })) });
    }
    await fs.writeFile(path.join(process.env.TASK_OUT!, `own-p960-lateack-${surface}.json`), JSON.stringify({ holds, header: { state: header.state, executionWait: header.executionWait,
      entries: (header.entries ?? []).map((e: any) => e.comment.id) }, ids, sweeps }, null, 2));
    expect(own?.ownerType, "the Stop's OWN board hold is active").toBe("board");
    expect(own?.cause).toBe("native_continuation_requires_reconciliation");
    expect((own?.evidence as any)?.runId, "the hold names the person-stopped run").toBe(turn.turnId);
    expect(header.executionWait, "header: the stopped shape").toEqual(STOPPED_BAR);
    const notes = unansweredNotes(shown);
    const all = JSON.stringify(shown);
    expect(all, "no no_run card").not.toContain(UNANSWERED_MESSAGE_NO_RUN_TEXT);
    expect(all, "never 'assign this agent a new task'").not.toContain("assign this agent a new task");
    expect(notes.length, "one note for the held set").toBe(1);
    expect(notes[0].body, "R3 exactly").toBe(PERSON_STOP_HELD_MESSAGE_TEXT);
    expect(notes[0].presentation?.title).toBe(PERSON_STOP_HELD_MESSAGE_TITLE);
  }, 120_000);
  // H2 (header): an EARLIER turn failed through the executor path with a NAMED injected adapter fault
  // (the mocked executePaperclipNativeSession throws "p960_first_provider_turn_failed"; the real
  // release then writes the PRODUCT hold active_run_watchdog / native_continuation_requires_reconciliation
  // for that run). Then a turn runs (planted running row), the person sends 3 messages through the real
  // comment POST (admission saves an execution_active wait on them: queue.ts deferBlockedExecution),
  // then the REAL Stop of that turn. The header shows the stopped shape (Z's text) at +0. The note keeps
  // the earlier failure's own card: that hold is NOT the Stop's (RFL control, isPersonStopOwnHold).
  // TASK is PLANTED: on a plain task the person's first comment reopens the blocked task to todo
  // (routes/issues.ts:20416-20425) and cancels the earlier hold as stale (:4509-4510, "manually moved
  // from blocked to todo"), so admission finds no blocker and saves NO wait. The task row plants the
  // wait H2 measured on c2b (execution_active, "Waiting for the current run. Your message is saved.")
  // on the held wake; everything else is the real path.
  for (const surface of ["chat", "task"] as const) it(`H2 ${surface}${surface === "task" ? " (planted saved wait)" : ""}: a saved wait from an earlier turn's hold never hides the person's Stop in the header`, async () => {
    fixture.firstFails = true;
    let r: Awaited<ReturnType<typeof exercise>>;
    try { r = await exercise("fails", `h2-${surface}`, { noMessages: true }); } finally { fixture.firstFails = false; }
    if (surface === "chat") {
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
      await db.update(issues).set({ conversationAgentId: r.agentId, conversationUserId: "rf4-person", conversationState: "active" }).where(eq(issues.id, r.issueId));
    }
    const earlier = r.holds.find(h => ["active", "escalated"].includes(h.status));
    const turn = await plantedTurnStop(r);
    const ids = await turn.send(3);
    if (surface === "task") expect((await db.update(agentWakeupRequests).set({ payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{executionWait}',
      ${JSON.stringify({ reason: "execution_active", message: "Waiting for the current run. Your message is saved." })}::jsonb)` })
      .where(and(eq(agentWakeupRequests.agentId, r.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")))
      .returning({ id: agentWakeupRequests.id })).length, "the planted wait landed on the held wake").toBeGreaterThan(0);
    const wakesBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, r.agentId));
    await turn.stop();
    const header = (await request(r.app).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, r.agentId));
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, r.issueId));
    const latest = Math.max(...(await db.select().from(issueComments).where(eq(issueComments.issueId, r.issueId))).filter(c => ids.includes(c.id)).map(m => m.createdAt.getTime()));
    const outcome = await settleUnansweredPersonMessage(db, { companyId: r.companyId, issueId: r.issueId, now: new Date(latest + 5 * 60_000) });
    const notes = unansweredNotes((await request(r.app).get(`/api/issues/${r.issueId}/comments`).expect(200)).body as any[]);
    const savedWaits = wakes.filter(w => ["deferred", "deferred_issue_execution"].includes(w.status) && ids.some(id => JSON.stringify(w.payload).includes(id))).map(w => ({ id: w.id, status: w.status, executionWait: (w.payload as any)?.executionWait ?? null }));
    await fs.writeFile(path.join(process.env.TASK_OUT!, `own-h2-${surface}.json`), JSON.stringify({ earlier, holds, firstRun: r.runId, stoppedTurn: turn.turnId,
      savedWaitsBeforeStop: wakesBefore.map(w => ({ id: w.id, status: w.status, executionWait: (w.payload as any)?.executionWait ?? null })), savedWaits,
      header: { state: header.state, executionWait: header.executionWait, entries: (header.entries ?? []).map((e: any) => e.comment.id) }, ids, outcome,
      notes }, null, 2));
    expect(earlier?.ownerType, "the earlier turn's PRODUCT hold").toBe("board");
    expect(earlier?.cause).toBe("native_continuation_requires_reconciliation");
    expect((earlier?.evidence as any)?.runId, "the hold is the failed earlier turn's").toBe(r.runId);
    const earlierNow = holds.find(h => h.id === earlier!.id);
    expect(earlierNow?.status, surface === "chat" ? "the earlier hold is still open when the messages are sent" : "task: the person's comment cancelled it as stale")
      .toBe(surface === "chat" ? "active" : "cancelled");
    // The saved wait is whatever admission wrote behind the earlier hold (measured: local_cleanup, the
    // earlier turn's environment cleanup); before the reader, ANY saved wait hid the Stop (!queue.executionWait).
    expect(savedWaits.length > 0 && savedWaits.every(w => typeof w.executionWait?.reason === "string" && typeof w.executionWait?.message === "string"),
      "every held message carries a saved wait").toBe(true);
    expect(header.executionWait, "header at +0: the stopped shape (Z's text)").toEqual(STOPPED_BAR);
    expect((header.entries ?? []).map((e: any) => e.comment.id).some((id: string) => ids.includes(id)), "the held messages are listed").toBe(true);
    // RFL control: a person Stop whose run is NOT the hold's run keeps the hold's card.
    if (surface === "chat") {
      expect(JSON.stringify(notes), "the earlier hold keeps its own card").toContain(earlier!.id);
      expect(notes.map(n => n.body)).not.toContain(PERSON_STOP_HELD_MESSAGE_TEXT);
    }
  }, 120_000);
});
