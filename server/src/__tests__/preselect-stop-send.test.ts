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

// Keep reason: a PERSON's Stop (real POST /api/heartbeat-runs/:id/cancel) of a
// native-bound (paperclip_runner) agent's run BEFORE native selection
// (runtimeMode still the 'legacy' default, run-control beforeNativeSelection)
// is that person's own stop, settled as the native startup Stop is: no legacy
// reconciliation, no recovery action, the task not blocked, the held messages
// gathered, and the person's Send starts ONE run carrying all of them in
// order. A SYSTEM pre-selection cancel and a direct-adapter legacy agent keep
// today's legacy path. Only the provider edge is scripted: the executor
// (successors record their turn and throw).
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

type StopKind = "person" | "person_preselect" | "tree_pause" | "system" | "system_preselect" | "direct_preselect";

describe.skipIf(!support.supported)("own Stop before native selection: settled as the startup Stop; Send starts one run with all held", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "responsible-user";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("preselect-stop-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "preselect-stop-"));
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

  async function seed(adapterType = "paperclip_runner") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Own stop", issuePrefix,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi worker", role: "engineer", status: "idle",
      adapterType, adapterConfig: adapterType === "paperclip_runner" ? { provider: "codex", model: "gpt-5.6-luna" } : { command: "true" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active",
      responsibleUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    return { companyId, agentId, issueId, runId: "" };
  }

  async function stopInStartup(kind: StopKind) {
    fixture.calls = [];
    const f = await seed(kind === "direct_preselect" ? "process" : "paperclip_runner");
    const client = app(f.companyId);
    const held: string[] = [];
    const post = (body: string) => request(client).post(`/api/issues/${f.issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    // PLANTED (labelled, as PROJECTION-R3's real-route rows): the native run in
    // startup exactly as runtime selection leaves it: running, native, an
    // unclaimed "observed" coordinator, no controller lease, no provider turn.
    f.runId = randomUUID();
    const preselect = kind === "person_preselect" || kind === "system_preselect" || kind === "direct_preselect";
    if (preselect) {
      // PLANTED: before native selection (run-control :1489 beforeNativeSelection):
      // runtimeMode still the 'legacy' default, runtimeModeResolvedAt null, preparing, no coordinator.
      await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
        status: "running", runtimeMode: "legacy", executionStage: "preparing", startedAt: new Date(),
        runnerProfileJson: { adapterDispatch: { adapterType: kind === "direct_preselect" ? "process" : "paperclip_runner" } }, contextSnapshot: { issueId: f.issueId } });
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
    const stopped = kind === "person" || kind === "person_preselect" || kind === "direct_preselect" ? await request(client).post(`/api/heartbeat-runs/${f.runId}/cancel`).send({})
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
    // Provider turns of THIS row's agent only (a run left by another row is not this row's turn).
    const turns = async () => { const mine = new Set((await successors()).map(run => run.id));
      return fixture.calls.filter(id => mine.has(id)); };
    return { f, client, held, state, sweep, send, settle, answered, post, successors, turns, heartbeat };
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


  const failedRetry = (value: { interruption: { state: string; canRetry: boolean | null } | null }) =>
    value.interruption?.state === "failed" && value.interruption?.canRetry === true;

  // R16-pre + banner: a person's own Stop BEFORE native selection, three held.
  // 0 recovery actions, task not blocked, the bar holds the 3 in order, no
  // self-start through +10 s/+2/+10 min (clock advanced, sweeps run), the GET
  // interruption is never {failed, canRetry} and the banner and Send agree (the
  // bar offers Send, no banner). Then the real Send: ONE run with [M1, M2, M3]
  // in order, each answered once, no second run.
  it("R16-pre: pre-selection person Stop + 3 held -> settled, no self-start for 10 min, Send -> ONE run [M1,M2,M3]", async () => {
    const s = await stopInStartup("person_preselect");
    const before = await s.state();
    console.log("R16-pre after-stop", JSON.stringify(before));
    expect(before.run).toMatchObject({ status: "cancelled", errorCode: "cancelled", by: "user", startup: true,
      beforeNativeSelection: true });
    expect(before.recoveryActions).toEqual([]);
    expect(before.issueStatus).not.toBe("blocked");
    expect(before.barIds).toEqual(s.held);
    const seen = await overTime(s, "r16-pre");
    for (const [at, value] of seen) {
      expect([at, value.recoveryActions]).toEqual([at, []]);
      expect([at, value.issueStatus]).not.toEqual([at, "blocked"]);
      expect([at, value.barIds]).toEqual([at, s.held]);
      // One fact: the bar offers Send for the person's Stop and no banner says it failed.
      expect([at, value.bar?.reason ?? null]).toEqual([at, "stopped_by_person"]);
      expect([at, value.banner]).toEqual([at, false]);
      expect([at, failedRetry(value)]).toEqual([at, false]);
      expect([at, (await s.successors()).length]).toEqual([at, 0]);
    }
    expect(await s.turns()).toEqual([]);
    const sentAt = Date.now();
    const sent = await s.send();
    console.log("R16-pre SEND", sent.status, JSON.stringify(sent.body).slice(0, 300));
    expect(sent.status).toBe(200);
    const started = await s.successors();
    console.log("R16-pre successors", Date.now() - sentAt, "ms", JSON.stringify(started.map(r => ({ id: r.id, status: r.status,
      wakeCommentIds: (r.contextSnapshot as any)?.wakeCommentIds }))));
    expect(started.length).toBe(1);
    expect(["queued", "running"]).toContain(started[0]!.status);
    expect((started[0]!.contextSnapshot as any)?.wakeCommentIds).toEqual(s.held);
    await s.settle();
    await s.sweep();
    await s.settle();
    const counts = await s.answered();
    console.log("R16-pre TURNS", JSON.stringify(fixture.calls), JSON.stringify([...counts]));
    for (const id of s.held) expect(counts.get(id)).toBe(1);
    expect((await s.turns()).length).toBe(1);
    expect((await s.successors()).length).toBe(1);
  }, 240_000);

  // Control: a SYSTEM cancel before native selection keeps today's legacy reconciliation.
  it("control: SYSTEM pre-selection cancel keeps legacy_execution_requires_reconciliation; Send starts no run", async () => {
    const s = await stopInStartup("system_preselect");
    const value = await s.state();
    console.log("SYS-pre", JSON.stringify(value));
    expect(value.run).toMatchObject({ by: "system", beforeNativeSelection: true });
    expect(value.recoveryActions.map(a => a.cause)).toEqual(["legacy_execution_requires_reconciliation"]);
    const sent = await s.send();
    console.log("SYS-pre SEND", sent.status, JSON.stringify(sent.body).slice(0, 300));
    expect((await s.successors()).filter(r => ["queued", "running"].includes(r.status))).toEqual([]);
    await s.settle();
    expect(await s.turns()).toEqual([]);
    expect((await s.state()).recoveryActions.map(a => a.cause)).toEqual(["legacy_execution_requires_reconciliation"]);
  }, 180_000);

  // Control: a truly legacy (direct adapter) agent's run keeps today's path:
  // no beforeNativeSelection, the legacy reconciliation, the messages not gathered.
  it("control: a direct-adapter legacy agent's person Stop keeps today's legacy path", async () => {
    const s = await stopInStartup("direct_preselect");
    const value = await s.state();
    console.log("DIRECT-pre", JSON.stringify(value));
    expect(value.run).toMatchObject({ by: "user", beforeNativeSelection: false });
    expect(value.recoveryActions.map(a => a.cause)).toEqual(["legacy_execution_requires_reconciliation"]);
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, s.f.companyId),
      eq(agentWakeupRequests.agentId, s.f.agentId)));
    expect(wakes.filter(w => w.status === "coalesced")).toEqual([]);
  }, 180_000);

  // Control: a person's Stop of ANOTHER run: the person stopped the earlier
  // pre-selection run; the task's latest run was then cancelled by the system.
  // The reader names no person Stop of the latest run, so Send does not bypass.
  it("control: a person's pre-selection Stop of another run -> no bypass for this run", async () => {
    const s = await stopInStartup("person_preselect");
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: s.f.companyId, agentId: s.f.agentId, invocationSource: "on_demand",
      status: "running", runtimeMode: "legacy", executionStage: "preparing", startedAt: new Date(),
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } }, contextSnapshot: { issueId: s.f.issueId } });
    await db.update(issues).set({ executionRunId: otherRunId, checkoutRunId: otherRunId }).where(eq(issues.id, s.f.issueId));
    await s.heartbeat.cancelRun(otherRunId, "Startup timed out", { expectedStatus: "running", resultJson: { cancelledByActorType: "system" } } as any);
    await waitFor(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRunId)))[0]?.status === "cancelled");
    const sent = await s.send();
    console.log("D-pre SEND", sent.status, JSON.stringify(sent.body).slice(0, 300));
    expect((await s.successors()).filter(r => r.id !== otherRunId && ["queued", "running"].includes(r.status))).toEqual([]);
    await s.settle();
    expect(await s.turns()).toEqual([]);
  }, 180_000);
});
