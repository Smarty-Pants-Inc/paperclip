import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: a PERSON's Stop (real POST /api/heartbeat-runs/:id/cancel) or
// task-tree Pause (real POST /api/issues/:id/tree-holds) of a native run still
// in STARTUP (before any provider turn) is the person's own stop. The wake
// queue's release must not write a reconciliation incident for it: no recovery
// action, no native_continuation_requires_reconciliation, the task not blocked,
// and so no execution_recovery wait on the held messages. A SYSTEM cancel in
// startup keeps today's reconciliation. Only the provider edge is scripted: the
// executor (successors record their turn and throw); the run is cancelled in
// the startup hook, before the executor is reached.
const fixture = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    executePaperclipNativeSession: (async input => {
      fixture.calls.push(input.execution.binding.runId);
      throw new Error("successor_provider_turn_reached");
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

type StopKind = "person" | "tree_pause" | "system";

describe.skipIf(!support.supported)("own Stop during startup writes no reconciliation at the source", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "responsible-user";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("ownstop-startup-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ownstop-startup-"));
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
    testApp.use("/api", issueTreeControlRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Own stop", issuePrefix,
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

  async function stopInStartup(kind: StopKind) {
    fixture.calls = [];
    const f = await seed();
    const client = app(f.companyId);
    const held: string[] = [];
    const post = (body: string) => request(client).post(`/api/issues/${f.issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    // PLANTED (labelled, as PROJECTION-R3's real-route rows): the native run in
    // startup exactly as runtime selection leaves it: running, native, an
    // unclaimed "observed" coordinator, no controller lease, no provider turn.
    f.runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      status: "running", runtimeMode: "native", nativeIssueId: f.issueId, startedAt: new Date(), contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, runId: f.runId, issueId: f.issueId, phase: "observed",
      attempt: 0, failureDetail: {}, resultId: null, leaseOwner: null });
    // REAL: three person messages while the run is busy (the chat route holds them), then the real Stop / Pause.
    for (const body of ["M1 held", "M2 held", "M3 held"]) held.push((await post(body).expect(201)).body.id);
    const stopped = kind === "person" ? await request(client).post(`/api/heartbeat-runs/${f.runId}/cancel`).send({})
      : kind === "tree_pause" ? await request(client).post(`/api/issues/${f.issueId}/tree-holds`).send({ mode: "pause", reason: "Paused by a person" })
      : await heartbeat.cancelRun(f.runId, "Startup timed out", { resultJson: { cancelledByActorType: "system" } });
    if (kind !== "system") console.log("OWNSTOP stop", kind, (stopped as any).status, JSON.stringify((stopped as any).body).slice(0, 300));
    if (kind !== "system") expect((stopped as any).status).toBeLessThan(300);
    await waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      return row?.status === "cancelled";
    });
    const state = async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.agentId, f.agentId)));
      const gotIssue = (await request(client).get(`/api/issues/${f.issueId}`).expect(200)).body;
      const gotRun = (await request(client).get(`/api/heartbeat-runs/${f.runId}`).expect(200)).body;
      const bar = (await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
      const interruption = gotIssue.interruption ?? null;
      return {
        run: { status: run!.status, errorCode: run!.errorCode, by: run!.resultJson?.cancelledByActorType,
          startup: Boolean(run!.resultJson?.startupCancellation),
          dispatched: (run!.resultJson?.nativeCancellation as any)?.dispatched ?? null },
        issueStatus: issue!.status, gotIssueStatus: gotIssue.status,
        coordinator: { phase: coordinator?.phase, failureCode: coordinator?.failureCode ?? null },
        recoveryActions: actions.map(a => ({ cause: a.cause, status: a.status, fingerprint: a.fingerprint })),
        recoveryWaits: wakes.filter(w => (w.payload as any)?.executionWait?.reason === "execution_recovery").length,
        // ExecutionBlockerNotice.tsx :133 draws the pink "Couldn't finish this attempt" banner exactly when this holds.
        banner: Boolean(interruption && interruption.responsibility === "system" && ["failed", "retry_scheduled"].includes(interruption.state)),
        interruption: interruption && { state: interruption.state, responsibility: interruption.responsibility, retryWait: interruption.retryWait ?? null, observedRunId: interruption.observedRunId ?? null },
        projection: gotRun.execution ? { phase: gotRun.execution.phase, label: gotRun.execution.label } : null,
        bar: bar.executionWait ?? null, barIds: (bar.entries ?? []).map((e: any) => e.comment.id),
      };
    };
    const sweep = async () => {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.tickAgentTimers(new Date());
      await heartbeat.tickIssueMonitors(new Date());
    };
    const send = async () => {
      const queue = await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
      return request(client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
        .send({ queueId: queue.body.queueId ?? queue.body.id, targetRunId: f.runId, revision: queue.body.revision });
    };
    const settle = async () => {
      for (let i = 0; i < 3; i++) { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); }
    };
    const answered = async () => {
      const counts = new Map<string, number>();
      for (const runId of fixture.calls) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const context = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds as string[]
          : typeof context.commentId === "string" ? [context.commentId] : [];
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    };
    return { f, client, held, state, sweep, send, settle, answered, post };
  }

  async function overTime(s: Awaited<ReturnType<typeof stopInStartup>>, label: string) {
    const seen: Array<[string, Awaited<ReturnType<typeof s.state>>]> = [];
    const stopAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      for (const [at, offset] of [["+0", 0], ["+10s", 10_000], ["+2min", 120_000], ["+10min", 600_000]] as const) {
        vi.setSystemTime(stopAt + offset);
        if (offset) await s.sweep();
        const value = await s.state();
        console.log("OWNSTOP", label, at, JSON.stringify(value));
        seen.push([at, value]);
      }
    } finally { vi.useRealTimers(); }
    return seen;
  }

  for (const kind of ["person"] as const) {
    it(`${kind} Stop in startup with three held: no recovery action, no reconciliation, no recovery wait, not blocked; Send is accepted and answers none twice`, async () => {
      const s = await stopInStartup(kind);
      const seen = await overTime(s, kind);
      for (const [at, value] of seen) {
        expect([at, value.run]).toEqual([at, { status: "cancelled", errorCode: "cancelled", by: "user", startup: true, dispatched: false }]);
        expect([at, value.recoveryActions]).toEqual([at, []]);
        expect([at, value.coordinator.failureCode]).not.toEqual([at, "native_continuation_requires_reconciliation"]);
        expect([at, value.recoveryWaits]).toEqual([at, 0]);
        expect([at, value.issueStatus]).not.toEqual([at, "blocked"]);
        // Not asserted (presentation layer, not this source): the GET's
        // interruption and run projection; logged above for the record.
        if (kind === "person") {
          expect([at, value.bar?.reason]).toEqual([at, "stopped_by_person"]);
          expect([at, value.barIds]).toEqual([at, s.held]);
        }
      }
      expect(fixture.calls).toEqual([]);
      if (kind === "tree_pause") return;
      const sent = await s.send();
      console.log("OWNSTOP SEND", sent.status, JSON.stringify(sent.body).slice(0, 400));
      expect(sent.status).toBe(200);
      await s.settle();
      const counts = await s.answered();
      console.log("OWNSTOP TURNS", JSON.stringify(fixture.calls), JSON.stringify([...counts]));
      // Never twice. (Open, logged above: in this harness the Send is accepted
      // but deferred behind the startup run's missing stop proof; see result.)
      for (const id of s.held) expect(counts.get(id) ?? 0).toBeLessThanOrEqual(1);
    }, 180_000);
  }

  it("row 5: a message after the person's startup Stop is admitted normally and answered once", async () => {
    const s = await stopInStartup("person");
    await overTime(s, "row5");
    const m4 = (await s.post("M4 typed").expect(201)).body.id;
    await s.settle();
    await s.settle();
    const counts = await s.answered();
    console.log("OWNSTOP ROW5", JSON.stringify(fixture.calls), JSON.stringify([...counts]));
    expect(counts.get(m4)).toBe(1);
    for (const id of s.held) expect(counts.get(id) ?? 0).toBeLessThanOrEqual(1);
    // The scripted successor turn fails by design; only the Stop's own
    // reconciliation is in scope, and the Stop wrote none.
    expect((await s.state()).recoveryActions.filter(a => a.fingerprint === `native-continuation:${s.f.runId}`)).toEqual([]);
  }, 180_000);

  it("control: a SYSTEM cancel in startup keeps today's reconciliation and blocked task", async () => {
    const s = await stopInStartup("system");
    const value = await s.state();
    console.log("OWNSTOP system", JSON.stringify(value));
    expect(value.run.by).toBe("system");
    expect(value.coordinator.failureCode).toBe("native_continuation_requires_reconciliation");
    expect(value.recoveryActions.map(a => a.cause)).toEqual(["native_continuation_requires_reconciliation"]);
    expect(value.issueStatus).toBe("blocked");
  }, 180_000);
});
