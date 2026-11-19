import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { readPersonStopHold } from "../services/acknowledged-native-stop.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-startstop-accept: a person's Stop of a paperclip_runner agent's run during STARTUP,
// BEFORE native selection (runtimeMode still legacy, runtimeModeResolvedAt null), must record
// the Stop route's server-owned acceptance row (run.stop.accepted, kind person_stop), so the
// ONE hold reader (readPersonStopHold) holds the messages that arrived behind it.
// Real: chat route, person Stop route (POST /api/heartbeat-runs/:runId/cancel), heartbeat
// admission -> claim -> prepare -> runtime selection, and the real wake-queue release drain.
// Faked edge: the provider turn (records the comment ids it was given and answers once).
const fixture = vi.hoisted(() => ({
  calls: [] as { runId: string; ids: string[] }[],
  onPrepare: undefined as undefined | ((input: { runId: string }) => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));

vi.mock("../services/heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/runtime-selection.js")>();
  return {
    ...actual,
    prepareAndSelectHeartbeatRuntime: (async (db, input, deps) => {
      const hook = fixture.onPrepare;
      fixture.onPrepare = undefined;
      // The Stop lands here: the run is claimed and preparing, before native selection.
      if (hook) await hook({ runId: input.run.id });
      return actual.prepareAndSelectHeartbeatRuntime(db, input, deps);
    }) as typeof actual.prepareAndSelectHeartbeatRuntime,
  };
});

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      const { heartbeatRuns, issueComments } = await import("@paperclipai/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await (fixture.db as any).select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const ctx = (row?.contextSnapshot ?? {}) as Record<string, any>;
      const ids = [...new Set([ctx.commentId, ctx.wakeCommentId, ...(ctx.wakeCommentIds ?? [])].filter(Boolean))] as string[];
      fixture.calls.push({ runId, ids });
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";

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

describe.skipIf(!support.supported)("a person's Stop during startup, before native selection, records the accepted Stop", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "startstop-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("startstop-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "startstop-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: userId, name: userId, email: "startstop@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.STARTSTOP_EVIDENCE) await fs.appendFile(process.env.STARTSTOP_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  async function setup(adapterType: "paperclip_runner" | "process") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "StartStop", issuePrefix, defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle", adapterType,
      adapterConfig: adapterType === "paperclip_runner" ? { provider: "codex", model: "gpt-5.6-luna" } : { command: "true" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active",
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    fixture.calls = [];
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
    const post = (body: string) => request(client).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
    const drive = async (ms = 2_000) => {
      const t0 = Date.now();
      do {
        await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
        await new Promise(r => setTimeout(r, 100));
      } while (Date.now() - t0 < ms);
    };
    const wakes = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .map(w => ({ id: w.id, status: w.status, reason: w.reason, runId: w.runId, wait: (w.payload as any)?.executionWait ?? null,
        ids: ((w.payload as any)?._paperclipWakeContext?.wakeCommentIds ?? (w.payload as any)?.queuedCommentIds ?? null) as string[] | null }));
    return { companyId, agentId, issueId, client, heartbeat, post, drive, wakes };
  }

  type StopKind = "person" | "system";
  /** M0 starts a turn; during its startup (claimed, preparing, before native selection) H1-H3 arrive and the Stop lands. */
  async function stopDuringStartup(adapterType: "paperclip_runner" | "process", kind: StopKind, withHeld = true) {
    const ctx = await setup(adapterType);
    const held: string[] = [];
    let firstRunId = "";
    let atStop: Record<string, unknown> = {};
    let stopping: Promise<{ status: number; body: unknown }> | undefined;
    fixture.onPrepare = async ({ runId }) => {
      firstRunId = runId;
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      atStop = { status: row?.status, runtimeMode: row?.runtimeMode, runtimeModeResolvedAt: row?.runtimeModeResolvedAt ?? null,
        executionStage: row?.executionStage, adapterDispatch: (row?.runnerProfileJson as any)?.adapterDispatch ?? null };
      if (withHeld) for (const body of ["H1 held", "H2 held", "H3 held"]) held.push((await ctx.post(body).expect(201)).body.id);
      stopping = kind === "person"
        ? request(ctx.client).post(`/api/heartbeat-runs/${runId}/cancel`).send({}).then(r => r)
        // A system startup cancel through the same supersession path (no person, no stopAcceptance).
        : ctx.heartbeat.cancelRun(runId, "Cancelled by the system", { errorCode: "issue_reassigned" } as any)
          .then(body => ({ status: 200, body }), error => ({ status: 500, body: String(error) }));
      void stopping.catch(() => undefined);
      // Let the Stop commit its fence before startup continues (it must not wait on this startup).
      await waitFor(async () => {
        const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const result = (current?.resultJson ?? {}) as Record<string, unknown>;
        return current?.status !== "running" || result.executionCancellation != null || result.startupCancellation != null;
      }, 10_000).catch(() => undefined);
    };
    await issueService(db).addComment(ctx.issueId, "M0 start", { userId }, { clientRequestId: randomUUID() });
    await deliverConversationComments(db, { id: ctx.issueId, companyId: ctx.companyId, conversationAgentId: ctx.agentId },
      ctx.heartbeat.wakeup);
    await ctx.heartbeat.resumeQueuedRuns();
    await ctx.heartbeat.drainActiveRunExecutions();
    fixture.onPrepare = undefined;
    expect(firstRunId, "the first turn reached startup").not.toBe("");
    const stopped = await stopping;
    expect(stopped?.status, `stop: ${JSON.stringify(stopped?.body)}`).toBe(200);
    await waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRunId));
      return row && row.status !== "running" && row.status !== "queued";
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRunId));
    const accepted = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, firstRunId),
      eq(heartbeatRunEvents.message, "run.stop.accepted")));
    return { ...ctx, held, firstRunId, atStop, run: run!, accepted };
  }

  const realRelease = (runId: string, companyId: string) => createReleaseIssueExecution({
    issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    } as never),
    recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } as never,
  })({ companyId, runId, now: new Date() });

  it("RED->GREEN: a person's Stop of a runner agent's run before native selection writes run.stop.accepted; the hold is found; the held messages stay held through the release", async () => {
    const r = await stopDuringStartup("paperclip_runner", "person");
    // The shape: claimed and preparing, runtime not yet selected, a native-bound (paperclip_runner) dispatch.
    expect(r.atStop).toMatchObject({ status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: null,
      adapterDispatch: { adapterType: "paperclip_runner" } });
    expect(r.run.runtimeMode, "the stopped run never reached native selection").toBe("legacy");
    expect(r.held.length).toBe(3);
    const accepted = r.accepted.map(row => row.payload as Record<string, unknown>);
    await r.drive(1_000);
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId });
    // Every real promoter that reconsiders saved messages after a stopped startup: the run's
    // wake-queue release drain, then the periodic workspace-recovery worker (index.ts ->
    // resumeRemoteStopComments, which admits a beforeNativeSelection startup cancel) and the
    // execution-wait worker.
    const release = await realRelease(r.firstRunId, r.companyId);
    await r.drive(1_000);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.firstRunId));
    await r.heartbeat.resumeRemoteStopComments(settled as any);
    await r.heartbeat.resumeExecutionWaitComments({ companyId: r.companyId });
    await r.drive(1_000);
    // A non-person wake on the same task runs a turn (as R7); its release drains the queue behind it.
    const woke = await r.heartbeat.wakeup(r.agentId, {
      source: "automation", triggerDetail: "system", reason: "heartbeat_timer",
      payload: { issueId: r.issueId }, contextSnapshot: { issueId: r.issueId, wakeReason: "heartbeat_timer" },
      requestedByActorType: "system", requestedByActorId: null,
    } as any);
    await r.drive(4_000);
    const [latest] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, r.companyId))
      .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    if (latest) await r.heartbeat.resumeRemoteStopComments(latest as any);
    await r.drive(3_000);
    const wakes = await r.wakes();
    const answered = fixture.calls.flatMap(call => call.ids);
    await evidence("RED-GREEN", { atStop: r.atStop, run: { status: r.run.status, runtimeMode: r.run.runtimeMode,
      startupCancellation: (r.run.resultJson as any)?.startupCancellation, cancelledByUserId: (r.run.resultJson as any)?.cancelledByUserId },
      accepted, hold, release: release.outcome.kind, woke: Boolean(woke), calls: fixture.calls, wakes, held: r.held });
    expect(accepted.map(p => p.kind), "the Stop route wrote its acceptance row").toEqual(["person_stop"]);
    expect(accepted[0]).toMatchObject({ schema: "paperclip.stop-acceptance.v1", userId, issueId: r.issueId });
    expect(hold, "the person's startup Stop holds").toMatchObject({ stoppedRunId: r.firstRunId, userId });
    expect(release.outcome.kind, JSON.stringify(wakes)).not.toBe("promoted");
    for (const id of r.held) expect(answered, `held message ran by itself: ${JSON.stringify(fixture.calls)}`).not.toContain(id);
    const heldWakes = wakes.filter(w => w.status === "deferred_issue_execution" && (w.ids ?? []).some(id => r.held.includes(id)));
    expect(heldWakes.length, JSON.stringify(wakes)).toBeGreaterThan(0);
  }, 120_000);

  it("release by Send: after the startup Stop, that person's Send delivers the held messages, once each", async () => {
    const r = await stopDuringStartup("paperclip_runner", "person");
    await r.drive(1_000);
    const q = (await request(r.client).get(`/api/issues/${r.issueId}/queued-comments`)).body;
    const sent = await request(r.client).post(`/api/issues/${r.issueId}/queued-comments/interrupt`)
      .send({ queueId: q.queueId ?? q.id, targetRunId: r.firstRunId, revision: q.revision });
    await r.drive(4_000);
    const answered = fixture.calls.flatMap(call => call.ids);
    await evidence("release-send", { accepted: r.accepted.map(row => row.payload), queue: q, sent: { status: sent.status, body: sent.body },
      calls: fixture.calls, wakes: await r.wakes(), held: r.held });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    for (const id of r.held) expect(answered.filter(a => a === id).length, JSON.stringify(fixture.calls)).toBe(1);
  }, 120_000);

  it("release by next message: after the startup Stop, that person's typed message runs first, then the held ones, once each", async () => {
    const r = await stopDuringStartup("paperclip_runner", "person");
    await r.drive(1_000);
    const typed = (await r.post("M4 typed").expect(201)).body.id as string;
    await r.drive(5_000);
    const answered = fixture.calls.flatMap(call => call.ids);
    await evidence("release-typed", { accepted: r.accepted.map(row => row.payload), typed, calls: fixture.calls, wakes: await r.wakes(), held: r.held });
    expect(fixture.calls[0]?.ids, JSON.stringify(fixture.calls)).toEqual([typed]);
    for (const id of [typed, ...r.held]) expect(answered.filter(a => a === id).length, JSON.stringify(fixture.calls)).toBe(1);
  }, 120_000);

  it("control A: a system startup cancel of the same run shape writes no acceptance row and is no hold", async () => {
    const r = await stopDuringStartup("paperclip_runner", "system");
    expect(r.atStop).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null, adapterDispatch: { adapterType: "paperclip_runner" } });
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId });
    await evidence("control-A", { atStop: r.atStop, status: r.run.status, accepted: r.accepted.map(row => row.payload), hold });
    expect(r.accepted, "a system cancel records no person's acceptance").toEqual([]);
    expect(hold).toBeNull();
  }, 120_000);

  it("control B: a legacy (non-runner) agent's startup Stop by a person is unchanged: no acceptance row, no hold", async () => {
    const r = await stopDuringStartup("process", "person", false);
    expect(r.atStop).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null });
    expect((r.atStop.adapterDispatch as any)?.adapterType).not.toBe("paperclip_runner");
    const hold = await readPersonStopHold(db, { companyId: r.companyId, issueId: r.issueId, agentId: r.agentId });
    await evidence("control-B", { atStop: r.atStop, status: r.run.status, accepted: r.accepted.map(row => row.payload), hold });
    expect(r.accepted, "a legacy agent's Stop is not a native person-Stop acceptance").toEqual([]);
    expect(hold).toBeNull();
  }, 120_000);
});
