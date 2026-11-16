import { and, eq } from "drizzle-orm";
import {
  agents, companies, companyMemberships, companySecrets, connectionGrants,
  projects, projectWorkspaces, toolConnections, userCompanyPreferences,
  type Db,
} from "@paperclipai/db";
import { isDeepStrictEqual } from "node:util";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { ActorInfo, DbTransaction } from "./tool-access/types.js";
import { isGitHubAppConnection, parseGitHubAppConfig } from "./github-app-client.js";
import { connectionManagementService } from "./connection-management.js";

/** Server-written approval. A request's projectScope is never an authority source. */
export type ProjectConnectionScope = Readonly<{
  version: 1;
  installationKey: string;
  registrationId: string;
  exclusive: boolean;
  approvedLeadAgentId: string;
  approvedByAgentId: string;
  responsibleUserId: string;
  approvedRepositoryIds: readonly number[];
  approvedSecretRefs: readonly Readonly<{ secretId: string; configPath: string }>[];
  migrationPending?: boolean;
  legacyConnectionId?: string;
}>;

type Connection = typeof toolConnections.$inferSelect;
type Database = Db | DbTransaction;
export type ProjectConnectionOperation = "create" | "finish" | "install" | "update" | "disable" | "retire" | "use" | "project_update" | "reconnect";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const repositoryIds = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.length <= 500
  && v.every(id => Number.isSafeInteger(id) && id > 0) && new Set(v).size === v.length;
const malformed = () => conflict("This project's connection has invalid saved approval metadata. It cannot be used or repaired by replacing its config.", { code: "project_connection_scope_invalid" });

/** Parse/version-check the protected envelope; malformed owned rows fail closed. */
export function readProjectConnectionScope(connection: Pick<Connection, "projectId" | "config">): ProjectConnectionScope | null {
  const config = connection.config;
  if (connection.projectId == null) {
    if (config && Object.hasOwn(config, "projectScope") && config.projectScope != null) throw malformed();
    return null;
  }
  const s = config?.projectScope;
  if (!uuid.test(connection.projectId) || !record(s) || s.version !== 1
    || typeof s.installationKey !== "string" || !/^github\.com\/github-app-installation\/[1-9]\d*$/.test(s.installationKey)
    || typeof s.registrationId !== "string" || !/^[1-9]\d*$/.test(s.registrationId)
    || typeof s.exclusive !== "boolean" || typeof s.approvedLeadAgentId !== "string" || !uuid.test(s.approvedLeadAgentId)
    || typeof s.approvedByAgentId !== "string" || !uuid.test(s.approvedByAgentId)
    || typeof s.responsibleUserId !== "string" || !s.responsibleUserId.trim()
    || !repositoryIds(s.approvedRepositoryIds) || !Array.isArray(s.approvedSecretRefs) || s.approvedSecretRefs.length !== 1
    || !s.approvedSecretRefs.every(ref => record(ref) && typeof ref.secretId === "string" && uuid.test(ref.secretId) && ref.configPath === "credentials.privateKey")
    || (s.migrationPending !== undefined && typeof s.migrationPending !== "boolean")
    || (s.legacyConnectionId !== undefined && (typeof s.legacyConnectionId !== "string" || !uuid.test(s.legacyConnectionId)))
    || (s.migrationPending === true && !s.legacyConnectionId)
    || (Object.hasOwn(s, "managerApp"))) throw malformed();
  // Copy arrays so a consumer cannot modify a previously checked DB snapshot.
  return { version: 1, installationKey: s.installationKey, registrationId: s.registrationId, exclusive: s.exclusive,
    approvedLeadAgentId: s.approvedLeadAgentId, approvedByAgentId: s.approvedByAgentId, responsibleUserId: s.responsibleUserId,
    approvedRepositoryIds: [...s.approvedRepositoryIds], approvedSecretRefs: s.approvedSecretRefs.map(ref => ({ secretId: ref.secretId as string, configPath: ref.configPath as string })),
    ...(s.migrationPending !== undefined ? { migrationPending: s.migrationPending } : {}),
    ...(s.legacyConnectionId !== undefined ? { legacyConnectionId: s.legacyConnectionId } : {}),
  };
}

