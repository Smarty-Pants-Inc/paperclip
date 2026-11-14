import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, issues, toolProfiles, type Db } from "@paperclipai/db";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import type { ConnectionManagementContext } from "../services/connection-management.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
// Normal task admission checks the requested parent, then checks the flattened
// effective parent separately. The latter can belong to a lower-ID former agent.
// Keep: active-root counterpart to the terminated-parent judge.
suite("active runtime gateway locks versus task admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("judge-gateway-task-admission-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  it("does not deadlock creation beside a child whose root belongs to a lower-ID active agent", async () => {
    const companyId = randomUUID();
    const [lower, higher] = [randomUUID(), randomUUID()].sort() as [string, string];
    await db.insert(companies).values({ id: companyId, name: "Judge task admission", issuePrefix: `A${companyId.slice(0,6)}` });
    await db.insert(agents).values([
      { id: lower, companyId, name: "Active root owner", status: "idle", lifecycleState:"ready", adapterType: "process" },
      { id: higher, companyId, name: "Current task actor", status: "idle", lifecycleState:"ready", adapterType: "process" },
    ]);
    const [root] = await db.insert(issues).values({companyId,title:"Existing root",status:"todo",assigneeAgentId:lower}).returning();
    const [child] = await db.insert(issues).values({companyId,title:"Current child",status:"todo",assigneeAgentId:higher,parentId:root!.id}).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: randomUUID(), name: "Judge profile" }).returning();
    const gateway = await createToolGatewayService(db).createNamedGateway({ companyId, body: { name: "Gateway", slug: randomUUID(), profileId: profile!.id, agentId: higher }, actor: { agentId: higher } });
    let ready!: () => void, release!: () => void;
    const held = new Promise<void>(r => { ready = r; });
    const resume = new Promise<void>(r => { release = r; });
    const barrier = db.transaction(async tx => { await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, root!.id)).for("update"); ready(); await resume; });
    const barrierResult = Promise.allSettled([barrier]);
    let readerPid: number | undefined, writerPid: number | undefined;
    let readerResult: Promise<PromiseSettledResult<unknown>[]> | undefined, writerResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let waitError: unknown;
    const waitForLock = async (pid: () => number | undefined) => vi.waitFor(async () => {
      expect(pid()).toBeDefined();
      const [row] = await db.execute<{ wait: string | null }>(sql`select wait_event_type as wait from pg_stat_activity where pid = ${pid()!}`);
      expect(row?.wait).toBe("Lock");
    }, { timeout: 5_000, interval: 10 });
    try {
      await held;
      readerResult = Promise.allSettled([db.transaction(async tx => {
        await tx.execute(sql`set local deadlock_timeout = '200ms'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        const [p] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); readerPid = p!.pid;
        return issueService(tx as unknown as Db).create(companyId, {title:"Follow-up task",status:"todo",createdByAgentId:higher,assigneeAgentId:higher,parentId:child!.id,expectedParentId:root!.id,parentDepthPolicy:"flatten"});
      })]);
      await waitForLock(() => readerPid);
      writerResult = Promise.allSettled([db.transaction(async tx => {
        await tx.execute(sql`set local deadlock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        const [p] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); writerPid = p!.pid;
        const managementContext = { actor: { type: "agent", agentId: higher, companyId }, audit: { actorType: "agent", actorId: higher, agentId: higher }, reauthorize: async () => {} } as ConnectionManagementContext;
        return createToolGatewayService(tx as unknown as Db).updateNamedGateway({ companyId, gatewayId: gateway.id, body: { name: "Changed" }, managementContext });
      })]);
      await waitForLock(() => writerPid);
    } catch (error) { waitError = error; }
    finally { release(); }
    await barrierResult;
    const results = [...await (readerResult ?? Promise.resolve([])), ...await (writerResult ?? Promise.resolve([]))];
    if (waitError) throw waitError;
    const outcomes = results.map(r => r.status === "fulfilled" ? "committed" : { code: r.reason?.cause?.code ?? r.reason?.code, message: String(r.reason?.cause?.message ?? r.reason?.message) });
    console.log("[judge-task-admission-lock-order]", JSON.stringify({ outcomes }));
    expect(outcomes).toEqual(["committed", "committed"]);
    expect(await db.select({parentId:issues.parentId}).from(issues).where(and(eq(issues.companyId,companyId),eq(issues.title,"Follow-up task")))).toEqual([{parentId:root!.id}]);
  }, 20_000);
});
