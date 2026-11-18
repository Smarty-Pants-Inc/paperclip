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
  closeSession: undefined as undefined | (() => Promise<void>), remoteCleanupScope: "" }));
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
        if (fixture.closeSession) {
          const { executeNativeSession } = await import("../vendor/paperclip-runner/index.js");
          const identity = { ...input.execution.binding, sessionId: `silent-wait-${runId}` };
          const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
          await executeNativeSession({ input: input.execution, runnerInstanceId: randomUUID(), controlPlaneInstanceId: "silent-wait-control",
            remoteCleanupScope: fixture.remoteCleanupScope,
            backend: { descriptor: async () => ({ kind: "runner", name: "silent-wait-provider", version: "1", capabilities, runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }), openSession: async () => ({
              identity: () => identity, capabilities: async () => capabilities,
              async *events() { await fixture.onFirst!(); throw new actual.NativeCancellationPendingRecoveryError(); },
              startTurn: async () => ({ turnId: "silent-wait-turn" }), result: async () => null,
              snapshot: async () => ({ backendKind: "mock", sessionId: identity.sessionId, identity, providerSessionId: "silent-wait-provider",
                cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }), close: () => fixture.closeSession!(),
            }) },
            controlPlane: { openRun: async () => {}, checkpointSession: async () => {},
              appendEvent: async () => ({ cursor: 0, highestContiguousSourceSeq: 0, disposition: "committed" }),
              replayEvents: async () => ({ events: [], highestContiguousSourceSeq: 0 }), completeRun: async () => {} },
          });
        } else await fixture.onFirst();
        throw new actual.NativeCancellationPendingRecoveryError();
      }
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
import { acknowledgedNativeStopExecutionHasStopped } from "../services/acknowledged-native-stop.js";
import { nativeSessionCleanupBlock } from "../vendor/paperclip-runner/index.js";

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
  async function exercise(mode: "waiting" | "mid_turn", label: string, opts: { chat?: boolean;
    silentWait?: "settling" | "pending" | "confirmed" } = {}) {
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
    let commentId = randomUUID();
    const message = async () => {
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
      if (mode === "waiting") waitingWakes = await message();
      const start = Date.now();
      const result = await request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      stopMs = Date.now() - start; stopResponse = { status: result.status, body: result.body };
      expect(result.status).toBe(200); expect(result.body.status).toBe("cancelled");
      await waitFor(async () => ((await heartbeat.getRun(runId))?.resultJson?.nativeCancellation as { dispatchState?: string } | undefined)?.dispatchState === "acknowledged");
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled", leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      if (mode === "mid_turn" && opts.silentWait !== "pending") waitingWakes = await message();
    };
    const provider = getSandboxProvider("fake")!;
    let stop = vi.spyOn(provider, "stopLease");
    const readThread = async () => {
      const response = await request(app).get(`/api/issues/${issueId}/comments`);
      expect(response.status).toBe(200);
      return response.body as Array<Record<string, unknown>>;
    };
    const snapshots: Record<string, Array<Record<string, unknown>>> = {};
    let failStop = opts.silentWait !== "confirmed";
    const realSetTimeout = globalThis.setTimeout;
    // Timing-only injection: spend the real nine-attempt retry budget without
    // waiting six minutes. No gate/attempt counter is assigned by the fixture.
    const retryTimer = opts.silentWait ? vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) =>
      realSetTimeout(callback, delay === 60_000 && new Error().stack?.includes("native-session-runtime") ? 5 : delay, ...args)
    ) as typeof setTimeout) : undefined;
    if (opts.silentWait) {
      // NAMED injection: only the provider stop RPC refuses to confirm. The real
      // Stop route/ack, active executor, close retries, gate and comments are product-written.
      stop.mockRestore();
      const originalStop = getSandboxProvider("fake")!.stopLease.bind(provider);
      stop = vi.spyOn(provider, "stopLease").mockImplementation(async input => {
        if (failStop) throw new Error("SILENT_WAIT_PROVIDER_STOP_NEVER_CONFIRMS");
        return originalStop(input);
      });
      fixture.remoteCleanupScope = JSON.stringify(["fake", providerLeaseId]);
      fixture.closeSession = () => provider.stopLease({ config: { driver: "sandbox", provider: "fake", image: "fixture:test", reuseLease: true }, providerLeaseId }).then(() => undefined);
      const originalOnFirst = fixture.onFirst;
      fixture.onFirst = async () => {
        await originalOnFirst!();
        if (opts.silentWait !== "pending") {
          await heartbeat.resumeQueuedRuns();
          snapshots.settling = await readThread();
          // A second claim is a later dispatch/poll, not a second notification.
          await heartbeat.resumeQueuedRuns();
          snapshots.settlingPoll = await readThread();
        }
      };
    }
    try {
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      if (opts.silentWait) {
        if (opts.silentWait === "pending") waitingWakes = await message();
        await heartbeat.resumeQueuedRuns();
        snapshots.pending = await readThread();
        if (opts.silentWait !== "confirmed") {
          await waitFor(async () => nativeSessionCleanupBlock({ companyId, issueId }) === "operator_required", 20_000);
          await heartbeat.resumeQueuedRuns();
          snapshots.operatorRequired = await readThread();
          await heartbeat.resumeQueuedRuns();
          snapshots.operatorRequiredPoll = await readThread();
        }
        await fs.writeFile(path.join(process.env.TASK_OUT!, `sw-${opts.silentWait}-thread.json`), JSON.stringify({ companyId, issueId, runId, commentId, snapshots }, null, 2));
        // End the injected outage through the real provider/teardown boundary;
        // never clear a cleanup gate or plant a stop receipt in the database.
        failStop = false;
        const stopped = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId, agentId, status: stopped[0]!.status, providerResourceDisposition: "stop_and_retain" });
        await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
        await heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId, agentId, status: stopped[0]!.status, providerResourceDisposition: "stop_and_retain" });
      }
      const admittedAt = Date.now();
      do { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); if (fixture.calls.length > 1) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() - admittedAt < 10_000);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const allLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
      const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), sql`(${heartbeatRuns.contextSnapshot}->>'commentId' = ${commentId} or ${heartbeatRuns.contextSnapshot}->'wakeCommentIds' ? ${commentId})`));
      const blocker = await getExecutionBlocker(db, companyId, issueId);
      const projection = (await executionProjectionsForRuns(db, companyId, [runId])).get(runId);
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      const interruption = await taskInterruptionPresentation(db, task);
      const evidence = { mode, opts, runId, companyId, agentId, issueId, commentId, lease, allLeases, holds, runs, calls: [...fixture.calls], blocker, projection, interruption,
        stopMs, stopResponse, waitingWakes, stopCalls: stop.mock.calls, observedMs: Date.now() - admittedAt, confirmed: hasConfirmedSandboxStopAndRetain(lease) };
      await fs.writeFile(path.join(process.env.TASK_OUT!, `own-${label}.json`), JSON.stringify(evidence, null, 2));
      return { ...evidence, app, heartbeat, snapshots };
    } finally { fixture.onFirst = undefined; await heartbeat.drainActiveRunExecutions(); retryTimer?.mockRestore(); stop.mockRestore(); fixture.closeSession = undefined; }
  }
  const waitLine = "The previous session is still shutting down. Your work is saved, and Paperclip finishes the cleanup automatically. This turn starts when the old Runner is confirmed stopped. Paperclip is stopping it and keeps its files.";
  const operatorLine = "This message hasn't started: Paperclip couldn't confirm the previous session stopped, and has stopped trying. Your message is saved; tell us and we'll start it.";
  const bodies = (comments: Array<Record<string, unknown>>) => comments.map(comment => comment.body);
  it("SW R1/R2: real Stop + ack, settling wait at once, then exhausted stop has its own line once", async () => {
    const r = await exercise("mid_turn", "sw-settling", { chat: true, silentWait: "settling" });
    expect.soft(bodies(r.snapshots.settling).filter(body => body === waitLine), "R1 immediate wait line").toHaveLength(1);
    expect.soft(bodies(r.snapshots.settlingPoll).filter(body => body === waitLine), "R1 dedupe on later polls").toHaveLength(1);
    expect.soft(bodies(r.snapshots.operatorRequired).filter(body => body === operatorLine), "R2 exhausted line").toHaveLength(1);
    expect.soft(bodies(r.snapshots.operatorRequiredPoll).filter(body => body === operatorLine), "R2 dedupe on later polls").toHaveLength(1);
    expect(r.snapshots.settling.some(comment => comment.id === r.commentId && comment.body === "Please answer next."), "typed message saved").toBe(true);
    expect(r.runs, "one successor after a confirmed provider stop").toHaveLength(1);
    expect(r.calls).toEqual([r.runId, r.runs[0]!.id]);
  }, 60_000);
  it("SW R3: pending cleanup keeps the existing wait line once", async () => {
    const r = await exercise("mid_turn", "sw-pending", { chat: true, silentWait: "pending" });
    expect(bodies(r.snapshots.pending).filter(body => body === waitLine)).toHaveLength(1);
  }, 60_000);
  it("SW R4: confirmed stop runs the saved message once with no exhausted line", async () => {
    const r = await exercise("mid_turn", "sw-confirmed", { chat: true, silentWait: "confirmed" });
    expect(r.confirmed).toBe(true);
    expect(r.runs).toHaveLength(1);
    expect(r.calls).toEqual([r.runId, r.runs[0]!.id]);
    expect(bodies(r.snapshots.pending).filter(body => body === operatorLine)).toHaveLength(0);
    expect(bodies(r.snapshots.pending).filter(body => body === waitLine).length).toBeLessThanOrEqual(1);
  }, 60_000);
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
});
