import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, sql, type SQLWrapper } from "drizzle-orm";
import {
  companies, companyMemberships, companySecrets, connectionGrants, pluginCompanySettings, pluginConfig, plugins,
  projects, toolConnections, userCompanyPreferences, type Db,
} from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden, HttpError, notFound } from "../errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { createGitHubAppClient, invalidateGitHubAppInstallation, isGitHubAppConnection, parseGitHubAppConfig } from "./github-app-client.js";
import { resolveConnectionGrantSecret, validateConnectionGrantSecretOwnership } from "./connection-credentials.js";
import { secretService } from "./secrets.js";
import type { DbTransaction } from "./tool-access/types.js";
import type { ProjectConnectionScope } from "./project-connection-admission.js";
import type { VerifiedProjectConnectionProviderScope } from "./project-connection-provider-scope.js";

type Database = Db | DbTransaction;
type Connection = typeof toolConnections.$inferSelect;
type Ref = Readonly<{ secretId: string; configPath: string; versionSelector?: "latest" | number }>;
export const PROJECT_APP_APPROVAL_FIELD = "projectAppApproval";
export const PROJECT_APP_APPROVAL_SOURCE = "projectAppApprovalSourceId";
/** Server-written on S when a receipt-citing first bind consumes it (RFL 04:5xZ). */
export const PROJECT_APP_APPROVAL_CONSUMED_BY = "projectAppApprovalConsumedBy";
export const ROW12_INSTALLER_PLUGIN_KEY = "paperclipai.plugin-row12-installer";
const positiveId = z.string().regex(/^[1-9]\d*$/);
const repoIds = z.array(z.number().int().positive().safe()).min(1).max(500).refine(ids => new Set(ids).size === ids.length);
const receiptSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), companyId: z.string().uuid(), humanUserId: z.string().min(1), projectId: z.string().uuid(),
  appId: positiveId, installationId: positiveId, repositoryIds: repoIds,
  secretRef: z.object({ secretId: z.string().uuid(), configPath: z.literal("credentials.privateKey") }).strict(),
  verifiedAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(),
}).strict();
export type ProjectAppApproval = Readonly<z.infer<typeof receiptSchema>>;
const unavailable = () => forbidden("The project App requires the current responsible human's approval of this exact verified tuple.", { code: "project_app_approval_required" });
const consumed = () => conflict("This project App approval was already used by a project connection. H must approve a new source.", { code: "project_app_approval_consumed" });
const managerUnavailable = () => forbidden("The session-configured manager App classification is unavailable.", { code: "project_app_manager_classification_unavailable" });
const managerForbidden = () => forbidden("The manager App and its private-key reference cannot serve a project or agent.", { code: "project_app_manager_forbidden" });
const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

/** A value-free presence fact selected with the current connection snapshot.
 * Ordinary credential reads need no separate classifier query when this company
 * has no C4/W1 state. Retained anchors/keys count even if config was removed. */
export function projectAppManagerConfigured(companyId: string | SQLWrapper) {
  return sql<boolean>`exists (
    select 1 from ${plugins} where ${plugins.pluginKey} = ${ROW12_INSTALLER_PLUGIN_KEY}
      and (exists (select 1 from ${pluginConfig} where ${pluginConfig.pluginId} = ${plugins.id} and ${pluginConfig.companyId} = ${companyId})
        or exists (select 1 from ${companySecrets} where ${companySecrets.ownerPluginId} = ${plugins.id} and ${companySecrets.companyId} = ${companyId}
          and ${companySecrets.scope} = 'instance' and ${companySecrets.key} = 'manager_private_key')
        or exists (select 1 from ${projects} where ${projects.companyId} = ${companyId} and ${projects.name} = 'github-manager-key'))
  )`;
}

/** Classification reads only existing native C4 config and W1 ownership metadata.
 * Null means this company has never configured a manager, not an unreadable
 * configured deny-list. Retained C4/W1 state always fails closed if incomplete.
 * Never read the manager PEM. */
