import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  agentWakeupRequests, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Scenario copied unchanged from adopt-c3-orphan RED 989c7da5; notice acceptance is separate.
// adopt-c3-orphan: a TYPED chat message whose first run FAILS must still be
// answered exactly once. Real chat route (POST /api/issues/:id/comments on a
// conversationAgentId task), real heartbeat admission, release drain and
// recovery. Only the native provider turn is scripted: it throws once.
const fixture = vi.hoisted(() => ({
  calls: [] as { runId: string; ok: boolean }[],
  failNext: 0,
  onFail: undefined as undefined | (() => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      if (fixture.failNext > 0) {
        fixture.failNext -= 1;
        await fixture.onFail?.();
        // What a real runner exit leaves: the server's verified local process stop.
        const { appendHeartbeatRunEvent } = await import("../services/heartbeat-run-events.js");
        await appendHeartbeatRunEvent(fixture.db as never, { companyId: fixture.companyId, runId, agentId: fixture.agentId,
          eventType: "native.local_process_stopped", stream: "system", level: "info", message: "fixture: provider process exited", payload: {} } as never);
        fixture.calls.push({ runId, ok: false });
        throw new Error("c3_orphan_provider_failed_once");
      }
      fixture.calls.push({ runId, ok: true });
      // A real chat turn answers with the agent's reply comment from this run.
      const { issueComments } = await import("@paperclipai/db");
      await (fixture.db as any).insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.agentId, authorType: "agent", createdByRunId: runId, origin: "comment", body: `answer from ${runId}` });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
    }) as typeof actual.executePaperclipNativeSession };
});
import { heartbeatService } from "../services/heartbeat.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const out = process.env.TASK_OUT ?? os.tmpdir();

