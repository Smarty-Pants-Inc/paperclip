import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { CANARY, projectConnectionFixture } from "./helpers/project-connections-fixture.js";

const provider = vi.hoisted(() => ({
  secret: vi.fn(async () => ({ value: "synthetic-project-key-never-return-this", latestVersion: 1 })),
  acquire: vi.fn<(namespace: string, config: import("../services/github-app-client.js").GitHubAppConfig, key: string, force?: boolean) => Promise<import("../services/github-app-client.js").AppCredential>>(async () => ({ token: "synthetic-restricted-token", expiresAt: Date.now() + 3600000, verifiedRegistrationId: "123",
    github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [{ id: "101", fullName: "owner/A", installationId: "456", private: true }] },
  })),
}));
vi.mock("../services/connection-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/connection-credentials.js")>(), resolveConnectionGrantSecret: provider.secret,
}));
vi.mock("../services/github-app-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/github-app-client.js")>(), createGitHubAppClient: () => ({ acquire: provider.acquire }),
}));
import { resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { parseGitHubAppConfig } from "../services/github-app-client.js";
import { verifyProjectConnectionGitHubScope } from "../services/project-connection-provider-scope.js";

describe("project connection stable-ID envelope at credential release", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-provider-"); db = createDb(database.connectionString); }, 60_000);
  beforeEach(() => { provider.secret.mockClear(); provider.acquire.mockClear(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  it("J05/A09: provider seam returns canonical registration/repository/version facts, not credentials", async () => {
    const facts = await verifyProjectConnectionGitHubScope({ companyId: "synthetic-company", namespace: "synthetic-candidate",
      config: parseGitHubAppConfig({ appId: "Iv1syntheticclient", installationId: "456", repositories: "owner/A", permissionProfile: "read" }),
      privateKey: CANARY, secretVersion: 7 });
    expect(facts).toEqual({ identity: { companyId: "synthetic-company", providerHost: "github.com",
      verifiedRegistrationId: "123", canonicalInstallationKey: "github.com/github-app-installation/456" }, repositoryIds: [101], secretVersion: 7 });
    expect(JSON.stringify(facts)).not.toContain(CANARY);
    expect(JSON.stringify(facts)).not.toContain("synthetic-restricted-token");
    expect(provider.acquire).toHaveBeenCalledWith("synthetic-company:synthetic-candidate:7", expect.anything(), CANARY, true);
  });

  it("J05: provider seam refuses an empty returned stable-ID set without exporting the token", async () => {
    provider.acquire.mockImplementationOnce(async () => ({ token: "synthetic-empty-scope", expiresAt: Date.now() + 3600000, verifiedRegistrationId: "123",
      github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 0, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [] } }));
    await expect(verifyProjectConnectionGitHubScope({ companyId: "synthetic-company", namespace: "empty",
      config: parseGitHubAppConfig({ appId: "123", installationId: "456", repositories: "owner/A", permissionProfile: "read" }),
      privateKey: CANARY, secretVersion: 1 })).rejects.toMatchObject({ details: { code: "github_app_access_unavailable" } });
  });

  it("J05/A02: a valid nonempty shard is allowed, but a token's wrong stable repo ID is denied", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    const good = await resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id);
    expect(good.token).toBe("synthetic-restricted-token");
    expect(JSON.stringify(good)).not.toContain(CANARY);
    provider.acquire.mockImplementationOnce(async () => ({ token: "synthetic-wrong-repo-token", expiresAt: Date.now() + 3600000, verifiedRegistrationId: "123",
      github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [{ id: "202", fullName: "owner/A", installationId: "456", private: true }] },
    }));
    // A repository retaining the same owner/name but changing stable ID is not
    // the approved repository, even though BASE's name check would accept it.
    await expect(resolveGitHubAppCredential(db, connection, grant, false, true, f.leadA.id)).rejects.toThrow();
  });

  it("INT-R2/R05: retain the exact wrong-repository typed refusal alongside the frozen assertion", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    expect((await resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id)).token).toBe("synthetic-restricted-token");
    provider.acquire.mockImplementationOnce(async () => ({ token: "synthetic-wrong-repo-token", expiresAt: Date.now() + 3600000, verifiedRegistrationId: "123",
      github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [{ id: "202", fullName: "owner/A", installationId: "456", private: true }] } }));
    await expect(resolveGitHubAppCredential(db, connection, grant, false, true, f.leadA.id)).rejects.toMatchObject({ details: { code: "github_app_access_unavailable" } });
  });

  it.each(["wrong-repo", "malformed", "unapproved-ref"] as const)("RFL-C5/J05/A12 companion: %s returns the intended typed refusal", async kind => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    expect((await resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id)).token).toBe("synthetic-restricted-token");
    let candidate = connection;
    if (kind === "wrong-repo") provider.acquire.mockImplementationOnce(async () => ({ token: "synthetic-wrong-repo-token", expiresAt: Date.now() + 3600000, verifiedRegistrationId: "123",
      github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [{ id: "202", fullName: "owner/A", installationId: "456", private: true }] } }));
    else {
      const projectScope = kind === "malformed" ? { version: 1 } : { ...f.scope(), approvedSecretRefs: [] };
      [candidate] = await db.update(toolConnections).set({ config: { ...connection.config, projectScope } }).where(eq(toolConnections.id, connection.id)).returning() as [typeof connection];
    }
    await expect(resolveGitHubAppCredential(db, candidate, grant, false, true, f.leadA.id)).rejects.toMatchObject({ details: { code: "github_app_access_unavailable" } });
  });

  it("J17/A05: a real provider cache hit is reauthorized and refused after grant revocation", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const actual = await vi.importActual<typeof import("../services/github-app-client.js")>("../services/github-app-client.js");
    const http = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app") return Response.json({ id: 123, slug: "project-fixture" });
      if (path === "/app/installations/456") return Response.json({ id: 456, app_id: 123, account: { login: "owner" },
        permissions: { contents: "write", pull_requests: "write", issues: "read" } });
      if (path.endsWith("/access_tokens")) return Response.json({ token: "synthetic-cached-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
      if (path.startsWith("/users/")) return Response.json({ id: 123, login: "project-fixture[bot]", type: "Bot" });
      if (path === "/installation/repositories") return Response.json({ repositories: [{ id: 101, full_name: "owner/A", private: true }] });
      throw new Error(`Unexpected synthetic provider path ${path}`);
    });
    const cached = actual.createGitHubAppClient(http);
    provider.secret.mockResolvedValue({ value: key, latestVersion: 1 });
    provider.acquire.mockImplementation(cached.acquire);
    try {
      expect((await resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id)).token).toBe("synthetic-cached-token");
      const requests = http.mock.calls.length;
      expect(requests).toBeGreaterThan(0);
      expect((await resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id)).token).toBe("synthetic-cached-token");
      expect(http).toHaveBeenCalledTimes(requests); // actual cache HIT, not a second mint
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, grant.id));
      await expect(resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id)).rejects.toMatchObject({ details: { code: "github_app_access_unavailable" } });
      expect(http).toHaveBeenCalledTimes(requests);
    } finally {
      provider.secret.mockResolvedValue({ value: CANARY, latestVersion: 1 });
      provider.acquire.mockImplementation(async () => ({ token: "synthetic-restricted-token", expiresAt: Date.now() + 3600000, verifiedRegistrationId: "123",
        github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [{ id: "101", fullName: "owner/A", installationId: "456", private: true }] } }));
    }
  });

  it("INT-R2/R06: retain the exact malformed-envelope typed refusal alongside the frozen assertion", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    expect((await resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id)).token).toBe("synthetic-restricted-token");
    provider.secret.mockClear(); provider.acquire.mockClear();
    const [malformed] = await db.update(toolConnections).set({ config: { ...connection.config, projectScope: { version: 1 } } }).where(eq(toolConnections.id, connection.id)).returning();
    await expect(resolveGitHubAppCredential(db, malformed!, grant, false, false, f.leadA.id)).rejects.toMatchObject({ details: { code: "github_app_access_unavailable" } });
    expect(provider.secret).not.toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("A12: a malformed owned approval envelope fails closed before the private-key read", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    const config = { ...connection.config, projectScope: { version: 1 } };
    const [malformed] = await db.update(toolConnections).set({ config }).where(eq(toolConnections.id, connection.id)).returning();
    await expect(resolveGitHubAppCredential(db, malformed!, grant, false, false, f.leadA.id)).rejects.toThrow();
    expect(provider.secret).not.toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("J15: manager App cannot be exported by bypassing the ordinary selector", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    const config = { ...connection.config, projectScope: { ...f.scope(), approvedSecretRefs: [] } };
    const [unapproved] = await db.update(toolConnections).set({ config }).where(eq(toolConnections.id, connection.id)).returning();
    await expect(resolveGitHubAppCredential(db, unapproved!, grant, false, false, f.leadA.id)).rejects.toThrow();
    expect(provider.secret).not.toHaveBeenCalled();
  });
});
