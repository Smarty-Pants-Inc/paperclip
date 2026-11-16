import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { prepareAgentHire } from "../services/agent-hiring.js";

// Judge RED (rfl-src9-judge): R2 says no path takes the company runtime lock and THEN
// an agent row. prepareAgentHire takes the EXCLUSIVE lock (agent-hiring.ts:38) and then,
// on the hire-inheritance path, enforceClaudeOAuthBindingClaim locks the parent (= the
// hiring agent, routes/agents.ts:4803) FOR UPDATE (agent-credentials.ts:155-164).
// FOR UPDATE conflicts with a FOR KEY SHARE (any FK reference to the parent, e.g. a hire
// with reportsTo = parent, which src9 takes before its own exclusive lock).
// Session B: KEY SHARE on the parent, then a per-agent runtime write (shared hold).
// Session A: the real prepareAgentHire. Rows-first => [null,null]. Expect a 40P01 if not.
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pgCode = (error: unknown) => { let e = error as any; while (e?.cause) e = e.cause; return e?.code ?? null; };
const evidence = (line: string) => { console.info(line); if (process.env.RED_EVIDENCE_FILE) writeFileSync(process.env.RED_EVIDENCE_FILE, line + "\n", { flag: "a" }); };

describePg("judge R2: hire-inheritance parent lock after the exclusive company lock", () => {
  let db: Db;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("judge-r2-inherit-"); db = createDb(temp.connectionString); }, 120_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function scenario(inherit: boolean) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Judge", issuePrefix: `J${companyId.slice(0, 5).toUpperCase()}` });
    const [parent] = await db.insert(agents).values({ companyId, name: "Parent", role: "engineer", adapterType: "claude_local",
      adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } } },
      runtimeConfig: {}, permissions: { canCreateAgents: true } }).returning();
    const [peer] = await db.insert(agents).values({ companyId, name: "Peer", role: "engineer", adapterType: "process" }).returning();
    const codes: Array<string | null> = [null, null];
    let aPid = 0; let aBlockedOnB = false; let aError: unknown = null;
    let aDone!: Promise<void>;
    await db.transaction(async btx => {
      await btx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      const bPid = Number((await btx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
      await btx.execute(sql`SELECT id FROM agents WHERE id = ${parent!.id} FOR KEY SHARE`);
      aDone = db.transaction(async atx => {
        await atx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
        aPid = Number((await atx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
        await prepareAgentHire(atx as unknown as Db, companyId, {
          name: "Child", role: "engineer", adapterType: "claude_local",
          adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } } },
        } as any, { createdByAgentId: parent!.id, createdByAgentCompanyId: companyId, runnerResolved: true,
          claudeLogin: inherit ? { storedSessionId: null, ownerUserId: null, inheritedFromAgentId: parent!.id } as any : undefined } as any);
      }).catch(error => { aError = error; codes[0] = pgCode(error); });
      for (let i = 0; i < 300 && !aBlockedOnB; i++) {
        if (aPid) aBlockedOnB = (await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE pid = ${aPid} AND ${bPid} = ANY(pg_blocking_pids(pid))`)).length > 0;
        if (!aBlockedOnB) await sleep(10);
      }
      // B: a per-agent runtime write (peer title -> paperclip_record_agent_runtime -> SHARED hold).
      await btx.update(agents).set({ title: `t-${randomUUID().slice(0, 6)}` }).where(sql`${agents.id} = ${peer!.id}`);
    }).catch(error => { codes[1] = pgCode(error); });
    await aDone;
    return { codes, aBlockedOnB, aError: aError ? String((aError as any)?.message ?? aError).slice(0, 120) : null };
  }

  it("control: without inheritance the hire takes no agent row after the lock", async () => {
    const r = await scenario(false);
    evidence(`JUDGE_R2_INHERIT_CONTROL ${JSON.stringify(r)}`);
    expect(r.codes).not.toContain("40P01");
  }, 60_000);

  it("RED: hire-inheritance locks the parent FOR UPDATE after the exclusive lock -> must not deadlock", async () => {
    const r = await scenario(true);
    evidence(`JUDGE_R2_INHERIT ${JSON.stringify(r)}`);
    expect(r.codes).not.toContain("40P01");
  }, 60_000);
});