describe("RFL started-run notice wording: real typed-chat orphan", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    expect(support.supported, support.reason ?? "real PostgreSQL required").toBe(true);
    temp = await startEmbeddedPostgresTestDatabase("c3-orphan-"); db = createDb(temp.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "c3-orphan-home-")); process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "orphan-person", name: "Person", email: "orphan@example.invalid", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.useRealTimers(); fixture.onFail = undefined; });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 }); await temp?.cleanup();
    const writable = async (dir: string): Promise<void> => { const st = await fs.lstat(dir).catch(() => null); if (!st?.isDirectory() || st.isSymbolicLink()) return; await fs.chmod(dir, 0o700); for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }); }
  });

  async function chat() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Orphan", issuePrefix: `O${companyId.slice(0, 6)}`, defaultResponsibleUserId: "orphan-person", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "orphan-person", membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_review", priority: "medium", assigneeAgentId: agentId,
      responsibleUserId: "orphan-person", issueNumber: 1, identifier: `O${companyId.slice(0, 6)}-1`,
      conversationAgentId: agentId, conversationUserId: "orphan-person", conversationState: "waiting" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "orphan-person", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use("/api", issueRoutes(db, {} as any, {})); app.use(errorHandler);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const send = async (body: string) => {
      const sent = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      return sent.body.id as string;
    };
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId;
    return { companyId, agentId, issueId, app, heartbeat, send };
  }

  async function sweep(c: Awaited<ReturnType<typeof chat>>, ms: number) {
    const t0 = Date.now();
    do {
      await c.heartbeat.resumeQueuedRuns(); await c.heartbeat.drainActiveRunExecutions();
      // The issue-recovery coordinator's `stranded` step (heartbeat.ts registerIssueStateRecoveryWork),
      // which delivers the chat outbox (recovery/service.ts deliverConversationComments).
      await c.heartbeat.reconcileStrandedAssignedIssues({ companyId: c.companyId, issueId: c.issueId, skipExternalConversationSettlement: true, skipRelatedRecovery: true });
      await new Promise(r => setTimeout(r, 200));
    } while (Date.now() - t0 < ms);
    const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, ctx: heartbeatRuns.contextSnapshot, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns).where(eq(heartbeatRuns.issueId, c.issueId)).orderBy(heartbeatRuns.createdAt);
    const wakes = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, key: agentWakeupRequests.idempotencyKey, payload: agentWakeupRequests.payload, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, c.companyId));
    return { runs, wakes };
  }
  const carried = (ctx: any): string[] => [...new Set([ctx?.commentId, ctx?.wakeCommentId, ...(ctx?.wakeCommentIds ?? [])].filter(Boolean))];
  /** How many SUCCESSFUL provider turns carried each comment. */
  function answers(runs: { id: string; ctx: any }[], ids: string[]) {
    const ok = new Set(fixture.calls.filter(call => call.ok).map(call => call.runId));
    return Object.fromEntries(ids.map(id => [id, runs.filter(run => ok.has(run.id) && carried(run.ctx).includes(id)).length]));
  }
  async function record(label: string, data: unknown) {
    await fs.writeFile(path.join(out, `c3-orphan-${label}.json`), JSON.stringify(data, null, 2));
  }

  const STARTED = "Your message wasn't answered. Check the task's recent history before trying again; the run may have taken actions.";
  const NO_RUN = "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
  const notes = (c: Awaited<ReturnType<typeof chat>>) => db.select().from(issueComments).where(and(
    eq(issueComments.issueId, c.issueId), eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));
  async function tick(c: Awaited<ReturnType<typeof chat>>, at: number) {
    // Family's Date-only clock: PG, route, admission, I/O and sweep are real.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at);
    await c.heartbeat.reconcileStrandedAssignedIssues({ companyId: c.companyId, issueId: c.issueId,
      unanswered: true, skipExternalConversationSettlement: true, skipRelatedRecovery: true });
  }

  it("supersedes(M1 STARTED and FAILED, later run answers only M2: ONE true started-run notice within 60s, no Retry, no double; RFL R2-1 rulings 11-18 12:06Z: the card and notice read decideRetryAuthority)", async () => {
    const c = await chat();
    fixture.calls = []; fixture.failNext = 1;
    let m2 = "";
    fixture.onFail = async () => { m2 = await c.send("Held: and also this."); };
    const m1 = await c.send("Typed: please answer this.");
    await sweep(c, 3_000);
    fixture.onFail = undefined;
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, c.companyId)).orderBy(heartbeatRuns.createdAt);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.startedAt, "M1's own run really STARTED").not.toBeNull();
    expect(carried(runs[0]!.contextSnapshot)).toEqual([m1]);
    expect(runs[1]!.status).toBe("succeeded");
    expect(carried(runs[1]!.contextSnapshot)).toEqual([m2]);
    expect(answers(runs.map(r => ({ id: r.id, ctx: r.contextSnapshot })), [m1, m2])).toEqual({ [m1]: 0, [m2]: 1 });
    const t0 = Date.now();
    let firstNoticeAt: number | null = null;
    for (let elapsed = 0; elapsed <= 60_000; elapsed += 5_000) {
      await tick(c, t0 + elapsed);
      const visible = await notes(c);
      expect(visible.length, "no double on any tick").toBeLessThanOrEqual(1);
      if (visible.length && firstNoticeAt === null) firstNoticeAt = elapsed;
    }
    const visible = await notes(c);
    const view = await request(c.app).get(`/api/issues/${c.issueId}`);
    await record("wording-started", { m1, m2, firstNoticeAt, runs, visible, interruption: view.body.interruption });
    expect(firstNoticeAt).not.toBeNull();
    expect(firstNoticeAt!).toBeLessThanOrEqual(60_000);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${m1}`);
    expect(visible[0]!.body).toBe(STARTED);
    expect(visible.filter(n => n.metadata?.authorizationReason === `unanswered_message:${m2}`)).toEqual([]);
    // supersedes("No Retry action in the note; the interruption disables Retry controls";
    // RFL record PENDING: rf-5 R2-1, e7cac008): the started-run BODY is unchanged
    // (asserted above); the note's Next action and the card are the one Retry
    // authority's personMessageOwed decision (orphan-m2-held-retry-surface.test.ts).
    const nextAction = ((visible[0]!.metadata as any)?.sections ?? []).flatMap((section: any) => section.rows ?? [])
      .find((entry: any) => entry.label === "Next action")?.value ?? null;
    expect(nextAction).toBe("Press Retry to answer it.");
    expect(view.status).toBe(200);
    expect(view.body.interruption.canRetry).toBe(true);
    expect(view.body.interruption.notice?.text).toBe("An earlier message wasn't answered. Press Retry to answer it.");
    expect(view.body.interruption.userAction).toBeNull();
    const id = visible[0]!.id;
    await tick(c, t0 + 120_000);
    expect((await notes(c)).map(n => ({ id: n.id, body: n.body }))).toEqual([{ id, body: STARTED }]);
  }, 60_000);

  it("NO run ever started for the message: exactly ONE unchanged NO_RUN notice", async () => {
    const c = await chat();
    fixture.calls = []; fixture.failNext = 0; fixture.onFail = undefined;
    // A saved route message with wake-on-demand disabled has no carrying run.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } } }).where(eq(agents.id, c.agentId));
    const m = await c.send("Typed: saved but never started.");
    await c.heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, c.companyId))).toHaveLength(0);
    const t0 = Date.now();
    await tick(c, t0 + 120_001);
    await tick(c, t0 + 180_000);
    const visible = await notes(c);
    await record("wording-no-run", { m, visible });
    expect(visible).toHaveLength(1);
    expect(visible[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${m}`);
    expect(visible[0]!.body).toBe(NO_RUN);
  }, 60_000);
});
