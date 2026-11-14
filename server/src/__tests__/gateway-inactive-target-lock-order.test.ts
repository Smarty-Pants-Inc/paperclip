import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, toolMcpGateways, toolProfiles, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertAgentInteraction } from "../services/agent-interaction-policy.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import type { ConnectionManagementContext } from "../services/connection-management.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// Keep reason: F-GW-1 / 387a3ebf locked the active actor before excluded
// configure targets. Exercise both sides of a rebind and clearing the old side,
// with actual PG row locks and the real configure policy, not a SQL mock.
suite("gateway lock order covers terminated targets and binding changes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-gateway-inactive-target-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each(["create", "rebind-from", "rebind-to", "clear"] as const)("%s locks the lower-ID terminated target before the active actor", async operation => {
    const companyId = randomUUID();
    const [lower, higher] = [randomUUID(), randomUUID()].sort();
    await db.insert(companies).values({ id: companyId, name: "Inactive gateway target", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: lower!, companyId, name: "Terminated target", status: "terminated", adapterType: "paperclip_runner" },
      { id: higher!, companyId, name: "Active actor", status: "idle", adapterType: "paperclip_runner" },
    ]);
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: randomUUID(), name: "Gateway profile" }).returning();
    const initialAgentId = operation === "rebind-to" ? higher! : lower!;
    const body = { name: "Gateway", slug: `inactive-${randomUUID()}`, profileId: profile!.id, agentId: initialAgentId };
    const existing = operation === "create" ? null : await createToolGatewayService(db).createNamedGateway({ companyId, body, actor: { agentId: higher } });
    const finalAgentId = operation === "clear" ? null : operation === "rebind-from" ? higher! : lower!;
    let ready!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const reader = db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '200ms'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, lower!)).for("share");
      ready();
      await resume;
      await assertAgentInteraction(tx, { companyId, actorAgentId: higher, operation: "configure", targetAgentId: lower, lock: true });
    });
    const readerResult = Promise.allSettled([reader]);
    let writerResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let writerPid: number | undefined;
    let waitingQuery = "";
    let waitError: unknown;
    try {
      await Promise.race([held, reader.then(() => { throw new Error("Reader exited before acquiring lower row"); })]);
      writerResult = Promise.allSettled([db.transaction(async tx => {
        await tx.execute(sql`set local deadlock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        writerPid = backend!.pid;
        const service = createToolGatewayService(tx as unknown as Db);
        if (!existing) return service.createNamedGateway({ companyId, body, actor: { agentId: higher } });
        // As in the original regression, only the outer reauthorization is a
        // no-op; the in-transaction old/new-target configure checks remain real.
        const managementContext = { actor: { type: "agent", agentId: higher, companyId },
          audit: { actorType: "agent", actorId: higher, agentId: higher }, reauthorize: async () => {} } as ConnectionManagementContext;
        return service.updateNamedGateway({ companyId, gatewayId: existing.id, body: { name: "Changed", agentId: finalAgentId }, managementContext });
      })]);
      await vi.waitFor(async () => {
        expect(writerPid).toBeDefined();
        const [activity] = await db.execute<{ wait: string | null; query: string }>(sql`select wait_event_type as wait, query from pg_stat_activity where pid = ${writerPid!}`);
        expect(activity?.wait).toBe("Lock");
        waitingQuery = activity!.query;
      }, { timeout: 5_000, interval: 10 });
    } catch (error) {
      waitError = error;
    } finally {
      release();
    }
    const results = [...await readerResult, ...await (writerResult ?? Promise.resolve([]))];
    if (waitError) throw waitError;
    const outcomes = results.map(result => result.status === "fulfilled" ? "committed" : {
      code: result.reason?.cause?.code ?? result.reason?.code,
      message: String(result.reason?.cause?.message ?? result.reason?.message),
    });
    console.log("[gateway-inactive-target]", JSON.stringify({ operation, waitingQuery, outcomes }));
    expect(outcomes).toEqual(["committed", "committed"]);
    const rows = await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: finalAgentId, name: existing ? "Changed" : body.name });
  }, 20_000);
});