export async function readProjectAppManager(db: Database, companyId: string) {
  const [plugin] = await db.select().from(plugins).where(eq(plugins.pluginKey, ROW12_INSTALLER_PLUGIN_KEY)).for("share");
  if (!plugin) return null;
  const [config] = await db.select().from(pluginConfig).where(and(eq(pluginConfig.companyId, companyId), eq(pluginConfig.pluginId, plugin.id))).for("share");
  if (!config) {
    // A removed config must not turn an existing W1 manager into an ordinary
    // App. Include inactive/deleted metadata: corruption is not deconfiguration.
    const [key] = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId), eq(companySecrets.ownerPluginId, plugin.id),
      eq(companySecrets.scope, "instance"), eq(companySecrets.key, "manager_private_key"),
    ));
    const [anchor] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), eq(projects.name, "github-manager-key")));
    if (key || anchor) throw managerUnavailable();
    return null;
  }
  const manifestKeys = z.object({ instanceSecretKeys: z.array(z.string()) }).safeParse(plugin.manifestJson);
  if (plugin.status !== "ready" || !plugin.manifestJson?.capabilities?.includes("projects.instance-secrets")
    || !manifestKeys.success || !manifestKeys.data.instanceSecretKeys.includes("manager_private_key")) throw managerUnavailable();
  const [settings] = await db.select().from(pluginCompanySettings).where(and(eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.pluginId, plugin.id)));
  const id = positiveId.safeParse(config?.configJson.managerAppId);
  const anchorId = z.string().uuid().safeParse(config?.configJson.managerKeyAnchorProjectId);
  if (settings?.enabled === false || !id.success || !anchorId.success) throw managerUnavailable();
  const [anchor] = await db.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, anchorId.data))).for("share");
  if (!anchor || anchor.archivedAt || anchor.name !== "github-manager-key" || anchor.leadAgentId) throw managerUnavailable();
  const keys = await db.select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion }).from(companySecrets).where(and(
    eq(companySecrets.companyId, companyId), eq(companySecrets.ownerPluginId, plugin.id), eq(companySecrets.ownerProjectId, anchor.id),
    eq(companySecrets.scope, "instance"), eq(companySecrets.key, "manager_private_key"), eq(companySecrets.status, "active"), isNull(companySecrets.deletedAt),
  ));
  if (keys.length !== 1 || !Number.isSafeInteger(keys[0]!.latestVersion) || keys[0]!.latestVersion < 1) throw managerUnavailable();
  return { appId: id.data, secretId: keys[0]!.id, anchorProjectId: anchor.id, pluginId: plugin.id };
}

export async function assertNotManagerApp(db: Database, input: { companyId: string; refs?: readonly Readonly<{ secretId: string; configPath?: string }>[]; appId?: string; verifiedAppId?: string; requireConfigured?: boolean }) {
  const manager = await readProjectAppManager(db, input.companyId);
  if (!manager) {
    if (input.requireConfigured) throw managerUnavailable();
    return null;
  }
  if (input.refs?.some(ref => ref.secretId === manager.secretId) || input.appId === manager.appId || input.verifiedAppId === manager.appId) throw managerForbidden();
  return manager;
}

/** Protect before normalization on all generic/native/plugin/import writers.
 * A full replacement that omits an existing protected field is an erase attempt. */
