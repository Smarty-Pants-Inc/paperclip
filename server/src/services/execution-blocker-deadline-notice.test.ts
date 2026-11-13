import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { EXECUTION_BLOCKER_PERSON_RETRY_ACTION, getExecutionBlocker } from "./execution-blocker.js";
import { issueService } from "./issues.js";
// Upstream ef2a49b6 shows its own deadline message for an active deadline action.
import { EXECUTION_FINALIZATION_DEADLINE_MESSAGE } from "./execution-control-deadline.js";

// SMAA-1444: the saved files were copied back and verified, so the hold itself
// would release to Retry. Stand in for that verified repair receipt.
vi.mock("./workspace-recovery-receipt.js", async importOriginal => ({
  ...await importOriginal<typeof import("./workspace-recovery-receipt.js")>(),
  hasVerifiedWorkspaceRepair: async () => true,
}));

const cause = "execution_finalization_deadline_exceeded";
// The notice exactly as execution-control-reconciliation commits it with the deadline failure.
const deadlineNotice = "Paperclip could not resume or finish this reply before its execution deadline. "
  + "Open the failed run for details. Before retrying, verify that the previous execution has stopped "
  + "and reconcile any uncertain action.";
const recoveredRetry = "Saved work recovered. Retry or send a message to continue.";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("execution blocker follows a standing execution-deadline notice (SMAA-1444)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-blocker-deadline-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function deadlineFailure(savedWorkRecovered: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deadline fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Deadline agent", adapterType: "process", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deadline task", status: "blocked", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: randomUUID(), contextSnapshot: { issueId },
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:01:00Z"),
      errorCode: cause, error: "The run could not finish before its execution deadline." }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", cause,
      fingerprint: `execution-control:${run.id}`, status: "active", nextAction: "Inspect the failed run.",
      evidence: { runId: run.id, providerOwnership: "unverified", ...(savedWorkRecovered ? {
        workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: run.id, status: "recovered",
          stage: "saving_receipts", attempt: 1, requestIds: [] } } : {}) } });
    return { companyId, agentId, issueId, run };
  }
  type Fixture = Awaited<ReturnType<typeof deadlineFailure>>;
  async function postDeadlineNotice(f: Fixture) {
    await issueService(db).addComment(f.issueId, deadlineNotice, {}, { authorType: "system",
      presentation: { kind: "system_notice", tone: "danger", title: "Reply could not finish", density: "compact", detailsDefaultOpen: false },
      metadata: { version: 1, sourceRunId: f.run.id, recoveryResponsibility: "system", authorizationReason: `${cause}:${f.run.id}`,
        sections: [{ title: "Failure details", rows: [
          { type: "run_link", runId: f.run.id, agentId: f.agentId, title: "Failed reply" },
          { type: "key_value", label: "Failure code", value: cause },
        ] }] } });
  }
  async function committedSuccess(f: Fixture) {
    const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId: randomUUID(), contextSnapshot: { issueId: f.issueId } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: later.id, phase: "committed" });
  }

  it("does not offer Retry over the deadline notice once saved work is recovered; a later committed success clears it", async () => {
    const f = await deadlineFailure(true);
    // Without the notice the recovered hold offers Retry (the existing contract).
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true, nextAction: recoveredRetry });
    await postDeadlineNotice(f);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.run.id, cause, canRetry: false, canContinue: false,
      workspaceRecovery: { status: "recovered" } });
    // One consistent message: the notice's own guidance, not an invitation to retry.
    expect(blocker!.nextAction).toBe(deadlineNotice);
    expect(blocker!.nextAction).not.toMatch(/Retry or send a message/);
    // A later committed success on the task supersedes the notice.
    await committedSuccess(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true, nextAction: recoveredRetry });
  });

  it("does not name Retry as the person's control while the deadline notice stands", async () => {
    const f = await deadlineFailure(false);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true,
      nextAction: `${EXECUTION_FINALIZATION_DEADLINE_MESSAGE} ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
    await postDeadlineNotice(f);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: false, canContinue: false, nextAction: deadlineNotice });
    expect(blocker!.nextAction).not.toContain(EXECUTION_BLOCKER_PERSON_RETRY_ACTION);
    await committedSuccess(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true,
      nextAction: `${EXECUTION_FINALIZATION_DEADLINE_MESSAGE} ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
  });

  it("an earlier success does not clear a later deadline notice, and another task's notice does not apply", async () => {
    const f = await deadlineFailure(true);
    await committedSuccess(f);
    await postDeadlineNotice(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: false, nextAction: deadlineNotice });
    const other = await deadlineFailure(true);
    expect(await getExecutionBlocker(db, other.companyId, other.issueId)).toMatchObject({ canRetry: true, nextAction: recoveredRetry });
  });
});
