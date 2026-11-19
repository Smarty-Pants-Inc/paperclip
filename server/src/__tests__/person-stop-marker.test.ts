import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { readPersonStoppedPreviousTurn } from "../services/acknowledged-native-stop.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-marker-port (RFL F1): Paul starts two-step work, presses Stop at the first tool line, asks '9 + 10'.
// The question's turn must say the person stopped the previous turn (so the model answers the question and does
// not re-run the stopped steps), once; the turn after it, and any turn after an Interrupt, must not.
// Real: the board Stop route (POST /api/heartbeat-runs/:runId/cancel -> run-control's run.stop.accepted row),
// the Interrupt route (queued-comments/interrupt), the chat comment route, heartbeat claim/dispatch, execution
// configuration, the wake prompt render and the native execution input, on a real Postgres. Faked edges only: the
// provider turn (the first is busy until the Stop, then the executor's settle-then-throw; every later turn
// records the built request it was given and answers) and the provider ACK of the Stop.
const fixture = vi.hoisted(() => ({
  /** request: the built native execution input as the provider gets it (JSON). */
  calls: [] as { runId: string; ids: string[]; request: string }[],
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
  /** The next turn fails BEFORE any provider turn (no call recorded); beforeFailure records what it did first. */
  failNext: undefined as undefined | { beforeFailure?: (runId: string) => Promise<void> },
  failed: [] as string[],
}));

