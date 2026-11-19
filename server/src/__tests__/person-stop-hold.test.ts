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

  // Port note (port-R13b onto final5c3): person-stop-hold.test.ts is absent at 5e8af273. Only the harness and this
  // commit's row (C1 R13b) are carried from ecfbbda0's tree; the source file's other rows belong to other commits/units.
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
});
