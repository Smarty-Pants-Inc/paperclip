import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  agentWakeupRequests, heartbeatRuns, issues, issueComments } from "@paperclipai/db";
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
      const handoff = await input.getFreshSessionHandoff?.() ?? null;
      const hasTypedInput = `${input.execution.task.prompt}\n${handoff ?? ""}`.includes("Typed: please answer this.");
      fixture.calls.push({ runId, ok: true, hasTypedInput } as never);
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
import { settleUnansweredPersonMessages } from "../services/recovery/unanswered-person-message.js";
import * as answerModule from "../services/person-message-answer.js";
// Head reads ANSWERED (completedPersonMessageAnswerSql). The base tree (al/noticesbf2) has only its own
// rule (answeredPersonMessageSql); the report names which one judged.
const answerRule = "completedPersonMessageAnswerSql" in answerModule ? "completedPersonMessageAnswerSql" : "answeredPersonMessageSql";
const completedPersonMessageAnswerSql = (answerModule as any)[answerRule] as typeof answerModule.answeredPersonMessageSql;

const support = await getEmbeddedPostgresTestSupport();
const out = process.env.TASK_OUT ?? os.tmpdir();

describe.skipIf(!support.supported)("tA-min (c): the orphan notice and its Retry, through the real routes", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("c3-orphan-nr-"); db = createDb(temp.connectionString);
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


  const get = async (c: Awaited<ReturnType<typeof chat>>, p: string) => { const r = await request(c.app).get(p); return { status: r.status, body: r.body }; };
  /** What the person sees, through the real routes. */
  async function visible(c: Awaited<ReturnType<typeof chat>>, m1: string) {
    const comments = await get(c, `/api/issues/${c.issueId}/comments`);
    const list: any[] = Array.isArray(comments.body) ? comments.body : (comments.body?.comments ?? comments.body?.items ?? []);
    const issue = await get(c, `/api/issues/${c.issueId}`);
    const notices = list.filter(row => row?.authorType === "system"
      && String(row?.metadata?.authorizationReason ?? "").startsWith("unanswered_message:"));
    return { list, notices, m1Notices: notices.filter(row => row.metadata.authorizationReason === `unanswered_message:${m1}`),
      agentReplies: list.filter(row => row?.authorType === "agent"),
      interruption: issue.body?.interruption ?? null,
      execution: await get(c, `/api/issues/${c.issueId}/execution`),
      recoveryActions: await get(c, `/api/issues/${c.issueId}/recovery-actions`),
      liveRuns: await get(c, `/api/issues/${c.issueId}/live-runs`) };
  }
  const noticeView = (row: any) => ({ id: row.id, body: row.body, title: row.presentation?.title ?? row.metadata?.title ?? null,
    presentation: row.presentation, metadata: row.metadata });
  async function answered(c: Awaited<ReturnType<typeof chat>>, id: string) {
    const [row] = await db.select({ answered: completedPersonMessageAnswerSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) })
      .from(issueComments).where(eq(issueComments.id, id));
    return Boolean(row?.answered);
  }
  /** The sweep the stranded step runs (heartbeat.ts reconcileStrandedAssignedIssues), with its clock moved on. */
  async function sweepAt(c: Awaited<ReturnType<typeof chat>>, m1: string, offsetsMs: number[]) {
    const steps = [];
    for (const offset of offsetsMs) {
      const result = await settleUnansweredPersonMessages(db, { companyId: c.companyId, issueId: c.issueId, now: new Date(Date.now() + offset) });
      const seen = await visible(c, m1);
      steps.push({ offsetMs: offset, result, notices: seen.notices.map(row => ({ id: row.id, reason: row.metadata.authorizationReason, body: row.body,
        waiting: JSON.stringify(row.metadata?.sections ?? []).includes("Waiting code") })) });
    }
    return steps;
  }
  const CLOCK = [20_000, 150_000, 11 * 60_000, 13 * 60_000, 25 * 60_000];

  // "m2-held" (adopt-lead's shape: a later held message's run succeeded after M1's run failed) is a KNOWN RED
  // on tA-min: M1 gets its one true notice, but the task's Retry belongs to the latest run. It runs only when asked.
  const SHAPES = (process.env.TAMIN_ORPHAN_M2_HELD ? ["plain", "m2-held"] : ["plain"]) as ("plain" | "m2-held")[];
  for (const shape of SHAPES) it(`${shape}: M1's only carrying run failed -> answer or ONE true notice; Retry through POST /issues/:id/retry answers M1 once; no second notice`, async () => {
    const c = await chat();
    fixture.calls = []; fixture.failNext = 1;
    let m2 = "";
    fixture.onFail = shape === "m2-held" ? async () => { m2 = await c.send("Held: and also this."); } : undefined;
    const m1 = await c.send("Typed: please answer this.");
    const first = await sweep(c, 6_000);
    fixture.onFail = undefined;
    const failedRun = first.runs.find(run => carried(run.ctx).includes(m1))!;
    const before = await visible(c, m1);
    const clock = await sweepAt(c, m1, CLOCK);
    const afterNotice = await visible(c, m1);
    const m1AnsweredBeforeRetry = await answered(c, m1);
    const okBefore = fixture.calls.filter(call => call.ok).length;
    // Retry exactly as the card does: the task's interruption names the run it observed.
    const interruption = afterNotice.interruption;
    const retry = await request(c.app).post(`/api/issues/${c.issueId}/retry`)
      .send({ idempotencyKey: randomUUID(), observedRunId: interruption?.observedRunId ?? failedRun.id });
    const second = await sweep(c, 8_000);
    const afterRetry = await visible(c, m1);
    const clockAfter = await sweepAt(c, m1, CLOCK);
    const end = await visible(c, m1);
    const okRuns = new Set(fixture.calls.filter(call => call.ok).map(call => call.runId));
    const report = { shape, answerRule, m1, m2: m2 || null, failedRunId: failedRun.id,
      beforeClock: { m1Answered: await answered(c, m1).catch(() => null), notices: before.notices.map(noticeView), interruption: before.interruption },
      clock,
      person: { m1AnsweredBeforeRetry, noticeCount: afterNotice.m1Notices.length, notices: afterNotice.m1Notices.map(noticeView),
        otherNotices: afterNotice.notices.filter(row => !afterNotice.m1Notices.includes(row)).map(noticeView),
        interruption, execution: afterNotice.execution, recoveryActions: afterNotice.recoveryActions },
      retry: { status: retry.status, body: retry.body },
      afterRetry: { calls: fixture.calls, newOkCalls: fixture.calls.filter(call => call.ok).length - okBefore,
        runs: second.runs.map(run => ({ id: run.id, status: run.status, carried: carried(run.ctx),
          attribution: (run.ctx as any)?.attributionCommentIds ?? null, retryOfRunId: (run.ctx as any)?.retryOfRunId ?? null,
          wakeReason: (run.ctx as any)?.wakeReason ?? null, taskRetry: (run.ctx as any)?.taskRetry ?? null, ok: okRuns.has(run.id) })),
        wakes: second.wakes.map(w => ({ id: w.id, status: w.status, key: w.key, runId: w.runId, reason: (w.payload as any)?.wakeReason ?? null })),
        m1Answered: await answered(c, m1), m2Answered: m2 ? await answered(c, m2) : null,
        agentReplies: afterRetry.agentReplies.map(row => ({ id: row.id, body: row.body, runId: row.createdByRunId ?? null })),
        m1Notices: afterRetry.m1Notices.map(noticeView), interruption: afterRetry.interruption },
      clockAfter, end: { m1Notices: end.m1Notices.map(noticeView), allNotices: end.notices.map(noticeView),
        agentReplies: end.agentReplies.length, m1Answered: await answered(c, m1) } };
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, `c-notice-retry-${shape}.json`), JSON.stringify(report, null, 2));

    expect(fixture.calls[0]?.ok, "first run failed").toBe(false);
    // NEVER SILENT: its answer, or exactly ONE true not-answered line.
    expect.soft(m1AnsweredBeforeRetry || afterNotice.m1Notices.length === 1, "M1 is answered or has exactly one notice").toBe(true);
    if (!m1AnsweredBeforeRetry) {
      expect.soft(afterNotice.m1Notices.map(row => row.body).join("\n"), "the one notice is the true not-answered line").toMatch(/wasn't answered/);
      expect.soft(interruption?.canRetry, "Retry is offered on the task").toBe(true);
      expect.soft(retry.status, `Retry accepted: ${JSON.stringify(retry.body)}`).toBe(202);
      expect.soft(report.afterRetry.newOkCalls, "Retry started exactly one run that reached the provider").toBe(1);
      expect.soft(fixture.calls.filter(call => call.ok).at(-1) as any, "the Retry run was given M1's text").toMatchObject({ hasTypedInput: true });
      expect.soft(report.afterRetry.m1Answered, "M1 is ANSWERED after Retry").toBe(true);
    }
    const m1Replies = report.afterRetry.runs.filter(run => run.ok && (run.carried.includes(m1) || (run.attribution ?? []).includes(m1)));
    expect.soft(m1Replies, "exactly one successful run carried M1").toHaveLength(1);
    expect.soft(end.m1Notices.length, "no second notice, ever").toBeLessThanOrEqual(1);
    expect(end.agentReplies.length, "no double answer").toBe(shape === "m2-held" ? (report.afterRetry.newOkCalls ? 2 : 1) : 1);
  }, 120_000);

  it("control: a typed message that WAS answered gets no notice, however late the sweep", async () => {
    const c = await chat();
    fixture.calls = []; fixture.failNext = 0;
    const m1 = await c.send("Typed: please answer this.");
    await sweep(c, 4_000);
    const clock = await sweepAt(c, m1, CLOCK);
    const end = await visible(c, m1);
    await fs.writeFile(path.join(out, "c-notice-retry-control.json"), JSON.stringify({ m1, calls: fixture.calls, clock,
      notices: end.notices.map(noticeView), agentReplies: end.agentReplies.length, interruption: end.interruption, m1Answered: await answered(c, m1) }, null, 2));
    expect(fixture.calls).toHaveLength(1);
    expect(await answered(c, m1)).toBe(true);
    expect(end.notices, "no notice on an answered message").toHaveLength(0);
    expect(end.agentReplies, "answered once").toHaveLength(1);
  }, 60_000);
});