export function assertProjectConnectionSupported(connection: Pick<Connection, "projectId" | "connectionPurpose" | "transport" | "config" | "credentialPolicy" | "credentialSource" | "externalCredential" | "credentialRefs" | "credentialSecretRefs">) {
  if (connection.projectId == null) return;
  if (connection.connectionPurpose !== "tool" || !isGitHubAppConnection(connection)
    || !["rest_api", "mcp_remote"].includes(connection.transport) || connection.credentialPolicy !== "shared"
    || connection.credentialSource !== "paperclip_vault" || connection.externalCredential
    || connection.credentialRefs.length || connection.credentialSecretRefs.length !== 1
    || connection.credentialSecretRefs[0]?.configPath !== "credentials.privateKey") {
    throw unprocessable("Project ownership is supported only for a shared GitHub App TOOL connection with one approved vault key.", { code: "project_connection_provider_unsupported" });
  }
}

export function projectConnectionActor(managementContext?: ActorInfo["managementContext"]): ActorInfo | undefined {
  if (!managementContext) return undefined;
  return { managementContext, responsibleUserId: managementContext.responsibleUserId,
    actorType: managementContext.actor.type === "agent" ? "agent" : "user",
    actorId: managementContext.actor.type === "agent" ? managementContext.actor.agentId : managementContext.actor.userId,
    authenticatedActorType: managementContext.actor.type === "agent" ? "agent" : "board" };
}

async function currentAuthority(db: Database, companyId: string, projectId: string) {
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)));
  if (!project) throw notFound("Project not found");
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const human = company?.defaultResponsibleUserId;
  const [membership] = human ? await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
    eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, human), eq(companyMemberships.status, "active"))) : [];
  const [preference] = human ? await db.select().from(userCompanyPreferences).where(and(eq(userCompanyPreferences.companyId, companyId), eq(userCompanyPreferences.userId, human))) : [];
  const [primary] = preference?.primaryAgentId ? await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, preference.primaryAgentId))) : [];
  const [primaryMembership] = primary ? await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
    eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, primary.id), eq(companyMemberships.status, "active"))) : [];
  return { project, human, primary: primary && primaryMembership && !["terminated", "paused", "pending_approval"].includes(primary.status)
    && membership && ["owner", "admin"].includes(membership.membershipRole ?? "") ? primary : undefined };
}

/** Final recipients must be explicit members of the lead's current reporting
 * subtree. Another distinct project's lead is a boundary, not an inherited team. */
export async function assertProjectConnectionRecipients(db: Database, companyId: string, projectId: string, leadId: string, ids: readonly string[]) {
  const roster = await db.select().from(agents).where(eq(agents.companyId, companyId));
  const memberships = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "agent"), eq(companyMemberships.status, "active")));
  const active = new Set(memberships.map(m => m.principalId));
  const otherProjects = await db.select({ id: projects.id, leadAgentId: projects.leadAgentId }).from(projects).where(eq(projects.companyId, companyId));
  const boundaries = new Set(otherProjects.filter(p => p.id !== projectId && p.leadAgentId !== leadId).map(p => p.leadAgentId));
  const byId = new Map(roster.map(a => [a.id, a]));
  for (const id of new Set(ids)) {
    let cursor = byId.get(id);
    const seen = new Set<string>();
    let allowed = false;
    while (cursor && !seen.has(cursor.id) && active.has(cursor.id) && !["terminated", "paused", "pending_approval"].includes(cursor.status)) {
      seen.add(cursor.id);
      if (cursor.id === leadId) { allowed = true; break; }
      if (boundaries.has(cursor.id)) break;
      cursor = cursor.reportsTo ? byId.get(cursor.reportsTo) : undefined;
    }
    if (!allowed) throw forbidden("Choose explicit recipients from this project's approved lead and current team.", { code: "project_connection_target_outside_project", projectId });
  }
}

