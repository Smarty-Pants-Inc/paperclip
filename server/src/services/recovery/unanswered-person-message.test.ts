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
  nativeRunFinalizations,
} from "@paperclipai/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";

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
    const f = await fixture({ status: "blocked" });
    const id = await f.run({ commentId: await f.message(), status: "failed", errorCode: "native_session_interrupted",
      error: "runner_harness_state_mismatch: backup_without_reusable_lease" });
    await f.boardHold("native_session_retry_exhausted", id);
    await f.sweep();
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(NOT_ANSWERED);
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

  it("no false notice: a later run the message did not start (a timer run) succeeding says nothing about the message", async () => {
    const f = await fixture();
    await f.message();
    await f.run({ commentId: null, status: "succeeded", wakeReason: "heartbeat_timer" });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
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
});
