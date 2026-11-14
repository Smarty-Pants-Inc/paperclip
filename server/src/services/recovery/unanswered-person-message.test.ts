import { randomUUID } from "node:crypto";
import {
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
  issues,
  completionContracts,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { noticeHeldUnfinishedPredecessor } from "../native-runtime/native-session-executor.js";
import { settleUnansweredPersonMessage, unansweredPersonMessageCommentCondition } from "./unanswered-person-message.js";

// C9 (Smarty fork): a person's message that nothing answers gets exactly ONE
// visible notice from the stranded sweep, in plain words, with the code in the
// metadata. Each case is a REAL shape: a refusal string from .local/SILENT-F.md
// or a production record shape named in the test title, on an agent with
// managed instructions. "Visible" is the v2 chat filter (TaskChatThread.tsx:930):
// a system comment is hidden only when recoveryResponsibility is "system".
const HELD = "Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.";
const NOT_ANSWERED = "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.";
const NO_RUN = "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
const NO_REPLY = "This run finished without a reply to your message. Sending it again is safe.";
// org 09:11Z: the default fixture is a CHAT (isConversation), where B''s action names a new chat, not
// a new task. Rows whose fixture is a chat assert these; task rows keep the task constants above.
const CHAT_NOT_ANSWERED = "Your message wasn't answered. Sending it again is safe; if it fails again, start a new chat with Managed Pi; this one stays readable.";
const CHAT_NO_RUN = "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, start a new chat with Managed Pi; this one stays readable.";
const CHAT_HELD = "Managed Pi can't continue this chat from its saved state. Start a new chat with Managed Pi; this one stays readable.";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("unanswered person message notice (C9, the stranded sweep)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("unanswered-person-message-");
    db = createDb(database.connectionString);
  }, 60_000);
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
    return { companyId, agentId, issueId, userId, message, run, reply, boardHold, sweep, visible, at };
  }

  const codeOf = (comment: { metadata: unknown }) => {
    const sections = ((comment.metadata as Record<string, unknown>)?.sections ?? []) as Array<{ rows: Array<{ label?: string; value?: string }> }>;
    return sections.flatMap(section => section.rows).find(row => row.label === "Failure code")?.value;
  };

  it("SMAA-143 msg 1: native_session_interrupted (backup_without_reusable_lease) with its retries exhausted -> exactly one notice, code in metadata only", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
    const f = await fixture({ status: "blocked" });
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_session_interrupted",
      error: "runner_harness_state_mismatch: backup_without_reusable_lease" });
    await f.boardHold("native_session_retry_exhausted", id);
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(CHAT_NOT_ANSWERED);
    expect(notices[0]!.body).not.toMatch(/native_|runner_|backup_without/);
    expect(notices[0]!.metadata?.recoveryResponsibility).toBe("user");
    expect(codeOf(notices[0]!)).toBe("runner_harness_state_mismatch");
  });

  it("SMAA-143 msg 1, other branch: the native same-run retry never starts -> pending first, then exactly one notice once it is overdue", async () => {
    const f = await fixture();
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_session_interrupted",
      error: "runner_harness_state_mismatch: backup_without_reusable_lease" });
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: id, phase: "retryable_failure",
      nextAttemptAt: new Date(Date.now() + 30_000) });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() - 10 * 60_000) }).where(eq(nativeRunFinalizations.runId, id));
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
  });

  it("SMA-94 (live C8): adapter_failed 'Native session failed' under an ACTIVE board-owned native_continuation_requires_reconciliation hold -> exactly one notice", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
    const f = await fixture();
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed", error: "Native session failed" });
    await f.boardHold("native_continuation_requires_reconciliation", id);
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    // RFL 09:16Z (b): under an ACTIVE board-owned code-only reconciliation hold a resend starts nothing
    // (run-dispatch postgres.ts:905-994), so the note is the held one, never "sending it again is safe".
    expect(notices[0]!.body).toBe(CHAT_HELD);
    expect(codeOf(notices[0]!)).toBe("adapter_failed");
    const rows = (notices[0]!.metadata?.sections ?? []).flatMap(section => section.rows) as Array<{ label?: string }>;
    expect(rows.some(row => row.label === "Recovery action")).toBe(true);
  });

  it("SMAA-1370 (REG-03 on Boat): 'runnerd transport closed during provider startup', blocked by the board -> exactly one notice", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
    const f = await fixture({ status: "blocked" });
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_session_retry_exhausted",
      error: "runnerd transport closed during provider startup" });
    await f.boardHold("native_session_retry_exhausted", id);
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(CHAT_NOT_ANSWERED);
    expect(notices[0]!.body).not.toContain("runnerd");
    expect(codeOf(notices[0]!)).toBe("native_session_retry_exhausted");
  });

  it("SMAA-501: a person comment with no run bound in 180 s on a task held by native_continuation_requires_reconciliation -> exactly one notice", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
    // RFL 09:16Z (b): a code-only reconciliation hold (no missing-evidence failure) also holds the
    // conversation: the wake-queue release keeps the issue behind the board-owned reconciliation action
    // and leaves deferred messages unpromoted (code-lead's D10 read, run-dispatch postgres.ts:905-994),
    // so a resend starts nothing and "sending it again is safe" is false. SUPERSEDES the NO_RUN
    // expectation: both messages get the held note, and the second replaces the first (one note).
    const f = await fixture({ status: "blocked" });
    const earlier = await f.run({ commentId: await f.message("first"), status: "failed", errorCode: "native_continuation_requires_reconciliation" });
    await f.boardHold("native_continuation_requires_reconciliation", earlier, "stranded_assigned_issue");
    await f.sweep();
    let notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(CHAT_HELD);
    const second = await f.message("second, never taken by a run", 200_000);
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", payload: { issueId: f.issueId } });
    await f.sweep();
    notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(CHAT_HELD);
    expect(notices[0]!.body).not.toMatch(/sending it again is safe/i);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${second}`);
  });

  it("SMAA-501 (RFL 20:37Z): a comment coalesced into a remote_cleanup execution wait whose wake FAILED -> exactly one notice, at the failure (no timer)", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
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
    expect(notices[0]!.body).toBe(CHAT_NO_RUN);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${comment!.id}`);
    expect(JSON.stringify(notices[0])).not.toContain("receipt missing");
  });

  it("REG-21: after a gateway key rotation the person's wake FAILED 'provider or completion contract changed', no run, blocked -> exactly one notice", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
    const f = await fixture({ status: "blocked" });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, body: "Are you there?",
      authorType: "user", authorUserId: f.userId, createdAt: new Date(Date.now() - 10_000) }).returning();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "issue_commented", status: "failed", error: "provider or completion contract changed", finishedAt: new Date(),
      payload: { issueId: f.issueId, commentId: comment!.id } });
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(CHAT_NO_RUN);
    expect(JSON.stringify(notices[0])).not.toContain("completion contract");
  });

  it("issues.ts:20740 save-to-wake: a saved person comment whose wake threw (no run, no wake) -> exactly one notice keyed on the comment", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
    const f = await fixture();
    const commentId = await f.message();
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(CHAT_NO_RUN);
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
    // org 09:11Z: chat fixture; the chat-aware action wording.
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed",
      error: "runner_state_identity_mismatch: legacy_owner_unverified" });
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(CHAT_HELD);
    expect(codeOf(notices[0]!)).toBe("runner_state_identity_mismatch");
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
    // org 09:11Z: chat fixture; the chat-aware action wording.
    for (const error of ["runner_process_termination_unconfirmed", "native_controller_recovery_missing_evidence:checkpoint_binding"]) {
      const f = await fixture();
      await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed", error });
      await f.sweep();
      const notices = await f.visible();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.body).toBe(CHAT_HELD);
    }
  });

  it("G5: pi_conversation_identity_missing -> one notice", async () => {
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed", error: "pi_conversation_identity_missing" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
  });

  it("raw error text never shows: a prose error keeps only the run's allowlisted code in metadata, plain words in the body", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
    const f = await fixture();
    await f.run({ commentId: await f.message(), status: "failed", errorCode: "adapter_failed",
      error: "Something exploded at /srv/secret/path with token abc123" });
    await f.sweep();
    const [notice] = await f.visible();
    expect(notice!.body).toBe(CHAT_NOT_ANSWERED);
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

  it("RFL F4: an unrelated timer run's success is not evidence; the message's own path gives exactly one notice", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
    const f = await fixture();
    await f.message();
    await f.run({ commentId: null, status: "succeeded", wakeReason: "heartbeat_timer" });
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(CHAT_NO_RUN);
  });

  it("fabric-v2 (21:40Z): a comment delivered as a run's FIRST-TURN input is carried by that run: no notice while it runs or after it answers; one if it fails", async () => {
    // org 09:11Z: chat fixture; the chat-aware action wording.
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
        expect(notices[0]!.body).toBe(CHAT_NOT_ANSWERED);
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
  const WAITING = "Your message is waiting for the agent to be free; it will start by itself.";
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
    // org 09:11Z: chat fixture; the chat-aware action wording.
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
    expect(notices[0]!.body).toBe(CHAT_NO_RUN);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${commentId}`);
    expect(rowsOf(notices[0]!).some(row => row.label === "Waiting code")).toBe(false);
    await settleAt(f, 12 * 60_000);
    expect(await f.visible()).toHaveLength(1);
  });

  it("E3.04 (2nd bound) control: the carrying run starts at 5 min -> the note stays 'waiting', then the answer supersedes it", async () => {
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
    expect(notices[0]!.body).toBe(WAITING);
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
  const PAUSED_TEXT = "Managed Pi is paused. Your message is saved, and it will run when Managed Pi is resumed. "
    + "A board user or Managed Pi's manager can resume Managed Pi.";
  const pause = (f: { agentId: string }) => db.update(agents).set({ status: "paused", lifecycleState: "paused",
    lifecycleHolds: ["manual"], pauseReason: "manual" }).where(eq(agents.id, f.agentId));
  const resume = (f: { agentId: string }) => db.update(agents).set({ status: "active", lifecycleState: "ready",
    lifecycleHolds: [], pauseReason: null }).where(eq(agents.id, f.agentId));

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

  it("paused agent, then resumed: the saved message's run is the only run (B' starts none), no second note, the answer supersedes it", async () => {
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
    await settleAt(f, 4 * 60_000);
    await settleAt(f, 20 * 60_000);
    expect((await f.visible()).map(n => n.body)).toEqual([PAUSED_TEXT]);
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

  // org 09:11Z (app-lead's SMAAA-1907 screenshots): in a CHAT (Paperclip's isConversation,
  // agent-conversations.ts:39-43) every B' action names the chat's way on; in a task it stays
  // "assign this agent a new task". One row per kind, chat and task, for each note that names an action.
  const nextActionOf = (notice: { metadata: unknown }) =>
    ((notice.metadata as { sections?: Array<{ rows: Array<{ label?: string; value?: string }> }> })?.sections ?? [])
      .flatMap(section => section.rows).find(row => row.label === "Next action")?.value;
  const CHAT_ACTION = {
    failed: { body: "Your message wasn't answered. Sending it again is safe; if it fails again, start a new chat with Managed Pi; this one stays readable.",
      next: "Send the message again; if it fails again, start a new chat with Managed Pi." },
    noRun: { body: "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, start a new chat with Managed Pi; this one stays readable.",
      next: "Send the message again; if it fails again, start a new chat with Managed Pi." },
    noReply: { body: NO_REPLY, next: "Send the message again; if it fails again, start a new chat with Managed Pi." },
    held: { body: "Managed Pi can't continue this chat from its saved state. Start a new chat with Managed Pi; this one stays readable.",
      next: "Start a new chat with Managed Pi." },
  };
  const TASK_ACTION = {
    failed: { body: NOT_ANSWERED, next: "Send the message again; if it fails again, assign this agent a new task." },
    noRun: { body: NO_RUN, next: "Send the message again; if it fails again, assign this agent a new task." },
    noReply: { body: NO_REPLY, next: "Send the message again; if it fails again, assign this agent a new task." },
    held: { body: HELD, next: "Assign this agent a new task to continue." },
  };
  for (const chat of [true, false]) {
    for (const kind of ["failed", "noRun", "noReply", "held"] as const) {
      it(`action wording, ${chat ? "chat" : "task"}: ${kind}`, async () => {
        const f = await fixture({ chat, status: "in_progress" });
        const commentId = await f.message();
        if (kind === "failed") await f.run({ commentId, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
        if (kind === "noReply") await f.run({ commentId, status: "succeeded" });
        if (kind === "held") await f.run({ commentId, status: "failed", errorCode: "native_continuation_requires_reconciliation",
          error: "native_controller_recovery_missing_evidence:snapshot_binding" });
        await f.sweep();
        await settleAt(f, 3 * 60_000);
        const notices = await f.visible();
        expect(notices).toHaveLength(1);
        const expected = (chat ? CHAT_ACTION : TASK_ACTION)[kind];
        expect(notices[0]!.body).toBe(expected.body);
        expect(nextActionOf(notices[0]!)).toBe(expected.next);
        if (chat) expect(`${notices[0]!.body} ${nextActionOf(notices[0]!)}`).not.toMatch(/new task/i);
      });
    }
  }

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
