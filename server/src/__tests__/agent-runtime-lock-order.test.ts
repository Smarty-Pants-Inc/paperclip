import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, principalPermissionGrants, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lockCompanyAgentRuntime } from "../services/agent-runtime-lock.js";

// #20805 lock-order evidence for migration 0489's rule: existing agent rows
// first, then the company runtime lock. Two sessions each, no timing races
// decide the outcome: each step waits for the other session to be blocked.
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const evidence = (line: string) => { console.info(line); if (process.env.RED_EVIDENCE_FILE) writeFileSync(process.env.RED_EVIDENCE_FILE, line + "\n", { flag: "a" }); };
const pgCode = (error: unknown) => { let e = error as any; while (e?.cause) e = e.cause; return e?.code ?? null; };

describePg("#20805 company runtime lock order", () => {
  let db: Db;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("runtime-lock-order-"); db = createDb(temp.connectionString); }, 120_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function company(peers: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Order", issuePrefix: `O${companyId.slice(0, 5).toUpperCase()}` });
    const rows = await db.insert(agents).values(Array.from({ length: peers }, (_, i) => ({ companyId, name: `A${i}`, role: "engineer", adapterType: "process" }))).returning();
    const [hirer] = await db.insert(agents).values({ id: `f${companyId.slice(1, 8)}-ffff-4fff-bfff-${companyId.slice(-12)}`, companyId, name: "Hirer",
      role: "general", adapterType: "process" }).returning();
    return { companyId, hirer: hirer!, peers: rows };
  }
  async function waitUntilBlocked(pid: number) {
    for (let i = 0; i < 300; i++) {
      if ((await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`)).length) return true;
      await sleep(10);
    }
    return false;
  }

  /** Session A takes the hirer row and the company lock in `order`; session B
   * is a single-agent runtime write of the hirer (row, then the shared hold). */
  async function hirerVersusRuntimeWrite(order: "row-then-lock" | "lock-then-row") {
    const f = await company(3);
    const codes: Array<string | null> = [null, null];
    let pidA = 0; let bStarted!: () => void; const bGo = new Promise<void>(r => { bStarted = r; });
    let b: Promise<void> | undefined;
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      pidA = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
      if (order === "row-then-lock") await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.hirer.id} FOR NO KEY UPDATE`);
      else await lockCompanyAgentRuntime(tx as unknown as Db, f.companyId);
      b = (async () => {
        bStarted();
        await db.transaction(async btx => {
          await btx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
          await btx.update(agents).set({ title: `t-${randomUUID().slice(0, 6)}` }).where(sql`${agents.id} = ${f.hirer.id}`);
        }).catch(error => { codes[1] = pgCode(error); });
      })();
      await bGo;
      await sleep(150); // B holds the hirer row (lock-then-row) or waits for it (row-then-lock)
      if (order === "row-then-lock") await lockCompanyAgentRuntime(tx as unknown as Db, f.companyId);
      else await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.hirer.id} FOR NO KEY UPDATE`);
      await tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: "u", permissionKey: "tasks:assign" });
    }).catch(error => { codes[0] = pgCode(error); });
    await b;
    return codes;
  }

  it("the hire's placement (hirer row, then the company lock) does not deadlock with a runtime write of the hirer; the reverse placement does", async () => {
    const ours = await hirerVersusRuntimeWrite("row-then-lock");
    const reverse = await hirerVersusRuntimeWrite("lock-then-row");
    evidence(`LOCK_ORDER_PLACEMENT ${JSON.stringify({ rowThenLock: ours, lockThenRow: reverse })}`);
    expect(ours).toEqual([null, null]);
    expect(reverse).toContain("40P01");
  }, 30_000);

  it("a hire holding the hirer row and the company lock does not deadlock with the startup runtime refresh", async () => {
    const f = await company(20);
    const codes: Array<string | null> = [null, null];
    let refresh: Promise<void> | undefined;
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.hirer.id} FOR NO KEY UPDATE`);
      await lockCompanyAgentRuntime(tx as unknown as Db, f.companyId);
      refresh = db.execute(sql`SELECT paperclip_invalidate_company_agent_runtimes(${f.companyId}::uuid)`).then(() => undefined, error => { codes[1] = pgCode(error); });
      expect(await waitUntilBlocked(pid)).toBe(true);
      await tx.insert(agents).values({ companyId: f.companyId, name: "New hire", role: "engineer", adapterType: "process" });
      await tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: "u", permissionKey: "tasks:assign" });
    }).catch(error => { codes[0] = pgCode(error); });
    await refresh;
    evidence(`LOCK_ORDER_REFRESH ${JSON.stringify({ codes })}`);
    expect(codes).toEqual([null, null]);
  }, 30_000);
});
