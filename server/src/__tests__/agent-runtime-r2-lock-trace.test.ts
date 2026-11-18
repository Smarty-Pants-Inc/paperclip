import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { persistActivity } from "../services/activity-log.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// #20805 R2 (src11) lock trace for review-fleet-4's five shapes (R2-PROBES): one lock
// order, existing agent rows (and their FK key shares) BEFORE the company runtime lock.
// For every EXISTING agent row a shape can touch, a blocker session holds that row
// FOR UPDATE (conflicts with every row lock, KEY SHARE included) and never takes the
// company lock. When the writer waits on that row, the trace reads the company
// advisory locks the writer holds at that moment. "afterCompanyLock" counts the rows
// the writer waited for while it held the company lock (either mode): R2 needs 0.
// A writer that never touches the row (none waited) is also R2-clean for that row.
const support = await getEmbeddedPostgresTestSupport();
const pg = support.supported ? describe : describe.skip;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const code = (e: any): string => { while (e?.cause) e = e.cause; return e?.code ?? e?.name ?? "UNKNOWN_ERROR"; };
const evidence = (line: string) => { console.info(line); if (process.env.RED_EVIDENCE_FILE) writeFileSync(process.env.RED_EVIDENCE_FILE, line + "\n", { flag: "a" }); };
const FILE_EVENT = "agent.instructions_file_updated";

type Fixture = { companyId: string; target: { id: string }; actor: { id: string } };
type Shape = (f: Fixture) => Promise<unknown>;

