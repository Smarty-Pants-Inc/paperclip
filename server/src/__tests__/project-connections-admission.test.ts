import { randomUUID } from "node:crypto";
import request from "supertest";
import { assertProjectConnectionAdmission } from "../services/project-connection-admission.js";
import { conflict } from "../errors.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companyMemberships, companySecrets, connectionGrants, createDb, projects, toolConnectionInstalls, toolConnections, toolOauthStates, toolProfileBindings, toolProfiles, userCompanyPreferences } from "@paperclipai/db";
import * as providerScope from "../services/project-connection-provider-scope.js";
import * as arbitration from "../services/project-connection-arbitration.js";
import * as retirement from "../services/project-connection-retirement.js";
import * as credentials from "../services/connection-credentials.js";
import { createToolConnectionSchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { CANARY, projectConnectionFixture, storedConnection } from "./helpers/project-connections-fixture.js";

describe("project connection writer admission (round-4 B)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-admission-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);
  afterEach(() => vi.restoreAllMocks());

  // B-only composition harness: A/C/D remain unimplemented on this lane.
  // Replace just those exported boundaries and synthetic vault acquisition;
  // all B writer, authority and transaction SQL below is production code.
  function composeFinish(f: Awaited<ReturnType<typeof projectConnectionFixture>>) {
    vi.spyOn(credentials, "resolveConnectionGrantSecret").mockResolvedValue({ value: CANARY, latestVersion: 1 });
    const verified = { identity: { companyId: f.companyId, providerHost: "github.com" as const,
      verifiedRegistrationId: "123", canonicalInstallationKey: "github.com/github-app-installation/456" },
      repositoryIds: [101], secretVersion: 1 };
    const verify = vi.spyOn(providerScope, "verifyProjectConnectionGitHubScope").mockResolvedValue(verified);
    vi.spyOn(retirement, "lockProjectConnectionLifecycle").mockImplementation(async (tx, input) => {
      await tx.select().from(projects).where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId))).for("update");
    });
    vi.spyOn(arbitration, "lockProjectConnectionIdentities").mockResolvedValue();
    vi.spyOn(arbitration, "assertProjectConnectionAvailability").mockResolvedValue();
    vi.spyOn(retirement, "assertProjectConnectionNotInUse").mockResolvedValue();
    const receipt = vi.spyOn(retirement, "writeProjectConnectionReceipt").mockImplementation(async (tx, input) => {
      const [row] = await tx.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.primary.id,
        action: input.action, entityType: "tool_connection", entityId: input.connection.id,
        details: { targetAgentIds: input.targetAgentIds, verifiedRepositoryIds: input.verifiedRepositoryIds } }).returning();
      return { activityId: row!.id };
    });
    const activate = vi.spyOn(retirement, "activateProjectConnectionMigration").mockImplementation(async (tx, input) => {
      const config = { ...input.connection.config, projectScope: { ...f.scope(), migrationPending: false, legacyConnectionId: (input.connection.config.projectScope as Record<string, unknown>).legacyConnectionId } };
      await tx.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, input.connection.id));
    });
    return { verified, verify, receipt, activate };
  }
  const finishInput = (agentId: string) => ({ access: { agentIds: [agentId] }, enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [] });

  it("J19: a viewer's private primary is not the designated human's approval authority", async () => {
    const f = await projectConnectionFixture(db);
    const viewer = `viewer-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: viewer, membershipRole: "viewer", status: "active" });
    await db.insert(userCompanyPreferences).values({ companyId: f.companyId, userId: viewer, primaryAgentId: f.outsider.id });
    await expect(f.service.createConnection(f.companyId, f.input(), { ...f.actor(f.outsider.id), responsibleUserId: viewer }))
      .rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });

  it("J19: another member's private primary and a mismatched responsible human cannot first-bind", async () => {
    const f = await projectConnectionFixture(db);
    const member = `member-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: member, membershipRole: "member", status: "active" });
    await db.insert(userCompanyPreferences).values({ companyId: f.companyId, userId: member, primaryAgentId: f.outsider.id });
    for (const actor of [{ ...f.actor(f.outsider.id), responsibleUserId: member }, { ...f.actor(), responsibleUserId: member }]) {
      await expect(f.service.createConnection(f.companyId, f.input(), actor))
        .rejects.toMatchObject({ status: 403, details: { code: "project_connection_actor_required" } });
    }
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });

  it("J19: missing trusted handoff refuses even H's real primary; installer labels are not proof", async () => {
    const f = await projectConnectionFixture(db);
    const resolve = vi.spyOn(credentials, "resolveConnectionGrantSecret");
    const verify = vi.spyOn(providerScope, "verifyProjectConnectionGitHubScope");
    for (const installedBy of [undefined, f.human, `different-human-${randomUUID()}`]) {
      const input = f.input();
      input.config = { ...input.config, ...(installedBy ? { installedBy, createdBy: f.human } : {}) };
      await expect(f.service.createConnection(f.companyId, input, f.actor()))
        .rejects.toMatchObject({ status: 403, details: { code: "project_connection_human_handoff_required" } });
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });

  it("A01: worker cannot self-ratify first bind; actorless service calls cannot bypass it", async () => {
    const f = await projectConnectionFixture(db);
    await expect(f.service.createConnection(f.companyId, f.input(), f.actor(f.worker.id)))
      .rejects.toMatchObject({ status: 403 });
    await expect(f.service.createConnection(f.companyId, f.input())).rejects.toMatchObject({ status: 403 });
  });

  it("J01: B's ordinarily permitted lead cannot disable A through the common writer", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    // The saved actor, not a route-only check, is needed by the writer.
    await expect(f.management(connection.id, f.leadB.id).then(context => f.service.updateConnection(connection.id, { enabled: false }, context)))
      .rejects.toMatchObject({ status: 403, details: { code: "project_connection_actor_required" } });
    expect((await storedConnection(db, connection.id)).enabled).toBe(true);
  });

  it("J02: wrong-project recipient cannot be installed by an otherwise permitted manager", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await expect(f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "agent", targetId: f.outsider.id }] }, f.actor()))
      .rejects.toMatchObject({ status: 403, details: { code: "project_connection_target_outside_project" } });
  });

  it("J03/J16: native create parsing preserves the nullable owner without removing baseline grants", async () => {
    const f = await projectConnectionFixture(db);
    const parsed = createToolConnectionSchema.parse(f.input());
    expect(parsed).toHaveProperty("projectId", f.a.id);
    const before = await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    const result = await f.service.createConnection(f.companyId, parsed, f.actor());
    expect(result).toHaveProperty("projectId", f.a.id);
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, f.companyId))).toEqual(before);
  });

  it("A02: changing workspace/repo hints cannot authorize another project's stable repo IDs", async () => {
    const f = await projectConnectionFixture(db);
    const proposed = f.input(f.b);
    proposed.config = { ...f.config(f.b), methodConfig: { ...f.config(f.b).methodConfig, repositories: "owner/A", repositoryIds: [101] } };
    await expect(f.service.createConnection(f.companyId, proposed, f.actor(f.leadB.id))).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
  });

  it("A02/B1: a lead's workspace metadata edit is not primary repository ratification for the next take", async () => {
    // Keep: trust boundary. Exercise the real lead PATCH then the common
    // next-take admission, independently of the missing human-custody reader.
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { status: "archived", installed: false });
    const { projectService } = await import("../services/projects.js");
    const [workspace] = await projectService(db).listWorkspaces(f.a.id);
    const edited = await request(f.route(f.leadA.id))
      .patch(`/api/projects/${f.a.id}/workspaces/${workspace!.id}`)
      .send({ metadata: { githubRepositoryId: 999 }, repoUrl: "https://github.com/owner/unapproved.git" });
    expect(edited.status).toBe(200);
    expect(edited.body.metadata.githubRepositoryId).toBe(999);
    // Even a request from the real primary cannot silently turn a lead's
    // mutable hint into a fresh approval. The retained snapshot is [101].
    await expect(assertProjectConnectionAdmission(db, { companyId: f.companyId, projectId: f.a.id,
      operation: "create", actor: f.actor(), proposedRepositoryIds: [999],
      proposedSecretRefs: connection.credentialSecretRefs,
    })).rejects.toMatchObject({ status: 403, details: { code: "project_connection_repository_not_approved" } });
    expect((await storedConnection(db, connection.id)).config.projectScope).toEqual(f.scope());
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(1);
  });

  it("A02/B1-narrow: a worker's workspace edit cannot widen an already approved connection", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    const { projectService } = await import("../services/projects.js");
    const [workspace] = await projectService(db).listWorkspaces(f.a.id);
    const edited = await request(f.route(f.worker.id))
      .patch(`/api/projects/${f.a.id}/workspaces/${workspace!.id}`)
      .send({ metadata: { githubRepositoryId: "999" } });
    expect(edited.status).toBe(200);
    await expect(assertProjectConnectionAdmission(db, { companyId: f.companyId, projectId: f.a.id,
      operation: "update", actor: f.actor(f.leadA.id), connection, proposedRepositoryIds: [999],
    })).rejects.toMatchObject({ status: 403, details: { code: "project_connection_repository_not_approved" } });
    expect((await storedConnection(db, connection.id)).config.projectScope).toEqual(f.scope());
  });

  it("A04: null adoption, reparent, owner clearing and direct archive are not generic PATCH", async () => {
    for (const direction of ["adopt", "reparent", "clear"] as const) {
      // Each direction has its own project, so the uniqueness backstop does not
      // become a fixture error once the earlier mutation assertions turn green.
      const f = await projectConnectionFixture(db);
      const { connection } = await f.seedConnection(direction === "adopt" ? null : f.a);
      const patch = { projectId: direction === "adopt" ? f.a.id : direction === "reparent" ? f.b.id : null, name: "must not silently strip ownership" };
      await expect(f.management(connection.id).then(context => f.service.updateConnection(connection.id, patch, context))).rejects.toMatchObject({ status: 409 });
      expect((await storedConnection(db, connection.id)).name).toBe(connection.name);
    }
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    await expect(f.management(connection.id).then(context => f.service.updateConnection(connection.id, { status: "archived" }, context))).rejects.toMatchObject({ status: 409 });
  });

  it("J15-caller-forgery: a caller managerApp marker is rejected, not treated as trusted classification", async () => {
    const f = await projectConnectionFixture(db);
    const input = f.input();
    input.config = { ...f.config(), projectScope: { ...f.scope(), managerApp: true } };
    // Even caller-supplied protected metadata must not become approval evidence.
    await expect(f.service.createConnection(f.companyId, input, f.actor())).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
  });

  it("A14/W1/W8: owned non-GitHub provider fails typed 422 before creating any residue", async () => {
    const f = await projectConnectionFixture(db);
    await expect(f.service.createConnection(f.companyId, f.input(f.a, { config: { sourceTemplateKey: "railway" } }), f.actor()))
      .rejects.toMatchObject({ status: 422, details: { code: "project_connection_provider_unsupported" } });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
  });

  it("A14-promotion: live shared to EXCLUSIVE is a typed refusal, not a hidden implementation", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    await expect(f.management(connection.id).then(context => f.service.updateConnection(connection.id, { config: f.config(f.a, true) }, context)))
      .rejects.toMatchObject({ status: 409, details: { code: "project_connection_exclusive_promotion_unsupported" } });
    expect((await storedConnection(db, connection.id)).config).toEqual(connection.config);
  });

  it("A08/W3: actorless company-wide replacement cannot manufacture owned connection reach", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await expect(f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "company", targetId: f.companyId }] }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("A09: another same-company secret cannot be substituted through a second/default installation grant", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    const [other] = await db.insert(companySecrets).values({ companyId: f.companyId, name: randomUUID(), key: randomUUID(), scope: "company" }).returning();
    await expect(f.service.addConnectionInstallation(connection.id, { isDefault: true,
      providerTenant: { externalId: "456" }, credentialSecretRefs: [{ secretId: other!.id, configPath: "credentials.privateKey", versionSelector: "latest" }],
    }, f.actor())).rejects.toMatchObject({ status: 403 });
    const saved = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connection.id));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: grant.id, isDefault: true, credentialSecretRefs: grant.credentialSecretRefs });
  });

  it("J15/A09: empty refs and alternate key projections never reach the key resolver", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    const resolve = vi.spyOn(credentials, "resolveConnectionGrantSecret");
    await expect(assertProjectConnectionAdmission(db, { companyId: f.companyId, projectId: f.a.id,
      operation: "finish", actor: f.actor(), connection, proposedSecretRefs: [], targetAgentIds: [f.worker.id],
    })).rejects.toMatchObject({ status: 403, details: { code: "project_connection_reference_not_approved" } });
    for (const configPath of ["env.GITHUB_TOKEN", "headers.Authorization", "credentials.otherKey"]) {
      await expect(assertProjectConnectionAdmission(db, { companyId: f.companyId, projectId: f.a.id,
        operation: "finish", actor: f.actor(), connection, proposedSecretRefs: [{ secretId: f.secret.id, configPath }], targetAgentIds: [f.worker.id],
      })).rejects.toMatchObject({ status: 403, details: { code: "project_connection_reference_not_approved" } });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("J02/J03: approved lead finishes an explicit worker with fresh verification and a transactional receipt", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { status: "draft", installed: false });
    const harness = composeFinish(f);
    const result = await f.service.finishGalleryAppConnection(f.companyId, connection.id, finishInput(f.worker.id), f.actor(f.leadA.id));
    expect(result.connection).toMatchObject({ id: connection.id, projectId: f.a.id, status: "active", enabled: true });
    expect(harness.verify).toHaveBeenCalledTimes(1);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id)))
      .toMatchObject([{ targetType: "agent", targetId: f.worker.id }]);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, result.profile.id)))
      .toMatchObject([{ targetType: "agent", targetId: f.worker.id }]);
    const receipts = await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id));
    expect(receipts).toMatchObject([{ action: "tool_connection.updated", details: { verifiedRepositoryIds: [101], targetAgentIds: [f.worker.id] } }]);
    expect(JSON.stringify({ result, receipts })).not.toContain(CANARY);
  });

  it("M02/A10: owned finish receipt failure rolls back activation, installs and profile, keeping legacy", async () => {
    const f = await projectConnectionFixture(db);
    const legacy = await f.seedConnection(null);
    const { connection } = await f.seedConnection(f.a, { status: "draft", pending: true, legacyId: legacy.connection.id, installed: false });
    const harness = composeFinish(f);
    harness.receipt.mockRejectedValue(new Error("synthetic receipt fault"));
    const before = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, f.companyId));
    await expect(f.service.finishGalleryAppConnection(f.companyId, connection.id, finishInput(f.worker.id), f.actor()))
      .rejects.toThrow("synthetic receipt fault");
    expect((await storedConnection(db, connection.id))).toMatchObject({ status: "draft", enabled: false, config: { projectScope: { migrationPending: true } } });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, f.companyId))).toEqual(before);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
    expect((await storedConnection(db, legacy.connection.id)).enabled).toBe(true);
  });

  it.each(["primary", "lead", "recipient", "key", "returned-repository", "identity"] as const)("A05/M02: %s changes during provider verification refuse before reach", async variant => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { status: "draft", installed: false });
    const harness = composeFinish(f);
    harness.verify.mockImplementation(async () => {
      if (variant === "primary") await db.update(userCompanyPreferences).set({ primaryAgentId: f.outsider.id }).where(and(eq(userCompanyPreferences.companyId, f.companyId), eq(userCompanyPreferences.userId, f.human)));
      if (variant === "lead") await db.update(projects).set({ leadAgentId: f.leadB.id }).where(eq(projects.id, f.a.id));
      if (variant === "recipient") await db.update(agents).set({ reportsTo: f.leadB.id }).where(eq(agents.id, f.worker.id));
      if (variant === "key") await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, f.secret.id));
      return { ...harness.verified,
        ...(variant === "returned-repository" ? { repositoryIds: [999] } : {}),
        ...(variant === "identity" ? { identity: { ...harness.verified.identity, verifiedRegistrationId: "987" } } : {}),
      };
    });
    await expect(f.service.finishGalleryAppConnection(f.companyId, connection.id, finishInput(f.worker.id), f.actor()))
      .rejects.toMatchObject({ status: expect.any(Number) });
    expect(harness.verify).toHaveBeenCalledTimes(1);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(0);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
    expect((await storedConnection(db, connection.id))).toMatchObject({ status: "draft", enabled: false });
  });

  it("J02/A05: preserveExistingAccess checks the final recipient union, not only the new worker", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { status: "draft", installed: false });
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: f.outsider.id });
    composeFinish(f);
    await expect(f.service.finishGalleryAppConnection(f.companyId, connection.id, { ...finishInput(f.worker.id), preserveExistingAccess: true }, f.actor()))
      .rejects.toMatchObject({ status: 403, details: { code: "project_connection_target_outside_project" } });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id)))
      .toMatchObject([{ targetId: f.outsider.id }]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });

  it("A08/W7: actorless project lead changes cannot rewrite the approved team", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    const { projectService } = await import("../services/projects.js");
    await expect(projectService(db).update(f.a.id, { leadAgentId: f.leadB.id }))
      .rejects.toMatchObject({ status: 403, details: { code: "project_connection_actor_required" } });
    expect((await db.select().from(projects).where(eq(projects.id, f.a.id)))[0]!.leadAgentId).toBe(f.leadA.id);
    expect((await storedConnection(db, connection.id)).config.projectScope).toEqual(f.scope());
  });

  it("J01/A08/W7: B's lead cannot change A's approved lead through real project PATCH", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    const response = await request(f.route(f.leadB.id)).patch(`/api/projects/${f.a.id}`).send({ leadAgentId: f.leadB.id });
    expect(response.status).toBe(403);
    expect((await db.select().from(projects).where(eq(projects.id, f.a.id)))[0]!.leadAgentId).toBe(f.leadA.id);
    expect((await storedConnection(db, connection.id)).config.projectScope).toEqual(f.scope());
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });

  it("J02/A08/W7: even the primary must reconcile old recipients before changing the lead", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    composeFinish(f);
    const response = await request(f.route(f.primary.id)).patch(`/api/projects/${f.a.id}`).send({ leadAgentId: f.leadB.id });
    expect(response.status).toBe(403);
    expect((await storedConnection(db, connection.id)).config.projectScope).toEqual(f.scope());
    expect((await db.select().from(projects).where(eq(projects.id, f.a.id)))[0]!.leadAgentId).toBe(f.leadA.id);
  });

  it("J03/A08/W7: an authorized drained lead change synchronizes live and retained approvals atomically", async () => {
    const f = await projectConnectionFixture(db);
    const archived = await f.seedConnection(f.a, { status: "archived", installed: false });
    const live = await f.seedConnection(f.a, { status: "draft", installed: false });
    composeFinish(f);
    const response = await request(f.route(f.primary.id)).patch(`/api/projects/${f.a.id}`).send({ leadAgentId: f.worker.id });
    expect(response.status).toBe(200);
    expect(response.body.leadAgentId).toBe(f.worker.id);
    for (const { connection } of [archived, live]) {
      expect((await storedConnection(db, connection.id)).config.projectScope).toEqual({ ...f.scope(), approvedLeadAgentId: f.worker.id });
    }
    expect((await storedConnection(db, archived.connection.id)).status).toBe("archived");
  });

  it("J11/A08/W7: running-work refusal rolls back project lead and all approval envelopes", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    composeFinish(f);
    vi.mocked(retirement.assertProjectConnectionNotInUse).mockRejectedValue(conflict("synthetic running work", { code: "project_connection_in_use" }));
    const response = await request(f.route(f.primary.id)).patch(`/api/projects/${f.a.id}`).send({ leadAgentId: f.worker.id });
    expect(response.status).toBe(409);
    expect((await storedConnection(db, connection.id)).config.projectScope).toEqual(f.scope());
    expect((await db.select().from(projects).where(eq(projects.id, f.a.id)))[0]!.leadAgentId).toBe(f.leadA.id);
  });

  it.each(["direct", "cloud", "vercel"] as const)("A03/A08/W2: an old %s OAuth continuation cannot write an owned App", async transport => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { status: "archived", installed: false });
    const state = randomUUID();
    await db.insert(toolOauthStates).values({ companyId: f.companyId, connectionId: connection.id, state, codeVerifier: "synthetic-pkce",
      subjectUserId: f.human, expiresAt: new Date(Date.now() + 60_000),
      createdByActorType: "user", createdByActorId: f.human });
    const actor = { actorType: "user" as const, actorId: f.human };
    const callback = transport === "direct" ? f.service.completeOAuthCallback({ state, code: "synthetic-code", redirectUri: "https://paperclip.invalid/callback", actor })
      : transport === "cloud" ? f.service.completePaperclipCloudConnectorCallback({ state, claimId: "synthetic-claim", actor })
      : f.service.completeVercelConnectCallback({ state, actor });
    await expect(callback).rejects.toMatchObject({ status: 409, details: { code: "project_connection_archived" } });
    expect((await storedConnection(db, connection.id)).status).toBe("archived");
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });

  it("A12/W7: project deletion cannot strand retained owned history", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { status: "archived", installed: false });
    const { projectService } = await import("../services/projects.js");
    await expect(projectService(db).remove(f.a.id)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.companyId), eq(toolConnections.status, "archived")))).toHaveLength(1);
  });
});
