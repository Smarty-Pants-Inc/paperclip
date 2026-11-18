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
const fixture = vi.hoisted(() => ({ calls: [] as string[], firstRun: "", onFirst: undefined as undefined | (() => Promise<void>), successorThrows: false }));
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
      if (runId === fixture.firstRun && fixture.onFirst) { await fixture.onFirst(); throw new actual.NativeCancellationPendingRecoveryError(); }
      if (fixture.successorThrows) throw new Error("rf4_successor_provider_turn_reached");
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
  async function exercise(mode: "waiting" | "mid_turn", label: string) {
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
      const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, provider: "fake", providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
        metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", reuseLease: true, reusableSandboxLease: true, remoteCwd, agentId } }).returning(); leaseId = lease.id;
      const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd, resourceDisposition: "keep_running" };
      await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativePhase: "observed", runnerProfileJson: { nativeWorkspaceSync: reference, nativeResourceDisposition: "keep_running" } }).where(eq(heartbeatRuns.id, runId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: -1, eventType: "tool.execution.started", stream: "system" });
    } });
    const commentId = randomUUID();
    const message = async () => {
      await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "rf4-person", body: "Please answer next." });
      return heartbeat.wakeup(agentId, { source: "automation", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "rf4-person",
        payload: { issueId, commentId }, contextSnapshot: { issueId, commentId, wakeReason: "issue_commented" } });
    };
    fixture.firstRun = runId; fixture.calls = [];
    fixture.onFirst = async () => {
      if (mode === "waiting") waitingWakes = await message();
      const start = Date.now();
      const result = await request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      stopMs = Date.now() - start; stopResponse = { status: result.status, body: result.body };
      expect(result.status).toBe(200); expect(result.body.status).toBe("cancelled");
      await waitFor(async () => (await heartbeat.getRun(runId))?.resultJson?.nativeCancellation?.dispatchState === "acknowledged");
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled", leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      if (mode === "mid_turn") waitingWakes = await message();
    };
    const provider = getSandboxProvider("fake")!, stop = vi.spyOn(provider, "stopLease");
    try {
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      const admittedAt = Date.now();
      do { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); if (fixture.calls.length > 1) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() - admittedAt < 10_000);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'commentId' = ${commentId}`));
      const blocker = await getExecutionBlocker(db, companyId, issueId);
      const projection = (await executionProjectionsForRuns(db, companyId, [runId])).get(runId);
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      const interruption = await taskInterruptionPresentation(db, task);
      const evidence = { mode, runId, companyId, agentId, issueId, commentId, lease, holds, runs, calls: [...fixture.calls], blocker, projection, interruption,
        stopMs, stopResponse, waitingWakes, stopCalls: stop.mock.calls, observedMs: Date.now() - admittedAt, confirmed: hasConfirmedSandboxStopAndRetain(lease) };
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
  it("Q5 after receipt the screen has no stale stopping text and exactly one truthful retained-work note", async () => {
    const r = await exercise("mid_turn", "q5");
    const visible = JSON.stringify({ blocker: r.blocker, projection: r.projection, interruption: r.interruption, activeActions: r.holds.filter(h => ["active", "escalated"].includes(h.status)) });
    expect.soft(r.confirmed).toBe(true);
    expect.soft(visible).not.toMatch(/Stop pending|will start automatically|Waiting for execution and required resources to stop\./);
    const notes = r.holds.filter(h => /stopp|recover|sandbox|saved/i.test(h.nextAction));
    expect.soft(notes, "one truthful note, not a fabricated active recovery promise").toHaveLength(1);
    expect.soft(visible).not.toMatch(/refused to recover|Create a new task|Recovering your saved work/);
  }, 60_000);
  it("Q5 control (RFL): a THROWING successor provider still gets its own true failure note, separate from the Stop note", async () => {
    fixture.successorThrows = true;
    try {
      const r = await exercise("mid_turn", "q5-control");
      const failure = r.holds.filter(h => h.evidence?.runId !== r.runId && ["active", "escalated"].includes(h.status));
      const stopNotes = r.holds.filter(h => h.evidence?.runId === r.runId && /unsaved changes stay on the previous sandbox/.test(h.nextAction ?? ""));
      await fs.writeFile(path.join(process.env.TASK_OUT!, "own-q5-control-holds.json"), JSON.stringify({ holds: r.holds, blocker: r.blocker }, null, 2));
      expect(r.calls.length, "the provider was reached").toBe(2);
      expect(failure, "the successor's real failure has its own note").toHaveLength(1);
      expect(failure[0]!.nextAction).not.toMatch(/unsaved changes stay on the previous sandbox/);
      expect(r.blocker?.runId, "the blocker names the failed successor, not the stopped run").toBe(r.runs[0]?.id);
      expect(stopNotes, "the Stop note is still there once").toHaveLength(1);
    } finally { fixture.successorThrows = false; }
  }, 60_000);
});
