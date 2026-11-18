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

// c2s (b) admit row (RFL: the HELD remedy "Press Retry to continue in a fresh run with this conversation's
// history." stays only with a row proving decideRetryAuthority ADMITS that Retry and the message is answered
// exactly once). Real chat route (POST /api/issues/:id/comments on a conversationAgentId task), real heartbeat
// admission, real sweep, real card read (GET /api/issues/:id) and real Retry route (POST /api/issues/:id/retry)
// on PostgreSQL. Only the native provider turn is scripted: it throws once. The failed run then carries the
// durable record shape c2s (b) names: a prior-owner refusal whose code is supervision-exhausted (a HELD run).
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
        throw new Error("c2s_held_provider_failed_once");
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
import { decideRetryAuthority } from "../services/task-retry-eligibility.js";
import { HELD_PREDECESSOR_NOTICE, HELD_RETRY_ACTION } from "../services/native-runtime/held-predecessor-notice-text.js";
import { REMOTE_RUNNER_SUPERVISION_EXHAUSTED } from "../services/native-runtime/remote-runner-recovery-diagnostics.js";
import * as answerModule from "../services/person-message-answer.js";
// Head reads ANSWERED (completedPersonMessageAnswerSql). The base tree (al/noticesbf2) has only its own
// rule (answeredPersonMessageSql); the report names which one judged.
const answerRule = "completedPersonMessageAnswerSql" in answerModule ? "completedPersonMessageAnswerSql" : "answeredPersonMessageSql";
const completedPersonMessageAnswerSql = (answerModule as any)[answerRule] as typeof answerModule.answeredPersonMessageSql;

const support = await getEmbeddedPostgresTestSupport();
const out = process.env.TASK_OUT ?? os.tmpdir();