/** Workspace metadata is editable by project workers. These IDs are only
 * current repository hints; every caller must intersect them with the saved
 * primary approval (never turn this result into approvedRepositoryIds). */
export async function projectConnectionRepositoryIds(db: Database, companyId: string, projectId: string, names?: readonly string[]): Promise<number[]> {
  const workspaces = await db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, projectId)));
  const saved = workspaces.flatMap(w => {
    const raw = w.metadata?.githubRepositoryId;
    const id = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    const name = w.repoUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?$/i)?.[1]?.toLowerCase();
    return Number.isSafeInteger(id) && id > 0 ? [{ id, name }] : [];
  });
  if (!names) return [...new Set(saved.map(r => r.id))];
  const ids = names.map(name => {
    const matches = saved.filter(r => r.name === name.toLowerCase());
    if (matches.length !== 1) throw forbidden("Every requested repository must have a saved stable GitHub ID in this project.", { code: "project_connection_repository_not_approved" });
    return matches[0]!.id;
  });
  if (!repositoryIds(ids)) throw forbidden("Project connections require a non-empty approved repository subset.", { code: "project_connection_repository_not_approved" });
  return ids;
}

/** Existing authorization remains necessary; callers run this on the actual
 * transaction after waits and after provider I/O, never as a route-only check. */
