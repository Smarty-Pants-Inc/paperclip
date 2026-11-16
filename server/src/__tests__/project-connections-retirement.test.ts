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

    it("RFL/M01: actual create -> token verification -> atomic install -> recipient-local legacy removal, with shared L still serving B", async () => {
      const p = await migration(); const candidate = await created(p);
      const legacyBefore = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
      await p.finish(candidate.id);
      expect(provider.verify).toHaveBeenCalled();
      expect(await storedConnection(db, candidate.id)).toMatchObject({ status: "active", enabled: true, config: { projectScope: { migrationPending: false } } });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.id))).toHaveLength(2);
      const [receipt] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, candidate.id), eq(activityLog.action, "tool_connection.updated")));
      expect(receipt?.details).toMatchObject({ migrationPending: false, verifiedRepositoryIds: [101] });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id))).toEqual(legacyBefore);
      await restartedPush(p, candidate.id);
      await restartedPush(p, p.legacy.connection.id, p.bContext);
      await p.cleanup();
      const remaining = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
      expect(remaining.map(row => row.targetId).sort()).toEqual([p.f.leadA.id, p.f.outsider.id].sort());
      await restartedPush(p, candidate.id);
      await restartedPush(p, p.legacy.connection.id, p.bContext);
    });

    it("RFL/M02 create: failing the first operation leaves no candidate/application/grant residue, and legacy pushes survive a new service", async () => {
      const p = await migration();
      const applications = await db.select().from(toolApplications).where(eq(toolApplications.companyId, p.f.companyId));
      const legacyInstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
      await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${p.f.companyId}' AND NEW.action = 'tool_connection.project_taken' THEN RAISE EXCEPTION 'synthetic create receipt failure'; END IF; RETURN NEW; END $$`));
      await db.execute(sql.raw("CREATE TRIGGER project_red_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_red_receipt_failure()"));
      try { await expect(p.create()).rejects.toThrow(); }
      finally { await restoreReceipt(db); }
      expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, p.f.companyId))).toEqual([p.legacy.connection]);
      expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, p.f.companyId))).toEqual(applications);
      expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, p.f.companyId))).toEqual([p.legacy.grant]);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id))).toEqual(legacyInstalls);
      await restartedPush(p, p.legacy.connection.id);
    });

    it("INT-R5/:143 companion: create fails on the injected receipt P0001, not the custody prerequisite", async () => {
      const control = await migration(); await created(control);
      const p = await migration();
      const beforeApplications = await db.select().from(toolApplications).where(eq(toolApplications.companyId, p.f.companyId));
      await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${p.f.companyId}' AND NEW.action = 'tool_connection.project_taken' THEN RAISE EXCEPTION 'synthetic create receipt failure'; END IF; RETURN NEW; END $$`));
      await db.execute(sql.raw("CREATE TRIGGER project_red_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_red_receipt_failure()"));
      try { await expect(p.create()).rejects.toMatchObject({ cause: { code: "P0001", message: "synthetic create receipt failure" } }); }
      finally { await restoreReceipt(db); }
      expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, p.f.companyId))).toEqual(beforeApplications);
      expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, p.f.companyId))).toEqual([p.legacy.connection]);
      expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, p.f.companyId))).toEqual([p.legacy.grant]);
      await restartedPush(p, p.legacy.connection.id);
    });

    it("INT-R5/:143 additional PG-boundary probe leaves the frozen migration-marker control independent", async () => {
      // This positive control proves only that the actual create/receipt writer
      // is reachable. created() above still separately enforces EVERY frozen
      // migration marker; its current failure is not relaxed or hidden here.
      const control = await migration();
      const created = await control.create();
      expect(await storedConnection(db, created.id)).toMatchObject({ projectId: control.f.a.id, status: "draft", enabled: false });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, created.id), eq(activityLog.action, "tool_connection.project_taken")))).toHaveLength(1);
      const p = await migration();
      const beforeApplications = await db.select().from(toolApplications).where(eq(toolApplications.companyId, p.f.companyId));
      const beforeInstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
      await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${p.f.companyId}' AND NEW.action = 'tool_connection.project_taken' THEN RAISE EXCEPTION 'synthetic create receipt failure'; END IF; RETURN NEW; END $$`));
      await db.execute(sql.raw("CREATE TRIGGER project_red_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_red_receipt_failure()"));
      try { await expect(p.create()).rejects.toMatchObject({ cause: { code: "P0001", message: "synthetic create receipt failure" } }); }
      finally { await restoreReceipt(db); }
      expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, p.f.companyId))).toEqual(beforeApplications);
      expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, p.f.companyId))).toEqual([p.legacy.connection]);
      expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, p.f.companyId))).toEqual([p.legacy.grant]);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id))).toEqual(beforeInstalls);
      await restartedPush(p, p.legacy.connection.id);
    });

    it.each(["mint", "wrong-repository-id", "stale-approval", "stale-key", "stale-recipient", "finish-install", "receipt"] as const)(
      "RFL/M02 second operation: %s failure preserves pending/non-serving candidate and usable legacy across a new service", async boundary => {
        const p = await migration(); const candidate = await created(p);
        const legacyInstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
        if (boundary === "mint") provider.verify.mockRejectedValueOnce(new Error("synthetic mint failure"));
        if (["wrong-repository-id", "stale-approval", "stale-key", "stale-recipient"].includes(boundary)) {
          provider.verify.mockImplementationOnce(async () => {
            if (boundary === "stale-approval") await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, p.f.primary.id));
            if (boundary === "stale-key") await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, p.f.secret.id));
            if (boundary === "stale-recipient") await db.update(agents).set({ reportsTo: p.f.primary.id }).where(eq(agents.id, p.f.worker.id));
            return { token: "synthetic-verified-project-token", expiresAt: Date.now() + 3600000,
              github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"],
                repositories: [{ id: boundary === "wrong-repository-id" ? "999" : "101", fullName: "owner/A", installationId: "456", private: true }] } };
          });
        }
        if (boundary === "receipt") await failReceipt(db, candidate.id);
        if (boundary === "finish-install") {
          await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_install_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.connection_id = '${candidate.id}' THEN RAISE EXCEPTION 'synthetic finish install failure'; END IF; RETURN NEW; END $$`));
          await db.execute(sql.raw("CREATE TRIGGER project_red_install_failure BEFORE INSERT ON tool_connection_installs FOR EACH ROW EXECUTE FUNCTION project_red_install_failure()"));
        }
        try { await expect(p.finish(candidate.id)).rejects.toThrow(); }
        finally {
          if (boundary === "receipt") await restoreReceipt(db);
          if (boundary === "finish-install") await db.execute(sql.raw("DROP TRIGGER IF EXISTS project_red_install_failure ON tool_connection_installs"));
        }
        expect(await storedConnection(db, candidate.id)).toMatchObject({ status: "draft", enabled: false, config: { projectScope: { migrationPending: true } } });
        expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.id))).toHaveLength(0);
        expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id))).toEqual(legacyInstalls);
        expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, candidate.id), eq(activityLog.action, "tool_connection.updated")))).toHaveLength(0);
        await restartedPush(p, p.legacy.connection.id);
      });

    it("RFL/M03 third operation: actual legacy cleanup fault cannot undo activation; new service still uses candidate, then retire blocks every fallback", async () => {
      const p = await migration(); const candidate = await created(p); await p.finish(candidate.id);
      const activated = await storedConnection(db, candidate.id);
      const receipts = await db.select().from(activityLog).where(eq(activityLog.entityId, candidate.id));
      const legacyInstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
      await restartedPush(p, candidate.id);
      await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.connection_id = '${p.legacy.connection.id}' THEN RAISE EXCEPTION 'synthetic legacy cleanup failure'; END IF; RETURN OLD; END $$`));
      await db.execute(sql.raw("CREATE TRIGGER project_red_cleanup_failure BEFORE DELETE ON tool_connection_installs FOR EACH ROW EXECUTE FUNCTION project_red_cleanup_failure()"));
      try { await expect(p.cleanup()).rejects.toThrow(); }
      finally { await db.execute(sql.raw("DROP TRIGGER IF EXISTS project_red_cleanup_failure ON tool_connection_installs")); }
      expect(await storedConnection(db, candidate.id)).toEqual(activated);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, candidate.id))).toEqual(receipts);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id))).toEqual(legacyInstalls);
      await restartedPush(p, candidate.id);
      await restartedPush(p, p.legacy.connection.id, p.bContext);
      const restartedDb = createDb(database.connectionString);
      try {
        const restartedService = toolAccessService(restartedDb);
        await restartedService.archiveConnection(candidate.id, p.f.companyId, { ...p.f.actor(),
          projectDoneConfirmation: { projectId: p.f.a.id, connectionId: candidate.id } } as ReturnType<typeof p.f.actor>);
      } finally { await restartedDb.$client.end({ timeout: 1 }); }
      expect(await storedConnection(db, candidate.id)).toMatchObject({ status: "archived", config: { projectScope: { migrationPending: false } } });
      await restartedPush(p, null);
      await restartedPush(p, p.legacy.connection.id, p.bContext);
    });
  });

  it("RFL/A06a PATCH: dead lead/no primary board human disables through existing narrow PATCH, with one human receipt and no table repair", async () => {
    const f = await projectConnectionFixture(db); const { connection } = await f.seedConnection();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.leadA.id));
    await db.update(userCompanyPreferences).set({ primaryAgentId: null }).where(eq(userCompanyPreferences.companyId, f.companyId));
    // Seed the fault before the HTTP request: a post-return route receipt is
    // not atomic and must NOT leave this row disabled when the receipt fails.
    await failReceipt(db, connection.id);
    try {
      const failed = await request(f.route()).patch(`/api/tool-connections/${connection.id}`).send({ enabled: false });
      expect(failed.status).toBe(500);
      expect(await storedConnection(db, connection.id)).toEqual(connection);
    } finally { await restoreReceipt(db); }
    const result = await request(f.route()).patch(`/api/tool-connections/${connection.id}`).send({ enabled: false });
    expect(result.status).toBe(200);
    expect(await storedConnection(db, connection.id)).toMatchObject({ projectId: f.a.id, status: "active", enabled: false, config: connection.config });
    const receipts = await db.select().from(activityLog).where(and(eq(activityLog.entityId, connection.id), eq(activityLog.action, "tool_connection.updated")));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ actorType: "user", actorId: f.human, details: { projectId: f.a.id, connectionId: connection.id, reason: "connection_disabled" } });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(1);
  });

  it("M01: verified finish clears pending atomically, selects A during legacy overlap and preserves unconverted B", async () => {
    const { f, legacy, candidate, context, finish } = await pending();
    const before = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(before.connection?.id).toBe(legacy.connection.id);
    await finish();
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect((await storedConnection(db, candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: false });
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.connection?.id).toBe(candidate.connection.id);
    const b = await f.run(f.b);
    const bContext = { ...context, issueId: b.issue.id, heartbeatRunId: b.run.id };
    const unconverted = await resolveManagedGitHubIdentitySelection(db, f.companyId, bContext);
    expect(unconverted.connection?.id).toBe(legacy.connection.id);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id))).toHaveLength(1);
  });

  it("M02: second-operation receipt failure leaves candidate pending/non-serving and legacy use intact", async () => {
    const { f, legacy, candidate, context, finish } = await pending();
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id));
    await failReceipt(db, candidate.connection.id);
    try { await expect(finish()).rejects.toThrow(); }
    finally { await restoreReceipt(db); }
    expect((await storedConnection(db, candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: true });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.connection.id))).toHaveLength(0);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id))).toEqual(installs);
    const selected = await resolveManagedGitHubCredential(db, { getByName: vi.fn(async () => null), resolveSecretValue: vi.fn(async () => "") }, f.companyId, context);
    expect(selected.credential?.connectionId).toBe(legacy.connection.id);
  });

  it("INT-R5/:249 companion: pending finish reaches the exact injected receipt P0001 after a successful finish control", async () => {
    const control = await pending(); await control.finish();
    expect((await storedConnection(db, control.candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: false });
    const { f, legacy, candidate, context, finish } = await pending();
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id));
    await failReceipt(db, candidate.connection.id);
    try { await expect(finish()).rejects.toMatchObject({ cause: { code: "P0001", message: "synthetic receipt persistence failure" } }); }
    finally { await restoreReceipt(db); }
    expect(await storedConnection(db, candidate.connection.id)).toEqual(candidate.connection);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.connection.id))).toHaveLength(0);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id))).toEqual(installs);
    expect((await resolveManagedGitHubIdentitySelection(db, f.companyId, context)).connection?.id).toBe(legacy.connection.id);
  });

  it("INT-R5/:263 companion: mint fault is the token-specific provider refusal, not version_missing", async () => {
    const control = await pending(); await control.finish();
    expect((await storedConnection(db, control.candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: false });
    const { f, legacy, candidate, context, finish } = await pending();
    let injected = false;
    provider.verify.mockImplementationOnce(async () => { injected = true; githubAppFailure("token"); });
    await expect(finish()).rejects.toMatchObject({ status: 422, details: { code: "github_app_access_unavailable", reason: "token" } });
    expect(injected).toBe(true);
    expect(await storedConnection(db, candidate.connection.id)).toEqual(candidate.connection);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.connection.id))).toHaveLength(0);
    expect((await resolveManagedGitHubIdentitySelection(db, f.companyId, context)).connection?.id).toBe(legacy.connection.id);
  });

  it("M02: failed token mint is not a health-only activation, and legacy remains usable after retry/restart", async () => {
    const { f, legacy, candidate, context, finish } = await pending();
    provider.verify.mockRejectedValueOnce(new Error("synthetic provider token mint failed"));
    await expect(finish()).rejects.toThrow();
    expect((await storedConnection(db, candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: true });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.connection.id))).toHaveLength(0);
    for (let restart = 0; restart < 2; restart++) {
      const selected = await resolveManagedGitHubCredential(db, { getByName: vi.fn(async () => null), resolveSecretValue: vi.fn(async () => "") }, f.companyId, context);
      expect(selected.credential?.connectionId).toBe(legacy.connection.id);
    }
  });

  it("M03/A04: resetting migrationPending on an activated row is refused without altering its history", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    await expect(f.management(connection.id).then(context => f.service.updateConnection(connection.id, { config: { ...connection.config, projectScope: { ...f.scope(), migrationPending: true, legacyConnectionId: connection.id } } }, context)))
      .rejects.toMatchObject({ status: 409 });
    expect((await storedConnection(db, connection.id)).config).toEqual(connection.config);
  });

  it("M03: activated then retired project cannot borrow leftover legacy reach or reset pending", async () => {
    const { f, legacy, candidate, context, finish } = await pending();
    await finish();
    await authenticateBoardRemoval(f, candidate.connection.id);
    const confirmedActor = { actorType: "user" as const, actorId: f.human, projectDoneConfirmation: { projectId: f.a.id, connectionId: candidate.connection.id } };
    await f.service.archiveConnection(candidate.connection.id, f.companyId, confirmedActor);
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.configured).toBe(true);
    expect(selected.grant).toBeUndefined();
    expect(selected.connection?.id).not.toBe(legacy.connection.id);
    expect((await storedConnection(db, candidate.connection.id)).status).toBe("archived");
  });

  it("A06a: board owner with dead lead/no primary uses existing DELETE; receipt failure rolls back", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.leadA.id));
    await db.update(userCompanyPreferences).set({ primaryAgentId: null }).where(eq(userCompanyPreferences.companyId, f.companyId));
    const success = await request(f.route()).delete(`/api/tool-connections/${connection.id}`);
    expect(success.status).toBe(200);
    expect(await storedConnection(db, connection.id)).toMatchObject({ status: "archived", enabled: false });
    const receipts = await db.select().from(activityLog).where(and(eq(activityLog.entityId, connection.id), eq(activityLog.action, "tool_connection.archived")));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ actorType: "user", actorId: f.human });
    const next = await f.seedConnection(f.a, { installed: false });
    await failReceipt(db, next.connection.id);
    try {
      const failed = await request(f.route()).delete(`/api/tool-connections/${next.connection.id}`);
      expect(failed.status).toBe(500);
      expect(await storedConnection(db, next.connection.id)).toMatchObject({ status: "active", enabled: true });
    } finally { await restoreReceipt(db); }
  });

  it("A06b: B lead acting for the same human gets readable 403, not board removal authority", async () => {
    const f = await projectConnectionFixture(db);
    await removalCustody(f);
    const { connection } = await f.seedConnection();
    const result = await request(f.route(f.leadB.id)).delete(`/api/tool-connections/${connection.id}`);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("project_connection_actor_required");
    expect(await storedConnection(db, connection.id)).toMatchObject({ status: "active", enabled: true });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toHaveLength(0);
  });

  it("A06b: board remove-only preservation does not authorize a mixed disable/rescope PATCH", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.leadA.id));
    await db.update(userCompanyPreferences).set({ primaryAgentId: null }).where(eq(userCompanyPreferences.companyId, f.companyId));
    const changed = await request(f.route()).patch(`/api/tool-connections/${connection.id}`).send({ enabled: false, name: "mixed removal and rescope" });
    expect(changed.status).toBe(403);
    expect(await storedConnection(db, connection.id)).toMatchObject({ enabled: true, name: connection.name });
  });

  it("A08/W2: continuation after the approving actor terminates refuses before provider verification", async () => {
    const { f, candidate, finish } = await pending();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.primary.id));
    await expect(finish()).rejects.toMatchObject({ status: 403 });
    expect(provider.verify).not.toHaveBeenCalled();
    expect((await storedConnection(db, candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: true });
  });

  it("J11: running work blocks archive before any grant/install cleanup", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    await authenticateBoardRemoval(f, connection.id);
    await f.run();
    await expect(f.service.archiveConnection(connection.id, f.companyId, { actorType: "user", actorId: f.human }))
      .rejects.toMatchObject({ status: 409, details: { code: "project_connection_in_use" } });
    expect(await storedConnection(db, connection.id)).toMatchObject({ status: "active", enabled: true });
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0]!.status).toBe("active");
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(1);
  });

  it("A10: archive receipt is in the same transaction; retry does not write a second success", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await authenticateBoardRemoval(f, connection.id);
    await failReceipt(db, connection.id);
    try { await expect(f.service.archiveConnection(connection.id, f.companyId, { actorType: "user", actorId: f.human })).rejects.toThrow(); }
    finally { await restoreReceipt(db); }
    expect(await storedConnection(db, connection.id)).toMatchObject({ enabled: true, status: "active" });
    await f.service.archiveConnection(connection.id, f.companyId, { actorType: "user", actorId: f.human });
    await f.service.archiveConnection(connection.id, f.companyId, { actorType: "user", actorId: f.human });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, connection.id), eq(activityLog.action, "tool_connection.archived")))).toHaveLength(1);
  });

  it("A10: take receipt failure rolls back applications, grants and reservation on the actual transaction", async () => {
    const f = await projectConnectionFixture(db);
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${f.companyId}' AND NEW.action = 'tool_connection.project_taken' THEN RAISE EXCEPTION 'synthetic take receipt persistence failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER project_red_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_red_receipt_failure()"));
    try { await expect(f.service.createConnection(f.companyId, f.input(), f.actor())).rejects.toThrow(); }
    finally { await restoreReceipt(db); }
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId))).toHaveLength(0);
  });

  it("INT-R5/:366 companion: take fails on the injected receipt P0001 after the same create succeeds", async () => {
    const control = await projectConnectionFixture(db); await versionOne(control);
    const controlSource = await control.seedConnection(null, { installed: false });
    await approveFixtureCustodySource(db, control, controlSource);
    const created = await control.service.createConnection(control.companyId, control.input(), control.actor());
    expect(created.projectId).toBe(control.a.id);
    const f = await projectConnectionFixture(db); await versionOne(f);
    const source = await f.seedConnection(null, { installed: false });
    await approveFixtureCustodySource(db, f, source);
    const beforeApplications = await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId));
    const beforeConnections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId));
    const beforeGrants = await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId));
    const beforeInstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, f.companyId));
    const beforeActivity = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${f.companyId}' AND NEW.action = 'tool_connection.project_taken' THEN RAISE EXCEPTION 'synthetic take receipt persistence failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER project_red_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_red_receipt_failure()"));
    try { await expect(f.service.createConnection(f.companyId, f.input(), f.actor())).rejects.toMatchObject({ cause: { code: "P0001", message: "synthetic take receipt persistence failure" } }); }
    finally { await restoreReceipt(db); }
    expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId))).toEqual(beforeApplications);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toEqual(beforeConnections);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId))).toEqual(beforeGrants);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, f.companyId))).toEqual(beforeInstalls);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual(beforeActivity);
  });

  it("A03/W2: explicit finish of archived owner returns terminal typed conflict, never revival", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { status: "archived", installed: false });
    await expect(f.service.finishGalleryAppConnection(f.companyId, connection.id, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [f.leadA.id] } }, f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "project_connection_archived" } });
    expect((await storedConnection(db, connection.id)).status).toBe("archived");
    expect(provider.verify).not.toHaveBeenCalled();
  });

  // Live finding D-RF2-0011: use the actual route/common writer and saved task,
  // with no adjacent-contract mocks. Confirmation is data, never authority.
  it("D-RF2-0011/J11: queued work on A's stored task refuses board retirement with a visible run link and no effects", async () => {
    const f = await projectConnectionFixture(db); const { connection, grant } = await f.seedConnection();
    const work = await f.run();
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, work.run.id));
    const result = await request(f.route()).delete(`/api/tool-connections/${connection.id}`);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: "project_connection_in_use", runs: [{ id: work.run.id, href: `/runs/${work.run.id}` }] });
    expect(await storedConnection(db, connection.id)).toEqual(connection);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0]).toEqual(grant);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toHaveLength(0);
  });

  it("D-RF2-0011/A06b: B's agent for the same human cannot confirm A done or retire it while A work is queued", async () => {
    const f = await projectConnectionFixture(db);
    await removalCustody(f); const { connection, grant } = await f.seedConnection();
    const work = await f.run();
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, work.run.id));
    const result = await request(f.route(f.leadB.id)).delete(`/api/tool-connections/${connection.id}`)
      .send({ projectDoneConfirmation: { projectId: f.a.id, connectionId: connection.id } });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("project_connection_actor_required");
    expect(await storedConnection(db, connection.id)).toEqual(connection);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0]).toEqual(grant);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toHaveLength(0);
  });

  // These additional checks exercise D's actual PostgreSQL transaction and
  // HTTP/remove code with ONLY A/B's not-yet-implemented contracts isolated.
  // They are D data-safety/lock proofs, NOT admission/identity qualification and
  // do not replace or loosen any of the original end-to-end REDs above.
  describe("D transaction boundary (adjacent A/B contracts isolated)", () => {
    beforeEach(() => {
      vi.spyOn(admission, "readProjectConnectionScope").mockImplementation(connection =>
        connection.projectId ? connection.config.projectScope as admission.ProjectConnectionScope : null);
      vi.spyOn(admission, "assertProjectConnectionAdmission").mockResolvedValue(undefined);
      vi.spyOn(arbitration, "lockProjectConnectionIdentities").mockResolvedValue(undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    async function version(f: Awaited<ReturnType<typeof projectConnectionFixture>>) {
      await db.insert(companySecretVersions).values({ secretId: f.secret.id, version: 1,
        material: { synthetic: true }, valueSha256: "synthetic-d-version", fingerprintSha256: "synthetic-d-version" }).onConflictDoNothing();
    }
    async function activate(p: Awaited<ReturnType<typeof pending>>, install = true, failAfterInstall = false) {
      return db.transaction(async tx => {
        await activateProjectConnectionMigration(tx, { connection: p.candidate.connection, actor: p.f.actor(),
          targetAgentIds: [p.f.leadA.id], verifiedRepositoryIds: [101], verifiedSecretVersion: 1 });
        if (install) await tx.insert(toolConnectionInstalls).values({ companyId: p.f.companyId, connectionId: p.candidate.connection.id,
          targetType: "agent", targetId: p.f.leadA.id });
        if (failAfterInstall) await tx.execute(sql`select 1 / 0`);
      });
    }

    it("D/M01: activation and caller installs commit together without touching shared lead's legacy", async () => {
      const p = await pending(); await version(p.f);
      const legacy = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
      await activate(p);
      expect(await storedConnection(db, p.candidate.connection.id)).toMatchObject({ status: "active", enabled: true,
        config: { projectScope: { migrationPending: false } } });
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.candidate.connection.id))).toHaveLength(1);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id))).toEqual(legacy);
      const receipts = await db.select().from(activityLog).where(eq(activityLog.entityId, p.candidate.connection.id));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ action: "tool_connection.updated", actorType: "agent", actorId: p.f.primary.id,
        responsibleUserId: p.f.human, details: { migrationPending: false, reason: "migration_activated", verifiedRepositoryIds: [101] } });
    });

    it.each(["receipt", "install"] as const)("D/M02: actual PG %s failure rolls pending/reach back and preserves legacy", async boundary => {
      const p = await pending(); await version(p.f);
      const legacy = await storedConnection(db, p.legacy.connection.id);
      const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.id));
      if (boundary === "receipt") await failReceipt(db, p.candidate.connection.id);
      try { await expect(activate(p, true, boundary === "install")).rejects.toThrow(); }
      finally { if (boundary === "receipt") await restoreReceipt(db); }
      expect(await storedConnection(db, p.candidate.connection.id)).toEqual(p.candidate.connection);
      expect(await storedConnection(db, legacy.id)).toEqual(legacy);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.candidate.connection.id))).toHaveLength(0);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.id))).toEqual(installs);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, p.candidate.connection.id))).toHaveLength(0);
    });

    it.each(["scope", "key-version", "revoked-version", "recipient", "history", "already-installed"] as const)("D/M02: stale %s refuses activation with zero legacy effects", async stale => {
      const p = await pending(); await version(p.f);
      if (stale === "scope") await db.update(toolConnections).set({ config: { ...p.candidate.connection.config,
        projectScope: { ...p.f.scope(), migrationPending: true, legacyConnectionId: p.legacy.connection.id, approvedRepositoryIds: [202] } } })
        .where(eq(toolConnections.id, p.candidate.connection.id));
      if (stale === "key-version") await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, p.f.secret.id));
      if (stale === "revoked-version") await db.update(companySecretVersions).set({ revokedAt: new Date() }).where(eq(companySecretVersions.secretId, p.f.secret.id));
      if (stale === "recipient") await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
      if (stale === "history") await p.f.seedConnection(p.f.a, { status: "archived", installed: false });
      if (stale === "already-installed") await db.insert(toolConnectionInstalls).values({ companyId: p.f.companyId, connectionId: p.candidate.connection.id, targetType: "agent", targetId: p.f.leadA.id });
      const before = await storedConnection(db, p.candidate.connection.id);
      const legacyInstalls = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id));
      await expect(activate(p, false)).rejects.toMatchObject({ status: 409, details: { code: "project_connection_verification_stale" } });
      expect(await storedConnection(db, before.id)).toEqual(before);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, p.legacy.connection.id))).toEqual(legacyInstalls);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, before.id))).toHaveLength(0);
    });

    it("D/M03: activated state is not reset on repeat activation; archived candidate is terminal", async () => {
      const p = await pending(); await version(p.f); await activate(p);
      const active = await storedConnection(db, p.candidate.connection.id);
      await db.transaction(tx => activateProjectConnectionMigration(tx, { connection: active, actor: p.f.actor(), targetAgentIds: [p.f.leadA.id], verifiedRepositoryIds: [101], verifiedSecretVersion: 1 }));
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, active.id))).toHaveLength(1);
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, p.bound.run.id));
      await p.f.service.archiveConnection(active.id, p.f.companyId, p.f.actor());
      await expect(activate(p, false)).rejects.toMatchObject({ status: 409, details: { code: "project_connection_archived" } });
      expect(await storedConnection(db, active.id)).toMatchObject({ status: "archived", config: { projectScope: { migrationPending: false } } });
    });

    it("D/A06a/A10: actual board DELETE with dead lead/no primary has one atomic human receipt; failure rolls all local effects back", async () => {
      const f = await projectConnectionFixture(db); const { connection, grant } = await f.seedConnection();
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.leadA.id));
      await db.update(userCompanyPreferences).set({ primaryAgentId: null }).where(eq(userCompanyPreferences.companyId, f.companyId));
      await failReceipt(db, connection.id);
      try {
        expect((await request(f.route()).delete(`/api/tool-connections/${connection.id}`)).status).toBe(500);
        expect(await storedConnection(db, connection.id)).toEqual(connection);
        expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0]).toEqual(grant);
        expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(1);
        expect((await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId)))[0]!.status).toBe("active");
      } finally { await restoreReceipt(db); }
      const result = await request(f.route()).delete(`/api/tool-connections/${connection.id}`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ status: "archived", enabled: false, removal: { grantsRevoked: 1, installsRemoved: 1, secretsRevoked: 0 } });
      const receipts = await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ action: "tool_connection.archived", actorType: "user", actorId: f.human,
        responsibleUserId: f.human, details: { removal: { grantsRevoked: 1, installsRemoved: 1 }, projectId: f.a.id } });
      expect((await request(f.route()).delete(`/api/tool-connections/${connection.id}`)).status).toBe(200);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toEqual(receipts);
    });

    it.each(["queued", "starting", "running"])("D/J11: %s project work refuses before grant/install/archive changes", async status => {
      const f = await projectConnectionFixture(db); const { connection, grant } = await f.seedConnection();
      const work = await f.run(); await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, work.run.id));
      await expect(f.service.archiveConnection(connection.id, f.companyId, f.actor())).rejects.toMatchObject({ status: 409, details: {
        code: "project_connection_in_use", runs: [{ id: work.run.id, href: `/runs/${work.run.id}` }],
      } });
      expect(await storedConnection(db, connection.id)).toEqual(connection);
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0]).toEqual(grant);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toHaveLength(0);
    });

    it.each(["native", "snapshot-issue", "snapshot-task"] as const)("D/J11 stored task binding: %s queued work without a direct issueId still protects A", async binding => {
      const f = await projectConnectionFixture(db); const { connection } = await f.seedConnection(f.a, { installed: false });
      const work = await f.run();
      await db.update(heartbeatRuns).set({ issueId: null, status: "queued",
        nativeIssueId: binding === "native" ? work.issue.id : null,
        contextSnapshot: binding === "snapshot-issue" ? { issueId: ` ${work.issue.id} ` }
          : binding === "snapshot-task" ? { issueId: " ", taskId: work.issue.id } : {},
      }).where(eq(heartbeatRuns.id, work.run.id));
      await expect(f.service.archiveConnection(connection.id, f.companyId, f.actor())).rejects.toMatchObject({ status: 409,
        details: { code: "project_connection_in_use", runs: [{ id: work.run.id, href: `/runs/${work.run.id}` }] } });
      expect(await storedConnection(db, connection.id)).toEqual(connection);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toHaveLength(0);
    });

    it("D/J11: same shared agent's B work is not A's work; null-task work is conservatively protected", async () => {
      const f = await projectConnectionFixture(db, true); const { connection } = await f.seedConnection();
      await f.run(f.b);
      await expect(db.transaction(tx => assertProjectConnectionNotInUse(tx, { companyId: f.companyId, projectId: f.a.id, connectionId: connection.id }))).resolves.toBeUndefined();
      const taskless = await f.run(null);
      await expect(db.transaction(tx => assertProjectConnectionNotInUse(tx, { companyId: f.companyId, projectId: f.a.id, connectionId: connection.id }))).rejects.toMatchObject({ status: 409 });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, taskless.run.id));
      const removed = await f.service.archiveConnection(connection.id, f.companyId, f.actor());
      expect(removed.connection.status).toBe("archived");
    });

    it("D/J11: generic force/project-done status is not confirmation; exact caller-scoped confirmation is explicit", async () => {
      const f = await projectConnectionFixture(db); const { connection } = await f.seedConnection(); await f.run();
      await db.update(projects).set({ status: "completed" }).where(eq(projects.id, f.a.id));
      await expect(f.service.archiveConnection(connection.id, f.companyId, { ...f.actor(), force: true } as ReturnType<typeof f.actor>)).rejects.toMatchObject({ status: 409 });
      const wrong = { actorType: "user" as const, actorId: f.human, projectDoneConfirmation: { projectId: f.b.id, connectionId: connection.id } };
      expect((await request(f.route()).delete(`/api/tool-connections/${connection.id}`).send({ projectDoneConfirmation: wrong.projectDoneConfirmation })).status).toBe(409);
      const confirmation = { projectId: f.a.id, connectionId: connection.id };
      expect((await request(f.route()).delete(`/api/tool-connections/${connection.id}`).send({ projectDoneConfirmation: confirmation })).status).toBe(200);
      const [receipt] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, connection.id), eq(activityLog.action, "tool_connection.archived")));
      expect(receipt?.details).toMatchObject({ projectDoneConfirmed: true, projectId: f.a.id, connectionId: connection.id });
      // A conflicting retry cannot turn the state-bound receipt into a replay API.
      expect((await request(f.route()).delete(`/api/tool-connections/${connection.id}`).send({ projectDoneConfirmation: wrong.projectDoneConfirmation })).status).toBe(409);
    });

    it("D/J11 race: lifecycle row serializes same-project admission/retire, not unrelated projects", async () => {
      const f = await projectConnectionFixture(db); const { connection } = await f.seedConnection();
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
      const admissionTx = db.transaction(async tx => { await lockProjectConnectionLifecycle(tx, { companyId: f.companyId, projectId: f.a.id });
        await tx.update(issues).set({ title: "admitted under project lock" }).where(eq(issues.companyId, f.companyId)); entered(); await held; });
      await ready;
      try {
        await expect(db.transaction(async tx => { await tx.execute(sql`set local lock_timeout = '100ms'`);
          await lockProjectConnectionLifecycle(tx, { companyId: f.companyId, projectId: f.a.id }); })).rejects.toThrow();
        await expect(db.transaction(tx => lockProjectConnectionLifecycle(tx, { companyId: f.companyId, projectId: f.b.id }))).resolves.toBeUndefined();
      } finally { release(); await admissionTx; }
      await expect(db.transaction(tx => lockProjectConnectionLifecycle(tx, { companyId: f.b.id, projectId: f.a.id }))).rejects.toMatchObject({ status: 404 });
      await expect(db.transaction(tx => assertProjectConnectionNotInUse(tx, { companyId: f.companyId, projectId: f.b.id, connectionId: connection.id }))).rejects.toMatchObject({ status: 404 });
    });

    it("D/J11 run-start race: a run committed under lifecycle lock is seen by the waiting actual retire writer", async () => {
      const f = await projectConnectionFixture(db); const { connection } = await f.seedConnection();
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Admitted work", projectId: f.a.id,
        assigneeAgentId: f.leadA.id, responsibleUserId: f.human }).returning();
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
      const starting = db.transaction(async tx => {
        await lockProjectConnectionLifecycle(tx, { companyId: f.companyId, projectId: f.a.id });
        await tx.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id, issueId: issue!.id, scopeKind: "issue", status: "queued" });
        entered(); await held;
      });
      await Promise.race([ready, starting]);
      const retirement = f.service.archiveConnection(connection.id, f.companyId, f.actor()).then(value => ({ value }), error => ({ error }));
      try { release(); await starting; }
      finally { release(); await starting; }
      expect(await retirement).toMatchObject({ error: { status: 409, details: { code: "project_connection_in_use" } } });
      expect(await storedConnection(db, connection.id)).toEqual(connection);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toHaveLength(0);
    });

    it("D/A06 receipt visibility: transactional disable and activation receipts remain visible in the existing activity reader", async () => {
      const f = await projectConnectionFixture(db); const { connection } = await f.seedConnection();
      await db.transaction(async tx => {
        const [disabled] = await tx.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connection.id)).returning();
        await writeProjectConnectionReceipt(tx, { connection: disabled!, actor: { actorType: "user", actorId: f.human },
          action: "tool_connection.updated", reason: "connection_disabled" });
      });
      const activity = await f.service.listConnectionActivity(connection.id, f.companyId);
      expect(activity.lifecycleEvents).toEqual([expect.objectContaining({ connectionId: connection.id, type: "app_paused", actorType: "user", actorId: f.human })]);
      const p = await pending(); await version(p.f); await activate(p);
      const activation = await p.f.service.listConnectionActivity(p.candidate.connection.id, p.f.companyId);
      expect(activation.lifecycleEvents).toEqual([expect.objectContaining({ connectionId: p.candidate.connection.id, type: "app_resumed", actorId: p.f.primary.id })]);
    });

    it("D/A10: no activity publication before commit; failed post-commit publication retains one durable receipt", async () => {
      const f = await projectConnectionFixture(db); const { connection } = await f.seedConnection();
      const publication = vi.spyOn(activityService, "publishActivity").mockImplementation(() => { throw new Error("synthetic realtime failure"); });
      await failReceipt(db, connection.id);
      try { await expect(f.service.archiveConnection(connection.id, f.companyId, f.actor())).rejects.toThrow(); }
      finally { await restoreReceipt(db); }
      expect(publication).not.toHaveBeenCalled();
      await expect(f.service.archiveConnection(connection.id, f.companyId, f.actor())).resolves.toMatchObject({ connection: { status: "archived" } });
      expect(publication).toHaveBeenCalledTimes(1);
      const receipts = await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id));
      expect(receipts).toHaveLength(1);
      await f.service.archiveConnection(connection.id, f.companyId, f.actor());
      expect(publication).toHaveBeenCalledTimes(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toEqual(receipts);
    });

    it("D/A10/A11: removal stays local; retained ownership/approval and B/shared key survive; new retake has distinct receipt", async () => {
      const f = await projectConnectionFixture(db, true); const a = await f.seedConnection(); const b = await f.seedConnection(f.b);
      const key = (await db.select().from(companySecrets).where(eq(companySecrets.id, f.secret.id)))[0];
      const removed = await f.service.archiveConnection(a.connection.id, f.companyId, f.actor());
      expect(removed.removal.secretsRevoked).toBe(0);
      expect(await storedConnection(db, a.connection.id)).toMatchObject({ projectId: f.a.id, config: a.connection.config,
        credentialRefs: [], credentialSecretRefs: [], status: "archived", enabled: false });
      expect(await storedConnection(db, b.connection.id)).toEqual(b.connection);
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, b.grant.id)))[0]).toEqual(b.grant);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, b.connection.id))).toHaveLength(1);
      expect((await db.select().from(companySecrets).where(eq(companySecrets.id, f.secret.id)))[0]).toEqual(key);
      expect(provider.verify).not.toHaveBeenCalled(); expect(provider.acquire).not.toHaveBeenCalled();
      const next = await f.seedConnection();
      await db.transaction(tx => writeProjectConnectionReceipt(tx, { connection: next.connection, actor: f.actor(), action: "tool_connection.project_taken",
        reason: "synthetic-PEM-token-canary", targetAgentIds: [f.leadA.id], verifiedRepositoryIds: [101] }));
      const receipts = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      expect(receipts).toHaveLength(2);
      expect(receipts[0]!.id).not.toBe(receipts[1]!.id);
      expect(JSON.stringify(receipts)).not.toContain("synthetic-PEM-token-canary");
      await expect(db.transaction(tx => writeProjectConnectionReceipt(tx, { connection: next.connection, actor: f.actor(), action: "tool_connection.project_taken" }))).rejects.toMatchObject({ status: 409 });
    });
  });
});
