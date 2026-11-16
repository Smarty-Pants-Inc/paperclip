import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  activityLog, companySecrets, companySecretVersions, connectionGrants, heartbeatRuns, issues, projects,
  toolConnectionInstalls, toolConnections, type Db,
} from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { assertProjectConnectionAdmission, readProjectConnectionScope } from "./project-connection-admission.js";
import type { ActorInfo, DbTransaction } from "./tool-access/types.js";

type Connection = typeof toolConnections.$inferSelect;

/** Lane D: both run admission (C) and destructive writers lock the same lifecycle row.
 * Call on the actual transaction, before registration/installation/run/connection
 * locks. Multiple projects must be acquired in sorted order by the caller. The
 * lock is deliberately NOT a running-work gate: parallel project runs may start.
 */
export async function lockProjectConnectionLifecycle(
  tx: Db | DbTransaction,
  input: Readonly<{ companyId: string; projectId: string }>,
): Promise<void> {
  const [project] = await tx.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)))
    .for("update");
  if (!project) throw notFound("Project not found");
}

/** The actual caller supplies confirmation; manager status never implies it.
 * The caller holds the lifecycle lock on this transaction. Project work is
 * counted conservatively, including queued/starting work and an installed
 * agent's taskless work. A task bound to another project is not A's work.
 */
export async function assertProjectConnectionNotInUse(
  tx: Db | DbTransaction,
  input: Readonly<{ companyId: string; projectId: string; connectionId: string; actor?: ActorInfo; projectDoneConfirmation?: Readonly<{ projectId: string; connectionId: string }> }>,
): Promise<void> {
  const [connection] = await tx.select({ id: toolConnections.id }).from(toolConnections).where(and(
    eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, input.connectionId),
    eq(toolConnections.projectId, input.projectId),
  ));
  if (!connection) throw notFound("Project connection not found");
  const confirmation = input.projectDoneConfirmation;
  if (confirmation) {
    if (confirmation.projectId !== input.projectId || confirmation.connectionId !== input.connectionId) {
      throw conflict("Project-done confirmation must name this project and connection", { code: "project_connection_confirmation_mismatch" });
    }
    if (!input.actor?.actorId || !["user", "agent"].includes(input.actor.actorType ?? "")) {
      throw forbidden("An authorized human or agent must explicitly confirm this project is done", { code: "project_connection_actor_required" });
    }
    // Confirmation is not authorization. In particular a B agent cannot waive
    // A's work by copying the same human's identity or a scoped confirmation.
    const [saved] = await tx.select().from(toolConnections).where(and(
      eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, input.connectionId),
    ));
    await assertProjectConnectionAdmission(tx, { ...input, connection: saved, operation: "retire" });
    return;
  }
  const installs = tx.select({ agentId: toolConnectionInstalls.targetId }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, input.connectionId),
    eq(toolConnectionInstalls.targetType, "agent"),
  ));
  const companyInstall = tx.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, input.connectionId),
    eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, input.companyId),
  ));
  // Use the existing stored task-binding precedence, including native runs and
  // trimmed historical task IDs. A snapshot's claimed project is NOT authority.
  // Compare as text so malformed historical hints cannot cause a UUID cast.
  const taskBinding = boundRunIssueIdSql();
  const projectTask = tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.projectId, input.projectId), sql`${issues.id}::text = ${taskBinding}`,
  ));
  const otherProjectTask = tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId), sql`${issues.id}::text = ${taskBinding}`,
    sql`${issues.projectId} is not null`,
  ));
  const runs = await tx.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    inArray(heartbeatRuns.status, ["queued", "starting", "running"]),
    or(sql`exists (${projectTask})`, and(
      sql`not exists (${otherProjectTask})`,
      or(sql`${heartbeatRuns.agentId}::text in (${installs})`, sql`exists (${companyInstall})`),
    )),
  )).orderBy(heartbeatRuns.id).limit(101);
  if (runs.length) {
    throw conflict("This project's connection is in use. Finish its work or explicitly confirm this project is done before removing access.", {
      code: "project_connection_in_use", projectId: input.projectId, connectionId: input.connectionId,
      runs: runs.slice(0, 100).map(run => ({ ...run, href: `/runs/${run.id}` })), more: runs.length > 100,
    });
  }
}