export async function assertProjectConnectionAdmission(
  db: Db | DbTransaction,
  input: Readonly<{
    companyId: string;
    projectId: string | null;
    operation: ProjectConnectionOperation;
    actor?: ActorInfo;
    connection?: Connection;
    targetAgentIds?: readonly string[];
    proposedSecretRefs?: readonly Readonly<{ secretId: string; configPath: string }>[];
    proposedRepositoryIds?: readonly number[];
  }>,
): Promise<void> {
  if (input.connection && (input.connection.companyId !== input.companyId || input.connection.projectId !== input.projectId)) throw notFound("Tool connection not found");
  if (input.projectId == null) {
    if (input.connection) readProjectConnectionScope(input.connection);
    return;
  }
  const { connection, actor, operation, companyId, projectId } = input;
  if (connection) assertProjectConnectionSupported(connection);
  const scope = connection ? readProjectConnectionScope(connection) : null;
  if (connection?.status === "archived" && operation !== "retire" && operation !== "project_update") {
    throw conflict("This project's connection was retired. Create a new approved project connection.", { code: "project_connection_archived" });
  }
  // This exception preserves ONLY a real board human's existing removal power.
  // It cannot be inferred from an agent's responsible-user or manager grant.
  const boardRemoval = ["retire", "disable"].includes(operation)
    && actor?.actorType === "user" && (actor.authenticatedActorType === "board" || actor.managementContext?.actor.type === "board");
  if (boardRemoval) {
    if (!actor.managementContext) throw forbidden("Removal requires the existing authenticated connection management authority", { code: "project_connection_actor_required" });
    await actor.managementContext.reauthorize();
    const userId = actor.managementContext.actor.userId;
    const [membership] = userId ? await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))) : [];
    if (!membership || membership.membershipRole === "viewer") throw forbidden("An active company manager is required");
    return;
  }
  const { project, human, primary } = await currentAuthority(db, companyId, projectId);
  const actorId = actor?.managementContext?.actor.type === "agent" ? actor.managementContext.actor.agentId : actor?.actorType === "agent" ? actor.actorId : null;
  const responsible = actor?.managementContext?.responsibleUserId ?? actor?.responsibleUserId;
  const actorRequired = () => forbidden(operation === "create" && !scope
    ? "Only the designated responsible human's active primary may approve this project's first binding."
    : "Only this project's approved lead or the company primary may manage its connection.", { code: "project_connection_actor_required", projectId,
      approvedLeadAgentId: scope?.approvedLeadAgentId ?? project.leadAgentId, primaryAgentId: primary?.id ?? null });
  if (!primary || !human || (scope && (scope.responsibleUserId !== human || scope.approvedByAgentId !== primary.id || scope.approvedLeadAgentId !== project.leadAgentId))) throw actorRequired();
  const [lead] = project.leadAgentId ? await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, project.leadAgentId))) : [];
  if (!lead || ["terminated", "paused", "pending_approval"].includes(lead.status)) throw actorRequired();
  if (operation !== "use") {
    if (!actorId || responsible !== human || (actorId !== primary.id && (!scope || actorId !== scope.approvedLeadAgentId))) throw actorRequired();
    const [acting] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, actorId)));
    const [membership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, actorId), eq(companyMemberships.status, "active")));
    if (!acting || !membership || ["terminated", "paused", "pending_approval"].includes(acting.status)) throw actorRequired();
    if (actor?.managementContext) await actor.managementContext.reauthorize();
    else await connectionManagementService(db as Db).authorize(
      { type: "agent", companyId, agentId: actorId, source: "agent_key", onBehalfOfUserId: human },
      "connections:configure", { type: "connection_management", companyId, ...(connection ? { connectionId: connection.id } : {}), operation: `project_connection:${operation}` },
      { targetAgentIds: [...(input.targetAgentIds ?? [])] },
    );
  } else if (!input.targetAgentIds?.length) throw forbidden("Project credential use requires an explicit server-derived recipient", { code: "project_connection_target_outside_project" });
  await assertProjectConnectionRecipients(db, companyId, projectId, lead.id, input.targetAgentIds ?? []);
  if (!scope) {
    // A new take must not launder a lead/worker's workspace edit into approval.
    // The primary's original server-written snapshot survives archive. Match
    // one approval, not a union of historical or other-project repository sets.
    // First binding (no history) still requires the trusted human handoff at
    // preflight; this preliminary evaluator cannot create that evidence.
    if (input.proposedRepositoryIds !== undefined) {
      const requested = input.proposedRepositoryIds;
      if (!repositoryIds(requested)) throw forbidden("Project connections require a non-empty approved repository subset", { code: "project_connection_repository_not_approved" });
      const retained = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.projectId, projectId)));
      const approvals = retained.map(row => readProjectConnectionScope(row)!);
      if (retained.length && !approvals.some(approval => approval.responsibleUserId === human
        && approval.approvedByAgentId === primary.id && approval.approvedLeadAgentId === lead.id
        && requested.every(id => approval.approvedRepositoryIds.includes(id)))) {
        throw forbidden("Workspace edits do not change this project's primary-ratified repository IDs. A new primary approval is required.", { code: "project_connection_repository_not_approved" });
      }
    }
    return;
  }
  if (operation === "install" && scope.migrationPending) throw conflict("Verify and finish this project candidate before installing it.", { code: "project_connection_migration_pending" });
  if (operation === "use" && (scope.migrationPending || connection!.status !== "active" || !connection!.enabled)) throw conflict("Verify and finish this active project candidate before using it.", { code: "project_connection_migration_pending" });
  const app = parseGitHubAppConfig(connection!.config.methodConfig);
  if (`github.com/github-app-installation/${app.installationId}` !== scope.installationKey
    || (/^[1-9]\d*$/.test(app.appId) && app.appId !== scope.registrationId)) throw malformed();
  const refs = input.proposedSecretRefs ?? connection!.credentialSecretRefs;
  if (refs.length !== 1 || !refs.every(r => scope.approvedSecretRefs.some(a => a.secretId === r.secretId && a.configPath === r.configPath))) {
    throw forbidden("This project's exact approved key reference and path must be preserved. Retire and retake to use a different key.", { code: "project_connection_reference_not_approved" });
  }
  for (const ref of refs) {
    const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId)));
    if (!secret || secret.scope !== "company" || secret.status !== "active" || secret.deletedAt) throw forbidden("The approved project reference is unavailable", { code: "project_connection_reference_not_approved" });
  }
  const savedIds = await projectConnectionRepositoryIds(db, companyId, projectId);
  const connectionRequested = await projectConnectionRepositoryIds(db, companyId, projectId, app.repositories);
  const requested = input.proposedRepositoryIds ?? connectionRequested;
  if (!repositoryIds(requested) || requested.length !== connectionRequested.length
    || !requested.every(id => connectionRequested.includes(id) && savedIds.includes(id) && scope.approvedRepositoryIds.includes(id))) {
    throw forbidden("The requested repository IDs must be a non-empty subset of this project's current primary approval.", { code: "project_connection_repository_not_approved" });
  }
  const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.connectionId, connection!.id)));
  if (grants.length !== 1 || grants[0]!.kind !== "organization" || !isDeepStrictEqual(grants[0]!.credentialSecretRefs.map(r => ({ secretId: r.secretId, configPath: r.configPath })), refs.map(r => ({ secretId: r.secretId, configPath: r.configPath })))) {
    throw forbidden("A project App requires exactly its approved organization authorization", { code: "project_connection_reference_not_approved" });
  }
  if (operation === "use" && grants[0]!.status !== "active") throw forbidden("This project's organization authorization is unavailable", { code: "project_connection_reference_not_approved" });
  const ids = grants[0]!.providerTenant?.github?.installationIds;
  if (!ids || ids.length !== 1 || `github.com/github-app-installation/${ids[0]}` !== scope.installationKey) throw forbidden("The authorization does not match the approved installation", { code: "project_connection_reference_not_approved" });
}

