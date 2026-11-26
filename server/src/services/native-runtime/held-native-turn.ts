import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { databaseWorkScopeKey, signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { parseObject } from "../../adapters/utils.js";

export const HELD_NATIVE_CONFIGURATION_TOPIC = "native-held-configuration";

/** Durable agent-scoped (optionally issue-scoped) intent; observers act only after commit and re-read it.
 * Old runs without this additive flag keep their existing hold policy. No wakes,
 * cancellation state, or next-run session-compatibility policy are changed. */
export async function requestHeldNativeConfigurationEnd(tx: Db, scope: { companyId: string; agentId: string; issueId?: string }) {
  const running = and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
    scope.issueId ? eq(heartbeatRuns.nativeIssueId, scope.issueId) : undefined,
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

export type HeldNativeConfigurationTarget = {
  targetType: "environment" | "project" | "agent";
  targetId: string;
  companyId?: string;
  responsibleUserId?: string;
  admittedSecretId?: string;
};

/** Resolve consumers from admitted runs, not agent defaults: an override or a
 * forced environment may differ from today's default. Instance environment
 * saves omit companyId; secret writes retain their binding's company scope.
 * Reuse the durable close seam, never cancellation or session reset. */
export async function requestHeldNativeConfigurationEndForTargets(tx: Db, targets: HeldNativeConfigurationTarget[]) {
  if (!targets.length) return;
  const consumers = await tx.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    issueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"), isNotNull(heartbeatRuns.nativeIssueId),
    or(...targets.map(target => and(
      target.companyId ? eq(heartbeatRuns.companyId, target.companyId) : undefined,
      target.responsibleUserId ? or(
        sql`case when ${heartbeatRuns.contextSnapshot} ? 'paperclipSecretIdentity'
          then ${heartbeatRuns.contextSnapshot} #>> '{paperclipSecretIdentity,responsibleUserId}' = ${target.responsibleUserId}
          else ${heartbeatRuns.responsibleUserId} = ${target.responsibleUserId} end`,
        // Previous releases already admitted exact secret IDs in the manifest.
        // They too must survive a later steering identity change.
        target.admittedSecretId ? sql`${heartbeatRuns.contextSnapshot} #> '{paperclipSecrets,manifest}' @> ${JSON.stringify([{ secretId: target.admittedSecretId }])}::jsonb` : undefined,
      ) : undefined,
      target.targetType === "agent" ? eq(heartbeatRuns.agentId, target.targetId)
        // A native run may still be preparing its workspace/lease. End that
        // one fresh hold conservatively; dispatch also revalidates its values.
        : target.targetType === "environment" ? sql`(${heartbeatRuns.contextSnapshot} #>> '{paperclipEnvironment,id}' = ${target.targetId}
          or ${heartbeatRuns.contextSnapshot} #>> '{paperclipEnvironment,id}' is null)`
        : or(sql`${heartbeatRuns.contextSnapshot} #>> '{paperclipWorkspace,projectId}' = ${target.targetId}`,
          inArray(heartbeatRuns.nativeIssueId, tx.select({ id: issues.id }).from(issues).where(and(
            eq(issues.projectId, target.targetId), eq(issues.companyId, heartbeatRuns.companyId))))),
    ))),
  )).orderBy(heartbeatRuns.nativeIssueId, heartbeatRuns.companyId, heartbeatRuns.agentId);
  // Stable issue order preserves the existing issue -> run lock order even
  // when a secret has bindings on several agents/projects/environments.
  const seen = new Set<string>();
  for (const consumer of consumers) {
    if (!consumer.issueId) continue;
    const key = `${consumer.companyId}:${consumer.agentId}:${consumer.issueId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await requestHeldNativeConfigurationEnd(tx, { ...consumer, issueId: consumer.issueId });
  }
}

/** Notifications are hints; bootstrap/reconnect and every idle/steering boundary
 * re-read the durable flag, so a rolled-back write cannot end a held turn. */
export function observeHeldNativeConfiguration(db: Db, scope: { companyId: string; agentId: string }, onHint: () => void): () => void {
  if (databaseWorkScopeKey(db) === db) return () => {}; // Uninstrumented service doubles.
  return subscribeDatabaseWork(db, HELD_NATIVE_CONFIGURATION_TOPIC, (event, hints) => {
    if (event !== "settled") return;
    if (!hints || [...hints].some(hint => {
      try { const value = JSON.parse(hint); return value.companyId === scope.companyId && value.agentId === scope.agentId; }
      catch { return false; }
    })) onHint();
  });
}

/** Only committed native-continuous-reply attribution counts as an answer.
 * Provider text, final arrival, a cancelled consumed wake, or an ACK do not. */
export function continuousReplyQuestionIds(result: Record<string, unknown>): Set<string> {
  return new Set(Object.values(parseObject(result.continuousReplies)).flatMap(value => {
    const ids = parseObject(value).questionCommentIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }));
}

export async function readHeldNativeTurnWork(db: Db, scope: { companyId: string; agentId: string; issueId: string; runId: string }) {
  const [run] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId),
    eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.nativeIssueId, scope.issueId),
  )).limit(1);
  if (!run) return null; // Missing authority cannot certify idle.
  const result = parseObject(run.resultJson);
  const answered = continuousReplyQuestionIds(result);
  const unanswered = Object.entries(parseObject(result.queuedSteeringAcknowledgements))
    .some(([id, receipt]) => parseObject(receipt).status === "acknowledged" && !answered.has(id));
  return { endRequested: result.heldNativeConfigurationEnd === true, answered, unanswered };
}
