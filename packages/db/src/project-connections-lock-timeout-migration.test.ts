import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const migrationFile = "0493_furry_the_watchers.sql";
const hash = createHash("sha256").update(await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url))).digest("hex");

// Keep reason: data safety and the real lock-queue failure reported in #20717
// (RFL C1). Mocks cannot prove that a queued ALTER stalls an unrelated reader.
describePostgres("project connection migration lock timeout", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let observer: ReturnType<typeof postgres>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-project-connection-lock-");
    observer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await observer?.end();
    await database?.cleanup();
  });

  function session(name: string) {
    return postgres(database.connectionString, { max: 1, onnotice: () => {}, connection: { application_name: name } });
  }

  function migrationUrl() {
    const url = new URL(database.connectionString);
    url.searchParams.set("application_name", "project-connection-lock-migrator");
    return url.toString();
  }

  async function prepare() {
    await observer.unsafe("DROP EVENT TRIGGER IF EXISTS count_project_connection_migration");
    await observer.unsafe("DROP FUNCTION IF EXISTS count_project_connection_migration()");
    await observer.unsafe("DROP SEQUENCE IF EXISTS project_connection_migration_attempts");
    await observer.unsafe('DROP INDEX IF EXISTS "tool_connections_project_live_installation_uq"');
    await observer.unsafe('ALTER TABLE "tool_connections" DROP COLUMN IF EXISTS "project_id"');
    await observer`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
    const state = await inspectMigrations(database.connectionString);
    expect(state).toMatchObject({ status: "needsMigrations", pendingMigrations: [migrationFile] });
    // nextval is deliberately not transactional: count actual ALTER attempts,
    // including rolled-back ones, without changing the migration being tested.
    await observer.unsafe("CREATE SEQUENCE project_connection_migration_attempts");
    await observer.unsafe(`CREATE FUNCTION count_project_connection_migration() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('project_connection_migration_attempts'); END $$`);
    await observer.unsafe(`CREATE EVENT TRIGGER count_project_connection_migration ON ddl_command_start
      WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION count_project_connection_migration()`);
  }

  async function attempts() {
    return Number((await observer`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS attempts
      FROM project_connection_migration_attempts`)[0]?.attempts);
  }

  async function assertUnapplied() {
    expect(await observer`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'tool_connections' AND column_name = 'project_id'`).toHaveLength(0);
    expect(await observer`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(0);
  }

  async function waitForQueuedAlter() {
    await expect.poll(async () => (await observer`SELECT EXISTS (
      SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.relation = 'tool_connections'::regclass AND l.mode = 'AccessExclusiveLock' AND NOT l.granted
        AND a.application_name = 'project-connection-lock-migrator') AS waiting`)[0]?.waiting,
    { timeout: 5_000, interval: 10 }).toBe(true);
  }

  it("unblocks a third-session read within 1s, rolls back the first attempt, then retries after the reader commits", async () => {
    await prepare();
    const holder = session("project-connection-lock-holder");
    const reader = session("project-connection-lock-reader");
    let migration: Promise<unknown> | undefined;
    let read: Promise<unknown> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await holder`BEGIN`;
      await holder`SELECT 1 FROM tool_connections LIMIT 1`;
      // Capture rejection immediately so a failing assertion never leaves an
      // unhandled promise while the finally block releases the blocking lock.
      migration = applyPendingMigrations(migrationUrl()).then(() => null, (error: unknown) => error);
      await waitForQueuedAlter();
      const started = performance.now();
      read = reader`SELECT 1 FROM tool_connections LIMIT 1`.then(() => true);
      const returned = await Promise.race([read, new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 1_000);
      })]);
      const readMs = performance.now() - started;
      console.log(JSON.stringify({ check: "RFL-C1-session-C", returned, readMs }));
      expect(returned, "session C is queued behind migration B while session A remains open").toBe(true);
      expect(readMs).toBeLessThan(1_000);
      expect(await attempts()).toBe(1);
      await assertUnapplied();
      await holder`COMMIT`;
      expect(await migration).toBeNull();
      expect(await attempts()).toBe(2);
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
      expect(await observer`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(1);
      expect((await observer`SELECT indisvalid FROM pg_index WHERE indexrelid =
        'tool_connections_project_live_installation_uq'::regclass`)[0]?.indisvalid).toBe(true);
      console.log(JSON.stringify({ check: "RFL-C1-retry", attempts: await attempts(), ledgerRows: 1 }));
    } finally {
      clearTimeout(deadline);
      await holder`ROLLBACK`;
      await Promise.allSettled([migration, read]);
      await Promise.all([holder.end(), reader.end()]);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("aborts after three lock timeouts with a named error and no partial DDL or ledger entry", async () => {
    await prepare();
    const holder = session("project-connection-lock-holder");
    let migration: Promise<unknown> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await holder`BEGIN`;
      await holder`SELECT 1 FROM tool_connections LIMIT 1`;
      const started = performance.now();
      migration = applyPendingMigrations(migrationUrl()).then(() => null, (error: unknown) => error);
      const error = await Promise.race([migration, new Promise<Error>((resolve) => {
        deadline = setTimeout(() => resolve(new Error("migration did not abort within 6s")), 6_000);
      })]);
      expect(error).toMatchObject({ name: "MigrationLockTimeoutError", code: "migration_lock_timeout",
        migrationFile, attempts: 3, cause: { code: "55P03" } });
      expect(await attempts()).toBe(3);
      await assertUnapplied();
      expect((await observer`SELECT to_regclass('tool_connections_project_live_installation_uq') AS name`)[0]?.name).toBeNull();
      console.log(JSON.stringify({ check: "RFL-C1-bounded-abort", elapsedMs: performance.now() - started,
        attempts: await attempts(), name: (error as Error).name, sqlstate: (error as { cause: { code: string } }).cause.code }));
    } finally {
      clearTimeout(deadline);
      await holder`ROLLBACK`;
      await Promise.allSettled([migration]);
      await holder.end();
    }
    // Exhaustion releases the advisory lock; an explicit later migrate is safe.
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    expect(await observer`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(1);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("does not retry other SQLSTATEs and rolls back an ALTER when the later index statement fails", async () => {
    await prepare();
    await observer.unsafe('CREATE INDEX "tool_connections_project_live_installation_uq" ON "tool_connections" ("company_id")');
    try {
      await expect(applyPendingMigrations(migrationUrl())).rejects.toMatchObject({ code: "42P07" });
      expect(await attempts()).toBe(1);
      await assertUnapplied();
    } finally {
      await observer.unsafe('DROP INDEX "tool_connections_project_live_installation_uq"');
    }
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
