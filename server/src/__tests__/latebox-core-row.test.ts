import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, sandboxCreationOperations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createOwnedSandbox, recoverSandboxCreations } from "../services/sandbox-creation-operations.js";

// adopt-boat-late-box2 money row: REAL core creation journal + bounded absence
// resolver (embedded PostgreSQL, production sandbox-creation-operations.ts) and
// the REAL Boat plugin (LATEBOX_PLUGIN = path to its plugin.ts). Only Boat's HTTP
// API (fetch) and the clock are simulated. A run create times out; the box
// appears in Boat at LATE_MIN minutes. Core's recovery is driven at each saved
// nextAttemptAt (its scheduler), and a cleanup lease is executed the way core's
// cleanup worker does (plugin destroy with the lease's failedCreateCleanup).
// adopt-boat-late-sweep (RFL late-box (A)): the plugin gets the host's plugin
// state (a Map), and its own maintenance timer runs on the fake clock, so after
// core has settled the operation the plugin's label sweep is what must find the
// late box. Pass: the box is stopped within one 15 s tick of appearing.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));
const LATE_MIN = Number(process.env.LATE_MIN ?? "40");
const TICK_MIN = 0.25;
const TTL_MIN = 120;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-latebox-");
  db = createDb(database.connectionString, { maxConnections: 4 });
}, 120_000);
afterAll(async () => { vi.useRealTimers(); await database?.cleanup(); });

