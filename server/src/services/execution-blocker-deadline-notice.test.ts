import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { EXECUTION_BLOCKER_PERSON_RETRY_ACTION, getExecutionBlocker } from "./execution-blocker.js";
import { issueService } from "./issues.js";
import { RECOVERED_WORK_RETRY_MESSAGE } from "./workspace-recovery-receipt.js";
// Upstream ef2a49b6 shows its own deadline message for an active deadline action.
import { EXECUTION_FINALIZATION_DEADLINE_MESSAGE } from "./execution-control-deadline.js";
import { EXECUTION_DEADLINE_NOTICE_BODY, readUnsupersededExecutionDeadlineNotice } from "./execution-deadline-notice.js";

// SMAA-1444: the saved files were copied back and verified, so the hold itself
// would release to Retry. Stand in for that verified repair receipt.
vi.mock("./workspace-recovery-receipt.js", async importOriginal => ({
  ...await importOriginal<typeof import("./workspace-recovery-receipt.js")>(),
  hasVerifiedWorkspaceRepair: async () => true,
}));

const cause = "execution_finalization_deadline_exceeded";
// The notice exactly as execution-control-reconciliation commits it with the deadline failure.
const deadlineNotice = EXECUTION_DEADLINE_NOTICE_BODY;
const recoveredRetry = RECOVERED_WORK_RETRY_MESSAGE;

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("execution blocker is independent of standing execution-deadline notices (SMAA-1444)", () => {
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

  // follow-Paperclip Cut B R4: a deadline notice cannot veto Retry after verified workspace recovery.
  it("offers Retry from recovered work while the deadline notice remains output; a later committed success clears it", async () => {
    const f = await deadlineFailure(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true, nextAction: recoveredRetry });
    await postDeadlineNotice(f);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.run.id, cause, canRetry: true, canContinue: false,
      workspaceRecovery: { status: "recovered" } });
    expect(blocker!.nextAction).toBe(recoveredRetry);
    expect(await readUnsupersededExecutionDeadlineNotice(db, f)).toMatchObject({ body: deadlineNotice });
    // A later committed success on the task supersedes the output notice, not Retry eligibility.
    await committedSuccess(f);
    expect(await readUnsupersededExecutionDeadlineNotice(db, f)).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true, nextAction: recoveredRetry });
  });

  // follow-Paperclip Cut B R4: Retry remains the person's control even while deadline output stands.
  it("names Retry as the person's control while the deadline notice stands", async () => {
    const f = await deadlineFailure(false);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true,
      nextAction: `${EXECUTION_FINALIZATION_DEADLINE_MESSAGE} ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
    await postDeadlineNotice(f);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: true, canContinue: false,
      nextAction: `${EXECUTION_FINALIZATION_DEADLINE_MESSAGE} ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
    expect(blocker!.nextAction).toContain(EXECUTION_BLOCKER_PERSON_RETRY_ACTION);
    await committedSuccess(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true,
      nextAction: `${EXECUTION_FINALIZATION_DEADLINE_MESSAGE} ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
  });

  // follow-Paperclip Cut B R4: notice supersession and task scoping remain output-only, never Retry policy.
  it("an earlier success does not clear later deadline output, and neither that task nor another loses Retry", async () => {
    const f = await deadlineFailure(true);
    await committedSuccess(f);
    await postDeadlineNotice(f);
    expect(await readUnsupersededExecutionDeadlineNotice(db, f)).toMatchObject({ body: deadlineNotice });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true, nextAction: recoveredRetry });
    const other = await deadlineFailure(true);
    expect(await readUnsupersededExecutionDeadlineNotice(db, other)).toBeNull();
    expect(await getExecutionBlocker(db, other.companyId, other.issueId)).toMatchObject({ canRetry: true, nextAction: recoveredRetry });
  });
});