/** Caller composes state/grant/install effects and this value-free receipt on ONE tx.
 * persistActivity deliberately does not publish before the caller commits.
 * Same-state archive retries are serialized by the connection row and reuse
 * only this row's durable receipt, never a cross-archive fingerprint.
 */
export async function writeProjectConnectionReceipt(
  tx: Db | DbTransaction,
  input: Readonly<{
    connection: Connection;
    actor?: ActorInfo;
    action: "tool_connection.project_taken" | "tool_connection.archived" | "tool_connection.updated";
    reason?: string;
    targetAgentIds?: readonly string[];
    verifiedRepositoryIds?: readonly number[];
  }>,
): Promise<{ activityId: string }> {
  const [connection] = await tx.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, input.connection.companyId), eq(toolConnections.id, input.connection.id),
  )).for("update");
  if (!connection || !connection.projectId || connection.projectId !== input.connection.projectId) throw notFound("Project connection not found");
  const scope = readProjectConnectionScope(connection);
  if (!scope) throw conflict("Project connection approval is unavailable", { code: "project_connection_scope_invalid" });
  if ((input.targetAgentIds ?? []).some(id => !isUuidLike(id))
    || (input.verifiedRepositoryIds ?? []).some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw conflict("Receipt identifiers must be normalized domain identifiers", { code: "project_connection_receipt_invalid" });
  }
  const audit = input.actor?.managementContext?.audit;
  const actorType = input.actor?.actorType ?? audit?.actorType;
  const actorId = input.actor?.actorId ?? audit?.actorId;
  if (!actorType || !actorId || (audit && (audit.actorType !== actorType || audit.actorId !== actorId))) {
    throw forbidden("Project connection receipts require the actual actor", { code: "project_connection_actor_required" });
  }
  if (input.action !== "tool_connection.archived" && connection.status === "archived") {
    throw conflict("This project's connection was retired. Create a new approved project connection.", { code: "project_connection_archived" });
  }
  if (input.action === "tool_connection.project_taken") {
    const [taken] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, connection.companyId), eq(activityLog.entityType, "tool_connection"),
      eq(activityLog.entityId, connection.id), eq(activityLog.action, input.action),
    )).limit(1);
    if (taken) throw conflict("This project connection already has a take receipt", { code: "project_connection_receipt_state_conflict" });
  }
  if (input.action === "tool_connection.archived") {
    if (connection.status !== "archived" || connection.enabled) throw conflict("Retirement receipt requires a disabled, archived connection", { code: "project_connection_receipt_state_conflict" });
    const [receipt] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, connection.companyId), eq(activityLog.entityType, "tool_connection"),
      eq(activityLog.entityId, connection.id), eq(activityLog.action, input.action),
    )).limit(1);
    if (receipt) return { activityId: receipt.id };
  }
  const operationId = randomUUID();
  const { activity } = await persistActivity(tx as Db, {
    companyId: connection.companyId, actorType, actorId,
    agentId: actorType === "agent" ? actorId : null,
    runId: audit?.runId ?? input.actor?.managementContext?.workContext.runId ?? null,
    responsibleUserIdOverride: actorType === "user" ? actorId
      : input.actor?.responsibleUserId ?? input.actor?.managementContext?.responsibleUserId ?? scope.responsibleUserId,
    action: input.action, entityType: "tool_connection", entityId: connection.id,
    details: {
      projectId: connection.projectId, connectionId: connection.id,
      installationKey: scope.installationKey, registrationId: scope.registrationId,
      operationId, outcome: "committed", status: connection.status, enabled: connection.enabled,
      migrationPending: scope.migrationPending === true,
      // A caller reason may include provider text. Keep only known semantic
      // reasons; never copy arbitrary config, secret references or wire bodies.
      reason: receiptReason(input.reason, input.action),
      // Reuse the existing activity vocabulary; the connection timeline ignores
      // updated rows with no lifecycle, so an atomic receipt must carry it.
      ...(input.action === "tool_connection.updated" && input.reason === "connection_disabled" ? { lifecycle: "paused" } : {}),
      ...(input.action === "tool_connection.updated" && input.reason === "migration_activated" ? { lifecycle: "resumed" } : {}),
      targetAgentIds: [...new Set(input.targetAgentIds ?? [])].sort(),
      verifiedRepositoryIds: [...new Set(input.verifiedRepositoryIds ?? [])].sort((a, b) => a - b),
    },
  });
  if (!activity) throw new Error("Project connection receipt was not persisted");
  return { activityId: activity.id };
}

