import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createBufferedTextFileWriter, runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import { applyPendingMigrations, ensurePostgresDatabase, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

async function readSchemaCatalog(sql: postgres.Sql) {
  await sql`SET search_path = pg_catalog`;
  const constraints = await sql`
    SELECT n.nspname AS schema_name, t.relname AS table_name, c.conname,
           c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    ORDER BY n.nspname, t.relname, c.conname
  `;
  const indexes = await sql`
    SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname <> 'information_schema' AND schemaname !~ '^pg_'
    ORDER BY schemaname, tablename, indexname
  `;
  const columns = await sql`
    SELECT n.nspname AS schema_name, t.relname AS table_name, a.attname,
           format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
           a.attidentity, pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_attribute a
    JOIN pg_class t ON t.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
    WHERE t.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    ORDER BY n.nspname, t.relname, a.attnum
  `;
  const statistics = await sql`
    SELECT n.nspname AS schema_name, s.stxname, s.stxstattarget,
           pg_get_statisticsobjdef(s.oid) AS definition
    FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    ORDER BY n.nspname, s.stxname
  `;
  return { constraints: [...constraints], indexes: [...indexes], columns: [...columns], statistics: [...statistics] };
}

function recordSchemaCatalogs(name: string, source: unknown, restored: unknown) {
  const directory = process.env.BACKUP_FIDELITY_EVIDENCE_DIR;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}-source.json`), JSON.stringify(source, null, 2));
  fs.writeFileSync(path.join(directory, `${name}-restored.json`), JSON.stringify(restored, null, 2));
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it("round-trips CHECK, exclusion, NULLS NOT DISTINCT and extended statistics with data", async () => {
    const cluster = await createTempDatabase();
    const source = await createSiblingDatabase(cluster, "constraint_source");
    const target = await createSiblingDatabase(cluster, "constraint_restore");
    const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
    const targetSql = postgres(target, { max: 1, onnotice: () => {} });
    try {
      await sourceSql.unsafe(`
        CREATE SCHEMA fidelity;
        CREATE SCHEMA statistics_only;
        CREATE FUNCTION fidelity.is_positive(integer) RETURNS boolean
          LANGUAGE sql IMMUTABLE AS 'SELECT $1 > 0';
        CREATE TABLE fidelity.records (
          id integer CONSTRAINT records_pk PRIMARY KEY DEFERRABLE INITIALLY DEFERRED,
          slot text,
          score integer NOT NULL DEFAULT 1,
          span int4range,
          CONSTRAINT positive_score CHECK (fidelity.is_positive(score)),
          CONSTRAINT unique_slot UNIQUE NULLS NOT DISTINCT (slot) INCLUDE (score) DEFERRABLE,
          CONSTRAINT nonoverlapping_span EXCLUDE USING gist (span WITH &&) DEFERRABLE INITIALLY DEFERRED
        );
        INSERT INTO fidelity.records VALUES (1, NULL, 1, '[1,3)'), (2, 'second', 2, '[3,5)');
        ALTER TABLE fidelity.records ADD CONSTRAINT unvalidated_score CHECK (score > 10) NOT VALID;
        CREATE STATISTICS statistics_only.record_stats (dependencies, ndistinct, mcv)
          ON slot, score FROM fidelity.records;
        ALTER STATISTICS statistics_only.record_stats SET STATISTICS 123;
        CREATE STATISTICS fidelity.expression_stats ON (fidelity.is_positive(score)), slot FROM fidelity.records;
        CREATE TABLE fidelity.parent (a integer, b integer, UNIQUE (a, b));
        CREATE TABLE fidelity.child (a integer, b integer,
          CONSTRAINT full_fk FOREIGN KEY (a, b) REFERENCES fidelity.parent (a, b) MATCH FULL
            DEFERRABLE INITIALLY DEFERRED);
        ALTER TABLE fidelity.child ADD CONSTRAINT unvalidated_fk FOREIGN KEY (a, b)
          REFERENCES fidelity.parent (a, b) NOT VALID;
        INSERT INTO fidelity.parent VALUES (1, 2);
        INSERT INTO fidelity.child VALUES (1, 2);
        ALTER DATABASE constraint_source SET search_path = fidelity, public;
      `);
      const backup = await runDatabaseBackup({ connectionString: source,
        backupDir: createTempDir("constraint-fidelity-"), backupEngine: "javascript",
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
      const sourceCatalog = await readSchemaCatalog(sourceSql);
      const restoredCatalog = await readSchemaCatalog(targetSql);
      recordSchemaCatalogs("constraints", sourceCatalog, restoredCatalog);
      expect.soft(restoredCatalog.constraints).toEqual(sourceCatalog.constraints);
      expect.soft(restoredCatalog.statistics).toEqual(sourceCatalog.statistics);
      expect.soft(restoredCatalog.indexes).toEqual(sourceCatalog.indexes);
      expect.soft(restoredCatalog.columns).toEqual(sourceCatalog.columns);
      expect(await targetSql`SELECT id FROM fidelity.records ORDER BY id`).toEqual([{ id: 1 }, { id: 2 }]);
      await expect(targetSql`INSERT INTO fidelity.records VALUES (3, 'bad', -1, '[8,9)')`)
        .rejects.toThrow('positive_score');
      await expect(targetSql`INSERT INTO fidelity.records VALUES (3, NULL, 20, '[8,9)')`)
        .rejects.toThrow('unique_slot');
      await expect(targetSql`INSERT INTO fidelity.records VALUES (3, 'third', 20, '[2,4)')`)
        .rejects.toThrow('nonoverlapping_span');
      const backupSql = gunzipSync(fs.readFileSync(backup.backupFile)).toString("utf8");
      expect(backupSql.indexOf('ADD CONSTRAINT "positive_score"')).toBeGreaterThan(
        backupSql.lastIndexOf('INSERT INTO "fidelity"."records"'));
    } finally {
      await sourceSql.end();
      await targetSql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("skips extended statistics cleanly when the server deparser is unavailable", async () => {
    const cluster = await createTempDatabase();
    const source = await createSiblingDatabase(cluster, "statistics_unavailable_source");
    const target = await createSiblingDatabase(cluster, "statistics_unavailable_restore");
    const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
    const targetSql = postgres(target, { max: 1, onnotice: () => {} });
    try {
      await sourceSql.unsafe(`
        CREATE TABLE public.records (a integer, b integer);
        INSERT INTO public.records VALUES (1, 2);
        CREATE STATISTICS public.record_stats ON a, b FROM public.records;
        ALTER FUNCTION pg_catalog.pg_get_statisticsobjdef(oid) RENAME TO unavailable_statistics_deparser;
      `);
      const backup = await runDatabaseBackup({ connectionString: source,
        backupDir: createTempDir("statistics-unavailable-"), backupEngine: "javascript",
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
      expect(await targetSql`SELECT a, b FROM public.records`).toEqual([{ a: 1, b: 2 }]);
      expect(await targetSql`SELECT stxname FROM pg_statistic_ext`).toEqual([]);
    } finally {
      await sourceSql.end();
      await targetSql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects and rolls back a restore when transformed data violates a validated CHECK", async () => {
    const cluster = await createTempDatabase();
    const source = await createSiblingDatabase(cluster, "invalid_check_source");
    const target = await createSiblingDatabase(cluster, "invalid_check_restore");
    const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
    const targetSql = postgres(target, { max: 1, onnotice: () => {} });
    try {
      await sourceSql.unsafe(`
        CREATE TABLE public.records (value text CONSTRAINT required_value CHECK (value IS NOT NULL));
        INSERT INTO public.records VALUES ('present');
      `);
      const backup = await runDatabaseBackup({ connectionString: source,
        backupDir: createTempDir("invalid-check-"), backupEngine: "javascript",
        nullifyColumns: { records: ["value"] },
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      await expect(runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile }))
        .rejects.toThrow('required_value');
      expect(await targetSql`SELECT to_regclass('public.records') AS table_name`).toEqual([{ table_name: null }]);
    } finally {
      await sourceSql.end();
      await targetSql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("round-trips the complete migrated schema catalog through the JavaScript engine", async () => {
    const cluster = await createTempDatabase();
    const source = await createSiblingDatabase(cluster, "migrated_source");
    const target = await createSiblingDatabase(cluster, "migrated_restore");
    const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
    const targetSql = postgres(target, { max: 1, onnotice: () => {} });
    try {
      await applyPendingMigrations(source);
      const migrationState = await inspectMigrations(source);
      expect(migrationState.status).toBe("upToDate");
      expect(migrationState.appliedMigrations).toEqual(migrationState.availableMigrations);
      const sourceCatalog = await readSchemaCatalog(sourceSql);
      expect(sourceCatalog.constraints.filter(c => c.contype === "c").length).toBeGreaterThan(0);
      const backup = await runDatabaseBackup({ connectionString: source,
        backupDir: createTempDir("migrated-fidelity-"), backupEngine: "javascript",
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
      const restoredCatalog = await readSchemaCatalog(targetSql);
      recordSchemaCatalogs("migrated", sourceCatalog, restoredCatalog);
      expect(restoredCatalog).toEqual(sourceCatalog);
    } finally {
      await sourceSql.end();
      await targetSql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("preserves a post-pg_dump verification error without falling back or pruning", async () => {
    const connectionString = await createTempDatabase();
    const backupDir = createTempDir("checkpoint-pg-dump-");
    const executable = path.join(backupDir, "pg-dump-fixture");
    fs.writeFileSync(executable, "#!/bin/sh\nprintf 'SELECT 1;\\n'\n", { mode: 0o700 });
    const history = path.join(backupDir, "paperclip-history.sql.gz");
    const historyBytes = gzipSync("SELECT 'history';");
    fs.writeFileSync(history, historyBytes);
    fs.utimesSync(history, new Date(0), new Date(0));
    const previous = process.env.PAPERCLIP_PG_DUMP_PATH;
    process.env.PAPERCLIP_PG_DUMP_PATH = executable;
    const failure = new Error("fixture archive fsync failed");
    let verified = 0;
    try {
      await expect(runDatabaseBackup({
        connectionString, backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        verifyBeforePrune: async archive => {
          verified++;
          expect(gunzipSync(fs.readFileSync(archive)).toString()).toBe("SELECT 1;\n");
          throw failure;
        },
      })).rejects.toBe(failure);
      expect(verified).toBe(1);
      expect(fs.readFileSync(history)).toEqual(historyBytes);
      expect(fs.readdirSync(backupDir).filter(name => name.endsWith(".sql.gz"))).toEqual(["paperclip-history.sql.gz"]);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
      else process.env.PAPERCLIP_PG_DUMP_PATH = previous;
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("preserves identity generation, sequence options and progress in JavaScript backups", async () => {
    const source = await createTempDatabase();
    const target = await createSiblingDatabase(source, "identity_restore_target");
    const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
    const targetSql = postgres(target, { max: 1, onnotice: () => {} });
    try {
      await sourceSql.unsafe(`
        CREATE SCHEMA identity_fixture;
        CREATE TABLE identity_fixture.records (
          id bigint GENERATED ALWAYS AS IDENTITY (START WITH 7 INCREMENT BY 2) PRIMARY KEY,
          default_id integer GENERATED BY DEFAULT AS IDENTITY,
          value text NOT NULL
        );
        INSERT INTO identity_fixture.records (value) VALUES ('one'), ('two');
      `);
      const backup = await runDatabaseBackup({ connectionString: source, backupDir: createTempDir("identity-backup-"), backupEngine: "javascript", retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
      expect(await targetSql`SELECT id::text, default_id, value FROM identity_fixture.records ORDER BY id`)
        .toEqual([{ id: "7", default_id: 1, value: "one" }, { id: "9", default_id: 2, value: "two" }]);
      expect(await targetSql`INSERT INTO identity_fixture.records (value) VALUES ('three') RETURNING id::text, default_id`)
        .toEqual([{ id: "11", default_id: 3 }]);
      await expect(targetSql`INSERT INTO identity_fixture.records (id, value) VALUES (99, 'explicit')`).rejects.toThrow("non-DEFAULT");
    } finally {
      await sourceSql.end();
      await targetSql.end();
    }
  }, 30_000);

  it(
    "keeps the newest backup for each retained calendar month",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const janNewest = path.join(backupDir, "paperclip-test-2026-01-28T12-00-00.sql.gz");
      const janOlder = path.join(backupDir, "paperclip-test-2026-01-10T12-00-00.sql.gz");
      const decOld = path.join(backupDir, "paperclip-test-2025-12-15T12-00-00.sql.gz");

      try {
        fs.writeFileSync(janNewest, "jan-newest");
        fs.writeFileSync(janOlder, "jan-older");
        fs.writeFileSync(decOld, "dec-old");

        fs.utimesSync(janNewest, new Date("2026-01-28T12:00:00Z"), new Date("2026-01-28T12:00:00Z"));
        fs.utimesSync(janOlder, new Date("2026-01-10T12:00:00Z"), new Date("2026-01-10T12:00:00Z"));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
          filenamePrefix: "paperclip-test",
        });

        expect(result.prunedCount).toBe(2);
        expect(fs.existsSync(janNewest)).toBe(true);
        expect(fs.existsSync(janOlder)).toBe(false);
        expect(fs.existsSync(decOld)).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);
        await sourceSql.unsafe(`
          CREATE FUNCTION "public"."backup_test_mark_done"()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            NEW."state" := 'done';
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER "backup_test_mark_done_trigger"
          BEFORE UPDATE OF "title" ON "public"."backup_test_records"
          FOR EACH ROW
          EXECUTE FUNCTION "public"."backup_test_mark_done"();
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);

        await restoreSql.unsafe(`
          UPDATE "public"."backup_test_records"
          SET "title" = 'triggered'
          WHERE "title" = 'row-0'
        `);
        const triggeredRows = await restoreSql.unsafe<{ state: string }[]>(`
          SELECT "state"::text AS "state"
          FROM "public"."backup_test_records"
          WHERE "title" = 'triggered'
        `);
        expect(triggeredRows).toEqual([{ state: "done" }]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_full_logical_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('paperclip-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'paperclip-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "paperclip-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "preserves composite foreign key column order without duplicate referenced columns",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_composite_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-composite-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_composite_fk";
          CREATE TABLE "plugin_composite_fk"."content_cases" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            CONSTRAINT "content_cases_company_case_unique" UNIQUE ("company_id", "id")
          );
          CREATE TABLE "plugin_composite_fk"."content_case_signals" (
            "company_id" uuid NOT NULL,
            "case_id" uuid NOT NULL,
            "signal" text NOT NULL,
            "scopes" text[] NOT NULL,
            "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
            CONSTRAINT "content_case_signals_company_case"
              FOREIGN KEY ("company_id", "case_id")
              REFERENCES "plugin_composite_fk"."content_cases" ("company_id", "id")
              ON DELETE CASCADE
          );
          INSERT INTO "plugin_composite_fk"."content_cases" ("company_id", "id", "title")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'case'
          );
          INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes", "warnings")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'signal',
            ARRAY['upstream_import:preview', 'scope with space', 'quoted "scope"', 'NULL', 'null'],
            jsonb_build_array('json warning', jsonb_build_object('code', 'quoted "value"'))
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-composite-fk-test",
          backupEngine: "javascript",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{
          signal: string;
          title: string;
          scopes: string[];
          warnings: Array<string | { code: string }>;
        }[]>(`
          SELECT s."signal", c."title", s."scopes", s."warnings"
          FROM "plugin_composite_fk"."content_case_signals" s
          JOIN "plugin_composite_fk"."content_cases" c
            ON c."company_id" = s."company_id"
           AND c."id" = s."case_id"
        `);
        expect(rows).toEqual([
          {
            signal: "signal",
            title: "case",
            scopes: ["upstream_import:preview", "scope with space", 'quoted "scope"', "NULL", "null"],
            warnings: ["json warning", { code: 'quoted "value"' }],
          },
        ]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes")
            VALUES (
              '11111111-1111-4111-8111-111111111111',
              '33333333-3333-4333-8333-333333333333',
              'orphan',
              ARRAY[]::text[]
            )
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores fallback COPY data when child tables are dumped before parent tables",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      const originalPsqlPath = process.env.PAPERCLIP_PSQL_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";
      process.env.PAPERCLIP_PSQL_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."zzz_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          CREATE TABLE "public"."aaa_child_records" (
            "id" uuid PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."zzz_parent_records"("id") ON DELETE CASCADE,
            "note" text NOT NULL
          );
          INSERT INTO "public"."zzz_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
          INSERT INTO "public"."aaa_child_records" ("id", "parent_id", "note")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            'child emitted before parent'
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-fk-test",
          backupEngine: "auto",
        });

        const backupSql = gunzipSync(await fs.promises.readFile(result.backupFile)).toString("utf8");
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeGreaterThan(-1);
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeLessThan(
          backupSql.indexOf("-- Data for: public.zzz_parent_records"),
        );
        expect(backupSql).not.toContain(" FROM stdin;");

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ note: string; name: string }[]>(`
          SELECT child."note", parent."name"
          FROM "public"."aaa_child_records" child
          JOIN "public"."zzz_parent_records" parent ON parent."id" = child."parent_id"
        `);
        expect(rows).toEqual([{ note: "child emitted before parent", name: "parent" }]);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        if (originalPsqlPath === undefined) {
          delete process.env.PAPERCLIP_PSQL_PATH;
        } else {
          process.env.PAPERCLIP_PSQL_PATH = originalPsqlPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores legacy public-only backups without migration history",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
});
