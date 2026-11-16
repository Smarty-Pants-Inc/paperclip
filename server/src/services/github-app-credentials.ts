import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { connectionGrants, toolConnections, toolConnectionInstalls, projectWorkspaces, type Db } from "@paperclipai/db";
import { resolveConnectionGrantSecret, validateConnectionGrantSecretOwnership } from "./connection-credentials.js";
import { HttpError, unprocessable } from "../errors.js";
import { assertNotManagerApp, projectAppManagerConfigured, readProjectAppCustody } from "./project-app-custody.js";
import { assertProjectConnectionAdmission, readProjectConnectionScope } from "./project-connection-admission.js";
import { createGitHubAppClient, GITHUB_APP_KEY_PATH, isGitHubAppConnection, parseGitHubAppConfig, githubAppFailure, rethrowGitHubAppFailure } from "./github-app-client.js";

export { isGitHubAppConnection, parseGitHubAppConfig } from "./github-app-client.js";
type Connection = typeof toolConnections.$inferSelect;
type Grant = typeof connectionGrants.$inferSelect;
const client = createGitHubAppClient();
// Project provider verdicts must not inherit the ordinary five-minute token
// lifetime. The existing client still supplies JWT, scope and HTTP validation.
const projectClient = createGitHubAppClient(fetch, Date.now, 60_000);

function matchesOwnership(connection: Connection, grant: Grant) {
  return connection.credentialPolicy === "per_user"
    ? grant.kind === "user" && Boolean(grant.subjectUserId)
    : connection.credentialPolicy === "per_agent"
      ? grant.kind === "agent" && Boolean(grant.subjectAgentId)
      : grant.kind === "organization";
}

export async function getGitHubAppGrant(db: Db, connection: Connection, options: { forReconnect?: boolean } = {}): Promise<Grant & { updatedAtVersion: string }> {
  const snapshots = await db.select({
    grant: connectionGrants,
    updatedAtVersion: sql<string>`${connectionGrants.updatedAt}::text`,
  }).from(connectionGrants).where(and(
    eq(connectionGrants.companyId, connection.companyId),
    eq(connectionGrants.connectionId, connection.id),
    options.forReconnect ? undefined : eq(connectionGrants.status, "active"),
  ));
  const active = snapshots.filter(snapshot => snapshot.grant.status === "active");
  const grants = active.length > 0 ? active : snapshots;
  const snapshot = grants[0];
  const grant = snapshot?.grant;
  if (grants.length !== 1 || !grant || !matchesOwnership(connection, grant)) {
    throw unprocessable("Reconnect the GitHub App identity.");
  }
  return { ...grant, updatedAtVersion: snapshot!.updatedAtVersion };
}

