import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, issues, toolProfiles, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lockAgentForRunWrite } from "../agent-run-cancellation.js";
import { issueService } from "../services/issues.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { startRecoveryPostgres, recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";
import type { ConnectionManagementContext } from "../services/connection-management.js";

// Keep: the native tool authority takes the actor's lifecycle SHARE fence before
// invoking its issue mutation. A later policy query must not be assumed to be
// the first agent lock of the OUTER transaction.
(support.supported ? describe : describe.skip)("gateway versus a preheld run-write policy reader", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => { temporary = await startRecoveryPostgres("gateway-preheld-reader-"); db = createDb(temporary.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  it("a real run-write fence followed by a real lower-agent mention commits alongside a gateway update", async () => {
    const companyId = randomUUID(), [lower, higher] = [randomUUID(), randomUUID()].sort() as [string, string];
    await db.insert(companies).values({ id: companyId, name: "Preheld lifecycle reader", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values([lower, higher].map(id => ({ id, companyId, name: id, status: "idle", adapterType: "process" })));
    const [task] = await db.insert(issues).values({ companyId, title: "Run-owned task", assigneeAgentId: higher }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: randomUUID(), name: "Profile" }).returning();
    const gateway = await createToolGatewayService(db).createNamedGateway({ companyId, body: { name: "Gateway", slug: randomUUID(), profileId: profile!.id, agentId: higher }, actor: { agentId: higher } });
    let ready!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    let writerPid: number | undefined;
    const reader = Promise.allSettled([db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`set local deadlock_timeout = '100ms'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await lockAgentForRunWrite(tx, companyId, higher);
      ready(); await resume;
      return issueService(tx).addComment(task!.id, `[Lower](agent://${lower})`, { agentId: higher }, undefined, tx);
    })]);
    let writer: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await held;
      writer = Promise.allSettled([db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await tx.execute(sql`set local deadlock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '8s'`);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); writerPid = backend!.pid;
        const managementContext = { actor: { type: "agent", agentId: higher, companyId }, audit: { actorType: "agent", actorId: higher, agentId: higher }, reauthorize: async () => {} } as ConnectionManagementContext;
        return createToolGatewayService(tx).updateNamedGateway({ companyId, gatewayId: gateway.id, body: { name: "Changed" }, managementContext });
      })]);
      await vi.waitFor(async () => {
        expect(writerPid).toBeDefined();
        const [state] = await db.execute<{ wait: string | null; query: string }>(sql`select wait_event_type as wait, query from pg_stat_activity where pid=${writerPid!}`);
        expect(state?.wait).toBe("Lock"); expect(state!.query).toContain('from "agents"');
      }, { timeout: 3000, interval: 10 });
    } finally { release(); await reader; if (writer) await writer; }
    const detail = (error: any): any => error?.cause ? detail(error.cause) : { code: error?.code, message: error?.message, detail: error?.detail, where: error?.where };
    const outcomes = [...await reader, ...await (writer ?? [])].map(result => result.status === "fulfilled" ? "committed" : detail(result.reason));
    console.log("[preheld-run-reader]", JSON.stringify({ outcomes }));
    expect(outcomes).toEqual(["committed", "committed"]);
  }, 15_000);
});
