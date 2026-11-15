import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const permissionKey = "agents:configure-reports-runtime";

(support.supported ? describe : describe.skip)("runner report runtime default migration", () => {
  it("adds a revocable runtime grant once, preserving scopes and existing trust restrictions", async () => {
    const database = await startEmbeddedPostgresTestDatabase("report-runtime-defaults-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Runtime defaults', 'RTD') RETURNING id`;
      const candidates = [
        { name: "Standard" }, { name: "Scoped configure" }, { name: "Scoped runtime" },
        { name: "Low trust", permissions: { trustPreset: "low_trust_review" } },
        { name: "Nested low trust", permissions: { authorizationPolicy: { trustBoundary: { mode: "low_trust_review" } } } },
        { name: "Built in", metadata: { paperclipBuiltInAgent: { key: "summarizer" } } },
        { name: "Setup", lifecycleState: "paused", lifecycleHolds: ["setup"] },
        { name: "Pending", status: "pending_approval" }, { name: "Terminated", status: "terminated" },
        { name: "Inactive", membershipStatus: "inactive" },
      ];
      const ids = new Map<string, string>();
      for (const candidate of candidates) {
        const id = randomUUID(); ids.set(candidate.name, id);
        await sql`INSERT INTO agents (id, company_id, name, status, lifecycle_state, lifecycle_holds, permissions, metadata)
          VALUES (${id}, ${company!.id}, ${candidate.name}, ${candidate.status ?? "idle"},
          ${candidate.lifecycleState ?? "ready"}, ${sql.json(candidate.lifecycleHolds ?? [])},
          ${sql.json(candidate.permissions ?? {})}, ${sql.json(candidate.metadata ?? {})})`;
        await sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
          VALUES (${company!.id}, 'agent', ${id}, ${candidate.membershipStatus ?? "active"}, 'member')`;
      }
      const scope = { subtreeRootAgentId: ids.get("Scoped configure")! };
      await sql`INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key, scope)
        VALUES (${company!.id}, 'agent', ${ids.get("Scoped configure")!}, 'agents:configure', ${sql.json(scope)}),
        (${company!.id}, 'agent', ${ids.get("Scoped runtime")!}, ${permissionKey}, ${sql.json(scope)})`;
      const content = await readFile(new URL("./migrations/0488_report_runtime_defaults.sql", import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await applyPendingMigrations(database.connectionString);
      const grants = await sql`SELECT principal_id, scope FROM principal_permission_grants WHERE permission_key = ${permissionKey}`;
      expect(grants).toHaveLength(3);
      expect(grants).toEqual(expect.arrayContaining([
        { principal_id: ids.get("Standard"), scope: null },
        { principal_id: ids.get("Scoped configure"), scope: null },
        { principal_id: ids.get("Scoped runtime"), scope },
      ]));
      expect((await sql`SELECT scope FROM principal_permission_grants WHERE permission_key = 'agents:configure'`)[0]!.scope).toEqual(scope);
      expect(await sql`SELECT id FROM activity_log WHERE actor_id = 'migration:report-runtime-defaults'`).toHaveLength(2);
      await sql.unsafe(content);
      expect(await sql`SELECT id FROM activity_log WHERE actor_id = 'migration:report-runtime-defaults'`).toHaveLength(2);
      await sql`DELETE FROM principal_permission_grants WHERE principal_id = ${ids.get("Standard")!} AND permission_key = ${permissionKey}`;
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT id FROM principal_permission_grants WHERE principal_id = ${ids.get("Standard")!}`).toHaveLength(0);
      expect(await sql`SELECT id FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(1);
    } finally {
      await sql.end(); await database.cleanup();
    }
  }, 120_000);
});
