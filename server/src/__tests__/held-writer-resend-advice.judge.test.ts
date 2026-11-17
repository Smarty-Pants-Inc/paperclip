import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import * as executor from "../services/native-runtime/native-session-executor.js";
import { HELD_PREDECESSOR_NOTICE } from "../services/native-runtime/held-predecessor-notice-text.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { readStandingRunNotice, readStandingRunNotices } from "../services/standing-run-notice.js";
import { PENDING_WAIT_ACTION, PENDING_WAIT_BOUND_MS, PENDING_WAIT_START_BOUND_MS,
  settleUnansweredPersonMessage, UNANSWERED_MESSAGE_RECOVERING_TEXT } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Re-points rf3 R1/R2/N1/N2 to the sole sweep owner (#21066, rf5 18:20Z).
// The original judge and field-by-field production evidence accompany the handoff.
// No service mocks: DB, sweep, standing reader and card projection are real.
const RESEND_ADVICE = /send a new message|send it again|sending it again|try again/i;
const HELD_REFUSAL = "runner_state_identity_mismatch: prior_owner_scope_mismatch";
const AUTO_CODE = "native_continuation_requires_reconciliation";
const support = await getEmbeddedPostgresTestSupport();

describe("held refusal: the predicate-aware sweep is the ONE notice owner", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    expect(support.supported, support.reason ?? "embedded PostgreSQL is required").toBe(true);
    database = await startEmbeddedPostgresTestDatabase("held-writer-sweep-judge-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function conversation(auto = false, priorStatus: "failed" | "cancelled" = "failed") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    const end = Date.now();
    await db.insert(companies).values({ id: companyId, name: "Held writer judge", issuePrefix: `H${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed agent", adapterType: "paperclip_runner", status: "active" });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Saved conversation", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const [prior] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: priorStatus, runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: sessionId, contextSnapshot: { issueId }, createdAt: new Date(end - 14_000),
      startedAt: new Date(end - 14_000), finishedAt: new Date(end - 13_000) }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "judge-person",
      body: "Continue from the saved conversation; do not repeat stopped work.", createdAt: new Date(end - 12_000) }).returning();
    const [refused] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: sessionId, contextSnapshot: { issueId, commentId: message!.id },
      errorCode: auto ? AUTO_CODE : "adapter_failed", error: HELD_REFUSAL,
      createdAt: new Date(end - 11_000), startedAt: new Date(end - 10_000), finishedAt: new Date(end) }).returning();
    await db.insert(nativeRunFinalizations).values([prior!, refused!].map(run => ({ companyId, issueId, runId: run.id,
      phase: "terminal_failure", failureCode: auto ? AUTO_CODE : "native_pre_dispatch_failure", resultId: null, leaseOwner: null })));
    return { companyId, agentId, issueId, sessionId, issue: issue!, prior: prior!, refused: refused!, message: message!, end };
  }
  type Conversation = Awaited<ReturnType<typeof conversation>>;
  // At the unfixed base (and the restore-writer mutation) invoke the ACTUAL
  // writer. At head it must not exist; the executor source assertion below
  // additionally prevents a renamed/private call from escaping this oracle.
  async function executorRefusal(f: Conversation) {
    const legacy = (executor as unknown as Record<string, unknown>).noticeHeldUnfinishedPredecessor;
    if (typeof legacy === "function") await legacy({ db, execution: { provider: { kind: "pi_rpc" },
      binding: { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.refused.id },
      session: { normalizedSessionId: f.sessionId } } }, new Error(HELD_REFUSAL));
  }
  const systemComments = (f: Conversation) => db.select().from(issueComments).where(and(
    eq(issueComments.companyId, f.companyId), eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"),
    isNull(issueComments.deletedAt)));
  const sweep = (f: Conversation, elapsed: number) => settleUnansweredPersonMessage(db,
    { companyId: f.companyId, issueId: f.issueId, now: new Date(f.end + elapsed) });
  async function beginGrace(f: Conversation) {
    await sweep(f, 20_000);
    // logActivity uses the database clock; pin its recorded T0 to the supplied
    // sweep clock just as the existing sweep fixtures do. No policy is mocked.
    await db.update(activityLog).set({ createdAt: new Date(f.end + 20_000) }).where(and(
      eq(activityLog.entityId, f.issueId), eq(activityLog.action, PENDING_WAIT_ACTION)));
  }
  async function pendingRecovery(f: Conversation, deferred = true) {
    const now = new Date(f.end + 66);
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "workspace_recovery", status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: f.agentId,
      cause: AUTO_CODE, fingerprint: `native-continuation:${f.refused.id}`, createdAt: now, resolvedAt: new Date(f.end + 115),
      nextAction: "Continuing automatically from saved work. No action needed.",
      evidence: { runId: f.refused.id, executionReconciliation: { runId: f.refused.id, providerStopped: true,
        actionOutcome: "mixed", outcomeEvidence: "Saved history retained; unknown actions will not be replayed.",
        workspaceRepairEvidence: "Continuation starts from saved work in a fresh workspace.",
        actorId: deferred ? "execution-recovery" : "fresh-continuation", recordedAt: now.toISOString() }, ...(deferred ? { continuationDelivery: "pending" } : {}) },
    }).returning();
    const [wake] = deferred ? await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_recovery_action_restored", status: "deferred_issue_execution",
      requestedByActorType: "system", requestedByActorId: "execution-recovery", idempotencyKey: `execution-reconciliation:${action!.id}`,
      payload: { issueId: f.issueId, recoveryActionId: action!.id, commentId: f.message.id,
        executionWait: { recoveryActionId: action!.id, reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." },
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, recoveryActionId: action!.id,
          commentId: f.message.id, wakeCommentId: f.message.id, wakeCommentIds: [f.message.id], previousRunId: f.refused.id,
          retryOfRunId: f.refused.id, forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" } },
    }).returning() : [];
    return { action: action!, wake };
  }
  async function card(f: Conversation) {
    const presentation = await taskInterruptionPresentation(db, f.issue);
    expect(presentation).not.toBeNull();
    expect(presentation!.observedRunId).toBe(f.refused.id);
    return presentation!;
  }
  const instructionText = (p: Awaited<ReturnType<typeof card>>) => [p.notice?.text, p.retryWait?.message,
    p.workspaceFailure?.message, p.setupFailure?.message].filter(Boolean).join("\n");
  async function oneSweepNotice(f: Conversation) {
    const notices = await systemComments(f);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${f.message.id}`);
    return notices[0]!;
  }

  it("c: s1 race: NO action at writer time, no writer comment; waiting note after grace, restored answer supersedes it", async () => {
    const f = await conversation(true, "cancelled");
    // Live 7ae251e4 at 16:42:17: the ONLY action belongs to the predecessor,
    // not the refused run. It must not mask the run-scoped pending predicate.
    const [predecessorStop] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "escalated", ownerType: "board", cause: "execution_stop_pending",
      fingerprint: `execution-stop:${f.prior.id}`, nextAction: "Inspect the predecessor's stopped execution.",
      evidence: { runId: f.prior.id, automaticAttemptsExhausted: true, maxAttempts: 1 } }).returning();
    expect(predecessorStop).toMatchObject({ status: "escalated", ownerType: "board", cause: "execution_stop_pending",
      evidence: { runId: f.prior.id, automaticAttemptsExhausted: true } });
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      eq(issueRecoveryActions.fingerprint, `native-continuation:${f.refused.id}`)))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    await executorRefusal(f);
    expect.soft(await systemComments(f), "s1 notice preceded the action by 66ms; no executor notice may be written").toEqual([]);
    await beginGrace(f);
    expect.soft((await systemComments(f)).map(n => n.body).join("\n")).not.toMatch(RESEND_ADVICE);
    expect(await card(f)).toMatchObject({ state: "failed", observedRunId: f.refused.id });
    await pendingRecovery(f, false);
    await sweep(f, 20_000 + PENDING_WAIT_BOUND_MS);
    const note = await oneSweepNotice(f);
    expect(note.body).toBe(UNANSWERED_MESSAGE_RECOVERING_TEXT);
    expect(instructionText(await card(f))).not.toMatch(RESEND_ADVICE);
    expect(await readStandingRunNotice(db, f)).toMatchObject({ source: "unanswered", text: note.body });
    const [restored] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", retryOfRunId: f.refused.id,
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" },
      createdAt: new Date(f.end + 150_000), startedAt: new Date(f.end + 150_000), finishedAt: new Date(f.end + 160_000) }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: restored!.id, body: "Continued from the saved work; here is the completed answer.", createdAt: new Date(f.end + 160_001) });
    // The read path must stop showing stale advice even before sweep cleanup.
    expect(await readStandingRunNotice(db, f)).toBeNull();
    await sweep(f, 161_000);
    expect(await systemComments(f)).toEqual([]);
    expect(await readStandingRunNotice(db, f)).toBeNull();
  });

  it.each(["R1", "R2"])("%s: no resend text from ANY writer or card while resolved recovery and deferred delivery are pending", async row => {
    const f = await conversation(false, row === "R1" ? "failed" : "cancelled");
    if (row === "R2") await executorRefusal(f);
    await pendingRecovery(f);
    if (row === "R1") await executorRefusal(f);
    await beginGrace(f);
    await sweep(f, 20_000 + PENDING_WAIT_BOUND_MS);
    expect((await systemComments(f)).map(n => n.body).join("\n")).not.toMatch(RESEND_ADVICE);
    expect(instructionText(await card(f))).not.toMatch(RESEND_ADVICE);
    expect((await oneSweepNotice(f)).body).toMatch(/waiting|recovering/i);
  });

  it("N1 / v / vi: non-auto adapter_failed + native_pre_dispatch_failure: failed card during grace, ONE true held notice from sweep", async () => {
    const f = await conversation();
    await executorRefusal(f);
    expect.soft(await systemComments(f)).toEqual([]);
    expect(await card(f)).toMatchObject({ state: "failed", canRetry: true, observedRunId: f.refused.id });
    await sweep(f, 2 * 60_000);
    await sweep(f, 3 * 60_000);
    const note = await oneSweepNotice(f);
    expect(note.body).toBe(HELD_PREDECESSOR_NOTICE);
    expect(note.body).not.toMatch(/sending it again is safe/i);
    expect((await card(f)).notice?.text).toBe(note.body);
  });

  it.each(["failed", "cancelled"] as const)("N2: recovery wake %s and delivery invalidated: ONE true notice from sweep", async status => {
    const f = await conversation(false, "cancelled");
    const recovery = await pendingRecovery(f);
    await db.update(agentWakeupRequests).set({ status, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, recovery.wake!.id));
    await db.update(issueRecoveryActions).set({ evidence: { ...recovery.action.evidence, continuationDelivery: "invalidated" } })
      .where(eq(issueRecoveryActions.id, recovery.action.id));
    await executorRefusal(f);
    expect.soft(await systemComments(f)).toEqual([]);
    await sweep(f, 2 * 60_000); await sweep(f, 3 * 60_000);
    expect((await oneSweepNotice(f)).body).toBe(HELD_PREDECESSOR_NOTICE);
  });

  it.each(["no action", "restore delivery never recorded", "deferred continuation never starts"])("e: %s: no resend at +1/+9 min, ONE true notice at failed END +10 min", async state => {
    const f = await conversation(true);
    if (state !== "no action") await pendingRecovery(f, state === "deferred continuation never starts");
    await executorRefusal(f);
    expect.soft(await systemComments(f)).toEqual([]);
    await beginGrace(f);
    for (const elapsed of [60_000, 9 * 60_000]) {
      await sweep(f, elapsed);
      expect((await systemComments(f)).map(n => n.body).join("\n")).not.toMatch(RESEND_ADVICE);
    }
    await sweep(f, PENDING_WAIT_START_BOUND_MS);
    await sweep(f, PENDING_WAIT_START_BOUND_MS + 1_000);
    const note = await oneSweepNotice(f);
    expect(note.body).toBe(HELD_PREDECESSOR_NOTICE);
    expect(note.body).not.toBe(UNANSWERED_MESSAGE_RECOVERING_TEXT);
  });

  it("vii: sweep standing-reader is batched, company scoped, ignores a newer input and deleted notices", async () => {
    const f = await conversation();
    await sweep(f, 120_000);
    const note = await oneSweepNotice(f);
    expect(await readStandingRunNotice(db, { companyId: randomUUID(), issueId: f.issueId })).toBeNull();
    const batch = await readStandingRunNotices(db, { companyId: f.companyId, issueIds: [f.issueId, f.issueId] });
    expect([...batch.values()]).toEqual([{ source: "unanswered", code: "unanswered_message", text: HELD_PREDECESSOR_NOTICE }]);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, note.id));
    expect(await readStandingRunNotice(db, f)).toBeNull();
    await db.update(issueComments).set({ deletedAt: null }).where(eq(issueComments.id, note.id));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user",
      body: "A new request", createdAt: new Date(f.end + 121_000) });
    expect(await readStandingRunNotice(db, f)).toBeNull();
  });

  it("e: a first sweep at +11 min cannot restart the automatic recovery clock", async () => {
    const f = await conversation(true);
    await pendingRecovery(f);
    await sweep(f, 11 * 60_000);
    await sweep(f, 12 * 60_000);
    expect((await oneSweepNotice(f)).body).toBe(HELD_PREDECESSOR_NOTICE);
  });

  it("the executor catch has no held-notice writer/call (the original refusal must still propagate)", () => {
    const source = readFileSync(new URL("../services/native-runtime/native-session-executor.ts", import.meta.url), "utf8");
    expect(source).not.toContain("noticeHeldUnfinishedPredecessor");
    expect(source).not.toContain("HELD_PREDECESSOR_REFUSAL");
  });
});
