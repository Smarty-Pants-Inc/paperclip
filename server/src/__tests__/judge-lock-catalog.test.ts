import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
beforeAll(async () => { temporary = await startRecoveryPostgres("judge-lock-catalog-"); db = createDb(temporary.connectionString); }, 90_000);
afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
it("records the migrated PostgreSQL FK and custom-trigger graph, not a schema-only guess", async () => {
  const version = await db.execute(sql`select version() as version`);
  const constraints = await db.execute(sql`select c.conname, c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
    pg_get_constraintdef(c.oid) as definition, c.condeferrable, c.condeferred, c.convalidated,
    c.confupdtype, c.confdeltype, c.confmatchtype from pg_constraint c where c.contype='f' order by child,parent,c.conname`);
  const triggers = await db.execute(sql`select t.tgrelid::regclass::text as table_name, t.tgname, pg_get_triggerdef(t.oid) as definition,
    t.tgfoid::regprocedure::text as procedure, pg_get_functiondef(t.tgfoid) as function_definition
    from pg_trigger t where not t.tgisinternal order by table_name,t.tgname`);
  const leaseFkTriggerOrder = await db.execute(sql`select tgname, pg_get_triggerdef(oid) as definition
    from pg_trigger where tgrelid='environment_leases'::regclass and tgname like 'RI_ConstraintTrigger_c_%' order by tgname`);
  await writeFile(join(process.env.TASK_OUT!, "postgres-lock-catalog.json"), JSON.stringify({ version, constraints, triggers, leaseFkTriggerOrder }, null, 2)+"\n");
  expect(constraints.some(c => c.child === "environment_leases" && c.parent === "environments")).toBe(true);
  expect(constraints.some(c => c.child === "environment_leases" && c.parent === "issues")).toBe(true);
  console.log("[catalog-counts]", JSON.stringify({ constraints: constraints.length, customTriggers: triggers.length, leaseFkTriggers: leaseFkTriggerOrder.length }));
});
