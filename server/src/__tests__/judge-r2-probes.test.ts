import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { persistActivity } from "../services/activity-log.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const pg = support.supported ? describe : describe.skip;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const code = (e: any): string => { while (e?.cause) e = e.cause; return e?.code ?? e?.name ?? "UNKNOWN_ERROR"; };
pg("Independent tightened-R2 probes at exact src9", () => {
  let db: Db;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("judge-r2-"); db = createDb(temp.connectionString); }, 120_000);
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Independent R2", issuePrefix: `J${companyId.slice(0, 5).toUpperCase()}` });
    const rows = await db.insert(agents).values(["target", "actor"].map(name => ({ companyId, name, role: "engineer", adapterType: "process" }))).returning();
    return { companyId, target: rows[0]!, actor: rows[1]! };
  }
  async function blockedBy(pid: number) {
    for (let i = 0; i < 300; i++) {
      const rows = await db.execute<{ pid: number }>(sql`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`);
      if (rows.length) return Number(rows[0]!.pid);
      await sleep(10);
    }
    throw new Error("PROBE_DID_NOT_REACH_EXPECTED_ROW_WAIT");
  }
  async function cycle(f: Awaited<ReturnType<typeof fixture>>, work: () => Promise<unknown>, mode: "update" | "no key update") {
    const codes: Array<string | null> = [null, null];
    let writer: Promise<unknown> | undefined;
    let trace: unknown = null;
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      const [owner] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (mode === "update") await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.actor.id} FOR UPDATE`);
      else await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.actor.id} FOR NO KEY UPDATE`);
      writer = work().catch(e => { codes[1] = code(e); });
      const pid = await blockedBy(Number(owner!.pid));
      trace = Array.from(await db.execute(sql`SELECT locktype, mode, granted FROM pg_locks WHERE pid = ${pid} AND (locktype = 'advisory' OR NOT granted) ORDER BY locktype, mode`));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('paperclip.connector_runtime:' || ${f.companyId}::uuid::text, 0))`);
    }).catch(e => { codes[0] = code(e); });
    await writer;
    return { codes, trace };
  }
  it("R2 forbids the activity_log BEFORE trigger taking SHARED and then its actor FK KEY SHARE, even for ONE file event", async () => {
    const f = await fixture();
    const observed = await cycle(f, () => persistActivity(db, {
      companyId: f.companyId, actorType: "agent", actorId: f.actor.id, agentId: f.actor.id,
      action: "agent.instructions_file_updated", entityType: "agent", entityId: f.target.id,
      details: { path: "AGENTS.md" },
    }), "update");
    console.info("JUDGE_R2_D10_SINGLE_EVENT_FK", JSON.stringify(observed));
    expect(observed.codes).toEqual([null, null]);
  }, 30_000);
  it("control: taking the activity actor FK key share BEFORE the file-event shared hold removes the single-event cycle", async () => {
    const f = await fixture();
    const observed = await cycle(f, () => db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.actor.id} FOR KEY SHARE`);
      await persistActivity(tx as unknown as Db, {
        companyId: f.companyId, actorType: "agent", actorId: f.actor.id, agentId: f.actor.id,
        action: "agent.instructions_file_updated", entityType: "agent", entityId: f.target.id,
        details: { path: "AGENTS.md" },
      });
    }), "update");
    console.info("JUDGE_R2_D10_FK_PRELOCK_CONTROL", JSON.stringify(observed));
    expect(observed.codes).toEqual([null, null]);
  }, 30_000);
  it("R2 forbids a multi-row activity_log file-event INSERT taking SHARED after agent 1 and then agent 2's row", async () => {
    const f = await fixture();
    const observed = await cycle(f, () => db.execute(sql`INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id)
      VALUES (${f.companyId}, 'system', 'judge', 'agent.files_updated', 'agent', ${f.target.id}),
             (${f.companyId}, 'system', 'judge', 'agent.files_updated', 'agent', ${f.actor.id})`), "no key update");
    console.info("JUDGE_R2_D10_MULTI_EVENT", JSON.stringify(observed));
    expect(observed.codes).toEqual([null, null]);
  }, 30_000);
  it("R2 forbids the connector secret-binding branch skipping its agent prelock after an earlier company-wide invalidation", async () => {
    const f = await fixture();
    const secretId = randomUUID();
    // Metadata-only fixture: no credential value is created or read.
    await db.execute(sql`INSERT INTO company_secrets (id, company_id, key, name) VALUES (${secretId}, ${f.companyId}, 'JUDGE_METADATA_ONLY', 'Judge metadata only')`);
    const observed = await cycle(f, () => db.transaction(async tx => {
      await tx.execute(sql`INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key) VALUES (${f.companyId}, 'user', 'judge', 'tasks:assign')`);
      await tx.execute(sql`INSERT INTO company_secret_bindings (company_id, secret_id, target_type, target_id, config_path) VALUES (${f.companyId}, ${secretId}, 'agent', ${f.actor.id}, 'env.JUDGE_METADATA_ONLY')`);
    }), "no key update");
    console.info("JUDGE_R2_D7_SKIPPED_PRELOCK_AFTER_COMPANY_INVALIDATION", JSON.stringify(observed));
    expect(observed.codes).toEqual([null, null]);
  }, 30_000);
  it("R2 forbids an agents multi-row INSERT taking SHARED in its first runtime AFTER trigger and then a later row's reports_to FK KEY SHARE", async () => {
    const f = await fixture();
    const observed = await cycle(f, () => db.insert(agents).values([
      { companyId: f.companyId, name: "first new child", role: "engineer", adapterType: "process" },
      { companyId: f.companyId, name: "second new child", role: "engineer", adapterType: "process", reportsTo: f.actor.id },
    ]), "update");
    console.info("JUDGE_R2_D9_MULTI_AGENT_FK", JSON.stringify(observed));
    expect(observed.codes).toEqual([null, null]);
  }, 30_000);
  it("R2 forbids the instance skill-pin fanout holding a SHARED company lock while waiting for the next company's agent row", async () => {
    const first = '00000000-0000-4000-8000-000000000001', second = 'ffffffff-ffff-4fff-bfff-fffffffffff1';
    await db.insert(companies).values([{ id: first, name: "First", issuePrefix: "JFIRST" }, { id: second, name: "Second", issuePrefix: "JLAST" }]);
    const a = await db.insert(agents).values([{ companyId: first, name: "first", adapterType: "process" }, { companyId: second, name: "last", adapterType: "process" }]).returning();
    await db.execute(sql`INSERT INTO instance_settings (singleton_key, experimental) VALUES ('default', '{}'::jsonb) ON CONFLICT (singleton_key) DO NOTHING`);
    let writer: Promise<unknown> | undefined; let held: unknown[] = [];
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${a[1]!.id} FOR NO KEY UPDATE`);
      const [owner] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      writer = db.execute(sql`UPDATE instance_settings SET experimental = jsonb_set(coalesce(experimental, '{}'::jsonb), '{enableBetaSkills}', 'true'::jsonb) WHERE singleton_key = 'default'`).then(x => x);
      const pid = await blockedBy(Number(owner!.pid));
      held = Array.from(await db.execute(sql`SELECT locktype, mode, granted FROM pg_locks WHERE pid = ${pid} AND locktype = 'advisory' AND mode = 'ShareLock' AND granted`));
    });
    await writer;
    console.info("JUDGE_R2_SKILL_PINS_POST_HOLD_AGENT_WAIT", JSON.stringify({ heldSharedLocksWhileWaitingForAgent: held.length }));
    expect(held).toHaveLength(0);
  }, 30_000);
  it("Residual 2 is a real Postgres-detected SHARED-to-EXCLUSIVE upgrade deadlock, without a subsequent agent-row acquisition", async () => {
    const f = await fixture();
    let ready!: () => void, release!: () => void;
    const both = new Promise<void>(r => { ready = r; }), go = new Promise<void>(r => { release = r; });
    const codes: Array<string | null> = [null, null];
    const one = db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      await tx.update(agents).set({ title: "first" }).where(sql`${agents.id} = ${f.target.id}`);
      ready(); await go;
      await tx.execute(sql`INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key) VALUES (${f.companyId}, 'user', 'one', 'tasks:assign')`);
    }).catch(e => { codes[0] = code(e); });
    await both;
    const two = db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      await tx.update(agents).set({ title: "second" }).where(sql`${agents.id} = ${f.actor.id}`);
      release();
      await tx.execute(sql`INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key) VALUES (${f.companyId}, 'user', 'two', 'tasks:assign')`);
    }).catch(e => { codes[1] = code(e); });
    await Promise.all([one, two]);
    console.info("JUDGE_RESIDUAL2_REAL_UPGRADE", JSON.stringify({ codes }));
    expect(codes).toContain("40P01");
  }, 30_000);
});
