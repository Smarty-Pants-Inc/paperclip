import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { databaseWorkScopeKey, signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db/work-signals";

export const HELD_NATIVE_CONFIGURATION_TOPIC = "native-held-configuration";

/** Durable, agent-scoped intent; observers act only after commit and re-read it.
 * Old runs without this additive flag keep their existing hold policy. No wakes,
 * cancellation state, or next-run session-compatibility policy are changed. */
export async function requestHeldNativeConfigurationEnd(tx: Db, scope: { companyId: string; agentId: string }) {
  const running = and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"));
  const runs = await tx.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns).where(running);
  const issueIds = [...new Set(runs.flatMap(run => run.issueId ? [run.issueId] : []))].sort();
  if (!issueIds.length) return;
  // Checkout/publication own issue -> run. Lock ALL affected issues in stable
  // order before updating only these sampled runs; never introduce run -> issue.
  await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, scope.companyId),
    inArray(issues.id, issueIds))).orderBy(issues.id).for("no key update");
  await signalDatabaseWork(tx, HELD_NATIVE_CONFIGURATION_TOPIC, JSON.stringify(scope));
  await tx.update(heartbeatRuns).set({
    resultJson: sql`jsonb_set(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb), '{heldNativeConfigurationEnd}', 'true'::jsonb)`,
  }).where(and(running, inArray(heartbeatRuns.id, runs.filter(run => run.issueId).map(run => run.id))));
}

/** Notifications are hints; bootstrap/reconnect and every idle/steering boundary
 * re-read the durable flag, so a rolled-back write cannot end a held turn. */
export function observeHeldNativeConfiguration(db: Db, scope: { companyId: string; agentId: string }, onHint: () => void): () => void {
  if (databaseWorkScopeKey(db) === db) return () => {};
  return subscribeDatabaseWork(db, HELD_NATIVE_CONFIGURATION_TOPIC, (event, hints) => {
    if (event !== "settled") return;
    if (!hints || [...hints].some(hint => {
      try { const value = JSON.parse(hint); return value.companyId === scope.companyId && value.agentId === scope.agentId; }
      catch { return false; }
    })) onHint();
  });
}

export async function heldNativeConfigurationEndRequested(db: Db, scope: { companyId: string; agentId: string; issueId: string; runId: string }) {
  const [run] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId),
    eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.nativeIssueId, scope.issueId),
  )).limit(1);
  return run?.resultJson?.heldNativeConfigurationEnd === true;
}
