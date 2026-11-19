import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { readPersonStopHold } from "../services/acknowledged-native-stop.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
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
  calls: [] as { runId: string; ids: string[]; reason: string | null }[],
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
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
      if (fixture.calls.length === 0 && fixture.onFirst) {
        fixture.calls.push({ runId, ids, reason: ctx.wakeReason ?? null });
        await fixture.onFirst({ runId });
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      fixture.calls.push({ runId, ids, reason: ctx.wakeReason ?? null });
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
    treePause?: boolean;
    count?: number;
    systemOnly?: boolean;
    saving?: boolean;
    /** "interrupt": the queued-message Interrupt, not a person's Stop (R5).
     * "unaccepted": the person's cancel that the Stop route did NOT accept: the
     * run ends cancelled with that person's attribution (heartbeat.cancelRun,
     * S's R10 control), but there is no run.stop.accepted person_stop row (rf-2 c). */
    stopKind?: "person" | "interrupt" | "unaccepted" | "system";
    /** Boat's stop stays hung: its stop receipt never comes during the wait. */
    hung?: boolean;
    /** A TASK page (no Agent Chat): the same Stop over a task's assignee turn. */
    task?: boolean;
  };
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function setup(setupOptions: { task?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const rootIssueId = setupOptions.task ? issueId : randomUUID();
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
    // PLANTED initial graph only: a chat is a child of an ordinary task so the person's subtree Cancel has a legal root.
    if (!setupOptions.task) await db.insert(issues).values({ id: rootIssueId, companyId, title: 'Cancel root',
      status: 'todo', priority: 'medium', responsibleUserId: userId, issueNumber: 2, identifier: `${issuePrefix}-2` });
    await db.insert(issues).values({ id: issueId, companyId, ...(setupOptions.task ? {} : { parentId: rootIssueId }), title: "Chat", status: "in_progress", priority: "medium",
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
      client.use("/api", activityRoutes(db));
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
    return { companyId, agentId, issueId, rootIssueId, client, otherClient, adminClient, heartbeat, post, drive, wakes, queue, tenMinutesPass, boatStopAnswers };
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
      if (options.saving) {
        // REAL Saving producer: accepted native result transfers ownership to workspace finalization.
        const { NativeRunCoordinatorStore } = await import('../services/native-runtime/native-run-coordinator-store.js');
        const { completionContracts } = await import('@paperclipai/db');
        const { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } = await import('../vendor/paperclip-runner/testing.js');
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, run.completionContractId!));
        const ids = ((contract.contractJson as any).criteria ?? []).map((c: any) => c.id);
        const revision = String(contract.revision);
        const store = new NativeRunCoordinatorStore(db, { companyId: ctx.companyId, issueId: ctx.issueId, agentId: ctx.agentId,
          runId, normalizedSessionId: run.nativeSessionId!, runnerSourceInstanceId: run.runnerInstanceId!,
          completionContractId: run.completionContractId!, completionContractSha256: run.completionContractSha256!,
          completionContractRevision: revision, completionContractCriterionIds: ids });
        await store.completeRun({ result: { ...CONTROL_PLANE_CONFORMANCE_RESULT, completionClaim: {
          ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: revision,
          criteria: ids.map((criterionId: string) => ({ criterionId, status: 'satisfied', evidenceRefs: ['event:2'] })) } },
          terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL });
        const [saving] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
        const publicRuns = await request(ctx.client).get(`/api/issues/${ctx.issueId}/runs`).expect(200);
        await evidence('rf3-Saving-producer', { phase: saving.phase, resultId: saving.resultId, publicRuns: publicRuns.body });
        expect(saving.phase).toBe('workspace_finalizing'); expect(saving.resultId).toBeTruthy();
      }
      for (const body of ["H1 held", "H2 held", "H3 held"].slice(0, options.count ?? 3)) held.push((await ctx.post(body).expect(201)).body.id);
      if (options.systemOnly) await ctx.heartbeat.wakeup(ctx.agentId, {
        source: 'automation', triggerDetail: 'system', reason: 'rf3_system_control',
        payload: { issueId: ctx.issueId }, contextSnapshot: { issueId: ctx.issueId, wakeReason: 'rf3_system_control' },
        requestedByActorType: 'system', requestedByActorId: null,
      } as any);
      if (options.treePause) {
        stopping = request(ctx.client).post(`/api/issues/${ctx.issueId}/tree-holds`)
          .send({ mode: 'pause', reason: 'rf3 K16 busy pause' }).then(r => r);
      } else if (options.stopKind === "interrupt") {
        const q = await ctx.queue();
        stopping = request(ctx.client).post(`/api/issues/${ctx.issueId}/queued-comments/interrupt`)
          .send({ queueId: q.queueId ?? q.id, targetRunId: runId, revision: q.revision }).then(r => r);
      } else if (options.stopKind === "system") {
        stopping = ctx.heartbeat.cancelRun(runId, 'Cancelled by system recovery', {
          resultJson: { cancelledByActorType: 'system' } } as any).then(body => ({ status: 200, body }));
      } else if (options.stopKind === "unaccepted") {
        stopping = ctx.heartbeat.cancelRun(runId, "Cancelled by a board operator", {
          resultJson: { cancelledByActorType: "user", cancelledByUserId: userId } } as any)
          .then(body => ({ status: 200, body }));
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
    expect(stopped?.status, `stop route: ${JSON.stringify(stopped?.body)}`).toBe(options.treePause ? 201 : 200);
    expect(firstRunId, "first turn reached the provider").not.toBe("");
    const accepted = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, firstRunId),
      eq(heartbeatRunEvents.message, "run.stop.accepted")));
    expect(accepted.map(row => (row.payload as any)?.kind), "the Stop route wrote its acceptance row")
      .toEqual(options.treePause || options.stopKind === "system" || options.stopKind === "unaccepted" ? [] : [options.stopKind === "interrupt" ? "interrupt" : "person_stop"]);
    return { ...ctx, held, firstRunId, holdId: options.treePause ? (stopped?.body as any)?.hold?.id as string : undefined };
  }

  const successorCalls = () => fixture.calls.slice(1);
  const answeredIds = () => successorCalls().flatMap(call => call.ids);
  const heldWakes = async (ctx: { wakes: Ctx["wakes"] }, held: string[]) =>
    (await ctx.wakes()).filter(w => w.status === "deferred_issue_execution" && (w.ids ?? []).some(id => held.includes(id)));


  // Independent rf3 requirements; reuse only the native/real-route harness, not builder assertions.
  // All response/card assertions read the real GET. The provider is scripted; this is NOT live-org proof.
  const comments = async (r: Ctx) => {
    const res = await request(r.client).get(`/api/issues/${r.issueId}/comments`).expect(200);
    return (Array.isArray(res.body) ? res.body : res.body.comments ?? res.body.items) as any[];
  };
  const cards = async (r: Ctx, ids: string[]) => (await comments(r)).filter(c =>
    c.authorType === 'system' && !c.deletedAt && ids.some(id => c.metadata?.authorizationReason === `unanswered_message:${id}`));
  const sweep = async (r: Ctx, minutes: number) => settleUnansweredPersonMessage(db,
    { companyId: r.companyId, issueId: r.issueId, now: new Date(Date.now() + minutes * 60_000) });
  const tree = async (r: Ctx, mode: 'pause'|'cancel') => {
    const root = mode === 'cancel' ? r.rootIssueId : r.issueId;
    const res = await request(r.client).post(`/api/issues/${root}/tree-holds`).send({ mode, reason: `rf3 ${mode}` });
    await evidence('rf3-tree-result', { root, mode, status: res.status, body: res.body, wakes: await r.wakes(), comments: await comments(r) });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body.hold.id as string;
  };
  const release = async (r: Ctx, holdId: string) => request(r.client)
    .post(`/api/issues/${r.issueId}/tree-holds/${holdId}/release`).send({ reason: 'rf3 release' }).expect(200);
  const assertExactlyOnce = (ids: string[], calls = successorCalls()) => {
    expect(calls, JSON.stringify(calls)).toHaveLength(1);
    expect(calls[0].ids.slice().sort()).toEqual(ids.slice().sort());
    for (const id of ids) expect(calls.flatMap(c => c.ids).filter(x => x === id)).toHaveLength(1);
  };

  it('rf3 K16: a PERSON wake parked behind a real native run survives real tree Pause, no false no-run card; release answers once', async () => {
    const r = await stopWithHeld({ treePause: true, count: 1 });
    const wakes = await r.wakes();
    const carrying = wakes.filter(w => w.ids?.includes(r.held[0]));
    await sweep(r, 3);
    const notes = await cards(r, r.held);
    await evidence('rf3-K16-paused', { held: r.held, wakes, notes, queue: await r.queue(), calls: fixture.calls });
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.every(w => w.status === 'deferred_issue_execution'), JSON.stringify(carrying)).toBe(true);
    expect(notes).toEqual([]);
    expect(successorCalls()).toEqual([]);
    await r.boatStopAnswers();
    await release(r, r.holdId!);
    await r.drive(4000);
    await evidence('rf3-K16-released', { calls: fixture.calls, wakes: await r.wakes(), comments: await comments(r) });
    // K16 owes one answer to this message, not the absence of an unrelated tree-resume system turn.
    assertExactlyOnce(r.held, successorCalls().filter(call => call.ids.some(id => r.held.includes(id))));
  }, 120_000);

  it('rf3 K16-two: TWO messages typed while tree-paused produce ONE run after release, each answered once', async () => {
    restoreRelease?.();
    const r = await setup(); fixture.onFirst = undefined;
    const holdId = await tree(r, 'pause');
    const a = await r.post('pause message A');
    const b = await r.post('pause message B');
    await evidence('rf3-two-posts', { a: { status: a.status, body: a.body }, b: { status: b.status, body: b.body } });
    expect(a.status, JSON.stringify(a.body)).toBe(201); expect(b.status, JSON.stringify(b.body)).toBe(201);
    const ids = [a.body.id, b.body.id] as string[];
    await r.drive(500);
    await sweep(r, 3);
    await evidence('rf3-two-paused', { ids, calls: fixture.calls, wakes: await r.wakes(), notes: await cards(r, ids) });
    expect(fixture.calls).toEqual([]);
    expect(await cards(r, ids)).toEqual([]);
    const carried = (await r.wakes()).filter(w => w.ids?.some(id => ids.includes(id)));
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.every(w => w.status === 'deferred_issue_execution'), JSON.stringify(carried)).toBe(true);
    await release(r, holdId);
    await r.drive(4000);
    await evidence('rf3-two-released', { ids, calls: fixture.calls, wakes: await r.wakes(), comments: await comments(r) });
    assertExactlyOnce(ids, fixture.calls);
  }, 120_000);

  it('rf3 system-control: a SYSTEM-only wake parked by the real producer is still CANCELLED by tree Pause', async () => {
    const r = await stopWithHeld({ treePause: true, count: 0, systemOnly: true });
    const wakes = await r.wakes();
    const controls = wakes.filter(w => w.src === 'automation/system' && !w.ids?.length);
    await evidence('rf3-system', { controls, wakes, calls: fixture.calls });
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every(w => w.status === 'cancelled'), JSON.stringify(controls)).toBe(true);
    expect(successorCalls()).toEqual([]);
  }, 120_000);

  for (const task of [false, true]) {
    it(`rf3 D2 ${task ? 'task' : 'chat'}: SUBTREE CANCEL cancels held wake and sender gets exactly ONE TRUE card via real GET`, async () => {
      const r = await stopWithHeld({ task, count: 1 });
      await r.drive(300);
      await tree(r, 'cancel');
      const carried = (await r.wakes()).filter(w => w.ids?.includes(r.held[0]));
      await sweep(r, 2); const at2 = await cards(r, r.held);
      await sweep(r, 11); const at11 = await cards(r, r.held);
      await evidence(`rf3-D2-${task ? 'task' : 'chat'}`, { held: r.held, carried, at2, at11, comments: await comments(r) });
      expect(carried.length).toBeGreaterThan(0);
      expect(carried.every(w => w.status === 'cancelled'), JSON.stringify(carried)).toBe(true);
      expect(at2).toHaveLength(1); expect(at11).toHaveLength(1);
      expect(at11[0].id).toBe(at2[0].id);
      expect(at11[0].body).toMatch(/no run started|wasn't answered/);
      expect(at11[0].metadata.authorizationReason).toBe(`unanswered_message:${r.held[0]}`);
      expect(successorCalls()).toEqual([]);
    }, 120_000);
  }

  it('rf3 Delete-retires: after a true card exists, the PERSON DELETE retires it; real GET never shows the deleted message card again', async () => {
    const r = await stopWithHeld({ count: 1, task: true });
    await tree(r, 'cancel');
    await sweep(r, 2);
    const before = await cards(r, r.held);
    await evidence('rf3-Delete-before', { held: r.held, before });
    expect(before).toHaveLength(1);
    const deleted = await request(r.client).delete(`/api/issues/${r.issueId}/comments/${r.held[0]}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBeLessThan(300);
    const immediate = await cards(r, r.held);
    await sweep(r, 3); const after = await cards(r, r.held);
    await sweep(r, 11); const later = await cards(r, r.held);
    await sweep(r, 30); const at30 = await cards(r, r.held);
    await evidence('rf3-Delete-after', { immediate, after, later, at30, comments: await comments(r) });
    expect(after).toEqual([]); expect(later).toEqual([]); expect(at30).toEqual([]);
  }, 120_000);

  let stopLifecycle: (() => Promise<void>) | undefined;
  afterAll(async () => { await stopLifecycle?.(); });
  it('rf3 R6: real agent Pause + Resume preserves the Stop hold, only a typed PERSON message releases each once', async () => {
    const r = await stopWithHeld();
    const { configureAgentLifecycle } = await import('../services/agent-lifecycle.js');
    // REAL lifecycle worker, scripted provider setup edge. Routes alone only enqueue Resume;
    // without this real producer the agent remains verifying and the heartbeat cannot dispatch.
    const lifecycle = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => 'complete', runHost: async () => 'complete' });
    stopLifecycle = async () => { await lifecycle.stop(); };
    await request(r.adminClient).post(`/api/agents/${r.agentId}/pause`).send({}).expect(200);
    await lifecycle.process(r.agentId);
    await r.drive(400);
    await request(r.adminClient).post(`/api/agents/${r.agentId}/resume`).send({}).expect(200);
    await lifecycle.process(r.agentId);
    const resumed = (await request(r.adminClient).get(`/api/agents/${r.agentId}`).expect(200)).body;
    await evidence('rf3-R6-resumed', { status: resumed.status, lifecycleState: resumed.lifecycleState });
    expect(resumed.status).toBe('idle');
    await r.drive(500);
    expect(successorCalls()).toEqual([]);
    const q = await r.queue();
    expect(q.entries.map((x: any) => x.comment.id)).toContain(r.held[0]);
    await r.tenMinutesPass();
    expect(successorCalls()).toEqual([]);
    const typed = (await r.post('PERSON resumes with a new message').expect(201)).body.id;
    await r.drive(4000);
    await evidence('rf3-R6', { held: r.held, typed, calls: fixture.calls, queue: await r.queue() });
    expect(successorCalls()[0]?.ids, JSON.stringify(await r.wakes())).toEqual([typed]);
    for (const id of [typed, ...r.held]) expect(answeredIds().filter(x => x === id)).toHaveLength(1);
    expect(successorCalls()).toHaveLength(2);
  }, 120_000);

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

  it('rf3 R17-export: a PERSON message arrives behind REAL workspace_finalizing producer, REAL Stop holds it; Send answers ONCE; never sweep no-run card', async () => {
    const r = await stopWithHeld({ saving: true, count: 1 });
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId, messageId: r.held[0] });
    const q = await r.queue(); await sweep(r, 3); const notes = await cards(r, r.held);
    await evidence('rf3-R17-export-held', { held: r.held, hold, queue: q, notes, wakes: await r.wakes() });
    expect(hold).toMatchObject({ stoppedRunId: r.firstRunId, userId });
    expect(q.executionWait?.reason).toBe('stopped_by_person');
    expect(q.entries.map((x: any) => x.comment.id)).toContain(r.held[0]); expect(notes).toEqual([]);
    const sent = await request(r.client).post(`/api/issues/${r.issueId}/queued-comments/interrupt`)
      .send({ queueId: q.queueId ?? q.id, targetRunId: r.firstRunId, revision: q.revision });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await r.drive(4000);
    await evidence('rf3-R17-export-sent', { held: r.held, calls: fixture.calls, wakes: await r.wakes(), comments: await comments(r) });
    assertExactlyOnce(r.held);
  }, 120_000);

  it('rf3 Delete-source-control: real system-cancelled lost wake gets ONE true card; PERSON Delete of its message retires the card on next sweep (task)', async () => {
    const r = await stopWithHeld({ stopKind: 'system', count: 1, task: true });
    await tree(r, 'cancel');
    await sweep(r, 3); const before = await cards(r, r.held);
    await evidence('rf3-Delete-source-before', { held: r.held, before, wakes: await r.wakes() });
    expect(before).toHaveLength(1);
    const del = await request(r.client).delete(`/api/issues/${r.issueId}/comments/${r.held[0]}`);
    expect(del.status, JSON.stringify(del.body)).toBeLessThan(300);
    const immediate = await cards(r, r.held);
    await sweep(r, 4); const after = await cards(r, r.held);
    await sweep(r, 11); const later = await cards(r, r.held);
    await sweep(r, 30); const at30 = await cards(r, r.held);
    await evidence('rf3-Delete-source-after', { immediate, after, later, at30, comments: await comments(r) });
    expect(after).toEqual([]); expect(later).toEqual([]); expect(at30).toEqual([]);
  }, 120_000);

});
