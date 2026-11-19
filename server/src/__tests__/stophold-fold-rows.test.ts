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
const fixture = vi.hoisted(() => ({ calls: [] as string[],
  /** F4 only: successor turns answer with one agent reply and succeed (a succeeding provider edge). */
  succeed: undefined as undefined | { db: unknown; companyId: string; agentId: string; issueId: string } }));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    executePaperclipNativeSession: (async input => {
      fixture.calls.push(input.execution.binding.runId);
      if (fixture.succeed) {
        const { issueComments } = await import("@paperclipai/db");
        const target = fixture.succeed;
        await (target.db as any).insert(issueComments).values({ companyId: target.companyId, issueId: target.issueId,
          authorAgentId: target.agentId, authorType: "agent", createdByRunId: input.execution.binding.runId, origin: "comment",
          body: `answer from ${input.execution.binding.runId}` });
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
      }
      throw new Error("successor_provider_turn_reached");
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

/** Row evidence (JSONL) for the caller, when FOLD_EVIDENCE names a file. */
async function evidence(label: string, ...value: unknown[]) {
  if (process.env.FOLD_EVIDENCE) await fs.appendFile(process.env.FOLD_EVIDENCE, JSON.stringify({ label, value }) + "\n");
}

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

type StopKind = "person" | "person_other" | "person_preselect" | "tree_pause" | "system" | "system_preselect";

describe.skipIf(!support.supported)("stophold-fold: the ONE same-person fact and the startup Stop (rf-2 F1/F3/F4, rf-5 G2)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const userId = "responsible-user";
  const otherUserId = "other-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("ownstop-startup-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ownstop-startup-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: userId, name: "Responsible User",
      email: "responsible-user@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(authUsers).values({ id: otherUserId, name: "Other Person",
      email: "other-person@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  function app(companyId: string, actorUserId = userId) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: actorUserId, companyIds: [companyId],
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
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: otherUserId,
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
      : kind === "person_other" ? await request(app(f.companyId, otherUserId)).post(`/api/heartbeat-runs/${f.runId}/cancel`).send({})
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
    return { f, client, held, state, sweep, send, settle, answered, post, successors, heartbeat, stopped };
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


  // rf-2 F1 (RFL 06:56Z, the ONE same-person fact): B's Stop of A's startup
  // run never gives A's Send the bypass; A's own Stop does (the control).
  for (const kind of ["person_other", "person"] as const) {
    it(`F1 ${kind}: ${kind === "person" ? "A's own" : "B's"} startup Stop of A's run -> A's Send ${kind === "person" ? "starts ONE successor (the bypass)" : "gets NO bypass"}`, async () => {
      const s = await stopInStartup(kind);
      const before = await s.state();
      await evidence("F1", kind, "after-stop", JSON.stringify(before));
      expect(before.run).toMatchObject({ status: "cancelled", errorCode: "cancelled", by: "user", startup: true, beforeNativeSelection: false });
      const sent = await s.send();
      await evidence("F1", kind, "SEND", sent.status, JSON.stringify(sent.body).slice(0, 300));
      const started = (await s.successors()).filter(r => ["queued", "running"].includes(r.status));
      await s.settle();
      if (kind === "person") {
        expect(started.length).toBe(1);
        expect((started[0]!.contextSnapshot as any)?.wakeCommentIds).toEqual(s.held);
        expect(fixture.calls.length).toBe(1);
      } else {
        expect(started).toEqual([]);
        expect(fixture.calls).toEqual([]);
        // The banner reads the same fact: B's Stop is not A's resolved Stop.
        expect((await s.state()).interruption?.state).not.toBe("resolved");
      }
    }, 180_000);
  }

  // rf-2 F3: ONE fact for both callers. A Stop before native selection: the
  // banner never resolves a run the Send won't admit, and they agree.
  it("F3: a pre-selection person Stop -> the banner and Send agree (no resolved banner over a Send that starts nothing)", async () => {
    const s = await stopInStartup("person_preselect");
    const before = await s.state();
    await evidence("F3 after-stop", JSON.stringify(before));
    expect(before.run).toMatchObject({ status: "cancelled", startup: true, beforeNativeSelection: true });
    const { isPersonAcceptedStartupStop } = await import("../services/acknowledged-native-stop.js");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.runId));
    const fact = await isPersonAcceptedStartupStop(db as any, { ...run!, issueId: s.f.issueId });
    const sent = await s.send();
    await evidence("F3 SEND", sent.status, JSON.stringify(sent.body).slice(0, 300));
    await s.settle();
    const started = await s.successors();
    const after = await s.state();
    await evidence("F3 after-send", fact, started.length, JSON.stringify(after.interruption));
    expect(fact).toBe(false);
    // Agreement: a resolved banner only where the Send starts the successor.
    expect([before.interruption?.state === "resolved", after.interruption?.state === "resolved"].some(Boolean))
      .toBe(started.length > 0);
  }, 180_000);

  // rf-2 F4: P2 tree Pause in startup, then the real release (wakeAgents):
  // each held message is delivered once.
  it("F4: startup tree Pause -> real release (wakeAgents) -> each held answered once, in one successor", async () => {
    const s = await stopInStartup("tree_pause");
    fixture.succeed = { db, companyId: s.f.companyId, agentId: s.f.agentId, issueId: s.f.issueId };
    try {
    const holdId = (s.stopped as any).body?.hold?.id ?? (s.stopped as any).body?.id;
    expect(typeof holdId).toBe("string");
    await s.sweep();
    expect(fixture.calls).toEqual([]);
    const released = await request(s.client).post(`/api/issues/${s.f.issueId}/tree-holds/${holdId}/release`)
      .send({ reason: "Resume", metadata: { wakeAgents: true } });
    await evidence("F4 RELEASE", released.status, JSON.stringify(released.body).slice(0, 400));
    expect(released.status).toBeLessThan(300);
    await s.settle(); await s.sweep(); await s.settle();
    const runs = (await s.successors()).map(r => ({ id: r.id, status: r.status, reason: (r.contextSnapshot as any)?.wakeReason,
      ids: (r.contextSnapshot as any)?.wakeCommentIds ?? [] }));
    const counts = await s.answered();
    const wakesAfter = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.f.companyId));
    await evidence("F4 WAKES", JSON.stringify(wakesAfter.map(w => ({ id: w.id, status: w.status, reason: w.reason, runId: w.runId,
      error: w.error, wait: (w.payload as any)?.executionWait?.reason ?? null, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds
        ?? (w.payload as any)?.commentId ?? null }))));
    await evidence("F4 RUNS", JSON.stringify(runs), JSON.stringify([...counts]), JSON.stringify(fixture.calls));
    for (const id of s.held) expect([id, counts.get(id) ?? 0]).toEqual([id, 1]);
    } finally { fixture.succeed = undefined; }
  }, 180_000);

  // rf-5 G2: chat, 3 messages typed during startup (3 queues) -> startup Stop
  // -> the bar -> each entry deletable -> Send -> ONE run with all 3, once each.
  it("G2: chat, 3 typed during startup -> startup Stop gathers them like the mid-turn Stop: one queue, each deletable, Send -> ONE run with all 3", async () => {
    const s = await stopInStartup("person");
    const bar = (await request(s.client).get(`/api/issues/${s.f.issueId}/queued-comments`).expect(200)).body;
    await evidence("G2 BAR", JSON.stringify({ wait: bar.executionWait, queueId: bar.queueId,
      entries: (bar.entries ?? []).map((e: any) => ({ id: e.comment.id, canDiscard: e.canDiscard, queueId: e.queueId ?? null })) }));
    expect(bar.executionWait?.reason).toBe("stopped_by_person");
    expect((bar.entries ?? []).map((e: any) => e.comment.id)).toEqual(s.held);
    for (const entry of bar.entries) expect([entry.comment.id, entry.canDiscard]).toEqual([entry.comment.id, true]);
    // Gathered at the source: one deferred wake carries all three.
    const waiting = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, s.f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"))));
    expect(waiting.length).toBe(1);
    const sent = await s.send();
    expect(sent.status).toBe(200);
    const started = await s.successors();
    expect(started.length).toBe(1);
    expect((started[0]!.contextSnapshot as any)?.wakeCommentIds).toEqual(s.held);
    await s.settle(); await s.sweep(); await s.settle();
    const counts = await s.answered();
    for (const id of s.held) expect(counts.get(id)).toBe(1);
    expect((await s.successors()).length).toBe(1);
  }, 180_000);
});
