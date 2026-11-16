import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import {
  agents, authUsers, companies, companyMemberships, companySecrets, connectionGrants,
  heartbeatRuns, issues, principalPermissionGrants, projects, projectWorkspaces,
  toolApplications, toolConnectionInstalls, toolConnections, userCompanyPreferences,
  type Db,
} from "@paperclipai/db";
import type { CreateToolConnection } from "@paperclipai/shared";
import { toolAccessService } from "../../services/tool-access.js";
import { toolAccessRoutes } from "../../routes/tool-access.js";
import { projectRoutes } from "../../routes/projects.js";
import { errorHandler } from "../../middleware/index.js";
import type { ActorInfo } from "../../services/tool-access/types.js";
import { connectionManagementService } from "../../services/connection-management.js";
import { ensureHumanRoleDefaultGrants } from "../../services/principal-access-compatibility.js";
import { captureProjectConnectionRunContext } from "../../services/project-connection-run-context.js";
import { lockProjectConnectionLifecycle } from "../../services/project-connection-retirement.js";

// Type-only forward contract: BASE deliberately has no projectId in these types.
// No missing runtime module, fake implementation, or test-only database DDL.
export type OwnedConnectionInput = CreateToolConnection & { projectId: string | null; exclusive?: boolean };
export type OwnedConnectionRow = typeof toolConnections.$inferInsert & { projectId: string | null };
export const INSTALLATION = "github.com/github-app-installation/456";
export const CANARY = "synthetic-project-key-never-return-this";

