import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, createDb, toolApplications, toolConnections, toolConnectionInstalls, toolProfiles } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture } from "./helpers/project-connections-fixture.js";

// Keep the non-route hiring writer real; only unrelated durable instruction /
// identity provisioning is stubbed. No actual secret or host identity is used.
vi.mock("../services/agent-file-durability.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/agent-file-durability.js")>(), initializeDurableAgentFiles: async () => undefined,
}));
vi.mock("../services/agent-identity.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/agent-identity.js")>(), agentIdentityService: () => ({ ensureAgentIdentity: async () => undefined }),
}));
import { initializeAgentHire } from "../services/agent-hiring.js";
import { connectionManagementService } from "../services/connection-management.js";

describe("project connection alternate saved-resource writers (A08)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-writers-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  it("A08/W9 compatibility: MCP preview is data only, even with forged project/assignment metadata", async () => {
    const f = await projectConnectionFixture(db);
    const preview = await f.service.previewMcpJsonImport({ mcpJson: { mcpServers: { attack: {
      url: "https://mcp.invalid/", projectId: f.a.id, projectScope: f.scope(), enabled: true,
      access: { agentIds: [f.outsider.id] }, headers: { Authorization: "synthetic-preview-token" },
    } } } });
    expect(preview.drafts).toHaveLength(1);
    expect(preview.drafts[0]!.status).toBe("draft");
    expect(preview.drafts[0]).not.toHaveProperty("projectId");
    expect(preview.drafts[0]!.config).not.toHaveProperty("projectScope");
    expect(JSON.stringify(preview)).not.toContain("synthetic-preview-token");
    for (const table of [toolConnections, toolConnectionInstalls, activityLog]) {
      expect(await db.select().from(table).where(eq(table.companyId, f.companyId))).toHaveLength(0);
    }
  });

  it.each([false, true])("A08/W8: non-route hiring rejects an owned TOOL passed as AI install (member=%s)", async member => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    const owned = connection.id;
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId, name: randomUUID(), type: "rest_api" }).returning();
    const [ai] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application!.id, name: randomUUID(), uid: randomUUID(), connectionPurpose: "ai", transport: "runtime_auth" }).returning();
    // member=true uses a valid null-purpose AI main ID, so a check of only the
    // main connection cannot hide the forged TOOL member.
    await expect(db.transaction(async tx => initializeAgentHire(tx as unknown as typeof db, f.worker, {
      setupOnly: true, aiConnectionInstall: { connectionId: member ? ai!.id : owned, ...(member ? { memberConnectionIds: [owned] } : {}), createdByUserId: f.human },
    }))).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, owned))).toHaveLength(0);
  });

  it("A08/W5: profile removal cannot strip a running project's protected access behind the retire gate", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "agent", targetId: f.leadA.id }] }, f.actor());
    const [profile] = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, f.companyId), eq(toolProfiles.profileKey, `app:${connection.id}`)));
    expect(profile).toBeDefined();
    await f.run();
    const management = await connectionManagementService(db).authorize(
      { type: "agent", companyId: f.companyId, agentId: f.primary.id, source: "agent_key", onBehalfOfUserId: f.human },
      "connections:profiles", { type: "connection_management", companyId: f.companyId, profileId: profile!.id, operation: "DELETE /tool-profiles/:profileId" },
    );
    await expect(f.service.deleteProfile(profile!.id, { force: true }, management))
      .rejects.toMatchObject({ status: 409, details: { code: "project_connection_in_use" } });
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.id, profile!.id))).toHaveLength(1);
  });
});
