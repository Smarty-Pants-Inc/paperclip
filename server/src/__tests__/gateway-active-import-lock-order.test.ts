import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, issues, issueComments, toolMcpGateways, toolProfiles, type Db } from "@paperclipai/db";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import type { ConnectionManagementContext } from "../services/connection-management.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// Real import owner loops over comments, locking each interaction separately.
// Barrier is an unrelated transaction holding the SECOND issue, not mocked SQL.
// No runtime subscriber: isolates the new all-status lock's conflict surface.
// Keep: active-reader counterpart to the pending-mention judge. A complete
// configure set alone must not introduce a new earlier-N / later-S cycle.
suite("active runtime gateway locks versus batched interaction reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("judge-gateway-import-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  it("does not deadlock a real comment import which mentions a lower-ID active agent in its second row", async () => {
    const companyId = randomUUID();
    const [lower, higher] = [randomUUID(), randomUUID()].sort() as [string, string];
    await db.insert(companies).values({ id: companyId, name: "Judge batch interaction", issuePrefix: `B${companyId.slice(0,6)}` });
    await db.insert(agents).values([
      { id: lower, companyId, name: "Active later mention", status: "idle", adapterType: "process" },
      { id: higher, companyId, name: "Import actor", status: "idle", adapterType: "process" },
    ]);
    const [one, two] = await db.insert(issues).values([1,2].map(n => ({ companyId, title: `Import target ${n}`, status: "todo", assigneeAgentId: higher }))).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: randomUUID(), name: "Judge profile" }).returning();
    const gateway = await createToolGatewayService(db).createNamedGateway({ companyId, body: { name: "Gateway", slug: randomUUID(), profileId: profile!.id, agentId: higher }, actor: { agentId: higher } });
    let ready!: () => void, release!: () => void;
    const held = new Promise<void>(r => { ready = r; });
    const resume = new Promise<void>(r => { release = r; });
    const barrier = db.transaction(async tx => { await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, two!.id)).for("update"); ready(); await resume; });
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
        await issueService(tx as unknown as Db).addImportedComments([
          { id: randomUUID(), companyId, issueId: one!.id, authorType: "agent", authorAgentId: higher, authorUserId:null, presentation:null, metadata:null, createdAt:null, body: "First comment" },
          { id: randomUUID(), companyId, issueId: two!.id, authorType: "agent", authorAgentId: higher, authorUserId:null, presentation:null, metadata:null, createdAt:null, body: `[Pending](agent://${lower})` },
        ], higher);
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
    console.log("[judge-import-lock-order]", JSON.stringify({ outcomes }));
    expect(outcomes).toEqual(["committed", "committed"]);
    expect(await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.companyId, companyId))).toHaveLength(2);
    expect(await db.select({ name: toolMcpGateways.name }).from(toolMcpGateways).where(and(eq(toolMcpGateways.companyId, companyId), eq(toolMcpGateways.id, gateway.id)))).toEqual([{ name: "Changed" }]);
  }, 20_000);
});
