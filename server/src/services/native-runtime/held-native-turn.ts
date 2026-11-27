import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { agents, environments, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { environmentService } from "../environments.js";
import { resolveFreshHeartbeatEnvironmentId } from "../heartbeat/environment-selection.js";
import { resolveCoreTrustPreset } from "../trust-preset-resolver.js";
import { parseIssueExecutionWorkspaceSettings } from "../execution-workspace-policy.js";
import type { InstanceSettings } from "@paperclipai/shared";
import { stableHash } from "../tool-catalog-hash.js";
import { instanceSettingsService } from "../instance-settings.js";
import { databaseWorkScopeKey, signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";

export const HELD_NATIVE_CONFIGURATION_TOPIC = "native-held-configuration";

/** Durable agent-scoped (optionally issue-scoped) intent; observers act only after commit and re-read it.
 * Old runs without this additive flag keep their existing hold policy. No wakes,
 * cancellation state, or next-run session-compatibility policy are changed. */
// Runtime selection can already say native while dispatch still owns the issue
// lock. Such a preparation is NOT a held consumer: the late hold check below
// closes the race without making a configuration writer wait on dispatch.
const admittedNativeRun = sql`(not (coalesce(${heartbeatRuns.usageJson}->'budgetDispatch', '{}'::jsonb) ? 'admittedAt')
  or ${heartbeatRuns.usageJson} #>> '{budgetDispatch,handedOffAt}' is not null)`;

export async function requestHeldNativeConfigurationEnd(tx: Db, scope: { companyId: string; agentId: string; issueId?: string; runId?: string }) {
  const running = and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
    scope.issueId ? eq(heartbeatRuns.nativeIssueId, scope.issueId) : undefined,
    scope.runId ? eq(heartbeatRuns.id, scope.runId) : undefined, admittedNativeRun,
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
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"), admittedNativeRun, isNotNull(heartbeatRuns.nativeIssueId),
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
        // Preparation still has legacy runtimeMode. Only admitted, exact
        // environment consumers belong to this held-turn fence; pre-launch
        // freshness is checked separately, never inferred from a missing id.
        : target.targetType === "environment" ? sql`${heartbeatRuns.contextSnapshot} #>> '{paperclipEnvironment,id}' = ${target.targetId}`
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

function settingsChangePreparedSelection(snapshot: unknown, settings: InstanceSettings): boolean {
  const selection = parseObject(parseObject(snapshot).selection);
  if (!Object.keys(selection).length) return false;
  return stableHash(selection) !== stableHash({ ...selection,
    executionMode: settings.general.executionMode ?? "any",
    managedSandboxOnly: settings.experimental.enableManagedSandboxOnly === true,
    ...(Object.hasOwn(selection, "instanceDefaultEnvironmentId")
      ? { instanceDefaultEnvironmentId: settings.defaultEnvironmentId ?? null } : {}),
  });
}

/** Older admitted runs have an exact selected environment but no source
 * snapshot. Re-resolve only the selector, never workspace/provider effects;
 * this also covers recovery of a pre-upgrade immutable native input. */
async function settingsChangeAdmittedEnvironment(db: Db, run: { companyId: string; agentId: string; issueId: string | null; contextSnapshot: unknown }, settings: InstanceSettings) {
  const context = parseObject(run.contextSnapshot);
  if (Object.keys(parseObject(context.paperclipHeldConfiguration)).length) {
    return settingsChangePreparedSelection(context.paperclipHeldConfiguration, settings);
  }
  const admittedId = parseObject(context.paperclipEnvironment).id;
  if (typeof admittedId !== "string") return false; // Controller-only runs have no environment.
  const [agent] = await db.select({ defaultEnvironmentId: agents.defaultEnvironmentId }).from(agents)
    .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
  const [issue] = run.issueId ? await db.select({ executionPolicy: issues.executionPolicy, executionWorkspaceSettings: issues.executionWorkspaceSettings })
    .from(issues).where(and(eq(issues.id, run.issueId), eq(issues.companyId, run.companyId))) : [];
  const [local] = await db.select({ id: environments.id }).from(environments).where(eq(environments.driver, "local")).limit(1);
  const service = environmentService(db);
  const managed = settings.experimental.enableManagedSandboxOnly ? await service.findManagedSandboxEnvironment(run.companyId) : null;
  const kubernetes = settings.general.executionMode === "kubernetes" ? await service.findKubernetesEnvironment(run.companyId) : null;
  try {
    return resolveFreshHeartbeatEnvironmentId({ executionMode: settings.general.executionMode ?? "any",
      kubernetesEnvironmentId: kubernetes?.id ?? null,
      lowTrustIssueEnvironmentId: issue && resolveCoreTrustPreset({ companyId: run.companyId, issue,
        run: { executionPolicy: context.executionPolicy } }).kind === "low_trust_review"
        ? parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings, { includeEnvironmentId: true })?.environmentId ?? null : null,
      agentDefaultEnvironmentId: agent?.defaultEnvironmentId ?? null,
      instanceDefaultEnvironmentId: settings.defaultEnvironmentId, localDefaultEnvironmentId: local?.id ?? null,
      managedSandboxOnly: settings.experimental.enableManagedSandboxOnly === true, managedSandboxEnvironmentId: managed?.id ?? null,
    }) !== admittedId;
  } catch { return true; } // The next turn must re-prepare and surface the policy blocker.
}

// A settings writer may acquire at most 32 consumer issue locks. Larger
// instances defer the remainder to their existing idle/attachment check; the
// committed singleton plus the broad notification are the invalidation marker.
export const HELD_SETTINGS_CONSUMER_LIMIT = 32;

/** Freeze the bounded consumer set and lock its issues BEFORE the settings
 * UPDATE's agent-runtime trigger. Reusing this exact sample after the UPDATE
 * prevents agent -> issue inversion, including newly attaching consumers. */
export async function lockHeldNativeSettingsConsumers(tx: Db) {
  const runs = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.nativeIssueId,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
    admittedNativeRun, isNotNull(heartbeatRuns.nativeIssueId),
  )).orderBy(heartbeatRuns.nativeIssueId, heartbeatRuns.id).limit(HELD_SETTINGS_CONSUMER_LIMIT + 1);
  const issueIds = [...new Set(runs.slice(0, HELD_SETTINGS_CONSUMER_LIMIT).flatMap(run => run.issueId ? [run.issueId] : []))].sort();
  if (issueIds.length) await tx.select({ id: issues.id }).from(issues).where(inArray(issues.id, issueIds))
    .orderBy(issues.id).for("no key update");
  return runs;
}

