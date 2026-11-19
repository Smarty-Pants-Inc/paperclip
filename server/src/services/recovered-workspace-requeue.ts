import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { readContinuationCommentInput } from "./continuation-comment-input.js";
import { answeredPersonMessageIds } from "./person-message-answer.js";
import { completedWorkspaceRecoveryCondition } from "./workspace-recovery-receipt.js";

/**
 * adopt-resolved-nothing2 (gate 7, chat 888e5d1d, 11-19): an Interrupt
 * successor failed before any provider work. Its files were pinned
 * (recordRequiredWorkspaceRestoreFailure → terminalizeLegacyExecution), which
 * resolves the run's hold 'blocked' with continuationDelivery 'invalidated'
 * and promises "your message is kept and runs when it's back". The release
 * then returned early (recordNativeTerminalRecoveryIfNeeded) and the carrying
 * wake had failed with the run, so when recovery completed
 * (issue.workspace_recovered → onRecovered) there was no deferred wake to
 * resume and nothing kept that promise.
 *
 * Returns what the post-recovery dispatch owes, or null: the run's resolved
 * no-replay hold whose workspace recovery is COMPLETE (the same receipt
 * condition that returns the sandbox to reuse), and the person messages the
 * failed run carried that are still unanswered, in thread order, as the ONE
 * answer function decides (readContinuationCommentInput's
 * answeredPersonMessageSql, then answeredPersonMessageIds again under the
 * caller's admission; never a second predicate).
 */
export async function recoveredWorkspaceOwedMessages(db: Db, run: {
  id: string; companyId: string; agentId: string; status: string; contextSnapshot: unknown;
}, issueId: string) {
  if (!["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)) return null;
  const [hold] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
    sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'invalidated'`,
    completedWorkspaceRecoveryCondition(run.id),
  )).orderBy(asc(issueRecoveryActions.createdAt)).limit(1);
  if (!hold) return null;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
  if (!task || task.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(task.status)) return null;
  // Something already continues the task: a Retry, a resumed saved message or
  // any later turn. It carries the owed input itself; never a second run.
  const [later] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), sql`${heartbeatRuns.id} <> ${run.id}`,
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
    sql`(${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry') or ${heartbeatRuns.createdAt} > (
      select r.finished_at from heartbeat_runs r where r.id = ${run.id}))`,
  )).limit(1);
  if (later) return null;
  const [waiting] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    sql`coalesce(${agentWakeupRequests.idempotencyKey}, '') not like 'recovered-workspace-requeue:%'`,
    // The failed run's own carrying wake is not a live carrier.
    sql`${agentWakeupRequests.runId} is distinct from ${run.id}`,
  )).limit(1);
  if (waiting) return null;
  const input = await readContinuationCommentInput(db, { companyId: run.companyId, issueId, runId: run.id });
  const carried = Array.isArray(input.wakeCommentIds) ? input.wakeCommentIds.filter((id): id is string => typeof id === "string") : [];
  if (!carried.length) return null;
  const persons = await db.select({ id: issueComments.id, authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
    eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, carried),
    eq(issueComments.authorType, "user"), isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const answered = await answeredPersonMessageIds(db, { companyId: run.companyId, issueId, commentIds: persons.map(row => row.id) });
  const owed = persons.filter(row => !answered.has(row.id));
  const authorUserId = owed.at(-1)?.authorUserId ?? null;
  if (!owed.length || !authorUserId) return null;
  return { hold, task, input, commentIds: owed.map(row => row.id), authorUserId };
}

/** The hold's own failure block (nativeFailureBlock: this run, unchanged
 * status version) is lifted before admission; a block another decision set
 * stays, and admission then refuses with its own wait. */
export async function liftRecoveredWorkspaceBlock(db: Db, owed: NonNullable<Awaited<ReturnType<typeof recoveredWorkspaceOwedMessages>>>,
  runId: string) {
  const block = owed.hold.evidence.nativeFailureBlock as { runId?: unknown; statusVersion?: unknown } | undefined;
  if (owed.task.status !== "blocked" || block?.runId !== runId || Number(block.statusVersion) !== Number(owed.task.statusVersion)) return;
  const now = new Date();
  const [lifted] = await db.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
    blockedOwnerNotifiedAt: null, updatedAt: now })
    .where(and(eq(issues.companyId, owed.task.companyId), eq(issues.id, owed.task.id), eq(issues.status, "blocked"),
      eq(issues.statusVersion, owed.task.statusVersion))).returning({ id: issues.id });
  if (lifted) await db.insert(activityLog).values({ companyId: owed.task.companyId, actorType: "system",
    actorId: "workspace-recovery", action: "issue.updated", entityType: "issue", entityId: owed.task.id, runId,
    details: { status: "todo", previousStatus: "blocked", reason: "workspace_recovered_owed_messages",
      recoveryActionId: owed.hold.id, _previous: { status: "blocked" } } });
}

/** Records the post-recovery dispatch on the hold: delivered (with its run) or
 * refused, so the DB says why a promised message did or did not run. */
export async function recordRecoveredWorkspaceRequeue(db: Db, holdId: string, result: { runId: string | null; commentIds: string[] }) {
  await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
    recoveredWorkspaceRequeue: { at: new Date().toISOString(), commentIds: result.commentIds,
      outcome: result.runId ? "enqueued" : "refused", runId: result.runId } })}::jsonb` })
    .where(eq(issueRecoveryActions.id, holdId));
}

/** adopt-requeue-boot: the failed runs on this task whose resolved no-replay
 * hold has not yet had its post-recovery dispatch enqueued. A chat left
 * 'blocked' by a recovery that completed with nothing queued (before the
 * onRecovered requeue existed, or when that dispatch was missed) is found by
 * the stranded sweep's visit and gets the SAME dispatch
 * (requeueRecoveredWorkspaceMessages); recoveredWorkspaceOwedMessages still
 * decides every gate. */
export async function recoveredWorkspaceRequeueRuns(db: Db, companyId: string, issueId: string) {
  const holds = await db.select({ runId: sql<string | null>`${issueRecoveryActions.evidence}->>'runId'` }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'invalidated'`,
    sql`coalesce(${issueRecoveryActions.evidence}->'recoveredWorkspaceRequeue'->>'outcome', '') <> 'enqueued'`,
  )).orderBy(asc(issueRecoveryActions.createdAt)).limit(5);
  const runIds = [...new Set(holds.map(row => row.runId).filter((id): id is string => !!id && /^[0-9a-f-]{36}$/i.test(id)))];
  if (!runIds.length) return [];
  return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)))
    .orderBy(asc(heartbeatRuns.createdAt));
}
