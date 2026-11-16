import request from "supertest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, companySecrets, companySecretVersions, connectionGrants, createDb, heartbeatRuns, issues, projects, toolApplications, toolConnectionInstalls, toolConnections, userCompanyPreferences } from "@paperclipai/db";
import * as admission from "../services/project-connection-admission.js";
import * as arbitration from "../services/project-connection-arbitration.js";
import * as activityService from "../services/activity-log.js";
import { activateProjectConnectionMigration, assertProjectConnectionNotInUse, lockProjectConnectionLifecycle, writeProjectConnectionReceipt } from "../services/project-connection-retirement.js";
import { toolAccessService } from "../services/tool-access.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { CANARY, projectConnectionFixture, storedConnection } from "./helpers/project-connections-fixture.js";
import { createLocalEncryptedCipher } from "../secrets/local-encrypted-provider.js";
import { connectionManagementService } from "../services/connection-management.js";
import { githubAppFailure } from "../services/github-app-client.js";
import { approveFixtureCustodySource } from "./helpers/project-connections-custody-setup.js";

const provider = vi.hoisted(() => {
  const controls = { verify: vi.fn(async () => ({ token: "synthetic-verified-project-token", expiresAt: Date.now() + 3600000,
  github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [{ id: "101", fullName: "owner/A", installationId: "456", private: true }] },
})), acquire: vi.fn(async (_db: unknown, connection: { id: string }) => ({
  token: `synthetic-project-token-${connection.id}`, expiresAt: Date.now() + 3600000,
  github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] },
})) };
  // Genuine approval setup and owned create/finish retain real vault resolution,
  // JWT signing, App-client verification and normalized provider admission.
  // Existing fault controls are exercised ONLY at the external HTTP boundary.
  let verified: Awaited<ReturnType<typeof controls.verify>>;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/app") return Response.json({ id: 123, slug: "project-fixture" });
    if (path === "/app/installations/456") return Response.json({ id: 456, app_id: 123, suspended_at: null,
      account: { login: "owner" }, permissions: { contents: "write", pull_requests: "write", issues: "read" } });
    if (path.endsWith("/access_tokens")) {
      try { verified = await controls.verify(); }
      catch { return Response.json({ message: "synthetic token fault" }, { status: 403 }); }
      return Response.json({ token: verified.token, expires_at: new Date(verified.expiresAt).toISOString() });
    }
    if (path.startsWith("/users/")) return Response.json({ id: 123, login: "project-fixture[bot]", type: "Bot" });
    if (path === "/installation/repositories") return Response.json({ repositories: verified.github.repositories.map(repo => ({
      id: Number(repo.id), full_name: repo.fullName, private: repo.private,
    })) });
    throw new Error(`Unexpected project-retirement provider HTTP path: ${path}`);
  }));
  return controls;
});
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
vi.mock("../services/github-app-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/github-app-credentials.js")>(),
  refreshGitHubAppAccess: provider.verify, resolveGitHubAppCredential: provider.acquire,
}));
import { createGitRemoteAuthProvider, resolveManagedGitHubCredential, resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";

// Receipt failure is injected at the actual PostgreSQL insert boundary, not in
// a fake service. This trigger exists only in this disposable test database.
async function failReceipt(db: ReturnType<typeof createDb>, id: string) {
  await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id = '${id}' THEN RAISE EXCEPTION 'synthetic receipt persistence failure'; END IF; RETURN NEW; END $$`));
  await db.execute(sql.raw("CREATE TRIGGER project_red_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_red_receipt_failure()"));
}
async function restoreReceipt(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw("DROP TRIGGER IF EXISTS project_red_receipt_failure ON activity_log"));
}

describe("project connection make-before-break and local retirement (round-4 D)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    // Synthetic, process-local test key: no host credential/key-file access.
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "http://127.0.0.1");
    database = await startEmbeddedPostgresTestDatabase("paperclip-project-retire-"); db = createDb(database.connectionString);
  }, 60_000);
  beforeEach(() => { provider.verify.mockReset(); provider.acquire.mockReset(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }, 60_000);

  async function versionOne(f: Awaited<ReturnType<typeof projectConnectionFixture>>) {
    await db.insert(companySecretVersions).values({ secretId: f.secret.id, version: 1,
      material: createLocalEncryptedCipher("write").encrypt(privateKey),
      valueSha256: "synthetic-retirement-version", fingerprintSha256: "synthetic-retirement-version" });
  }

  // Explicit service-call fixture authentication. This models the existing
  // board route's adapter, never product inference from actorType/user ID.
  async function authenticateBoardRemoval(f: Awaited<ReturnType<typeof projectConnectionFixture>>, connectionId: string) {
    const managementContext = await connectionManagementService(db).authorize(
      { type: "board", userId: f.human, source: "session", sessionId: f.companyId, isInstanceAdmin: false },
      "connections:configure", { type: "connection_management", companyId: f.companyId, connectionId, operation: "DELETE /tool-connections/:connectionId" });
    const archive = f.service.archiveConnection;
    f.service.archiveConnection = (id, companyId, actor) => archive(id, companyId,
      actor?.actorType === "user" && actor.actorId === f.human
        ? { ...actor, authenticatedActorType: "board", managementContext } : actor);
  }

  async function pending() {
    const f = await projectConnectionFixture(db, true);
    await versionOne(f);
    const legacy = await f.seedConnection(null);
    await approveFixtureCustodySource(db, f, legacy);
    provider.verify.mockClear(); // finish assertions count the operation, not setup approval
    const candidate = await f.seedConnection(f.a, { status: "draft", installed: false, pending: true, legacyId: legacy.connection.id });
    const bound = await f.run();
    const context = { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id, issueId: bound.issue.id };
    const finish = () => f.service.finishGalleryAppConnection(f.companyId, candidate.connection.id, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [f.leadA.id] } }, f.actor());
    return { f, legacy, candidate, bound, context, finish };
  }

  async function removalCustody(f: Awaited<ReturnType<typeof projectConnectionFixture>>) {
    await versionOne(f);
    const source = await f.seedConnection(null, { installed: false });
    await approveFixtureCustodySource(db, f, source);
    provider.verify.mockClear();
  }

  // RFL F2/F3: these tests intentionally use the REAL create/finish/install-set
  // writers and Git auth factory. Candidate rows are NEVER seeded here. The
  // only simulated dependency is the external provider; all writes/faults are PG.
  // Keep reason: migration data safety and credential trust boundary.
  describe("RFL make-before-break real writer sequence", () => {
    async function migration() {
      const f = await projectConnectionFixture(db, true);
      await versionOne(f);
      const legacy = await f.seedConnection(null);
      await approveFixtureCustodySource(db, f, legacy);
      provider.verify.mockClear();
      // L still serves B; only the fully transferred A worker may be removed.
      await f.service.putConnectionInstalls(legacy.connection.id, { installs: [f.leadA, f.worker, f.outsider]
        .map(agent => ({ targetType: "agent" as const, targetId: agent.id })) }, f.actor());
      const a = await f.run(f.a, f.worker.id);
      const b = await f.run(f.b);
      const context = { agentId: f.worker.id, responsibleUserId: f.human, heartbeatRunId: a.run.id, issueId: a.issue.id };
      const bContext = { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: b.run.id, issueId: b.issue.id };
      const create = () => f.service.createConnection(f.companyId, f.input(), f.actor());
      const finish = (id: string, service = f.service) => service.finishGalleryAppConnection(f.companyId, id,
        { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [f.leadA.id, f.worker.id] } }, f.actor());
      const cleanup = () => f.service.putConnectionInstalls(legacy.connection.id, { installs: [f.leadA, f.outsider]
        .map(agent => ({ targetType: "agent" as const, targetId: agent.id })) }, f.actor());
      return { f, legacy, a, b, context, bContext, create, finish, cleanup };
    }

    // A restart means a NEW database client and NEW stateful service/factory,
    // not two calls to the same resolver. Nothing in the old factory is reused.
    async function restartedPush(p: Awaited<ReturnType<typeof migration>>, connectionId: string | null, context = p.context) {
      const restartedDb = createDb(database.connectionString);
      const secrets = { getByName: vi.fn(async () => null), resolveSecretValue: vi.fn(async () => "synthetic-ambient-must-not-be-read") };
      const nextService = toolAccessService(restartedDb);
      expect(nextService).not.toBe(p.f.service);
      const nextGit = createGitRemoteAuthProvider(restartedDb, p.f.companyId, context,
        { secrets, env: { GH_TOKEN: "synthetic-ambient-must-not-be-used" } });
      const acquiredBefore = provider.acquire.mock.calls.length;
      try {
        if (connectionId) {
          const invocation = await nextGit("https://github.com/owner/A.git");
          expect(invocation?.env.GH_TOKEN).toBe(`synthetic-project-token-${connectionId}`);
          expect(provider.acquire.mock.calls.slice(acquiredBefore).some(([, connection]) => connection.id === connectionId)).toBe(true);
        } else {
          await expect(nextGit("https://github.com/owner/A.git")).rejects.toThrow();
          expect(provider.acquire.mock.calls.slice(acquiredBefore)).toHaveLength(0);
        }
        expect(secrets.getByName).not.toHaveBeenCalled();
        expect(secrets.resolveSecretValue).not.toHaveBeenCalled();
      } finally { await restartedDb.$client.end({ timeout: 1 }); }
    }

    async function created(p: Awaited<ReturnType<typeof migration>>) {
      await restartedPush(p, p.legacy.connection.id);
      const candidate = await p.create();
      const row = await storedConnection(db, candidate.id);
      expect(row).toMatchObject({ projectId: p.f.a.id, status: "draft", enabled: false,
        config: { projectScope: { migrationPending: true, legacyConnectionId: p.legacy.connection.id } } });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.id))).toHaveLength(0);
      const receipts = await db.select().from(activityLog).where(and(eq(activityLog.entityId, candidate.id), eq(activityLog.action, "tool_connection.project_taken")));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.details).toMatchObject({ migrationPending: true });
      await restartedPush(p, p.legacy.connection.id);
      return row;
    }

    it("N6(iii)(a): A completes while B serves from S; S stays active, readable and consumedBy A", async () => {
      const p = await migration();
      const candidate = await created(p);
      await p.finish(candidate.id);
      const serving = await storedConnection(db, candidate.id);
      expect(serving).toMatchObject({ status: "active", enabled: true, config: { projectScope: { migrationPending: false } } });
      await p.cleanup();
      const source = await storedConnection(db, p.legacy.connection.id);
      expect(source.config.projectAppApprovalConsumedBy).toBe(candidate.id);
      expect(source.status).toBe("active");
      await restartedPush(p, p.legacy.connection.id, p.bContext);
    });

    it("N6(iii)(b): B completes too; final recipient cleanup archives S without deleting custody or credentials", async () => {
      const p = await migration();
      const candidate = await created(p);
      await p.finish(candidate.id);
      await p.cleanup();
      const bResult = { token: "synthetic-B", expiresAt: Date.now() + 3600000,
        github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1,
          repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"],
          repositories: [{ id: "202", fullName: "owner/B", installationId: "456", private: true }] } };
      provider.verify.mockResolvedValue(bResult);
      const bSource = await p.f.seedConnection(null);
      const { projectScope: _scope, ...bConfig } = p.f.config(p.f.b);
      await db.update(toolConnections).set({ config: bConfig, transportConfig: bConfig }).where(eq(toolConnections.id, bSource.connection.id));
      const approval = await request(p.f.route()).post(`/api/companies/${p.f.companyId}/tools/connections/${bSource.connection.id}/project-app-approval`)
        .set("Origin", "http://127.0.0.1").send({ action: "approve", projectId: p.f.b.id });
      expect(approval.status).toBe(200);
      await p.f.service.putConnectionInstalls(bSource.connection.id, { installs: [p.f.leadA, p.f.outsider]
        .map(agent => ({ targetType: "agent" as const, targetId: agent.id })) }, p.f.actor());
      const bCandidate = await p.f.service.createConnection(p.f.companyId, p.f.input(p.f.b), p.f.actor());
      await p.f.service.finishGalleryAppConnection(p.f.companyId, bCandidate.id,
        { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [p.f.leadA.id, p.f.outsider.id] } }, p.f.actor());
      expect(await storedConnection(db, bCandidate.id)).toMatchObject({ status: "active", enabled: true,
        config: { projectScope: { migrationPending: false } } });
      await p.f.service.putConnectionInstalls(p.legacy.connection.id, { installs: [] }, p.f.actor());
      const source = await storedConnection(db, p.legacy.connection.id);
      expect(source).toMatchObject({ status: "archived", enabled: false,
        config: { projectAppApprovalConsumedBy: candidate.id } });
      expect(source.credentialSecretRefs).toEqual(p.legacy.connection.credentialSecretRefs);
      expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, source.id)))
        .toMatchObject([{ status: "active", credentialSecretRefs: source.credentialSecretRefs }]);
    });

    it("N6(iii)(c): abort restores S live and reserved with the genuine receipt unconsumed, atomically", async () => {
      const p = await migration();
      const original = await storedConnection(db, p.legacy.connection.id);
      const candidate = await created(p);
      await p.f.service.archiveConnection(candidate.id, p.f.companyId, { ...p.f.actor(),
        projectDoneConfirmation: { projectId: p.f.a.id, connectionId: candidate.id } });
      const source = await storedConnection(db, p.legacy.connection.id);
      expect(source).toMatchObject({ status: "active", enabled: true });
      expect(source.config.projectAppApprovalConsumedBy).toBeUndefined();
      expect(source.transportConfig.projectAppApprovalConsumedBy).toBeUndefined();
      expect(source.config.projectAppApproval).toEqual(original.config.projectAppApproval);
      await expect(arbitration.assertProjectConnectionAvailability(db, { identity: {
        companyId: p.f.companyId, providerHost: "github.com", verifiedRegistrationId: "123",
        canonicalInstallationKey: "github.com/github-app-installation/456" }, projectId: p.f.b.id, exclusive: true }))
        .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
    });

    it("N6(iii)(a)/(c): a retake after abort cannot archive S while B still serves from it", async () => {
      const p = await migration();
      const candidate = await created(p);
      await p.f.service.archiveConnection(candidate.id, p.f.companyId, { ...p.f.actor(),
        projectDoneConfirmation: { projectId: p.f.a.id, connectionId: candidate.id } });
      const retake = await p.create();
      // Retained ownership deliberately prevents resetting D's first-migration
      // exception. That is not permission to break another project's legacy.
      expect((await storedConnection(db, retake.id)).config.projectScope).toMatchObject({ approvedRepositoryIds: [101] });
      expect(await storedConnection(db, p.legacy.connection.id)).toMatchObject({ status: "active", enabled: true,
        config: { projectAppApprovalConsumedBy: retake.id } });
      await restartedPush(p, p.legacy.connection.id, p.bContext);
    });

    it("N6(iii)(c) rollback: abort receipt failure cannot release S without retiring its pending consumer", async () => {
      const p = await migration();
      const candidate = await created(p);
      const before = await storedConnection(db, p.legacy.connection.id);
      await failReceipt(db, candidate.id);
      try { await expect(p.f.service.archiveConnection(candidate.id, p.f.companyId, { ...p.f.actor(),
        projectDoneConfirmation: { projectId: p.f.a.id, connectionId: candidate.id } })).rejects.toMatchObject({ cause: {
          code: "P0001", message: "synthetic receipt persistence failure" } }); }
      finally { await restoreReceipt(db); }
      expect(await storedConnection(db, candidate.id)).toMatchObject({ status: "draft", enabled: false,
        config: { projectScope: { migrationPending: true } } });
      expect((await storedConnection(db, p.legacy.connection.id)).config).toEqual(before.config);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, p.legacy.connection.id),
        eq(activityLog.action, "tool_connection.project_app_approval_released")))).toHaveLength(0);
      await restartedPush(p, p.legacy.connection.id, p.bContext);
    });

    it("N6(iii)(d): a completed transition rolled back by its receipt leaves S live while B still needs it", async () => {
      const p = await migration();
      const candidate = await created(p);
      await failReceipt(db, candidate.id);
      try { await expect(p.finish(candidate.id)).rejects.toMatchObject({ cause: {
        code: "P0001", message: "synthetic receipt persistence failure" } }); }
      finally { await restoreReceipt(db); }
      expect(await storedConnection(db, candidate.id)).toMatchObject({ status: "draft", enabled: false,
        config: { projectScope: { migrationPending: true } } });
      expect(await storedConnection(db, p.legacy.connection.id)).toMatchObject({ status: "active", enabled: true });
      await restartedPush(p, p.legacy.connection.id, p.bContext);
    });
  });
});
