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

type StopKind = "person" | "person_preselect" | "tree_pause" | "system" | "system_preselect";

describe.skipIf(!support.supported)("own Stop during startup: Send starts one successor; the projection is resolved", () => {
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
    const preselect = kind === "person_preselect" || kind === "system_preselect";
    if (preselect) {
      // PLANTED: before native selection (run-control :1489 beforeNativeSelection):
      // runtimeMode still the 'legacy' default, runtimeModeResolvedAt null, preparing, no coordinator.
      await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
        status: "running", runtimeMode: "legacy", executionStage: "preparing", startedAt: new Date(),
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } }, contextSnapshot: { issueId: f.issueId } });
      await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    } else {
    await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      status: "running", runtimeMode: "native", nativeIssueId: f.issueId, startedAt: new Date(), contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, runId: f.runId, issueId: f.issueId, phase: "observed",
      attempt: 0, failureDetail: {}, resultId: null, leaseOwner: null });
    }
    // REAL: three person messages while the run is busy (the chat route holds them), then the real Stop / Pause.
    for (const body of ["M1 held", "M2 held", "M3 held"]) held.push((await post(body).expect(201)).body.id);
    const system = kind === "system" || kind === "system_preselect";
    const stopped = kind === "person" || kind === "person_preselect" ? await request(client).post(`/api/heartbeat-runs/${f.runId}/cancel`).send({})
      : kind === "tree_pause" ? await request(client).post(`/api/issues/${f.issueId}/tree-holds`).send({ mode: "pause", reason: "Paused by a person" })
      : await heartbeat.cancelRun(f.runId, "Startup timed out", { expectedStatus: "running", resultJson: { cancelledByActorType: "system" } } as any);
    if (!system) console.log("OWNSTOP stop", kind, (stopped as any).status, JSON.stringify((stopped as any).body).slice(0, 300));
    if (!system) expect((stopped as any).status).toBeLessThan(300);
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
          beforeNativeSelection: (run!.resultJson?.startupCancellation as any)?.beforeNativeSelection ?? null,
          dispatched: (run!.resultJson?.nativeCancellation as any)?.dispatched ?? null },
        issueStatus: issue!.status, gotIssueStatus: gotIssue.status,
        coordinator: { phase: coordinator?.phase, failureCode: coordinator?.failureCode ?? null },
        recoveryActions: actions.map(a => ({ cause: a.cause, status: a.status, fingerprint: a.fingerprint })),
        recoveryWaits: wakes.filter(w => (w.payload as any)?.executionWait?.reason === "execution_recovery").length,
        // ExecutionBlockerNotice.tsx :133 draws the pink "Couldn't finish this attempt" banner exactly when this holds.
        banner: Boolean(interruption && interruption.responsibility === "system" && ["failed", "retry_scheduled"].includes(interruption.state)),
        interruption: interruption && { state: interruption.state, canRetry: interruption.canRetry ?? null, responsibility: interruption.responsibility, retryWait: interruption.retryWait ?? null, observedRunId: interruption.observedRunId ?? null },
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
    const successors = async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.agentId, f.agentId)))).filter(run => run.id !== f.runId);
    return { f, client, held, state, sweep, send, settle, answered, post, successors, heartbeat };
  }

  async function overTime(s: Awaited<ReturnType<typeof stopInStartup>>, label: string,
    offsets: ReadonlyArray<readonly [string, number]> = [["+0", 0], ["+10s", 10_000], ["+2min", 120_000], ["+10min", 600_000]]) {
    const seen: Array<[string, Awaited<ReturnType<typeof s.state>>]> = [];
    const stopAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      for (const [at, offset] of offsets) {
        vi.setSystemTime(stopAt + offset);
        if (offset) await s.sweep();
        const value = await s.state();
        console.log("OWNSTOP", label, at, JSON.stringify(value));
        seen.push([at, value]);
      }
    } finally { vi.useRealTimers(); }
    return seen;
  }


  // R16: a person's own Stop of a native run in startup (after native
  // selection), three held, then the real Send: ONE successor starts within
  // seconds carrying the three in order, each held message is answered once,
  // and no second run follows. (Before native selection, "person_preselect",
  // is not covered here: its release never reaches the person-Stop branch.)
  for (const kind of ["person"] as const) {
    it(`R16 ${kind}: startup Stop + 3 held -> Send starts ONE successor with the 3 in order, each answered once`, async () => {
      const s = await stopInStartup(kind);
      const before = await s.state();
      console.log("R16", kind, "after-stop", JSON.stringify(before));
      expect(before.run).toMatchObject({ status: "cancelled", errorCode: "cancelled", by: "user", startup: true,
        beforeNativeSelection: false });
      expect(before.barIds).toEqual(s.held);
      await s.sweep();
      expect(fixture.calls).toEqual([]);
      const sentAt = Date.now();
      const sent = await s.send();
      console.log("R16", kind, "SEND", sent.status, JSON.stringify(sent.body).slice(0, 300));
      expect(sent.status).toBe(200);
      const started = await s.successors();
      console.log("R16", kind, "successors", Date.now() - sentAt, "ms", JSON.stringify(started.map(r => ({ id: r.id, status: r.status,
        wakeCommentIds: (r.contextSnapshot as any)?.wakeCommentIds, commentId: (r.contextSnapshot as any)?.wakeCommentId }))));
      expect(started.length).toBe(1);
      expect(["queued", "running"]).toContain(started[0]!.status);
      expect(Date.now() - sentAt).toBeLessThan(5_000);
      expect((started[0]!.contextSnapshot as any)?.wakeCommentIds).toEqual(s.held);
      await s.settle();
      await s.sweep();
      await s.settle();
      const counts = await s.answered();
      console.log("R16", kind, "TURNS", JSON.stringify(fixture.calls), JSON.stringify([...counts]));
      for (const id of s.held) expect(counts.get(id)).toBe(1);
      expect(fixture.calls.length).toBe(1);
      expect((await s.successors()).length).toBe(1);
    }, 180_000);
  }

  // (e) banner rows from the real GET issue.interruption.
  it("(e) person startup Stop + 3 held: interruption is NOT {failed, canRetry} at +10 s/+2/+10 min", async () => {
    const s = await stopInStartup("person");
    const seen = await overTime(s, "e-person");
    for (const [at, value] of seen.slice(1)) {
      expect([at, value.banner]).toEqual([at, false]);
      expect([at, value.interruption?.state === "failed" && value.interruption?.canRetry === true]).toEqual([at, false]);
    }
  }, 180_000);

  it("(e) control: a SYSTEM startup cancel keeps {failed, canRetry}", async () => {
    const s = await stopInStartup("system");
    const seen = await overTime(s, "e-system", [["+0", 0], ["+10s", 10_000]]);
    const [, at10] = seen[1]!;
    expect(at10.interruption).toMatchObject({ state: "failed", canRetry: true, responsibility: "system" });
  }, 180_000);

  // (c) a SYSTEM cancel in startup: Send does not bypass its recovery.
  it("(c) control: SYSTEM startup cancel -> Send starts no run and the recovery stays", async () => {
    const s = await stopInStartup("system");
    const before = await s.state();
    expect(before.recoveryActions.map(a => a.cause)).toEqual(["native_continuation_requires_reconciliation"]);
    const sent = await s.send();
    console.log("C SEND", sent.status, JSON.stringify(sent.body).slice(0, 300));
    const started = (await s.successors()).filter(r => ["queued", "running"].includes(r.status));
    console.log("C successors", JSON.stringify(started.map(r => r.status)));
    expect(started).toEqual([]);
    await s.settle();
    expect(fixture.calls).toEqual([]);
    expect((await s.state()).recoveryActions.map(a => a.cause)).toEqual(["native_continuation_requires_reconciliation"]);
  }, 180_000);

  // (d) a person's Stop that is not of THIS run: the person stopped an earlier
  // startup run; the task's latest run was then cancelled by the system. The
  // reader names no person Stop of the latest run, so Send does not bypass.
  it("(d) control: a person's Stop of another run -> no bypass for this run", async () => {
    const s = await stopInStartup("person");
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: s.f.companyId, agentId: s.f.agentId, invocationSource: "on_demand",
      status: "running", runtimeMode: "native", nativeIssueId: s.f.issueId, startedAt: new Date(), contextSnapshot: { issueId: s.f.issueId } });
    await db.update(issues).set({ executionRunId: otherRunId, checkoutRunId: otherRunId }).where(eq(issues.id, s.f.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId: s.f.companyId, runId: otherRunId, issueId: s.f.issueId, phase: "observed",
      attempt: 0, failureDetail: {}, resultId: null, leaseOwner: null });
    await s.heartbeat.cancelRun(otherRunId, "Startup timed out", { expectedStatus: "running", resultJson: { cancelledByActorType: "system" } } as any);
    await waitFor(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRunId)))[0]?.status === "cancelled");
    const sent = await s.send();
    console.log("D SEND", sent.status, JSON.stringify(sent.body).slice(0, 300));
    const started = (await s.successors()).filter(r => r.id !== otherRunId && ["queued", "running"].includes(r.status));
    expect(started).toEqual([]);
    await s.settle();
    expect(fixture.calls).toEqual([]);
  }, 180_000);

  // P2: a person's task-tree Pause of a native run in startup.
  it("P2 tree Pause in startup: 0 recovery actions, not blocked at +0/+30 s/+2 min, projection resolved (no banner)", async () => {
    const s = await stopInStartup("tree_pause");
    const seen = await overTime(s, "p2", [["+0", 0], ["+30s", 30_000], ["+2min", 120_000]]);
    for (const [at, value] of seen) {
      expect([at, value.run]).toMatchObject([at, { status: "cancelled", errorCode: "cancelled", by: "user", startup: true }]);
      expect([at, value.recoveryActions]).toEqual([at, []]);
      expect([at, value.issueStatus]).not.toEqual([at, "blocked"]);
      expect([at, value.banner]).toEqual([at, false]);
    }
    expect(fixture.calls).toEqual([]);
  }, 180_000);

  it("P2 control: a SYSTEM startup cancel keeps today's reconciliation and blocked task", async () => {
    const s = await stopInStartup("system");
    const value = await s.state();
    console.log("P2 system", JSON.stringify(value));
    expect(value.run.by).toBe("system");
    expect(value.coordinator.failureCode).toBe("native_continuation_requires_reconciliation");
    expect(value.recoveryActions.map(a => a.cause)).toEqual(["native_continuation_requires_reconciliation"]);
    expect(value.issueStatus).toBe("blocked");
  }, 180_000);
});
