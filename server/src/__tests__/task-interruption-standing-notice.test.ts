import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { HELD_PREDECESSOR_NOTICE } from "../services/native-runtime/held-predecessor-notice-text.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { taskInterruptionPresentation, taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { readStandingRunNotice } from "../services/standing-run-notice.js";
import { EXECUTION_DEADLINE_NOTICE_BODY, EXECUTION_DEADLINE_NOTICE_REASON_PREFIX } from "../services/execution-deadline-notice.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const captureTaskInterruptionFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure }));

const GENERIC_FAILED = { state: "failed", canRetry: true };
// SILENT-F.md PARTIAL rows: each row's real refusal code (C8 ad2371a7).
const PARTIAL_ROWS = [
  ["F11", "native_controller_recovery_metadata_too_large"],
  ["F28", "native_session_cleanup_quarantined"],
  ["F31", "runner_state_identity_mismatch: remote_warm_session_unproven"],
  ["F32", "native_sandbox_cold_resume_unproven"],
  ["F47", "native_session_checkpoint_binding_mismatch"],
  ["F48", "native_governed_wait_replay_mismatch"],
  ["F49", "native_event_replay_conflict"],
  ["F50", "native_recovery_replay_did_not_advance"],
  ["F52", "native_session_multi_run_unavailable"],
  ["F58", "runner_remote_recovery_identity_mismatch"],
  ["F62", "native_execution_ownership_unverified"],
] as const;

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("chat task-status card reads the standing notice (C9 G1)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("standing-notice-card-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  let clock = Date.parse("2026-11-13T19:00:00Z");
  const next = () => new Date(clock += 1_000);

  async function conversation(errorCode: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Standing notice", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed agent", adapterType: "paperclip_runner", status: "active" });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const run = async (status: string, code: string | null) => {
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, runtimeMode: "native", nativeIssueId: issueId,
        nativeSessionId: sessionId, contextSnapshot: { issueId }, errorCode: code, createdAt: next(), finishedAt: new Date() }).returning();
      return row;
    };
    const failed = await run("failed", errorCode);
    return { companyId, agentId, issueId, sessionId, issue: issue!, failed, run };
  }
  // The executor's notice (noticeHeldUnfinishedPredecessor): same author, metadata and text.
  async function holdConversation(f: Awaited<ReturnType<typeof conversation>>) {
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system", body: HELD_PREDECESSOR_NOTICE,
      createdAt: next(), metadata: { version: 1, authorizationReason: `native_prior_owner_held:${f.sessionId}`,
        sections: [{ rows: [{ type: "run_link", runId: f.failed.id, agentId: f.agentId, title: "Held conversation" }] }] } });
  }
  const card = async (f: Awaited<ReturnType<typeof conversation>>) => {
    const listed = (await taskInterruptionPresentations(db, f.companyId, [f.issue])).get(f.issueId);
    expect(await taskInterruptionPresentation(db, f.issue)).toEqual(listed);
    return listed;
  };

  it("(a) a held conversation whose last run failed: the card carries the notice text and no Retry", async () => {
    const f = await conversation("native_controller_recovery_missing_evidence:retained_sandbox_binding");
    await holdConversation(f);
    const presentation = await card(f);
    expect(presentation).toMatchObject({ state: "failed", canRetry: false,
      notice: { code: "native_prior_owner_held", text: HELD_PREDECESSOR_NOTICE } });
    // The SAME standing notice the blocker and the leaf reader see.
    expect(await readStandingRunNotice(db, { companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ source: "held", retryCanWork: false, text: HELD_PREDECESSOR_NOTICE });
    // No recovery action here, so getExecutionBlocker has no blocker; the notice still withholds Retry.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("(b) no notice: unchanged generic failure with Retry", async () => {
    const f = await conversation("native_controller_recovery_missing_evidence:retained_sandbox_binding");
    const presentation = await card(f);
    expect(presentation).toMatchObject(GENERIC_FAILED);
    expect(presentation?.notice).toBeUndefined();
  });

  it("(c) a later committed success on the same conversation clears it", async () => {
    const f = await conversation("runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate");
    await holdConversation(f);
    expect(await card(f)).toMatchObject({ canRetry: false, notice: { text: HELD_PREDECESSOR_NOTICE } });
    const succeeded = await f.run("succeeded", null);
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: succeeded.id, phase: "committed" });
    // A later ordinary failure on the continued conversation shows the generic card again.
    await f.run("failed", "native_session_interrupted");
    const presentation = await card(f);
    expect(presentation).toMatchObject(GENERIC_FAILED);
    expect(presentation?.notice).toBeUndefined();
  });

  // Upstream b4861d5e task-interruption-presentation.ts:824-840, ported: a restore
  // hold whose blocker refuses Retry withholds the card's Retry too.
  it("(upstream port) a restore hold the blocker refuses withholds the card's Retry", async () => {
    const f = await conversation("native_workspace_restore_failed");
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "workspace_recovery",
      status: "active", ownerType: "board", cause: "native_continuation_requires_reconciliation", fingerprint: `restore:${f.failed.id}`,
      nextAction: "Inspect the saved archive.", evidence: { runId: f.failed.id, workspaceRestoreFailure: "restore_unsafe_archive",
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.failed.id, stage: "restoring_files", status: "blocked",
          attempt: 1, attemptLimit: 6, retryable: false, requestIds: [] } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: false });
    expect(await card(f)).toMatchObject({ state: "failed", canRetry: false, retryWait: { reason: "workspace_repair_required" } });
  });

  it.each(PARTIAL_ROWS)("(d) %s %s: Retry stays offered with no standing notice (no existing predicate refuses it)", async (_row, code) => {
    const f = await conversation(code);
    const presentation = await card(f);
    expect(presentation).toMatchObject(GENERIC_FAILED);
    expect(presentation?.notice).toBeUndefined();
  });

  it.each(PARTIAL_ROWS)("(d) %s %s: a standing held notice withholds Retry and shows its text", async (_row, code) => {
    const f = await conversation(code);
    await holdConversation(f);
    expect(await card(f)).toMatchObject({ state: "failed", canRetry: false,
      notice: { code: "native_prior_owner_held", text: HELD_PREDECESSOR_NOTICE } });
  });
  // C2 (RFL 4x3): the execution-deadline notice exactly as reconciliation commits it.
  async function deadlineNotice(f: Awaited<ReturnType<typeof conversation>>) {
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system",
      body: EXECUTION_DEADLINE_NOTICE_BODY, createdAt: next(), metadata: { version: 1,
        authorizationReason: `${EXECUTION_DEADLINE_NOTICE_REASON_PREFIX}${f.failed.id}`,
        sections: [{ rows: [{ type: "run_link", runId: f.failed.id, agentId: f.agentId, title: "Failed reply" }] }] } });
  }
  const deadlineCause = "execution_finalization_deadline_exceeded";

  it("(C2) a standing deadline notice with no workspace hold: the card says no Retry and shows the notice, as the blocker does", async () => {
    const f = await conversation(deadlineCause);
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      cause: deadlineCause, fingerprint: `execution-control:${f.failed.id}`, status: "active", nextAction: "Inspect the failed run.",
      evidence: { runId: f.failed.id, providerOwnership: "unverified" } });
    expect(await card(f)).toMatchObject({ state: "failed", canRetry: true });
    await deadlineNotice(f);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: false, nextAction: EXECUTION_DEADLINE_NOTICE_BODY });
    const presentation = await card(f);
    expect(presentation).toMatchObject({ state: "failed", canRetry: false,
      notice: { code: deadlineCause, text: EXECUTION_DEADLINE_NOTICE_BODY } });
    expect(presentation?.canRetry).toBe(blocker!.canRetry);
    expect(await readStandingRunNotice(db, f)).toMatchObject({ source: "deadline", retryCanWork: false });
  });

  it("(C2) a standing deadline notice with no recovery action still withholds the card's Retry", async () => {
    const f = await conversation(deadlineCause);
    await deadlineNotice(f);
    expect(await card(f)).toMatchObject({ state: "failed", canRetry: false,
      notice: { code: deadlineCause, text: EXECUTION_DEADLINE_NOTICE_BODY } });
  });

  it("(C2) a later committed success supersedes the deadline notice for the card and the blocker", async () => {
    const f = await conversation(deadlineCause);
    await deadlineNotice(f);
    const later = await f.run("succeeded", null);
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: later.id, phase: "committed" });
    expect(await readStandingRunNotice(db, f)).toBeNull();
    expect((await card(f))?.notice).toBeUndefined();
  });
});