export async function resolveGitHubAppCredential(db: Db, connection: Connection, grant: Grant, allowDraft = false, force = false, agentId?: string | null) {
  const valid = async (verifiedAppId?: string) => {
    const [c] = await db.select({ ...getTableColumns(toolConnections), hasProjectAppManager: projectAppManagerConfigured(toolConnections.companyId) })
      .from(toolConnections).where(and(eq(toolConnections.companyId, connection.companyId), eq(toolConnections.id, connection.id)));
    const [g] = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.id, grant.id)));
    if (!c || !g || !isGitHubAppConnection(c) || g.connectionId !== c.id || !matchesOwnership(c, g) || g.kind !== grant.kind || g.subjectUserId !== grant.subjectUserId
      || c.projectId !== connection.projectId || c.credentialPolicy !== connection.credentialPolicy || g.subjectAgentId !== grant.subjectAgentId || g.status !== "active" || (allowDraft ? c.status !== "draft" : (!c.enabled || c.status !== "active"))
      || JSON.stringify(c.config) !== JSON.stringify(connection.config)
      || JSON.stringify(c.credentialSecretRefs) !== JSON.stringify(connection.credentialSecretRefs)
      || JSON.stringify(g.credentialSecretRefs) !== JSON.stringify(grant.credentialSecretRefs)) githubAppFailure();
    if (c.projectId || c.hasProjectAppManager) await assertNotManagerApp(db, { companyId: c.companyId, refs: g.credentialSecretRefs,
      appId: parseGitHubAppConfig(c.config.methodConfig).appId, verifiedAppId, requireConfigured: c.projectId != null });
    if (c.projectId) {
      const scope = readProjectConnectionScope(c);
      const config = parseGitHubAppConfig(c.config.methodConfig);
      if (!scope || c.credentialPolicy !== "shared" || g.kind !== "organization"
        || scope.installationKey !== `github.com/github-app-installation/${config.installationId}`
        || (!config.appId.startsWith("Iv") && config.appId !== scope.registrationId)
        || g.credentialSecretRefs.length !== 1 || c.credentialSecretRefs.length !== 1
        || c.credentialSecretRefs[0]?.secretId !== g.credentialSecretRefs[0]?.secretId
        || (c.credentialSecretRefs[0]?.versionSelector ?? "latest") !== (g.credentialSecretRefs[0]?.versionSelector ?? "latest")
        || g.credentialSecretRefs.some(ref => ref.configPath !== GITHUB_APP_KEY_PATH
          || !scope.approvedSecretRefs.some(approved => approved.secretId === ref.secretId && approved.configPath === ref.configPath))
        || c.credentialSecretRefs.some(ref => ref.configPath !== GITHUB_APP_KEY_PATH
          || !scope.approvedSecretRefs.some(approved => approved.secretId === ref.secretId && approved.configPath === ref.configPath))
        || (!allowDraft && scope.migrationPending)) githubAppFailure();
      // Actorless use cannot manufacture management authority; B validates current
      // approval and recipient reach, while existing finish writers own management.
      await assertProjectConnectionAdmission(db, { companyId: c.companyId, projectId: c.projectId, operation: "use", connection: c,
        targetAgentIds: agentId ? [agentId] : [], proposedSecretRefs: g.credentialSecretRefs });
    }
    if (!allowDraft) {
      const installs = await db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, c.companyId), eq(toolConnectionInstalls.connectionId, c.id)));
      const targetAgentId = agentId ?? (g.kind === "agent" ? g.subjectAgentId : null);
      if (!installs.some(install =>
        (install.targetType === "company" && install.targetId === c.companyId)
        || (install.targetType === "agent" && (!targetAgentId || install.targetId === targetAgentId))
      )) githubAppFailure();
    }
    return { c, g };
  };
  try {
    // The initial saved-scope check shares the provider boundary's existing
    // value-free failure contract, just like post-I/O and cache validation.
    const { c, g } = await valid();
    const ref = g.credentialSecretRefs.find(r => r.configPath === GITHUB_APP_KEY_PATH);
    if (!ref) githubAppFailure();
    const secret = await resolveConnectionGrantSecret(db, c, g, ref, { actorType: "system", actorId: g.subjectAgentId ?? undefined, consumerType: "tool_connection", consumerId: c.id });
    const result = await (c.projectId ? projectClient : client).acquire(`${c.companyId}:${c.id}:${g.id}:${secret.latestVersion}`, parseGitHubAppConfig(c.config.methodConfig), secret.value, force);
    await valid(result.verifiedRegistrationId);
    if (c.projectId) {
      const currentKey = await validateConnectionGrantSecretOwnership(db, c, g, ref);
      if (currentKey.latestVersion !== secret.latestVersion) githubAppFailure();
      const scope = readProjectConnectionScope(c);
      const config = parseGitHubAppConfig(c.config.methodConfig);
      const repositories = result.github.repositories ?? [];
      const ids = repositories.map(repo => Number(repo.id));
      const workspaces = await db.select({ repoUrl: projectWorkspaces.repoUrl, metadata: projectWorkspaces.metadata }).from(projectWorkspaces).where(and(
        eq(projectWorkspaces.companyId, c.companyId), eq(projectWorkspaces.projectId, c.projectId),
      ));
      const requestedIds = config.repositories.map(name => {
        const matches = workspaces.filter(workspace => {
          const url = workspace.repoUrl?.replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();
          return url === `https://github.com/${name}`;
        });
        const values = [...new Set(matches.map(w => Number(w.metadata?.githubRepositoryId)))];
        return values.length === 1 ? values[0] : undefined;
      });
      if (!scope || !ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || !scope.approvedRepositoryIds.includes(id))
        || new Set(ids).size !== ids.length || ids.length !== requestedIds.length
        || requestedIds.some(id => id === undefined || !ids.includes(id))
        || repositories.some(repo => repo.installationId !== config.installationId || !config.repositories.includes(repo.fullName.toLowerCase()))
        || (result.verifiedRegistrationId !== undefined && result.verifiedRegistrationId !== scope.registrationId)
        || result.github.installationIds?.length !== 1 || result.github.installationIds[0] !== config.installationId) githubAppFailure("repositories");
      await readProjectAppCustody(db, { companyId: c.companyId, projectId: c.projectId, config: c.config,
        refs: g.credentialSecretRefs, registrationId: result.verifiedRegistrationId, repositoryIds: ids });
      await assertProjectConnectionAdmission(db, { companyId: c.companyId, projectId: c.projectId, operation: "use", connection: c,
        targetAgentIds: agentId ? [agentId] : [], proposedSecretRefs: g.credentialSecretRefs, proposedRepositoryIds: ids });
      await valid(result.verifiedRegistrationId);
    }
    return result;
  } catch (error) {
    const code = error instanceof HttpError ? (error.details as { code?: unknown } | undefined)?.code : undefined;
    if (typeof code === "string" && code.startsWith("project_app_")) throw error;
    if (connection.projectId && code === "github_app_access_unavailable") throw new HttpError(503,
      "GitHub project App verification is unavailable. No credential was released.", { code: "project_app_verification_unavailable" });
    rethrowGitHubAppFailure(error);
  }
}

export async function refreshGitHubAppAccess(db: Db, connection: Connection, force = false) {
  const grant = await getGitHubAppGrant(db, connection);
  const result = await resolveGitHubAppCredential(db, connection, grant, connection.status === "draft", force);
  await db.update(connectionGrants).set({ providerTenant: { github: result.github } }).where(and(
    eq(connectionGrants.id, grant.id), eq(connectionGrants.companyId, connection.companyId),
    eq(connectionGrants.status, "active"),
    sql`${connectionGrants.updatedAt} = ${grant.updatedAtVersion}::timestamptz`,
  ));
  return result;
}