pg("#20805 R2 lock trace: no existing agent row after the company runtime lock (rf4 F1a-d, F2)", () => {
  let db: Db;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("r2-lock-trace-"); db = createDb(temp.connectionString); }, 120_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture(): Promise<Fixture> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "R2 trace", issuePrefix: `T${companyId.slice(0, 5).toUpperCase()}` });
    const rows = await db.insert(agents).values(["target", "actor"].map(name => ({ companyId, name, role: "engineer", adapterType: "process" }))).returning();
    return { companyId, target: rows[0]!, actor: rows[1]! };
  }

  /** One run per existing agent row: block it, run the shape, record the company locks held while waiting. */
  async function trace(shape: Shape, which: Array<"target" | "actor">) {
    const rows: Array<{ row: string; waited: boolean; companyLocksWhileWaiting: string[]; writer: string | null }> = [];
    for (const row of which) {
      const f = await fixture();
      let done = false; let writerCode: string | null = null; let waited = false; let held: string[] = [];
      let writer!: Promise<void>;
      await db.transaction(async tx => {
        const [owner] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        await tx.execute(sql`SELECT id FROM agents WHERE id = ${f[row].id} FOR UPDATE`);
        writer = Promise.resolve().then(() => shape(f)).then(() => undefined, e => { writerCode = code(e); }).finally(() => { done = true; });
        for (let i = 0; i < 300 && !done && !waited; i++) {
          const blocked = await db.execute<{ pid: number }>(sql`SELECT pid FROM pg_stat_activity WHERE ${Number(owner!.pid)} = ANY(pg_blocking_pids(pid))`);
          if (blocked.length) {
            waited = true;
            held = Array.from(await db.execute<{ mode: string }>(sql`SELECT mode FROM pg_locks WHERE pid = ${Number(blocked[0]!.pid)}
              AND locktype = 'advisory' AND granted ORDER BY mode`)).map(l => l.mode);
          } else await sleep(10);
        }
      });
      await writer;
      rows.push({ row, waited, companyLocksWhileWaiting: held, writer: writerCode });
    }
    return { rows, afterCompanyLock: rows.filter(r => r.waited && r.companyLocksWhileWaiting.length > 0).length };
  }

  const shapes: Record<string, { shape: Shape; which: Array<"target" | "actor"> }> = {
    // F1a: one file event, actor differs from the file target (actor FK key share).
    D10_SINGLE: { which: ["target", "actor"], shape: f => persistActivity(db, {
      companyId: f.companyId, actorType: "agent", actorId: f.actor.id, agentId: f.actor.id,
      action: FILE_EVENT, entityType: "agent", entityId: f.target.id, details: { path: "AGENTS.md" } }) },
    // F1b: one INSERT, two file events for two agents.
    D10_MULTI: { which: ["target", "actor"], shape: f => db.execute(sql`INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id)
      VALUES (${f.companyId}, 'system', 'trace', 'agent.files_updated', 'agent', ${f.target.id}),
             (${f.companyId}, 'system', 'trace', 'agent.files_updated', 'agent', ${f.actor.id})`) },
    // F1c: one agents INSERT, the later row reports to an existing manager.
    D9_MULTI: { which: ["target", "actor"], shape: f => db.insert(agents).values([
      { companyId: f.companyId, name: "first new", role: "engineer", adapterType: "process" },
      { companyId: f.companyId, name: "second new", role: "engineer", adapterType: "process", reportsTo: f.actor.id }]) },
    // F2: a company-wide grant (exclusive lock), then an agent secret binding, in one transaction.
    // Metadata-only secret row: no credential value is created or read.
    D7_GRANT_THEN_AGENT_BINDING: { which: ["target", "actor"], shape: async f => {
      const secretId = randomUUID();
      await db.execute(sql`INSERT INTO company_secrets (id, company_id, key, name) VALUES (${secretId}, ${f.companyId}, 'TRACE_METADATA_ONLY', 'Trace metadata only')`);
      await db.transaction(async tx => {
      await tx.execute(sql`INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key) VALUES (${f.companyId}, 'user', 'trace', 'tasks:assign')`);
      await tx.execute(sql`INSERT INTO company_secret_bindings (company_id, secret_id, target_type, target_id, config_path) VALUES (${f.companyId}, ${secretId}, 'agent', ${f.actor.id}, 'env.TRACE_METADATA_ONLY')`);
      });
    } },
    // F1d: the instance-wide skill-pin fanout (every company's agents).
    SKILL_PINS: { which: ["target", "actor"], shape: async () => {
      await db.execute(sql`INSERT INTO instance_settings (singleton_key, experimental) VALUES ('default', '{}'::jsonb) ON CONFLICT (singleton_key) DO NOTHING`);
      await db.execute(sql`UPDATE instance_settings SET experimental = jsonb_set(coalesce(experimental, '{}'::jsonb), '{enableBetaSkills}',
        to_jsonb(NOT coalesce((experimental->>'enableBetaSkills')::boolean, false))) WHERE singleton_key = 'default'`);
    } },
  };

  for (const [name, { shape, which }] of Object.entries(shapes)) {
    it(`${name}: 0 existing agent rows waited for after the company runtime lock`, async () => {
      const observed = await trace(shape, which);
      evidence(`R2_LOCK_TRACE_${name} ${JSON.stringify(observed)}`);
      expect(observed.rows.map(r => r.writer)).toEqual(which.map(() => null));
      expect(observed.afterCompanyLock).toBe(0);
    }, 60_000);
  }

  it("the file-event revision still lands in the activity row and the event exists once per file event", async () => {
    const f = await fixture();
    const [before] = await db.execute<{ id: string }>(sql`SELECT coalesce(max(id), 0)::text AS id FROM resource_lifecycle_events`);
    await db.execute(sql`INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
      VALUES (${f.companyId}, 'system', 'trace', 'agent.files_updated', 'agent', ${f.target.id}, '{"path":"a"}'::jsonb),
             (${f.companyId}, 'system', 'trace', 'issue.updated', 'agent', ${f.target.id}, null),
             (${f.companyId}, 'system', 'trace', 'agent.files_updated', 'agent', ${f.actor.id}, null)`);
    const events = Array.from(await db.execute<{ id: string; resource_id: string }>(sql`SELECT id::text, resource_id::text FROM resource_lifecycle_events
      WHERE id > ${before!.id}::bigint AND resource_type = 'agent_runtime' ORDER BY id`));
    const logged = Array.from(await db.execute<{ action: string; entity_id: string; details: any }>(sql`SELECT action, entity_id, details FROM activity_log
      WHERE company_id = ${f.companyId} ORDER BY action, entity_id`));
    evidence(`R2_FILE_EVENT_REVISIONS ${JSON.stringify({ events, logged })}`);
    expect(events.map(e => e.resource_id)).toEqual([f.target.id, f.actor.id]);
    const byAgent = (id: string) => logged.find(l => l.action === "agent.files_updated" && l.entity_id === id)!.details;
    expect(byAgent(f.target.id)).toEqual({ path: "a", agentRuntimeRevision: events[0]!.id });
    expect(byAgent(f.actor.id)).toEqual({ agentRuntimeRevision: events[1]!.id });
    expect(logged.find(l => l.action === "issue.updated")!.details).toBeNull();
  }, 30_000);
});