export function assertProjectAppReceiptInput(input: { config?: unknown; transportConfig?: unknown }, existing?: Pick<Connection, "config" | "transportConfig">) {
  for (const key of ["config", "transportConfig"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    for (const field of [PROJECT_APP_APPROVAL_FIELD, PROJECT_APP_APPROVAL_SOURCE, PROJECT_APP_APPROVAL_CONSUMED_BY]) {
      if (Object.hasOwn(record, field) || (existing?.[key] && Object.hasOwn(existing[key], field))) {
        throw forbidden("Project App approval receipts are written only by the responsible human's board-session approval route.", { code: "project_app_receipt_protected" });
      }
    }
  }
}

async function responsibleHuman(db: Database, companyId: string, userId: string, lock = false) {
  const query = db.select().from(companies).where(eq(companies.id, companyId));
  const [company] = await (lock ? query.for("update") : query);
  const [membership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
    eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
  if (!company?.defaultResponsibleUserId || company.defaultResponsibleUserId !== userId || !membership
    || !["owner", "admin"].includes(membership.membershipRole ?? "")) {
    throw forbidden("Only the company's current default responsible human may approve or revoke this App.", { code: "project_app_approver_not_responsible_human" });
  }
  return company;
}

/** The ONE internal custody reader. Facts only: no PEM, JWT, token or provider
 * wire data. DB state is checked on every admission and every cache hit. */
export async function readProjectAppCustody(db: Database, input: {
  companyId: string; projectId: string; config: Record<string, unknown>; refs: readonly Ref[];
  registrationId?: string; repositoryIds: readonly number[];
  /** The owned connection reading its custody. Only the connection that consumed
   * an archived source may keep reading it; a first bind passes none. */
  connectionId?: string;
}): Promise<Readonly<{ sourceConnectionId: string; receipt: ProjectAppApproval }>> {
  const app = parseGitHubAppConfig(input.config.methodConfig);
  await assertNotManagerApp(db, { companyId: input.companyId, refs: input.refs, appId: app.appId, verifiedAppId: input.registrationId, requireConfigured: true });
  const [company] = await db.select().from(companies).where(eq(companies.id, input.companyId)).for("share");
  const sourceId = input.config[PROJECT_APP_APPROVAL_SOURCE];
  if (sourceId !== undefined && !z.string().uuid().safeParse(sourceId).success) throw unavailable();
  const sources = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, input.companyId),
    typeof sourceId === "string" ? eq(toolConnections.id, sourceId) : undefined)).for("share");
  const matches: Array<{ sourceConnectionId: string; receipt: ProjectAppApproval }> = [];
  let consumedForProject: string | undefined;
  for (const source of sources) {
    const parsed = receiptSchema.safeParse(source.config[PROJECT_APP_APPROVAL_FIELD]);
    const consumedBy = source.config[PROJECT_APP_APPROVAL_CONSUMED_BY];
    if (consumedBy !== undefined) {
      // Single use: an archived consumed source serves ONLY its consumer.
      if (parsed.success && parsed.data.projectId === input.projectId && typeof consumedBy === "string" && consumedBy !== input.connectionId) consumedForProject = consumedBy;
      if (consumedBy !== input.connectionId || source.status !== "archived") continue;
    } else if (source.status === "archived") continue;
    if (!parsed.success || source.status === "disabled" || source.projectId !== null || !isGitHubAppConnection(source)) continue;
    const receipt = parsed.data;
    const sourceApp = parseGitHubAppConfig(source.config.methodConfig);
    if (receipt.revokedAt || receipt.companyId !== input.companyId || receipt.projectId !== input.projectId || receipt.humanUserId !== company?.defaultResponsibleUserId
      || receipt.installationId !== app.installationId || sourceApp.installationId !== receipt.installationId
      || receipt.appId !== (input.registrationId ?? (/^[1-9]\d*$/.test(app.appId) ? app.appId : receipt.appId))
      || (/^[1-9]\d*$/.test(sourceApp.appId) && sourceApp.appId !== receipt.appId)
      || !isDeepStrictEqual(sorted(receipt.repositoryIds), sorted(input.repositoryIds))
      || input.refs.length !== 1 || !input.refs.every(ref => ref.secretId === receipt.secretRef.secretId && ref.configPath === receipt.secretRef.configPath)
      || source.credentialSecretRefs.length !== 1 || !source.credentialSecretRefs.every(ref => ref.secretId === receipt.secretRef.secretId && ref.configPath === receipt.secretRef.configPath)
      || Date.parse(receipt.verifiedAt) > Date.now() + 1000) continue;
    const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, receipt.secretRef.secretId))).for("share");
    if (!secret || secret.scope !== "company" || secret.status !== "active" || secret.deletedAt) continue;
    const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.connectionId, source.id))).for("share");
    if (grants.length !== 1 || grants[0]!.kind !== "organization" || grants[0]!.status !== "active" || grants[0]!.credentialSecretRefs.length !== 1
      || !grants[0]!.credentialSecretRefs.every(ref => ref.secretId === receipt.secretRef.secretId && ref.configPath === receipt.secretRef.configPath)) continue;
    matches.push({ sourceConnectionId: source.id, receipt });
  }
  if (matches.length === 0 && consumedForProject) {
    // While the consumer is live for this project and installation, a replay
    // is the existing named duplicate; once it is retired, the receipt is spent.
    const [consumer] = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, consumedForProject)));
    if (consumer && consumer.status !== "archived" && consumer.projectId === input.projectId
      && isGitHubAppConnection(consumer) && parseGitHubAppConfig(consumer.config.methodConfig).installationId === app.installationId) {
      throw conflict("This project already has a live connection to that installation", { code: "project_installation_in_use" });
    }
    throw consumed();
  }
  if (matches.length !== 1) throw unavailable();
  return matches[0]!;
}

