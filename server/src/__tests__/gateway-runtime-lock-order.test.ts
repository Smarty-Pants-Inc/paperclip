import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  agents, companies, createDb, plugins, resourceLifecycleEvents, toolMcpGateways,
  toolProfiles, type Db,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertAgentInteraction } from "../services/agent-interaction-policy.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import type { ConnectionManagementContext } from "../services/connection-management.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// C8 / cd191df1: gateway admission locks its own (higher-ID) agent, then
// the connector trigger visits the whole company from the lowest ID. A
// concurrent permission reader visits lower -> higher, completing the cycle.
// Keep reason: the production 40P01 at 2026-11-13 20:50:47.956, plus data safety
// of the transactional runtime invalidation journal. No SQL/trigger mocks.
suite("gateway runtime invalidation lock order", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-gateway-lock-order-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each(["create", "update"] as const)("%s takes the complete runtime lock set before scoped permission locks", async operation => {
    const companyId = randomUUID();
    const [lower, higher] = [randomUUID(), randomUUID()].sort();
    const pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Gateway deadlock regression", issuePrefix: `G${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "runtime-fixture", version: "1.0.0", status: "ready",
      manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", "agents.lifecycle.manage"] } as never });
    await db.insert(agents).values([lower!, higher!].map(id => ({ id, companyId, name: id, adapterType: "paperclip_runner", lifecycleRequiredPluginIds: [pluginId] })));
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: randomUUID(), name: "Native profile" }).returning();
    const body = { name: "Native warm-up gateway", slug: `native-${randomUUID()}`, profileId: profile!.id, agentId: higher!,
      contextScopeType: "agent" as const, contextScopeId: higher!, metadata: { nativeRuntimeAssignmentDigest: randomUUID(), agentId: higher! } };
    const existing = operation === "update" ? await createToolGatewayService(db).createNamedGateway({ companyId, body, actor: { agentId: higher } }) : null;
    const journal = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"))).orderBy(resourceLifecycleEvents.id);
    const eventsBefore = (await journal()).length;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    let release!: () => void;
    const resume = new Promise<void>(resolve => { release = resolve; });
    // First acquire only the lower row. Once the other transaction actually
    // waits for that lock, ask the real permission reader for lower + higher.
    const reader = db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '200ms'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await assertAgentInteraction(tx, { companyId, actorAgentId: lower, operation: "configure", targetAgentId: lower, lock: true });
      ready();
      await resume;
      await assertAgentInteraction(tx, { companyId, actorAgentId: lower, operation: "configure", targetAgentId: higher, lock: true });
    });
    // Attach rejection handlers immediately; always drain both transactions.
    const readerResult = Promise.allSettled([reader]);
    let writerResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let writerPid: number | undefined;
    let waitingQuery = "";
    let waitError: unknown;
    try {
      await held;
      writerResult = Promise.allSettled([db.transaction(async tx => {
        await tx.execute(sql`set local deadlock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        writerPid = backend!.pid;
        const service = createToolGatewayService(tx as unknown as Db);
        if (existing) {
          // Reauthorization is a separate boundary; the transaction's actual
          // configure-permission checks below remain real and locked.
          const managementContext = { actor: { type: "agent", agentId: higher, companyId },
            audit: { actorType: "agent", actorId: higher, agentId: higher }, reauthorize: async () => {} } as ConnectionManagementContext;
          return service.updateNamedGateway({ companyId, gatewayId: existing.id, body: { name: "Updated native gateway" }, managementContext });
        }
        return service.createNamedGateway({ companyId, body, actor: { agentId: higher } });
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
      code: result.reason?.cause?.code ?? result.reason?.code, message: String(result.reason?.cause?.message ?? result.reason?.message),
    });
    console.log("[gateway-runtime-lock-order]", JSON.stringify({ operation, waitingQuery, outcomes }));
    expect(outcomes).toEqual(["committed", "committed"]);
    const gateways = await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, companyId));
    expect(gateways).toHaveLength(1);
    expect(gateways[0]).toMatchObject({ agentId: higher, name: existing ? "Updated native gateway" : body.name });
    // The fix must preserve, not bypass, the company-wide invalidation.
    expect((await journal()).slice(eventsBefore).map(row => row.resourceId).sort()).toEqual([lower, higher]);
  }, 20_000);
});
