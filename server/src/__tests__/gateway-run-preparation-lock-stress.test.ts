import { createHash, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, toolAccessAuditEvents, agents, companies, createDb, heartbeatRuns, toolApplications, toolConnections, toolConnectionInstalls,
  toolProfiles, toolProfileEntries, toolProfileBindings, toolMcpGateways, toolMcpGatewayTokens, type Db } from "@paperclipai/db";
import { startRecoveryPostgres, recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat/run-preparation.js";
import { logger } from "../middleware/logger.js";
import * as liveEvents from "../services/live-events.js";

// Keep: production cd191df1 / SMAA-1955. Actual runtime assignment/profile,
// gateway, token and synchronous invalidation writes; no provider or DB mocks.
function detail(error: any): any { return error?.cause ? detail(error.cause) : { code: error?.code, message: error?.message }; }
function observeTransactions(db: Db, setup: (tx: Db) => Promise<void>): Db {
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return (callback: (tx: Db) => Promise<unknown>) => target.transaction(async tx => {
      await setup(tx as unknown as Db); return callback(observeTransactions(tx as unknown as Db, setup));
    });
  } });
}
async function record(kind: string, value: unknown) {
  console.log(`[${kind}]`, JSON.stringify(value));
  if (process.env.TASK_OUT) await appendFile(join(process.env.TASK_OUT, `latency-${process.env.LOCKFIX_VARIANT ?? "candidate"}.ndjson`), JSON.stringify({ kind, value }) + "\n");
}
(support.supported ? describe : describe.skip)("connector lock sets under concurrent preparation", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;
  afterEach(() => vi.restoreAllMocks());
  beforeAll(async () => { temporary = await startRecoveryPostgres("gateway-preparation-stress-"); db = createDb(temporary.connectionString);
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test"; }, 90_000);
  afterAll(async () => { if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL; else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture(count: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Concurrent run preparation", issuePrefix: `P${companyId.slice(0,6)}` });
    const seeded = await db.insert(agents).values(Array.from({length:count}, (_, i) => ({ companyId, name: `Preparing agent ${i}`,
      role: "engineer", adapterType: "paperclip_runner", status: "idle", adapterConfig: {} }))).returning();
    const [application] = await db.insert(toolApplications).values({ companyId, applicationKey: randomUUID(), name: "Preparation MCP", type: "mcp_http", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Assigned MCP", uid: `test/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, config: { url: "https://assigned.example.test/mcp" } }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `app:${connection!.id}`, name: "Installed MCP", defaultAction: "deny" }).returning();
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "connection", effect: "include", applicationId: application!.id, connectionId: connection!.id });
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "company", targetId: companyId });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "company", targetId: companyId });
    const runs = await db.insert(heartbeatRuns).values(seeded.map(agent => ({ companyId, agentId: agent.id, status: "running", runtimeMode: "native" }))).returning();
    return { companyId, seeded, runs, profile: profile! };
  }

  it("two real run preparations retry the SMAA-1955 gateway INSERT pair", async () => {
    const f = await fixture(2);
    const [lower, higher] = [...f.seeded].sort((a, b) => a.id.localeCompare(b.id));
    let ready!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let lowerPid: number | undefined, paused = false, waitingQuery = "";
    // Observe real SQL only: on M1 the higher owner holds its configure N;
    // on the candidate it already holds the complete ascending runtime set.
    const highDb = observeTransactions(db, async tx => {
      await tx.execute(sql`set local deadlock_timeout = '100ms'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      const session = (tx as unknown as { session: { prepareQuery: (...args: unknown[]) => { execute: (...args: unknown[]) => Promise<unknown> } } }).session;
      const prepare = session.prepareQuery;
      session.prepareQuery = function (...args) {
        const prepared = prepare.apply(this, args), execute = prepared.execute;
        prepared.execute = async function (...values) {
          const result = await execute.apply(this, values), query = (args[0] as { sql: string }).sql;
          if (!paused && query.includes('from "agents"') && query.endsWith("for no key update")) {
            paused = true; ready(); await resume;
          }
          return result;
        };
        return prepared;
      };
    });
    const retries = vi.spyOn(logger, "warn");
    const high = Promise.allSettled([buildPaperclipRuntimeMcpServers({ db: highDb, agent: higher!,
      runId: f.runs.find(r => r.agentId === higher!.id)!.id })]);
    let low: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await Promise.race([held, high.then(() => { throw new Error("higher gateway did not take its real configure fence"); })]);
      const lowDb = observeTransactions(db, async tx => {
        await tx.execute(sql`set local deadlock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); lowerPid = backend!.pid;
      });
      low = Promise.allSettled([buildPaperclipRuntimeMcpServers({ db: lowDb, agent: lower!,
        runId: f.runs.find(r => r.agentId === lower!.id)!.id })]);
      await vi.waitFor(async () => {
        expect(lowerPid).toBeDefined();
        const [state] = await db.execute<{ wait: string | null; query: string }>(sql`select wait_event_type as wait, query from pg_stat_activity where pid=${lowerPid!}`);
        expect(state?.wait).toBe("Lock"); waitingQuery = state!.query;
      }, { timeout: 3000, interval: 10 });
    } finally { release(); await high; if (low) await low; }
    const outcomes = [...await high, ...await (low ?? [])].map(r => r.status === "fulfilled" ? "committed" : detail(r.reason));
    await record("gateway-pair", { outcomes, waitingQuery, retries: retries.mock.calls.map(([value]) => value) });
    retries.mockRestore();
    expect(outcomes).toEqual(["committed", "committed"]);
    expect(await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, f.companyId))).toHaveLength(2);
    expect(await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, f.companyId), sql`${toolProfiles.profileKey} like 'native:%'`))).toHaveLength(2);
    expect(await db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.companyId, f.companyId))).toHaveLength(2);
  }, 30_000);

  it("twenty runs prepare concurrently after reopening the runtime database", async () => {
    for (let round = 0; round < 5; round++) {
      const f = await fixture(20);
      // Reopen the client, discard service instances, and prepare from database
      // state with no native profiles/gateways yet. This is the cold restart
      // preparation boundary, not an assertion of a full server restart.
      await db.$client.end(); db = createDb(temporary.connectionString);
      const entered = performance.now(), durations: number[] = [];
      const retries = vi.spyOn(logger, "warn");
      const results = await Promise.allSettled(f.seeded.map(async agent => {
        const start = performance.now();
        try {
          const servers = await buildPaperclipRuntimeMcpServers({ db, agent, runId: f.runs.find(r => r.agentId === agent.id)!.id });
          expect(servers).toHaveLength(1);
          return "prepared";
        } finally { durations.push(performance.now() - start); }
      }));
      durations.sort((a,b) => a-b);
      const outcomes = results.map(r => r.status === "fulfilled" ? r.value : detail(r.reason));
      await record("twenty-preparing", { round, totalMs: performance.now()-entered, medianMs:durations[9], p95Ms:durations[18], maxMs:durations[19], durationsMs:durations, outcomes,
        retryCount: retries.mock.calls.length, retries: retries.mock.calls.map(([value]) => value) });
      retries.mockRestore();
      expect(outcomes).toEqual(Array(20).fill("prepared"));
      const gateways = await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, f.companyId));
      expect(gateways).toHaveLength(20);
      const tokens = await db.select({ id: toolMcpGatewayTokens.id }).from(toolMcpGatewayTokens)
        .where(and(eq(toolMcpGatewayTokens.companyId, f.companyId), sql`${toolMcpGatewayTokens.gatewayId} in (select id from tool_mcp_gateways where company_id=${f.companyId})`));
      expect(tokens).toHaveLength(20);
      expect(await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, f.companyId),
        sql`${toolProfiles.profileKey} like 'native:%'`))).toHaveLength(20);
    }
  }, 600_000);

  it("rolls back a whole prepare after token insertion, leaving exactly one profile/gateway/token set on retry", async () => {
    const f = await fixture(1);
    let failed = false;
    const retries = vi.spyOn(logger, "warn");
    const events = vi.spyOn(liveEvents, "publishLiveEvent");
    const retryDb = observeTransactions(db, async tx => {
      const session = (tx as unknown as { session: { prepareQuery: (...args: unknown[]) => { execute: (...args: unknown[]) => Promise<unknown> } } }).session;
      const prepare = session.prepareQuery;
      session.prepareQuery = function (...args) {
        const prepared = prepare.apply(this, args), execute = prepared.execute;
        prepared.execute = async function (...values) {
          const result = await execute.apply(this, values);
          if (!failed && (args[0] as { sql: string }).sql.startsWith('insert into "tool_mcp_gateway_tokens"')) {
            failed = true;
            // A real PostgreSQL transaction failure after all rows exist. No
            // service or trigger is mocked; all failed-attempt rows must roll back.
            await tx.execute(sql`do $$ begin raise exception 'late preparation contention' using errcode = '40P01'; end $$`);
          }
          return result;
        };
        return prepared;
      };
    });
    const servers = await buildPaperclipRuntimeMcpServers({ db: retryDb, agent: f.seeded[0]!, runId: f.runs[0]!.id });
    expect(failed).toBe(true);
    expect(servers).toHaveLength(1);
    expect(retries.mock.calls).toHaveLength(1);
    await record("late-token-retry", { retryCount: retries.mock.calls.length, retries: retries.mock.calls.map(([value]) => value) });
    retries.mockRestore();
    const profiles = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, f.companyId), sql`${toolProfiles.profileKey} like 'native:%'`));
    const gateways = await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.companyId, f.companyId));
    const tokens = await db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.companyId, f.companyId));
    expect(profiles).toHaveLength(1);
    expect(gateways).toHaveLength(1);
    expect(tokens).toHaveLength(1);
    expect(gateways[0]!.profileId).toBe(profiles[0]!.id);
    expect(tokens[0]!.gatewayId).toBe(gateways[0]!.id);
    expect(tokens[0]!.tokenHash).toBe(createHash("sha256").update(servers[0]!.token!).digest("hex"));
    const publications = events.mock.calls.filter(([event]) => event.companyId === f.companyId &&
      event.type === "activity.logged" && event.payload?.action === "tool_gateway.session_created");
    expect(publications).toHaveLength(1);
    expect(await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_gateway.session_created")))).toHaveLength(1);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profiles[0]!.id))).toHaveLength(1);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.targetId, gateways[0]!.id))).toHaveLength(1);
  }, 30_000);
});
