import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, toolMcpGateways, toolProfiles, type Db } from "@paperclipai/db";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertAgentInteraction } from "../services/agent-interaction-policy.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import type { ConnectionManagementContext } from "../services/connection-management.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// Independent judge: the complete lock set must also include a scoped target
// excluded by the runtime status filter. Pending approval is not an absent row.
suite("judge: gateway lock order includes non-runtime configure targets", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("judge-gateway-excluded-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  it.each(["create", "update"] as const)("%s does not invert a lower-ID pending-approval target against an active actor", async operation => {
    const companyId = randomUUID();
    const [lower, higher] = [randomUUID(), randomUUID()].sort();
    await db.insert(companies).values({ id: companyId, name: "Judge scoped target", issuePrefix: `J${companyId.slice(0,6)}` });
    await db.insert(agents).values([
      { id: lower!, companyId, name: "Pending target", status: "pending_approval", adapterType: "paperclip_runner" },
      { id: higher!, companyId, name: "Active actor", status: "idle", adapterType: "paperclip_runner" },
    ]);
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: randomUUID(), name: "Judge profile" }).returning();
    const body = { name: "Judge gateway", slug: `judge-${randomUUID()}`, profileId: profile!.id, agentId: lower!, contextScopeType: "agent" as const, contextScopeId: lower! };
    const existing = operation === "update" ? await createToolGatewayService(db).createNamedGateway({ companyId, body, actor: { agentId: higher } }) : null;
    let ready!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const reader = db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '200ms'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      // Model an in-flight ordered reader between its lower and higher rows.
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, lower!)).for("share");
      ready(); await resume;
      // Actual reader policy: the authenticated actor is active, target pending.
      await assertAgentInteraction(tx, { companyId, actorAgentId: higher, operation: "configure", targetAgentId: lower, lock: true });
    });
    const readerResult = Promise.allSettled([reader]);
    let writerResult: Promise<PromiseSettledResult<unknown>[]> | undefined, writerPid: number | undefined, waitError: unknown;
    let waitingQuery = "";
    try {
      await Promise.race([held, reader.then(() => { throw new Error("Reader exited before acquiring lower row"); })]);
      writerResult = Promise.allSettled([db.transaction(async tx => {
        await tx.execute(sql`set local deadlock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); writerPid = backend!.pid;
        const service = createToolGatewayService(tx as unknown as Db);
        if (!existing) return service.createNamedGateway({ companyId, body, actor: { agentId: higher } });
        const managementContext = { actor: { type: "agent", agentId: higher, companyId }, audit: { actorType: "agent", actorId: higher, agentId: higher }, reauthorize: async () => {} } as ConnectionManagementContext;
        return service.updateNamedGateway({ companyId, gatewayId: existing.id, body: { name: "Changed" }, managementContext });
      })]);
      await vi.waitFor(async () => {
        expect(writerPid).toBeDefined();
        const [activity] = await db.execute<{ wait: string | null; query: string }>(sql`select wait_event_type as wait, query from pg_stat_activity where pid = ${writerPid!}`);
        expect(activity?.wait).toBe("Lock"); waitingQuery = activity!.query;
      }, { timeout: 5_000, interval: 10 });
    } catch (error) { waitError = error; }
    finally { release(); }
    const results = [...await readerResult, ...await (writerResult ?? Promise.resolve([]))];
    if (waitError) throw waitError;
    const outcomes = results.map(result => result.status === "fulfilled" ? "committed" : { code: result.reason?.cause?.code ?? result.reason?.code, message: String(result.reason?.cause?.message ?? result.reason?.message) });
    console.log("[judge-excluded-target]", JSON.stringify({ operation, waitingQuery, outcomes }));
    expect(outcomes).toEqual(["committed", "committed"]);
    const rows = await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, companyId));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ agentId: lower, name: existing ? "Changed" : body.name });
  }, 20_000);
});