/** Request protection before normalization. Keep attempts visible rather than
 * silently dropping projectId, envelope fields, archive, or new ref IDs. */
export function assertProjectConnectionPatch(connection: Connection, input: Record<string, unknown>) {
  if (Object.hasOwn(input, "projectId") && input.projectId !== connection.projectId) throw conflict("A connection's project owner cannot be adopted, cleared or changed.", { code: "project_connection_owner_immutable" });
  if (!connection.projectId) {
    for (const key of ["config", "transportConfig"] as const) if (record(input[key]) && Object.hasOwn(input[key], "projectScope")) throw forbidden("Project approval metadata is server-written", { code: "project_connection_scope_protected" });
    return;
  }
  const scope = readProjectConnectionScope(connection)!;
  if (input.status === "archived") throw conflict("Use local retirement to archive this project's connection.", { code: "project_connection_retirement_required" });
  if (connection.status === "archived") throw conflict("This project's connection was retired. Create a new approved project connection.", { code: "project_connection_archived" });
  for (const key of ["config", "transportConfig"] as const) {
    if (input[key] === undefined) continue;
    const proposed = input[key];
    if (record(proposed) && record(proposed.projectScope) && !scope.exclusive && proposed.projectScope.exclusive === true) throw conflict("Live shared to EXCLUSIVE promotion is not supported. Create a new approved exclusive connection.", { code: "project_connection_exclusive_promotion_unsupported" });
    if (!isDeepStrictEqual(proposed, connection[key])) throw conflict("Project approval metadata and verified App configuration cannot be replaced or erased.", { code: "project_connection_scope_protected" });
  }
  if ((connection.status === "draft" || scope.migrationPending) && (input.enabled === true || input.status === "active")) {
    throw conflict("Verify and finish this project candidate before activating it. Generic PATCH cannot grant unverified access.", { code: "project_connection_verification_required" });
  }
  if (Object.hasOwn(input, "exclusive")) throw conflict("EXCLUSIVE is a create-only request", { code: "project_connection_exclusive_promotion_unsupported" });
  for (const key of ["credentialRefs", "credentialSecretRefs", "credentialPolicy", "transport", "connectionPurpose", "ownership", "connectionKind"] as const) {
    if (Object.hasOwn(input, key) && !isDeepStrictEqual(input[key], connection[key])) throw forbidden("This project's identity and approved key reference cannot change through PATCH", { code: "project_connection_reference_not_approved" });
  }
}

/** First binding cannot manufacture the human's GitHub clicks from provider
 * identity, delegated createdByUserId, labels, or caller-supplied JSON. The
 * trusted row-12 custody reader is an explicit integration prerequisite. */
export function requireProjectConnectionHumanHandoff(): never {
  throw forbidden("The designated human's existing App creation, installation and manager-key custody evidence is required before first binding.", { code: "project_connection_human_handoff_required" });
}