function receiptReason(reason: string | undefined, action: string): string {
  return reason && ["project_taken", "project_retired", "migration_activated", "connection_disabled", "access_updated"].includes(reason)
    ? reason : action.replace("tool_connection.", "");
}

/** Compose option-B first binding with the judged make-before-break exception.
 * The create writer holds the project's lifecycle/identity locks and has just
 * revalidated this exact ordinary source through the custody reader. Only an
 * initially unowned project with real legacy reach may stage a pending draft;
 * retained history (including archives) can never reset C2. No caller metadata
 * chooses this exception, and no legacy install is changed here.
 */
export async function stageProjectConnectionMigration(
  tx: Db | DbTransaction,
  input: Readonly<{ companyId: string; projectId: string; sourceConnectionId: string; config: Record<string, unknown>; status: string; enabled: boolean }>,
): Promise<Record<string, unknown>> {
  const [history] = await tx.select({ id: toolConnections.id }).from(toolConnections).where(and(
    eq(toolConnections.companyId, input.companyId), eq(toolConnections.projectId, input.projectId),
  )).limit(1);
  if (history) return input.config;
  const [legacy] = await tx.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, input.sourceConnectionId),
  ));
  if (!legacy || legacy.projectId !== null || legacy.status !== "active" || !legacy.enabled) return input.config;
  const [install] = await tx.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, legacy.id),
  )).limit(1);
  if (!install) return input.config;
  if (input.status !== "draft" || input.enabled) {
    throw conflict("Verify and finish this project candidate before activating it.", { code: "project_connection_verification_required" });
  }
  const scope = readProjectConnectionScope({ projectId: input.projectId, config: input.config });
  if (!scope) throw conflict("Project connection approval is unavailable", { code: "project_connection_scope_invalid" });
  return { ...input.config, projectScope: { ...scope, migrationPending: true, legacyConnectionId: legacy.id } };
}

/** B's existing finish writer calls this only AFTER external verification, under its tx.
 * B also takes A's verified identity locks and compares the preflight token's
 * identity/repo/version facts. This helper never mints a token or removes legacy
 * reach. B's grant/profile/install writes remain on THIS transaction; any later
 * failure rolls the pending transition and receipt back as well.
 */