/** RFL 05:56Z: an approval source is not an owned reservation against another
 * receipt-citing first bind of the same installation OR registration. This is a
 * value-free classification, never approval for the caller or consumption of S.
 * The caller's own exact receipt is separately re-read under the create locks. */
export function isUnconsumedProjectAppApprovalSource(connection: Connection, identity: {
  companyId: string; verifiedRegistrationId: string; canonicalInstallationKey: string;
}) {
  const parsed = receiptSchema.safeParse(connection.config[PROJECT_APP_APPROVAL_FIELD]);
  if (!parsed.success || parsed.data.revokedAt || connection.projectId !== null
    || ["archived", "disabled"].includes(connection.status) || !isGitHubAppConnection(connection)
    || connection.config[PROJECT_APP_APPROVAL_CONSUMED_BY] !== undefined
    || parsed.data.companyId !== connection.companyId || connection.companyId !== identity.companyId) return false;
  const app = parseGitHubAppConfig(connection.config.methodConfig);
  return app.installationId === parsed.data.installationId
    && (!/^[1-9]\d*$/.test(app.appId) || app.appId === parsed.data.appId)
    && connection.credentialSecretRefs.length === 1
    && connection.credentialSecretRefs[0]!.secretId === parsed.data.secretRef.secretId
    && connection.credentialSecretRefs[0]!.configPath === parsed.data.secretRef.configPath
    && (parsed.data.appId === identity.verifiedRegistrationId
      || `github.com/github-app-installation/${parsed.data.installationId}` === identity.canonicalInstallationKey);
}

const approvalClient = createGitHubAppClient();
/** Called ONLY by the session route. HTTP and key resolution occur before row
 * locks. The exact snapshot, current H and current classifier are rechecked
 * inside the transaction that writes BOTH receipt and activity. */
