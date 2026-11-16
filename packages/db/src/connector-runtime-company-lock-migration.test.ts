import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const FUNCTIONS = ["paperclip_record_agent_runtime", "paperclip_invalidate_connector_company"];
const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

/** The CREATE statements for FUNCTIONS in one migration file, in file order. */
async function functionStatements(path: string) {
  return (await read(path)).split("--> statement-breakpoint")
    .filter(statement => FUNCTIONS.some(name => statement.includes(`CREATE OR REPLACE FUNCTION ${name}(`))).join(";\n");
}

(support.supported ? describe : describe.skip)("#20805 connector runtime company lock migration (0489)", () => {
  it("replaces two function bodies without touching revision rows; the DOWN restores the 0354 bodies", async () => {
    const database = await startEmbeddedPostgresTestDatabase("connector-runtime-company-lock-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const definitions = async () => Object.fromEntries((await sql`SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY(${FUNCTIONS}) ORDER BY p.proname`)
        .map(row => [row.proname as string, row.def as string]));
      const revisions = async () => Array.from(await sql`SELECT id, company_id, resource_type, resource_id, action FROM resource_lifecycle_events ORDER BY id`);
      const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Lock migration', 'LKM') RETURNING id`;
      const agentIds = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of agentIds) await sql`INSERT INTO agents (id, company_id, name) VALUES (${id}, ${company!.id}, ${`Agent ${id.slice(0, 4)}`})`;
      await sql`INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key)
        VALUES (${company!.id}, 'user', 'migration-user', 'tasks:assign')`;
      const seeded = await revisions();
      expect(seeded.length).toBeGreaterThan(0);

      const head = await definitions();
      expect(head.paperclip_invalidate_connector_company).toContain("pg_advisory_xact_lock(");
      expect(head.paperclip_invalidate_connector_company).not.toContain("FOR NO KEY UPDATE");
      expect(head.paperclip_record_agent_runtime).toContain("pg_advisory_xact_lock_shared(");

      // Previous bodies, from the migration that last defined them.
      await sql.unsafe(await functionStatements("./migrations/0354_agent_connection_assignment_hooks.sql"));
      const previous = await definitions();
      expect(previous).not.toEqual(head);
      expect(await revisions()).toEqual(seeded);

      // UP over the previous bodies: identical to the migrated head, no row changes.
      const up = await read("./migrations/0489_connector_runtime_company_lock.sql");
      await sql.unsafe(up);
      expect(await definitions()).toEqual(head);
      expect(await revisions()).toEqual(seeded);

      // Re-applying through the migrator keeps the head bodies and rewrites no rows.
      const hash = createHash("sha256").update(up).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      const settled = await revisions();
      await applyPendingMigrations(database.connectionString);
      expect(await definitions()).toEqual(head);
      expect(await revisions()).toEqual(settled);
      // DOWN: exactly the previous bodies, no row changes.
      await sql.unsafe(await read("./migration-rollbacks/0489_connector_runtime_company_lock.down.sql"));
      expect(await definitions()).toEqual(previous);
      expect(await revisions()).toEqual(seeded);

      // The restored bodies still invalidate every active agent exactly once per change.
      const before = Number((await sql`SELECT coalesce(max(id), 0)::text AS id FROM resource_lifecycle_events`)[0]!.id);
      await sql`INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key)
        VALUES (${company!.id}, 'user', 'migration-user', 'agents:create')`;
      const bumped = await sql`SELECT resource_id::text, count(*)::int AS n FROM resource_lifecycle_events WHERE id > ${before}
        AND resource_type = 'agent_runtime' GROUP BY resource_id ORDER BY resource_id`;
      expect(bumped.map(row => [row.resource_id, row.n])).toEqual([...agentIds].sort().map(id => [id, 1]));

      const line = `RED_E_MIGRATION ${JSON.stringify({ seededRevisions: seeded.length, upDownRowDelta: 0, downRestoresPrevious: true, rerunRowDelta: 0 })}`;
      console.info(line);
      if (process.env.RED_EVIDENCE_FILE) await appendFile(process.env.RED_EVIDENCE_FILE, line + "\n");
    } finally {
      await sql.end(); await database.cleanup();
    }
  }, 120_000);
});