it(`LATEBOX-CORE: a box appearing ${LATE_MIN} min after a timed-out create is found by core + plugin and stopped`, async () => {
  const plugin = (await import(/* @vite-ignore */ process.env.LATEBOX_PLUGIN!)).default;
  const pluginState = new Map<string, unknown>();
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} }, state: {
    get: async (key: any) => pluginState.get(`${key.scopeId}:${key.namespace}:${key.stateKey}`) ?? null,
    set: async (key: any, value: unknown) => { pluginState.set(`${key.scopeId}:${key.namespace}:${key.stateKey}`, structuredClone(value)); },
  } } as any);
  const T0 = Date.parse("2026-11-19T00:00:00.000Z");
  // The plugin's timers, its maintenance timer (setInterval) included, run on ONE
  // fake clock throughout: re-installing the clock would drop a timer it holds.
  // shouldAdvanceTime lets the database driver's own timers run in real time.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], now: T0, shouldAdvanceTime: true });
  const min = () => ((Date.now() - T0) / 60_000).toFixed(2);
  const trace: string[] = [];
  const log = (event: string) => { trace.push(`t=${min()}min ${event}`); };

  // Boat: the create is accepted but never answered; the box is visible from LATE_MIN.
  const boxes = new Map<string, { labels: Record<string, string>; stopped: boolean; stoppedAt?: string }>();
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    const visible = Date.now() >= T0 + LATE_MIN * 60_000;
    if (method === "POST" && path === "/sandboxes") {
      boxes.set("bx_late", { labels: JSON.parse(init.body).labels, stopped: false });
      const signal: AbortSignal = init.signal;
      return await new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
    if (method === "GET" && path === "/sandboxes") {
      const attempt = u.searchParams.get("label")!.split("=")[1];
      return json({ sandboxes: [...boxes].filter(([, b]) => b.labels["paperclip-acquire"] === attempt && visible)
        .map(([id, b]) => ({ id, labels: b.labels, state: b.stopped ? "archived" : "ready" })), pageInfo: { nextCursor: null } });
    }
    const id = decodeURIComponent(path.split("/")[2] ?? ""), b = boxes.get(id);
    if (b && visible && method === "POST" && path.endsWith("/stop")) { if (!b.stopped) { b.stopped = true; b.stoppedAt = min(); } return json({ stop: { id: `stop_${id}`, status: "pending" } }, 202); }
    if (b && visible && method === "GET") return json({ sandbox: { id, labels: b.labels, state: b.stopped ? "archived" : "ready",
      ...(b.stopped ? { stop: { id: `stop_${id}`, status: "completed" } } : {}) } });
    if (method === "GET") return json({ error: "not found" }, 404);
    throw new Error(`Unexpected ${method} ${path}`);
  }));

  const companyId = randomUUID(), environmentId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Late box", issuePrefix: "LATE" });
  const [agent] = await db.insert(agents).values({ companyId, name: "Run owner" }).returning();
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, status: "running", invocationSource: "manual" });
  await db.insert(environments).values({ id: environmentId, name: "Boat", driver: "plugin", config: {} });
  const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: TTL_MIN * 60, reuseLease: false, labels: {} };
  const pluginParams = { driverKey: "boat", companyId, environmentId, config: cfg };

  // 1. The run's create, through core's creation journal, times out in the plugin.
  const created = createOwnedSandbox(db, { companyId, environmentId, heartbeatRunId: runId, provider: "boat", pluginId: randomUUID(),
    driverKey: "boat", config: cfg, metadata: { driver: "plugin", sandboxProviderPlugin: true } },
  async identity => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms); return c.signal;
    });
    const acquire = plugin.definition.onEnvironmentAcquireLease!({ ...pluginParams, runId: identity.runId, creationOperationId: identity.id }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(95_000);
    const error = await acquire;
    timeout.mockRestore();
    throw error;
  });
  await expect(created).rejects.toMatchObject({ code: "ETIMEDOUT" });
  log("create timed out (plugin ETIMEDOUT, providerState absent); run fails");
  await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));

  const inspect = async (operation: any) => {
    try {
      const observed = await plugin.definition.onEnvironmentInspectLease!({ ...pluginParams, providerLeaseId: operation.id,
        creationOperation: { id: operation.id, runId: operation.runId } });
      log(`core inspect -> ${observed.creationCleanup ? `FOUND ${observed.providerLeaseId}` : observed.state}`);
      return observed;
    } catch (error) { log(`core inspect -> throws "${(error as Error).message}"`); throw error; }
  };
  const op = async () => (await db.select().from(sandboxCreationOperations))[0]!;
  // 2. Core's scheduler: run recovery at each saved deadline; execute cleanup leases.
  let ownedUntilStop = true;
  const box0 = () => boxes.get("bx_late")!;
  for (let tick = 0; tick < 60; tick++) {
    const row = await op();
    const boxRunning = boxes.get("bx_late") && Date.now() >= T0 + LATE_MIN * 60_000 && !boxes.get("bx_late")!.stopped;
    if (boxRunning && !["pending", "cleanup_pending"].includes(row.state)) ownedUntilStop = false;
    if (row.state === "pending") {
      vi.setSystemTime(Math.max(Date.now(), row.nextAttemptAt.getTime()));
      await recoverSandboxCreations(db, inspect);
      const after = await op();
      log(`core op state=${after.state} attempts=${after.metadata.creationRecoveryAttempts ?? 0} next=${((after.nextAttemptAt.getTime() - T0) / 60_000).toFixed(2)}min${after.metadata.creationReconciliationReason ? ` reason=${after.metadata.creationReconciliationReason}` : ""}`);
      continue;
    }
    if (row.state === "cleanup_pending") {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, row.leaseId!));
      const stopped = await plugin.definition.onEnvironmentDestroyLease!({ ...pluginParams, runId: row.runId, providerLeaseId: lease.providerLeaseId!,
        leaseMetadata: lease.metadata } as any);
      log(`core cleanup lease ${lease.status} -> plugin destroy ${lease.providerLeaseId}: ${stopped?.state}`);
      await db.update(sandboxCreationOperations).set({ state: "resolved" }).where(eq(sandboxCreationOperations.id, row.id));
      break;
    }
    // Resolved: core's recovery only scans pending ops; keep ticking 5 min to see if anything finds the box.
    // The plugin's maintenance ticks (every 15 s) fire on the way.
    if (box0().stopped) break;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await recoverSandboxCreations(db, inspect);
    if (Date.now() >= T0 + (LATE_MIN + TTL_MIN) * 60_000) { log("Boat TTL reached; box never found by core or plugin"); break; }
  }
  const box = boxes.get("bx_late")!;
  log(`RESULT box stopped=${box.stopped} stoppedAt=${box.stoppedAt ?? "never"}min ownedUntilStop=${ownedUntilStop}`);
  const text = `LATEBOX_TRACE plugin=${process.env.LATEBOX_PLUGIN} LATE_MIN=${LATE_MIN}\n${trace.join("\n")}\n`;
  if (process.env.LATEBOX_OUT) (await import("node:fs")).writeFileSync(process.env.LATEBOX_OUT, text);
  console.log(text);
  expect(box.stopped, "the late earlier box is stopped, never left running").toBe(true);
  // RFL (A): after core settled the operation, the plugin's durable record owns the box; it is stopped within one tick of appearing.
  if (LATE_MIN > 30) expect(Number(box.stoppedAt), "a box appearing after core settled is stopped within one maintenance tick").toBeLessThanOrEqual(LATE_MIN + TICK_MIN);
  void ownedUntilStop;
}, 120_000);
