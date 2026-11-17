import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { executionProjectionForRun } from "./execution-projection.js";
import { HELD_PREDECESSOR_NOTICE } from "./native-runtime/held-predecessor-notice-text.js";

// Keep reason: real incident B2 showed a cancelled recovered run can be retried;
// that status alone is not the held-predecessor fence. The receipt must use the
// actual standing HELD notice, and must keep non-held receipts unchanged.
describe("recovered-work receipt respects the conversation's held state", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("workspace-held-receipt-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  it("the actual held-predecessor notice gives the one action that does not reuse the held owner", () => {
    expect(HELD_PREDECESSOR_NOTICE).toBe("Your message and saved work are kept, but this conversation cannot continue. Assign this agent a new task to continue.");
  });

  async function fixture(held: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovered cancelled task", issuePrefix: `H${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Saved work", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: sessionId, errorCode: "operator_interrupted", contextSnapshot: { issueId },
      resultJson: { cancelledByActorType: "agent", cancelledByAgentId: agentId } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_continuation_requires_reconciliation", status: "resolved", outcome: "blocked", ownerType: "board",
      fingerprint: randomUUID(), nextAction: "Saved work recovered.", resolvedAt: new Date(),
      evidence: { runId, workspaceRestoreFailure: "restore_unsafe_archive", continuationDelivery: "invalidated",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown", recordedAt: new Date().toISOString() },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId, status: "recovered", stage: "saving_receipts", attempt: 1, requestIds: [] } } });
    if (held) await db.insert(issueComments).values({ companyId, issueId, authorType: "system", body: HELD_PREDECESSOR_NOTICE,
      metadata: { version: 1, authorizationReason: `native_prior_owner_held:${sessionId}`,
        sections: [{ rows: [{ type: "run_link", runId, agentId }] }] } });
    return { companyId, issueId, runId };
  }

  it.each([false, true])("blocker and run projection choose the exact receipt from actual HELD=%s evidence", async held => {
    const f = await fixture(held);
    const expected = held
      ? "Saved work recovered, but this conversation cannot continue. Assign this agent a new task to continue."
      : "Saved work recovered. Send a message to continue.";
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).not.toBeNull();
    expect(blocker!.workspaceRecovery?.message).toBe(expected);
    expect(blocker!.nextAction).toBe(expected);
    expect((await executionProjectionForRun(db, f.companyId, f.runId))?.nextAction).toBe(expected);
    // Reading is not a continuation: it creates no successor or extra note.
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(held ? 1 : 0);
  });
});
