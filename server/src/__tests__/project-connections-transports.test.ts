import "./helpers/project-connections-approval-http.js";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { connectionGrants, createDb, heartbeatRuns, issues, toolCatalogEntries, toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

const provider = vi.hoisted(() => ({ acquire: vi.fn(async (_db: unknown, connection: { id: string }) => ({
  token: `synthetic-transport-token-${connection.id}`, expiresAt: Date.now() + 3600000,
  github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] },
})) }));
vi.mock("../services/github-app-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/github-app-credentials.js")>(), resolveGitHubAppCredential: provider.acquire,
}));
import { resolveNativeRuntimeMcpSnapshot } from "../services/native-runtime/runtime-context.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { createNativeGitHubAccess } from "../services/native-runtime/native-github-access.js";

// Synthetic transport probes, not the A13 real daily-work journey. The actual
// operation resolver / localhost native broker run; no GitHub API is contacted.
describe("project connection shell/native operation parity", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-transports-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  async function shared() {
    const f = await projectConnectionFixture(db, true);
    const a = await f.seedConnection(f.a);
    const b = await f.seedConnection(f.b);
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, b.connection.id));
    await db.update(connectionGrants).set({ createdAt: new Date(Date.now() + 10000) }).where(eq(connectionGrants.id, b.grant.id));
    const bound = await f.run();
    // Seed the DB-owned admission pair for credential-level transport probes.
    // This is NOT proof of the outside-C queue's actual admission integration.
    const [task] = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, bound.issue.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...bound.run.contextSnapshot,
      projectConnectionRunContext: { version: 1, issueId: bound.issue.id, projectId: task!.projectId },
    } }).where(eq(heartbeatRuns.id, bound.run.id));
    await initializeRunIdentity(db, { companyId: f.companyId, runId: bound.run.id, responsibleUserId: f.human, cause: "instruction" });
    return { f, a, b, bound, input: { companyId: f.companyId, agentId: f.leadA.id, runId: bound.run.id } };
  }

  it("RFL-C1/J17/J18: real native discovery with an active identity pins only the task A catalog", async () => {
    const { f, a, b, bound } = await shared();
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.companyId, name: "Native catalog qualification", profileKey: "native-fixture", defaultAction: "deny" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: f.companyId, profileId: profile!.id, targetType: "agent", targetId: f.leadA.id });
    const catalogs: { id: string; connectionId: string }[] = [];
    for (const owned of [a, b]) {
      await db.update(toolConnections).set({ transport: "mcp_remote", healthStatus: "healthy" }).where(eq(toolConnections.id, owned.connection.id));
      const [entry] = await db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: owned.connection.applicationId,
        connectionId: owned.connection.id, name: "read_file", toolName: "read_file", riskLevel: "read", isReadOnly: true,
        inputSchema: { type: "object" }, versionHash: "native-fixture" }).returning();
      catalogs.push(entry!);
      await db.insert(toolProfileEntries).values({ companyId: f.companyId, profileId: profile!.id, selectorType: "connection", effect: "include", connectionId: owned.connection.id });
    }
    const result = await resolveNativeRuntimeMcpSnapshot({ db, agent: f.leadA, runId: bound.run.id });
    const expected = createHash("sha256").update(JSON.stringify({ version: 1, agentId: f.leadA.id,
      connections: [a.connection.id], tools: catalogs.filter(c => c.connectionId === a.connection.id).map(c => c.id).sort() })).digest("hex");
    expect(result).toEqual({ assignmentSetId: `sha256:${expected}`, digest: expected, bindingId: `native-mcp:${bound.run.id}` });
  });

  it("J17/A07 shell Git/gh operation resolver selects task A, not healthier B", async () => {
    const { a, b, input } = await shared();
    const selected = await resolveGitHubOperationCredentials(db, input);
    expect(selected.status).toBe("available");
    expect(selected.connectionId).toBe(a.connection.id);
    expect(selected.connectionId).not.toBe(b.connection.id);
    expect(JSON.stringify(selected.env)).toContain(`synthetic-transport-token-${a.connection.id}`);
  });

  it("A05/A07 warm operation after a task project move refuses rather than silently reusing/switching", async () => {
    const { f, a, b, bound, input } = await shared();
    const first = await resolveGitHubOperationCredentials(db, input);
    expect(first.connectionId).toBe(a.connection.id);
    await db.update(issues).set({ projectId: f.b.id }).where(eq(issues.id, bound.issue.id));
    const next = await resolveGitHubOperationCredentials(db, input);
    expect(next.status).toBe("unavailable");
    expect(next.connectionId).not.toBe(b.connection.id);
    expect(next.env).toEqual({});
  });

  it("J18/A07 native broker ignores body/header project B and threads its controller's task A", async () => {
    const { f, a, b, bound, input } = await shared();
    const cwd = await mkdtemp(join(tmpdir(), "project-native-red-"));
    const broker = await createNativeGitHubAccess({
      scope: { companyId: f.companyId, agentId: f.leadA.id, issueId: bound.issue.id },
      target: null, cwd, env: { PATH: process.env.PATH },
      resolveCredentials: binding => resolveGitHubOperationCredentials(db, binding),
    }, async () => null);
    try {
      const release = await broker.activate({ ...input, issueId: bound.issue.id });
      try {
        const response = await fetch(`${broker.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/credentials`, {
          method: "POST", headers: { authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`, "content-type": "application/json", "x-project-id": f.b.id },
          body: JSON.stringify({ projectId: f.b.id, grantId: b.grant.id, repository: "owner/B" }),
        });
        expect(response.status).toBe(200);
        const selected = await response.json() as { status: string; connectionId?: string };
        expect(selected.status).toBe("available");
        expect(selected.connectionId).toBe(a.connection.id);
        expect(selected.connectionId).not.toBe(b.connection.id);
      } finally { await release(); }
    } finally { await broker.stop(); }
    // cwd is deliberately preserved under task TMPDIR (the task's disk rule).
  });
});
