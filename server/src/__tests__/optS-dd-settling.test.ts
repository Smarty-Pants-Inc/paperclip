import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
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
import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-optS-dd-settling: can Option S (or a typed message) start a DOUBLE run
// while the stopped run's execution is still live in THIS server process?
// Harness: the F3 harness (local run, real chat/Stop/Send routes, real wake ->
// claim -> executor dispatch). The first turn stays INSIDE the provider
// executor after the person's acknowledged Stop (run row already cancelled +
// finished), and the test also publishes adapterExecutionControls[firstRun]
// (the brief's execution_settling state). While it is live, Send (S path) or a
// typed message (typed path) is made and the scheduler is driven. A second
// executor entry while the first is still inside = a real double run.
// (Original F3 note follows.)
// adopt-optS-dd-f3 (rf-4 F3): ANSWERS-ONCE with a SUCCEEDING provider, counting
// PERSISTED agent replies. Real chat route (POST /api/issues/:id/comments on a
// conversationAgentId task), real person Stop route (POST
// /api/heartbeat-runs/:runId/cancel), real Send route (queued-comments/interrupt),
// real heartbeat admission/dispatch and Option S. The run stays LOCAL (no
// remote box: the c3-orphan harness environment). Faked edges only: the
// provider turn (first turn: busy until the person's Stop, then the executor's
// settle-then-throw after an acknowledged Stop; successor turns answer with one
// agent reply comment 'answer from <runId>' and succeed) and the provider ACK
// of the Stop (dispatched flag), as the optS-dd tests.
const fixture = vi.hoisted(() => ({
  calls: [] as { runId: string; ok: boolean; firstLive: boolean }[],
  firstLive: false,
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    // Provider edge of Stop: the run-only abort reached the live session (dispatched).
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
      if (fixture.calls.length === 0 && fixture.onFirst) {
        fixture.calls.push({ runId, ok: false, firstLive: true });
        fixture.firstLive = true;
        try { await fixture.onFirst({ runId }); } finally { fixture.firstLive = false; }
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      fixture.calls.push({ runId, ok: true, firstLive: fixture.firstLive });
      // A real chat turn answers with the agent's reply comment from this run (c3-orphan harness).
      const { issueComments } = await import("@paperclipai/db");
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";

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

describe.skipIf(!support.supported)("optS-dd settling: no second execution while the stopped run is still live here", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "settling-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("optS-settling-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "optS-settling-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "settling@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    const writable = async (dir: string): Promise<void> => { const st = await fs.lstat(dir).catch(() => null); if (!st?.isDirectory() || st.isSymbolicLink()) return; await fs.chmod(dir, 0o700); for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }).catch(() => undefined); }
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.OPTS_EVIDENCE) await fs.appendFile(process.env.OPTS_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };
  const carried = (ctx: any): string[] => [...new Set([ctx?.commentId, ctx?.wakeCommentId, ...(ctx?.wakeCommentIds ?? [])]
    .filter(Boolean))];

  /** Held M1-M3, person Stop via the route (acknowledged), then -- while the first turn is STILL inside the
   * provider executor and adapterExecutionControls holds its id -- the person's next action. */
  async function stopThenActWhileLive(action: "send" | "typed") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Settling", issuePrefix, defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active",
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    fixture.calls = []; fixture.firstLive = false;
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
    const post = (body: string) => request(client).post(`/api/issues/${issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    const held: string[] = [];
    let firstRunId = "";
    let stopping: Promise<unknown> | undefined;
    const snapshot = async () => {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(heartbeatRuns.createdAt);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      const [issue] = await db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, issueId));
      return {
        issueExecutionRunId: issue?.executionRunId ?? null,
        runs: runs.map(r => ({ id: r.id, first: r.id === firstRunId, status: r.status, code: r.errorCode,
          finished: !!r.finishedAt, ids: carried(r.contextSnapshot) })),
        wakes: wakes.map(w => ({ id: w.id, status: w.status, runId: w.runId, wait: (w.payload as any)?.executionWait?.reason ?? null,
          ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds ?? null })),
      };
    };
    const live: Record<string, unknown> = {};
    let m4 = "";
    fixture.onFirst = async ({ runId }) => {
      firstRunId = runId;
      for (const body of ["M1 held", "M2 held", "M3 held"]) held.push((await post(body).expect(201)).body.id);
      stopping = request(client).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        return value?.dispatchState === "acknowledged" && row?.status === "cancelled" && !!row?.finishedAt;
      });
      // The brief's execution_settling state: the stopped run's adapter is still controlled in THIS process.
      live.productRegisteredControl = adapterExecutionControls.has(runId);
      const control = createAdapterExecutionControl();
      if (!adapterExecutionControls.has(runId)) adapterExecutionControls.set(runId, control);
      try {
        live.before = await snapshot();
        if (action === "send") {
          const queue = await request(client).get(`/api/issues/${issueId}/queued-comments`).expect(200);
          const sent = await request(client).post(`/api/issues/${issueId}/queued-comments/interrupt`)
            .send({ queueId: queue.body.queueId ?? queue.body.id, targetRunId: runId, revision: queue.body.revision });
          live.sent = { status: sent.status, body: sent.body };
        } else {
          const typed = await post("M4 typed");
          m4 = typed.body.id; live.typed = { status: typed.status, id: m4 };
        }
        // Drive the real scheduler (wake -> claim -> executor) while the first is still live.
        const t0 = Date.now();
        do {
          await heartbeat.resumeQueuedRuns();
          await new Promise(r => setTimeout(r, 150));
        } while (Date.now() - t0 < 4_000);
        live.controlStillHeld = adapterExecutionControls.has(runId);
        live.during = await snapshot();
        live.overlappingCalls = fixture.calls.filter(call => call.ok && call.firstLive).map(call => call.runId);
      } finally {
        if (adapterExecutionControls.get(runId) === control) adapterExecutionControls.delete(runId);
        control.finish();
      }
    };
    try {
      await issueService(db).addComment(issueId, "M0 start", { userId }, { clientRequestId: randomUUID() });
      await deliverConversationComments(db, { id: issueId, companyId, conversationAgentId: agentId }, heartbeat.wakeup);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const stopped = await stopping as { status: number } | undefined;
      expect(stopped?.status, "person Stop route").toBe(200);
    } finally { fixture.onFirst = undefined; }
    expect(firstRunId, "first turn reached the provider").not.toBe("");
    const accepted = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, firstRunId),
      eq(heartbeatRunEvents.message, "run.stop.accepted")));
    expect(accepted.map(row => (row.payload as any)?.kind), "the Stop route wrote the person_stop row").toEqual(["person_stop"]);
    // After the first settles: drive to quiescence and read what eventually ran.
    const t0 = Date.now();
    do {
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      await new Promise(r => setTimeout(r, 150));
    } while (Date.now() - t0 < 4_000);
    const after = await snapshot();
    return { held, m4, live, after, calls: [...fixture.calls] };
  }

  for (const action of ["send", "typed"] as const) {
    it(`${action === "send" ? "S path (Send)" : "typed path (M4)"}: no second provider execution starts while the stopped run is still live`, async () => {
      const r = await stopThenActWhileLive(action);
      await evidence(`settling-${action}`, r);
      const successorsDuringLive = (r.live.overlappingCalls as string[] | undefined) ?? [];
      // A real double run = a second executor entry while the first is still inside its executor.
      expect(successorsDuringLive, `second execution while first live: ${JSON.stringify(r.live.during)}`).toEqual([]);
      expect(r.live.controlStillHeld, "adapter control held for the whole live window").toBe(true);
      if (action === "send") expect((r.live.sent as any)?.status, JSON.stringify(r.live.sent)).toBe(200);
      else expect((r.live.typed as any)?.status).toBe(201);
      // Nothing answered twice after the first settles.
      const successors = r.calls.filter(call => call.ok);
      expect(new Set(successors.map(call => call.runId)).size).toBe(successors.length);
    }, 120_000);
  }
});
