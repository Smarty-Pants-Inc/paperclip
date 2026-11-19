import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, issueTreeHolds, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
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
import { readPersonStopHold } from "../services/acknowledged-native-stop.js";
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_NO_RUN_TEXT } from "../services/recovery/unanswered-person-message.js";
import { writeDeferredExecutionWait } from "../services/deferred-execution-wait.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-stop-hold4: after a person's Stop, the messages held behind the stopped
// turn WAIT until that person presses Send or types the next message. Nothing
// promotes them on the stopped run's own release (the deferred-wake drain,
// wake-queue use-cases runReleaseDrain), on a later run's release, on a Resume,
// or through a tree pause/release.
// Harness: the optS-dd F3/settling harness. Real chat route (POST
// /api/issues/:id/comments on a conversation task), real person Stop route
// (POST /api/heartbeat-runs/:runId/cancel), real Send / Delete routes
// (queued-comments), real tree-hold routes, real heartbeat admission ->
// claim -> executor dispatch and the real release drain. Faked edges only: the
// provider turn (first turn: busy until the Stop, then the executor's
// settle-then-throw after an acknowledged Stop; every later turn records the
// comment ids it was given and answers once) and the provider ACK of the Stop.
const fixture = vi.hoisted(() => ({
  calls: [] as { runId: string; ids: string[]; reason: string | null; ordered?: string[] }[],
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
  /** Every later turn, while its run is running (before it answers). */
  onTurn: undefined as undefined | ((input: { runId: string; ids: string[] }) => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));

vi.mock("../services/heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/runtime-selection.js")>();
  return {
    ...actual,
    // The admitted value a warm (keep_running) remote box selects, as tB2's Boat turns.
    prepareAndSelectHeartbeatRuntime: (async (db, input, deps) => actual.prepareAndSelectHeartbeatRuntime(db, {
      ...input,
      onProviderResourceDisposition: disposition => input.onProviderResourceDisposition("keep_running"),
    }, deps)) as typeof actual.prepareAndSelectHeartbeatRuntime,
  };
});

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
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
      const { heartbeatRuns, issueComments } = await import("@paperclipai/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await (fixture.db as any).select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const ctx = (row?.contextSnapshot ?? {}) as Record<string, any>;
      const ids = [...new Set([ctx.commentId, ctx.wakeCommentId, ...(ctx.wakeCommentIds ?? [])].filter(Boolean))] as string[];
      // The run's input in its own order (agent-conversations' Stop row reads it this way).
      const ordered = (Array.isArray(ctx.wakeCommentIds) ? ctx.wakeCommentIds.map(String)
        : typeof ctx.wakeCommentId === "string" ? [ctx.wakeCommentId] : []) as string[];
      if (fixture.calls.length === 0 && fixture.onFirst) {
        fixture.calls.push({ runId, ids, reason: ctx.wakeReason ?? null, ordered });
        await fixture.onFirst({ runId });
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      fixture.calls.push({ runId, ids, reason: ctx.wakeReason ?? null, ordered });
      await fixture.onTurn?.({ runId, ids });
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import * as environmentOrchestrator from "../services/environment-run-orchestrator.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const TEN_MIN = 10 * 60_000;

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!support.supported)("a person's Stop holds the messages behind it until that person's Send or next message", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "hold-person";
  const otherUserId = "hold-other-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("stop-hold-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "stop-hold-home-"));
    process.env.PAPERCLIP_HOME = home;
    for (const [id, email] of [[userId, "hold@example.invalid"], [otherUserId, "other@example.invalid"]]) {
      await db.insert(authUsers).values({ id, name: id, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    }
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    restoreRelease?.();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    const writable = async (dir: string): Promise<void> => { const st = await fs.lstat(dir).catch(() => null); if (!st?.isDirectory() || st.isSymbolicLink()) return; await fs.chmod(dir, 0o700); for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }).catch(() => undefined); }
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.STOPHOLD_EVIDENCE) await fs.appendFile(process.env.STOPHOLD_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  type Options = {
    /** Who presses Stop (R9: a different person). */
    stopper?: string;
    /** "interrupt": the queued-message Interrupt, not a person's Stop (R5).
     * "unaccepted": the person's cancel that the Stop route did NOT accept: the
     * run ends cancelled with that person's attribution (heartbeat.cancelRun,
     * S's R10 control), but there is no run.stop.accepted person_stop row (rf-2 c). */
    stopKind?: "person" | "interrupt" | "unaccepted" | "treePause";
    /** How many messages wait behind the running turn (default 3: H1-H3). */
    heldCount?: number;
    /** Runs while the turn is still running, after the messages are saved and before the Stop/Pause. */
    beforeStop?: (ctx: Ctx, held: string[], runId: string) => Promise<void>;
    /** Boat's stop stays hung: its stop receipt never comes during the wait. */
    hung?: boolean;
    /** A TASK page (no Agent Chat): the same Stop over a task's assignee turn. */
    task?: boolean;
  };
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function setup(setupOptions: { task?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Hold", issuePrefix, defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false });
    for (const principalId of [userId, otherUserId]) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId,
        membershipRole: "owner", status: "active" });
    }
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, ...(setupOptions.task ? {} : { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" }),
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    fixture.calls = [];
    const clientFor = (actorUserId: string, isInstanceAdmin = false) => {
      const client = express();
      client.use(express.json());
      client.use((req, _res, next) => {
        (req as any).actor = { type: "board", source: "session", userId: actorUserId, companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin };
        next();
      });
      client.use("/api", issueRoutes(db, {} as any, {}));
      client.use("/api", agentRoutes(db, {}));
      client.use("/api", issueTreeControlRoutes(db));
      client.use(errorHandler);
      return client;
    };
    const client = clientFor(userId);
    const otherClient = clientFor(otherUserId);
    const adminClient = clientFor(userId, true);
    // The remote box (c3-optS-send-after-stop harness): a daytona sandbox lease kept warm; its release hands it
    // back retained with no stop receipt. Faked edge: the orchestrator's lease release only.
    const firstRun = { id: "" };
    const heartbeat = heartbeatService(db, {
      nativeSessionBackendFactory: () => ({}) as never,
      beforeNativeRuntimeSelection: async runId => {
        if (firstRun.id && runId !== firstRun.id) return;
        firstRun.id = runId;
        const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
          provider: "daytona", providerLeaseId: randomUUID(), status: "active", leasePolicy: "reuse_by_environment",
          metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
        }).returning();
        const reference = { schema: "paperclip.native-workspace-sync/v3" as const, state: "prepared" as const,
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
          workspaceId: randomUUID(), leaseId: lease!.id, providerLeaseId: lease!.providerLeaseId!, remoteCwd: "/work",
          resourceDisposition: "keep_running" as const };
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativePhase: "observed",
          runnerProfileJson: { nativeWorkspaceSync: reference, nativeResourceDisposition: "keep_running" },
        }).where(eq(heartbeatRuns.id, runId));
        await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      },
    });
    const post = (body: string, as = client) => request(as).post(`/api/issues/${issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    const drive = async (ms = 3_000) => {
      const t0 = Date.now();
      do {
        await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
        await new Promise(r => setTimeout(r, 100));
      } while (Date.now() - t0 < ms);
    };
    const wakes = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .map(w => ({ id: w.id, status: w.status, reason: w.reason, runId: w.runId, error: w.error,
        wait: (w.payload as any)?.executionWait?.reason ?? null, src: `${w.source}/${w.triggerDetail}`,
        ids: ((w.payload as any)?._paperclipWakeContext?.wakeCommentIds ?? (w.payload as any)?.queuedCommentIds ?? null) as string[] | null }));
    const queue = async () => request(client).get(`/api/issues/${issueId}/queued-comments`).expect(200).then(r => r.body);
    /** "Nobody touches anything for 10 minutes": every recorded time moves 10 minutes into the past, then the real scheduler runs. */
    const tenMinutesPass = async () => {
      const back = sql`interval '10 minutes'`;
      await db.update(agentWakeupRequests).set({ requestedAt: sql`${agentWakeupRequests.requestedAt} - ${back}`,
        updatedAt: sql`${agentWakeupRequests.updatedAt} - ${back}` }).where(eq(agentWakeupRequests.companyId, companyId));
      await db.update(heartbeatRuns).set({ createdAt: sql`${heartbeatRuns.createdAt} - ${back}`,
        updatedAt: sql`${heartbeatRuns.updatedAt} - ${back}`,
        finishedAt: sql`${heartbeatRuns.finishedAt} - ${back}` }).where(eq(heartbeatRuns.companyId, companyId));
      await db.update(issueComments).set({ createdAt: sql`${issueComments.createdAt} - ${back}` })
        .where(eq(issueComments.companyId, companyId));
      // The real periodic workers that reconsider saved messages (index.ts / workspace recovery work).
      await heartbeat.resumeExecutionWaitComments({ companyId });
      const [latest] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))
        .orderBy(sql`${heartbeatRuns.createdAt} desc`).limit(1);
      if (latest) await heartbeat.resumeRemoteStopComments(latest as any);
      await drive(3_000);
    };
    /** Boat's stop answers: the warm box's lease is released with the provider's bound stop receipt. */
    const boatStopAnswers = async () => {
      for (const lease of await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId))) {
        const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" });
        await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
          metadata: { ...(lease.metadata ?? {}), remoteExecutionTermination: receipt } }).where(eq(environmentLeases.id, lease.id));
      }
    };
    return { companyId, agentId, issueId, client, otherClient, adminClient, heartbeat, post, drive, wakes, queue, tenMinutesPass, boatStopAnswers };
  }

  /** M0 runs; H1-H3 arrive while it works (held behind it); the Stop lands; then the stopped turn settles. */
  let restoreRelease: (() => void) | undefined;
  async function stopWithHeld(options: Options = {}) {
    restoreRelease?.();
    const originalFactory = environmentOrchestrator.environmentRunOrchestrator;
    const release = vi.fn(async (input: { heartbeatRunId: string; providerResourceDisposition?: string }) => {
      await db.update(environmentLeases).set({ status: "retained", cleanupStatus: "success" })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active")));
      return { released: [], errors: [] };
    });
    const spy = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...originalFactory(...args), releaseForRun: release,
    }));
    restoreRelease = () => spy.mockRestore();
    const ctx = await setup({ task: options.task });
    const held: string[] = [];
    let firstRunId = "";
    let stopping: Promise<{ status: number; body: unknown }> | undefined;
    fixture.onFirst = async ({ runId }) => {
      firstRunId = runId;
      for (const body of ["H1 held", "H2 held", "H3 held", "H4 held"].slice(0, options.heldCount ?? 3)) held.push((await ctx.post(body).expect(201)).body.id);
      await options.beforeStop?.(ctx, held, runId);
      if (options.stopKind === "interrupt") {
        const q = await ctx.queue();
        stopping = request(ctx.client).post(`/api/issues/${ctx.issueId}/queued-comments/interrupt`)
          .send({ queueId: q.queueId ?? q.id, targetRunId: runId, revision: q.revision }).then(r => r);
      } else if (options.stopKind === "unaccepted") {
        stopping = ctx.heartbeat.cancelRun(runId, "Cancelled by a board operator", {
          resultJson: { cancelledByActorType: "user", cancelledByUserId: userId } } as any)
          .then(body => ({ status: 200, body }));
      } else if (options.stopKind === "treePause") {
        // The person's REAL tree Pause (POST /api/issues/:id/tree-holds {mode:"pause"}): it interrupts the
        // running turn (heartbeat.cancelRun) and runs cancelUnclaimedWakeupsForTree. No Stop route.
        stopping = request(ctx.client).post(`/api/issues/${ctx.issueId}/tree-holds`).send({ mode: "pause", reason: "tree pause" })
          .then(r => ({ status: r.status < 300 ? 200 : r.status, body: r.body }));
      } else {
        const as = options.stopper === otherUserId ? ctx.otherClient : ctx.client;
        stopping = request(as).post(`/api/heartbeat-runs/${runId}/cancel`).send({}).then(r => r);
      }
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        return value?.dispatchState === "acknowledged" && row?.status === "cancelled" && !!row?.finishedAt;
      });
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled",
        leaseOwner: null }).where(eq(nativeRunFinalizations.runId, runId));
    };
    if (options.task) await ctx.post("M0 start").expect(201);
    else {
      await issueService(db).addComment(ctx.issueId, "M0 start", { userId }, { clientRequestId: randomUUID() });
      await deliverConversationComments(db, { id: ctx.issueId, companyId: ctx.companyId, conversationAgentId: ctx.agentId },
        ctx.heartbeat.wakeup);
    }
    await ctx.heartbeat.resumeQueuedRuns();
    const draining = ctx.heartbeat.drainActiveRunExecutions();
    await draining;
    fixture.onFirst = undefined;

    const stopped = await stopping;
    expect(stopped?.status, `stop route: ${JSON.stringify(stopped?.body)}`).toBe(200);
    expect(firstRunId, "first turn reached the provider").not.toBe("");
    const accepted = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, firstRunId),
      eq(heartbeatRunEvents.message, "run.stop.accepted")));
    expect(accepted.map(row => (row.payload as any)?.kind), "the Stop route wrote its acceptance row")
      .toEqual(options.stopKind === "unaccepted" || options.stopKind === "treePause" ? []
        : [options.stopKind === "interrupt" ? "interrupt" : "person_stop"]);
    return { ...ctx, held, firstRunId, stopBody: stopped?.body as any };
  }

  const successorCalls = () => fixture.calls.slice(1);
  const answeredIds = () => successorCalls().flatMap(call => call.ids);
  const heldWakes = async (ctx: { wakes: Ctx["wakes"] }, held: string[]) =>
    (await ctx.wakes()).filter(w => w.status === "deferred_issue_execution" && (w.ids ?? []).some(id => held.includes(id)));

  it("R1 (Boat's stop completes): 10 minutes untouched after the release, nothing runs; the held wake and the bar's queue stay", async () => {
    const r = await stopWithHeld();
    await r.drive(1_000);
    // Boat's stop completes about two minutes later: its stop receipt lands; the real workers run.
    await r.boatStopAnswers();
    await r.tenMinutesPass();
    const wakes = await r.wakes();
    const q = await r.queue();
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, r.companyId));
    const rawWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, r.companyId));
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, r.companyId));
    const [run1] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.firstRunId));
    const [fin] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, r.firstRunId));
    await evidence("R1-complete-debug", { actions: actions.map(a => ({ cause: a.cause, status: a.status, evidence: a.evidence })),
      waits: rawWakes.map(w => (w.payload as any)?.executionWait), leases: leases.map(l => ({ status: l.status, cleanup: l.cleanupStatus, rel: l.releasedAt })),
      run1: { status: run1?.status, code: run1?.errorCode, nc: (run1?.resultJson as any)?.nativeCancellation, ec: (run1?.resultJson as any)?.executionCancellation }, fin });
    await evidence("R1-complete", { calls: fixture.calls, wakes, queue: q });
    expect(successorCalls(), `runs started by themselves: ${JSON.stringify(wakes)}`).toEqual([]);
    expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId }), "the person's Stop holds")
      .toMatchObject({ stoppedRunId: r.firstRunId, userId });
    expect((await heldWakes(r, r.held)).length, JSON.stringify(wakes)).toBeGreaterThan(0);
    const queuedIds = (q.entries ?? []).map((entry: any) => entry.comment?.id);
    for (const id of r.held) expect(queuedIds, JSON.stringify(q)).toContain(id);
  }, 120_000);

  /** The real wake-queue release (the promotion heartbeat's finally / lease release drives) for one run. */
  const realRelease = (runId: string, companyId: string, extra: { resumeStrandedQueue?: boolean } = {}) => createReleaseIssueExecution({
    issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    } as never),
    recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } as never,
  })({ companyId, runId, now: new Date(), ...extra });

  /** The live tB2 order (stack-lead 03:52Z): the stopped run's release fires while Boat's answer to the Stop has
   * not been recorded yet, so the release's stop-acknowledged pre-drain does not stand it down. */
  const releaseNotYetAcknowledged = async (r: { firstRunId: string; companyId: string }, extra: { resumeStrandedQueue?: boolean } = {}) => {
    await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(jsonb_set(${heartbeatRuns.resultJson},
      '{nativeCancellation,dispatchState}', '"pending"'::jsonb), '{executionCancellation,state}', '"requested"'::jsonb)` })
      .where(eq(heartbeatRuns.id, r.firstRunId));
    return realRelease(r.firstRunId, r.companyId, extra);
  };

  for (const resume of [false, true]) {
    it(`R1/R6 at the promotion gate (${resume ? "a Resume's stranded-queue promotion" : "the stopped run's own release"}): the deferred-wake drain does not promote the held wake`, async () => {
      const r = await stopWithHeld();
      await r.drive(1_000);
      const before = (await heldWakes(r, r.held)).map(w => w.id);
      expect(before.length).toBeGreaterThan(0);
      const result = await releaseNotYetAcknowledged(r, resume ? { resumeStrandedQueue: true } : {});
      await r.drive(2_000);
      await evidence(`R1-gate-${resume ? "resume" : "release"}`, { outcome: result.outcome.kind, calls: fixture.calls, wakes: await r.wakes() });
      expect(result.outcome.kind, JSON.stringify(await r.wakes())).not.toBe("promoted");
      expect(successorCalls()).toEqual([]);
      const after = await r.wakes();
      for (const id of before) expect(after.find(w => w.id === id)?.status).toBe("deferred_issue_execution");
    }, 120_000);
  }

  for (const proven of [false, true]) {
    it(`G746: the saved-message worker resumeRemoteStopComments (Stop ${proven ? "proven" : "not yet proven"}) does not send the held messages`, async () => {
      const r = await stopWithHeld();
      await r.drive(1_000);
      const before = (await heldWakes(r, r.held)).map(w => w.id);
      expect(before.length).toBeGreaterThan(0);
      if (!proven) await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(jsonb_set(${heartbeatRuns.resultJson},
        '{nativeCancellation,dispatchState}', '"pending"'::jsonb), '{executionCancellation,state}', '"requested"'::jsonb)` })
        .where(eq(heartbeatRuns.id, r.firstRunId));
      const [run1] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.firstRunId));
      for (const id of before) await r.heartbeat.resumeRemoteStopComments(run1 as any, id);
      await r.heartbeat.resumeRemoteStopComments(run1 as any);
      await r.drive(2_000);
      await evidence(`G746-${proven ? "proven" : "unproven"}`, { calls: fixture.calls, wakes: await r.wakes() });
      expect(successorCalls(), JSON.stringify(await r.wakes())).toEqual([]);
      const after = await r.wakes();
      for (const id of before) expect(after.find(w => w.id === id)?.status, JSON.stringify(after)).toBe("deferred_issue_execution");
    }, 120_000);
  }

  it("R1 (Boat's stop hung): its stop receipt never comes; 10 minutes untouched, nothing runs", async () => {
    const r = await stopWithHeld({ hung: true });
    await r.drive(2_000);
    await r.tenMinutesPass();
    await evidence("R1-hung", { calls: fixture.calls, wakes: await r.wakes() });
    expect(successorCalls(), JSON.stringify(await r.wakes())).toEqual([]);
    expect((await heldWakes(r, r.held)).length).toBeGreaterThan(0);
  }, 120_000);

  it("R4: a typed message after the Stop runs FIRST, then the held ones, each once (row 6)", async () => {
    const r = await stopWithHeld();
    await r.tenMinutesPass();
    const typed = (await r.post("M4 typed").expect(201)).body.id as string;
    await r.drive(4_000);
    await evidence("R4", { typed, calls: fixture.calls, wakes: await r.wakes() });
    expect(successorCalls()[0]?.ids, JSON.stringify(fixture.calls)).toEqual([typed]);
    const answered = answeredIds();
    for (const id of [typed, ...r.held]) expect(answered.filter(a => a === id).length, JSON.stringify(fixture.calls)).toBe(1);
    // The held ones follow the typed one in ONE turn (the drain at the typed turn's release).
    expect(successorCalls().length, JSON.stringify(fixture.calls)).toBe(2);
  }, 120_000);

  for (const task of [false, true]) {
    it(`R4b (${task ? "task page" : "chat"}): a message T typed after the person's Stop is answered FIRST with ONLY T as its input; the held ones then run ONCE in their own turn; nothing is carried twice`, async () => {
      const r = await stopWithHeld({ task });
      await r.tenMinutesPass();
      expect(successorCalls(), "nothing ran by itself before T").toEqual([]);
      const typed = (await r.post("T typed").expect(201)).body.id as string;
      await r.drive(4_000);
      await r.tenMinutesPass();
      await evidence(`R4b-${task ? "task" : "chat"}`, { typed, held: r.held, calls: fixture.calls, wakes: await r.wakes() });
      // T's run input carries ONLY T (never the held ones): it is answered first.
      expect(successorCalls()[0]?.ids, JSON.stringify(fixture.calls)).toEqual([typed]);
      // The held ones run in their own turn, carrying only the held ones.
      expect(successorCalls()[1]?.ids?.slice().sort(), JSON.stringify(fixture.calls)).toEqual(r.held.slice().sort());
      // Each message is carried exactly once across every run (no 'already answered' turn).
      const answered = answeredIds();
      for (const id of [typed, ...r.held]) expect(answered.filter(a => a === id).length, JSON.stringify(fixture.calls)).toBe(1);
      expect(successorCalls().length, JSON.stringify(fixture.calls)).toBe(2);
    }, 120_000);
  }

  // 2c' (rf-2 keyed re-run on compose2): T, typed by the stopping person, ends the hold; during T's run the
  // held messages' queue line said the STORED 'Waiting for execution recovery' though nothing failed.
  const AFTER_TYPED = { reason: "after_typed_message", message: "These go right after your new message." };
  it("2c' R: Stop -> 3 held -> the person types T: during T's run the held messages' queue line (the real GET) says they go right after it, never 'execution recovery'; then each held one is answered once, after T", async () => {
    const r = await stopWithHeld();
    await r.tenMinutesPass();
    expect(successorCalls(), "nothing ran by itself before T").toEqual([]);
    const storedBefore = (await r.wakes()).filter(w => (w.ids ?? []).some(id => r.held.includes(id))).map(w => w.wait);
    let typed = "";
    const during: { runId: string; ids: string[]; queue: any; running: string[] }[] = [];
    fixture.onTurn = async ({ runId, ids }) => {
      const running = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, r.companyId), eq(heartbeatRuns.status, "running")))).map(run => run.id);
      during.push({ runId, ids, queue: await r.queue(), running });
    };
    try {
      typed = (await r.post("T typed").expect(201)).body.id as string;
      await r.drive(4_000);
      await r.tenMinutesPass();
    } finally { fixture.onTurn = undefined; }
    await evidence("2c-typed-line", { typed, held: r.held, storedBefore, during, calls: fixture.calls, wakes: await r.wakes() });
    const tRun = during.find(turn => turn.ids.includes(typed));
    expect(tRun, JSON.stringify(fixture.calls)).toBeTruthy();
    expect(tRun!.running, "the GET was read during T's run").toContain(tRun!.runId);
    expect(tRun!.queue.entries.map((entry: any) => entry.comment.id).sort(), JSON.stringify(tRun!.queue)).toEqual(r.held.slice().sort());
    expect(tRun!.queue.executionWait, JSON.stringify(tRun!.queue)).toEqual(AFTER_TYPED);
    expect(JSON.stringify(tRun!.queue)).not.toContain("execution recovery");
    // Then the held ones: answered once each, after T.
    expect(successorCalls()[0]?.ids, JSON.stringify(fixture.calls)).toEqual([typed]);
    const answered = answeredIds();
    for (const id of [typed, ...r.held]) expect(answered.filter(a => a === id).length, JSON.stringify(fixture.calls)).toBe(1);
    for (const id of r.held) expect(answered.indexOf(id), JSON.stringify(fixture.calls)).toBeGreaterThan(answered.indexOf(typed));
  }, 120_000);

  it("2c' control: another person's message after my Stop does not change my held line (still the Stop's line, never 'go right after')", async () => {
    const r = await stopWithHeld();
    await r.drive(1_000);
    const before = (await r.queue()).executionWait;
    const theirs = await r.post("N other person", r.otherClient);
    await r.drive(1_000);
    const after = await r.queue();
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId, reportEndedByTypedMessage: true });
    await evidence("2c-other-person", { theirs: { status: theirs.status, body: theirs.body }, before, after: after.executionWait, hold, wakes: await r.wakes() });
    expect(before?.reason, JSON.stringify(before)).toBe("stopped_by_person");
    expect(after.executionWait, JSON.stringify(after)).toEqual(before);
    expect(hold?.endedByTypedCommentId, JSON.stringify(hold)).toBeUndefined();
    for (const id of r.held) expect(answeredIds(), JSON.stringify(fixture.calls)).not.toContain(id);
  }, 120_000);

  it("R5: an Interrupt (not a person's Stop) is no hold: the hold reader does not hold them", async () => {
    const r = await stopWithHeld({ stopKind: "interrupt" });
    await r.drive(1_000);
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId });
    await evidence("R5", { hold, calls: fixture.calls, wakes: await r.wakes() });
    expect(hold, "an Interrupt's acceptance row (kind interrupt) is not a hold").toBeNull();
  }, 120_000);

  it("R6: agent Pause + Resume after the Stop: the held still wait (the Resume's promotion respects the hold)", async () => {
    const r = await stopWithHeld();
    await r.drive(1_000);
    const paused = await request(r.adminClient).post(`/api/agents/${r.agentId}/pause`).send({});
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    await r.drive(1_000);
    const resumed = await request(r.adminClient).post(`/api/agents/${r.agentId}/resume`).send({});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await r.tenMinutesPass();
    await evidence("R6-agent", { calls: fixture.calls, wakes: await r.wakes() });
    expect(successorCalls()).toEqual([]);
    expect((await heldWakes(r, r.held)).length).toBeGreaterThan(0);
  }, 120_000);

  it("R6/R6b: the real tree pause skips the held wakes (not cancelled); after its real release they show as held and run only on that person's next message, once each", async () => {
    const r = await stopWithHeld();
    await r.drive(1_000);
    const before = (await heldWakes(r, r.held)).map(w => w.id);
    expect(before.length).toBeGreaterThan(0);
    const hold = await request(r.client).post(`/api/issues/${r.issueId}/tree-holds`).send({ mode: "pause", reason: "pause" });
    expect(hold.status, JSON.stringify(hold.body)).toBeLessThan(300);
    await r.drive(1_000);
    const duringPause = await r.wakes();
    for (const id of before) expect(duringPause.find(w => w.id === id)?.status, JSON.stringify(duringPause)).toBe("deferred_issue_execution");
    const holdId = hold.body.hold?.id ?? hold.body.id;
    const released = await request(r.client).post(`/api/issues/${r.issueId}/tree-holds/${holdId}/release`).send({ reason: "release" });
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    await r.tenMinutesPass();
    expect(successorCalls(), JSON.stringify(await r.wakes())).toEqual([]);
    const q = await r.queue();
    const queuedIds = (q.entries ?? []).map((entry: any) => entry.comment?.id);
    for (const id of r.held) expect(queuedIds, JSON.stringify(q)).toContain(id);
    // Released by that person's next typed message: it runs first, then the held ones (row 6).
    const typed = (await r.post("M4 typed").expect(201)).body.id as string;
    await r.drive(4_000);
    expect(successorCalls()[0]?.ids, JSON.stringify(fixture.calls)).toEqual([typed]);
    await evidence("R6b", { duringPause, calls: fixture.calls, wakes: await r.wakes() });
    const answered = answeredIds();
    for (const id of r.held) expect(answered.filter(a => a === id).length, JSON.stringify(fixture.calls)).toBe(1);
  }, 120_000);

  it("R7: a non-person wake on the same task still runs, and its input does not carry the held messages", async () => {
    const r = await stopWithHeld();
    await r.drive(1_000);
    const woke = await r.heartbeat.wakeup(r.agentId, {
      source: "automation", triggerDetail: "system", reason: "heartbeat_timer",
      payload: { issueId: r.issueId }, contextSnapshot: { issueId: r.issueId, wakeReason: "heartbeat_timer" },
      requestedByActorType: "system", requestedByActorId: null,
    } as any);
    expect(woke, "the scheduled wake was admitted").toBeTruthy();
    await r.drive(3_000);
    await r.tenMinutesPass();
    await evidence("R7", { calls: fixture.calls, wakes: await r.wakes() });
    expect(successorCalls().length, JSON.stringify(fixture.calls)).toBe(1);
    for (const id of r.held) expect(answeredIds()).not.toContain(id);
    expect((await heldWakes(r, r.held)).length).toBeGreaterThan(0);
  }, 120_000);

  it("R8: another board user's message after the Stop keeps today's path (a person's chat refuses it) and the held stay", async () => {
    const r = await stopWithHeld();
    await r.drive(1_000);
    const theirs = await r.post("N other person", r.otherClient);
    await r.drive(1_000);
    await r.tenMinutesPass();
    await evidence("R8", { theirs: { status: theirs.status, body: theirs.body }, calls: fixture.calls, wakes: await r.wakes() });
    expect(theirs.status).toBe(403);
    for (const id of r.held) expect(answeredIds(), JSON.stringify(fixture.calls)).not.toContain(id);
    expect((await heldWakes(r, r.held)).length).toBeGreaterThan(0);
  }, 120_000);

  it("R9: another person's Stop is not a hold for the sender's messages: the hold reader does not hold them", async () => {
    const r = await stopWithHeld({ stopper: otherUserId });
    await r.drive(1_000);
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId });
    await evidence("R9", { hold, calls: fixture.calls, wakes: await r.wakes() });
    expect(hold, "the sender's messages are not held by another person's Stop").toBeNull();
    // The bar (the real GET, the same ONE reader) does not show them as held by a person's Stop.
    expect((await r.queue()).executionWait?.reason ?? null).not.toBe("stopped_by_person");
  }, 120_000);

  it("rf-2 (c): a Stop the Stop route did not accept (no run.stop.accepted person_stop row; the run is only cancelled with the person's attribution) holds nothing", async () => {
    const r = await stopWithHeld({ stopKind: "unaccepted" });
    await r.drive(1_000);
    const [run1] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.firstRunId));
    expect(run1?.status, "the run ended cancelled").toBe("cancelled");
    expect((run1?.resultJson as any)?.cancelledByActorType, "cancelled with a user's attribution").toBe("user");
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId });
    const q = await r.queue();
    await evidence("rf2-c-unaccepted", { hold, bar: q.executionWait, calls: fixture.calls, wakes: await r.wakes() });
    expect(hold, "'the latest run was cancelled by a user' alone is no hold").toBeNull();
    expect(q.executionWait?.reason ?? null, JSON.stringify(q.executionWait)).not.toBe("stopped_by_person");
  }, 120_000);

  it("rf-2 (a): another person's Stop over MY held messages does not hold them: the bar does not say stopped, and my next message is not kept waiting behind them", async () => {
    const r = await stopWithHeld({ stopper: otherUserId });
    await r.drive(1_000);
    const q = await r.queue();
    await evidence("rf2-a-other", { bar: q.executionWait, calls: fixture.calls, wakes: await r.wakes() });
    expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId }), "no hold").toBeNull();
    for (const id of r.held) expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId,
      messageId: id }), `message ${id}`).toBeNull();
    expect(q.executionWait?.reason ?? null, JSON.stringify(q.executionWait)).not.toBe("stopped_by_person");
  }, 120_000);

  // ---- adopt-stophold-2cp: adopt-lead's decisions D1-D3 (cut 2c') ----
  const STOPPED_LINE = "Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it.";
  /** The sweep (settleUnansweredPersonMessage) at +2 and +11 minutes; returns every 'no run started' note it wrote. */
  const noRunNotes = async (r: { companyId: string; issueId: string }) => {
    for (const minute of [2, 11]) await settleUnansweredPersonMessage(db, { companyId: r.companyId, issueId: r.issueId,
      now: new Date(Date.now() + minute * 60_000) });
    return (await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, r.issueId)))
      .filter(c => c.body.includes("no run started")).map(c => c.body);
  };
  const wakesOf = async (r: { wakes: Ctx["wakes"] }, ids: string[]) => (await r.wakes()).filter(w => (w.ids ?? []).some(id => ids.includes(id)));

  // D1 (ruling (c)): agent-conversations' Stop row variants send / delete-then-send / agent-paused / chat-held,
  // RETARGETED from the legacy `process` adapter (a direct heartbeat.cancelRun) to a NATIVE run stopped through
  // the REAL Stop route (POST /api/heartbeat-runs/:runId/cancel, board user => run.stop.accepted person_stop).
  // Setup only changed; the assertions are agent-conversations.test.ts's, one for one.
  for (const variant of ["send", "delete-then-send", "agent-paused", "chat-held"] as const) {
    it(`D1 Stop row (${variant}), native + real Stop route: after a person's Stop nothing is sent; the owner's Send starts one turn with the waiting messages`, async () => {
      // C2 (review-fleet-5): the pre-Stop checks the original row made, read at the same moment (all three
      // saved behind the running turn, before the Stop), asserted below one for one.
      let preStop: { heldIds: string[]; calls: number; busyQueue: any } | undefined;
      // The original's heldIds(): the deferred wakes' wakeCommentIds, read in the wakes' own (requested) order.
      const heldIds = async (agentId: string) => (await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")))
        .orderBy(agentWakeupRequests.requestedAt))
        .flatMap(wake => {
          const ids = (wake.payload as Record<string, any>)?._paperclipWakeContext?.wakeCommentIds;
          return Array.isArray(ids) ? ids : [];
        });
      const r = await stopWithHeld({ beforeStop: async (ctx, _held, _runId) => {
        preStop = { heldIds: await heldIds(ctx.agentId), calls: fixture.calls.length,
          busyQueue: (await request(ctx.client).get(`/api/issues/${ctx.issueId}/queued-comments`).expect(200)).body };
      } });
      const queuedIds = r.held;
      const queuePath = `/api/issues/${r.issueId}/queued-comments`;
      const liveRuns = async () => db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, r.agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
      // All three are saved behind the running turn, none dispatched yet.
      expect(preStop?.heldIds).toEqual(queuedIds);
      expect(preStop?.calls).toBe(1);
      // FALLBACK 2 gives each posted message its own wake. The read must show the whole waiting list even
      // BEFORE Stop gathers those wakes.
      const busyQueue = preStop!.busyQueue;
      expect(busyQueue.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual(queuedIds);
      expect(busyQueue.entries.map((entry: { comment: { body: string } }) => entry.comment.body)).toEqual(["H1 held", "H2 held", "H3 held"]);
      expect(busyQueue.entries.slice(1).every((entry: { queueId?: string; queueRevision?: string }) =>
        entry.queueId && entry.queueId !== busyQueue.queueId && entry.queueRevision)).toBe(true);
      expect(new Set([busyQueue.queueId, ...busyQueue.entries.slice(1).map((entry: { queueId: string }) => entry.queueId)]).size).toBe(3);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.firstRunId));
      expect(stopped!.status).toBe("cancelled");
      // Stop means stop: nothing is sent and nothing is lost.
      await r.drive(1_500);
      expect(fixture.calls).toHaveLength(1);
      expect(await liveRuns()).toHaveLength(0);
      expect(await heldIds(r.agentId)).toEqual(queuedIds);
      const readQueue = async () => {
        const response = await request(r.client).get(queuePath);
        expect(response.status).toBe(200);
        return response.body;
      };
      let queue = await readQueue();
      expect(queue.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual(queuedIds);
      expect(queue.entries.every((entry: { queueId?: string }) => !entry.queueId || entry.queueId === queue.queueId)).toBe(true);
      expect(queue.executionWait).toEqual({ reason: "stopped_by_person", message: STOPPED_LINE });
      const reloaded = await readQueue();
      expect(reloaded.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual(queuedIds);
      expect(reloaded.executionWait?.reason).toBe("stopped_by_person");
      const sendBody = () => ({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
      // Only the chat's owner can Send.
      expect((await request(r.otherClient).post(`${queuePath}/interrupt`).send(sendBody())).status).toBe(403);
      let expected = queuedIds;
      if (variant === "delete-then-send") {
        const deleted = await request(r.client).delete(`${queuePath}/${queuedIds[1]}`).send({ queueId: queue.queueId, revision: queue.revision });
        expect(deleted.status).toBe(200);
        expected = [queuedIds[0]!, queuedIds[2]!];
        queue = await readQueue();
        expect(queue.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual(expected);
        expect(queue.executionWait?.reason).toBe("stopped_by_person");
      }
      if (variant === "agent-paused" || variant === "chat-held") {
        const [hold] = variant === "chat-held"
          ? await db.insert(issueTreeHolds).values({ companyId: r.companyId, rootIssueId: r.issueId, mode: "pause",
            status: "active", createdByActorType: "user", createdByUserId: userId,
            releasePolicy: { strategy: "manual", note: "leaf_pause" } }).returning()
          : [null];
        if (variant === "agent-paused") {
          expect((await request(r.adminClient).post(`/api/agents/${r.agentId}/pause`).send({})).status).toBe(200);
          expect((await readQueue()).executionWait).toEqual({ reason: "queued_comment_chat_paused",
            message: "This agent is paused. Resume it to send these messages." });
        }
        const refused = await request(r.client).post(`${queuePath}/interrupt`).send(sendBody());
        expect(refused.status).toBe(409);
        expect(refused.body.details?.code).toBe("queued_comment_chat_paused");
        expect(refused.body.error).toBe(variant === "agent-paused"
          ? "This agent is paused. Resume it to send these messages."
          : "This chat is paused. Resume it to send these messages.");
        await r.drive(1_500);
        expect(fixture.calls).toHaveLength(1);
        expect(await liveRuns()).toHaveLength(0);
        expect(await heldIds(r.agentId)).toEqual(queuedIds);
        expect((await readQueue()).entries).toHaveLength(3);
        if (hold) await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.id, hold.id));
        else {
          const lifecycle = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
            runHost: async () => "complete" as const, runPlugin: async () => "complete" as const });
          try {
            expect((await request(r.adminClient).post(`/api/agents/${r.agentId}/resume`).send({})).status).toBe(200);
            await lifecycle.process(r.agentId);
          } finally { await lifecycle.stop(); }
        }
        queue = await readQueue();
        expect(queue.executionWait).toEqual({ reason: "stopped_by_person", message: STOPPED_LINE });
      }
      const sent = await request(r.client).post(`${queuePath}/interrupt`).send(sendBody());
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      await waitFor(async () => {
        await r.drive(300);
        const answered = successorCalls().flatMap(call => call.ids);
        if (!expected.every(id => answered.includes(id))) return false;
        return (await liveRuns()).length === 0;
      }, 30_000);
      // A repeated Send of the same queue neither doubles nor reopens it.
      expect((await request(r.client).post(`${queuePath}/interrupt`).send(sendBody())).status).toBe(409);
      await r.drive(500);
      await evidence(`D1-${variant}`, { calls: fixture.calls, wakes: await r.wakes() });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.firstRunId)))[0]!.status).toBe("cancelled");
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.calls[1]!.runId).not.toBe(r.firstRunId);
      expect(fixture.calls[1]!.ordered).toEqual(expected);
      const answers = await db.select().from(issueComments).where(and(eq(issueComments.issueId, r.issueId),
        eq(issueComments.authorAgentId, r.agentId)));
      expect(answers.map(answer => answer.createdByRunId)).toEqual([fixture.calls[1]!.runId]);
      expect(await heldIds(r.agentId)).toEqual([]);
      expect((await readQueue()).entries).toHaveLength(0);
    }, 120_000);
  }

  // D2 (RFL 05:33Z ruling 3, org 3B). K16: a person's message parked behind a running turn, then the person's REAL
  // tree Pause: its wake stays deferred (never cancelled), no 'no run started ... send again' note while paused;
  // the REAL release answers it once. The control rides along: a system-only deferred wake (PLANTED row: no
  // person message) on the same task IS cancelled by the same Pause.
  it("D2 K16: a parked person wake + the real tree Pause: still deferred, no 'no run started' note while paused; the real release answers it once; a system-only deferred wake is cancelled (control)", async () => {
    let systemWakeId = "";
    const r = await stopWithHeld({ stopKind: "treePause", heldCount: 1, beforeStop: async (ctx, _held, runId) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: ctx.companyId, agentId: ctx.agentId,
        source: "automation", triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
        requestedByActorType: "system", payload: { issueId: ctx.issueId, _paperclipWakeContext: { issueId: ctx.issueId, wakeReason: "heartbeat_timer" } },
      }).returning();
      systemWakeId = wake!.id;
      void runId;
    } });
    await r.drive(1_000);
    const holdId = r.stopBody?.hold?.id ?? r.stopBody?.id;
    expect(holdId, JSON.stringify(r.stopBody)).toBeTruthy();
    const duringPause = await wakesOf(r, r.held);
    const system = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, systemWakeId)))[0];
    // The pause lasts: the real workers run, and the sweep runs at +2 and +11 minutes (its own clock).
    // (tenMinutesPass is not used here: it shifts runs and wakes but not the tree hold's own times.)
    await r.drive(2_000);
    const notesWhilePaused = await noRunNotes(r);
    const callsWhilePaused = successorCalls().length;
    const released = await request(r.client).post(`/api/issues/${r.issueId}/tree-holds/${holdId}/release`).send({ reason: "release" });
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    await r.drive(4_000);
    await r.tenMinutesPass();
    const notesAfter = await noRunNotes(r);
    await evidence("D2-K16", { duringPause, system: system?.status, notesWhilePaused, calls: fixture.calls, wakes: await r.wakes(),
      released: released.body, actions: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, r.companyId)))
        .map(a => ({ cause: a.cause, status: a.status, owner: a.ownerType, next: a.nextAction })),
      payloads: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, r.companyId))).map(w => ({ s: w.status, p: w.payload })),
      runs: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, r.companyId))).map(x => ({ id: x.id, s: x.status, e: x.errorCode, rj: x.resultJson })),
      activity: (await db.execute(sql`select action, details from activity_log where company_id = ${r.companyId} order by created_at`)) });
    expect(duringPause.length, JSON.stringify(await r.wakes())).toBeGreaterThan(0);
    expect(duringPause.every(w => w.status === "deferred_issue_execution"), JSON.stringify(duringPause)).toBe(true);
    expect(system?.status, "the system-only deferred wake is cancelled by the Pause").toBe("cancelled");
    expect(callsWhilePaused, JSON.stringify(fixture.calls)).toBe(0);
    expect(notesWhilePaused, "no 'no run started... send again' while paused").toEqual([]);
    expect(answeredIds().filter(id => id === r.held[0]).length, JSON.stringify(fixture.calls)).toBe(1);
    expect(successorCalls().filter(call => call.ids.includes(r.held[0]!)).length).toBe(1);
    expect(notesAfter).toEqual([]);
  }, 120_000);

  it("D2: two person messages parked when the real tree Pause lands: both stay deferred; the real release starts ONE run with both, each once", async () => {
    const r = await stopWithHeld({ stopKind: "treePause", heldCount: 2 });
    await r.drive(1_000);
    const holdId = r.stopBody?.hold?.id ?? r.stopBody?.id;
    const duringPause = await wakesOf(r, r.held);
    // A person cannot add a third message while the task is paused (the comment route refuses it).
    const third = await r.post("third while paused");
    const released = await request(r.client).post(`/api/issues/${r.issueId}/tree-holds/${holdId}/release`).send({ reason: "release" });
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    await r.drive(4_000);
    await r.tenMinutesPass();
    await evidence("D2-two", { duringPause, third: third.status, calls: fixture.calls, wakes: await r.wakes() });
    // Nothing carrying them is cancelled; a deferred wake carries both (the chat gathers the second into it).
    expect(duringPause.length).toBeGreaterThan(0);
    expect(duringPause.some(w => w.status === "cancelled"), JSON.stringify(duringPause)).toBe(false);
    expect(duringPause.filter(w => w.status === "deferred_issue_execution").flatMap(w => w.ids ?? []).sort(), JSON.stringify(duringPause))
      .toEqual(r.held.slice().sort());
    expect(third.status).toBe(409);
    const carrying = successorCalls().filter(call => call.ids.some(id => r.held.includes(id)));
    expect(carrying.length, JSON.stringify(fixture.calls)).toBe(1);
    expect(carrying[0]!.ids.slice().sort()).toEqual(r.held.slice().sort());
    for (const id of r.held) expect(answeredIds().filter(a => a === id).length, JSON.stringify(fixture.calls)).toBe(1);
    expect(await noRunNotes(r)).toEqual([]);
  }, 120_000);

  // A subtree cancel is refused on an Agent Chat (issue-tree-control.ts:796 'Stop the active reply instead of
  // cancelling the persistent conversation'), so this row is on a TASK page.
  it("D2: a subtree CANCEL (task page) cancels the held wakes (held by the person's Stop or not)", async () => {
    const r = await stopWithHeld({ task: true });
    await r.drive(1_000);
    const before = (await heldWakes(r, r.held)).map(w => w.id);
    expect(before.length).toBeGreaterThan(0);
    const cancelled = await request(r.client).post(`/api/issues/${r.issueId}/tree-holds`).send({ mode: "cancel", reason: "cancel" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
    await r.drive(1_000);
    const after = await r.wakes();
    await evidence("D2-cancel", { before, after });
    for (const id of before) expect(after.find(w => w.id === id)?.status, JSON.stringify(after)).toBe("cancelled");
    expect(successorCalls()).toEqual([]);
  }, 120_000);

  // D3, R17 (RFL ruling 1 / org 1A): a person's message parked behind a SAVING run (its saved wait is the
  // remote_cleanup wait admission stores, written by the real writer writeDeferredExecutionWait), then that
  // person's real Stop: HELD (the reader and the bar say so); Send starts one run, answered once; never the
  // sweep's 'no run started... send again'.
  it("D3 R17: a message parked behind a saving run (remote_cleanup wait), then the person's real Stop: held (reader + bar); Send: one run, answered once; never 'no run started'", async () => {
    const r = await stopWithHeld({ heldCount: 1, beforeStop: async (ctx, held) => {
      const [wake] = (await ctx.wakes()).filter(w => (w.ids ?? []).includes(held[0]!));
      expect(wake, JSON.stringify(await ctx.wakes())).toBeTruthy();
      await writeDeferredExecutionWait(db, { companyId: ctx.companyId, requestId: wake!.id },
        { reason: "remote_cleanup", message: "Waiting for the previous environment to stop. Your message will start automatically." });
    } });
    await r.drive(1_000);
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId });
    const bar = await r.queue();
    // The sweep at +2 and +11 minutes (its own clock) before the Send.
    await r.drive(1_000);
    const notesBeforeSend = await noRunNotes(r);
    const q = await r.queue();
    const sent = await request(r.client).post(`/api/issues/${r.issueId}/queued-comments/interrupt`)
      .send({ queueId: q.queueId, revision: q.revision, targetRunId: null });
    await waitFor(async () => { await r.drive(300); return successorCalls().length > 0; }, 30_000).catch(() => undefined);
    await r.drive(1_000);
    await r.tenMinutesPass();
    const notesAfter = await noRunNotes(r);
    await evidence("D3-R17", { hold, bar: bar.executionWait, sent: sent.status, sentBody: sent.body, calls: fixture.calls, wakes: await r.wakes(),
      payloads: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, r.companyId))).map(w => ({ s: w.status, p: w.payload, e: w.error })),
      leases: (await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, r.companyId))).map(l => ({ s: l.status, c: l.cleanupStatus })),
      activity: (await db.execute(sql`select action, details from activity_log where company_id = ${r.companyId} order by created_at`)) });
    expect(hold, "the ONE reader holds the message").toMatchObject({ stoppedRunId: r.firstRunId, userId });
    expect(bar.executionWait?.reason, JSON.stringify(bar.executionWait)).toBe("stopped_by_person");
    expect((bar.entries ?? []).map((e: any) => e.comment?.id)).toEqual(r.held);
    expect(notesBeforeSend).toEqual([]);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(successorCalls().length, JSON.stringify(fixture.calls)).toBe(1);
    expect(successorCalls()[0]!.ids).toEqual(r.held);
    expect(notesAfter).toEqual([]);
  }, 120_000);

});
