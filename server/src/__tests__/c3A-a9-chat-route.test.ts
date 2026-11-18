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

// adopt-c3-stop-a9 (E): rf-4's fixture (c3A-rf4-c3-person-stop.test.ts) with ONE change:
// the task is a CHAT (conversationAgentId) and every message enters through the
// person's chat POST /api/issues/:id/comments (routes/issues.ts chat branch), not
// heartbeat.wakeup. Stop is the person-Stop route POST /api/heartbeat-runs/:id/cancel.
// rf-4 header follows. Independent reviewer regression: real person HTTP Stop, real DB cancellation,
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
import { instanceSettingsService } from "../services/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
async function waitFor(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error("rf4 wait timed out"); await new Promise(r => setTimeout(r, 25)); }
}
describe.skipIf(!support.supported)("a9 (E) rf-4 Q1/Q2 through the CHAT route", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("a9-c3-chat-"); db = createDb(temp.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "a9-c3-chat-home-")); process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "rf4-person", name: "Person", email: "rf4@example.invalid", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
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
      responsibleUserId: "rf4-person", issueNumber: 1, identifier: `J${companyId.slice(0, 6)}-1`,
      conversationAgentId: agentId, conversationUserId: "rf4-person", conversationState: "active" });
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
    let commentId = "", messageAt = 0, messageResponse: unknown;
    const message = async () => {
      messageAt = Date.now();
      const sent = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Please answer next.", clientRequestId: randomUUID() });
      messageResponse = { status: sent.status, body: sent.body };
      expect(sent.status, JSON.stringify(sent.body)).toBe(201); commentId = sent.body.id;
      return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId), sql`${agentWakeupRequests.payload}->>'commentId' = ${commentId}`));
    };
    fixture.firstRun = runId; fixture.calls = [];
    fixture.onFirst = async () => {
      if (mode === "waiting") waitingWakes = await message();
      const start = Date.now();
      const result = await request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      stopMs = Date.now() - start; stopResponse = { status: result.status, body: result.body };
      expect(result.status).toBe(200); expect(result.body.status).toBe("cancelled");
      await waitFor(async () => ((await heartbeat.getRun(runId))?.resultJson as Record<string, any> | null | undefined)?.nativeCancellation?.dispatchState === "acknowledged");
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
      const evidence = { mode, messageAt, messageResponse, runId, companyId, agentId, issueId, commentId, lease, holds, runs, calls: [...fixture.calls], blocker, projection, interruption,
        stopMs, stopResponse, waitingWakes, stopCalls: stop.mock.calls, observedMs: Date.now() - admittedAt, confirmed: hasConfirmedSandboxStopAndRetain(lease) };
      await fs.writeFile(path.join(process.env.TASK_OUT!, `a9-chat-${label}.json`), JSON.stringify(evidence, null, 2));
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
  it("a9 Q1 CHAT: a message POSTed to the chat before the person's Stop is HELD with Send; Send gives ONE run carrying it", async () => {
    const r = await exercise("waiting", "q1");
    expect(r.messageResponse).toMatchObject({ status: 201 });
    const queue = await heldAfterStop(r);
    const t0 = Date.now();
    const send = await request(r.app).post(`/api/issues/${r.issueId}/queued-comments/interrupt`).send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    expect(send.status, JSON.stringify(send.body)).toBe(200);
    await sweepRuns(r, 20_000, runs => runs.some(run => run.id !== r.runId) && fixture.calls.length > 1);
    const answeredMs = Date.now() - t0;
    const later = await sweepRuns(r, 15_000);
    const successors = later.runs.filter(run => run.id !== r.runId);
    const after = (await request(r.app).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    await fs.writeFile(path.join(process.env.TASK_OUT!, "a9-chat-q1-send.json"), JSON.stringify({ queue, send: { status: send.status, body: send.body }, answeredMs, calls: fixture.calls,
      runs: later.runs.map(run => ({ id: run.id, status: run.status, commentId: run.ctx?.commentId, wakeCommentIds: run.ctx?.wakeCommentIds })), after }, null, 2));
    expect(successors, "ONE run after Send").toHaveLength(1);
    expect(carries(successors[0]!, r.commentId), "it carries the held chat message").toBe(true);
    expect(answeredMs).toBeLessThan(20_000);
    expect(fixture.calls).toEqual([r.runId, successors[0]!.id]);
    expect(after.entries ?? []).toHaveLength(0);
  }, 180_000);
  // Was it.fails until a8's twin admission gate (afabba6e, acknowledged-native-stop.ts)
  // landed in this line: a released LOCAL lease no longer needs a sandbox stop receipt.
  it("a9 Q1 CHAT held list says the true Stop line, never a recovery wait (twin gate: a8)", async () => {
    const r = await exercise("waiting", "q1-line");
    const queue = (await request(r.app).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    await fs.writeFile(path.join(process.env.TASK_OUT!, "a9-chat-q1-line.json"), JSON.stringify(queue, null, 2));
    expect(queue.entries.map((e: any) => e.comment.id)).toEqual([r.commentId]);
    expect(queue.executionWait).toEqual({ reason: "stopped_by_person", message: "Stopped. These messages are waiting: Send them, or delete any first." });
  }, 60_000);
  it("a9 Q2 CHAT: a message POSTed to the chat after a mid-turn person Stop gives ONE run, answered in bound, no workspace_repair_required", async () => {
    const r = await exercise("mid_turn", "q2");
    const later = await sweepRuns(r, 5_000);
    const successors = later.runs.filter(run => run.id !== r.runId);
    const visible = JSON.stringify({ blocker: r.blocker, projection: r.projection, interruption: r.interruption, holds: r.holds, runs: r.runs });
    await fs.writeFile(path.join(process.env.TASK_OUT!, "a9-chat-q2-after.json"), JSON.stringify({ calls: fixture.calls, observedMs: r.observedMs,
      runs: later.runs.map(run => ({ id: run.id, status: run.status, commentId: run.ctx?.commentId, wakeCommentIds: run.ctx?.wakeCommentIds })) }, null, 2));
    expect(r.messageResponse).toMatchObject({ status: 201 });
    expect.soft(r.confirmed).toBe(true);
    expect(successors, "ONE run").toHaveLength(1);
    expect(carries(successors[0]!, r.commentId), "it carries the chat message").toBe(true);
    expect(fixture.calls, "answered").toEqual([r.runId, successors[0]!.id]);
    expect(r.observedMs, "answered in bound").toBeLessThan(10_000);
    expect(visible).not.toMatch(/workspace_repair_required/);
    expect(r.blocker).toBeNull();
    // (F) the stopped run is shown Stopped, not "Recovery needed".
    expect(r.projection?.label).not.toBe("Recovery needed");
  }, 60_000);
});