export async function writeProjectAppApproval(db: Db, input: { companyId: string; connectionId: string; projectId: string; userId: string; action: "approve" | "revoke" }) {
  await responsibleHuman(db, input.companyId, input.userId);
  const [project] = await db.select().from(projects).where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)));
  const [source] = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, input.connectionId)));
  if (!project || project.archivedAt) throw notFound("Active project not found");
  if (!source || source.projectId !== null || !isGitHubAppConnection(source) || ["archived", "disabled"].includes(source.status)
    || source.credentialPolicy !== "shared" || source.credentialSource !== "paperclip_vault" || source.credentialSecretRefs.length !== 1) throw notFound("Project App source connection not found");
  const config = parseGitHubAppConfig(source.config.methodConfig);
  const manager = await assertNotManagerApp(db, { companyId: input.companyId, refs: source.credentialSecretRefs, appId: config.appId, requireConfigured: true });
  const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.connectionId, source.id)));
  const grant = grants[0]; const ref = source.credentialSecretRefs[0]!;
  if (grants.length !== 1 || !grant || grant.kind !== "organization" || grant.status !== "active" || ref.configPath !== "credentials.privateKey"
    || !isDeepStrictEqual(grant.credentialSecretRefs, source.credentialSecretRefs)) throw unavailable();
  const keyState = await validateConnectionGrantSecretOwnership(db, source, grant, ref);
  if (keyState.status !== "active" || keyState.deletedAt) throw unavailable();
  const saved = receiptSchema.safeParse(source.config[PROJECT_APP_APPROVAL_FIELD]);
  if (input.action === "approve" && saved.success && !saved.data.revokedAt && saved.data.companyId === input.companyId
    && saved.data.projectId === input.projectId && saved.data.humanUserId === input.userId && saved.data.installationId === config.installationId
    && (!/^[1-9]\d*$/.test(config.appId) || saved.data.appId === config.appId)
    && saved.data.secretRef.secretId === ref.secretId && saved.data.secretRef.configPath === ref.configPath) {
    // A replay has no provider work/token mint and no second durable event.
    // It still rechecks the current H, classifier and exact source under locks.
    return db.transaction(async tx => {
      await responsibleHuman(tx, input.companyId, input.userId, true);
      const [current] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, source.id))).for("update");
      await assertNotManagerApp(tx, { companyId: input.companyId, refs: source.credentialSecretRefs, appId: config.appId, verifiedAppId: saved.data.appId, requireConfigured: true });
      if (!current || current.status !== source.status || !isDeepStrictEqual(current.config, source.config) || !isDeepStrictEqual(current.credentialSecretRefs, source.credentialSecretRefs)) {
        throw conflict("The project App changed during replay", { code: "project_app_approval_state_changed" });
      }
      return saved.data;
    });
  }
  let proposed: ProjectAppApproval | undefined;
  if (input.action === "approve") {
    const secret = await resolveConnectionGrantSecret(db, source, grant, ref, { actorType: "user", actorId: input.userId, consumerType: "tool_connection", consumerId: source.id });
    let result;
    try { result = await approvalClient.acquire(`${input.companyId}:${source.id}:approval:${secret.latestVersion}`, config, secret.value, true); }
    catch { throw new HttpError(503, "GitHub could not verify the project App approval. Retry after provider recovery.", { code: "project_app_verification_unavailable" }); }
    await assertNotManagerApp(db, { companyId: input.companyId, refs: source.credentialSecretRefs, verifiedAppId: result.verifiedRegistrationId, requireConfigured: true });
    proposed = receiptSchema.parse({ version: 1, id: randomUUID(), companyId: input.companyId, humanUserId: input.userId, projectId: input.projectId,
      appId: result.verifiedRegistrationId, installationId: config.installationId, repositoryIds: sorted((result.github.repositories ?? []).map(repo => Number(repo.id))),
      secretRef: { secretId: ref.secretId, configPath: ref.configPath }, verifiedAt: new Date(Date.now()).toISOString(), revokedAt: null });
  }
  const result = await db.transaction(async tx => {
    await responsibleHuman(tx, input.companyId, input.userId, true);
    const [current] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, source.id))).for("update");
    const [currentProject] = await tx.select().from(projects).where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId))).for("share");
    const [currentGrant] = await tx.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.id, grant.id))).for("share");
    const currentKey = await validateConnectionGrantSecretOwnership(tx, source, grant, ref);
    const currentManager = await assertNotManagerApp(tx, { companyId: input.companyId, refs: source.credentialSecretRefs, appId: config.appId, verifiedAppId: proposed?.appId, requireConfigured: true });
    if (!current || !currentProject || currentProject.archivedAt || !currentGrant || currentGrant.status !== "active"
      || !isDeepStrictEqual(currentGrant.credentialSecretRefs, grant.credentialSecretRefs)
      || !isDeepStrictEqual(currentManager, manager) || currentKey.latestVersion !== keyState.latestVersion || currentKey.status !== "active" || currentKey.deletedAt
      || !isDeepStrictEqual(current.config, source.config) || !isDeepStrictEqual(current.credentialSecretRefs, source.credentialSecretRefs) || current.status !== source.status) {
      throw conflict("The project App changed during verification. Retry against its current state.", { code: "project_app_approval_state_changed" });
    }
    const old = receiptSchema.safeParse(current.config[PROJECT_APP_APPROVAL_FIELD]);
    let next: ProjectAppApproval;
    if (input.action === "revoke") {
      if (!old.success || old.data.projectId !== input.projectId) throw unavailable();
      if (old.data.revokedAt) return { receipt: old.data, publication: null };
      next = { ...old.data, revokedAt: new Date(Date.now()).toISOString() };
    } else {
      next = proposed!;
      // Exact same live approval is a replay, not a second receipt/activity.
      if (old.success && !old.data.revokedAt && old.data.humanUserId === next.humanUserId
        && old.data.projectId === next.projectId && old.data.appId === next.appId && old.data.installationId === next.installationId
        && isDeepStrictEqual(old.data.repositoryIds, next.repositoryIds) && isDeepStrictEqual(old.data.secretRef, next.secretRef)) return { receipt: old.data, publication: null };
    }
    const nextConfig = { ...current.config, [PROJECT_APP_APPROVAL_FIELD]: next };
    await tx.update(toolConnections).set({ config: nextConfig, transportConfig: { ...current.transportConfig, [PROJECT_APP_APPROVAL_FIELD]: next }, updatedAt: new Date() })
      .where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, current.id)));
    const { publication } = await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.userId,
      responsibleUserIdOverride: input.userId, action: input.action === "approve" ? "tool_connection.project_app_approved" : "tool_connection.project_app_revoked",
      entityType: "tool_connection", entityId: source.id,
      details: { receiptId: next.id, companyId: next.companyId, projectId: next.projectId, humanUserId: next.humanUserId, appId: next.appId,
        installationId: next.installationId, repositoryIds: next.repositoryIds, secretId: next.secretRef.secretId },
    });
    return { receipt: next, publication };
  });
  invalidateGitHubAppInstallation(config.installationId);
  // Durable approval must not be reported as failed because realtime is offline.
  if (result.publication) { try { publishActivity(result.publication); } catch { /* persisted activity is authoritative */ } }
  return result.receipt;
}