vi.mock("../services/heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/runtime-selection.js")>();
  return {
    ...actual,
    prepareAndSelectHeartbeatRuntime: (async (db, input, deps) => actual.prepareAndSelectHeartbeatRuntime(db, {
      ...input, onProviderResourceDisposition: () => input.onProviderResourceDisposition("keep_running"),
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
      const built = JSON.stringify(input.execution);
      if (fixture.calls.length === 0 && fixture.onFirst) {
        fixture.calls.push({ runId, ids, request: built });
        await fixture.onFirst({ runId });
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      if (fixture.failNext) {
        const fail = fixture.failNext;
        fixture.failNext = undefined;
        await fail.beforeFailure?.(runId);
        fixture.failed.push(runId);
        throw new Error("provider_unavailable_before_turn");
      }
      fixture.calls.push({ runId, ids, request: built });
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import * as environmentOrchestrator from "../services/environment-run-orchestrator.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const STOP_MARKER = "The person stopped your previous turn. Do not resume or redo that work unless they ask; answer their new message.";
const markerCount = (built: string | undefined) => (built ?? "").split(STOP_MARKER).length - 1;

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!support.supported)("adopt-marker-port: the first turn after a person's Stop says so, once", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "responsible-user";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("person-stop-marker-");
    db = createDb(tempDb.connectionString);
    fixture.db = db;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "person-stop-marker-"));
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

  const evidence = async (label: string, value: unknown) => {
    if (process.env.MARKER_EVIDENCE) await fs.appendFile(process.env.MARKER_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

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
    const issuePrefix = `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Stop marker", issuePrefix,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active",
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    Object.assign(fixture, { companyId, agentId, issueId });
    return { companyId, agentId, issueId, runId: "" };
  }

  /** Two-step work starts; at its first tool line the person presses Stop (or Interrupt with a queued message). */
  async function stoppedTurn(stopBy: "person" | "interrupt") {
    fixture.calls = [];
    fixture.failed = [];
    fixture.failNext = undefined;
    const f = await seed();
    const client = app(f.companyId);
    const originalFactory = environmentOrchestrator.environmentRunOrchestrator;
    const factory = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...originalFactory(...args),
      releaseForRun: vi.fn(async (input: { heartbeatRunId: string; providerResourceDisposition?: string }) => {
        await db.update(environmentLeases).set(input.providerResourceDisposition === "keep_running"
          ? { status: "retained", cleanupStatus: "success" }
          : { status: "released", cleanupStatus: "success", releasedAt: new Date() })
          .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active")));
        return { released: [], errors: [] };
      }),
    }));
    const heartbeat = heartbeatService(db, {
      nativeSessionBackendFactory: () => ({}) as never,
      beforeNativeRuntimeSelection: async runId => {
        const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
          heartbeatRunId: runId, provider: "daytona", providerLeaseId: randomUUID(), status: "active",
          leasePolicy: "reuse_by_environment",
          metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
        }).returning();
        const reference = { schema: "paperclip.native-workspace-sync/v3" as const, state: "prepared" as const,
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
          workspaceId: randomUUID(), leaseId: lease!.id, providerLeaseId: lease!.providerLeaseId!, remoteCwd: "/work",
          resourceDisposition: "keep_running" as const };
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issueId, nativePhase: "observed",
          runnerProfileJson: { nativeWorkspaceSync: reference, nativeResourceDisposition: "keep_running" },
        }).where(eq(heartbeatRuns.id, runId));
        await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId, phase: "observed" })
          .onConflictDoNothing();
      },
    });
    const post = (body: string) => request(client).post(`/api/issues/${f.issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    let stopping: Promise<unknown> | undefined;
    fixture.onFirst = async ({ runId }) => {
      f.runId = runId;
      if (stopBy === "person") {
        // The person's Stop: the real board Stop route.
        stopping = request(client).post(`/api/heartbeat-runs/${runId}/cancel`).send({}).expect(200);
      } else {
        // The person's Interrupt: a queued message, then the real Interrupt route on the live turn.
        await post("interrupt: do this instead").expect(201);
        const queue = await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
        stopping = request(client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
          .send({ queueId: queue.body.queueId ?? queue.body.id, targetRunId: runId, revision: queue.body.revision }).expect(200);
      }
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return row?.status === "cancelled";
      });
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled",
        leaseOwner: null }).where(eq(nativeRunFinalizations.runId, runId));
    };
    try {
      await issueService(db).addComment(f.issueId, "Step 1: sleep 60. Step 2: sleep 60.", { userId }, { clientRequestId: randomUUID() });
      await deliverConversationComments(db, { id: f.issueId, companyId: f.companyId, conversationAgentId: f.agentId },
        heartbeat.wakeup);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      await stopping;
    } finally { fixture.onFirst = undefined; }
    const settle = async () => {
      for (let i = 0; i < 4; i++) { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); }
    };
    const acceptance = async () => (await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.message, "run.stop.accepted"))))
      .map(row => (row.payload as Record<string, unknown>).kind);
    const record = () => fixture.calls.map(call => ({ runId: call.runId, ids: call.ids, marker: markerCount(call.request) }));
    return { f, post, settle, acceptance, record, done: () => factory.mockRestore() };
  }

  it("(a)+(b): Stop, then '9 + 10': its built request carries the marker ONCE; the turn after ('continue') carries none", async () => {
    const s = await stoppedTurn("person");
    try {
      expect(await s.acceptance(), "the real Stop route wrote the person's acceptance").toEqual(["person_stop"]);
      expect(markerCount(fixture.calls[0]?.request), "the stopped turn's own input had no marker").toBe(0);
      const question = (await s.post("9 + 10").expect(201)).body.id as string;
      await s.settle();
      const next = fixture.calls.slice(1);
      await evidence("a-question", { question, calls: s.record() });
      expect(next.map(call => call.ids), JSON.stringify(s.record())).toEqual([[question]]);
      // (a) the question's turn: the marker, once.
      expect(markerCount(next[0]!.request), next[0]!.request.slice(0, 2000)).toBe(1);
      // (b) the person's own ask to resume: no marker.
      const resume = (await s.post("continue").expect(201)).body.id as string;
      await s.settle();
      await evidence("b-continue", { resume, calls: s.record() });
      const after = fixture.calls.slice(2);
      expect(after.map(call => call.ids), JSON.stringify(s.record())).toEqual([[resume]]);
      expect(markerCount(after[0]!.request)).toBe(0);
    } finally { s.done(); }
  }, 120_000);

  it("(c): an Interrupt (not a person's Stop), then a message: no turn carries the marker", async () => {
    const s = await stoppedTurn("interrupt");
    try {
      expect(await s.acceptance(), "the real Interrupt route wrote its acceptance").toEqual(["interrupt"]);
      await s.settle();
      const question = (await s.post("9 + 10").expect(201)).body.id as string;
      await s.settle();
      await evidence("c-interrupt", { question, calls: s.record() });
      expect(fixture.calls.slice(1).some(call => call.ids.includes(question)), JSON.stringify(s.record())).toBe(true);
      for (const call of fixture.calls) expect(markerCount(call.request), call.runId).toBe(0);
    } finally { s.done(); }
  }, 120_000);

  it("(d): a run in between that failed before a provider turn (even after opening its session) does not consume it; one that started a turn does", async () => {
    const s = await stoppedTurn("person");
    try {
      // The question's run opens its session (session.started) and fails before any provider turn (real heartbeat).
      fixture.failNext = { beforeFailure: async runId => {
        await db.insert(heartbeatRunEvents).values({ companyId: s.f.companyId, agentId: s.f.agentId, runId, seq: 900,
          eventType: "session.started", stream: "system", level: "info", message: "session started" });
      } };
      await s.post("9 + 10").expect(201);
      await s.settle();
      expect(fixture.failed, "a run failed before any provider turn").toHaveLength(1);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.failed[0]!));
      expect(failed?.status).toBe("failed");
      // The next run on the issue (the retry / the next message's run) asks the ONE reader.
      const [next] = await db.insert(heartbeatRuns).values({ companyId: s.f.companyId, agentId: s.f.agentId, status: "queued",
        contextSnapshot: { issueId: s.f.issueId } }).returning();
      const read = () => readPersonStoppedPreviousTurn(db, { companyId: s.f.companyId, issueId: s.f.issueId,
        agentId: s.f.agentId, runId: next!.id, runCreatedAt: next!.createdAt });
      const passed = await read();
      // Contrast on the same state: had the failed run started a provider turn, it consumed the marker.
      await db.insert(heartbeatRunEvents).values({ companyId: s.f.companyId, agentId: s.f.agentId, runId: failed!.id, seq: 901,
        eventType: "turn.started", stream: "system", level: "info", message: "turn started" });
      const consumed = await read();
      await evidence("d-failed-between", { failed: fixture.failed, status: failed?.status, code: failed?.errorCode,
        afterSessionOnly: passed, afterTurnStarted: consumed });
      expect(passed, "a failed-before-turn run left the marker for the next run").toBe(true);
      expect(consumed, "a run that started a turn consumed it").toBe(false);
    } finally { s.done(); }
  }, 120_000);
});
