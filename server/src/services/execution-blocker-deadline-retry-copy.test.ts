import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker, NEW_TASK_CONTINUE_ACTION } from "./execution-blocker.js";
import { issueService } from "./issues.js";

// RFL 05:01Z, the restack's added case (Smarty fork, C9 M1.1, TEMPORARY):
// with a standing execution-deadline notice (b6800e5c), Retry is not offered.
// When the saved-work recovery is not "recovered", the banner falls through to
// workspaceRecovery.message; a stored message that names Retry must not reach
// the person: the banner never names a Retry they cannot press.
const cause = "execution_finalization_deadline_exceeded";
const deadlineNotice = "Paperclip could not resume or finish this reply before its execution deadline. "
  + "Open the failed run for details. Before retrying, verify that the previous execution has stopped "
  + "and reconcile any uncertain action.";
const storedRecoveryMessage = "Automatic recovery of saved work failed. Press Retry to try again.";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("deadline notice + Retry not offered + a workspaceRecovery.message naming Retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-blocker-deadline-retry-copy-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("the banner names no Retry: it says to create a new task", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deadline copy", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Deadline agent", adapterType: "process", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deadline task", status: "blocked", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: randomUUID(), contextSnapshot: { issueId },
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:01:00Z"),
      errorCode: cause, error: "The run could not finish before its execution deadline." }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", cause,
      fingerprint: `execution-control:${run!.id}`, status: "active", nextAction: "Inspect the failed run.",
      evidence: { runId: run!.id, providerOwnership: "unverified", workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: run!.id, status: "blocked", stage: "saving_receipts",
          attempt: 1, requestIds: [], retryable: true, message: storedRecoveryMessage } } });
    // The deadline notice exactly as execution-control-reconciliation commits it.
    await issueService(db).addComment(issueId, deadlineNotice, {}, { authorType: "system",
      presentation: { kind: "system_notice", tone: "danger", title: "Reply could not finish", density: "compact", detailsDefaultOpen: false },
      metadata: { version: 1, sourceRunId: run!.id, recoveryResponsibility: "system", authorizationReason: `${cause}:${run!.id}`,
        sections: [{ title: "Failure details", rows: [
          { type: "run_link", runId: run!.id, agentId, title: "Failed reply" },
          { type: "key_value", label: "Failure code", value: cause },
        ] }] } });
    const blocker = await getExecutionBlocker(db, companyId, issueId);
    expect(blocker).not.toBeNull();
    expect(blocker!.canRetry).toBe(false);
    expect(blocker!.workspaceRecovery?.status).toBe("blocked");
    expect(blocker!.nextAction).not.toMatch(/\bRetry\b/);
    expect(blocker!.nextAction).toContain("Automatic recovery of saved work failed.");
    expect(blocker!.nextAction).toContain(NEW_TASK_CONTINUE_ACTION);
  });
});