/** Verify an exact vault reference even on the ordinary create path: a Client
 * ID alias must not reserve or export the numeric manager App. Values remain
 * internal to the existing App client; only normalized provider facts leave. */
export async function verifyGitHubAppCandidate(db: Db, input: { companyId: string; config: Record<string, unknown>; refs: readonly Ref[]; namespace: string; actorId?: string; projectId?: string }) {
  const app = parseGitHubAppConfig(input.config.methodConfig);
  await assertNotManagerApp(db, { companyId: input.companyId, refs: input.refs, appId: app.appId, requireConfigured: input.projectId != null });
  const ref = input.refs[0];
  if (input.refs.length !== 1 || !ref || ref.configPath !== "credentials.privateKey") throw unavailable();
  const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, ref.secretId)));
  if (!secret || (input.projectId != null && secret.scope !== "company") || secret.status !== "active" || secret.deletedAt) throw unavailable();
  const version = ref.versionSelector ?? "latest";
  const privateKey = await secretService(db).resolveSecretValue(input.companyId, ref.secretId, version, {
    accessContext: { actorType: "system", actorId: input.actorId, consumerType: "system", consumerId: "project-app-reference-verification" },
  });
  let result: Awaited<ReturnType<typeof approvalClient.acquire>>;
  try {
    result = await approvalClient.acquire(`${input.companyId}:${input.namespace}:${ref.secretId}:${secret.latestVersion}:${version}`, app, privateKey, true);
  } catch (error) {
    if (input.projectId != null) throw new HttpError(503,
      "GitHub project App verification is unavailable. No connection was created.", { code: "project_app_verification_unavailable" });
    throw error;
  }
  const registrationId = positiveId.safeParse(result.verifiedRegistrationId);
  const ids = repoIds.safeParse((result.github.repositories ?? []).map(repo => Number(repo.id)));
  if (!registrationId.success || !ids.success || result.github.installationIds?.length !== 1 || result.github.installationIds[0] !== app.installationId) throw unavailable();
  const verified: VerifiedProjectConnectionProviderScope = { identity: { companyId: input.companyId, providerHost: "github.com", verifiedRegistrationId: registrationId.data,
    canonicalInstallationKey: `github.com/github-app-installation/${app.installationId}` }, repositoryIds: sorted(ids.data), secretVersion: typeof version === "number" ? version : secret.latestVersion };
  await assertNotManagerApp(db, { companyId: input.companyId, refs: input.refs, verifiedAppId: verified.identity.verifiedRegistrationId, requireConfigured: input.projectId != null });
  return { verified, providerTenant: { github: result.github }, secretVersion: secret.latestVersion };
}

