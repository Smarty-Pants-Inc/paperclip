import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issues, type Db,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { hasPendingRunCleanup } from "../services/execution-blocker.js";
import { isHeartbeatRunTerminalStatus } from "../services/heartbeat/run-lifecycle.js";
import { queuedRunOwnsIssue, queuedRunPredecessorHold } from "../services/heartbeat/queued-run-predecessor.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

// The claim's predecessor loop as it stood inline in heartbeat/queue.ts
// claimQueuedRun at 3b8372de/ab396f02 (verbatim; declined() returns its reason).
async function inlineClaimDecision(tx: Db, run: { id: string; companyId: string; agentId: string; retryOfRunId: string | null;
  scheduledRetryReason: string | null }, issueId: string | null, owner: { assigneeAgentId: string | null; executionRunId: string | null } | undefined,
  context: Record<string, unknown>, liveRunExecutions: Set<string>) {
  const ownsIssue = owner?.assigneeAgentId === run.agentId &&
    context.wakeReason !== "source_scoped_recovery_action";
  const declined = (reason: string, predecessorRunId?: string) => ({ reason, predecessorRunId });
  const executionOwnerId = run.scheduledRetryReason === "native_provider_overloaded"
    ? run.retryOfRunId : ownsIssue ? owner?.executionRunId : null;
  for (const previousRunId of new Set([executionOwnerId, ownsIssue ? run.retryOfRunId : null])) {
    if (!previousRunId || previousRunId === run.id) continue;
    const [previous] = await tx.select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
      supersededByFreshContinuation: sql<boolean>`${heartbeatRuns.resultJson} ? 'freshContinuationSupersededAt'`,
      contextIssueId: sql<unknown>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
    })
      .from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, previousRunId),
        eq(heartbeatRuns.companyId, run.companyId),
      ));
    if (previousRunId !== executionOwnerId && (previous?.agentId !== run.agentId ||
        (previous.nativeIssueId ?? previous.issueId ?? previous.contextIssueId) !== issueId)) continue;
    // A terminal result can precede workspace/lease cleanup on this or
    // another controller. Local absence alone is not a release receipt.
    if (!isHeartbeatRunTerminalStatus(previous?.status) ||
        liveRunExecutions.has(previousRunId)) {
      return declined("predecessor_still_executing", previousRunId);
    }
    // A fresh continuation replaced the predecessor: its writes are revoked
    // and it shares no workspace with this run (a fenced remote epoch or a
    // new isolated workspace), so its cleanup continues without holding it.
    if (!previous?.supersededByFreshContinuation && await hasPendingRunCleanup(tx, run.companyId, previousRunId)) {
      return declined("predecessor_cleanup_pending", previousRunId);
    }
  }
  return null;
}

describe.skipIf(!support.supported)("the extracted claim predecessor decision", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("queued-predecessor-equivalence-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("decides exactly as the claim's inline loop did, over every predecessor shape", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Equivalence", issuePrefix: `E${companyId.slice(0, 7)}` });
    for (const id of [agentId, otherAgentId]) await db.insert(agents).values({ id, companyId, name: id.slice(0, 6), adapterType: "codex_local" });
    const [issue] = await db.insert(issues).values({ companyId, title: "T", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [other] = await db.insert(issues).values({ companyId, title: "O", status: "in_progress", assigneeAgentId: agentId }).returning();
    const self = randomUUID();
    const shapes: Array<{ name: string; agentId: string; issueId?: string; nativeIssueId?: string; context?: Record<string, unknown>;
      status: string; superseded?: boolean; pending: boolean }> = [
      { name: "same-task-pending", agentId, issueId: issue.id, status: "failed", pending: true },
      { name: "same-task-released", agentId, issueId: issue.id, status: "failed", pending: false },
      { name: "same-task-superseded", agentId, issueId: issue.id, status: "failed", superseded: true, pending: true },
      { name: "same-task-running", agentId, issueId: issue.id, status: "running", pending: false },
      { name: "native-same-task-pending", agentId, nativeIssueId: issue.id, status: "failed", pending: true },
      { name: "context-task-pending", agentId, context: { taskId: issue.id }, status: "failed", pending: true },
      { name: "other-agent-pending", agentId: otherAgentId, issueId: issue.id, status: "failed", pending: true },
      { name: "other-issue-pending", agentId, issueId: other.id, status: "failed", pending: true },
      { name: "other-agent-other-issue-running", agentId: otherAgentId, issueId: other.id, status: "running", pending: false },
    ];
    const ids = new Map<string, string>();
    for (const shape of shapes) {
      const id = randomUUID(); ids.set(shape.name, id);
      await db.insert(heartbeatRuns).values({ id, companyId, agentId: shape.agentId, issueId: shape.issueId ?? null,
        nativeIssueId: shape.nativeIssueId ?? null, status: shape.status, contextSnapshot: shape.context ?? {},
        resultJson: shape.superseded ? { freshContinuationSupersededAt: new Date().toISOString() } : null });
      if (shape.pending) await db.insert(environmentLeases).values({ companyId, heartbeatRunId: id, provider: "boat",
        providerLeaseId: `sbx-${id}`, status: "pending_cleanup", cleanupStatus: "failed", releasedAt: new Date() });
      expect(await hasPendingRunCleanup(db, companyId, id)).toBe(shape.pending);
    }
    const predecessorIds: Array<string | null> = [null, self, randomUUID(), ...ids.values()];
    const decisions: Record<string, number> = {};
    let cases = 0;
    for (const scheduledRetryReason of [null, "native_provider_overloaded", "native_safe_replacement"])
    for (const assigneeAgentId of [agentId, otherAgentId])
    for (const wakeReason of ["issue_status_changed", "source_scoped_recovery_action"])
    for (const issueId of [issue.id, other.id, null])
    for (const executionRunId of predecessorIds)
    for (const retryOfRunId of predecessorIds)
    for (const live of [false, true]) {
      const run = { id: self, companyId, agentId, retryOfRunId, scheduledRetryReason };
      const owner = issueId ? { assigneeAgentId, executionRunId } : undefined;
      const liveRuns = new Set(live ? [ids.get("same-task-pending")!, ids.get("other-agent-pending")!] : []);
      const expected = await inlineClaimDecision(db, run, issueId, owner, { wakeReason }, liveRuns);
      const ownsIssue = queuedRunOwnsIssue(owner?.assigneeAgentId, run.agentId, wakeReason);
      const actual = await queuedRunPredecessorHold(db, { run, issueId, ownsIssue, executionRunId: owner?.executionRunId,
        isTerminal: isHeartbeatRunTerminalStatus, isLive: id => liveRuns.has(id) });
      expect(actual, JSON.stringify({ scheduledRetryReason, assigneeAgentId, wakeReason, issueId, executionRunId, retryOfRunId, live })).toEqual(expected);
      const key = actual?.reason ?? "starts"; decisions[key] = (decisions[key] ?? 0) + 1; cases++;
    }
    console.log(`equivalence: ${cases} cases`, decisions);
    expect(Object.keys(decisions).sort()).toEqual(["predecessor_cleanup_pending", "predecessor_still_executing", "starts"]);
  }, 300_000);
});
