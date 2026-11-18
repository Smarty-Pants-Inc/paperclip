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
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { readFailedPreparationSettlement } from "../services/failed-preparation-settlement.js";
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
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
  holdCancel: undefined as undefined | Promise<void>,
  failAppend: false,
}));

// R12 (js_throw): the acceptance append fails in JS before any SQL, so only the transaction's own rollback
// can undo the fence. A swallowed error then commits the acceptance without its row.
vi.mock("../services/heartbeat-run-events.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat-run-events.js")>();
  return {
    ...actual,
    appendHeartbeatRunEvent: (async (db, input, ...rest) => {
      if (fixture.failAppend && input.message === "run.stop.accepted") throw new Error("opts_dd_append_failed_js");
      return actual.appendHeartbeatRunEvent(db, input, ...rest);
    }) as typeof actual.appendHeartbeatRunEvent,
  };
});

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
      // D4: hold the provider edge of the Stop so the stopped run is genuinely still running when Send lands.
      if (fixture.holdCancel) await fixture.holdCancel;
      const result = await actual.cancelNativeSession(runId, reason, options!);
      if (!options || !fixture.calls.includes(runId) || typeof result !== "object") return result;
      const { db } = options;
      const { heartbeatRuns } = await import("@paperclipai/db");
      const { eq, sql } = await import("drizzle-orm");
      await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson},
        '{nativeCancellation,dispatched}', 'true'::jsonb)` }).where(eq(heartbeatRuns.id, runId));
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
describe.skipIf(!support.supported)("optS-dd: default-DENY stop-acceptance row", () => {
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

  const acceptance = async (runId: string) => (await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.message, "run.stop.accepted"))))
  const kinds = async (runId: string) => (await acceptance(runId)).map(row => (row.payload as any)?.kind).sort();
  const sameShapeRow = (f: { companyId: string; agentId: string; issueId: string; runId: string }, kind: string, extra: Record<string, unknown> = {}) =>
    appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId, eventType: "lifecycle", stream: "system",
      level: "info", message: "run.stop.accepted", payload: { schema: "paperclip.stop-acceptance.v1", kind, issueId: f.issueId,
        userId, acceptedAt: new Date(0).toISOString(), ...extra } });
  const duringRun = async (runId: string, rowId: number) => {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRunEvents).set({ createdAt: new Date(run!.finishedAt!.getTime() - 1) }).where(eq(heartbeatRunEvents.id, rowId));
  };
  const sendOutcome = async (s: Awaited<ReturnType<typeof heldThenStop>>) => {
    const sent = await s.send();
    await s.settle();
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
    return { sent: sent.status, turns: [...turns], wakes: wakes.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait?.reason })) };
  };
  const expectB = (out: Awaited<ReturnType<typeof sendOutcome>>) => {
    expect(out.turns, "B: no dispatch").toEqual([]);
    expect(out.wakes.some(w => w.wait === "remote_cleanup"), JSON.stringify(out.wakes)).toBe(true);
  };

  async function heldThenStop(stopBy: "person" | "direct" | "system" | "interrupt" | "person_then_send" = "person") {
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
    let sendWhileRunning: { status?: string; statusAtAccept?: string; res: number; body?: unknown } | undefined;
    fixture.onFirst = async ({ runId }) => {
      // Three person messages while the turn is busy: the chat route holds them.
      for (const body of ["M1 held", "M2 held", "M3 held"])
        held.push((await post(body).expect(201)).body.id);
      const interrupt = async () => {
        const queue = await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
        return await request(client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
          .send({ queueId: queue.body.queueId ?? queue.body.id, targetRunId: runId, revision: queue.body.revision });
      };
      // Every person Stop goes through the real Stop route: POST /api/heartbeat-runs/:runId/cancel.
      const routeStop = () => request(client).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      stopping = stopBy === "interrupt" ? interrupt()
        : stopBy === "person" ? routeStop()
        : stopBy === "person_then_send" ? (async () => {
          let release!: () => void;
          fixture.holdCancel = new Promise<void>(resolve => { release = resolve; });
          const stop = routeStop(); void stop.then(() => undefined, () => undefined);
          // The Stop's fence has committed (B and this build both record executionCancellation in it).
          await waitFor(async () => !!(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.resultJson?.executionCancellation);
          const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          let answered = false;
          const sending = interrupt(); void sending.then(() => { answered = true; }, () => { answered = true; });
          // Its own cancel is held too: wait until the route answered or its Interrupt was accepted.
          await waitFor(async () => answered || (await kinds(runId)).includes("interrupt"), 5_000).catch(() => undefined);
          const [atAccept] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          fixture.holdCancel = undefined; release();
          const r = await sending;
          sendWhileRunning = { status: row?.status, statusAtAccept: atAccept?.status, res: r.status, body: r.body };
          return await stop;
        })()
        : heartbeat.cancelRun(runId, "Cancelled by a board operator", {
        resultJson: stopBy === "direct" ? { cancelledByActorType: "user", cancelledByUserId: userId }
          : { cancelledByActorType: "system" } });
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        return (stopBy === "system" || stopBy === "person_then_send" || value?.dispatchState === "acknowledged") && row?.status === "cancelled";
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
    return { f, client, heartbeat, held, settle, answered, send, lease, post, sendWhileRunning: () => sendWhileRunning, done: () => factory.mockRestore() };
  }

  // R1 Interrupt boundary. Mutation: the Interrupt helper sends person_stop.
  it("R1 Interrupt: no dispatch, waits on remote_cleanup, one interrupt row and no person_stop", async () => {
    const s = await heldThenStop("interrupt");
    try {
      expect(await kinds(s.f.runId)).toEqual(["interrupt"]);
      const out = await sendOutcome(s);
      await evidence("R1-interrupt", out);
      expectB(out);
    } finally { s.done(); }
  }, 120_000);

  // R9 S10 through the route. Mutations: remove the append, or the route option.
  it("R9 S10 via POST /api/heartbeat-runs/:runId/cancel: one run carries M1-M3 once; exactly one person_stop row", async () => {
    const s = await heldThenStop("person");
    try {
      const rows = await acceptance(s.f.runId);
      expect(rows.map(r => (r.payload as any).kind)).toEqual(["person_stop"]);
      expect(rows[0]).toMatchObject({ eventType: "lifecycle", stream: "system", level: "info", sourceEventId: null,
        sourceInstanceId: null, sourceSeq: null, sourcePayloadSha256: null, protocolSchemaVersion: null });
      expect(Object.keys(rows[0]!.payload as object).sort()).toEqual(["acceptedAt", "issueId", "kind", "schema", "userId"]);
      expect(rows[0]!.payload).toMatchObject({ schema: "paperclip.stop-acceptance.v1", issueId: s.f.issueId, userId });
      const out = await sendOutcome(s);
      await evidence("R9-S10-route", out);
      expect(out.sent).toBe(200);
      expect(out.turns).toHaveLength(1);
      expect(out.turns[0]!.commentIds).toEqual(s.held);
      expect([...s.answered().values()]).toEqual([1, 1, 1]);
    } finally { s.done(); }
  }, 120_000);

  // R10 Control: attribution is not authority. Mutation: drop the person_stop term.
  it("R10 control: direct cancelRun with user attribution and no option writes no row and takes B", async () => {
    const s = await heldThenStop("direct");
    try {
      expect(await kinds(s.f.runId)).toEqual([]);
      const out = await sendOutcome(s);
      await evidence("R10-direct", out);
      expectB(out);
    } finally { s.done(); }
  }, 120_000);

  // R8 Stop then Interrupt, and Interrupt then Stop. Mutation: drop the "no other kind" term
  // ("latest wins" fails the second order). The second acceptance is seeded with run-control's shape.
  it.each(["stop_then_interrupt", "interrupt_then_stop"] as const)("R8 %s: no dispatch", async order => {
    const s = await heldThenStop(order === "stop_then_interrupt" ? "person" : "interrupt");
    try {
      const { row } = await sameShapeRow(s.f, order === "stop_then_interrupt" ? "interrupt" : "person_stop");
      // Accepted while the run was live (before finished_at), so only the kind terms can deny it.
      await duringRun(s.f.runId, row.id);
      expect(await kinds(s.f.runId)).toEqual(["interrupt", "person_stop"]);
      const out = await sendOutcome(s);
      await evidence(`R8-${order}`, out);
      expectB(out);
    } finally { s.done(); }
  }, 120_000);

  // D4 (condition 7): Send pressed while the stopped run is still running. Two real outcomes, both observed:
  // the route accepts it as an Interrupt (200, DESIGN's issues.ts :18155) and writes an interrupt row, or it
  // refuses it (409) while the Stop's cancellation is pending and writes nothing. Either way: never S, no successor.
  it.each([1, 2, 3, 4])("D4 Send while the stopped run is still running (try %i): never S", async attempt => {
    const s = await heldThenStop("person_then_send");
    try {
      const pressed = s.sendWhileRunning();
      const k = await kinds(s.f.runId);
      await s.settle();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
      await evidence("D4-send-while-running", { attempt, status: pressed?.status, statusAtAccept: pressed?.statusAtAccept, res: pressed?.res, kinds: k, held: s.held, turns: [...turns],
        wakes: wakes.map(w => ({ status: w.status, wait: (w.payload as any)?.executionWait?.reason })) });
      expect(pressed?.status).toBe("running");
      expect(pressed?.statusAtAccept).toBe("running");
      expect(turns, "no successor from the Send pressed while running").toEqual([]);
      if (pressed?.res === 200) expect(k).toEqual(["interrupt", "person_stop"]);
      else { expect(pressed?.res).toBe(409); expect(k).toEqual(["person_stop"]); }
    } finally { s.done(); }
  }, 120_000);

  // D3 FORGERY: the most permissive writer (legacy adapter events, run-output.ts onAdapterEvent) can write a
  // lifecycle row with a caller-chosen message and payload but always adds its receipt stamp. After a non-person
  // cancel, a forged row (stamped, or another user's) must not admit S.
  it.each(["adapter_stamped", "other_user", "after_finish"] as const)("D3 forged %s row after an attributed non-route cancel does not admit S", async mode => {
    // The R10 control (acknowledged, user-attributed Stop that is not the Stop route): every term but the row holds.
    const s = await heldThenStop("direct");
    try {
      const { row } = await sameShapeRow(s.f, "person_stop", mode === "adapter_stamped"
        ? { receivedAt: new Date().toISOString(), adapterEventIndex: 1 } : mode === "other_user" ? { userId: "someone-else" } : {});
      // A forging writer runs during the run: only after_finish is left outside the window.
      if (mode !== "after_finish") await duringRun(s.f.runId, row.id);
      const out = await sendOutcome(s);
      await evidence(`D3-forged-${mode}`, out);
      expect(out.turns).toEqual([]);
    } finally { s.done(); }
  }, 120_000);

  // R12 Atomic append. Mutation: swallow the append error.
  it.each(["js_throw", "db_trigger"] as const)("R12 a failing append (%s) rolls back the Stop's acceptance", async mode => {
    if (mode === "js_throw") fixture.failAppend = true;
    else await db.execute(sql.raw(`create or replace function opts_dd_fail() returns trigger language plpgsql as $$ begin
      if new.message = 'run.stop.accepted' then raise exception 'opts_dd_append_failed'; end if; return new; end $$;
      drop trigger if exists opts_dd_fail on heartbeat_run_events;
      create trigger opts_dd_fail before insert on heartbeat_run_events for each row execute function opts_dd_fail();`));
    try {
      fixture.warm = true; fixture.calls = [];
      const f = await seed();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
        invocationSource: "on_demand", runtimeMode: "native", nativeIssueId: f.issueId, issueId: f.issueId,
        contextSnapshot: { issueId: f.issueId }, startedAt: new Date() } as any).returning();
      const res = await request(app(f.companyId)).post(`/api/heartbeat-runs/${run!.id}/cancel`).send({});
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      await evidence("R12-atomic", { status: res.status, resultJson: after?.resultJson, runStatus: after?.status });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect((after?.resultJson as any)?.executionCancellation).toBeUndefined();
      expect(after?.status).toBe("running");
      expect(await acceptance(run!.id)).toEqual([]);
    } finally {
      fixture.failAppend = false;
      await db.execute(sql.raw("drop trigger if exists opts_dd_fail on heartbeat_run_events"));
    }
  }, 120_000);

  // Condition 1: an exact-sequence reader reads past the row as on B. Mutation: drop the not(stopAcceptance) filter.
  it("C1 a Stop during preparation then a failure settles as on B (failed-preparation-settlement)", async () => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
      invocationSource: "on_demand", error: "prep failed", contextSnapshot: { issueId: f.issueId } } as any).returning();
    f.runId = run!.id;
    const append = (eventType: string, level: string, message: string, payload: Record<string, unknown> | null) =>
      appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: run!.id, agentId: f.agentId, eventType, stream: "system", level, message, payload });
    await sameShapeRow(f, "person_stop");
    await append("error", "error", "prep failed", null);
    await append("lifecycle", "info", "task.run.measured", { phase: "task.run.measured", outcome: "failed", durationMs: 5, durableSettlement: true });
    const withRow = await readFailedPreparationSettlement(db, run!);
    await evidence("C1-failed-prep", { withRow });
    expect(withRow).toEqual({ unsupportedHarnessWarning: null });
    // A real extra row still refuses settlement (the reader stays exact).
    await append("lifecycle", "info", "run started", null);
    expect(await readFailedPreparationSettlement(db, run!)).toBeNull();
  }, 60_000);
});