/** Reference-only first-bind preflight. Nothing is written/reserved until H's
 * receipt AND provider facts agree. Repeated DB reader checks fence lock waits. */
export async function prepareProjectAppFirstBind(db: Db, input: { companyId: string; projectId: string; config: Record<string, unknown>; refs: readonly Ref[]; exclusive: boolean; actorId: string; repositoryIds: readonly number[] }) {
  const { verified, providerTenant, secretVersion } = await verifyGitHubAppCandidate(db, { ...input, namespace: `custody-first-bind:${input.projectId}` });
  const ref = input.refs[0]!;
  if (!isDeepStrictEqual(sorted(input.repositoryIds), sorted(verified.repositoryIds))) throw unavailable();
  const custody = await readProjectAppCustody(db, { ...input, registrationId: verified.identity.verifiedRegistrationId, repositoryIds: verified.repositoryIds });
  const [project] = await db.select().from(projects).where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)));
  const [preference] = await db.select().from(userCompanyPreferences).where(and(eq(userCompanyPreferences.companyId, input.companyId), eq(userCompanyPreferences.userId, custody.receipt.humanUserId)));
  if (!project?.leadAgentId || preference?.primaryAgentId !== input.actorId) throw unavailable();
  const scope: ProjectConnectionScope = { version: 1, installationKey: verified.identity.canonicalInstallationKey, registrationId: verified.identity.verifiedRegistrationId,
    exclusive: input.exclusive, approvedLeadAgentId: project.leadAgentId, approvedByAgentId: input.actorId, responsibleUserId: custody.receipt.humanUserId,
    approvedRepositoryIds: [...verified.repositoryIds], approvedSecretRefs: [{ secretId: ref.secretId, configPath: ref.configPath }] };
  return { custody, verified, providerTenant, config: { ...input.config, projectScope: scope, [PROJECT_APP_APPROVAL_SOURCE]: custody.sourceConnectionId }, secretVersion };
}

/** RFL 04:5xZ: the receipt-citing first bind CONSUMES its source S,
 * make-before-break, inside the create transaction. S is archived (never
 * deleted) and linked to its consumer; the receipt and credential binding stay
 * readable for audit. Any failure in the caller's transaction leaves S live,
 * still reserved, and the receipt unconsumed. */
export async function consumeProjectAppApproval(tx: Database, input: {
  companyId: string; projectId: string; sourceConnectionId: string; receiptId: string; connectionId: string;
  actorType: "agent" | "user" | "system"; actorId: string;
}) {
  const [source] = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, input.sourceConnectionId))).for("update");
  const parsed = receiptSchema.safeParse(source?.config[PROJECT_APP_APPROVAL_FIELD]);
  if (!source || source.projectId !== null || !parsed.success || parsed.data.id !== input.receiptId || parsed.data.projectId !== input.projectId) throw unavailable();
  if (source.config[PROJECT_APP_APPROVAL_CONSUMED_BY] !== undefined || source.status === "archived") throw consumed();
  const config = { ...source.config, [PROJECT_APP_APPROVAL_CONSUMED_BY]: input.connectionId };
  const transportConfig = { ...source.transportConfig, [PROJECT_APP_APPROVAL_CONSUMED_BY]: input.connectionId };
  await tx.update(toolConnections).set({ status: "archived", enabled: false, config, transportConfig, updatedAt: new Date() })
    .where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, source.id)));
  await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: input.actorType, actorId: input.actorId,
    action: "tool_connection.project_app_approval_consumed", entityType: "tool_connection", entityId: source.id,
    details: { receiptId: input.receiptId, projectId: input.projectId, connectionId: input.connectionId, previousStatus: source.status } });
}