export async function projectConnectionFixture(db: Db, sharedLead = false) {
  const companyId = randomUUID();
  const human = `owner-${companyId}`;
  await db.insert(companies).values({ id: companyId, name: "Project connection RED", issuePrefix: companyId.slice(0, 8), defaultResponsibleUserId: human });
  const addAgent = async (name: string, reportsTo?: string) => {
    const [agent] = await db.insert(agents).values({ companyId, name, role: "engineer", adapterType: "process", status: "active", reportsTo }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, membershipRole: "member", status: "active" });
    await db.insert(principalPermissionGrants).values(["tools:manage_connections", "tools:manage_profiles", "agents:configure", "agents:hire", "projects:manage"].map(permissionKey => ({ companyId, principalType: "agent", principalId: agent!.id, permissionKey })));
    return agent!;
  };
  const primary = await addAgent("H primary");
  const leadA = await addAgent("A lead", primary.id);
  const leadB = sharedLead ? leadA : await addAgent("B lead", primary.id);
  const worker = await addAgent("A worker", leadA.id);
  const outsider = await addAgent("Outside worker", leadB.id);
  await db.insert(authUsers).values({ id: human, name: "Project connection owner fixture", email: `${companyId}@project-fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: human, membershipRole: "owner", status: "active" });
  await ensureHumanRoleDefaultGrants(db, { companyId, principalId: human, membershipRole: "owner", grantedByUserId: human });
  await db.insert(userCompanyPreferences).values({ companyId, userId: human, primaryAgentId: primary.id });
  const addProject = async (name: string, leadAgentId: string, repoId: number) => {
    const [project] = await db.insert(projects).values({ companyId, name, leadAgentId }).returning();
    await db.insert(projectWorkspaces).values({ companyId, projectId: project!.id, name: `${name} repository`, repoUrl: `https://github.com/owner/${name}.git`, metadata: { githubRepositoryId: repoId } });
    return project!;
  };
  const a = await addProject("A", leadA.id, 101);
  const b = await addProject("B", leadB.id, 202);
  const [secret] = await db.insert(companySecrets).values({ companyId, key: `pool-${companyId}`, name: "Synthetic pool reference", scope: "company" }).returning();
  const scope = (project = a, exclusive = false) => ({
    version: 1, installationKey: INSTALLATION, registrationId: "123", exclusive,
    approvedLeadAgentId: project.leadAgentId, approvedByAgentId: primary.id,
    responsibleUserId: human, approvedRepositoryIds: [project.id === a.id ? 101 : 202],
    approvedSecretRefs: [{ secretId: secret!.id, configPath: "credentials.privateKey" }],
  });
  const config = (project = a, exclusive = false) => ({
    sourceTemplateKey: "github", connectionMethodKey: "app-installation",
    methodConfig: { version: 1, appId: "123", installationId: "456", repositories: `owner/${project.name}`, permissionProfile: "author" },
    projectScope: scope(project, exclusive),
  });
  const actor = (agentId = primary.id): ActorInfo => ({ actorType: "agent", actorId: agentId, responsibleUserId: human });
  const management = (connectionId: string, agentId = primary.id) => connectionManagementService(db).authorize(
    { type: "agent", companyId, agentId, source: "agent_key", onBehalfOfUserId: human },
    "connections:configure", { type: "connection_management", companyId, connectionId, operation: "PATCH /tool-connections/:connectionId" },
  );
  const input = (project = a, overrides: Partial<OwnedConnectionInput> = {}): OwnedConnectionInput => {
    const { projectScope, ...proposedConfig } = overrides.config ?? config(project);
    // A create asks for a mode; it never submits the saved approval envelope.
    // Only the seeded server-owned rows above/below carry projectScope.
    const requestedExclusive = (projectScope as { exclusive?: boolean } | undefined)?.exclusive === true;
    return {
      projectId: project.id, name: `Project ${project.name} ${randomUUID()}`, transport: "rest_api",
      connectionPurpose: "tool", ownership: "customer", connectionKind: "managed", authKind: "none",
      status: "draft", enabled: false, credentialPolicy: "shared",
      credentialSecretRefs: [{ secretId: secret!.id, configPath: "credentials.privateKey", versionSelector: "latest", required: true }],
      ...overrides, config: proposedConfig, ...(requestedExclusive ? { exclusive: true } : {}),
    };
  };
  const seedConnection = async (project: typeof a | null = a, options: { exclusive?: boolean; status?: "draft" | "active" | "disabled" | "archived"; installed?: boolean; pending?: boolean; legacyId?: string; installationKey?: string } = {}) => {
    const [app] = await db.insert(toolApplications).values({ companyId, name: randomUUID(), type: "rest_api" }).returning();
    const c = config(project ?? a, options.exclusive);
    const projectScope = { ...c.projectScope, installationKey: options.installationKey ?? INSTALLATION,
      ...(options.pending ? { migrationPending: true, legacyConnectionId: options.legacyId } : {}) };
    const row: OwnedConnectionRow = {
      companyId, applicationId: app!.id, name: randomUUID(), uid: randomUUID(), projectId: project?.id ?? null,
      transport: "rest_api", authKind: "none", credentialPolicy: "shared", status: options.status ?? "active",
      enabled: (options.status ?? "active") === "active", config: { ...c, ...(project ? { projectScope } : { projectScope: undefined }) },
      credentialSecretRefs: [{ secretId: secret!.id, configPath: "credentials.privateKey", versionSelector: "latest" }], createdByUserId: human,
    };
    // Drizzle ignores unknown insert keys on BASE. After migration the exact same
    // fixture persists the column. That absence is recorded, not papered over.
    const [connection] = await db.insert(toolConnections).values(row).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId, connectionId: connection!.id, kind: "organization", status: "active", isDefault: true,
      credentialSecretRefs: row.credentialSecretRefs,
      providerTenant: { github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] } },
    }).returning();
    if (options.installed !== false) await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "agent", targetId: leadA.id });
    return { connection: connection!, grant: grant! };
  };
  const run = async (project: typeof a | null = a, agentId = leadA.id, snapshot: Record<string, unknown> = {}) => db.transaction(async tx => {
    const [issue] = await tx.insert(issues).values({ companyId, title: "Project-scoped work", assigneeAgentId: agentId, projectId: project?.id ?? null, responsibleUserId: human }).returning();
    if (issue!.projectId) await lockProjectConnectionLifecycle(tx, { companyId, projectId: issue!.projectId });
    const { projectConnectionRunContext: _callerPair, ...hints } = snapshot;
    const [heartbeat] = await tx.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id, status: "running", contextSnapshot: { issueId: issue!.id, projectId: project?.id ?? null, ...hints } }).returning();
    // Model real queue admission, never lazy credential-use capture or a pair
    // taken from optional caller snapshot hints. No assertion is relaxed.
    await captureProjectConnectionRunContext(tx, { companyId, agentId, heartbeatRunId: heartbeat!.id });
    const [admitted] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeat!.id));
    return { issue: issue!, run: admitted! };
  });
  const route = (who: "board" | string = "board") => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = who === "board" ? { type: "board", userId: human, userName: "H", userEmail: null, isInstanceAdmin: false, source: "session", sessionId: companyId, companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }] }
        : { type: "agent", companyId, agentId: who, source: "agent_key", onBehalfOfUserId: human, onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] };
      next();
    });
    app.use("/api", toolAccessRoutes(db)); app.use("/api", projectRoutes(db)); app.use(errorHandler); return app;
  };
  return { companyId, human, primary, leadA, leadB, worker, outsider, a, b, secret: secret!, scope, config, input, actor, management, seedConnection, run, route, service: toolAccessService(db), addAgent };
}

export async function storedConnection(db: Db, id: string) {
  return (await db.select().from(toolConnections).where(eq(toolConnections.id, id)))[0]!;
}
