import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const FUNCTIONS = ["paperclip_record_agent_runtime", "paperclip_invalidate_connector_company"];
// src8 (R2): the multi-agent fanouts 0491 also replaces, each with the migration
// that last defined it, plus the new row-lock helper (dropped by the DOWN).
const FANOUTS: Record<string, string> = {
  paperclip_invalidate_company_agent_runtimes: "./migrations/0354_agent_connection_assignment_hooks.sql",
  paperclip_invalidate_skill_source_runtimes: "./migrations/0378_environment_skill_runtime_hooks.sql",
  paperclip_skill_runtime_changed: "./migrations/0378_environment_skill_runtime_hooks.sql",
  paperclip_environment_runtimes_changed: "./migrations/0378_environment_skill_runtime_hooks.sql",
  paperclip_connector_runtime_changed: "./migrations/0444_github_access_refresh_runtime_bookkeeping.sql",
  // src11 (rf4 F1a/F1b, F1d): the file-event trigger body and the skill-pin fanout.
  paperclip_agent_runtime_files_changed: "./migrations/0347_flippant_imperial_guard.sql",
  paperclip_skill_pins_runtime_changed: "./migrations/0348_agent_skill_runtime_hooks.sql",
};
// src11 (rf4 F1c): the manager key-share prelock function (dropped by the DOWN).
const ALL_FUNCTIONS = [...FUNCTIONS, ...Object.keys(FANOUTS), "paperclip_lock_runtime_agents", "paperclip_agent_runtime_lock_manager"];
const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

/** The CREATE statements for FUNCTIONS in one migration file, in file order. */
async function functionStatements(path: string, names: string[] = FUNCTIONS) {
  return (await read(path)).split("--> statement-breakpoint")
    .filter(statement => names.some(name => statement.includes(`CREATE OR REPLACE FUNCTION ${name}(`))).join(";\n");
}

(support.supported ? describe : describe.skip)("#20805 connector runtime company lock migration (0491)", () => {
  it("replaces two function bodies without touching revision rows; the DOWN restores the 0354 bodies", async () => {
    const database = await startEmbeddedPostgresTestDatabase("connector-runtime-company-lock-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const definitions = async () => Object.fromEntries((await sql`SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY(${ALL_FUNCTIONS}) ORDER BY p.proname`)
        .map(row => [row.proname as string, row.def as string]));
      // src11: the runtime triggers on agents and activity_log the migration re-creates.
      const triggers = async () => Array.from(await sql`SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgrelid IN ('agents'::regclass, 'activity_log'::regclass) AND NOT tgisinternal AND tgname LIKE 'paperclip_agent_runtime%' ORDER BY tgname`)
        .map(row => `${row.tgname}: ${row.def}`);
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
      // R2 (src8): every multi-agent fanout locks its rows before the first record.
      for (const name of ["paperclip_invalidate_company_agent_runtimes", "paperclip_invalidate_skill_source_runtimes", "paperclip_skill_runtime_changed"])
        expect(head[name]).toMatch(/FOREACH candidate IN ARRAY ARRAY\(SELECT[\s\S]*FOR NO KEY UPDATE\) LOOP/);
      expect(head.paperclip_environment_runtimes_changed).toContain("FOR NO KEY UPDATE OF a)) ORDER BY locked.company_id, locked.id LOOP");
      expect(head.paperclip_connector_runtime_changed.match(/PERFORM paperclip_lock_runtime_agents\(agent_ids\)/g)).toHaveLength(3);
      expect(head.paperclip_lock_runtime_agents).toContain("ORDER BY id FOR NO KEY UPDATE");
      // src11: file events are recorded by a statement trigger after every row lock;
      // the manager's key share is taken BEFORE ROW; the skill-pin fanout prelocks.
      expect(head.paperclip_agent_runtime_files_changed).toContain("PERFORM paperclip_lock_runtime_agents(ARRAY(SELECT n.entity_id::uuid FROM new_rows n");
      expect(head.paperclip_skill_pins_runtime_changed).toContain("ORDER BY company_id, id FOR NO KEY UPDATE;");
      expect(head.paperclip_connector_runtime_changed).toContain("IS DISTINCT FROM pg_current_xact_id()::text THEN\n          SELECT id INTO candidate");
      const headTriggers = await triggers();
      expect(headTriggers.join("\n")).toContain("paperclip_agent_runtime_files_changed AFTER INSERT ON public.activity_log REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT");
      expect(headTriggers.filter(t => t.startsWith("paperclip_agent_runtime_lock_manager_"))).toHaveLength(2);

      // Previous bodies, from the migration that last defined them.
      await sql.unsafe(await functionStatements("./migrations/0354_agent_connection_assignment_hooks.sql"));
      for (const [name, path] of Object.entries(FANOUTS)) await sql.unsafe(await functionStatements(path, [name]));
      await sql`DROP FUNCTION paperclip_lock_runtime_agents(uuid[])`;
      await sql.unsafe(`DROP TRIGGER paperclip_agent_runtime_lock_manager_insert ON agents;
        DROP TRIGGER paperclip_agent_runtime_lock_manager_update ON agents;
        DROP FUNCTION paperclip_agent_runtime_lock_manager();
        DROP TRIGGER paperclip_agent_runtime_files_changed ON activity_log;
        CREATE TRIGGER paperclip_agent_runtime_files_changed BEFORE INSERT ON activity_log
          FOR EACH ROW EXECUTE FUNCTION paperclip_agent_runtime_files_changed();`);
      const previous = await definitions();
      const previousTriggers = await triggers();
      expect(previousTriggers).toEqual(["paperclip_agent_runtime_changed: CREATE TRIGGER paperclip_agent_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION paperclip_agent_runtime_changed()",
        "paperclip_agent_runtime_files_changed: CREATE TRIGGER paperclip_agent_runtime_files_changed BEFORE INSERT ON public.activity_log FOR EACH ROW EXECUTE FUNCTION paperclip_agent_runtime_files_changed()"]);
      expect(previous.paperclip_lock_runtime_agents).toBeUndefined();
      expect(previous).not.toEqual(head);
      expect(await revisions()).toEqual(seeded);

      // UP over the previous bodies: identical to the migrated head, no row changes.
      const up = await read("./migrations/0494_connector_runtime_company_lock.sql");
      await sql.unsafe(up);
      expect(await definitions()).toEqual(head);
      expect(await triggers()).toEqual(headTriggers);
      expect(await revisions()).toEqual(seeded);

      // Re-applying through the migrator keeps the head bodies and rewrites no rows.
      const hash = createHash("sha256").update(up).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      const settled = await revisions();
      await applyPendingMigrations(database.connectionString);
      expect(await definitions()).toEqual(head);
      expect(await triggers()).toEqual(headTriggers);
      expect(await revisions()).toEqual(settled);
      // DOWN: exactly the previous bodies, no row changes.
      await sql.unsafe(await read("./migration-rollbacks/0491_connector_runtime_company_lock.down.sql"));
      expect(await definitions()).toEqual(previous);
      expect(await triggers()).toEqual(previousTriggers);
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
