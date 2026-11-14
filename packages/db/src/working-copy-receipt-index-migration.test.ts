import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const migrationSql = await readFile(new URL("./migrations/0479_organic_pixie.sql", import.meta.url), "utf8");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

// Data safety: a renumbered/changed-hash migration can replay outside a
// transaction. Preserve retained receipts and the resulting index definitions,
// and prove the normal history-aware executor does not rebuild applied indexes.
describePostgres("working-copy receipt index migration", () => {
  it("replays twice without changing rows or schema, then skips recorded SQL", async () => {
    const database = await startEmbeddedPostgresTestDatabase("working-copy-index-replay-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Receipt replay', 'RCP')`;
      await sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Writer')`;
      for (const receipt of [
        null,
        { schema: "paperclip.agent-files.v1", baseline: {} },
        { schema: "paperclip.agent-files.v1", cleanupTerminal: { reason: "source_gone" } },
        { schema: "paperclip.agent-files.v1", retainedByRunId: randomUUID() },
      ]) {
        const runId = randomUUID();
        await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id) VALUES (${runId}, ${companyId}, ${agentId})`;
        await sql`INSERT INTO agent_instruction_working_copies
          (run_id, company_id, agent_id, responsible_user_id, entry_file, base_hash,
           local_root, execution_root, location, state, receipt)
          VALUES (${runId}, ${companyId}, ${agentId}, 'editor', 'AGENTS.md', 'retained-hash',
            '/private/copy', '/private/copy', 'remote:retained-source', 'unavailable',
            ${receipt === null ? null : sql.json(receipt)})`;
      }
      const rows = async () => Array.from(await sql`
        SELECT * FROM agent_instruction_working_copies ORDER BY run_id`);
      const history = async () => Array.from(await sql`
        SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`);
      const indexes = async () => Array.from(await sql`
        SELECT c.relname, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid, i.indisready
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'agent_instruction_working_copies'::regclass ORDER BY c.relname`);
      const indexOids = async () => Array.from(await sql`
        SELECT c.relname, c.oid::text AS oid FROM pg_class c
        WHERE c.relname IN ('agent_instruction_copies_collection_idx', 'agent_instruction_copies_cleanup_idx')
        ORDER BY c.relname`);
      const beforeRows = await rows();
      const beforeHistory = await history();
      const expectedIndexes = await indexes();
      expect(beforeRows).toHaveLength(4);
      expect(expectedIndexes.filter((index) =>
        ["agent_instruction_copies_collection_idx", "agent_instruction_copies_cleanup_idx"].includes(index.relname),
      )).toHaveLength(2);

      // Start with the old, broader indexes. Applying just CREATE IF NOT EXISTS
      // would silently preserve these stale definitions; the guarded drops matter.
      await sql`DROP INDEX CONCURRENTLY agent_instruction_copies_collection_idx`;
      await sql`DROP INDEX CONCURRENTLY agent_instruction_copies_cleanup_idx`;
      await sql`CREATE INDEX agent_instruction_copies_collection_idx ON agent_instruction_working_copies (run_id, company_id)`;
      await sql`CREATE INDEX agent_instruction_copies_cleanup_idx ON agent_instruction_working_copies (run_id, company_id)`;
      expect(await indexes()).not.toEqual(expectedIndexes);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // CONCURRENTLY statements must run at top level, not inside a DO/transaction.
        for (const statement of migrationSql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
          await sql.unsafe(statement);
        }
        expect(await rows()).toEqual(beforeRows);
        expect(await history()).toEqual(beforeHistory);
        expect(await indexes()).toEqual(expectedIndexes);
      }

      // A partial previous attempt with a missing index is also recoverable.
      await sql`DROP INDEX CONCURRENTLY agent_instruction_copies_cleanup_idx`;
      for (const statement of migrationSql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
        await sql.unsafe(statement);
      }
      expect(await rows()).toEqual(beforeRows);
      expect(await indexes()).toEqual(expectedIndexes);

      // Raw replay deliberately rebuilds physical indexes. History-aware repeat
      // upgrades must be true no-ops, including the physical relation identities.
      const beforeOids = await indexOids();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
        await applyPendingMigrations(database.connectionString);
        expect(await rows()).toEqual(beforeRows);
        expect(await history()).toEqual(beforeHistory);
        expect(await indexes()).toEqual(expectedIndexes);
        expect(await indexOids()).toEqual(beforeOids);
      }
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
