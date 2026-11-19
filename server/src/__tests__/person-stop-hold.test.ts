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
import { readPersonStopHold, readPersonStoppedPreviousTurn } from "../services/acknowledged-native-stop.js";
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
  /** prompt: the next turn's built request text (task.prompt + continuationPrompt), as the provider gets it. */
  calls: [] as { runId: string; ids: string[]; reason: string | null; ordered?: string[]; prompt?: string }[],
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
  /** Every later turn, while its run is running (before it answers). */
  onTurn: undefined as undefined | ((input: { runId: string; ids: string[] }) => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
  /** adopt-marker-restore: the next turn fails BEFORE any provider work (no call recorded, no provider event). */
  failNextBeforeProvider: undefined as undefined | (() => Error),
  /** Run ids whose turn failed before provider work. */
  failedBeforeProvider: [] as string[],
  /** adopt-marker2: what the failing run recorded before it failed (e.g. its runner's session.started). */
  beforeProviderFailure: undefined as undefined | ((runId: string) => Promise<void>),
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
      const execution = input.execution as { task?: { prompt?: string }; continuationPrompt?: string | null };
      const prompt = [execution.task?.prompt, execution.continuationPrompt].filter(Boolean).join("\n\n");
      if (fixture.calls.length === 0 && fixture.onFirst) {
        fixture.calls.push({ runId, ids, reason: ctx.wakeReason ?? null, ordered, prompt });
        await fixture.onFirst({ runId });
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      if (fixture.failNextBeforeProvider) {
        const failure = fixture.failNextBeforeProvider();
        fixture.failNextBeforeProvider = undefined;
        await fixture.beforeProviderFailure?.(runId);
        fixture.failedBeforeProvider.push(runId);
        throw failure;
      }
      fixture.calls.push({ runId, ids, reason: ctx.wakeReason ?? null, ordered, prompt });
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
    stopKind?: "person" | "interrupt" | "unaccepted" | "treePause" | "system";
    /** How many messages wait behind the running turn (default 3: H1-H3). */
    heldCount?: number;
    /** rf3 R17's name for heldCount (its row is kept byte-identical). */
    count?: number;
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
    fixture.calls = []; fixture.failedBeforeProvider = []; fixture.failNextBeforeProvider = undefined; fixture.beforeProviderFailure = undefined;
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
      for (const body of ["H1 held", "H2 held", "H3 held", "H4 held"].slice(0, options.heldCount ?? options.count ?? 3)) held.push((await ctx.post(body).expect(201)).body.id);
      await options.beforeStop?.(ctx, held, runId);
      if (options.stopKind === "interrupt") {
        const q = await ctx.queue();
        stopping = request(ctx.client).post(`/api/issues/${ctx.issueId}/queued-comments/interrupt`)
          .send({ queueId: q.queueId ?? q.id, targetRunId: runId, revision: q.revision }).then(r => r);
      } else if (options.stopKind === "unaccepted") {
        stopping = ctx.heartbeat.cancelRun(runId, "Cancelled by a board operator", {
          resultJson: { cancelledByActorType: "user", cancelledByUserId: userId } } as any)
          .then(body => ({ status: 200, body }));
      } else if (options.stopKind === "system") {
        // rf3 R17's system cancel (no person, no stopAcceptance): the run ends before any person's Stop.
        stopping = ctx.heartbeat.cancelRun(runId, 'Cancelled by system recovery', {
          resultJson: { cancelledByActorType: 'system' } } as any).then(body => ({ status: 200, body }));
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
      .toEqual(options.stopKind === "unaccepted" || options.stopKind === "treePause" || options.stopKind === "system" ? []
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

  // C1 (R13b, review-fleet-5): on a TASK, A and B both post while the turn runs (a task's wake can carry both
  // authors). A presses the real Stop, then the real row Send. A's Send carries ONLY A's held message (the ONE
  // same-person fact: author == the Stop's person == the Send-er); B's message runs on its own path after, once,
  // never lost or doubled.
  it("C1 R13b (task): A and B post while it runs; A's Stop then A's Send carries ONLY A's held message; B's runs on its own path after, once", async () => {
    let theirs = "";
    const r = await stopWithHeld({ task: true, heldCount: 1, beforeStop: async ctx => {
      theirs = (await ctx.post("HB other person", ctx.otherClient).expect(201)).body.id;
    } });
    const mine = r.held[0]!;
    await r.drive(1_000);
    // Boat's stop completes: the warm box's stop receipt lands (as R1), so the Send is not waiting on cleanup.
    await r.boatStopAnswers();
    await r.drive(1_000);
    expect(successorCalls(), "nothing runs by itself before the Send").toEqual([]);
    const queue = await r.queue();
    await evidence("C1-before-send", { mine, theirs, queue, wakes: await r.wakes() });
    expect((queue.entries ?? []).map((entry: any) => entry.comment?.id), JSON.stringify(queue)).toContain(mine);
    const sent = await request(r.client).post(`/api/issues/${r.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await waitFor(async () => {
      await r.drive(300);
      return answeredIds().includes(mine) && answeredIds().includes(theirs);
    }, 30_000).catch(() => undefined);
    await r.drive(1_000);
    await r.tenMinutesPass();
    await evidence("C1-after-send", { mine, theirs, calls: fixture.calls, wakes: await r.wakes() });
    // A's Send: ONE successor carrying ONLY A's message.
    expect(successorCalls()[0]?.ids, JSON.stringify(fixture.calls)).toEqual([mine]);
    // B's message: its own run, after, once; never lost, never doubled.
    expect(successorCalls().find(call => call.ids.includes(theirs))?.ids, JSON.stringify(fixture.calls)).toEqual([theirs]);
    for (const id of [mine, theirs]) expect(answeredIds().filter(a => a === id).length, JSON.stringify(fixture.calls)).toBe(1);
    expect(successorCalls().length, JSON.stringify(fixture.calls)).toBe(2);
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


  // review-fleet-3's R17 (the hung-Boat shape), moved here from rf3-hold-review.test.ts:508 with ONLY the
  // helpers it calls (review-fleet-3 code line 7002827026); the row's assertions are byte-identical.
  const comments = async (r: Ctx) => {
    const res = await request(r.client).get(`/api/issues/${r.issueId}/comments`).expect(200);
    return (Array.isArray(res.body) ? res.body : res.body.comments ?? res.body.items) as any[];
  };
  const cards = async (r: Ctx, ids: string[]) => (await comments(r)).filter(c =>
    c.authorType === 'system' && !c.deletedAt && ids.some(id => c.metadata?.authorizationReason === `unanswered_message:${id}`));
  const sweep = async (r: Ctx, minutes: number) => settleUnansweredPersonMessage(db,
    { companyId: r.companyId, issueId: r.issueId, now: new Date(Date.now() + minutes * 60_000) });
  const assertExactlyOnce = (ids: string[], calls = successorCalls()) => {
    expect(calls, JSON.stringify(calls)).toHaveLength(1);
    expect(calls[0].ids.slice().sort()).toEqual(ids.slice().sort());
    for (const id of ids) expect(calls.flatMap(c => c.ids).filter(x => x === id)).toHaveLength(1);
  };

  it('rf3 R17: PERSON message parked by real remote_cleanup producer, then real PERSON Stop becomes HELD, Send answers ONCE (no false sweep card)', async () => {
    // Real producer, not a planted wait: a warm native run is cancelled by the system;
    // its retained remote lease has no stop receipt, so admission parks the next person's POST on remote_cleanup.
    const r = await stopWithHeld({ stopKind: 'system', count: 0 });
    const p = (await r.post('PERSON request while previous run is saving').expect(201)).body.id as string;
    await r.drive(400);
    const before = await r.wakes(); const q0 = await r.queue();
    await evidence('rf3-R17-saving', { p, before, queue: q0, calls: fixture.calls });
    expect(before.some(w => w.ids?.includes(p) && w.wait === 'remote_cleanup'), JSON.stringify(before)).toBe(true);
    expect(successorCalls()).toEqual([]);
    const stopped = await request(r.client).post(`/api/heartbeat-runs/${r.firstRunId}/cancel`).send({});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId, messageId: p });
    const q = await r.queue();
    await sweep(r, 3); const notes = await cards(r, [p]);
    await evidence('rf3-R17-stopped', { p, hold, queue: q, notes, calls: fixture.calls });
    expect(hold).toMatchObject({ stoppedRunId: r.firstRunId, userId });
    expect(q.executionWait?.reason).toBe('stopped_by_person');
    expect(q.entries.map((x: any) => x.comment.id)).toContain(p);
    expect(notes).toEqual([]);
    const sent = await request(r.client).post(`/api/issues/${r.issueId}/queued-comments/interrupt`)
      .send({ queueId: q.queueId ?? q.id, targetRunId: r.firstRunId, revision: q.revision });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await r.drive(4000);
    await evidence('rf3-R17-sent', { p, calls: fixture.calls, wakes: await r.wakes(), comments: await comments(r) });
    assertExactlyOnce([p]);
  }, 120_000);


  // adopt-cutc3 (2): rf3 R17's shape, and Boat's stop receipt lands before the Send (as in R1 / C1 R13b). The
  // system-cancelled run owns TWO leases: the real producer's LOCAL lease and the warm remote box. The remote
  // receipt binds only the remote one; admission used to demand it of the local one too, so nothing ever ran.
  it("rf3 R17 + Boat's receipt: after the receipt lands, the person's Send answers the held message ONCE (no false sweep card)", async () => {
    const r = await stopWithHeld({ stopKind: 'system', count: 0 });
    const p = (await r.post('PERSON request while previous run is saving').expect(201)).body.id as string;
    await r.drive(400);
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, r.firstRunId));
    expect(leases.map(l => l.provider).sort(), "the stopped run's own local lease and the warm remote box").toEqual(["daytona", "local"]);
    const stopped = await request(r.client).post(`/api/heartbeat-runs/${r.firstRunId}/cancel`).send({});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId, messageId: p }))
      .toMatchObject({ stoppedRunId: r.firstRunId, userId });
    const q = await r.queue();
    expect(q.executionWait?.reason).toBe('stopped_by_person');
    await r.boatStopAnswers();
    await r.drive(400);
    expect(successorCalls(), "the receipt alone sends nothing: the Stop still holds").toEqual([]);
    const sent = await request(r.client).post(`/api/issues/${r.issueId}/queued-comments/interrupt`)
      .send({ queueId: q.queueId ?? q.id, targetRunId: r.firstRunId, revision: q.revision });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await r.drive(4000);
    await sweep(r, 3); await sweep(r, 11);
    await evidence('cutc3-R17-receipt-sent', { p, calls: fixture.calls, wakes: await r.wakes(), cards: await cards(r, [p]) });
    assertExactlyOnce([p]);
    expect(await cards(r, [p])).toEqual([]);
  }, 120_000);

  // 3d (adopt-lead's pick; rf-3 + rf-4 09:26Z conditions): a person's Stop of an ALREADY-ENDED latest run.
  const endedRunAcceptances = async (runId: string) => (await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.message, "run.stop.accepted")))).map(row => row.payload as any);
  it("3d control (1): a Stop on an OLDER ended run (a successor started since) is a no-op: nothing held, no acceptance, the person's message is not kept waiting", async () => {
    const r = await stopWithHeld({ stopKind: "system", count: 0 });
    const p = (await r.post("PERSON request while previous run is saving").expect(201)).body.id as string;
    await r.drive(400);
    // A later run of this agent on the task (a successor since the system-cancelled one), already ended.
    const [first] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.firstRunId));
    await db.insert(heartbeatRuns).values({ companyId: r.companyId, agentId: r.agentId, status: "failed",
      invocationSource: "automation", contextSnapshot: { issueId: r.issueId }, createdAt: new Date(first!.createdAt.getTime() + 1_000),
      startedAt: new Date(), finishedAt: new Date() } as any);
    const stopped = await request(r.client).post(`/api/heartbeat-runs/${r.firstRunId}/cancel`).send({});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(await endedRunAcceptances(r.firstRunId)).toEqual([]);
    expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId, messageId: p })).toBeNull();
    expect((await r.queue()).executionWait?.reason).not.toBe("stopped_by_person");
  }, 120_000);

  it("3d control (4): a Stop on the latest ended run with NOTHING waiting is a no-op: no acceptance row, no hold, no card", async () => {
    const r = await stopWithHeld({ stopKind: "system", count: 0 });
    // The system-cancelled turn's own message (M0) already has its true card; the no-op Stop adds or retires nothing.
    const systemCards = async () => (await comments(r)).filter(c => c.authorType === "system" && !c.deletedAt)
      .map(c => `${c.metadata?.authorizationReason}|${c.body}`).sort();
    await sweep(r, 3); await sweep(r, 11);
    const before = await systemCards();
    const stopped = await request(r.client).post(`/api/heartbeat-runs/${r.firstRunId}/cancel`).send({});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(await endedRunAcceptances(r.firstRunId)).toEqual([]);
    expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId })).toBeNull();
    await sweep(r, 3); await sweep(r, 11);
    expect(await systemCards()).toEqual(before);
    // A message the person sends after that no-op Stop is not held by it.
    const later = (await r.post("PERSON after the no-op Stop").expect(201)).body.id as string;
    expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId, messageId: later })).toBeNull();
  }, 120_000);

  // adopt-cutc3 (1), R17 bound (a) (RFL 09:27Z): only a SYSTEM-ended latest run (cancelled / timed out, no person's
  // cancel) counts. A Stop on the latest run that SUCCEEDED (answered long ago) holds nothing: no row, no hold, no card.
  it("3d control (a): a Stop on the latest SUCCEEDED run is a no-op: nothing held, no acceptance row, no card", async () => {
    const r = await stopWithHeld({ stopKind: "system", count: 0 });
    // The latest run of this agent on the task SUCCEEDED (its answer is long given); it is the only run after the cancelled one.
    const [first] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.firstRunId));
    const [done] = await db.insert(heartbeatRuns).values({ companyId: r.companyId, agentId: r.agentId, status: "succeeded",
      invocationSource: "automation", contextSnapshot: { issueId: r.issueId }, createdAt: new Date(first!.createdAt.getTime() + 1_000),
      startedAt: new Date(Date.now() - 60 * 60_000), finishedAt: new Date(Date.now() - 60 * 60_000) } as any).returning();
    const p = (await r.post("PERSON request after an answered turn").expect(201)).body.id as string;
    await sweep(r, 3); await sweep(r, 11);
    const cardsBefore = await cards(r, [p]);
    const stopped = await request(r.client).post(`/api/heartbeat-runs/${done!.id}/cancel`).send({});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(await endedRunAcceptances(done!.id)).toEqual([]);
    expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId, messageId: p })).toBeNull();
    expect((await r.queue()).executionWait?.reason).not.toBe("stopped_by_person");
    await sweep(r, 3); await sweep(r, 11);
    expect(await cards(r, [p])).toEqual(cardsBefore);
  }, 120_000);

  it("3d control: ANOTHER person's Stop of the latest ended run does not hold MY waiting message", async () => {
    const r = await stopWithHeld({ stopKind: "system", count: 0 });
    const p = (await r.post("PERSON request while previous run is saving").expect(201)).body.id as string;
    await r.drive(400);
    const stopped = await request(r.otherClient).post(`/api/heartbeat-runs/${r.firstRunId}/cancel`).send({});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(await endedRunAcceptances(r.firstRunId)).toEqual([]);
    expect(await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId, messageId: p })).toBeNull();
    expect((await r.queue()).executionWait?.reason).not.toBe("stopped_by_person");
  }, 120_000);

  // adopt-stop-marker (RFL F1, take v1-stop-late-g2-m4): after a person's Stop, the NEXT turn's input says the
  // person stopped the previous turn and not to resume it unless asked; said once, only for a person's Stop.
  const STOP_MARKER = "The person stopped your previous turn. Do not resume or redo that work unless they ask; answer their new message.";
  const markerCount = (prompt: string | undefined) => (prompt ?? "").split(STOP_MARKER).length - 1;

  it("stop-marker (a)+(b)+(d): Stop a running turn, then a new question: the next turn's input carries the marker ONCE; the turn after it carries none; its wording leaves resuming to the person's ask", async () => {
    const r = await stopWithHeld();
    await r.tenMinutesPass();
    expect(successorCalls(), "nothing ran by itself").toEqual([]);
    expect(markerCount(fixture.calls[0]?.prompt), "the stopped turn's own input had no marker").toBe(0);
    const typed = (await r.post("9 + 10").expect(201)).body.id as string;
    await r.drive(4_000);
    await r.tenMinutesPass();
    await evidence("stop-marker-a-b", { typed, calls: fixture.calls.map(call => ({ runId: call.runId, ids: call.ids,
      marker: markerCount(call.prompt), head: call.prompt?.slice(0, 600) })) });
    const [next, after] = successorCalls();
    expect(next?.ids, JSON.stringify(fixture.calls.map(call => call.ids))).toEqual([typed]);
    // (a) the first turn after the person's Stop: the marker, once, right under the wake heading.
    expect(markerCount(next?.prompt), next?.prompt).toBe(1);
    expect(next!.prompt!.indexOf(STOP_MARKER)).toBeLessThan(next!.prompt!.indexOf("Use this wake to continue the task"));
    // (b) the turn after that (the held messages' own turn): no marker.
    expect(after, "the held turn ran").toBeTruthy();
    expect(markerCount(after?.prompt), after?.prompt).toBe(0);
    // (d) 'continue' control: the wording permits resuming when the person asks.
    expect(STOP_MARKER).toContain("unless they ask");
  }, 120_000);

  it("stop-marker-restore (a): Stop, real Send; the Send's run fails BEFORE provider work; the next run that starts a provider turn (the automatic fresh-thread restore) is the first turn after the Stop; the turn after it is not", async () => {
    const r = await stopWithHeld();
    const queuePath = `/api/issues/${r.issueId}/queued-comments`;
    const queue = (await request(r.client).get(queuePath).expect(200)).body;
    expect(queue.executionWait?.reason).toBe("stopped_by_person");
    fixture.failNextBeforeProvider = () => new Error("native_continuation_requires_reconciliation: test pre-claim refusal");
    const sent = await request(r.client).post(`${queuePath}/interrupt`).send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await waitFor(async () => { await r.drive(300); return fixture.failedBeforeProvider.length > 0; }, 30_000);
    const failedRunId = fixture.failedBeforeProvider[0]!;
    await waitFor(async () => { const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failedRunId));
      return row && !["queued", "running"].includes(row.status); }, 30_000);
    // The faked edge's pre-claim refusal as the real executor records it (incident run 092726ac).
    await db.update(heartbeatRuns).set({ errorCode: "native_continuation_requires_reconciliation" }).where(eq(heartbeatRuns.id, failedRunId));
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failedRunId));
    expect(failed!.status).toBe("failed");
    expect(successorCalls(), "the Send's run never reached the provider").toEqual([]);
    // The automatic fresh-thread restore (incident run 39c78365): the next run of this agent on the task. This harness
    // parks every later turn behind the failed run's recovery, so the ONE reader is asked for that run (as the
    // system-cancel row below does); execution-configuration.ts asks it the same way for every run it builds.
    const marker = (run: { id: string; createdAt: Date }) => readPersonStoppedPreviousTurn(db, { companyId: r.companyId,
      issueId: r.issueId, agentId: r.agentId, runId: run.id, runCreatedAt: run.createdAt });
    const [restore] = await db.insert(heartbeatRuns).values({ companyId: r.companyId, agentId: r.agentId, status: "queued",
      contextSnapshot: { issueId: r.issueId, wakeReason: "issue_continuation_needed", previousRunId: failedRunId } }).returning();
    const restoreMarked = await marker(restore!);
    // The restore turn then reaches the provider and answers; the turn after it is not the first after the Stop.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, restore!.id));
    const [after] = await db.insert(heartbeatRuns).values({ companyId: r.companyId, agentId: r.agentId, status: "queued",
      contextSnapshot: { issueId: r.issueId } }).returning();
    const afterMarked = await marker(after!);
    await evidence("stop-marker-restore-a", { stoppedRunId: r.firstRunId, failedRunId, failedErrorCode: failed!.errorCode,
      restoreRunId: restore!.id, restoreMarked, afterRunId: after!.id, afterMarked });
    expect(restoreMarked, "the first run after the Stop that starts a provider turn carries the marker").toBe(true);
    expect(afterMarked, "the turn after it carries none").toBe(false);
  }, 180_000);

  /** adopt-marker2: real Stop, real Send; the Send's run (the successor) records `events` as its runner would (sourced
   * events), plus an optional session checkpoint, then fails before any answer. Returns the ONE reader's verdict for
   * the automatic restore after it and for the turn after that. */
  async function markerAfterFailedSuccessor(label: string, events: string[], sessionCheckpoint?: Record<string, unknown>) {
    const r = await stopWithHeld();
    const queuePath = `/api/issues/${r.issueId}/queued-comments`;
    const queue = (await request(r.client).get(queuePath).expect(200)).body;
    expect(queue.executionWait?.reason).toBe("stopped_by_person");
    const sourceInstanceId = `runner-${randomUUID()}`;
    fixture.beforeProviderFailure = async runId => {
      let seq = 10_000;
      for (const eventType of events) {
        seq += 1;
        await db.insert(heartbeatRunEvents).values({ companyId: r.companyId, runId, agentId: r.agentId, seq, eventType,
          stream: "system", level: "info", message: eventType, payload: { sessionId: "pi-session-1" },
          sourceInstanceId, sourceEventId: `${sourceInstanceId}:${seq}`, sourceSeq: seq });
      }
      if (sessionCheckpoint) await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson},
        '{}'::jsonb) || ${JSON.stringify({ sessionCheckpoint })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
    };
    fixture.failNextBeforeProvider = () => new Error("runner_session_failed: test failure after the session opened");
    const sent = await request(r.client).post(`${queuePath}/interrupt`).send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await waitFor(async () => { await r.drive(300); return fixture.failedBeforeProvider.length > 0; }, 30_000);
    const failedRunId = fixture.failedBeforeProvider[0]!;
    await waitFor(async () => { const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failedRunId));
      return row && !["queued", "running"].includes(row.status); }, 30_000);
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failedRunId));
    expect(failed!.status).toBe("failed");
    const recorded = await db.select({ eventType: heartbeatRunEvents.eventType, sourceEventId: heartbeatRunEvents.sourceEventId })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, failedRunId), sql`${heartbeatRunEvents.sourceEventId} is not null`));
    expect(recorded.map(row => row.eventType)).toEqual(events);
    expect(successorCalls(), "the successor never answered").toEqual([]);
    const marker = (run: { id: string; createdAt: Date }) => readPersonStoppedPreviousTurn(db, { companyId: r.companyId,
      issueId: r.issueId, agentId: r.agentId, runId: run.id, runCreatedAt: run.createdAt });
    const [restore] = await db.insert(heartbeatRuns).values({ companyId: r.companyId, agentId: r.agentId, status: "queued",
      contextSnapshot: { issueId: r.issueId, wakeReason: "issue_continuation_needed", previousRunId: failedRunId } }).returning();
    const restoreMarked = await marker(restore!);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, restore!.id));
    const [after] = await db.insert(heartbeatRuns).values({ companyId: r.companyId, agentId: r.agentId, status: "queued",
      contextSnapshot: { issueId: r.issueId } }).returning();
    const afterMarked = await marker(after!);
    await evidence(label, { stoppedRunId: r.firstRunId, failedRunId, failedStatus: failed!.status, failedError: failed!.error,
      recordedSuccessorEvents: recorded, sessionCheckpoint: sessionCheckpoint ?? null,
      restoreRunId: restore!.id, restoreMarked, afterRunId: after!.id, afterMarked });
    return { restoreMarked, afterMarked };
  }

  it("stop-marker-restore (e) adopt-marker2: Stop, real Send; the Send's run OPENS its session (harness.ready, session.started) and fails before any turn; the automatic restore after it still carries the marker; the turn after it does not", async () => {
    const { restoreMarked, afterMarked } = await markerAfterFailedSuccessor("stop-marker-restore-e-session-started",
      ["harness.ready", "session.started"]);
    expect(restoreMarked, "opening a session is not a turn: the restore is the first turn after the Stop").toBe(true);
    expect(afterMarked, "the turn after it carries none").toBe(false);
  }, 180_000);

  it("stop-marker-restore (e2) adopt-marker2: a resumed session (harness.ready, session.resumed, session.updated) that fails before any turn leaves the marker too", async () => {
    const { restoreMarked } = await markerAfterFailedSuccessor("stop-marker-restore-e2-session-resumed",
      ["harness.ready", "session.resumed", "session.updated"]);
    expect(restoreMarked).toBe(true);
  }, 180_000);

  it("stop-marker-restore (f) adopt-marker2: a successor that DID submit a turn (turn.submitted) and then failed consumed the marker; the restore after it carries none", async () => {
    const { restoreMarked, afterMarked } = await markerAfterFailedSuccessor("stop-marker-restore-f-turn-submitted",
      ["harness.ready", "session.started", "turn.submitted"]);
    expect(restoreMarked, "the successor's turn already showed the provider the marker").toBe(false);
    expect(afterMarked).toBe(false);
  }, 180_000);

  it("stop-marker-restore (f2) adopt-marker2: a successor whose session checkpoint holds an active turn id consumed the marker (no turn event needed)", async () => {
    const { restoreMarked } = await markerAfterFailedSuccessor("stop-marker-restore-f2-active-turn",
      ["harness.ready", "session.started"], { activeTurnId: "turn-1", terminalTurns: [] });
    expect(restoreMarked).toBe(false);
  }, 180_000);

  it("stop-marker-restore (d): one true note at a time: the failed Send's 'Send a new message to try again' note retires when the automatic fresh thread starts (its started note supersedes it); another unanswered note stays", async () => {
    const r = await stopWithHeld({ count: 0 });
    const { HELD_PREDECESSOR_NOTICE } = await import("../services/native-runtime/held-predecessor-notice-text.js");
    const { supersedeHeldConversationNotice, writePiSessionHistoryLossNotice } = await import("../services/native-runtime/pi-session-recovery-notice.js");
    const { FRESH_THREAD_STARTED_NOTE } = await import("../services/native-runtime/fresh-thread-stop-gate.js");
    const note = (body: string, reason: string) => issueService(db).addComment(r.issueId, body, {}, { authorType: "system",
      presentation: { kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: true },
      metadata: { version: 1, authorizationReason: reason, sections: [{ rows: [{ type: "run_link", runId: r.firstRunId, agentId: r.agentId, title: "Run" }] }] } } as any);
    // The unanswered sweep's note for the failed Send (incident: 'Your message and saved work are kept ... Send a new
    // message to try again.') and, as the control, a different unanswered note on another message.
    const held = await note(HELD_PREDECESSOR_NOTICE, `unanswered_message:${randomUUID()}`);
    const other = await note("Your message wasn't answered.", `unanswered_message:${randomUUID()}`);
    const notes = async () => db.select().from(issueComments).where(and(eq(issueComments.issueId, r.issueId), eq(issueComments.authorType, "system")));
    const current = (rows: Awaited<ReturnType<typeof notes>>) => rows.filter(row => !(row.metadata as any)?.supersededByCommentId).map(row => row.body);
    expect(current(await notes())).toContain(HELD_PREDECESSOR_NOTICE);
    // The fresh thread starts: the real writer pair selectFreshContinuationThread / pi-conversation-record run.
    const authorizationReason = `fresh_provider_thread:${randomUUID()}`;
    await db.transaction(async tx => {
      await writePiSessionHistoryLossNotice(db, tx, { companyId: r.companyId, issueId: r.issueId, runId: r.firstRunId, agentId: r.agentId,
        authorizationReason, body: FRESH_THREAD_STARTED_NOTE, replaceExisting: true });
      await supersedeHeldConversationNotice(tx, { companyId: r.companyId, issueId: r.issueId, heldSessionId: null, reason: authorizationReason });
    });
    const after = await notes();
    await evidence("stop-marker-restore-d", after.map(row => ({ id: row.id, body: row.body.slice(0, 80),
      reason: (row.metadata as any)?.authorizationReason, supersededBy: (row.metadata as any)?.supersededByCommentId ?? null })));
    expect(current(after)).not.toContain(HELD_PREDECESSOR_NOTICE);
    expect(current(after)).toContain(FRESH_THREAD_STARTED_NOTE);
    expect(current(after)).toContain("Your message wasn't answered.");
    expect(after.find(row => row.id === held.id)!.body, "history kept").toBe(HELD_PREDECESSOR_NOTICE);
    expect(after.find(row => row.id === other.id)!.metadata).not.toHaveProperty("supersededByCommentId");
  }, 180_000);

  it("stop-marker (c): a queued-message Interrupt (not a person's Stop), then a message: no marker in the next turn's input", async () => {
    const r = await stopWithHeld({ stopKind: "interrupt", count: 1 });
    await r.tenMinutesPass();
    const typed = (await r.post("9 + 10").expect(201)).body.id as string;
    await r.drive(4_000);
    await r.tenMinutesPass();
    await evidence("stop-marker-c-interrupt", { typed, calls: fixture.calls.map(call => ({ runId: call.runId, ids: call.ids,
      marker: markerCount(call.prompt) })) });
    expect(successorCalls().filter(call => call.ids.includes(typed)).length, JSON.stringify(fixture.calls.map(call => call.ids))).toBe(1);
    for (const call of successorCalls()) expect(markerCount(call.prompt), call.prompt).toBe(0);
  }, 120_000);

  it("stop-marker (c): a system-cancelled run, then a message: the ONE reader gives its next turn no marker (this harness parks every later turn after a system cancel, so the reader is asked for that turn's run)", async () => {
    const r = await stopWithHeld({ stopKind: "system", count: 0 });
    await r.post("9 + 10").expect(201);
    await r.drive(1_000);
    const [next] = await db.insert(heartbeatRuns).values({ companyId: r.companyId, agentId: r.agentId, status: "queued",
      contextSnapshot: { issueId: r.issueId } }).returning();
    expect(await readPersonStoppedPreviousTurn(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId,
      runId: next!.id, runCreatedAt: next!.createdAt })).toBe(false);
    // Contrast on the same state: the person's real Stop of that ended run (R17) makes it the first turn after a Stop.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, next!.id));
    const stopped = await request(r.client).post(`/api/heartbeat-runs/${r.firstRunId}/cancel`).send({});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    const [after] = await db.insert(heartbeatRuns).values({ companyId: r.companyId, agentId: r.agentId, status: "queued",
      contextSnapshot: { issueId: r.issueId } }).returning();
    expect(await readPersonStoppedPreviousTurn(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId,
      runId: after!.id, runCreatedAt: after!.createdAt })).toBe(true);
  }, 120_000);

});
