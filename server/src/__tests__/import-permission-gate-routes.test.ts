import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { agents, authUsers, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { agentPermissionGrantRoutes } from "../routes/agent-permission-grants.js";

const permissionKey = "tasks:assign_scope";
const actors = ["board-with", "board-without", "agent-within", "agent-outside"] as const;
type ActorCase = typeof actors[number];

// Trust-boundary regression: real routers, authorization and embedded-PG writes.
// Compare the same authenticated actor and resolved grant scope, not every
// import/PATCH behavior (imports retain their existing 422 delegation refusal).
describe("import permission replay uses PATCH's actor gate", () => {
  let db: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-import-permission-gate-");
    db = createDb(fixture.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  async function seed(kind: ActorCase) {
    const companyId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Permission gate", issuePrefix: `L${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Member", email: `${userId}@example.com`,
      createdAt: new Date(), updatedAt: new Date() });
    const [ceo] = await db.insert(agents).values({ companyId, name: "CEO", role: "ceo", adapterType: "codex_local",
      permissions: { canCreateAgents: true }, adapterConfig: {} }).returning();
    const [root, peer] = await db.insert(agents).values([
      { companyId, name: "Scope root", role: "engineer", reportsTo: ceo!.id, adapterType: "codex_local", adapterConfig: {} },
      { companyId, name: "Denied peer", role: "engineer", adapterType: "codex_local", adapterConfig: {} },
    ]).returning();
    const [patchTarget] = await db.insert(agents).values({ companyId, name: "PATCH target", role: "engineer",
      reportsTo: root!.id, adapterType: "codex_local", adapterConfig: {} }).returning();
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "member", status: "active" },
      ...[ceo!, root!, peer!, patchTarget!].map(a => ({ companyId, principalType: "agent", principalId: a.id,
        membershipRole: "member", status: "active" })),
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: ceo!.id, permissionKey: "agents:configure", scope: { subtreeRootAgentId: ceo!.id } },
      { companyId, principalType: "agent", principalId: ceo!.id, permissionKey,
        scope: { subtreeRootAgentId: kind === "agent-outside" ? peer!.id : root!.id } },
      ...(kind === "board-with" ? [{ companyId, principalType: "user", principalId: userId, permissionKey: "users:manage_permissions" }] : []),
    ]);
    const actor: Express.Request["actor"] = kind.startsWith("board")
      ? { type: "board", source: "session", userId, companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "member", status: "active" }] }
      : { type: "agent", source: "agent_key", agentId: ceo!.id, companyId, keyId: randomUUID() };
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => { req.actor = actor; next(); });
    api.use("/api/companies", companyRoutes(db));
    api.use("/api", agentPermissionGrantRoutes(db));
    api.use(errorHandler);
    return { companyId, root: root!, peer: peer!, patchTarget: patchTarget!, api };
  }
  function bundle(f: Awaited<ReturnType<typeof seed>>, scopeId: string, alias: boolean, skippedGrantee = false) {
    const sourceId = randomUUID();
    const aliasSlug = scopeId === f.root.id ? "scope-root" : "denied-peer";
    const granteeSlug = skippedGrantee ? "patch-target" : "import-target";
    const slugs = [granteeSlug, ...(alias ? [aliasSlug] : [])];
    const files: Record<string, string> = {
      "COMPANY.md": `---\nname: Permission gate\nincludes:\n${slugs.map(s => `  - agents/${s}/AGENTS.md`).join("\n")}\n---\n`,
      ".paperclip.yaml": stringify({ schema: "paperclip/v1", agents: {
        [granteeSlug]: { role: "engineer", reportsToExistingAgentId: f.root.id,
          adapter: { type: "codex_local", runner: "legacy", config: {} },
          permissionGrants: [{ permissionKey, scope: { subtreeRootAgentId: alias ? sourceId : scopeId } }] },
        ...(alias ? { [aliasSlug]: { sourceAgentId: sourceId, role: "engineer",
          adapter: { type: "codex_local", runner: "legacy", config: {} } } } : {}),
      } }),
    };
    for (const slug of slugs) files[`agents/${slug}/AGENTS.md`] = `---\nname: ${slug}\nslug: ${slug}\nkind: agent\n---\n\nImported.\n`;
    return { source: { type: "inline", files }, target: { mode: "existing_company", companyId: f.companyId },
      include: { company: false, agents: true, projects: false, issues: false, skills: false }, agents: "all", collisionStrategy: "skip" };
  }
  for (const kind of actors) {
    it.each([
      ["direct report scope", false, false], ["skipped report alias", false, true],
      ["denied peer scope", true, false], ["skipped denied peer alias", true, true],
    ] as const)(`${kind}: %s matches PATCH allow/deny`, async (label, peer, alias) => {
      const f = await seed(kind), scopeId = peer ? f.peer.id : f.root.id;
      const patch = await request(f.api).patch(`/api/agents/${f.patchTarget.id}/permission-grants`)
        .send({ permissionKey, enabled: true, scope: { subtreeRootAgentId: scopeId } });
      const imported = await request(f.api).post(`/api/companies/${f.companyId}/imports/apply`).send(bundle(f, scopeId, alias));
      const expectedAllowed = kind === "board-with" || (kind === "agent-within" && !peer);
      console.log(JSON.stringify({ row: `${kind}:${label}`, companyId: f.companyId, scopeId,
        patchStatus: patch.status, importStatus: imported.status, importError: imported.body.error }));
      expect.soft(patch.status, patch.text).toBe(expectedAllowed ? 200 : 403);
      expect.soft(imported.status < 300, imported.text).toBe(expectedAllowed);
      const target = (await db.select().from(agents).where(eq(agents.companyId, f.companyId)))
        .find(a => a.name === "import-target");
      const replayed = target ? await db.select().from(principalPermissionGrants).where(and(
        eq(principalPermissionGrants.principalId, target.id), eq(principalPermissionGrants.permissionKey, permissionKey),
      )) : [];
      expect.soft(replayed).toEqual(expectedAllowed ? [expect.objectContaining({ scope: { subtreeRootAgentId: scopeId } })] : []);
    });
    it(`${kind}: skipping the grantee does not replay its grant`, async () => {
      const f = await seed(kind);
      const imported = await request(f.api).post(`/api/companies/${f.companyId}/imports/apply`)
        .send(bundle(f, f.peer.id, true, true));
      expect(imported.status, imported.text).toBe(200);
      expect(await db.select().from(principalPermissionGrants).where(and(
        eq(principalPermissionGrants.principalId, f.patchTarget.id), eq(principalPermissionGrants.permissionKey, permissionKey),
      ))).toEqual([]);
    });
  }
});
