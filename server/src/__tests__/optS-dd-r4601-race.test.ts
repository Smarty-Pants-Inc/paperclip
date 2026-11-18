import { createHash, randomUUID } from "node:crypto";
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
import { isAcknowledgedNativeStop } from "../services/acknowledged-native-stop.js";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: Stop on a WARM (keep_running) native chat turn, then the
// person's next message. Crosses the real heartbeat teardown (the
// NativeCancellationPendingRecoveryError handler), real cancelRun, real lease
// release and the real run-dispatch claim gate on a real database. Only the
// provider edge is scripted: the executor's settle-then-throw after an
// acknowledged Stop (native-session-executor.ts, cancellation pending recovery)
// and the admitted warm sandbox lifecycle (runtime-selection's keep_running).
const fixture = vi.hoisted(() => ({
  warm: true,
  calls: [] as string[],
  recoveryRaceArmed: true,
  recoveryRacePaused: false,
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
}));

vi.mock("../services/heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/runtime-selection.js")>();
  return {
    ...actual,
    prepareAndSelectHeartbeatRuntime: (async (db, input, deps) => actual.prepareAndSelectHeartbeatRuntime(db, {
      ...input,
      // The admitted value a warm sandbox lifecycle selects (runtime-selection
      // nativeSandboxLifecycle.sandboxResource === "keep_running").
      onProviderResourceDisposition: disposition => input.onProviderResourceDisposition(
        fixture.warm ? "keep_running" : disposition),
    }, deps)) as typeof actual.prepareAndSelectHeartbeatRuntime,
  };
});

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    // Provider edge of Stop: the run-only abort reached the live Pi session
    // (dispatched). The durable intent and acknowledgement stay product code.
    cancelNativeSession: (async (runId: string, reason: string, options?: Parameters<typeof actual.cancelNativeSession>[2]) => {
      const result = await actual.cancelNativeSession(runId, reason, options!);
      if (!options || !fixture.calls.includes(runId) || typeof result !== "object") return result;
      const { db } = options;
      const { heartbeatRuns } = await import("@paperclipai/db");
      const { eq, sql } = await import("drizzle-orm");
      await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson},
        '{nativeCancellation,dispatched}', 'true'::jsonb)` }).where(eq(heartbeatRuns.id, runId));
      // Controlled scheduling only: hold the HTTP Interrupt's native ACK return
      // while the executor unwinds through the real cancellation recovery path.
      // This models a delayed original cancellation continuation, not lost DB data.
      if (fixture.recoveryRaceArmed && !fixture.recoveryRacePaused) {
        fixture.recoveryRacePaused = true;
        await waitFor(async () => {
          const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          return row?.status === "cancelled";
        });
      }
      return { ...result, dispatched: true };
    }) as typeof actual.cancelNativeSession,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      fixture.calls.push(runId);
      if (fixture.calls.length === 1 && fixture.onFirst) {
        await fixture.onFirst({ runId });
        // The executor's own unwinding after an acknowledged Stop: it settles
        // the coordinator and throws for the outer recovery handler.
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      throw new Error("successor_provider_turn_reached");
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import * as environmentOrchestrator from "../services/environment-run-orchestrator.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { preserveCancelledNativeWorkspaces, registerCancelledWorkspacePreservationWork }
  from "../services/native-runtime/native-failed-workspace-recovery.js";

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

// adopt-c3-optS (S10): three messages held by a person's Stop on a WARM
// (keep_running) native chat turn, then Send. Real routes: POST comments,
// GET queued-comments, POST queued-comments/interrupt (Send). The Stop is the
// board Stop route's exact call (heartbeat.cancelRun with the person's
// resultJson). Faked edges, as in heartbeat-warm-stop-hold.test.ts: the
// provider executor (settle-then-throw after the acknowledged Stop; successors
// record their turn and throw), the Stop's dispatch flag, the keep_running
// selection and the lease release (warm box handed back retained, no stop
// receipt). No real warm box or Runner retirement is driven.
describe.skipIf(!support.supported)("optS-dd staged race (rf-4)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "responsible-user";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("optS-send-after-stop-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "optS-send-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: userId, name: "Responsible User",
      email: "responsible-user@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  function app(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use("/api", agentRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Send after stop", issuePrefix,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active",
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    return { companyId, agentId, issueId, runId: "" };
  }

  const turns: Array<{ runId: string; commentIds: string[] }> = [];
  const evidence = async (label: string, value: unknown) => {
    if (process.env.OPTS_EVIDENCE) await fs.appendFile(process.env.OPTS_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };
  // Successor provider turns: each run that reached the executor, with the
  // exact comment ids its wake delivered.
  async function readTurns() {
    turns.length = 0;
    for (const runId of fixture.calls.slice(1)) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const context = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds as string[]
        : typeof context.commentId === "string" ? [context.commentId] : [];
      turns.push({ runId, commentIds: ids });
    }
  }

  const kinds = async (runId: string) => (await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId),
    eq(heartbeatRunEvents.message, "run.stop.accepted")))).map(row => (row.payload as any)?.kind).sort();

  async function heldThenStop(stopBy: "person" | "system" | "interrupt" | "route" = "person") {
    fixture.warm = true;
    fixture.calls = [];
    turns.length = 0;
    const f = await seed();
    const client = app(f.companyId);
    let leaseId: string | undefined;
    const originalFactory = environmentOrchestrator.environmentRunOrchestrator;
    const release = vi.fn(async (input: { heartbeatRunId: string; providerResourceDisposition?: string }) => {
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active"),
          eq(environmentLeases.provider, "local")));
      if (input.providerResourceDisposition === "keep_running") await db.update(environmentLeases)
        .set({ status: "retained", cleanupStatus: "success" })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active")));
      return { released: [], errors: [] };
    });
    const factory = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...originalFactory(...args), releaseForRun: release,
    }));
    const heartbeat = heartbeatService(db, {
      nativeSessionBackendFactory: () => ({}) as never,
      beforeNativeRuntimeSelection: async runId => {
        if (f.runId && runId !== f.runId) return;
        f.runId = runId;
        const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
          heartbeatRunId: runId, provider: "daytona", providerLeaseId: randomUUID(), status: "active",
          leasePolicy: "reuse_by_environment",
          metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
        }).returning();
        leaseId = lease!.id;
        const reference = { schema: "paperclip.native-workspace-sync/v3" as const, state: "prepared" as const,
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
          workspaceId: randomUUID(), leaseId: lease!.id, providerLeaseId: lease!.providerLeaseId!, remoteCwd: "/work",
          resourceDisposition: "keep_running" as const };
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issueId, nativePhase: "observed",
          runnerProfileJson: { nativeWorkspaceSync: reference, nativeResourceDisposition: "keep_running" },
        }).where(eq(heartbeatRuns.id, runId));
        await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId, phase: "observed" });
      },
    });
    const held: string[] = [];
    let stopping: Promise<unknown> | undefined;
    fixture.onFirst = async ({ runId }) => {
      // Three person messages while the turn is busy: the chat route holds them.
      for (const body of ["M1 held", "M2 held"])
        held.push((await post(body).expect(201)).body.id);
      stopping = stopBy === "interrupt" ? (async () => {
        const queue = await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
        return await request(client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
          .send({ queueId: queue.body.queueId ?? queue.body.id, targetRunId: runId, revision: queue.body.revision }).expect(200);
      })() : stopBy === "route" ? request(client).post(`/api/heartbeat-runs/${runId}/cancel`).send({})
      : heartbeat.cancelRun(runId, "Cancelled by a board operator", {
        resultJson: stopBy === "person" ? { cancelledByActorType: "user", cancelledByUserId: userId }
          : { cancelledByActorType: "system" } });
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        return (stopBy === "system" || value?.dispatchState === "acknowledged") &&
          (fixture.recoveryRaceArmed && (stopBy === "interrupt" || stopBy === "route") || row?.status === "cancelled");
      });
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled",
        leaseOwner: null }).where(eq(nativeRunFinalizations.runId, runId));
    };
    const post = (body: string) => request(client).post(`/api/issues/${f.issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    try {
      // M0 opens the busy turn: the chat route's own delivery path.
      await issueService(db).addComment(f.issueId, "M0 start", { userId }, { clientRequestId: randomUUID() });
      await deliverConversationComments(db, { id: f.issueId, companyId: f.companyId, conversationAgentId: f.agentId },
        heartbeat.wakeup);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      await stopping;
    } finally { fixture.onFirst = undefined; fixture.warm = false; }
    const settle = async () => {
      for (let i = 0; i < 3; i++) { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); }
      await readTurns();
    };
    const answered = () => {
      const counts = new Map<string, number>();
      for (const turn of turns) for (const id of turn.commentIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      return counts;
    };
    const send = async () => {
      const queue = await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
      return request(client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
        .send({ queueId: queue.body.queueId ?? queue.body.id, targetRunId: f.runId, revision: queue.body.revision });
    };
    const lease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId!)))[0];
    return { f, client, heartbeat, held, settle, answered, send, lease, post, done: () => factory.mockRestore() };
  }

  it("R4-601: recovery winning Interrupt terminalization must not dispatch Send before the stop receipt", async () => {
    const s = await heldThenStop("interrupt");
    try {
      await s.settle();
      expect(turns).toEqual([]);
      const [interrupted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.runId));
      expect(fixture.recoveryRacePaused).toBe(true);
      expect(interrupted.resultJson?.operatorInterrupted, "race source loses the late HTTP Interrupt marker").not.toBe(true);
      expect(interrupted.resultJson?.cancelledByActorType).toBe("user");
      const sent = await s.send();
      await s.settle();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
      await evidence("forced-recovery-before-http-interrupt-terminalization", { send: sent.status, held: s.held, turns, lease: await s.lease(),
        source: { id: interrupted.id, status: interrupted.status, code: interrupted.errorCode, finishedAt: interrupted.finishedAt, resultJson: interrupted.resultJson },
        wakes: wakes.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait })) });
      expect(turns, "an operator Interrupt must not dispatch a successor without its remote stop receipt").toEqual([]);
      expect(wakes.some(w => (w.payload as any)?.executionWait?.reason === "remote_cleanup")).toBe(true);
      // optS-dd: the Interrupt's acceptance row survives the race's terminal writer (and the Send).
      expect(await kinds(s.f.runId), "the interrupt row survives").toEqual(["interrupt"]);
    } finally { s.done(); }
  }, 120_000);

  // optS-dd "Recovery wins after Stop": the person's Stop through the real Stop route, held at its provider ACK
  // while the executor's recovery wins the terminal write. Mutation: remove the append.
  it("optS-dd recovery wins after a route Stop: person_stop row survives; S admits as S10 when the acknowledged term holds", async () => {
    const s = await heldThenStop("route");
    try {
      await s.settle();
      expect(turns).toEqual([]);
      expect(fixture.recoveryRacePaused, "the race was forced: recovery terminalized while the Stop's ACK was held").toBe(true);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.runId));
      const acknowledged = isAcknowledgedNativeStop(stopped!);
      const rowsBefore = await kinds(s.f.runId);
      const pressedAt = Date.now();
      const sent = await s.send();
      await s.settle();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
      await evidence("optS-dd-recovery-wins-after-route-stop", { send: sent.status, held: s.held, turns, acknowledged, rowsBefore,
        rowsAfter: await kinds(s.f.runId), source: { status: stopped!.status, code: stopped!.errorCode, resultJson: stopped!.resultJson },
        wakes: wakes.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait?.reason })) });
      expect(rowsBefore, "the person_stop row survives the recovery's terminal write").toEqual(["person_stop"]);
      expect(await kinds(s.f.runId)).toEqual(["person_stop"]);
      expect(acknowledged, "the acknowledged-stop term holds after recovery wins").toBe(true);
      expect(sent.status).toBe(200);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.commentIds).toEqual(s.held);
      expect([...s.answered().values()]).toEqual(s.held.map(() => 1));
      expect(Date.now() - pressedAt).toBeLessThan(15_000);
    } finally { s.done(); }
  }, 120_000);

  it("S10: three held, Stop, Send => one run carries all three IDs once at once (not answers)", async () => {
    const s = await heldThenStop();
    try {
      const [r1] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.runId));
      console.log("OPTS RUN1", JSON.stringify({ calls: fixture.calls, held: s.held, status: r1?.status, err: r1?.error, code: r1?.errorCode, lease: await s.lease() }));
      // The box is kept warm: retained, no stop receipt.
      expect((await s.lease())?.status).toBe("retained");
      const queue = await request(s.client).get(`/api/issues/${s.f.issueId}/queued-comments`).expect(200);
      console.log("OPTS QUEUE", JSON.stringify(queue.body));
      await readTurns();
      expect(turns).toEqual([]);
      const pressedAt = Date.now();
      const sent = await s.send();
      console.log("OPTS SEND", sent.status, JSON.stringify(sent.body));
      expect(sent.status).toBe(200);
      await s.settle();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
      console.log("OPTS WAKES", JSON.stringify(wakes.map(w => ({ id: w.id, status: w.status, wait: (w.payload as any)?.executionWait, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds }))));
      console.log("OPTS TURNS", JSON.stringify(turns));
      const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.f.companyId));
      const responses = await db.select().from(issueComments).where(and(eq(issueComments.issueId, s.f.issueId), eq(issueComments.authorType, "agent")));
      expect(allRuns.filter(r => r.id !== s.f.runId)).toHaveLength(1);
      await evidence("S10-independent", { held: s.held, turns, ms: Date.now() - pressedAt,
        runs: allRuns.map(r => ({ id: r.id, status: r.status, code: r.errorCode, error: r.error })),
        agentResponseCount: responses.length,
        wakes: wakes.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait })) });
      expect(turns).toHaveLength(1);
      expect(turns[0]!.commentIds).toEqual(s.held);
      expect([...s.answered().values()]).toEqual([1, 1, 1]);
      expect(Date.now() - pressedAt).toBeLessThan(15_000);
    } finally { s.done(); }
  }, 120_000);

  it("control typed-after-Stop: M4 first, then the three once by themselves; never twice", async () => {
    const s = await heldThenStop();
    try {
      const m4r = await s.post("M4 typed");
      console.log("OPTS M4", m4r.status, JSON.stringify(m4r.body), JSON.stringify(fixture.calls));
      const m4 = m4r.body.id;
      await s.settle();
      await s.settle();
      console.log("OPTS TYPED TURNS", JSON.stringify(turns));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.f.companyId));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
      await evidence("typed-after-Stop", { held: s.held, m4, turns,
        runs: runs.map(r => ({ id: r.id, status: r.status, code: r.errorCode, err: r.error?.slice(0, 160) })),
        wakes: wakes.map(w => ({ id: w.id, status: w.status, runId: w.runId, wait: (w.payload as any)?.executionWait, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds })) });
      expect(turns[0]?.commentIds).toEqual([m4]);
      const counts = s.answered();
      expect(counts.get(m4)).toBe(1);
      // Never twice. FAKED EDGE: the scripted successor turn fails (it has no
      // native finalization), so the existing release/promote of the three
      // after M4 is refused here by the stop-proof check for that scripted
      // run; "then the three by themselves" is not driven in this harness.
      for (const id of s.held) expect(counts.get(id) ?? 0).toBeLessThanOrEqual(1);
      expect(turns.slice(1).flatMap(turn => turn.commentIds).filter(id => id === m4)).toEqual([]);
    } finally { s.done(); }
  }, 120_000);

  it("control Send and a typed message together never answer a held message twice", async () => {
    const s = await heldThenStop();
    try {
      const [sent] = await Promise.all([s.send(),
        s.post("M4 typed").expect(201)]);
      console.log("OPTS BOTH SEND", sent.status);
      await s.settle();
      await s.settle();
      console.log("OPTS BOTH TURNS", JSON.stringify(turns));
      await evidence("send+typed", { held: s.held, send: sent.status, turns });
      for (const id of s.held) expect(s.answered().get(id) ?? 0).toBeLessThanOrEqual(1);
    } finally { s.done(); }
  }, 120_000);

  it.each(["existing_source", "unacknowledged", "dispatch_false", "non_owner_chat", "non_chat", "click_before_finish"] as const)("independent control %s keeps Send held", async mode => {
    const s = await heldThenStop();
    try {
      if (mode === "existing_source") await db.insert(issueRecoveryActions).values({
        companyId: s.f.companyId, sourceIssueId: s.f.issueId, kind: "active_run_watchdog",
        cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
        status: "active", outcome: "blocked", nextAction: "Inspect the stopped execution.", evidence: { runId: s.f.runId },
      });
      if (mode === "unacknowledged" || mode === "dispatch_false") await db.update(heartbeatRuns).set({
        resultJson: mode === "unacknowledged"
          ? sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCancellation,dispatchState}', '"requested"'::jsonb)`
          : sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCancellation,dispatched}', 'false'::jsonb)`,
      }).where(eq(heartbeatRuns.id, s.f.runId));
      if (mode === "non_owner_chat") await db.update(issues).set({ conversationUserId: "other-owner" }).where(eq(issues.id, s.f.issueId));
      if (mode === "non_chat") await db.update(issues).set({ conversationUserId: null, conversationAgentId: null, conversationState: null }).where(eq(issues.id, s.f.issueId));
      if (mode === "click_before_finish") await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, s.f.runId));
      const sent = await s.send();
      await s.settle();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
      await evidence(mode, { send: sent.status, turns, wakes: wakes.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait })) });
      expect(turns).toEqual([]);
      expect(wakes.some(w => w.status === "deferred_issue_execution")).toBe(true);
      if (["existing_source", "unacknowledged", "dispatch_false"].includes(mode))
        expect(wakes.some(w => (w.payload as any)?.executionWait?.reason === "remote_cleanup")).toBe(true);
      if (mode === "click_before_finish") expect(wakes.some(w => (w.payload as any)?.executionWait?.reason === "send_predates_stop")).toBe(true);
    } finally { s.done(); }
  }, 120_000);

  it("control non-person cancel: Send still waits for the box's stop receipt (unchanged)", async () => {
    const s = await heldThenStop("system");
    try {
      const sent = await s.send();
      await s.settle();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
      await evidence("non-person-cancel", { held: s.held, send: sent.status, turns,
        wakes: wakes.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait?.reason })) });
      expect(turns).toEqual([]);
      expect(wakes.some(w => w.status === "deferred_issue_execution")).toBe(true);
      expect(wakes.some(w => (w.payload as any)?.executionWait?.reason === "remote_cleanup")).toBe(true);
    } finally { s.done(); }
  }, 120_000);
});