/** Only prepared consumers of the changed settings; own/issue/forced environment
 * selections omit the instance-default key. Atomic with the settings save. */
export async function requestHeldNativeConfigurationEndForSettings(tx: Db, settings: InstanceSettings,
  lockedRuns?: Awaited<ReturnType<typeof lockHeldNativeSettingsConsumers>>) {
  const runs = lockedRuns ?? await lockHeldNativeSettingsConsumers(tx);
  const overflow = runs.length > HELD_SETTINGS_CONSUMER_LIMIT;
  const sampled = runs.slice(0, HELD_SETTINGS_CONSUMER_LIMIT);
  // No per-overflow-run writes or issue locks inside the saving transaction.
  // Every held controller invalidates its per-hold selector cache after commit;
  // attachment and the next idle boundary also check without a notification.
  await signalDatabaseWork(tx, HELD_NATIVE_CONFIGURATION_TOPIC);
  for (const run of sampled) {
    if (run.issueId && await settingsChangeAdmittedEnvironment(tx, run, settings)) {
      await requestHeldNativeConfigurationEnd(tx, { companyId: run.companyId, agentId: run.agentId,
        issueId: run.issueId, runId: run.id });
    }
  }
  logger.info({ processedConsumers: sampled.length, overflow, consumerLimit: HELD_SETTINGS_CONSUMER_LIMIT },
    "held native settings consumers checked; overflow deferred to idle/attachment");
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

/** Server-only classification after the idle interrupt is accepted. This is not
 * a person's Stop receipt, and is never sent as the provider interrupt reason. */
export async function recordHeldNativeTurnClose(db: Db, scope: { companyId: string; agentId: string; issueId: string; runId: string }) {
  await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(
    coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb), '{heldNativeTurnCloseReason}',
    to_jsonb(case when ${heartbeatRuns.resultJson}->'heldNativeConfigurationEnd' = 'true'::jsonb
      then 'configuration_changed'::text else 'hold_close'::text end))` })
    .where(and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.nativeIssueId, scope.issueId)));
}

/** Only committed native-continuous-reply attribution counts as an answer.
 * Provider text, final arrival, a cancelled consumed wake, or an ACK do not. */
export function continuousReplyQuestionIds(result: Record<string, unknown>): Set<string> {
  return new Set(Object.values(parseObject(result.continuousReplies)).flatMap(value => {
    const ids = parseObject(value).questionCommentIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }));
}

export async function readHeldNativeTurnWork(db: Db, scope: { companyId: string; agentId: string; issueId: string; runId: string },
  options: { checkConfiguration?: boolean; settingsFingerprint?: string } = {}): Promise<{
    endRequested: boolean; answered: Set<string>; unanswered: boolean; publishedItems?: string[]; settingsFingerprint?: string;
  } | null> {
  const [run] = await db.select({ resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId),
    eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.nativeIssueId, scope.issueId),
  )).limit(1);
  if (!run) return null; // Missing authority cannot certify idle.
  const result = parseObject(run.resultJson);
  const prepared = parseObject(parseObject(run.contextSnapshot).paperclipHeldConfiguration);
  let settingsFingerprint: string | undefined;
  if (result.heldNativeConfigurationEnd !== true && (Object.keys(prepared).length ||
    typeof parseObject(parseObject(run.contextSnapshot).paperclipEnvironment).id === "string")) {
    // Hints are only an optimization. Before ANY held-message/steer authority
    // read can reuse a checked selector, compare the actual saved settings
    // content. This constant-size uncached read survives lost notifications,
    // cross-agent scan overflow, process replacement and reconnect. It does
    // not resolve environment selection on unchanged-settings steering.
    const settings = await instanceSettingsService(db).getReadOnly();
    settingsFingerprint = stableHash(settings ? {
      defaultEnvironmentId: settings.defaultEnvironmentId ?? null,
      executionMode: settings.general.executionMode ?? "any",
      managedSandboxOnly: settings.experimental.enableManagedSandboxOnly === true,
    } : null);
    if (options.checkConfiguration !== false || options.settingsFingerprint !== settingsFingerprint) {
      // Also runs on reconnect/hold attachment: a save can have committed before
      // this run was a held consumer. Never replace recovery's admitted input.
      const [agent] = await db.select({ adapterConfig: agents.adapterConfig, defaultEnvironmentId: agents.defaultEnvironmentId })
        .from(agents).where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)));
      const changed = !agent || (Object.hasOwn(prepared, "agentEnvFingerprint") &&
        prepared.agentEnvFingerprint !== stableHash(parseObject(agent.adapterConfig).env ?? null)) ||
        (Object.hasOwn(prepared, "agentDefaultEnvironmentId") && prepared.agentDefaultEnvironmentId !== agent?.defaultEnvironmentId) ||
        (settings && await settingsChangeAdmittedEnvironment(db, { ...scope, contextSnapshot: run.contextSnapshot }, settings));
      if (changed) {
        await db.transaction(tx => requestHeldNativeConfigurationEnd(tx as unknown as Db, scope));
        result.heldNativeConfigurationEnd = true;
      }
    }
  }
  const answered = continuousReplyQuestionIds(result);
  const unanswered = Object.entries(parseObject(result.queuedSteeringAcknowledgements))
    .some(([id, receipt]) => parseObject(receipt).status === "acknowledged" && !answered.has(id));
  return { endRequested: result.heldNativeConfigurationEnd === true, answered, unanswered,
    publishedItems: Object.keys(parseObject(result.continuousReplies)), settingsFingerprint };
}
