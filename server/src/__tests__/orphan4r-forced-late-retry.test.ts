import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  agentWakeupRequests, heartbeatRuns, issues, issueComments, nativeRunFinalizations, statusDecisions, statusDecisionEffects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-c3-orphan: a TYPED chat message whose first run FAILS must still be
// answered exactly once. Real chat route (POST /api/issues/:id/comments on a
// conversationAgentId task), real heartbeat admission, release drain and
// recovery. Only the native provider turn is scripted: it throws once.
const fixture = vi.hoisted(() => ({
  calls: [] as { runId: string; ok: boolean }[],
  failNext: 0,
  onFail: undefined as undefined | (() => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
  helperCalls: [] as { runId: string; result: string[] }[], onHelperRead: undefined as undefined | ((runId: string, result: string[]) => Promise<void>),
}));
// THE FORCED ORDER: the hook runs inside the held admission's transaction, after the helper's read
// (queue.ts:5257-5259), before that transaction commits.
vi.mock("../services/continuation-comment-input.js", async importOriginal => {
 const actual = await importOriginal<typeof import("../services/continuation-comment-input.js")>();
 return { ...actual, failedTurnPendingCommentIds: async (db: Parameters<typeof actual.failedTurnPendingCommentIds>[0], input: Parameters<typeof actual.failedTurnPendingCommentIds>[1]) => {
  const result = await actual.failedTurnPendingCommentIds(db, input);
  fixture.helperCalls.push({ runId: input.runId, result });
  const hook = fixture.onHelperRead; if (hook && result.length) { fixture.onHelperRead = undefined; await hook(input.runId, result); }
  return result;
 }};
});
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
import { enqueueWake } from "../services/native-runtime/status-decision-committer.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const out = process.env.TASK_OUT ?? os.tmpdir();

describe.skipIf(!support.supported)("c3 orphan: a typed chat message whose first run fails", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("c3-orphan-"); db = createDb(temp.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "c3-orphan-home-")); process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "orphan-person", name: "Person", email: "orphan@example.invalid", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
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

  it("forced order: helper reads no applied retry, THEN the retry applies, THEN admission commits: M1 answered exactly once", async () => {
    const c = await chat();
    fixture.calls = []; fixture.failNext = 1; fixture.helperCalls = [];
    let m2 = ""; const trace: string[] = []; let applying: Promise<unknown> | null = null; let blocked: unknown = null; let sourceDecision: unknown = null;
    const side = createDb(temp.connectionString);
    fixture.onHelperRead = async (sourceRunId, carriedIds) => {
      trace.push(`helper-read:${carriedIds.join(",")}`);
      applying = side.transaction(async tx => {
        // Same locks, same order as commitNativeStatusDecision (status-decision-committer.ts :1717-1746).
        await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, sourceRunId), eq(nativeRunFinalizations.companyId, c.companyId))).for("update");
        await tx.select().from(issues).where(and(eq(issues.id, c.issueId), eq(issues.companyId, c.companyId))).for("update");
        trace.push("retry-apply-got-locks");
        // The source's applied decision, or (no native decision on this path) one applied now, carrying the
        // schedule_retry effect exactly as status-decision-committer.ts :897-928 and :2721-2752 write it.
        let [decision] = await tx.select().from(statusDecisions).where(eq(statusDecisions.runId, sourceRunId));
        sourceDecision = decision ?? null;
        // On this path the failed source has no native status decision to carry a retry (recorded, asserted below).
        if (!decision) { trace.push("no-source-decision"); return; }
        await tx.update(statusDecisions).set({ applicationState: "applied", appliedAt: new Date() }).where(eq(statusDecisions.id, decision.id));
        const wakeId = await enqueueWake({ tx: tx as never, companyId: c.companyId, issueId: c.issueId, agentId: c.agentId, reason: "issue_status_changed",
          idempotencyKey: `native-status:${decision.id}:retry`, originRunId: sourceRunId,
          payload: { nativeDecisionId: decision.id, retryCause: "forced_late_retry", retrySummary: "forced late retry" } });
        await tx.insert(statusDecisionEffects).values({ companyId: c.companyId, issueId: c.issueId, decisionId: decision.id, ordinal: 100, effectKind: "schedule_retry",
          targetType: "agent_wakeup_request", targetId: wakeId, idempotencyKey: `native-status:${decision.id}:100`,
          payload: { cause: "forced_late_retry", summary: "forced late retry" }, deliveryState: "delivered", attemptCount: 1, deliveredAt: new Date() } as never);
        trace.push("retry-applied");
      }).catch(e => { trace.push("retry-apply-error:" + String(e)); });
      const t0 = Date.now();
      do {
        const waits = await db.execute(sql`select pid, wait_event_type, left(query, 120) as q from pg_stat_activity where wait_event_type = 'Lock'`);
        if ((waits as unknown as unknown[]).length) { blocked = waits; break; }
        await new Promise(r => setTimeout(r, 50));
      } while (Date.now() - t0 < 3_000);
      trace.push(`retry-apply-blocked-while-admission-open:${blocked !== null}`);
    };
    fixture.onFail = async () => { m2 = await c.send("Held: and also this."); };
    const m1 = await c.send("Typed: please answer this.");
    const { runs, wakes } = await sweep(c, 10_000);
    if (applying) await applying;
    const after = await sweep(c, 3_000);
    await side.$client.end({ timeout: 1 });
    fixture.onFail = undefined;
    const counts = answers(after.runs, [m1, m2]);
    const comments = await db.select({ id: issueComments.id, body: issueComments.body, runId: issueComments.createdByRunId, authorType: issueComments.authorType }).from(issueComments).where(eq(issueComments.issueId, c.issueId));
    const notAnswered = comments.filter(row => /wasn.t answered/i.test(row.body));
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, c.issueId));
    await record(`forced-late-retry-${Date.now()}`, { m1, m2, counts, trace, helperCalls: fixture.helperCalls, blocked, sourceDecision, calls: fixture.calls, notAnswered, comments,
      decisions: decisions.map(d => ({ id: d.id, runId: d.runId, applicationState: d.applicationState })),
      runs: after.runs.map(run => ({ id: run.id, status: run.status, carried: carried(run.ctx), wakeIntent: (run.ctx as any)?.nativeStatusWakeIntentId })),
      wakes: after.wakes.map(w => ({ id: w.id, status: w.status, key: w.key, runId: w.runId })) });
    expect(trace[0], "the helper read carried M1").toBe(`helper-read:${m1}`);
    expect(trace.indexOf("retry-apply-got-locks"), "the late apply got its locks only after the admission committed").toBeGreaterThan(trace.indexOf("retry-apply-blocked-while-admission-open:true"));
    expect(trace.some(t => t === "retry-applied" || t === "no-source-decision"), "late apply ran after the read").toBe(true);
    expect(trace).toContain("retry-apply-blocked-while-admission-open:true");
    expect(counts[m1], "M1 answered EXACTLY once").toBe(1);
    expect(counts[m2], "M2 answered exactly once").toBe(1);
    expect(notAnswered, "no 'wasn't answered' notice beside an answer").toHaveLength(0);
  }, 90_000);
});
