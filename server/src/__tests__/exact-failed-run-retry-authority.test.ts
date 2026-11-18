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

// rf-5 condition (2) on tA-min (ONE RETRY PREDICATE): the agent run page's exact failed-run retry
// (POST /api/agents/:id/wakeup { reason: "retry_failed_run", failedRunId }, routes/agents.ts) is admitted by the
// task's one Retry authority (task-retry-eligibility.ts decideRetryAuthority, read for the failed run), like the
// card's Retry. Harness of orphan-m2-held-retry-surface.test.ts / c3-orphan-notice-retry.test.ts:
// a TYPED chat message whose first run FAILS must still be
// answered exactly once. Real chat route (POST /api/issues/:id/comments on a
// conversationAgentId task), real heartbeat admission, release drain and
// recovery. Only the native provider turn is scripted: it throws once.
const fixture = vi.hoisted(() => ({
  calls: [] as { runId: string; ok: boolean }[],
  failNext: 0,
  onFail: undefined as undefined | (() => Promise<void>),
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
  restoreHold: null as Record<string, unknown> | null,
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
// Row (c) only: the authority's restore-hold FACT is given (a hold Paperclip can still release); the decision is
// the real decideRetryAuthority. Every other read passes through untouched.
vi.mock("../services/task-retry-eligibility.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/task-retry-eligibility.js")>();
  return { ...actual, readRetryAdmissionAuthority: (async (db, input) => fixture.restoreHold
    ? actual.decideRetryAuthority({ restoreHold: fixture.restoreHold, retrySource: true })
    : actual.readRetryAdmissionAuthority(db, input)) as typeof actual.readRetryAdmissionAuthority };
});
import { heartbeatService } from "../services/heartbeat.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { settleUnansweredPersonMessages } from "../services/recovery/unanswered-person-message.js";
import { PERSON_MESSAGE_ANSWERED_MESSAGE, PERSON_MESSAGE_ANSWERED_REASON, readRetryAdmissionAuthority } from "../services/task-retry-eligibility.js";
import * as answerModule from "../services/person-message-answer.js";
// Head reads ANSWERED (completedPersonMessageAnswerSql). The base tree (al/noticesbf2) has only its own
// rule (answeredPersonMessageSql); the report names which one judged.
const answerRule = "completedPersonMessageAnswerSql" in answerModule ? "completedPersonMessageAnswerSql" : "answeredPersonMessageSql";
const completedPersonMessageAnswerSql = (answerModule as any)[answerRule] as typeof answerModule.answeredPersonMessageSql;

const support = await getEmbeddedPostgresTestSupport();
const out = process.env.TASK_OUT ?? os.tmpdir();

describe.skipIf(!support.supported)("the run page's exact failed-run retry reads the one Retry authority, through the real routes", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("exact-retry-authority-"); db = createDb(temp.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "exact-retry-authority-home-")); process.env.PAPERCLIP_HOME = home;
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

  const nextActionOf = (row: any): string | null => (row?.metadata?.sections ?? []).flatMap((section: any) => section.rows ?? [])
    .find((entry: any) => entry.label === "Next action")?.value ?? null;
  /** The one decision admission reads for the run the card names (task-retry.ts refuseRetryTheCardDoesNotOffer). */
  const admission = async (c: Awaited<ReturnType<typeof chat>>, runId: string | null) => {
    const a = await readRetryAdmissionAuthority(db, { companyId: c.companyId, issueId: c.issueId, sourceRunId: runId });
    return { canRetry: a.canRetry, reason: a.reason, cardText: a.cardText, nextAction: a.nextAction };
  };
  /** The card's own Retry control: useTaskRetry.ts retry() posts { idempotencyKey, observedRunId:
   * issue.interruption.observedRunId } (retryAction only for move_forward) to POST /issues/:id/retry (api/issues.ts retryTask). */
  const pressCardRetry = (c: Awaited<ReturnType<typeof chat>>, interruption: any) => request(c.app).post(`/api/issues/${c.issueId}/retry`)
    .send({ idempotencyKey: randomUUID(), observedRunId: interruption?.observedRunId ?? null,
      ...(interruption?.retryAction === "move_forward" ? { retryAction: "move_forward" } : {}) });

  /** The run page's exact retry: ui/src/api/agents.ts retryFailedRun. */
  const pressRunRetry = (c: Awaited<ReturnType<typeof chat>>, failedRunId: string) => request(c.app)
    .post(`/api/agents/${c.agentId}/wakeup?companyId=${c.companyId}`)
    .send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId });
  const okRunsCarrying = (runs: { id: string; ctx: any }[], id: string) => {
    const ok = new Set(fixture.calls.filter(call => call.ok).map(call => call.runId));
    return runs.filter(run => ok.has(run.id) && (carried(run.ctx).includes(id) || (run.ctx?.attributionCommentIds ?? []).includes(id)));
  };
  const report: Record<string, unknown> = {};
  afterAll(async () => { await fs.mkdir(out, { recursive: true }); await fs.writeFile(path.join(out, "exact-retry-authority.json"), JSON.stringify(report, null, 2)); });

  it("(a) M2-held orphan: the route admits M1's failed run and answers M1 once, M2 never twice; (b) the same run, its input now ANSWERED: refused, nothing starts", async () => {
    const c = await chat();
    fixture.calls = []; fixture.failNext = 1; fixture.restoreHold = null;
    let m2 = "";
    fixture.onFail = async () => { m2 = await c.send("Held: and also this."); };
    const m1 = await c.send("Typed: please answer this.");
    const first = await sweep(c, 6_000);
    fixture.onFail = undefined;
    const failedRun = first.runs.find(run => carried(run.ctx).includes(m1))!;
    await sweepAt(c, m1, CLOCK);
    expect(failedRun.status, "M1's run failed").toBe("failed");
    expect(first.runs.at(-1)!.id, "the task's latest run is M2's").not.toBe(failedRun.id);
    expect(await answered(c, m1), "M1 is not ANSWERED").toBe(false);
    expect(await answered(c, m2), "M2 is ANSWERED").toBe(true);
    const verdict = await admission(c, failedRun.id);
    expect(verdict.canRetry, "the authority admits M1's failed run").toBe(true);

    const retry = await pressRunRetry(c, failedRun.id);
    const second = await sweep(c, 8_000);
    await sweepAt(c, m1, CLOCK);
    report.a = { m1, m2, failedRunId: failedRun.id, verdict, retry: { status: retry.status, body: retry.body },
      runs: second.runs.map(run => ({ id: run.id, status: run.status, carried: carried(run.ctx), wakeReason: (run.ctx as any)?.wakeReason ?? null,
        source: (run.ctx as any)?.source ?? null })), calls: fixture.calls };
    const newRuns = second.runs.filter(run => !first.runs.some(before => before.id === run.id));
    expect.soft(retry.status, `(a) the route admits: ${JSON.stringify(retry.body)}`).toBeLessThan(300);
    // The route's admitted behaviour is unchanged. Upstream's own follow-up for a task this retry leaves in
    // progress (issue.productive_terminal_continuation_recovery, no person message) may queue; it is recorded in
    // the report, carries neither message and is no provider turn here.
    expect.soft(newRuns.filter(run => carried(run.ctx).length > 0).map(run => carried(run.ctx)), "(a) one new run carries a person message: M1").toEqual([[m1]]);
    expect.soft(fixture.calls.filter(call => call.ok).length, "(a) one new provider turn (M2's, then M1's)").toBe(2);
    expect.soft(await answered(c, m1), "(a) M1 is ANSWERED").toBe(true);
    expect.soft(okRunsCarrying(second.runs, m1), "(a) M1 answered EXACTLY once").toHaveLength(1);
    expect.soft(okRunsCarrying(second.runs, m2), "(a) M2 answered EXACTLY once, never twice").toHaveLength(1);

    // (b) the failed run's own input is ANSWERED now.
    const verdictAfter = await admission(c, failedRun.id);
    const okBefore = fixture.calls.filter(call => call.ok).length;
    const again = await pressRunRetry(c, failedRun.id);
    const third = await sweep(c, 3_000);
    const end = await visible(c, m1);
    report.b = { verdictAfter, again: { status: again.status, body: again.body }, runs: third.runs.length };
    expect.soft(verdictAfter, "(b) the authority refuses").toMatchObject({ canRetry: false, reason: PERSON_MESSAGE_ANSWERED_REASON, cardText: PERSON_MESSAGE_ANSWERED_MESSAGE });
    expect.soft(again.status, `(b) the route refuses: ${JSON.stringify(again.body)}`).toBe(409);
    expect.soft(again.body?.error, "(b) in the authority's words").toBe(PERSON_MESSAGE_ANSWERED_MESSAGE);
    expect.soft(JSON.stringify(again.body), "(b) with the authority's typed reason").toContain(PERSON_MESSAGE_ANSWERED_REASON);
    expect.soft(third.runs.length, "(b) the refused retry starts no run").toBe(second.runs.length);
    expect.soft(fixture.calls.filter(call => call.ok).length, "(b) no provider turn").toBe(okBefore);
    expect(end.agentReplies.length, "(b) no second answer: one for M2, one for M1").toBe(2);
  }, 120_000);

  it("(c) a failed run the authority holds (a restore hold Paperclip can still release): held, no run beside it; released, it answers M1 once", async () => {
    const c = await chat();
    fixture.calls = []; fixture.failNext = 1; fixture.onFail = undefined; fixture.restoreHold = null;
    const m1 = await c.send("Typed: please answer this.");
    const first = await sweep(c, 6_000);
    const failedRun = first.runs.find(run => carried(run.ctx).includes(m1))!;
    expect(failedRun.status, "M1's run failed").toBe("failed");
    fixture.restoreHold = { workspaceRestorePending: true };
    const heldVerdict = await readRetryAdmissionAuthority(db, { companyId: c.companyId, issueId: c.issueId, sourceRunId: failedRun.id });
    expect(heldVerdict, "the authority holds this Retry").toMatchObject({ canRetry: true, admission: "held", reason: "workspace_repair_required" });
    const held = await pressRunRetry(c, failedRun.id);
    const heldAgain = await pressRunRetry(c, failedRun.id);
    const second = await sweep(c, 3_000);
    expect.soft(held.status, `(c) held, not started: ${JSON.stringify(held.body)}`).toBe(409);
    expect.soft(held.body?.error, "(c) in the hold's words").toBe(heldVerdict.cardText);
    expect.soft(JSON.stringify(held.body), "(c) typed held").toContain("retry_held");
    expect.soft(heldAgain.status, "(c) a repeat is held too").toBe(409);
    expect.soft(second.runs.length, "(c) no run started while held").toBe(first.runs.length);
    expect.soft(fixture.calls.filter(call => call.ok).length, "(c) no provider turn while held").toBe(0);
    fixture.restoreHold = null;
    const released = await pressRunRetry(c, failedRun.id);
    const third = await sweep(c, 8_000);
    report.c = { m1, failedRunId: failedRun.id, heldVerdict, held: { status: held.status, body: held.body },
      heldAgain: { status: heldAgain.status, body: heldAgain.body }, released: { status: released.status, body: released.body },
      runs: third.runs.map(run => ({ id: run.id, status: run.status, carried: carried(run.ctx) })), calls: fixture.calls };
    expect.soft(released.status, `(c) released: admitted: ${JSON.stringify(released.body)}`).toBeLessThan(300);
    expect.soft(third.runs.length, "(c) one run after release, not a double").toBe(first.runs.length + 1);
    expect.soft(okRunsCarrying(third.runs, m1), "(c) M1 answered EXACTLY once").toHaveLength(1);
    expect(await answered(c, m1), "(c) M1 is ANSWERED").toBe(true);
  }, 120_000);
});
