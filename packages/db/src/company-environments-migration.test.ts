import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const files = ["0493_nervous_stellaris.sql", "0494_rainy_lionheart.sql"];
const hashes = await Promise.all(files.map(async file => createHash("sha256")
  .update(await readFile(new URL(`./migrations/${file}`, import.meta.url))).digest("hex")));

// Keep: admission scoping must never rewrite a previously saved execution target.
describePostgres("company environment migration on the pre-change schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-company-environments-");
    sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await sql?.end(); await database?.cleanup(); });

  it("backfills only unambiguous non-local ownership and defaults, preserving all agent targets and shared rows", async () => {
    await sql`ALTER TABLE companies DROP COLUMN default_environment_id`;
    await sql`ALTER TABLE environments DROP COLUMN company_id`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(hashes)}`;
    const [paul, test, ambiguous, localOnly, archivedOnly] = Array.from({ length: 5 }, () => randomUUID());
    for (const id of [paul, test, ambiguous, localOnly, archivedOnly]) {
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${id}, 'Migration company', ${`C${id.slice(0, 7)}`})`;
    }
    const ids = Object.fromEntries(["paul", "test", "shared", "unused", "first", "second", "local", "archived"].map(key => [key, randomUUID()]));
    const [local] = await sql`SELECT id FROM environments WHERE driver = 'local'`;
    if (local) ids.local = local.id;
    for (const [key, id] of Object.entries(ids)) {
      if (key === "local" && local) continue;
      await sql`INSERT INTO environments (id, name, driver, status) VALUES
        (${id}, ${`Migration ${id}`}, ${key === "local" ? "local" : "sandbox"}, ${key === "archived" ? "archived" : "active"})`;
    }
    for (const [companyId, key] of [[paul, "paul"], [test, "test"], [paul, "shared"], [test, "shared"],
      [ambiguous, "first"], [ambiguous, "second"], [localOnly, "local"], [archivedOnly, "archived"], [paul, "paul"]]) {
      await sql`INSERT INTO agents (company_id, name, default_environment_id) VALUES (${companyId}, 'Existing agent', ${ids[key!]})`;
    }
    const before = Array.from(await sql`SELECT id, company_id, default_environment_id FROM agents ORDER BY id`);
    await applyPendingMigrations(database.connectionString);
    expect(Array.from(await sql`SELECT id, company_id, default_environment_id FROM agents ORDER BY id`)).toEqual(before);
    const ownership = new Map((await sql`SELECT id, company_id FROM environments`).map(row => [row.id, row.company_id]));
    expect(ownership.get(ids.paul)).toBe(paul);
    expect(ownership.get(ids.test)).toBe(test);
    expect(ownership.get(ids.shared)).toBeNull();
    expect(ownership.get(ids.unused)).toBeNull();
    expect(ownership.get(ids.local)).toBeNull();
    const defaults = new Map((await sql`SELECT id, default_environment_id FROM companies`).map(row => [row.id, row.default_environment_id]));
    expect(defaults.get(paul)).toBe(ids.paul);
    expect(defaults.get(test)).toBe(ids.test);
    expect(defaults.get(ambiguous)).toBeNull();
    expect(defaults.get(localOnly)).toBeNull();
    expect(defaults.get(archivedOnly)).toBeNull();
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    await applyPendingMigrations(database.connectionString);
    expect(Array.from(await sql`SELECT id, company_id, default_environment_id FROM agents ORDER BY id`)).toEqual(before);
    expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash IN ${sql(hashes)}`).toHaveLength(2);
    // Default deletion semantics match agent defaults; no dangling preference.
    await sql`DELETE FROM environments WHERE id = ${ids.paul}`;
    expect((await sql`SELECT default_environment_id FROM companies WHERE id = ${paul}`)[0]?.default_environment_id).toBeNull();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
