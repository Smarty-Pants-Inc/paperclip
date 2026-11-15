import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "./manifest.js";
import plugin from "./plugin.js";
import { readySpareConfigHash, type ReadySpare } from "./ready-spares.js";

const apiKey = "boat_ready_spare_test";
const baseConfig = { apiKey, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const companyId = "company-spare-test";
const environmentId = "environment-spare-test";
const eventHandlers = new Map<string, (event: any) => Promise<void>>();
const persistedState = new Map<string, unknown>();
let inferredEnvironmentId: string | undefined;
let explicitEnvironmentIds: string[] | undefined;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function hashFor(config: typeof baseConfig = baseConfig) {
  return readySpareConfigHash({ type: config.type, ttlSeconds: config.ttlSeconds, labels: config.labels, noEnv: true,
    configuredSnapshot: null, resolvedSnapshot: null, pinnedSnapshotId: null,
    accountFingerprint: createHash("sha256").update(`https://boat.dev/api/v1\n${config.apiKey}`).digest("hex") });
}
function inventorySpare(options: { hash?: string; environment?: string; company?: string; warmed?: boolean; state?: string; id?: string } = {}): ReadySpare {
  const configHash = options.hash ?? hashFor();
  const owner = options.company ?? companyId;
  const environment = options.environment ?? environmentId;
  const expiry = new Date(Date.now() + 1_800_000).toISOString();
  const labels = { owner: `paperclip:${owner}`, environment, purpose: "spare", expiry, configHash };
  return {
    id: options.id ?? "bx_warm_0001", key: { companyId: owner, environmentId: environment, configHash },
    state: options.state ?? "running", warmed: options.warmed ?? true, expiresAt: expiry,
    name: options.warmed === false ? `paperclip-spare:warming:${configHash}` : `paperclip-spare:ready:${configHash}`,
    labels, ttlSeconds: 1800,
    providerObservation: { id: options.id ?? "bx_warm_0001", state: options.state ?? "running", name: options.warmed === false ? `paperclip-spare:warming:${configHash}` : `paperclip-spare:ready:${configHash}`, labels, team: { id: "team-spare-test" } },
  };
}
function fixture(initial: ReadySpare[] = [], warmExitCode = 0) {
  const inventory = initial.map(item => ({ ...(item.providerObservation ?? {}), id: item.id, state: item.state, name: item.name, labels: { ...item.labels }, archiveAfter: item.expiresAt, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), team: { id: "team-spare-test" } }));
  const calls: Array<{ method: string; url: URL; body?: any }> = [];
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const route = url.pathname.replace("/api/v1", "");
    calls.push({ method, url, body });
    if (method === "GET" && route === "/sandboxes") {
      const matching = inventory.filter(sb => [...url.searchParams.getAll("label")].every(label => {
        const [key, ...rest] = label.split("="); return sb.labels?.[key] === rest.join("=");
      }));
      return response({ sandboxes: matching, pageInfo: { nextCursor: null } });
    }
    if (method === "POST" && route === "/sandboxes") {
      const id = body.labels.purpose === "spare" ? `bx_spare_${inventory.length}` : `bx_run_${inventory.length}`;
      const sb = { id, state: "running", name: "", labels: body.labels, archiveAfter: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(), createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), team: { id: "team-spare-test" } };
      inventory.push(sb);
      return response({ sandbox: sb }, 202);
    }
    if (method === "GET" && /^\/sandboxes\/[^/]+$/.test(route)) {
      const sb = inventory.find(item => item.id === route.split("/").at(-1));
      return sb ? response({ sandbox: sb }) : response({ error: "not_found" }, 404);
    }
    if (method === "PATCH" && /^\/sandboxes\/[^/]+$/.test(route)) {
      const sb = inventory.find(item => item.id === route.split("/").at(-1));
      if (!sb) return response({ error: "not_found" }, 404);
      if (body.name) sb.name = body.name;
      if (body.ttlSeconds) sb.archiveAfter = new Date(Date.now() + body.ttlSeconds * 1000).toISOString();
      return response({ sandbox: sb });
    }
    if (method === "POST" && /^\/sandboxes\/[^/]+\/commands$/.test(route)) return response({ exitCode: warmExitCode, timedOut: false, stdout: "{}\n", stderr: "" });
    if (method === "POST" && /^\/sandboxes\/[^/]+\/resume$/.test(route)) {
      const id = route.split("/").at(-2)!;
      const sb = inventory.find(item => item.id === id) ?? { id, state: "running", labels: {}, team: { id: "team-spare-test" } };
      if (!inventory.some(item => item.id === id)) inventory.push(sb);
      sb.state = "running";
      return response({ sandbox: sb }, 202);
    }
    if (method === "POST" && route.endsWith("/stop")) {
      const sb = inventory.find(item => item.id === route.split("/").at(-2));
      if (sb) sb.state = "archived";
      return response({ operation: { id: "stop-spare", status: "completed" } }, 202);
    }
    throw new Error(`Unexpected mock request ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, inventory, fetch };
}
function fakeDatabase() {
  const claims = new Map<string, unknown[]>();
  return {
    namespace: "boat_sandbox_provider",
    execute: vi.fn(async (_sql: string, params: unknown[] = []) => {
      const leaseId = String(params[0]);
      if (claims.has(leaseId)) return { rowCount: 0 };
      claims.set(leaseId, params);
      return { rowCount: 1 };
    }),
    query: vi.fn(async (_sql: string, params: unknown[] = []) => {
      const leaseId = String(params[0]);
      return claims.has(leaseId) ? [{ provider_lease_id: leaseId }] : [];
    }),
  };
}
async function setup(spares: number, environmentIds?: string[], idleMinutes = 60, db = fakeDatabase()) {
  explicitEnvironmentIds = environmentIds;
  inferredEnvironmentId = undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  await plugin.definition.setup({
    config: { get: vi.fn(async () => ({ spares, spareEnvironmentIds: explicitEnvironmentIds ?? [inferredEnvironmentId ?? environmentId], spareIdleMinutes: idleMinutes })) },
    logger,
    db,
    events: { on: vi.fn((name: string, handler: (event: any) => Promise<void>) => { eventHandlers.set(name, handler); return () => eventHandlers.delete(name); }) },
    state: {
      get: vi.fn(async (key: { scopeId?: string; stateKey: string }) => persistedState.get(`${key.scopeId}:${key.stateKey}`) ?? null),
      set: vi.fn(async (key: { scopeId?: string; stateKey: string }, value: unknown) => { persistedState.set(`${key.scopeId}:${key.stateKey}`, value); }),
    },
  } as any);
}
function acquire(runId: string, config: Record<string, unknown> = baseConfig, env = environmentId, company = companyId) {
  if (!explicitEnvironmentIds) inferredEnvironmentId = env;
  return plugin.definition.onEnvironmentAcquireLease!({ driverKey: "boat", companyId: company, environmentId: env, runId, creationOperationId: `attempt-${runId}`, config });
}
async function emitActivity(eventType: string, company = companyId) {
  const handler = eventHandlers.get(eventType);
  if (!handler) throw new Error(`No handler subscribed for ${eventType}`);
  await handler({ eventId: `event-${eventType}-${company}`, eventType, companyId: company, occurredAt: new Date().toISOString() });
}
function companyActivityState(company: string): any {
  for (const [key, value] of persistedState) if (key.startsWith(`${company}:`) && value && typeof value === "object" && "lastActivityAt" in value) return value;
  return undefined;
}

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  eventHandlers.clear();
  persistedState.clear();
  inferredEnvironmentId = undefined;
  explicitEnvironmentIds = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await setup(0);
});

describe("Boat ready spare", () => {
  it("exposes a company-scoped bounded spare count, disabled by default", () => {
    expect(manifest.instanceConfigSchema).toMatchObject({
      type: "object",
      properties: {
        spares: { type: "integer", minimum: 0, maximum: 3, default: 0 },
      },
    });
  });

  it("claims a warmed spare through the shared post-create path and starts a replacement", async () => {
    const env = "environment-claim-path", company = "company-claim-path";
    const f = fixture();
    await setup(1);
    await acquire("run-seed", baseConfig, env, company);
    await vi.waitFor(() => expect(f.inventory.some(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))).toBe(true), { timeout: 2_000 });
    await new Promise(resolve => setTimeout(resolve, 20)); // let the keeper index the completed warm-up
    const spareCreate = f.calls.find(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare")!;
    expect(spareCreate.body).toMatchObject({ type: "small", ttlSeconds: 1800, noEnv: true });
    expect(spareCreate.body.labels).toMatchObject({ owner: `paperclip:${company}`, environment: env, purpose: "spare", configHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Date.parse(spareCreate.body.labels.expiry)).toBeGreaterThan(Date.now());
    const spareBeforeClaim = f.inventory.find(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))!;
    const normalCreatesBeforeClaim = f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "run").length;
    const lease = await acquire("run-claim", baseConfig, env, company);
    expect(lease.providerLeaseId).toBe(spareBeforeClaim.id);
    expect(lease.metadata).toMatchObject({ providerClaimName: "paperclip-claim:run-claim:attempt-run-claim", providerLabels: spareBeforeClaim.labels, boatOrgId: "team-spare-test", sandboxId: spareBeforeClaim.id, resumedLease: false });
    expect(f.calls.filter(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "run")).toHaveLength(normalCreatesBeforeClaim);
    await vi.waitFor(() => expect(f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare").length).toBeGreaterThan(1), { timeout: 2_000 });
    const warmCommand = f.calls.find(call => call.method === "POST" && call.url.pathname.endsWith("/commands"))?.body.command as string;
    expect(warmCommand).toContain("PI_CODING_AGENT_DIR=/home/user/.pi/agent timeout 25 pi --mode rpc --no-session");
    expect(warmCommand).toContain("printf '{\"type\":\"get_state\",\"id\":\"1\"}\\n'");
    expect(lease.metadata).toHaveProperty("workspaceSentinel");
    expect(f.calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it.each([
    ["empty inventory", undefined],
    ["not warmed", { warmed: false }],
    ["wrong environment", { environment: "environment-other" }],
    ["wrong create config hash", { hash: "not-the-current-create-hash" }],
  ])("falls back to ordinary create for %s", async (_label, options) => {
    const suffix = String(_label).replaceAll(" ", "-");
    const env = `environment-fallback-${suffix}`, company = `company-fallback-${suffix}`;
    const spareOptions = options ? { ...(options as any), company, ...(String(_label) === "wrong environment" ? {} : { environment: env }) } : undefined;
    const f = fixture(spareOptions ? [inventorySpare(spareOptions)] : []);
    await setup(1);
    const lease = await acquire(`run-fallback-${suffix}`, baseConfig, env, company);
    expect(lease.providerLeaseId).toMatch(/^bx_run_/);
    expect(f.calls.some(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "run")).toBe(true);
    expect(f.calls.some(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toBe(false);
  });

  it("does not hand over a spare when Boat read-back changes the claim token", async () => {
    const env = "environment-claim-readback", company = "company-claim-readback";
    const warm = inventorySpare({ company, environment: env, id: "bx_readback_mismatch" });
    const f = fixture([warm]);
    let claimWritten = false;
    const realFetch = f.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const url = new URL(String(input)), method = init.method ?? "GET";
      const result = await realFetch(input, init);
      if (method === "PATCH" && url.pathname.endsWith(`/${warm.id}`) && JSON.parse(String(init.body)).name?.startsWith("paperclip-claim:")) claimWritten = true;
      if (claimWritten && method === "GET" && url.pathname.endsWith(`/${warm.id}`)) {
        return response({ sandbox: { ...warm.providerObservation, id: warm.id, state: "running", name: "paperclip-claim:another-worker" } });
      }
      return result;
    }));
    await setup(1);
    await acquire("run-readback-seed", baseConfig, env, company);
    await vi.waitFor(() => expect(f.calls.some(call => call.method === "GET" && call.url.pathname === "/api/v1/sandboxes")).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));

    const lease = await acquire("run-readback-mismatch", baseConfig, env, company);
    expect(lease.providerLeaseId).not.toBe(warm.id);
    expect(f.calls.filter(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:")).length).toBe(1);
  });

  it("refuses acquisitions and stops keeper activity as soon as shutdown begins", async () => {
    const env = "environment-shutdown-claim", company = "company-shutdown-claim";
    const f = fixture([inventorySpare({ company, environment: env, id: "bx_shutdown_spare" })]);
    await setup(1);
    await acquire("run-shutdown-seed", baseConfig, env, company);
    await vi.waitFor(() => expect(f.calls.some(call => call.method === "GET" && call.url.pathname === "/api/v1/sandboxes")).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    const beforeShutdown = f.calls.length;

    const shutdown = plugin.definition.onShutdown!();
    await expect(acquire("run-after-shutdown", baseConfig, env, company)).rejects.toThrow(/shut(?:ting)? down/i);
    await shutdown;
    const afterShutdown = f.calls.slice(beforeShutdown);
    expect(afterShutdown.some(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toBe(false);
    expect(afterShutdown.some(call => call.method === "POST" && call.body?.labels?.purpose === "spare")).toBe(false);
  });

  it("starts no spare timer or inventory work when the company spare count is zero", async () => {
    const f = fixture();
    const timer = vi.spyOn(globalThis, "setInterval");
    await setup(0);
    await plugin.definition.onHealth!();
    expect(timer).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    await plugin.definition.onShutdown?.();
  });

  it("never hands one spare to two concurrent acquires", async () => {
    const env = "environment-concurrent-claim", company = "company-concurrent-claim";
    const f = fixture();
    await setup(1);
    await acquire("run-concurrent-seed", baseConfig, env, company);
    await vi.waitFor(() => expect(f.inventory.some(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))).toBe(true), { timeout: 2_000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const warm = f.inventory.find(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))!;
    const [first, second] = await Promise.all([
      acquire("run-concurrent-a", baseConfig, env, company),
      acquire("run-concurrent-b", baseConfig, env, company),
    ]);
    expect(new Set([first.providerLeaseId, second.providerLeaseId]).size).toBe(2);
    expect([first.providerLeaseId, second.providerLeaseId]).toContain(warm.id);
    expect(f.calls.filter(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "run")).toHaveLength(2);
  });

  it("keeps created and claimed leases on one metadata shape", async () => {
    const coldFixture = fixture();
    const created = await acquire("run-created-shape", baseConfig, "environment-created-shape");
    expect(created.providerLeaseId).toMatch(/^bx_run_/);
    expect(coldFixture.calls.some(call => call.method === "POST" && call.body.labels.purpose === "run")).toBe(true);

    const env = "environment-shape-warm", company = "company-shape-warm";
    const warmFixture = fixture();
    await setup(1);
    await acquire("run-shape-seed", baseConfig, env, company);
    await vi.waitFor(() => expect(warmFixture.inventory.some(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))).toBe(true), { timeout: 2_000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const readySpare = warmFixture.inventory.find(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))!;
    const claimed = await acquire("run-claimed-shape", baseConfig, env, company);
    expect(claimed.providerLeaseId).toBe(readySpare.id);
    expect(Object.keys(claimed).sort()).toEqual(Object.keys(created).sort());
    expect(Object.keys(claimed.metadata ?? {}).sort()).toEqual(Object.keys(created.metadata ?? {}).sort());
    const normalize = (lease: typeof created) => ({
      ...lease, providerLeaseId: "same-id", expiresAt: "same-time",
      metadata: { ...lease.metadata, sandboxId: "same-id", providerLabels: {}, providerClaimName: "same-claim" },
    });
    expect(normalize(claimed as typeof created)).toEqual(normalize(created));
    expect(warmFixture.calls.some(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toBe(true);
  });

  it("does not wait for slow spare inventory before falling back to normal create", async () => {
    const env = "environment-fast-fallback", company = "company-fast-fallback";
    const f = fixture([inventorySpare({ company, environment: env, id: "bx_slow_inventory" })]);
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      if ((init.method ?? "GET") === "GET" && url.pathname === "/api/v1/sandboxes" && url.search) await new Promise(resolve => setTimeout(resolve, 700));
      return f.fetch(input, init);
    });
    await setup(1);
    const started = Date.now();
    const lease = await acquire("run-fast-fallback", baseConfig, env, company);
    expect(lease.providerLeaseId).toMatch(/^bx_run_/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("stops a spare whose Pi warm-up fails and never makes it claimable", async () => {
    const env = "environment-warm-failure", company = "company-warm-failure";
    const f = fixture([], 1);
    await setup(1);
    const cold = await acquire("run-warm-failure", baseConfig, env, company);
    expect(cold.providerLeaseId).toMatch(/^bx_run_/);
    await vi.waitFor(() => expect(f.calls.some(call => call.method === "POST" && call.url.pathname.endsWith("/stop"))).toBe(true), { timeout: 2_000 });
    expect(f.inventory.some(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))).toBe(false);
    expect(f.calls.some(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toBe(false);
    expect(f.calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it("adopts matching labeled spares after restart without blocking the first cold create", async () => {
    const env = "environment-restart-adoption", company = "company-restart-adoption";
    const warm = inventorySpare({ company, environment: env, id: "bx_restart_warm" });
    const f = fixture([warm]);
    await setup(1);
    const first = await acquire("run-after-restart-first", baseConfig, env, company);
    expect(first.providerLeaseId).not.toBe(warm.id);
    expect(f.calls.filter(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toHaveLength(0);
    await vi.waitFor(() => expect(f.calls.filter(call => call.method === "GET" && call.url.pathname === "/api/v1/sandboxes").length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await acquire("run-after-restart-second", baseConfig, env, company);
    expect(second.providerLeaseId).toBe(warm.id);
    expect(f.calls.filter(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toHaveLength(1);
  });

  it("refreshes Boat TTL and stops spares when the company setting is disabled", async () => {
    const env = "environment-refresh-retire", company = "company-refresh-retire";
    const f = fixture();
    await setup(1);
    await acquire("run-refresh-seed", baseConfig, env, company);
    await vi.waitFor(() => {
      const ready = f.inventory.some(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"));
      expect(ready, JSON.stringify(f.calls.map(call => [call.method, call.url.pathname, call.body?.labels?.purpose, call.body?.name]))).toBe(true);
    }, { timeout: 2_000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const spareId = f.inventory.find(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))!.id;
    const createdExpiry = f.inventory.find(item => item.id === spareId)!.archiveAfter;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(createdExpiry) - 800_000);
    await plugin.definition.onHealth!();
    expect(f.calls.some(call => call.method === "PATCH" && call.url.pathname.endsWith(`/${spareId}`) && call.body?.ttlSeconds === 1800 && call.body?.name === undefined)).toBe(true);
    await plugin.definition.onConfigChanged!({ spares: 0 }, { companyId: company } as any);
    await vi.waitFor(() => expect(f.calls.some(call => call.method === "POST" && call.url.pathname === `/api/v1/sandboxes/${spareId}/stop`)).toBe(true), { timeout: 2_000 });
    expect(f.calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it("stops idle spares and wakes one immediately on same-company issue activity", async () => {
    const env = "environment-idle-rule", company = "company-idle-rule";
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await setup(1, [env], 60);
    await acquire("run-idle-seed", baseConfig, env, company);
    await vi.waitFor(() => expect(f.inventory.some(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:"))).toBe(true), { timeout: 2_000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const original = f.inventory.find(item => item.labels.purpose === "spare")!;
    const createdSpares = f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare").length;

    now += 60 * 60_000 + 1;
    await plugin.definition.onHealth!();
    await vi.waitFor(() => expect(f.calls.some(call => call.method === "POST" && call.url.pathname === `/api/v1/sandboxes/${original.id}/stop`)).toBe(true), { timeout: 2_000 });
    expect(f.inventory.find(item => item.id === original.id)?.state).toBe("archived");
    expect(f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare")).toHaveLength(createdSpares);
    expect(f.calls.some(call => call.method === "DELETE")).toBe(false);

    await emitActivity("issue.comment.created", company);
    await vi.waitFor(() => expect(f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare")).toHaveLength(createdSpares + 1), { timeout: 2_000 });
    await vi.waitFor(() => expect(f.inventory.some(item => item.labels.purpose === "spare" && item.name.startsWith("paperclip-spare:ready:") && item.state === "running")).toBe(true), { timeout: 2_000 });
    expect(f.calls.some(call => call.method === "POST" && call.url.pathname.endsWith("/commands"))).toBe(true);
    expect(f.calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it("does not let another company's event wake this company's idle spare", async () => {
    const env = "environment-company-filter", company = "company-company-filter";
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await setup(1, [env], 60);
    await acquire("run-company-filter", baseConfig, env, company);
    await vi.waitFor(() => expect(f.inventory.some(item => item.labels.owner === `paperclip:${company}` && item.labels.purpose === "spare" && item.state === "running")).toBe(true), { timeout: 2_000 });
    now += 60 * 60_000 + 1;
    await plugin.definition.onHealth!();
    const before = f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare").length;
    await emitActivity("issue.comment.created", "company-other");
    await plugin.definition.onHealth!();
    expect(f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare")).toHaveLength(before);
    expect(f.inventory.find(item => item.labels.owner === `paperclip:${company}` && item.labels.purpose === "spare")?.state).toBe("archived");
  });

  it("scopes spares to explicitly listed environments", async () => {
    const allowed = "environment-allowed", excluded = "environment-excluded", company = "company-environment-scope";
    const f = fixture();
    await setup(1, [allowed]);
    await acquire("run-excluded", baseConfig, excluded, company);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.calls.some(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare" && call.body.labels.environment === excluded)).toBe(false);
    await acquire("run-allowed", baseConfig, allowed, company);
    await vi.waitFor(() => expect(f.calls.some(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare" && call.body.labels.environment === allowed)).toBe(true), { timeout: 2_000 });
  });

  it("records acquire and release as company activity", async () => {
    const env = "environment-lease-activity", company = "company-lease-activity";
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await setup(1, [env]);
    const lease = await acquire("run-activity", baseConfig, env, company);
    expect(companyActivityState(company)).toMatchObject({ lastActivityAt: now, lastLeaseAcquiredAt: now });
    now += 5 * 60_000;
    await plugin.definition.onEnvironmentReleaseLease!({ driverKey: "boat", companyId: company, environmentId: env,
      config: baseConfig, providerLeaseId: lease.providerLeaseId });
    expect(companyActivityState(company)).toMatchObject({ lastActivityAt: now, lastLeaseAcquiredAt: now - 5 * 60_000 });
    expect(f.calls.some(call => call.method === "POST" && call.url.pathname.endsWith("/stop"))).toBe(true);
  });

  it("refreshes a spare TTL while active but stops refreshing once idle", async () => {
    const env = "environment-idle-ttl", company = "company-idle-ttl";
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    await setup(1, [env], 60);
    await acquire("run-idle-ttl", baseConfig, env, company);
    await vi.waitFor(() => expect(f.inventory.some(item => item.labels.purpose === "spare" && item.state === "running")).toBe(true), { timeout: 2_000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const spare = f.inventory.find(item => item.labels.purpose === "spare")!;
    now += 1_000_000;
    await plugin.definition.onHealth!();
    const ttlPatches = f.calls.filter(call => call.method === "PATCH" && call.url.pathname.endsWith(`/${spare.id}`) && call.body?.ttlSeconds === 1800).length;
    expect(ttlPatches).toBeGreaterThan(0);
    now += 60 * 60_000 + 1;
    await plugin.definition.onHealth!();
    const idleTtlPatches = f.calls.filter(call => call.method === "PATCH" && call.url.pathname.endsWith(`/${spare.id}`) && call.body?.ttlSeconds === 1800).length;
    await plugin.definition.onHealth!();
    expect(f.calls.filter(call => call.method === "PATCH" && call.url.pathname.endsWith(`/${spare.id}`) && call.body?.ttlSeconds === 1800)).toHaveLength(idleTtlPatches);
    expect(f.inventory.find(item => item.id === spare.id)?.state).toBe("archived");
    expect(idleTtlPatches).toBe(ttlPatches);
  });

  it("subscribes to company activity events and validates environment, idle, and count settings", async () => {
    const f = fixture();
    await setup(1);
    const eventTypes = ["agent.run.started", "agent.run.finished", "agent.run.failed", "agent.run.cancelled", "issue.comment.created", "issue.created", "issue.updated"];
    expect(eventTypes.every(type => eventHandlers.has(type))).toBe(true);
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.instanceConfigSchema.properties).toMatchObject({
      spareIdleMinutes: { type: "integer", minimum: 15, maximum: 1440, default: 60 },
      spareEnvironmentIds: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string", minLength: 1 } },
    });
    expect(f.calls.some(call => call.body?.labels?.purpose === "spare")).toBe(false);
  });

  it("never claims a spare from the resume/reuse hook", async () => {
    const env = "environment-resume-path";
    const f = fixture([inventorySpare({ environment: env })]);
    await setup(1);
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "boat", companyId, environmentId: env, config: baseConfig, providerLeaseId: "bx_existing",
    });
    expect(lease.providerLeaseId).toBe("bx_existing");
    expect(f.calls.some(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toBe(false);
    expect(f.calls.some(call => call.method === "GET" && call.url.pathname === "/api/v1/sandboxes")).toBe(false);
  });
});
