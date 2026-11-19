import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { closeRegisteredClients, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNativeRunLogTestTables } from "../../__tests__/helpers/native-run-log-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { newStore, spilledRun } from "../object-run-log-spill.fixture.js";
import { readObjectRunLogSpill } from "../object-run-log-store.js";
import { readRecoverableRunLog } from "../native-runtime/native-run-log-recovery.js";
import { recoverSpilledRunLogs } from "./run-log-spill-recovery.js";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7002475364 (rf-3 condition 1)
// Keep reason: NEVER-OK trace custody. The read path behind
// GET /api/heartbeat-runs/:id/log (heartbeat.readLog -> readRecoverableRunLog)
// against a REAL database row and the production store + journal: a settled
// run whose storage refused its log is served in full once storage is back,
// and its row gets the size and digest. OBJLOG_MUTATION=recovery-off -> red.

const support = await getEmbeddedPostgresTestSupport();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!support.supported)("run-log spill recovery on the log read path", () => {
  const schema = `run_log_spill_${randomUUID().replaceAll("-", "")}`;
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-log-spill-");
    db = createDb(database.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0 });
    await db.execute(sql.raw(`create schema ${schema}`));
    await db.execute(sql.raw(`set search_path=${schema}`));
    await createNativeRunLogTestTables(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    try {
      if (db) await db.execute(sql.raw(`drop schema ${schema} cascade`));
    } finally {
      if (database) {
        await closeRegisteredClients(database.connectionString, { scope: "database" });
        await database.cleanup();
      }
    }
  });

  /** A legacy run that settled `status` while storage refused its log: size and digest unknown. */
  async function settledRun(status: string) {
    const binding = { companyId: randomUUID(), agentId: randomUUID() }, runId = randomUUID();
    const r = await spilledRun(runId, binding);
    await db.execute(sql`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,log_store,log_ref)
      values(${runId},${binding.companyId},${binding.agentId},${status},'legacy','s3_segments',${r.logRef})`);
    const row = async () => (await db.execute(sql`select log_bytes, log_sha256 from heartbeat_runs where id = ${runId}`))[0] as
      { log_bytes: string | number | null; log_sha256: string | null };
    return { ...r, runId, row };
  }
  async function readLog(r: Awaited<ReturnType<typeof settledRun>>, status: string) {
    const store = newStore(r.m, r.spillDir), parts: Buffer[] = [];
    for (let offset: number | undefined = 0; offset !== undefined;) {
      const current = await r.row();
      const page = await readRecoverableRunLog(db, store, { store: "s3_segments", logRef: r.logRef },
        { offset, limitBytes: 64 },
        { runtimeMode: "legacy", status, logBytes: current.log_bytes === null ? null : Number(current.log_bytes) });
      parts.push(Buffer.from(page.content));
      offset = page.nextOffset;
    }
    return Buffer.concat(parts);
  }

  it("persistent EIO -> spill; storage restored -> the next log read returns ALL admitted bytes and sets the run's size and sha", async () => {
    const r = await settledRun("failed");
    const spilledFile = readFileSync((await readObjectRunLogSpill(r.spillDir, r.logRef)).path);
    // Storage still refuses: the read serves the stored prefix, the row stays unknown, the spill is intact.
    const prefix = await readLog(r, "failed");
    expect(prefix.length).toBeLessThan(r.admitted.length);
    expect(r.admitted.subarray(0, prefix.length).equals(prefix)).toBe(true);
    expect(await r.row()).toEqual({ log_bytes: null, log_sha256: null });
    expect(Buffer.concat([prefix, (await readObjectRunLogSpill(r.spillDir, r.logRef)).unrecovered]).equals(r.admitted)).toBe(true);
    // Storage restored: the next read is the whole admitted log.
    r.m.state.down = false;
    const served = await readLog(r, "failed");
    expect(served.toString()).toBe(r.admitted.toString());
    const row = await r.row();
    expect({ bytes: Number(row.log_bytes), sha256: row.log_sha256 }).toEqual({ bytes: r.admitted.length, sha256: sha(r.admitted) });
    expect((await readObjectRunLogSpill(r.spillDir, r.logRef)).unrecovered.length).toBe(0);
    expect(readFileSync((await readObjectRunLogSpill(r.spillDir, r.logRef)).path).equals(spilledFile)).toBe(true);
  }, 60_000);

  it("the startup reconcile recovers settled runs and leaves a running run's spill to its own writer", async () => {
    const settled = await settledRun("succeeded");
    settled.m.state.down = false;
    expect(await recoverSpilledRunLogs(db, newStore(settled.m, settled.spillDir))).toEqual({ spilled: 1, recovered: 1 });
    const row = await settled.row();
    expect({ bytes: Number(row.log_bytes), sha256: row.log_sha256 }).toEqual({ bytes: settled.admitted.length, sha256: sha(settled.admitted) });

    const running = await settledRun("running");
    running.m.state.down = false;
    const before = await readObjectRunLogSpill(running.spillDir, running.logRef);
    expect(await recoverSpilledRunLogs(db, newStore(running.m, running.spillDir))).toEqual({ spilled: 1, recovered: 0 });
    expect(await running.row()).toEqual({ log_bytes: null, log_sha256: null });
    const after = await readObjectRunLogSpill(running.spillDir, running.logRef);
    expect(after.unrecovered.equals(before.unrecovered)).toBe(true);
    expect(after.records).toEqual(before.records);
  }, 60_000);
});
