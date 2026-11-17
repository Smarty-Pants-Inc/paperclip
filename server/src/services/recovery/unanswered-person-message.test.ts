import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issueQuestionResponseDeliveries,
  issues,
  completionContracts,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
  statusDecisions,
  statusDecisionEffects,
  environmentLeases,
  subscribeDatabaseWork,
} from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../agent-lifecycle.js";
import { createLifecycleDriver } from "../agent-lifecycle-driver.js";
import { LIFECYCLE_ENVIRONMENT_WAIT_MESSAGE } from "../../modules/agent-lifecycle/application/retry.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../question-response-delivery.js";
import { freshContinuationDescendsFrom } from "../fresh-continuation-chain.js";
import { pendingContinuationCommentInput, readContinuationCommentInput } from "../continuation-comment-input.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { REMOTE_RUNNER_SUPERVISION_EXHAUSTED, REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION } from "../native-runtime/remote-runner-recovery-diagnostics.js";
import { settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { HELD_PREDECESSOR_NOTICE as HELD, noticeHeldUnfinishedPredecessor } from "../native-runtime/native-session-executor.js";
import { buildNoRunningExecutionNoticeSeed, buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";
import { settleUnansweredPersonMessage, unansweredPersonMessageCommentCondition,
  UNANSWERED_MESSAGE_TEXT as NOT_ANSWERED, UNANSWERED_MESSAGE_NO_RUN_TEXT as NO_RUN,
  UNANSWERED_MESSAGE_NO_REPLY_TEXT as NO_REPLY, UNANSWERED_MESSAGE_WAITING_TEXT as WAITING,
  PENDING_WAIT_ACTION, PENDING_WAIT_BOUND_MS, PENDING_WAIT_START_BOUND_MS,
  UNANSWERED_MESSAGE_WORKING_TEXT, UNANSWERED_MESSAGE_WORKING_TITLE,
  UNANSWERED_MESSAGE_STARTED_FAILED_TEXT as STARTED_FAILED, UNANSWERED_MESSAGE_STARTED_NO_REPLY_TEXT as STARTED_NO_REPLY,
} from "./unanswered-person-message.js";

// C9 (Smarty fork): a person's message that nothing answers gets exactly ONE
// visible notice from the stranded sweep, in plain words, with the code in the
// metadata. Each case is a REAL shape: a refusal string from .local/SILENT-F.md
// or a production record shape named in the test title, on an agent with
// managed instructions. "Visible" is the v2 chat filter (TaskChatThread.tsx:930):
// a system comment is hidden only when recoveryResponsibility is "system".
// follow-Paperclip Cut B R8: held copy preserves the message and offers a new message, never a permanent ban.

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("unanswered person message notice (C9, the stranded sweep)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("unanswered-person-message-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(input: { status?: string; chat?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `user-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Unanswered fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", adapterType: "paperclip_runner", status: "active",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    const chat = input.chat ?? true;
    await db.insert(issues).values({ id: issueId, companyId, title: chat ? "Chat with Managed Pi" : "A task", assigneeAgentId: agentId,
      status: input.status ?? (chat ? "in_progress" : "blocked"),
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: input.status === "in_review" ? "waiting" : "active" } : {}) });
    let clock = Date.now() - 900_000;
    const at = (stepMs = 1_000) => new Date(clock += stepMs);
    const message = async (body = "Please continue.", stepMs?: number) => {
      const [row] = await db.insert(issueComments).values({ companyId, issueId, body, authorType: "user", authorUserId: userId,
        createdAt: at(stepMs) }).returning();
      return row!.id;
    };
    const run = async (r: { commentId?: string | null; status: string; error?: string | null; errorCode?: string | null;
      retryOfRunId?: string; wakeReason?: string; finishedAgoMs?: number }) => {
      const contextSnapshot: Record<string, unknown> = { issueId, wakeReason: r.wakeReason ?? "issue_commented" };
      if (r.commentId) contextSnapshot.wakeCommentId = r.commentId;
      const created = at();
      const finishedAt = r.finishedAgoMs === undefined ? created : new Date(Date.now() - r.finishedAgoMs);
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: r.status, runtimeMode: "native",
        nativeIssueId: issueId, contextSnapshot, error: r.error ?? null, errorCode: r.errorCode ?? null,
        retryOfRunId: r.retryOfRunId ?? null, createdAt: created,
        finishedAt: ["running", "queued", "scheduled_retry"].includes(r.status) ? null : finishedAt }).returning();
      return row!.id;
    };
    const reply = async (runId: string) => {
      await db.insert(issueComments).values({ companyId, issueId, body: "Here is my answer.", authorType: "agent", authorAgentId: agentId,
        createdByRunId: runId, createdAt: at() });
    };
    const boardHold = async (cause: string, runId: string, kind = "active_run_watchdog") => {
      const [row] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind, status: "active",
        ownerType: "board", cause, fingerprint: `${kind}:${runId}`, evidence: { runId },
        nextAction: "Saved work recovered. Retry or send a message to continue." }).returning();
      return row!.id;
    };
    // The fixture runs on a clock in the past (so the settle grace has
    // elapsed); a notice the sweep writes now is re-stamped onto that clock so
    // later messages and answers come after it, as they do in production.
    const sweep = async () => {
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId });
      const fresh = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, issueId),
        eq(issueComments.authorType, "system"), gt(issueComments.createdAt, new Date(clock))));
      for (const row of fresh) await db.update(issueComments).set({ createdAt: at() }).where(eq(issueComments.id, row.id));
    };
    // What the v2 chat panel shows: system comments not classified "system".
    const visible = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(comment => (comment.metadata as Record<string, unknown> | null)?.recoveryResponsibility !== "system");
    const nativeSuccessor = async (sourceRunId: string, status = "succeeded") => {
      // Real status-decision outbox provenance: unlike a fresh fallback, this
      // producer saves a wake-intent id, not retryOfRunId/previousRunId.
      const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
        schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block",
        contractJson: {}, canonicalSha256: "47".repeat(32), createdByActorType: "system", createdByActorId: "fixture" }).returning();
      await db.update(heartbeatRuns).set({ completionContractId: contract!.id }).where(eq(heartbeatRuns.id, sourceRunId));
      const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: sourceRunId,
        completionContractId: contract!.id, serverFingerprint: "fixture", schemaStatus: "accepted",
        canonicalSha256: "fixture", resultJson: {} }).returning();
      const [assessment] = await db.insert(workAssessments).values({ companyId, issueId, runId: sourceRunId,
        contractId: contract!.id, resultId: result!.id, triggerKind: "run_terminal", triggerActorCompanyId: companyId,
        priorIssueStatus: "in_review", priorStatusVersion: 1, policyVersion: "v1", assessmentJson: {}, inputDigest: "fixture" }).returning();
      const [decision] = await db.insert(statusDecisions).values({ companyId, issueId, runId: sourceRunId,
        assessmentId: assessment!.id, decisionVersion: 1, policyVersion: "v1", fromStatus: "in_review", toStatus: "in_progress",
        reasonCode: "native_run_failed_continuation", decisionJson: {}, decisionDigest: "fixture", applicationState: "applied" }).returning();
      const target = await run({ status, wakeReason: "issue_status_changed" });
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
        reason: "issue_status_changed", status: "coalesced", runId: target, requestedByActorType: "system",
        requestedByActorId: "native-status-committer", payload: { issueId, nativeDecisionId: decision!.id } }).returning();
      await db.insert(statusDecisionEffects).values({ companyId, issueId, decisionId: decision!.id, ordinal: 0,
        effectKind: "schedule_retry", targetType: "agent_wakeup_request", targetId: wake!.id,
        idempotencyKey: `native-status:${decision!.id}:retry`, payload: {} });
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_status_changed",
        source: "native_status_decision", statusDecisionSource: "native_status_decision", nativeStatusWakeIntentId: wake!.id } })
        .where(eq(heartbeatRuns.id, target));
      return target;
    };
    return { companyId, agentId, issueId, userId, message, run, reply, boardHold, sweep, visible, at, nativeSuccessor };
  }

  const codeOf = (comment: { metadata: unknown }) => {
    const sections = ((comment.metadata as Record<string, unknown>)?.sections ?? []) as Array<{ rows: Array<{ label?: string; value?: string }> }>;
    return sections.flatMap(section => section.rows).find(row => row.label === "Failure code")?.value;
  };

  // KEEP: row14 F2 caught the real notice consumer discarding the named code
  // and claiming resend was safe while a predecessor's stop was unconfirmed.
  it.each(["raw", "notification", "saved_code", "named", "wrapped_named"] as const)(
    "row14 unconfirmed supervision has one truthful notice and Retry (%s)", async shape => {
      const f = await fixture({ status: "blocked" });
      const messageId = await f.message();
      const failure = "runner_process_termination_unconfirmed: runnerd process supervision failed: "
        + "Boat POST /sandboxes/{sandboxId}/commands failed (unavailable): result_unconfirmed, evidence=unknown (possibly ran)";
      const named = `${REMOTE_RUNNER_SUPERVISION_EXHAUSTED}: ${REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION}`;
      const runId = await f.run({ commentId: messageId, status: "failed",
        error: shape === "named" ? named : shape === "wrapped_named" ? `Notification transport failed closed: runner_process_termination_unconfirmed: runnerd process supervision failed: ${named}`
          : shape === "saved_code" ? "Saved supervision failure" : shape === "notification" ? `Notification transport failed closed: ${failure}` : failure,
        errorCode: shape === "named" ? REMOTE_RUNNER_SUPERVISION_EXHAUSTED : shape === "saved_code" ? failure : "notification_transport_failed" });
      await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId,
        phase: "terminal_failure", failureCode: "notification_transport_failed", recoveryState: "blocked" });
      expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed", code: REMOTE_RUNNER_SUPERVISION_EXHAUSTED });
      const notes = await f.visible();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toContain("Its termination is not confirmed.");
      expect(notes[0]!.body).toContain("Retry or send a new message");
      expect(notes[0]!.body).not.toMatch(/\bsafe\b/i);
      expect(codeOf(notes[0]!)).toBe(REMOTE_RUNNER_SUPERVISION_EXHAUSTED);
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task!.executionRunId).toBeNull();
      expect(await taskInterruptionPresentation(db, task!)).toMatchObject({ state: "failed", canRetry: true, observedRunId: runId });
      expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed_before" });
      expect(await f.visible()).toHaveLength(1);
    });

  // Keep: recorded gate-1 catch: one setup_failed run had a Retry notice, then a contradictory resend note.
  async function setupFailureWithRetryNotice(input: { attempts?: number; actionStatus?: string; deleted?: boolean;
    noticeRunId?: string; nextAction?: string; linkedActionId?: string; ownerType?: string;
    wakePolicy?: Record<string, unknown> } = {}) {
    const f = await fixture({ status: "blocked", chat: false });
    const messageId = await f.message();
    const runId = await f.run({ commentId: messageId, status: "failed", errorCode: "setup_failed" });
    const actionId = await f.boardHold("stranded_assigned_issue", runId, "stranded_assigned_issue");
    await db.update(issueRecoveryActions).set({ status: input.actionStatus ?? "active", ownerType: input.ownerType ?? "board",
      nextAction: input.nextAction ?? "Press Retry to start it again from the saved work.",
      ...(input.wakePolicy ? { wakePolicy: input.wakePolicy } : {}) })
      .where(eq(issueRecoveryActions.id, actionId));
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: input.nextAction ? { title: "Recovery needed", body: input.nextAction, nextAction: input.nextAction, tone: "danger" }
        : buildNoRunningExecutionNoticeSeed({ status: "in_progress", attempts: input.attempts ?? 1 }),
      recoveryActionId: input.linkedActionId ?? actionId, recoveryOwner: null,
      sourceRun: { id: input.noticeRunId ?? runId, status: "failed", errorCode: "setup_failed" },
    });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "system", ...notice, createdAt: f.at(), deletedAt: input.deleted ? f.at() : null }).returning();
    const notes = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));
    return { ...f, messageId, runId, actionId, commentId: comment!.id, notes };
  }

  it.each(["active", "escalated"])("one-note: a single setup failure with an %s Retry notice has exactly one note after repeated sweeps", async actionStatus => {
    const f = await setupFailureWithRetryNotice({ actionStatus });
    for (let pass = 0; pass < 2; pass++) {
      const outcome = await settleUnansweredPersonMessage(db, f);
      await f.sweep();
      const notes = await f.notes();
      expect(notes).toHaveLength(1);
      expect(outcome).toEqual({ kind: "explained" });
      expect(notes[0]!.id).toBe(f.commentId);
      expect(notes[0]!.body).toBe("Paperclip could not continue this task. Press Retry to start it again from the saved work.");
      expect(notes[0]!.body.split(".")[0]).not.toContain("again");
      expect(notes[0]!.metadata?.sourceRunId).toBe(f.runId);
      expect(notes[0]!.body).not.toContain("Sending it again");
    }
  });

  it("one-note: a system-owned recovery action with a Retry remedy also covers its run", async () => {
    const f = await setupFailureWithRetryNotice({ ownerType: "system" });
    const outcome = await settleUnansweredPersonMessage(db, f);
    expect(await f.notes()).toHaveLength(1);
    expect(outcome).toEqual({ kind: "explained" });
  });

  // Keep: review-fleet-5 caught the stale-card NEGATIVE remedy matching /retry/.
  // Same run, live notice and linked action: only the positive remedy covers it.
  it("one-note4: do not retry from this older card does not suppress the same-run resend note", async () => {
    const f = await setupFailureWithRetryNotice({
      nextAction: "The latest run changed; do not retry from this older card. Paperclip is refreshing recovery for the current run.",
    });
    expect((await f.notes())[0]!.metadata?.sourceRunId).toBe(f.runId);
    expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed", code: "setup_failed" });
    expect(await f.notes()).toHaveLength(2);
    const visible = await f.visible();
    expect(visible).toHaveLength(1);
    expect(visible[0]!.body).toBe(NOT_ANSWERED);
    expect(codeOf(visible[0]!)).toBe("setup_failed");
    expect(visible[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${f.messageId}`);
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "noticed_before" });
    expect(await f.notes()).toHaveLength(2);
  });

  it.each([
    "Press Retry to start it.",
    "This attempt could not be finished. Press Retry to start it again from the saved work.",
  ])("one-note4: positive same-run remedy still suppresses the resend note: %s", async nextAction => {
    const f = await setupFailureWithRetryNotice({ nextAction });
    expect((await f.notes())[0]!.metadata?.sourceRunId).toBe(f.runId);
    for (let pass = 0; pass < 2; pass++) {
      expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "explained" });
      const notes = await f.notes();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.id).toBe(f.commentId);
    }
  });

  // Keep: review-fleet-5 C1 DB catch: real producer remedies need not start a
  // sentence with "Press Retry". Each row keeps the same-run notice/action fence.
  it.each([
    ["workspace repository access (service.ts)", "Paperclip could not copy the project's repository into the task's workspace. Restore access to the repository in the project settings, then press Retry."],
    ["contained execution (execution-projection.ts)", "The original execution was contained and its action outcomes reviewed. Use Retry to request another attempt."],
    ["preparation failure (native-recovery-preparation-failure.ts)", "Preparation failed before the provider was started again. Retry the task."],
    ["released owner (native-failed-run-owner-release.ts)", "The run ended before it could resume its native provider session. Inspect the run failure, then explicitly retry the task."],
    ["provider startup (native-session-executor.ts)", "The provider refused to start a session, so no provider work began. Read the provider message and fix its cause in the agent's environment or AI connection if needed, then Retry. Retry starts a new run with a fresh provider session."],
  ])("one-note5 C1: %s has exactly one note after repeated settlement and sweeps", async (_producer, nextAction) => {
    const f = await setupFailureWithRetryNotice({ nextAction });
    for (let pass = 0; pass < 2; pass++) {
      const outcome = await settleUnansweredPersonMessage(db, f);
      await f.sweep();
      const notes = await f.notes();
      expect(notes.map(note => note.body)).toEqual([nextAction]);
      expect(notes).toHaveLength(1);
      expect(outcome).toEqual({ kind: "explained" });
      expect(notes[0]!.id).toBe(f.commentId);
      expect(notes[0]!.body).toBe(nextAction);
      expect(notes[0]!.metadata?.sourceRunId).toBe(f.runId);
      expect(notes[0]!.body).not.toContain("Sending it again");
    }
  });

  it("one-note5 C1: a structured manual_retry remedy covers its run without depending on Retry copy", async () => {
    const f = await setupFailureWithRetryNotice({ nextAction: "Request another attempt when the environment is available.",
      ownerType: "system", wakePolicy: { type: "manual_retry", reason: "environment_provider_unavailable", preservesSourceAssignee: true } });
    for (let pass = 0; pass < 2; pass++) {
      expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "explained" });
      expect(await f.notes()).toHaveLength(1);
      expect((await f.notes())[0]!.id).toBe(f.commentId);
    }
  });

  it.each([
    "Do not retry this attempt.",
    "Automatic retry is stopped.",
    "Automatic retries are stopped.",
    "Retry is not available for this attempt.",
    "Do not retry this attempt. Press Retry on the current task instead.",
  ])("one-note5 C1: a negated remedy does not silence the message: %s", async nextAction => {
    const f = await setupFailureWithRetryNotice({ nextAction });
    expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed", code: "setup_failed" });
    const notes = await f.notes();
    expect(notes).toHaveLength(2);
    expect(notes.find(note => note.id !== f.commentId)!.body).toBe(NOT_ANSWERED);
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "noticed_before" });
    expect(await f.notes()).toHaveLength(2);
  });

  it("one-note: a second failure keeps after 2 tries without a second remedy", async () => {
    const f = await setupFailureWithRetryNotice({ attempts: 2 });
    const outcome = await settleUnansweredPersonMessage(db, f);
    const notes = await f.notes();
    expect(notes).toHaveLength(1);
    expect(outcome).toEqual({ kind: "explained" });
    expect(notes[0]!.body).toBe("Paperclip tried to continue this task again, but it still could not continue after 2 tries. Press Retry to start it again from the saved work.");
  });

  it("one-note: a setup failure with no recovery notice still gets the unanswered-message note", async () => {
    const f = await fixture({ status: "blocked", chat: false });
    const messageId = await f.message();
    const runId = await f.run({ commentId: messageId, status: "failed", errorCode: "setup_failed" });
    await f.boardHold("stranded_assigned_issue", runId, "stranded_assigned_issue");
    expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed", code: "setup_failed" });
    const notes = await f.visible();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(NOT_ANSWERED);
    expect(notes[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${messageId}`);
  });

  it.each([
    { actionStatus: "resolved" }, { deleted: true }, { noticeRunId: randomUUID() },
    { nextAction: "" }, { nextAction: "The agent continues automatically." }, { linkedActionId: randomUUID() },
  ])("one-note: a non-covering recovery notice cannot silence the message (%j)", async input => {
    const f = await setupFailureWithRetryNotice(input);
    expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed", code: "setup_failed" });
    expect((await f.visible())[0]!.body).toBe(NOT_ANSWERED);
  });

  it("one-note: an older Retry notice does not cover a new message and failed run", async () => {
    const f = await setupFailureWithRetryNotice();
    const messageId = await f.message("A new request");
    await f.run({ commentId: messageId, status: "failed", errorCode: "setup_failed" });
    expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed", code: "setup_failed" });
    expect((await f.visible())[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${messageId}`);
  });

  // Keep: recorded D10 F0 catch. One continuation must not abort the ordinary conversations behind it.
  it("RFL round4 F0 sweeps a continued conversation with five ordinary unanswered ones without throwing", async () => {
    const held = await fixture();
    const heldRunId = await held.run({ commentId: await held.message(), status: "failed", errorCode: "runner_remote_state_unavailable" });
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, heldRunId));
    await db.insert(environmentLeases).values({ companyId: held.companyId, issueId: held.issueId,
      heartbeatRunId: heldRunId, provider: "boat", providerLeaseId: `gate-held-${randomUUID()}`, status: "retained" });
    const { ensureFreshContinuation } = await import("../fresh-continuation-fallback.js");
    // follow-Paperclip Cut B R1/R8: unknown physical stop no longer prevents ordinary continuation or its one-note sweep.
    expect(await ensureFreshContinuation(db, { companyId: held.companyId, runId: heldRunId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    const ordinary = [];
    for (let i = 0; i < 5; i++) {
      const f = await fixture();
      await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed" });
      ordinary.push(f);
    }
    for (let pass = 0; pass < 3; pass++) {
      await expect(heartbeatService(db).reconcileStrandedAssignedIssues()).resolves.toBeDefined();
      for (const f of ordinary) {
        const notices = await f.visible();
        expect(notices).toHaveLength(1);
        expect(notices[0]!.body).toBe(NOT_ANSWERED);
      }
      const heldNotices = await held.visible();
      expect(heldNotices).toHaveLength(1);
      expect(heldNotices[0]!.body).toBe(NOT_ANSWERED);
      expect(heldNotices[0]!.presentation).toMatchObject({ title: "Your message wasn't answered" });
      expect(heldNotices[0]!.body).not.toContain("I'm stopping");
    }
  });

  it("D10b SMAA-143 exhausted backup refusal gets exactly one factual unanswered notice", async () => {
    const f = await fixture({ status: "blocked" });
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_session_interrupted",
      error: "runner_harness_state_mismatch: backup_without_reusable_lease" });
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: id, provider: "boat", providerLeaseId: null, status: "expired" });
    await f.boardHold("native_session_retry_exhausted", id);
    await f.sweep();
    // follow-Paperclip Cut B R8: the unanswered-message owner no longer defers typed refusals to the removed stop gate.
    expect(await f.visible()).toHaveLength(1);
    await settleUnrecoverableExecutions(db);
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NOT_ANSWERED);
    expect(notices[0]!.body).not.toMatch(/native_|runner_|backup_without/);
    expect(codeOf(notices[0]!)).toBe("runner_harness_state_mismatch");
    await f.sweep();
    await settleUnrecoverableExecutions(db);
    expect(await f.visible()).toHaveLength(1);
  });

  it("D10b SMAA-143 does not preempt a same-run retry by timer; its terminal refusal reaches disposition", async () => {
    const f = await fixture();
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_session_interrupted",
      error: "runner_harness_state_mismatch: backup_without_reusable_lease" });
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: id, provider: "boat", providerLeaseId: null, status: "expired" });
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: id, phase: "retryable_failure",
      nextAttemptAt: new Date(Date.now() + 30_000) });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() - 10 * 60_000) }).where(eq(nativeRunFinalizations.runId, id));
    await f.sweep();
    // follow-Paperclip Cut B R8: an overdue retry can be explained without preempting its recovery owner.
    expect(await f.visible()).toHaveLength(1);
    expect((await f.visible())[0].body).toBe(NOT_ANSWERED);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, id)))[0].phase)
      .toBe("retryable_failure");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
    // Only the existing recovery owner settles the attempt; a notice does not execute or stop it.
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", nextAttemptAt: null })
      .where(eq(nativeRunFinalizations.runId, id));
    await f.boardHold("native_session_retry_exhausted", id);
    await settleUnrecoverableExecutions(db);
    expect(await f.visible()).toHaveLength(1);
    expect((await f.visible())[0].body).toBe(NOT_ANSWERED);
  });

  it("SMA-94 (live C8): adapter_failed 'Native session failed' under an ACTIVE board-owned native_continuation_requires_reconciliation hold -> exactly one notice", async () => {
    const f = await fixture();
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed", error: "Native session failed" });
    await f.boardHold("native_continuation_requires_reconciliation", id);
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NOT_ANSWERED);
    expect(codeOf(notices[0]!)).toBe("adapter_failed");
    const rows = (notices[0]!.metadata?.sections ?? []).flatMap(section => section.rows) as Array<{ label?: string }>;
    expect(rows.some(row => row.label === "Recovery action")).toBe(true);
  });

  it("SMAA-1370 (REG-03 on Boat): 'runnerd transport closed during provider startup', blocked by the board -> exactly one notice", async () => {
    const f = await fixture({ status: "blocked" });
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_session_retry_exhausted",
      error: "runnerd transport closed during provider startup" });
    await f.boardHold("native_session_retry_exhausted", id);
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NOT_ANSWERED);
    expect(notices[0]!.body).not.toContain("runnerd");
    expect(codeOf(notices[0]!)).toBe("native_session_retry_exhausted");
  });

  it("SMAA-501: a person comment with no run bound in 180 s on a task held by native_continuation_requires_reconciliation -> exactly one notice", async () => {
    const f = await fixture({ status: "blocked" });
    const earlier = await f.run({ commentId: await f.message("first"), status: "failed", errorCode: "native_continuation_requires_reconciliation" });
    await f.boardHold("native_continuation_requires_reconciliation", earlier, "stranded_assigned_issue");
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
    await f.message("second, never taken by a run", 200_000);
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", payload: { issueId: f.issueId } });
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(2);
    expect(notices.map(notice => notice.body)).toContain(NO_RUN);
  });

  it("SMAA-501 (RFL 20:37Z): a comment coalesced into a remote_cleanup execution wait whose wake FAILED -> exactly one notice, at the failure (no timer)", async () => {
    const f = await fixture();
    const earlier = await f.run({ commentId: await f.message("first"), status: "succeeded" });
    await f.reply(earlier);
    // The comment was just saved (inside the no-run grace): only the recorded
    // wake failure can trigger the notice.
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: "second",
      authorType: "user", authorUserId: f.userId, createdAt: new Date(Date.now() - 5_000) }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "issue_commented", status: "deferred_issue_execution",
      payload: { issueId: f.issueId, commentId: comment!.id, executionWait: "remote_cleanup" } }).returning();
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    expect(await f.visible()).toHaveLength(0);
    await db.update(agentWakeupRequests).set({ status: "failed", error: "remote cleanup receipt missing", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake!.id));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NO_RUN);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${comment!.id}`);
    expect(JSON.stringify(notices[0])).not.toContain("receipt missing");
  });

  it("REG-21: after a gateway key rotation the person's wake FAILED 'provider or completion contract changed', no run, blocked -> exactly one notice", async () => {
    const f = await fixture({ status: "blocked" });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: "Are you there?",
      authorType: "user", authorUserId: f.userId, createdAt: new Date(Date.now() - 10_000) }).returning();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "issue_commented", status: "failed", error: "provider or completion contract changed", finishedAt: new Date(),
      payload: { issueId: f.issueId, commentId: comment!.id } });
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NO_RUN);
    expect(JSON.stringify(notices[0])).not.toContain("completion contract");
  });

  it("issues.ts:20740 save-to-wake: a saved person comment whose wake threw (no run, no wake) -> exactly one notice keyed on the comment", async () => {
    const f = await fixture();
    const commentId = await f.message();
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NO_RUN);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
    expect(codeOf(notices[0]!)).toBe("no_run");
  });

  it("succeeded without a reply -> exactly one notice (no_reply in metadata)", async () => {
    const f = await fixture({ status: "in_review" });
    await f.run({ commentId: await f.message(), status: "succeeded" });
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NO_REPLY);
    expect(codeOf(notices[0]!)).toBe("no_reply");
  });

  it("conversation clause: an ANSWERED waiting chat is a valid wait (no notice); an UNANSWERED one is not (one notice)", async () => {
    const answered = await fixture({ status: "in_review" });
    await answered.reply(await answered.run({ commentId: await answered.message(), status: "succeeded" }));
    await answered.sweep();
    expect(await answered.visible()).toHaveLength(0);
    const unanswered = await fixture({ status: "in_review" });
    await unanswered.run({ commentId: await unanswered.message(), status: "failed", errorCode: "adapter_failed",
      error: "native_session_lease_lost" });
    await unanswered.sweep();
    expect(await unanswered.visible()).toHaveLength(1);
  });

  it("G4: a pre-turn refusal recorded as adapter_failed (legacy_owner_unverified) -> one held notice", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed",
      error: "runner_state_identity_mismatch: legacy_owner_unverified" });
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(HELD);
    expect(codeOf(notices[0]!)).toBe("runner_state_identity_mismatch");
  });

  it("note-port: one true note at a time: the sweep's held 'Send a new message to try again' note retires when the automatic fresh thread starts; without one it stands unchanged; another unanswered note stays", async () => {
    const { supersedeHeldConversationNotice, writePiSessionHistoryLossNotice } = await import("../native-runtime/pi-session-recovery-notice.js");
    const { FRESH_THREAD_STARTED_NOTE } = await import("../native-runtime/fresh-thread-stop-gate.js");
    const current = (rows: { body: string; metadata: unknown }[]) => rows
      .filter(row => !(row.metadata as Record<string, unknown> | null)?.supersededByCommentId).map(row => row.body);
    for (const heldSessionId of [randomUUID(), null]) {
      // The person's attempt fails before any turn (the real sweep writes today's held note under unanswered_message:<id>).
      const f = await fixture();
      const failed = await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed",
        error: "runner_state_identity_mismatch: legacy_owner_unverified" });
      await f.sweep();
      const [held] = await f.visible();
      expect(held!.body).toBe(HELD);
      // A control: a different unanswered note (another message's) on the same task.
      const [other] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system",
        body: "Your message wasn't answered.", metadata: { version: 1, authorizationReason: `unanswered_message:${randomUUID()}`, sections: [] } }).returning();
      // No automatic continuation yet: today's note is unchanged and current.
      expect(current(await f.visible())).toContain(HELD);
      // The automatic fresh thread starts: the real writer pair (selectFreshContinuationThread / pi-conversation-record).
      const authorizationReason = `fresh_provider_thread:${randomUUID()}`;
      await db.transaction(async tx => {
        await writePiSessionHistoryLossNotice(db, tx, { companyId: f.companyId, issueId: f.issueId, runId: failed, agentId: f.agentId,
          authorizationReason, body: FRESH_THREAD_STARTED_NOTE, replaceExisting: true });
        await supersedeHeldConversationNotice(tx, { companyId: f.companyId, issueId: f.issueId, heldSessionId, reason: authorizationReason });
      });
      // A later sweep pass does not write the retired note again.
      await f.sweep();
      const after = await f.visible();
      console.log("[note-port]", JSON.stringify({ heldSessionId, notes: after.map(row => ({ body: row.body.slice(0, 60),
        reason: (row.metadata as any)?.authorizationReason, supersededBy: (row.metadata as any)?.supersededByCommentId ?? null })) }));
      expect(current(after), "the 'Send a new message' note retired").not.toContain(HELD);
      expect(current(after)).toContain(FRESH_THREAD_STARTED_NOTE);
      expect(current(after), "another unanswered note stays").toContain("Your message wasn't answered.");
      expect(after.find(row => row.id === held!.id)!.body, "history kept").toBe(HELD);
      expect(after.find(row => row.id === other!.id)!.metadata).not.toHaveProperty("supersededByCommentId");
    }
  });

  it("G2: the first refusal after a good turn (prior_owner_active) -> one notice", async () => {
    const f = await fixture();
    await f.reply(await f.run({ commentId: await f.message("First question"), status: "succeeded" }));
    await f.run({ commentId: await f.message("Second question"), status: "failed", errorCode: "adapter_failed",
      error: "runner_state_identity_mismatch: prior_owner_active" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
  });

  it("G3: bare runner_process_termination_unconfirmed, and missing_evidence:checkpoint_binding -> one notice each", async () => {
    for (const error of ["runner_process_termination_unconfirmed", "native_controller_recovery_missing_evidence:checkpoint_binding"]) {
      const f = await fixture();
      await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed", error });
      await f.sweep();
      const notices = await f.visible();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.body).toBe(HELD);
    }
  });

  it("G5: pi_conversation_identity_missing -> one notice", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed", error: "pi_conversation_identity_missing" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
  });

  it("raw error text never shows: a prose error keeps only the run's allowlisted code in metadata, plain words in the body", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed",
      error: "Something exploded at /srv/secret/path with token abc123" });
    await f.sweep();
    const [notice] = await f.visible();
    expect(notice!.body).toBe(NOT_ANSWERED);
    expect(JSON.stringify(notice)).not.toMatch(/exploded|secret|abc123/);
    expect(codeOf(notice!)).toBe("adapter_failed");
    const unknown = await fixture();
    await unknown.run({ commentId: await unknown.message(), status: "failed", errorCode: "brand_new_failure_code",
      error: "brand_new_failure_code: provider said something private" });
    await unknown.sweep();
    const [other] = await unknown.visible();
    expect(JSON.stringify(other)).not.toMatch(/brand_new|private/);
    expect(codeOf(other!)).toBe("unclassified_failure");
  });

  it("one per message: repeated sweeps add none; a NEW message after it gets its own", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message("one"), status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
    await f.sweep();
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
    await f.run({ commentId: await f.message("two"), status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(2);
  });

  it("no false notice: a scheduled retry pending, a live run, and an answered message add none", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const failed = await f.run({ commentId, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
    const retry = await f.run({ commentId, status: "scheduled_retry", retryOfRunId: failed });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, retry));
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, retry));
    await f.reply(retry);
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
  });

  it("no false notice: a task with no person message (an agent or timer wake failed) adds none", async () => {
    const f = await fixture();
    await f.run({ commentId: null, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost", wakeReason: "heartbeat_timer" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
  });

  it.each(["retry", "native-status"])("supersedes(D10 row 12): ordered chain rule: PV2b chain: a comment-less %s continuation supersedes its ancestor's notice", async kind => {
    const f = await fixture();
    const commentId = await f.message("What about my follow-up?");
    const failed = await f.run({ commentId, status: "failed", errorCode: "adapter_failed", error: "native_workspace_required" });
    await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId });
    const before = await f.visible();
    expect(before).toHaveLength(1);
    expect(before[0]!.body).toBe(NOT_ANSWERED);
    const continuation = kind === "native-status" ? await f.nativeSuccessor(failed)
      : await f.run({ commentId: null, status: "succeeded", retryOfRunId: failed, wakeReason: "issue_continuation_needed" });
    await f.reply(continuation);
    const outcome = await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId });
    expect(outcome).toEqual({ kind: "answered" });
    expect(await f.visible()).toHaveLength(0);
    const [superseded] = await db.select().from(issueComments).where(eq(issueComments.id, before[0]!.id));
    expect(superseded!.deletedAt).not.toBeNull();
  });

  it("RFL F4: an unrelated timer run's success is not evidence; the message's own path gives exactly one notice", async () => {
    const f = await fixture();
    await f.message();
    await f.run({ commentId: null, status: "succeeded", wakeReason: "heartbeat_timer" });
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NO_RUN);
  });

  it("fabric-v2 (21:40Z): a comment delivered as a run's FIRST-TURN input is carried by that run: no notice while it runs or after it answers; one if it fails", async () => {
    for (const outcome of ["answers", "fails"] as const) {
      const f = await fixture();
      await f.reply(await f.run({ commentId: await f.message("first"), status: "succeeded" }));
      const running = await f.run({ commentId: null, status: "running", wakeReason: "issue_assigned" });
      const commentId = await f.message("A follow-up while you prepare.");
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned",
        firstTurnQueuedInput: { schema: "paperclip.first-turn-queued-input.v1", runId: running, commentIds: [commentId],
          claimedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, running));
      // Its deferred wake was cancelled AS DELIVERED: not "nothing pending".
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
        reason: "issue_execution_deferred", status: "cancelled", finishedAt: new Date(), payload: { issueId: f.issueId, commentId } });
      await f.sweep();
      expect(await f.visible(), `${outcome}: running`).toHaveLength(0);
      if (outcome === "answers") {
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.at() }).where(eq(heartbeatRuns.id, running));
        await f.reply(running);
        await f.sweep();
        expect(await f.visible(), "answered").toHaveLength(0);
      } else {
        await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost",
          finishedAt: f.at() }).where(eq(heartbeatRuns.id, running));
        await f.sweep();
        await f.sweep();
        const notices = await f.visible();
        expect(notices).toHaveLength(1);
        expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
        expect(notices[0]!.body).toBe(NOT_ANSWERED);
      }
    }
  });

  it("RFL F3: an approval requested BEFORE the new message does not answer that message's failed run", async () => {
    const f = await fixture({ status: "blocked" });
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "deploy", requestedByAgentId: f.agentId,
      status: "pending", payload: { summary: "An earlier deployment" }, createdAt: f.at() }).returning();
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: approval!.id, linkedByAgentId: f.agentId });
    await f.run({ commentId: await f.message("What is the status?"), status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
  });

  // RFL bprime3 F1 (22:17Z): the fenced recheck must be the SAME predicate as
  // outside: the turn's own card under every carrying key, and a wake queued
  // while the sweep waits on the fence.
  async function waitForSweepAtIssueFence() {
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      const rows = await db.$client<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike '%for no key update%'`;
      if (rows[0]?.n) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Sweep did not reach the issue fence; race is not established");
  }
  it.each(["wakeCommentId", "commentId", "conversationReplyBoundaryCommentId"] as const)(
    "F1 fence: a carrying run (%s) and ITS OWN card committed while the sweep waits -> no notice, then or later", async key => {
      const f = await fixture({ status: "blocked" });
      const commentId = await f.message();
      await f.run({ commentId, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
      let pending: Promise<void> | undefined;
      try {
        await db.transaction(async tx => {
          await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("no key update");
          pending = f.sweep();
          await waitForSweepAtIssueFence();
          const [answering] = await tx.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
            runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId, [key]: commentId },
            createdAt: sql`statement_timestamp()`, finishedAt: sql`statement_timestamp()` }).returning();
          await tx.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation",
            status: "pending", sourceRunId: answering!.id, createdByAgentId: f.agentId, addresseeUserId: f.userId,
            payload: { version: 1, prompt: "Apply this?" } as never, createdAt: sql`statement_timestamp()` });
        });
      } finally { await pending; }
      await f.sweep();
      expect(await f.visible()).toHaveLength(0);
    });

  it("F1 fence: a wake for the message queued while the sweep waits -> no notice", async () => {
    const f = await fixture({ status: "blocked" });
    const commentId = await f.message();
    await f.run({ commentId, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
    let pending: Promise<void> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("no key update");
        pending = f.sweep();
        await waitForSweepAtIssueFence();
        await tx.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
          reason: "issue_commented", status: "queued", payload: { issueId: f.issueId, commentId } });
      });
    } finally { await pending; }
    expect(await f.visible()).toHaveLength(0);
  });

  it("25-SILENT-BLOCK (org 23:03Z): an accepted native result that declared a blocker but whose words were never published -> exactly one notice", async () => {
    const f = await fixture();
    const commentId = await f.message("Deploy it.");
    const runId = await f.run({ commentId, status: "succeeded" });
    const contractId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "46".repeat(32), createdByActorType: "system", createdByActorId: "fixture" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId, completionContractId: contractId,
      serverFingerprint: "fixture", schemaStatus: "accepted", canonicalSha256: "fixture",
      resultJson: { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "blocked", summary: "The deploy key is missing.",
        blocker: { scope: "current_track", owner: { kind: "system", name: "Deploy key" }, reasonCode: "permission_denied",
          unblockAction: "Add the deploy key, then retry." } },
        terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", reportedWorkDisposition: "blocked" } } });
    await f.sweep();
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
    // Published words answer it: the same shape WITH the run's reply is quiet.
    const g = await fixture();
    const replied = await g.run({ commentId: await g.message("Deploy it."), status: "succeeded" });
    await g.reply(replied);
    await g.sweep();
    expect(await g.visible()).toHaveLength(0);
  });

  // M1.1 (RFL 02:57Z, hq-test warm1/warm2: 'native_session_recovery_failed:
  // runner_remote_state_unavailable', 0 notices): a queued wake carrying the
  // issue kept the decision pending every 30 s forever. The wait is now bounded
  // by a durable T0 (recorded once) + 2 min.
  const AFTER_WAKE_BOUND_MS = 3 * 60_000;
  const settleAt = (f: { companyId: string; issueId: string }, ms: number) =>
    settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(Date.now() + ms) });
  const queueWake = (f: { companyId: string; agentId: string; issueId: string }, payload: Record<string, unknown>) =>
    db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_continuation_needed", status: "queued", payload }).returning().then(rows => rows[0]!);

  // Keep: S10-1, gate 3, 2026-11-17: Stop cancelled 6a1cdfa9; the next
  // message's 6558f709 wake waited on remote_cleanup, then 0a65c27c answered.
  // The sweep falsely said "no run started" while that attempt was pending.
  async function stoppedMessageWithWait(status: string, executionWait: unknown) {
    const f = await fixture();
    await f.run({ commentId: await f.message("Before Stop"), status: "cancelled", errorCode: "cancelled" });
    const commentId = await f.message("After Stop, please continue.");
    const now = new Date();
    const createdAt = new Date(now.getTime() - 120_000);
    await db.update(issueComments).set({ createdAt }).where(eq(issueComments.id, commentId));
    const payload = { issueId: f.issueId, commentId, executionWait };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", reason: "issue_execution_deferred", requestedByActorType: "user",
      requestedByActorId: f.userId, status, payload, createdAt, updatedAt: createdAt }).returning();
    return { ...f, commentId, wakeId: wake!.id, now };
  }

  it.each(["deferred", "deferred_issue_execution"])(
    "supersedes(pausefix4 F1: the standing waiting note says working while its OWN run runs; RFL record SUPERSEDE-PAUSEFIX-RUNNING-1118): waitnote S10-1: %s remote_cleanup after Stop stays pending, then its completed wake's run answers without a resend notice", async status => {
      const f = await stoppedMessageWithWait(status, { reason: "remote_cleanup",
        message: "Waiting for the previous environment to stop. Your message will start automatically.", recoveryActionId: null });
      // The production sweep entry, not just its decision helper, must be quiet
      // at message +2 min (the original false-notice time).
      await f.sweep();
      expect(await f.visible()).toHaveLength(0);
      await settleAt(f, PENDING_WAIT_BOUND_MS + 1_000);
      const [waiting] = await f.visible();
      expect(waiting?.body).toBe(WAITING);
      expect(waiting?.presentation).toMatchObject({ title: "Your message is waiting to start" });
      expect(codeOf(waiting!)).toBeUndefined();
      await settleAt(f, 5 * 60_000);
      expect((await f.visible()).map(note => note.body)).toEqual([WAITING]);
      f.at(15 * 60_000); // the later run/reply are after the saved message
      const runId = await f.run({ commentId: f.commentId, status: "running" });
      await db.update(agentWakeupRequests).set({ status: "completed", runId, finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, f.wakeId));
      await settleAt(f, 6 * 60_000);
      expect((await f.visible()).map(note => note.body)).toEqual([WORKING]);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await f.reply(runId);
      await f.sweep();
      expect(await f.visible()).toHaveLength(0);
      const history = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
      expect(history.map(note => note.body)).toEqual([WORKING]);
      expect(history[0]!.deletedAt).not.toBeNull();
    });

  // Keep: rf5 independent waitnote F1 caught a real lifecycle pause cancelling
  // the still-deferred carrying wake, then resume being called another failure.
  async function deferredMessageBeforePause() {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const f = await fixture();
    await db.update(agents).set({ status: "idle", lifecycleState: "ready" }).where(eq(agents.id, f.agentId));
    const commentId = await f.message("After Stop, continue my saved work.");
    await db.update(issueComments).set({ createdAt: new Date(start) }).where(eq(issueComments.id, commentId));
    const payload = { issueId: f.issueId, commentId, executionWait: { reason: "remote_cleanup",
      message: "Waiting for the previous environment to stop. Your message will start automatically.", recoveryActionId: null } };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: f.userId, payload,
      createdAt: new Date(start), updatedAt: new Date(start) }).returning();
    const advance = (minute: number) => vi.setSystemTime(start + minute * 60_000);
    const stampedWaits = new Set<string>();
    const sweep = async (minute: number) => {
      advance(minute);
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
      // Date-only timers do not change PostgreSQL defaultNow(): stamp each T0
      // once at its sweep's virtual time, without restarting the durable bound.
      const clocks = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, PENDING_WAIT_ACTION)));
      for (const clock of clocks) if (!stampedWaits.has(clock.id)) {
        await db.update(activityLog).set({ createdAt: new Date() }).where(eq(activityLog.id, clock.id));
        stampedWaits.add(clock.id);
      }
      return f.visible();
    };
    return { ...f, commentId, wakeId: wake!.id, payload, advance, sweep };
  }

  it.each(["paused", "waiting", "none"] as const)(
    "pausewake rf5: pause cancels deferred wake with no run, resume +1/+11 gives the true pause note (standing %s)", async standing => {
      const f = await deferredMessageBeforePause();
      if (standing !== "none") {
        await f.sweep(1); await f.sweep(5);
        expect((await f.visible()).map(note => note.body)).toEqual([WAITING]);
      }
      f.advance(5.1);
      const lifecycle = createAgentLifecycle(db);
      const driver = createLifecycleDriver(db, {} as never);
      const worker = configureAgentLifecycle(db, { ...driver, requiredPluginIds: async () => [], runPlugin: async () => "complete" });
      try {
        await lifecycle.pauseAgent(f.agentId); await worker.process(f.agentId);
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
        expect(wake).toMatchObject({ status: "cancelled", runId: null, error: "Agent lifecycle stop requested",
          reason: "issue_execution_deferred", payload: f.payload });
        expect(wake!.finishedAt).not.toBeNull();
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
        if (standing === "paused") {
          const paused = await f.sweep(5.5);
          expect(paused).toHaveLength(1);
          expect(rowsOf(paused[0]!).find(row => row.label === "Waiting code")?.value).toBe("agent_paused");
        }
        const before = (await f.visible())[0];
        f.advance(6); await lifecycle.resumeAgent(f.agentId); await worker.process(f.agentId);
        expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.lifecycleState).toBe("ready");
        for (const minute of [7, 17]) {
          const notes = await f.sweep(minute);
          if (process.env.PAUSEWAKE_EVIDENCE_FILE) appendFileSync(process.env.PAUSEWAKE_EVIDENCE_FILE,
            `${JSON.stringify({ standing, minute, wake, notes })}\n`);
          expect(notes).toHaveLength(1);
          expect.soft(notes[0]!.body, `resume+${minute - 6}m`).toBe("Managed Pi was paused before it answered your message. Send it again to continue.");
          expect.soft(notes[0]!.presentation).toMatchObject({ title: "Managed Pi was paused before it answered" });
          expect.soft(codeOf(notes[0]!)).toBeUndefined();
          expect.soft(JSON.stringify(notes[0])).not.toContain("if it fails again");
          if (before) {
            expect(notes[0]!.id).toBe(before.id);
            expect(notes[0]!.createdAt.getTime()).toBe(before.createdAt.getTime());
          }
        }
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(1);
      } finally { await worker.stop(); }
    });

  it.each([
    { status: "cancelled", error: "Cancelled as delivered to another turn" },
    { status: "cancelled", error: "Cancelled because the company was archived" },
    { status: "cancelled", error: null },
    { status: "failed", error: "Agent lifecycle stop requested" },
  ])("pausewake guard: a wake cancelled for another reason or failed keeps no_run (%j)", async input => {
    const f = await deferredMessageBeforePause();
    f.advance(5);
    await db.update(agentWakeupRequests).set({ ...input, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, f.wakeId));
    for (const minute of [7, 17]) {
      const notes = await f.sweep(minute);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toBe(NO_RUN);
      expect(codeOf(notes[0]!)).toBe("no_run");
    }
  });

  it.each(["message", "issue", "agent", "linked-run", "later-failure"] as const)(
    "pausewake guard: a pause-cancelled wake cannot mask a different or later attempt (%s)", async control => {
      const f = await deferredMessageBeforePause();
      f.advance(5);
      const other = await fixture();
      const otherCommentId = await other.message();
      const unrelatedRun = control === "linked-run" ? await f.run({ status: "succeeded" }) : null;
      await db.update(agentWakeupRequests).set({ status: "cancelled", error: "Agent lifecycle stop requested",
        finishedAt: new Date(), updatedAt: new Date(), runId: unrelatedRun,
        ...(control === "agent" ? { agentId: other.agentId } : {}),
        payload: { ...f.payload, ...(control === "message" ? { commentId: otherCommentId } : {}),
          ...(control === "issue" ? { issueId: other.issueId } : {}) } })
        .where(eq(agentWakeupRequests.id, f.wakeId));
      if (control === "later-failure") {
        f.advance(6);
        await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
          source: "on_demand", reason: "issue_commented", status: "failed", error: "A later wake failed",
          payload: f.payload, createdAt: new Date(), updatedAt: new Date(), finishedAt: new Date() });
      }
      const notes = await f.sweep(7);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toBe(NO_RUN);
      expect(codeOf(notes[0]!)).toBe("no_run");
    });

  it("waitnote: execution_recovery uses the existing start bound and upgrades the SAME waiting note after it", async () => {
    const f = await stoppedMessageWithWait("deferred_issue_execution", { reason: "execution_recovery", message: "Recovery will retry automatically." });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await settleAt(f, PENDING_WAIT_BOUND_MS + 1_000);
    const [waiting] = await f.visible();
    expect(waiting?.body).toBe(WAITING);
    await settleAt(f, PENDING_WAIT_START_BOUND_MS - 1_000);
    expect((await f.visible()).map(note => note.body)).toEqual([WAITING]);
    await settleAt(f, PENDING_WAIT_START_BOUND_MS + 1_000);
    const notes = await f.visible();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe(waiting!.id);
    expect(notes[0]!.body).toBe(NO_RUN);
    expect(codeOf(notes[0]!)).toBe("no_run");
    await settleAt(f, PENDING_WAIT_START_BOUND_MS + 60_000);
    expect(await f.visible()).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, PENDING_WAIT_ACTION))))
      .toHaveLength(1);
  });

  it.each(["deferred", "deferred_issue_execution"].flatMap(status =>
    [undefined, null, "remote_cleanup", {}, { reason: "remote_cleanup" },
      { reason: " ", message: "Waiting" }, { reason: "remote_cleanup", message: false },
      [{ reason: "remote_cleanup", message: "Waiting" }]].map(executionWait => ({ status, executionWait }))))(
    "waitnote guard: malformed or missing wait retains today's behaviour (%j)", async ({ status, executionWait }) => {
      const f = await stoppedMessageWithWait(status, executionWait);
      await f.sweep();
      expect(await f.visible()).toHaveLength(status === "deferred" ? 1 : 0); // unchanged initial pending grace
      await settleAt(f, PENDING_WAIT_BOUND_MS + 1_000);
      const notes = await f.visible();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toBe(NO_RUN);
    });

  it("waitnote guard: an unrelated deferred wait and a coalesced receipt alone do not silence a failed message", async () => {
    const f = await fixture();
    const commentId = await f.message();
    await f.run({ commentId, status: "failed", errorCode: "adapter_failed" });
    for (const [status, carriedId] of [["deferred", randomUUID()], ["coalesced", commentId]]) {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
        status, payload: { issueId: f.issueId, commentId: carriedId,
          executionWait: { reason: "remote_cleanup", message: "Waiting" } } });
    }
    await f.sweep();
    expect((await f.visible()).map(note => note.body)).toEqual([NOT_ANSWERED]);
  });

  it("waitnote guard: a failed run with no deferred wake still gets its resend notice", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed" });
    await f.sweep();
    expect((await f.visible()).map(note => note.body)).toEqual([NOT_ANSWERED]);
  });

  it("M1.1 (1): a queued wake carrying the issue that never runs -> no notice inside the bound, exactly one after it", async () => {
    const f = await fixture();
    const commentId = await f.message();
    await f.run({ commentId, status: "failed", errorCode: "native_session_recovery_failed",
      error: "native_session_recovery_failed: runner_remote_state_unavailable" });
    await queueWake(f, { issueId: f.issueId });
    await f.sweep();
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
    expect(JSON.stringify(notices[0])).not.toContain("runner_remote_state_unavailable");
  });

  it("M1.1 (2): a queued wake that DOES start a run carrying the message within the bound -> no notice", async () => {
    const f = await fixture();
    const commentId = await f.message();
    await f.run({ commentId, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
    const wake = await queueWake(f, { issueId: f.issueId, commentId });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    const started = await f.run({ commentId, status: "running" });
    await db.update(agentWakeupRequests).set({ status: "completed", runId: started, finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    expect(await f.visible()).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, started));
    await f.reply(started);
    await settleAt(f, AFTER_WAKE_BOUND_MS + 60_000);
    expect(await f.visible()).toHaveLength(0);
  });

  it("M1.1 (3): two workers racing T0 and then the bound -> exactly one notice", async () => {
    const f = await fixture();
    const commentId = await f.message();
    await f.run({ commentId, status: "failed", errorCode: "native_session_recovery_failed",
      error: "native_session_recovery_failed: runner_remote_state_unavailable" });
    await queueWake(f, { issueId: f.issueId });
    await Promise.all([f.sweep(), f.sweep()]);
    expect(await f.visible()).toHaveLength(0);
    await Promise.all([settleAt(f, AFTER_WAKE_BOUND_MS), settleAt(f, AFTER_WAKE_BOUND_MS)]);
    expect(await f.visible()).toHaveLength(1);
  });

  // M1.1 widened (03:03Z): every wait for a further attempt except a turn in
  // progress is bounded the same way. One RED per wait, each with a control.
  const finalization = (f: { companyId: string; issueId: string }, runId: string, phase: string, nextAttemptAt: Date | null = null) =>
    db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId, phase, nextAttemptAt });

  it("M1.1 (4): a native finalization stuck in workspace_pending -> exactly one notice after the bound", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const runId = await f.run({ commentId, status: "succeeded" });
    await finalization(f, runId, "workspace_pending");
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
  });

  it("M1.1 (4) control: workspace_pending that commits and answers within the bound -> no notice", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const runId = await f.run({ commentId, status: "succeeded" });
    await finalization(f, runId, "workspace_pending");
    await f.sweep();
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, runId));
    await f.reply(runId);
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    expect(await f.visible()).toHaveLength(0);
  });

  it("M1.1 (5): a retryable_failure with no next attempt -> exactly one notice after the bound", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const runId = await f.run({ commentId, status: "failed", errorCode: "native_session_interrupted",
      error: "native_session_recovery_failed: runner_remote_state_unavailable" });
    await finalization(f, runId, "retryable_failure", null);
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    expect(await f.visible()).toHaveLength(1);
  });

  it("M1.1 (5) control: the retry starts a run carrying the message within the bound, which answers -> no notice", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const runId = await f.run({ commentId, status: "failed", errorCode: "native_session_interrupted" });
    await finalization(f, runId, "retryable_failure", null);
    await f.sweep();
    const retry = await f.run({ commentId, status: "running", retryOfRunId: runId });
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    expect(await f.visible()).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, retry));
    await f.reply(retry);
    await settleAt(f, AFTER_WAKE_BOUND_MS + 60_000);
    expect(await f.visible()).toHaveLength(0);
  });

  it("M1.1 (6): a missing-comment retry (retry_queued) that never runs -> exactly one notice after the bound", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const runId = await f.run({ commentId, status: "succeeded" });
    await db.update(heartbeatRuns).set({ issueCommentStatus: "retry_queued" }).where(eq(heartbeatRuns.id, runId));
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NO_REPLY);
  });

  it("M1.1 (6) control: the missing-comment retry posts the reply within the bound -> no notice", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const runId = await f.run({ commentId, status: "succeeded" });
    await db.update(heartbeatRuns).set({ issueCommentStatus: "retry_queued" }).where(eq(heartbeatRuns.id, runId));
    await f.sweep();
    await f.reply(runId);
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    expect(await f.visible()).toHaveLength(0);
  });

  it("M1.1 control: a running turn on the task that does not carry the message (busy agent) is never bounded -> no notice", async () => {
    const f = await fixture();
    await f.reply(await f.run({ commentId: await f.message("first"), status: "succeeded" }));
    await f.run({ commentId: null, status: "running", wakeReason: "issue_continuation_needed" });
    const second = await f.message("A follow-up during the long turn.");
    await queueWake(f, { issueId: f.issueId, commentId: second });
    await f.sweep();
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    await settleAt(f, 30 * 60_000);
    expect(await f.visible()).toHaveLength(0);
  });

  // RFL 03:16Z (E3.04): only a RUNNING turn is unbounded. A queued run that
  // carries the message but is never claimed gets one "waiting to start" note.
  it("E3.04: a carrying run queued behind a full agent -> one 'waiting' note at the bound; it starts later -> no second note; its answer supersedes it", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const queued = await f.run({ commentId, status: "queued" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    let notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(WAITING);
    expect(notices[0]!.presentation).toMatchObject({ title: "Your message is waiting to start" });
    // RFL 20:36Z: the waiting note is written open (systemNoticePresentation).
    expect(notices[0]!.presentation).toMatchObject({ detailsDefaultOpen: true });
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, queued));
    await settleAt(f, AFTER_WAKE_BOUND_MS + 60_000);
    notices = await f.visible();
    expect(notices).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, queued));
    await f.reply(queued);
    await settleAt(f, AFTER_WAKE_BOUND_MS + 120_000);
    expect(await f.visible()).toHaveLength(0);
  });

  // RFL 03:26Z: "it will start by itself" must stay TRUE. A carrying run that
  // still has not started by T0 + 10 min turns the SAME note into the failure
  // text; the waiting note carries no failure code.
  const rowsOf = (notice: { metadata: unknown }) =>
    ((notice.metadata as { sections?: Array<{ rows: Array<{ label?: string; value?: string }> }> })?.sections ?? []).flatMap(section => section.rows);
  it("E3.04 (2nd bound): a carrying queued run that never starts -> waiting note at ~2 min, the SAME note becomes the failure text at ~10 min", async () => {
    const f = await fixture();
    const commentId = await f.message();
    await f.run({ commentId, status: "queued" });
    await f.sweep();
    await settleAt(f, 3 * 60_000);
    let notices = await f.visible();
    expect(notices).toHaveLength(1);
    const noteId = notices[0]!.id;
    expect(notices[0]!.body).toBe(WAITING);
    expect(rowsOf(notices[0]!).some(row => row.label === "Failure code")).toBe(false);
    expect(rowsOf(notices[0]!).find(row => row.label === "Waiting code")?.value).toBe("waiting_to_start");
    expect((await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      unansweredPersonMessageCommentCondition()))).length, "the waiting note keeps the obligation open").toBeGreaterThan(0);
    await settleAt(f, 6 * 60_000);
    expect((await f.visible())[0]!.body).toBe(WAITING);
    await settleAt(f, 11 * 60_000);
    notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.id).toBe(noteId);
    expect(notices[0]!.body).toBe(NO_RUN);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
    expect(rowsOf(notices[0]!).some(row => row.label === "Waiting code")).toBe(false);
    await settleAt(f, 12 * 60_000);
    expect(await f.visible()).toHaveLength(1);
  });

  it("supersedes(pausefix4 F1: the standing waiting note says working while its OWN run runs; RFL record SUPERSEDE-PAUSEFIX-RUNNING-1118): E3.04 (2nd bound) control: the carrying run starts at 5 min -> the SAME note says working, then the answer supersedes it", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const queued = await f.run({ commentId, status: "queued" });
    await f.sweep();
    await settleAt(f, 3 * 60_000);
    expect((await f.visible())[0]!.body).toBe(WAITING);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, queued));
    await settleAt(f, 5 * 60_000);
    await settleAt(f, 11 * 60_000);
    let notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(WORKING);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, queued));
    await f.reply(queued);
    await settleAt(f, 12 * 60_000);
    notices = await f.visible();
    expect(notices).toHaveLength(0);
  });

  it("E3.04 control: a RUNNING run carrying the message is never bounded (a quiet healthy turn) -> no note at +30 min", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "running" });
    await f.sweep();
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    await settleAt(f, 30 * 60_000);
    expect(await f.visible()).toHaveLength(0);
  });

  // RFL 04:58Z: a PAUSED agent's chat. "Sending it again is safe" is false
  // advice there; the note says the agent is paused and who can resume it.
  const WORKING = UNANSWERED_MESSAGE_WORKING_TEXT("Managed Pi");
  const PAUSED_TEXT = "Managed Pi is paused. Your message is saved, and it will run when Managed Pi is resumed. "
    + "A board user or Managed Pi's manager can resume Managed Pi.";
  const pause = (f: { agentId: string }) => db.update(agents).set({ status: "paused", lifecycleState: "paused",
    lifecycleHolds: ["manual"], pauseReason: "manual" }).where(eq(agents.id, f.agentId));
  const resume = (f: { agentId: string }) => db.update(agents).set({ status: "active", lifecycleState: "ready",
    lifecycleHolds: [], pauseReason: null }).where(eq(agents.id, f.agentId));

  // Keep: NOTE 7(c), first-chat setup was falsely described as an operator pause.
  it.each([
    ["preparing", null], ["preparing", "setup"],
    ["verifying", null], ["verifying", "setup"],
  ] as const)("NOTE7c: %s with pauseReason=%s keeps the first message pending, then its own run answers after ready", async (lifecycleState, pauseReason) => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused", lifecycleState, pauseReason, lifecycleHolds: [], lifecycleError: null })
      .where(eq(agents.id, f.agentId));
    // Four minutes old: past settle/no-run grace, but inside the setup bound.
    const commentId = await f.message("My first chat message, while setup is still running.", 11 * 60_000);
    // RED must reach the production heartbeat entry before a direct settle assertion.
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    const now = new Date();
    expect(await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now }))
      .toEqual({ kind: "pending", recheckAt: now.getTime() + 30_000 });
    await settleAt(f, 2 * 60_000);
    expect(await f.visible()).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(0);
    await resume(f);
    const runId = await f.run({ commentId, status: "running" });
    expect((await settleAt(f, 12 * 60_000)).kind).toBe("pending");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.at() }).where(eq(heartbeatRuns.id, runId));
    await f.reply(runId);
    expect((await settleAt(f, 13 * 60_000)).kind).toBe("answered");
    expect(await f.visible()).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
  });

  // Keep: judge NOTE7c-fix2 caught a setup wait that stayed silent forever.
  it.each(["preparing", "verifying"] as const)("NOTE7c stalled %s: the production sweep posts exactly one true setup note at ten minutes", async lifecycleState => {
    const start = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    try {
      const f = await fixture();
      await db.update(agents).set({ status: "paused", lifecycleState, pauseReason: "setup", lifecycleHolds: [], lifecycleError: null })
        .where(eq(agents.id, f.agentId));
      const commentId = await f.message("Please answer when setup finishes.", 900_000);
      // A delayed first sweep must not restart the ten-minute message clock.
      vi.setSystemTime(new Date(start.getTime() + 240_000));
      await f.sweep();
      expect(await f.visible()).toHaveLength(0);
      const waits = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
        eq(activityLog.action, "issue.unanswered_message_wait")));
      expect(waits).toHaveLength(1);
      expect(waits[0]!.details).toMatchObject({ messageId: commentId, waitKind: "setup", startedAt: start.toISOString(), boundMs: 600_000 });
      vi.setSystemTime(new Date(start.getTime() + 600_000 - 1));
      await f.sweep();
      expect(await f.visible()).toHaveLength(0);
      vi.setSystemTime(new Date(start.getTime() + 600_000));
      await f.sweep();
      const [note] = await f.visible();
      expect(await f.visible()).toHaveLength(1);
      const hhmm = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
      expect(note!.body).toBe(`Managed Pi is still being set up (since ${hhmm}). Your message is saved and will be answered as soon as it's ready.`);
      expect(note!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
      expect(rowsOf(note!).some(row => row.label === "Failure code")).toBe(false);
      expect(JSON.stringify(note)).not.toMatch(/paused|resume|send.*again/i);
      for (const elapsed of [660_000, 3_600_000, 25 * 3_600_000, 7 * 24 * 3_600_000]) {
        vi.setSystemTime(new Date(start.getTime() + elapsed));
        await f.sweep();
        expect((await f.visible()).map(n => ({ id: n.id, body: n.body }))).toEqual([{ id: note!.id, body: note!.body }]);
      }
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
        eq(activityLog.action, "issue.unanswered_message_wait")))).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(0);
      // A setup error still takes the existing error path, updating the same note.
      vi.setSystemTime(new Date(start.getTime() + 720_000));
      await db.update(agents).set({ lifecycleError: "Saved execution configuration failed verification." }).where(eq(agents.id, f.agentId));
      await f.sweep();
      expect((await f.visible()).map(n => ({ id: n.id, body: n.body }))).toEqual([{ id: note!.id, body: PAUSED_TEXT }]);
      await resume(f);
      const runId = await f.run({ commentId, status: "succeeded" });
      await f.reply(runId);
      await f.sweep();
      expect(await f.visible()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("NOTE7c late discovery: a first sweep after ten minutes records setup's message start and posts immediately", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused", lifecycleState: "preparing", pauseReason: "setup", lifecycleHolds: [], lifecycleError: null })
      .where(eq(agents.id, f.agentId));
    const commentId = await f.message("Setup was already stalled when the sweep first ran.");
    const [message] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    await f.sweep();
    const [note] = await f.visible();
    expect(await f.visible()).toHaveLength(1);
    expect(note!.body).toContain("Managed Pi is still being set up (since ");
    const [wait] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, "issue.unanswered_message_wait")));
    expect(wait!.details).toMatchObject({ waitKind: "setup", startedAt: message!.createdAt.toISOString(), boundMs: 600_000 });
    await f.sweep();
    expect((await f.visible()).map(n => n.id)).toEqual([note!.id]);
  });

  it.each([
    { lifecycleHolds: ["manual"] as const, pauseReason: "setup" as const, lifecycleError: null },
    { lifecycleHolds: [] as const, pauseReason: "manual" as const, lifecycleError: null },
    { lifecycleHolds: [] as const, pauseReason: "setup" as const, lifecycleError: "Saved execution configuration failed verification." },
  ])("NOTE7c guard: setup-looking state with a hold, explicit pause or lifecycle failure still follows the existing notice path (%j)", async input => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused", lifecycleState: "verifying", ...input,
      lifecycleHolds: [...input.lifecycleHolds] }).where(eq(agents.id, f.agentId));
    await f.message();
    expect((await settleAt(f, 0)).kind).toBe("noticed");
    expect((await f.visible()).map(notice => notice.body)).toEqual([PAUSED_TEXT]);
  });

  it("paused agent: a person's message gets ONE note that says the agent is paused and who can resume it, never 'sending again is safe'", async () => {
    const f = await fixture();
    await pause(f);
    const commentId = await f.message("Are you there?");
    await f.sweep();
    await settleAt(f, 3 * 60_000);
    await settleAt(f, 10 * 60_000);
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(PAUSED_TEXT);
    expect(notices[0]!.body).not.toMatch(/sending it again|send the message again|safe/i);
    expect(notices[0]!.presentation).toMatchObject({ title: "Managed Pi is paused" });
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
    expect(rowsOf(notices[0]!).some(row => row.label === "Failure code")).toBe(false);
  });

  // Keep: S10 gate 3, 2026-11-18 04:54Z: after a person's Stop and a Send the
  // chat said '<agent> is paused'; nobody paused it. A 'pausing'/'resuming'
  // transition with no hold, pause reason or error ends by itself, so the
  // Send gets the waiting note, never the paused line.
  it.each(["pausing", "resuming"] as const)("paused-line: %s with no hold after a person's Stop, then a Send -> the waiting note, never the paused line", async lifecycleState => {
    const f = await fixture();
    await f.run({ commentId: await f.message("Before Stop"), status: "cancelled", errorCode: "cancelled" });
    await db.update(agents).set({ status: "paused", lifecycleState, lifecycleHolds: [], pauseReason: null, lifecycleError: null })
      .where(eq(agents.id, f.agentId));
    await f.message("After Stop, please continue.");
    await f.sweep();
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    const notices = await f.visible();
    expect(notices.map(n => n.body)).toEqual([WAITING]);
    expect(JSON.stringify(notices)).not.toMatch(/is paused|resume/i);
  });

  it("paused-line control: the pause route's hold on a pausing agent keeps the paused line", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message("Before Stop"), status: "cancelled", errorCode: "cancelled" });
    await db.update(agents).set({ status: "paused", lifecycleState: "pausing", lifecycleHolds: ["manual"], pauseReason: "manual" })
      .where(eq(agents.id, f.agentId));
    await f.message("After Stop, please continue.");
    await f.sweep();
    await settleAt(f, AFTER_WAKE_BOUND_MS);
    expect((await f.visible()).map(n => n.body)).toEqual([PAUSED_TEXT]);
  });

  // Keep: stack-lead live fact on B, 2026-11-18: an agent RESUMED before the
  // message still said '<agent> is paused' while it worked and above its
  // answer. The real lifecycle writers the pause and resume routes call
  // (routes/agents.ts:6105 pauseAgent, :6142 resumeAgent); the worker's
  // 'complete' (pausing -> paused) is the one write simulated here.
  const pauseRoute = async (f: { agentId: string }) => {
    await createAgentLifecycle(db).pauseAgent(f.agentId);
    await db.update(agents).set({ lifecycleState: "paused" }).where(eq(agents.id, f.agentId));
  };
  const resumeRoute = async (f: { agentId: string }) => {
    await createAgentLifecycle(db).resumeAgent(f.agentId);
    const [row] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(row).toMatchObject({ lifecycleState: "resuming", status: "paused", lifecycleHolds: [], pauseReason: null });
  };
  const noPausedLine = async (f: { visible: () => Promise<Array<{ body: string }>> }, when: string) =>
    expect(JSON.stringify(await f.visible()), when).not.toMatch(/is paused|resume/i);
  const answers = (f: { issueId: string }) => db.select().from(issueComments)
    .where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "agent")));

  it.each([[true, null], [false, null], [true, LIFECYCLE_ENVIRONMENT_WAIT_MESSAGE], [false, LIFECYCLE_ENVIRONMENT_WAIT_MESSAGE]] as const)(
    "pause-resume 1: chat=%s, pause -> resume (resuming, lifecycleError=%s) -> message: no paused line at +0, +2 m, +10 m; answered once",
    async (chat, lifecycleError) => {
      const f = await fixture({ chat });
      await pauseRoute(f);
      await resumeRoute(f);
      if (lifecycleError) await db.update(agents).set({ lifecycleError }).where(eq(agents.id, f.agentId));
      const commentId = await f.message("After the resume: are you there?");
      await f.sweep();
      await noPausedLine(f, "+0");
      const run = await f.run({ commentId, status: "running" });
      await settleAt(f, 2 * 60_000);
      await noPausedLine(f, "+2 m");
      await settleAt(f, 10 * 60_000);
      await noPausedLine(f, "+10 m");
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run));
      await f.reply(run);
      await settleAt(f, 11 * 60_000);
      expect(await f.visible()).toHaveLength(0);
      expect(await answers(f)).toHaveLength(1);
    });

  it.each([[true, "waits"], [false, "waits"], [true, "runs"], [false, "runs"]] as const)(
    "supersedes(pausefix: stale paused note after Resume; RFL record SUPERSEDE-PAUSEFIX-RUNNING-1118): pause-resume 2: chat=%s, pause -> message -> resume (the turn %s): the SAME sweep replaces the paused note with ONE note (working while its own run runs, else waiting); the answer supersedes it",
    async (chat, turn) => {
      const f = await fixture({ chat });
      await pauseRoute(f);
      const commentId = await f.message("While paused: are you there?");
      await f.sweep();
      const [pausedNote] = await f.visible();
      expect((await f.visible()).map(n => n.body)).toEqual([PAUSED_TEXT]);
      await resumeRoute(f);
      const run = turn === "runs" ? await f.run({ commentId, status: "running" }) : null;
      await f.sweep();
      const replaced = turn === "runs" ? WORKING : WAITING;
      expect((await f.visible()).map(n => ({ id: n.id, body: n.body }))).toEqual([{ id: pausedNote!.id, body: replaced }]);
      const carrying = run ?? await f.run({ commentId, status: "running" });
      // Its OWN run is RUNNING now in both variants: the SAME note says working (F1).
      for (const ms of [2 * 60_000, 10 * 60_000]) {
        await settleAt(f, ms);
        expect((await f.visible()).map(n => ({ id: n.id, body: n.body })), `+${ms}`).toEqual([{ id: pausedNote!.id, body: WORKING }]);
      }
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, carrying));
      await f.reply(carrying);
      await f.sweep();
      expect(await f.visible()).toHaveLength(0);
      expect(await answers(f)).toHaveLength(1);
    });

  it.each([
    ["the pause route's hold", null],
    ["budget", { status: "paused", lifecycleState: "paused", lifecycleHolds: ["budget"], pauseReason: "budget", lifecycleError: null }],
    ["company_paused", { status: "paused", lifecycleState: "paused", lifecycleHolds: ["company_paused"], pauseReason: "company_paused", lifecycleError: null }],
    ["a pauseReason with no hold", { status: "paused", lifecycleState: "paused", lifecycleHolds: [], pauseReason: "manual", lifecycleError: null }],
    ["a lifecycleError", { status: "paused", lifecycleState: "paused", lifecycleHolds: [], pauseReason: null, lifecycleError: "Saved execution configuration failed verification." }],
  ] as const)("pause-resume 3 control: %s keeps the paused line ONCE while truly paused (chat and task)", async (_shape, row) => {
    for (const chat of [true, false]) {
      const f = await fixture({ chat });
      if (row) await db.update(agents).set({ ...row, lifecycleHolds: [...row.lifecycleHolds] }).where(eq(agents.id, f.agentId));
      else await pauseRoute(f);
      await f.message("Are you there?");
      await f.sweep();
      const [note] = await f.visible();
      for (const ms of [2 * 60_000, 10 * 60_000]) {
        await settleAt(f, ms);
        expect((await f.visible()).map(n => ({ id: n.id, body: n.body })), `chat=${chat} +${ms}`).toEqual([{ id: note!.id, body: PAUSED_TEXT }]);
      }
    }
  });

  it.each([[true, null], [false, LIFECYCLE_ENVIRONMENT_WAIT_MESSAGE]] as const)(
    "pause-resume 4: chat=%s, a 'resuming' that sticks (lifecycleError=%s) is never paused: the waiting note, then the no-run text at +10 m",
    async (chat, lifecycleError) => {
      const f = await fixture({ chat });
      await pauseRoute(f);
      await resumeRoute(f);
      if (lifecycleError) await db.update(agents).set({ lifecycleError }).where(eq(agents.id, f.agentId));
      await f.message("After the resume: are you there?");
      await f.sweep();
      await noPausedLine(f, "+0");
      await settleAt(f, AFTER_WAKE_BOUND_MS);
      const [note] = await f.visible();
      expect((await f.visible()).map(n => n.body)).toEqual([WAITING]);
      await settleAt(f, 11 * 60_000);
      expect((await f.visible()).map(n => ({ id: n.id, body: n.body }))).toEqual([{ id: note!.id, body: NO_RUN }]);
    });

  // pausefix 2 (rf-5 P1, org 10:32Z): after a Resume, the stale paused note
  // says 'working' ONLY while a run whose OWN input carries the message is
  // RUNNING (w1); a queued/scheduled run, another message's run or another
  // task's run keeps the waiting text. The working note never outlives its
  // run (w2): the SAME note gets RFL's started-run text. One note (w3).
  const pausedThenResumed = async (chat: boolean) => {
    const f = await fixture({ chat });
    await pauseRoute(f);
    const commentId = await f.message("While paused: are you there?");
    await f.sweep();
    const [pausedNote] = await f.visible();
    expect(pausedNote!.body).toBe(PAUSED_TEXT);
    await resumeRoute(f);
    return { f, commentId, pausedNote: pausedNote! };
  };
  const one = async (f: { visible: () => Promise<Array<{ id: string; body: string }>> }) =>
    (await f.visible()).map(n => ({ id: n.id, body: n.body }));

  it.each([true, false])("pausefix2 RED: chat=%s, its OWN run is running after the Resume: the SAME note says the agent is working on it (title, no next action); the answer supersedes it", async chat => {
    const { f, commentId, pausedNote } = await pausedThenResumed(chat);
    const run = await f.run({ commentId, status: "running" });
    await f.sweep();
    const notes = await f.visible();
    expect(notes.map(n => ({ id: n.id, body: n.body }))).toEqual([{ id: pausedNote.id, body: WORKING }]);
    expect(notes[0]!.presentation).toMatchObject({ title: UNANSWERED_MESSAGE_WORKING_TITLE("Managed Pi") });
    expect(JSON.stringify(notes[0]!.metadata)).not.toMatch(/Next action/);
    await settleAt(f, 4 * 60_000);
    expect(await one(f)).toEqual([{ id: pausedNote.id, body: WORKING }]);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run));
    await f.reply(run);
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    expect(await answers(f)).toHaveLength(1);
  });

  it.each(["queued", "scheduled_retry"] as const)("pausefix2 w1: its own run is %s (not running): the SAME note is the waiting text, never 'working'", async status => {
    const { f, commentId, pausedNote } = await pausedThenResumed(true);
    await f.run({ commentId, status });
    await f.sweep();
    expect(await one(f)).toEqual([{ id: pausedNote.id, body: WAITING }]);
  });

  it.each(["another task", "another message on this task"] as const)("pausefix2 CONTROL: the agent's running run is %s's: the SAME note is the waiting text (true)", async other => {
    const { f, commentId, pausedNote } = await pausedThenResumed(true);
    if (other === "another task") {
      const [otherIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Other work", assigneeAgentId: f.agentId,
        status: "in_progress" }).returning();
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "native",
        nativeIssueId: otherIssue!.id, contextSnapshot: { issueId: otherIssue!.id, wakeReason: "issue_assigned" } });
      await f.run({ commentId, status: "queued" });
    } else {
      await f.run({ commentId: null, status: "running", wakeReason: "heartbeat_timer" });
    }
    await f.sweep();
    expect(await one(f)).toEqual([{ id: pausedNote.id, body: WAITING }]);
  });

  it.each([
    ["fails", "resuming", { status: "failed", errorCode: "adapter_failed" }, STARTED_FAILED],
    ["is cancelled", "resuming", { status: "cancelled", errorCode: "cancelled" }, STARTED_FAILED],
    ["succeeds with no reply", "resuming", { status: "succeeded", errorCode: null }, STARTED_NO_REPLY],
    ["fails", "ready", { status: "failed", errorCode: "adapter_failed" }, STARTED_FAILED],
    ["is cancelled", "ready", { status: "cancelled", errorCode: "cancelled" }, STARTED_FAILED],
    ["succeeds with no reply", "ready", { status: "succeeded", errorCode: null }, STARTED_NO_REPLY],
  ] as const)("pausefix2 w2: the working note's run %s without answering (agent %s): the SAME note becomes RFL's started-run text; one note", async (_end, state, end, text) => {
    const { f, commentId, pausedNote } = await pausedThenResumed(true);
    const run = await f.run({ commentId, status: "running" });
    await f.sweep();
    expect(await one(f)).toEqual([{ id: pausedNote.id, body: WORKING }]);
    // 'ready': the lifecycle worker's resuming -> ready 'complete' (status idle).
    if (state === "ready") await db.update(agents).set({ lifecycleState: "ready", status: "idle" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ ...end, finishedAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, run));
    await settleAt(f, 2 * 60_000);
    expect(await one(f)).toEqual([{ id: pausedNote.id, body: text }]);
    expect(JSON.stringify(await f.visible())).not.toMatch(/working on|safe/i);
  });

  // pausefix 4 (rf-5 F1): Resume's sweep ran BEFORE the carrying run started,
  // so the SAME note is the waiting note. Its OWN run then RUNNING makes the
  // next sweep say working (the shared standing-note transition, not a
  // Resume-only case); every other live run keeps the waiting text.
  const waitingThenResumed = async (chat: boolean) => {
    const { f, commentId, pausedNote } = await pausedThenResumed(chat);
    await f.sweep();
    expect(await one(f)).toEqual([{ id: pausedNote.id, body: WAITING }]);
    return { f, commentId, pausedNote };
  };

  it.each([[true, "answers"], [false, "answers"], [true, "fails"], [false, "fails"], [true, "succeeds with no reply"], [false, "succeeds with no reply"]] as const)(
    "pausefix4 F1: chat=%s, a standing WAITING note becomes the SAME working note when its OWN run is running; then the run %s",
    async (chat, end) => {
      const { f, commentId, pausedNote } = await waitingThenResumed(chat);
      const run = await f.run({ commentId, status: "running" });
      await f.sweep();
      const notes = await f.visible();
      expect(notes.map(n => ({ id: n.id, body: n.body }))).toEqual([{ id: pausedNote.id, body: WORKING }]);
      expect(notes[0]!.presentation).toMatchObject({ title: UNANSWERED_MESSAGE_WORKING_TITLE("Managed Pi") });
      expect(JSON.stringify(notes[0]!.metadata)).not.toMatch(/Next action/);
      if (end === "answers") {
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run));
        await f.reply(run);
        await f.sweep();
        expect(await f.visible()).toHaveLength(0);
        expect(await answers(f)).toHaveLength(1);
        return;
      }
      await db.update(heartbeatRuns).set({ status: end === "fails" ? "failed" : "succeeded",
        errorCode: end === "fails" ? "adapter_failed" : null, finishedAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, run));
      await settleAt(f, 2 * 60_000);
      expect(await one(f)).toEqual([{ id: pausedNote.id, body: end === "fails" ? STARTED_FAILED : STARTED_NO_REPLY }]);
    });

  it.each(["another message's run running", "its own run queued", "its own run scheduled_retry", "another task's run running"] as const)(
    "pausefix4 F1 CONTROL: a standing WAITING note stays WAITING (never working) when %s",
    async other => {
      const { f, commentId, pausedNote } = await waitingThenResumed(true);
      if (other === "another message's run running") {
        await f.run({ commentId: null, status: "running", wakeReason: "heartbeat_timer" });
      } else if (other === "another task's run running") {
        const [otherIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Other work", assigneeAgentId: f.agentId,
          status: "in_progress" }).returning();
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "native",
          nativeIssueId: otherIssue!.id, contextSnapshot: { issueId: otherIssue!.id, wakeReason: "issue_commented", wakeCommentId: commentId } });
      } else {
        await f.run({ commentId, status: other === "its own run queued" ? "queued" : "scheduled_retry" });
      }
      await f.sweep();
      expect(await one(f)).toEqual([{ id: pausedNote.id, body: WAITING }]);
      await settleAt(f, 60_000);
      expect(await one(f)).toEqual([{ id: pausedNote.id, body: WAITING }]);
    });

  // pausefix 3 (rf-5 L1, Paul's event-driven rule): the standing paused note's
  // own recheck is 5 min again; the RESUME EVENT drives the upgrade. The resume
  // transition hands the task to the stranded sweep's per-issue entry at commit
  // (what recovery/work.ts does with the hint is replayed here, once per hint).
  it.each([[true, "waits"], [false, "waits"], [true, "runs"], [false, "runs"]] as const)(
    "pausefix3 L1: chat=%s, Resume (the turn %s) upgrades the SAME paused note through the sweep's per-issue entry at commit, not at the 5-min recheck",
    async (chat, turn) => {
      const f = await fixture({ chat });
      await pauseRoute(f);
      const commentId = await f.message("While paused: are you there?");
      await f.sweep();
      const [pausedNote] = await f.visible();
      expect(pausedNote!.body).toBe(PAUSED_TEXT);
      const before = Date.now();
      const standing = await settleAt(f, 0);
      expect(standing.kind).toBe("pending");
      expect((standing as { recheckAt: number }).recheckAt, "the standing paused recheck is 5 min").toBeGreaterThanOrEqual(before + 5 * 60_000);
      const hints: string[] = [];
      const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.strandedAssignments, (event, set) => {
        if (event === "settled") hints.push(...(set ?? []));
      });
      try { await resumeRoute(f); } finally { unsubscribe(); }
      if (turn === "runs") await f.run({ commentId, status: "running" });
      const deadlines: number[] = [];
      for (const hint of new Set(hints)) {
        const scope = JSON.parse(hint) as { companyId: string; issueId?: string };
        if (scope.companyId !== f.companyId || scope.issueId !== f.issueId) continue;
        await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: scope.companyId, issueId: scope.issueId, unanswered: true,
          skipExternalConversationSettlement: true, skipRelatedRecovery: true, onDeferredDeadline: at => deadlines.push(at) });
      }
      expect(await one(f), "upgraded at the Resume, not at +5 min").toEqual([{ id: pausedNote!.id, body: turn === "runs" ? WORKING : WAITING }]);
      expect(hints.map(hint => JSON.parse(hint))).toContainEqual({ companyId: f.companyId, issueId: f.issueId });
    });

  it("supersedes(pausefix: stale paused note after Resume; RFL record SUPERSEDE-PAUSEFIX-RUNNING-1118): paused agent, then resumed: the saved message's run is the only run (B' starts none), no second note, the answer supersedes it", async () => {
    const f = await fixture();
    await pause(f);
    const commentId = await f.message("Are you there?");
    await f.sweep();
    await settleAt(f, 3 * 60_000);
    expect((await f.visible()).map(n => n.body)).toEqual([PAUSED_TEXT]);
    const runsCarrying = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId)))
      .filter(r => (r.contextSnapshot as Record<string, unknown> | null)?.wakeCommentId === commentId).length;
    expect(await runsCarrying()).toBe(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(0);
    // Resumed: Paperclip delivers the saved message to one run of its own.
    await resume(f);
    const run = await f.run({ commentId, status: "running" });
    const [pausedNote] = await f.visible();
    await settleAt(f, 4 * 60_000);
    // pausefix 2: no longer paused and its OWN run is running, so the SAME note says the agent is working on it.
    expect((await f.visible()).map(n => ({ id: n.id, body: n.body }))).toEqual([{ id: pausedNote!.id, body: WORKING }]);
    await settleAt(f, 20 * 60_000);
    expect((await f.visible()).map(n => ({ id: n.id, body: n.body }))).toEqual([{ id: pausedNote!.id, body: WORKING }]);
    expect(await runsCarrying()).toBe(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run));
    await f.reply(run);
    await settleAt(f, 21 * 60_000);
    expect(await f.visible()).toHaveLength(0);
  });

  it("paused while a waiting-to-start note stands: the SAME note becomes the paused text", async () => {
    const f = await fixture();
    const commentId = await f.message();
    await f.run({ commentId, status: "queued" });
    await f.sweep();
    await settleAt(f, 3 * 60_000);
    const [waitingNote] = await f.visible();
    expect(waitingNote!.body).toBe(WAITING);
    await pause(f);
    await settleAt(f, 4 * 60_000);
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.id).toBe(waitingNote!.id);
    expect(notices[0]!.body).toBe(PAUSED_TEXT);
  });

  it("RFL F2 lock order: the sweep and the executor's held-notice writer run CONCURRENTLY, both orders, no deadlock, exactly one notice", async () => {
    for (let round = 0; round < 4; round++) {
      const f = await fixture();
      const sessionId = randomUUID();
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed", runtimeMode: "native",
        nativeIssueId: f.issueId, nativeSessionId: sessionId, contextSnapshot: { issueId: f.issueId }, createdAt: f.at(), finishedAt: f.at() });
      const refused = await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed",
        error: "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate" });
      await db.update(heartbeatRuns).set({ nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, refused));
      const [late] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "native",
        nativeIssueId: f.issueId, nativeSessionId: sessionId, contextSnapshot: { issueId: f.issueId } }).returning();
      const writer = () => noticeHeldUnfinishedPredecessor({ db, execution: { provider: { kind: "pi_rpc" },
        binding: { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: late!.id },
        session: { normalizedSessionId: sessionId } } as never }, new Error("runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate"));
      const sweep = () => heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
      await expect(Promise.all(round % 2 ? [writer(), sweep()] : [sweep(), writer()])).resolves.toBeDefined();
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(Date.now() - 60_000) }).where(eq(heartbeatRuns.id, late!.id));
      await sweep();
      expect(await f.visible(), `round ${round}`).toHaveLength(1);
    }
  });

  it("RFL F2, the other order: the sweep's notice first, then the executor's held-notice writer adds none (same issue fence)", async () => {
    const f = await fixture();
    const sessionId = randomUUID();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: f.issueId, nativeSessionId: sessionId, contextSnapshot: { issueId: f.issueId }, createdAt: f.at(), finishedAt: f.at() });
    const refused = await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed",
      error: "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate" });
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, refused));
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
    const [late] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "native",
      nativeIssueId: f.issueId, nativeSessionId: sessionId, contextSnapshot: { issueId: f.issueId } }).returning();
    await noticeHeldUnfinishedPredecessor({ db, execution: { provider: { kind: "pi_rpc" },
      binding: { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: late!.id },
      session: { normalizedSessionId: sessionId } } as never }, new Error("runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate"));
    expect(await f.visible()).toHaveLength(1);
  });

  it("a later answer supersedes the notice", async () => {
    const f = await fixture();
    const commentId = await f.message();
    const failed = await f.run({ commentId, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
    const success = await f.run({ commentId, status: "succeeded", retryOfRunId: failed });
    await f.reply(success);
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
  });

  // RFL 20:42Z (b): a BLOCKED task the person is legitimately waiting on after
  // the agent answered stays quiet, and the new blocked visit skips it.
  // Loaded dynamically so this file also runs (RED) on a base without the module.
  const visitedWhileBlocked = async (issueId: string) => {
    const module = await import("./unanswered-person-message.js").catch(() => null);
    if (!module) return null;
    return (await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issueId), module.unansweredPersonMessageCondition(issues.id, issues.companyId)))).length > 0;
  };

  it("no false notice: blocked on an approval after the agent answered -> quiet, not visited", async () => {
    const f = await fixture({ status: "blocked" });
    const done = await f.run({ commentId: await f.message("Please deploy it."), status: "succeeded" });
    await f.reply(done);
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "deploy", requestedByAgentId: f.agentId,
      status: "pending", payload: { summary: "Deploy to production" } }).returning();
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: approval!.id, linkedByAgentId: f.agentId });
    expect(await visitedWhileBlocked(f.issueId)).toBe(false);
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
  });

  it("no false notice: blocked on a question card to the person (the agent's answer is the card) -> quiet", async () => {
    const f = await fixture({ status: "blocked" });
    const asked = await f.run({ commentId: await f.message("Which region?"), status: "succeeded" });
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions",
      status: "pending", createdByAgentId: f.agentId, sourceRunId: asked, addresseeUserId: f.userId,
      payload: { version: 1, questions: [{ id: "region", prompt: "Which region?", selectionMode: "single",
        options: [{ id: "eu", label: "EU" }, { id: "us", label: "US" }] }] } as never, createdAt: f.at() });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
  });

  // Keep: PV2b gate-4: a final from a later chain run answers the original
  // input even when only the failed predecessor still carries its comment id.
  it.each([
    ["carrying", "context"], ["continuation", "context"], ["carrying", "delivery"], ["continuation", "delivery"],
  ] as const)(
    "PV2b chain: message -> %s card -> answer-resume (%s) fails -> successor final never gets a resend notice", async (cardSource, answerLink) => {
      const f = await fixture({ status: "in_review" });
      const messageId = await f.message("Build Sol; ask me for the name first.");
      const carryingRunId = await f.run({ commentId: messageId, status: "succeeded" });
      const sourceRunId = cardSource === "carrying" ? carryingRunId
        : await f.run({ status: "succeeded", retryOfRunId: carryingRunId });
      const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
        kind: "ask_user_questions", status: "pending", sourceRunId, createdByAgentId: f.agentId,
        addresseeUserId: f.userId, continuationPolicy: "wake_assignee", createdAt: f.at(),
        payload: { version: 1, questions: [{ id: "name", prompt: "What is the product called?", required: true,
          selectionMode: "single", options: [{ id: "sol", label: "Sol" }] }] } }).returning();
      const noticesEver = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
        sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
      expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "answered" });
      expect(await noticesEver()).toHaveLength(0);
      await issueThreadInteractionService(db).answerQuestions({ id: f.issueId, companyId: f.companyId }, card!.id,
        { answers: [{ questionId: "name", optionIds: ["sol"] }] }, { userId: f.userId });
      const resume = await f.run({ status: "failed", errorCode: "native_run_failed" });
      if (answerLink === "context") {
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, interactionId: card!.id,
          interactionStatus: "answered", source: "issue.interaction.respond" } }).where(eq(heartbeatRuns.id, resume));
      } else {
        await db.update(issueQuestionResponseDeliveries).set({ targetRunId: resume, status: "fallback_queued",
          deliveryMode: "wake_fallback" }).where(eq(issueQuestionResponseDeliveries.interactionId, card!.id));
      }
      expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "answered" });
      const successor = await f.nativeSuccessor(resume);
      await f.reply(successor);
      expect(await freshContinuationDescendsFrom(db, { companyId: f.companyId, issueId: f.issueId,
        runId: successor, ancestorRunId: carryingRunId, includeAnswerLineage: true })).toBe(true);
      await f.sweep();
      expect(await noticesEver()).toHaveLength(0);
      expect(await readContinuationCommentInput(db, { ...f, runId: carryingRunId })).toEqual({});
      // A previously published notice is superseded too, not merely hidden
      // by the decision to avoid writing another one.
      const [stale] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "system", body: NOT_ANSWERED, createdAt: f.at(), metadata: { version: 1,
          authorizationReason: `unanswered_message:${messageId}`, sourceRunId: resume, sections: [] } }).returning();
      await settleUnansweredPersonMessage(db, f);
      expect(await f.visible()).toHaveLength(0);
      expect((await db.select().from(issueComments).where(eq(issueComments.id, stale!.id)))[0]!.deletedAt).not.toBeNull();
    });

  it("PV2b chain: a final after multiple failed ancestors answers without copied input ids or a card", async () => {
    const f = await fixture();
    const messageId = await f.message();
    const root = await f.run({ commentId: messageId, status: "failed", errorCode: "native_run_failed" });
    const resume = await f.run({ status: "failed", retryOfRunId: root, errorCode: "native_run_failed" });
    const final = await f.run({ status: "succeeded" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, previousRunId: resume,
      wakeReason: "native_status_decision" } }).where(eq(heartbeatRuns.id, final));
    await f.reply(final);
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "answered" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    expect(await readContinuationCommentInput(db, { ...f, runId: root })).toEqual({});
    expect(await db.select().from(issueComments).where(and(eq(issueComments.id, messageId),
      unansweredPersonMessageCommentCondition()))).toHaveLength(0);
  });

  it("PV2b chain guard: all runs fail without a reply or card -> one notice; an unrelated final cannot hide it", async () => {
    const f = await fixture();
    const messageId = await f.message();
    const root = await f.run({ commentId: messageId, status: "failed", errorCode: "native_run_failed" });
    await f.run({ status: "failed", retryOfRunId: root, errorCode: "native_run_failed" });
    const unrelated = await f.run({ status: "succeeded", wakeReason: "heartbeat_timer" });
    const sessionId = randomUUID();
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId })
      .where(sql`${heartbeatRuns.id} in (${root}, ${unrelated})`);
    await f.reply(unrelated);
    for (let pass = 0; pass < 2; pass++) {
      await settleUnansweredPersonMessage(db, f);
      expect(await f.visible()).toHaveLength(1);
      expect((await f.visible())[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${messageId}`);
    }
    expect(await readContinuationCommentInput(db, { ...f, runId: root })).toMatchObject({ wakeCommentIds: [messageId] });
  });

  it.each(["proposed-decision", "unrelated-effect", "unbound-wake"])(
    "PV2b chain guard: %s is not native continuation provenance", async variant => {
      const f = await fixture();
      const messageId = await f.message();
      const root = await f.run({ commentId: messageId, status: "failed", errorCode: "native_run_failed" });
      const successor = await f.nativeSuccessor(root);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, successor));
      const decisionId = String(wake!.payload!.nativeDecisionId);
      if (variant === "proposed-decision") {
        await db.update(statusDecisions).set({ applicationState: "proposed" }).where(eq(statusDecisions.id, decisionId));
      } else if (variant === "unrelated-effect") {
        await db.update(statusDecisionEffects).set({ effectKind: "bind_blocker" }).where(eq(statusDecisionEffects.decisionId, decisionId));
      } else {
        await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, wake!.id));
      }
      await f.reply(successor);
      expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed" });
      expect((await f.visible())[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${messageId}`);
      expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "noticed_before" });
    });

  it("PV2b chain: a pending output-cap continuation never asks for a resend; its final answers the chain", async () => {
    const f = await fixture();
    const root = await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_run_failed" });
    // The sweep observes the durable continuation, not a provider-specific
    // output-cap string. No input ids need to be copied into its context.
    const successor = await f.nativeSuccessor(root, "queued");
    expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "pending" });
    expect(await f.visible()).toHaveLength(0);
    expect(await settleUnansweredPersonMessage(db, { ...f, now: new Date(Date.now() + 180_000) }))
      .toMatchObject({ kind: "noticed", code: "waiting_to_start" });
    expect((await f.visible()).map(note => note.body)).toEqual([WAITING]);
    // A real output-cap successor still queued beyond the ordinary start
    // bound is waiting work, not permission to send duplicate input.
    expect(await settleUnansweredPersonMessage(db, { ...f, now: new Date(Date.now() + 20 * 60_000) }))
      .toMatchObject({ kind: "pending" });
    expect((await f.visible()).map(note => note.body)).toEqual([WAITING]);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successor));
    expect(await settleUnansweredPersonMessage(db, { ...f, now: new Date(Date.now() + 240_000) }))
      .toMatchObject({ kind: "pending" });
    expect((await f.visible()).every(note => !note.body.includes("Sending it again"))).toBe(true);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.at() }).where(eq(heartbeatRuns.id, successor));
    await f.reply(successor);
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "answered" });
    expect(await f.visible()).toHaveLength(0);
  });

  // Keep: recorded PV2 gate-1 catch (11:27Z): answering the run's question
  // removed its pending-card exemption before response delivery could wake it.
  it.each([true, false])("PV2 card-answer: no resend notice before, during or after one answer delivery (chat=%s)", async chat => {
    const f = await fixture({ chat, status: "in_review" });
    const messageId = await f.message("Build the landing page.");
    const sourceRunId = await f.run({ commentId: messageId, status: "running" });
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "pending", sourceRunId, createdByAgentId: f.agentId,
      addresseeUserId: f.userId, continuationPolicy: "wake_assignee", createdAt: f.at(),
      payload: { version: 1, questions: [{ id: "name", prompt: "What is the product called?", required: true,
        selectionMode: "single", options: [{ id: "sol", label: "Sol" }] }] } }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.at() }).where(eq(heartbeatRuns.id, sourceRunId));
    const noticesEver = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
    await f.sweep();
    expect(await noticesEver()).toHaveLength(0);

    const answered = await issueThreadInteractionService(db).answerQuestions({ id: f.issueId, companyId: f.companyId }, card!.id,
      { answers: [{ questionId: "name", optionIds: ["sol"] }] }, { userId: f.userId });
    expect(answered.status).toBe("answered");
    // The exact live race: the card answer committed, but no delivery wake exists yet.
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "answered" });
    await f.sweep();
    expect(await noticesEver()).toHaveLength(0);
    expect(await readContinuationCommentInput(db, { ...f, runId: sourceRunId })).toEqual({});

    // Only provider dispatch is replaced: the real answer transaction, delivery
    // claim/idempotency, durable wake, sweep and reply attribution all use PostgreSQL.
    const delivery = questionResponseDeliveryService(db, { heartbeat: {
      wakeup: async (agentId, wake) => {
        const [target] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId,
          nativeIssueId: f.issueId, runtimeMode: "native", status: "queued", contextSnapshot: wake?.contextSnapshot }).returning();
        await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId, source: "automation",
          reason: "issue_commented", status: "queued", runId: target!.id, idempotencyKey: wake?.idempotencyKey,
          payload: wake?.payload });
        return target!;
      },
      cancelRun: async () => { throw new Error("A question answer must not cancel a run"); },
    } });
    const first = await delivery.deliver(card!.id);
    const duplicate = await delivery.deliver(card!.id);
    expect(first).toMatchObject({ status: "fallback_queued", mode: "wake_fallback", duplicate: false });
    expect(duplicate).toMatchObject({ targetRunId: first!.targetRunId, duplicate: true });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.payload).toMatchObject({ interactionId: card!.id, interactionStatus: "answered" });
    expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, card!.id)))
      .toHaveLength(1);
    await f.sweep();
    expect(await noticesEver()).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.at() }).where(eq(heartbeatRuns.id, first!.targetRunId!));
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, wakes[0]!.id));
    await f.reply(first!.targetRunId!);
    await f.sweep();
    expect(await noticesEver()).toHaveLength(0);
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "agent"))))
      .toHaveLength(1);
  });

  // Keep: rf5 H4 F1 caught confirmation acceptance changing pending -> accepted,
  // which made the original input look unanswered again. Use the production
  // creation and resolution services, not a hand-written terminal status.
  it.each([
    { chat: true, decision: "accept" }, { chat: false, decision: "accept" },
    { chat: true, decision: "reject" }, { chat: false, decision: "reject" },
    { chat: true, decision: "skip" }, { chat: false, decision: "skip" },
    { chat: true, decision: "withdraw" }, { chat: false, decision: "withdraw" },
  ] as const)("H4 confirmation reply: $decision leaves no notice or carry (chat=$chat)", async ({ chat, decision }) => {
    const f = await fixture({ chat, status: "in_progress" });
    const messageId = await f.message("Apply the proposed change.");
    const sourceRunId = await f.run({ commentId: messageId, status: "running" });
    const svc = issueThreadInteractionService(db);
    const scope = { id: f.issueId, companyId: f.companyId };
    const card = await svc.create(scope, {
      kind: "request_confirmation", sourceRunId, continuationPolicy: "none",
      payload: { version: 1, prompt: "Apply this change?", rejectRequiresReason: true },
    }, { agentId: f.agentId, runId: sourceRunId });
    expect(card.status).toBe("pending");
    // Align the real card/run with the fixture's elapsed settlement clock.
    await db.update(issueThreadInteractions).set({ createdAt: f.at() }).where(eq(issueThreadInteractions.id, card.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.at() }).where(eq(heartbeatRuns.id, sourceRunId));
    const noticesEver = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
    const assertQuiet = async () => {
      await f.sweep();
      expect(await noticesEver(), "no notice, including soft-deleted notices").toHaveLength(0);
      expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "answered" });
      expect(await readContinuationCommentInput(db, { ...f, runId: sourceRunId })).toEqual({});
      expect(await db.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.id, messageId), unansweredPersonMessageCommentCondition()))).toHaveLength(0);
    };
    await assertQuiet();
    const actor = { userId: f.userId };
    const reason = { reason: "Keep the current behavior." };
    const resolved = decision === "accept"
      ? (await svc.acceptInteraction({ ...scope, projectId: null, goalId: null }, card.id, {}, actor)).interaction
      : decision === "reject" ? await svc.rejectInteraction(scope, card.id, reason, actor)
      : decision === "skip" ? await svc.skipInteraction(scope, card.id, reason, actor)
      : await svc.withdrawInteraction(scope, card.id, reason, actor);
    const expectedStatus = { accept: "accepted", reject: "rejected", skip: "cancelled", withdraw: "cancelled" };
    expect(resolved).toMatchObject({ status: expectedStatus[decision], resolvedByUserId: f.userId });
    await assertQuiet();
    // Cross the 10-minute no-reply grace as well as ordinary settlement, then
    // sweep twice. No provider reply or continuation wake can mask this bug.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(heartbeatRuns.id, sourceRunId));
    await assertQuiet();
    await assertQuiet();
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "agent")))).toHaveLength(0);
  });

  it.each(["wakeCommentId", "commentId", "conversationReplyBoundaryCommentId", "wakeCommentIds", "firstTurnQueuedInput"])(
    "PV2 card-answer: open and answered cards answer only their own carried input through %s", async key => {
      const f = await fixture();
      const earlier = await f.message("Still waiting in the queue.");
      const messageId = await f.message("The steered input.");
      const runId = await f.run({ status: "succeeded" });
      const contextSnapshot = { issueId: f.issueId, steeredCommentIds: [messageId],
        [key]: key === "wakeCommentIds" ? [messageId] : key === "firstTurnQueuedInput" ? { commentIds: [messageId] } : messageId };
      await db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, runId));
      for (const kind of ["ask_user_questions", "request_confirmation"] as const) {
        const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
          kind, status: "pending", sourceRunId: runId, createdByAgentId: f.agentId, createdAt: f.at(),
          payload: kind === "ask_user_questions" ? { version: 1, questions: [] } : { version: 1, prompt: "Proceed?" } }).returning();
        for (const status of kind === "ask_user_questions" ? ["pending", "answered"] : ["pending", "accepted", "rejected"]) {
          await db.update(issueThreadInteractions).set({ status }).where(eq(issueThreadInteractions.id, card!.id));
          expect(await settleUnansweredPersonMessage(db, f), `${kind}/${status}`).toEqual({ kind: "answered" });
          expect(await readContinuationCommentInput(db, { ...f, runId })).toEqual({});
          const pending = await pendingContinuationCommentInput(db, { ...f, contextSnapshot: { wakeCommentIds: [earlier] } });
          expect(pending.wakeCommentIds, "a card for the steered input must not consume earlier queued messages").toEqual([earlier]);
          const candidates = await db.select({ id: issueComments.id }).from(issueComments).where(and(
            eq(issueComments.id, messageId), unansweredPersonMessageCommentCondition()));
          expect(candidates, `${kind}/${status}: discovery and settlement agree`).toHaveLength(0);
        }
        await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.id, card!.id));
      }
    });

  it.each(["cancelled", "expired", "failed", "cancelled-by-admin", "expired-by-admin", "other-run", "other-task", "other-company", "board"])(
    "PV2 card-answer guard: %s is not an answered message", async variant => {
      const f = await fixture();
      const messageId = await f.message();
      const sourceRunId = await f.run({ commentId: messageId, status: "succeeded" });
      const other = await fixture();
      const unrelatedRun = await f.run({ status: "succeeded" });
      await db.insert(issueThreadInteractions).values({ companyId: variant === "other-company" ? other.companyId : f.companyId,
        issueId: variant === "other-task" ? other.issueId : f.issueId, kind: "ask_user_questions",
        status: variant.endsWith("-by-admin") ? variant.split("-")[0] : ["cancelled", "expired", "failed"].includes(variant) ? variant : "answered",
        ...(variant.endsWith("-by-admin") ? { resolvedByUserId: f.userId,
          result: { version: 1, outcome: "issue_closed", answers: [] } } : {}),
        sourceRunId: variant === "other-run" ? unrelatedRun : sourceRunId,
        createdByAgentId: variant === "board" ? null : f.agentId, createdAt: f.at(), payload: { version: 1, questions: [] } });
      expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed", code: "no_reply" });
      expect(await f.visible()).toHaveLength(1);
    });

  it("the blocked visit DOES include a blocked task whose person's message is unanswered", async () => {
    const f = await fixture({ status: "blocked" });
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_session_retry_exhausted" });
    expect(await visitedWhileBlocked(f.issueId)).toBe(true);
  });

  it("the executor's standing held notice for the conversation adds no second notice", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed",
      error: "runner_state_identity_mismatch: prior_owner_active" });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: HELD, authorType: "system",
      metadata: { version: 1, authorizationReason: `native_prior_owner_held:${randomUUID()}`, sections: [] }, createdAt: f.at() });
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
  });
  // RFL second judge (21:33Z), cases copied unchanged from .local/rfl-bprime/bprime2-judge-cases.ts.

  it("JUDGE: a pending approval from BEFORE the latest failed message does not answer that message", async () => {
    const f = await fixture({ status: "blocked" });
    const prior = await f.run({ commentId: await f.message("Deploy when approved."), status: "succeeded" });
    await f.reply(prior);
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "deploy", requestedByAgentId: f.agentId,
      status: "pending", payload: { summary: "Deploy to production" }, createdAt: f.at() }).returning();
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: approval!.id,
      linkedByAgentId: f.agentId, createdAt: f.at() });
    const message = await f.message("Never mind the deploy. What is the current version?");
    const failed = await f.run({ commentId: message, status: "failed", errorCode: "adapter_failed", error: "Native session failed" });
    await f.boardHold("native_continuation_requires_reconciliation", failed);
    await f.sweep();
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${message}`);
  });

  it("JUDGE: a question card from BEFORE the latest failed message does not answer that message", async () => {
    const f = await fixture({ status: "blocked" });
    const prior = await f.run({ commentId: await f.message("Deploy it."), status: "succeeded" });
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions",
      status: "pending", createdByAgentId: f.agentId, sourceRunId: prior, addresseeUserId: f.userId,
      payload: { version: 1, questions: [{ id: "region", prompt: "Which region?", selectionMode: "single",
        options: [{ id: "eu", label: "EU" }, { id: "us", label: "US" }] }] } as never, createdAt: f.at() });
    const message = await f.message("Never mind the deploy. What is the current version?");
    const failed = await f.run({ commentId: message, status: "failed", errorCode: "adapter_failed" });
    await f.boardHold("native_continuation_requires_reconciliation", failed);
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${message}`);
  });

  it("JUDGE: a newer board-created confirmation for someone else does not answer the latest failed message", async () => {
    const f = await fixture({ status: "blocked" });
    const message = await f.message("What is the current version?");
    const failed = await f.run({ commentId: message, status: "failed", errorCode: "adapter_failed" });
    await f.boardHold("native_continuation_requires_reconciliation", failed);
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "pending", sourceRunId: null, continuationPolicy: "none",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
      addresseeUserId: "someone-else", createdByUserId: f.userId, title: "Other person's decision", createdAt: f.at(),
      payload: { version: 1, prompt: "Approve the unrelated deploy?" } });
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${message}`);
  });

  it("JUDGE: a succeeded message-owned run with no reply stays visible despite a later succeeded timer", async () => {
    const f = await fixture({ status: "in_review" });
    const message = await f.message();
    await f.run({ commentId: message, status: "succeeded" });
    await f.run({ status: "succeeded", wakeReason: "heartbeat_timer" });
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NO_REPLY);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${message}`);
  });

  it.each(["wakeCommentIds", "wakeCommentId", "commentId", "conversationReplyBoundaryCommentId"])(
    "JUDGE: succeeded-without-reply carries message through %s", async key => {
      const f = await fixture({ status: "in_review" });
      const message = await f.message();
      const run = await f.run({ status: "succeeded" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, [key]: key === "wakeCommentIds" ? [message] : message } })
        .where(eq(heartbeatRuns.id, run));
      await f.sweep();
      const notices = await f.visible();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.body).toBe(NO_REPLY);
    });
});