export async function activateProjectConnectionMigration(
  tx: Db | DbTransaction,
  input: Readonly<{ connection: Connection; actor?: ActorInfo; targetAgentIds: readonly string[]; verifiedRepositoryIds: readonly number[]; verifiedSecretVersion: number }>,
): Promise<void> {
  if (!input.connection.projectId) return;
  const { companyId, projectId, id } = input.connection;
  await lockProjectConnectionLifecycle(tx, { companyId, projectId });
  const [connection] = await tx.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId), eq(toolConnections.projectId, projectId), eq(toolConnections.id, id),
  )).for("update");
  if (!connection) throw notFound("Project connection not found");
  if (connection.status === "archived") throw conflict("This project's connection was retired. Create a new approved project connection.", { code: "project_connection_archived" });
  const scope = readProjectConnectionScope(connection);
  if (!scope) throw conflict("Project connection approval is unavailable", { code: "project_connection_scope_invalid" });
  if (scope.migrationPending !== true) return;
  await assertProjectConnectionAdmission(tx, { companyId, projectId, connection, actor: input.actor, operation: "finish",
    targetAgentIds: input.targetAgentIds, proposedRepositoryIds: input.verifiedRepositoryIds });
  const stale = () => conflict("Project connection verification changed. Verify this saved draft again.", { code: "project_connection_verification_stale" });
  if (connection.status !== "draft" || connection.enabled || !scope.legacyConnectionId
    || JSON.stringify(connection.config) !== JSON.stringify(input.connection.config)
    || JSON.stringify(connection.credentialSecretRefs) !== JSON.stringify(input.connection.credentialSecretRefs)) throw stale();
  const installs = await tx.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.connectionId, id),
  )).limit(1);
  const history = await tx.select({ id: toolConnections.id }).from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId), eq(toolConnections.projectId, projectId), ne(toolConnections.id, id),
  )).limit(1);
  if (installs.length || history.length) throw stale();
  const [legacy] = await tx.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId), eq(toolConnections.id, scope.legacyConnectionId),
  ));
  if (!legacy || legacy.projectId !== null || legacy.status !== "active" || !legacy.enabled) throw stale();
  const legacyInstalls = await tx.select({ targetType: toolConnectionInstalls.targetType, targetId: toolConnectionInstalls.targetId })
    .from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.connectionId, legacy.id)));
  if (!legacyInstalls.some(install => install.targetType === "company" && install.targetId === companyId)
    && input.targetAgentIds.some(id => !legacyInstalls.some(install => install.targetType === "agent" && install.targetId === id))) throw stale();
  const repositoryIds = [...new Set(input.verifiedRepositoryIds)];
  if (!repositoryIds.length || repositoryIds.some(id => !Number.isSafeInteger(id) || id <= 0 || !scope.approvedRepositoryIds.includes(id))) throw stale();
  if (!input.targetAgentIds.length || !Number.isSafeInteger(input.verifiedSecretVersion) || input.verifiedSecretVersion <= 0) throw stale();
  const grants = await tx.select().from(connectionGrants).where(and(
    eq(connectionGrants.companyId, companyId), eq(connectionGrants.connectionId, id), ne(connectionGrants.status, "revoked"),
  ));
  if (grants.length !== 1 || grants[0]!.kind !== "organization") throw stale();
  const refs = grants[0]!.credentialSecretRefs;
  if (refs.length !== 1 || refs[0]!.configPath !== "credentials.privateKey" || connection.credentialRefs.length
    || connection.credentialSecretRefs.length !== 1) throw stale();
  const ref = refs[0]!;
  const connectionRef = connection.credentialSecretRefs[0]!;
  if (ref.secretId !== connectionRef.secretId || ref.configPath !== connectionRef.configPath
    || (ref.versionSelector ?? "latest") !== (connectionRef.versionSelector ?? "latest")) throw stale();
  if (!scope.approvedSecretRefs.some(approved => approved.secretId === ref.secretId && approved.configPath === ref.configPath)) throw stale();
  const [secret] = await tx.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId)));
  if (!secret || secret.status !== "active" || secret.deletedAt || secret.scope !== "company"
    || (ref.versionSelector === undefined || ref.versionSelector === "latest" ? secret.latestVersion : ref.versionSelector) !== input.verifiedSecretVersion) throw stale();
  const [version] = await tx.select({ status: companySecretVersions.status, revokedAt: companySecretVersions.revokedAt })
    .from(companySecretVersions).where(and(eq(companySecretVersions.secretId, ref.secretId), eq(companySecretVersions.version, input.verifiedSecretVersion)));
  if (!version || version.revokedAt || !["current", "previous"].includes(version.status)) throw stale();
  // Re-read current actor/recipient approval after all waits. No provider I/O is
  // performed while the lifecycle lock is held.
  await assertProjectConnectionAdmission(tx, { companyId, projectId, connection, actor: input.actor, operation: "finish",
    targetAgentIds: input.targetAgentIds, proposedRepositoryIds: repositoryIds,
    proposedSecretRefs: [{ secretId: ref.secretId, configPath: ref.configPath }] });
  const nextScope = { ...scope, migrationPending: false };
  const config = { ...connection.config, projectScope: nextScope };
  const [activated] = await tx.update(toolConnections).set({ config,
    transportConfig: { ...connection.transportConfig, projectScope: nextScope }, status: "active", enabled: true, updatedAt: new Date(),
  }).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, id))).returning();
  if (!activated) throw stale();
  await writeProjectConnectionReceipt(tx, { connection: activated, actor: input.actor, action: "tool_connection.updated",
    reason: "migration_activated", targetAgentIds: input.targetAgentIds, verifiedRepositoryIds: repositoryIds });
}