describe.skipIf(!support.supported)("c2s (b) admit: the HELD supervision-exhausted notice offers Retry, and that Retry is admitted (real routes + PostgreSQL)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("c2s-held-admit-"); db = createDb(temp.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "c2s-held-home-")); process.env.PAPERCLIP_HOME = home;
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
  const noticesEver = (c: Awaited<ReturnType<typeof chat>>, m1: string) => db.select().from(issueComments).where(and(
    eq(issueComments.issueId, c.issueId), sql`${issueComments.metadata}->>'authorizationReason' = ${`unanswered_message:${m1}`}`));
  const visibleNotices = async (c: Awaited<ReturnType<typeof chat>>) => {
    const res = await request(c.app).get(`/api/issues/${c.issueId}/comments`);
    const list: any[] = Array.isArray(res.body) ? res.body : (res.body?.comments ?? res.body?.items ?? []);
    return { notices: list.filter(row => row?.authorType === "system"
      && String(row?.metadata?.authorizationReason ?? "").startsWith("unanswered_message:")),
      agentReplies: list.filter(row => row?.authorType === "agent") };
  };
  async function answered(c: Awaited<ReturnType<typeof chat>>, id: string) {
    const [row] = await db.select({ answered: completedPersonMessageAnswerSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) })
      .from(issueComments).where(eq(issueComments.id, id));
    return Boolean(row?.answered);
  }
  const CLOCK = [20_000, 150_000, 11 * 60_000, 13 * 60_000, 25 * 60_000];
  const settleAt = async (c: Awaited<ReturnType<typeof chat>>) => {
    for (const offset of CLOCK)
      await settleUnansweredPersonMessages(db, { companyId: c.companyId, issueId: c.issueId, now: new Date(Date.now() + offset) });
  };

  it("c2s (b) admit: a HELD supervision-exhausted run's notice says Press Retry; the card offers that Retry; POST /issues/:id/retry is ACCEPTED, starts ONE run, and the message is answered exactly once with no second notice", async () => {
    const c = await chat();
    fixture.calls = []; fixture.failNext = 1; fixture.onFail = undefined;
    const m1 = await c.send("Typed: please answer this.");
    const first = await sweep(c, 6_000);
    expect(fixture.calls, "the first provider turn failed, nothing else ran").toEqual([expect.objectContaining({ ok: false })]);
    const failedRun = first.runs.find(run => carried(run.ctx).includes(m1))!;
    expect(failedRun.status).toBe("failed");
    // c2s (b)'s durable record: the failed run is a HELD run (prior-owner refusal) whose code is supervision-exhausted.
    await db.update(heartbeatRuns).set({ error: "runner_state_identity_mismatch: prior_owner_active",
      errorCode: REMOTE_RUNNER_SUPERVISION_EXHAUSTED }).where(eq(heartbeatRuns.id, failedRun.id));

    await settleAt(c);
    const noticed = await visibleNotices(c);
    // The notice the person sees: ONE, the HELD text, and its Next action is the body's own Retry instruction.
    expect(noticed.notices.map(row => [row.metadata.authorizationReason, row.body])).toEqual([[`unanswered_message:${m1}`, HELD_PREDECESSOR_NOTICE]]);
    expect(JSON.stringify(noticed.notices[0]!.metadata)).toContain(HELD_RETRY_ACTION);
    expect(JSON.stringify(noticed.notices[0]!.metadata)).not.toContain("Send a new message to try again.");
    expect(noticed.notices[0]!.metadata.sourceRunId).toBe(failedRun.id);
    expect(await answered(c, m1)).toBe(false);
    expect(noticed.agentReplies).toHaveLength(0);

    // The card the person sees offers that Retry, for the run the notice names.
    const issue = await request(c.app).get(`/api/issues/${c.issueId}`);
    const interruption = issue.body?.interruption;
    expect(interruption, JSON.stringify(interruption)).toMatchObject({ canRetry: true, observedRunId: failedRun.id });
    // The authority the notice's Next action comes from admits the same Retry with the same words.
    expect(decideRetryAuthority({ heldConversation: true, retrySource: true })).toMatchObject({ canRetry: true,
      userAction: "retry", cardText: HELD_PREDECESSOR_NOTICE, nextAction: HELD_RETRY_ACTION });

    // Press it, exactly as the card does.
    const retry = await request(c.app).post(`/api/issues/${c.issueId}/retry`)
      .send({ idempotencyKey: randomUUID(), observedRunId: interruption.observedRunId });
    expect(retry.status, `Retry accepted: ${JSON.stringify(retry.body)}`).toBe(202);
    const second = await sweep(c, 8_000);
    const okCalls = fixture.calls.filter(call => call.ok);
    expect(okCalls, "Retry started exactly one run that reached the provider").toHaveLength(1);
    expect(okCalls[0] as any, "the Retry run was given the message").toMatchObject({ hasTypedInput: true });
    const retryRun = second.runs.find(run => run.id === okCalls[0]!.runId)!;
    expect(retryRun.id).not.toBe(failedRun.id);
    expect(retryRun.status).toBe("succeeded");
    expect(await answered(c, m1), "the message is ANSWERED after Retry").toBe(true);

    // A second press, now that it is answered, is the true no-op: no run, no reply.
    const again = await request(c.app).post(`/api/issues/${c.issueId}/retry`)
      .send({ idempotencyKey: randomUUID(), observedRunId: second.runs.at(-1)!.id });
    expect(again.body).toMatchObject({ accepted: false, alreadyAnswered: true,
      refused: { reason: "person_message_already_answered", message: "Already answered above." } });
    const third = await sweep(c, 3_000);
    expect(third.runs.length, "the no-op starts no run").toBe(second.runs.length);
    await settleAt(c);
    const end = await visibleNotices(c);
    expect(end.agentReplies, "answered exactly once").toHaveLength(1);
    expect(end.agentReplies[0]!.createdByRunId).toBe(retryRun.id);
    expect(fixture.calls.filter(call => call.ok), "one answering turn, ever").toHaveLength(1);
    expect(end.notices, "the HELD notice retires once the message is ANSWERED").toHaveLength(0);
    expect(await noticesEver(c, m1), "no second notice, ever (deleted ones included)").toHaveLength(1);
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, "c2s-b-held-retry-admit.json"), JSON.stringify({ m1, failedRunId: failedRun.id,
      notice: { body: noticed.notices[0]!.body, metadata: noticed.notices[0]!.metadata }, interruption,
      retry: { status: retry.status, body: retry.body }, calls: fixture.calls,
      runs: second.runs.map(run => ({ id: run.id, status: run.status, carried: carried(run.ctx), taskRetry: (run.ctx as any)?.taskRetry ?? null })),
      again: again.body, end: { agentReplies: end.agentReplies.length, visibleNotices: end.notices.length,
        noticesEver: (await noticesEver(c, m1)).length, m1Answered: await answered(c, m1) } }, null, 2));
  }, 120_000);
});
