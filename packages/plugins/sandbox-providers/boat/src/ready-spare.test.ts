import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "./manifest.js";
import plugin from "./plugin.js";
import { readySpareConfigHash, type ReadySpare } from "./ready-spares.js";

const apiKey = "boat_ready_spare_test";
const baseConfig = { apiKey, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const companyId = "company-spare-test";
const environmentId = "environment-spare-test";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function hashFor(config: typeof baseConfig = baseConfig) {
  return readySpareConfigHash({ type: config.type, ttlSeconds: config.ttlSeconds, labels: config.labels, noEnv: true,
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
function fixture(initial: ReadySpare[] = []) {
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
    if (method === "POST" && /^\/sandboxes\/[^/]+\/commands$/.test(route)) return response({ exitCode: 0, timedOut: false, stdout: "{}\n", stderr: "" });
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
async function setup(spares: number) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  await plugin.definition.setup({ config: { get: vi.fn(async () => ({ spares })) }, logger } as any);
}
function acquire(runId: string, config: Record<string, unknown> = baseConfig, env = environmentId) {
  return plugin.definition.onEnvironmentAcquireLease!({ driverKey: "boat", companyId, environmentId: env, runId, creationOperationId: `attempt-${runId}`, config });
}

afterEach(async () => {
  await plugin.definition.onShutdown?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    const env = "environment-claim-path";
    const warm = inventorySpare({ environment: env });
    const f = fixture([warm]);
    await setup(1);
    const lease = await acquire("run-claim", baseConfig, env);
    expect(lease.providerLeaseId).toBe(warm.id);
    expect(lease.metadata).toMatchObject({ providerClaimName: "paperclip-claim:run-claim:attempt-run-claim", providerLabels: warm.labels, boatOrgId: "team-spare-test", sandboxId: warm.id, resumedLease: false });
    expect(f.calls.filter(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "run")).toHaveLength(0);
    await vi.waitFor(() => expect(f.calls.some(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "spare")).toBe(true), { timeout: 2_000 });
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
    const env = `environment-fallback-${String(_label).replaceAll(" ", "-")}`;
    const spareOptions = options ? { ...(options as any), ...(String(_label) === "wrong environment" ? {} : { environment: env }) } : undefined;
    const f = fixture(spareOptions ? [inventorySpare(spareOptions)] : []);
    await setup(1);
    const lease = await acquire(`run-fallback-${String(_label).replaceAll(" ", "-")}`, baseConfig, env);
    expect(lease.providerLeaseId).toMatch(/^bx_run_/);
    expect(f.calls.some(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "run")).toBe(true);
    expect(f.calls.some(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toBe(false);
  });

  it("never hands one spare to two concurrent acquires", async () => {
    const env = "environment-concurrent-claim";
    const warm = inventorySpare({ environment: env });
    const f = fixture([warm]);
    await setup(1);
    const [first, second] = await Promise.all([
      acquire("run-concurrent-a", baseConfig, env),
      acquire("run-concurrent-b", baseConfig, env),
    ]);
    expect(new Set([first.providerLeaseId, second.providerLeaseId]).size).toBe(2);
    expect([first.providerLeaseId, second.providerLeaseId]).toContain(warm.id);
    expect(f.calls.filter(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "POST" && call.url.pathname === "/api/v1/sandboxes" && call.body.labels.purpose === "run")).toHaveLength(1);
  });

  it("keeps created and claimed leases on one metadata shape", async () => {
    const coldFixture = fixture();
    const created = await acquire("run-created-shape", baseConfig, "environment-created-shape");
    expect(created.providerLeaseId).toMatch(/^bx_run_/);
    expect(coldFixture.calls.some(call => call.method === "POST" && call.body.labels.purpose === "run")).toBe(true);

    const env = "environment-shape-warm";
    const warm = inventorySpare({ id: "bx_shape_warm", environment: env });
    const warmFixture = fixture([warm]);
    await setup(1);
    const claimed = await acquire("run-claimed-shape", baseConfig, env);
    expect(claimed.providerLeaseId).toBe("bx_shape_warm");
    expect(Object.keys(claimed).sort()).toEqual(Object.keys(created).sort());
    expect(Object.keys(claimed.metadata ?? {}).sort()).toEqual(Object.keys(created.metadata ?? {}).sort());
    const normalize = (lease: typeof created) => ({
      ...lease, providerLeaseId: "same-id", expiresAt: "same-time",
      metadata: { ...lease.metadata, sandboxId: "same-id", providerLabels: {}, providerClaimName: "same-claim" },
    });
    expect(normalize(claimed as typeof created)).toEqual(normalize(created));
    expect(warmFixture.calls.some(call => call.method === "PATCH" && call.body?.name?.startsWith("paperclip-claim:"))).toBe(true);
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
