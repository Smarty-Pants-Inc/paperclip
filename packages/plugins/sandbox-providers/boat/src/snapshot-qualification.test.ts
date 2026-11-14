import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import manifest from "./manifest.js";
import { workspaceSentinelToken } from "./runner-support.js";
import type { PluginEnvironmentAcquireLeaseParams } from "@paperclipai/plugin-sdk";

// Keep: provider/core identity trust boundary and data safety. A pinned artifact
// must never silently become a replacement image; HTTP fixtures reach acquire.
const id = "a6b9e7d0-f886-471a-b461-640dd03e8d0f";
const otherId = "b6b9e7d0-f886-471a-b461-640dd03e8d0f";
const provider = "plugin:paperclip.boat-sandbox-provider:boat";
const saved = { name: "runner-base", snapshotId: id, status: "ready", createdAt: "2026-11-12T05:57:00.123Z", sourceSandboxId: "bx_source" };
const sandbox = { id: "bx_qualification", state: "ready", team: { id: "team_actual" } };
const config = { apiKey: "fixture-only", provider, snapshot: saved.name };
const params: PluginEnvironmentAcquireLeaseParams = { driverKey: "boat", companyId: "company", environmentId: "environment", runId: "probe", resolveSnapshotIdentity: true, config };
const identity = { provider, requestedRef: saved.name, id, name: saved.name, organizationId: "team_actual", createdAt: saved.createdAt };
type Call = { path: string; method: string; body: any };
function fixture(options: { list?: unknown; snapshot?: Record<string, unknown>; create?: Record<string, unknown>; ready?: Record<string, unknown>; status?: number; listStatus?: number; lookupError?: Error } = {}) {
  const calls: Call[] = [];
  let stopped = false;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url), path = u.pathname.replace("/api/v1", "") + u.search, method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/saved-snapshots" && method === "GET") return reply(options.list ?? { ok: true, type: "snapshot.saved.list", snapshots: [saved] }, options.listStatus);
    if (path === `/saved-snapshots/${saved.name}` && method === "GET") {
      if (options.lookupError) throw options.lookupError;
      return reply({ ok: true, type: "snapshot.saved.info", snapshot: { ...saved, ...options.snapshot } }, options.status);
    }
    if (path === "/sandboxes" && method === "POST") return reply({ sandbox: { ...sandbox, ...options.create } }, 202);
    if (path === `/sandboxes/${sandbox.id}` && method === "GET") return reply({ sandbox: { ...sandbox, ...options.ready, ...(stopped ? { state: "archived", stop: { id: "stop_qualification", status: "completed" } } : {}) } });
    if (path === `/sandboxes/${sandbox.id}/stop` && method === "POST") { stopped = true; return reply({ operation: { id: "stop_qualification" } }, 202); }
    throw new Error(`Unexpected provider operation: ${method} ${path}`);
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("Boat lease snapshot qualification", () => {
  it("returns all six identity fields only from the resolved name and sandbox team", async () => {
    const calls = fixture({ snapshot: { organizationId: "never-trust-snapshot-org" } });
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params);
    expect(lease.metadata?.snapshotIdentity).toEqual(identity);
    expect(lease.metadata?.snapshot).toBe(config.snapshot);
    expect(lease.metadata?.provider).toBe(config.provider);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /saved-snapshots/runner-base", "POST /sandboxes", "GET /sandboxes/bx_qualification"]);
    expect(calls[1].body.from).toBe(saved.name);
    expect(calls[1].body).not.toHaveProperty("snapshot");
    expect([identity.id, identity.name]).toContain(identity.requestedRef);
  });

  it.each([undefined, false, "true", 1])("does not attach identity without literal true (%j), but still resolves the name", async resolveSnapshotIdentity => {
    const calls = fixture();
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...params, resolveSnapshotIdentity: resolveSnapshotIdentity as boolean });
    expect(lease.metadata).not.toHaveProperty("snapshotIdentity");
    expect(lease.metadata?.snapshot).toBe(config.snapshot);
    expect(lease.metadata?.provider).toBe(provider);
    expect(calls[0].path).toBe("/saved-snapshots/runner-base");
    expect(calls[1].body.from).toBe(saved.name);
  });

  it.each([true, false])("resolves an immutable ID to one name then re-reads immediately before create (flag=%j)", async resolveSnapshotIdentity => {
    const calls = fixture({ list: { snapshots: [{ ...saved, snapshotId: otherId, name: "unrelated" }, saved] } });
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...params, resolveSnapshotIdentity, config: { ...config, snapshot: id } });
    expect(calls.slice(0, 3).map(c => `${c.method} ${c.path}`)).toEqual(["GET /saved-snapshots", "GET /saved-snapshots/runner-base", "POST /sandboxes"]);
    expect(calls[2].body.from).toBe(saved.name);
    if (resolveSnapshotIdentity) {
      expect(lease.metadata?.snapshotIdentity).toEqual({ ...identity, requestedRef: id });
      const resolved = lease.metadata!.snapshotIdentity as typeof identity;
      expect([resolved.id, resolved.name]).toContain(resolved.requestedRef);
    } else expect(lease.metadata).not.toHaveProperty("snapshotIdentity");
    expect(lease.metadata?.provider).toBe(provider);
  });

  it("fails a missing ID without falling back to the replacement name or allocating", async () => {
    const calls = fixture({ list: { snapshots: [{ ...saved, snapshotId: otherId }] } });
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...config, snapshot: id } })).rejects.toThrow(/snapshot.*not found/i);
    expect(calls.map(c => c.path)).toEqual(["/saved-snapshots"]);
  });

  it.each([{ snapshots: [saved, { ...saved, name: "another-name" }] }, { snapshots: [saved, saved] }])("rejects ambiguous IDs, even duplicate entries: %j", async ({ snapshots }) => {
    const calls = fixture({ list: { snapshots } });
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...config, snapshot: id } })).rejects.toThrow(/ambiguous/i);
    expect(calls.map(c => c.path)).toEqual(["/saved-snapshots"]);
  });

  it("refuses a name re-saved after ID resolution, before allocation or cleanup", async () => {
    const calls = fixture({ snapshot: { snapshotId: otherId } });
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...config, snapshot: id } })).rejects.toThrow(/snapshot.*mismatch/i);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /saved-snapshots", "GET /saved-snapshots/runner-base"]);
  });

  it.each([{ status: "saving" }, { status: "failed" }, { snapshotId: "not-a-uuid" }, { snapshotId: null }, { name: "different-name" }, { createdAt: "invalid" }, { createdAt: null }])("rejects an unverified named snapshot before allocation: %j", async snapshot => {
    const calls = fixture({ snapshot });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow(/snapshot.*identity/i);
    expect(calls.map(c => c.method)).toEqual(["GET"]);
  });

  it.each([{}, { snapshots: {} }, { savedSnapshots: [saved] }, { snapshots: [null] }])("fails closed on malformed list response %j", async list => {
    const calls = fixture({ list });
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...config, snapshot: id } })).rejects.toThrow(/snapshot/i);
    expect(calls.map(c => c.method)).toEqual(["GET"]);
  });

  it.each([404, 503])("never allocates after name lookup HTTP %i", async status => {
    const calls = fixture({ status });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow(`(${status})`);
    expect(calls.map(c => c.method)).toEqual(["GET"]);
  });

  it("never allocates after list lookup failure", async () => {
    const calls = fixture({ listStatus: 503 });
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...config, snapshot: id } })).rejects.toThrow("(503)");
    expect(calls.map(c => c.method)).toEqual(["GET"]);
  });

  it("never allocates after a timed-out identity read", async () => {
    const calls = fixture({ lookupError: new DOMException("lookup timed out", "TimeoutError") });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow(/network_error/);
    expect(calls.map(c => c.method)).toEqual(["GET"]);
  });

  it.each([undefined, null])("refuses stale create ownership when GET team is %s", async team => {
    const calls = fixture({ ready: { team } });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow(/snapshot.*(team|organization)/i);
    expect(calls.slice(-2)).toMatchObject([
      { method: "POST", path: "/sandboxes/bx_qualification/stop", body: {} },
      { method: "GET", path: "/sandboxes/bx_qualification" },
    ]);
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
  });

  it("uses the GET response's team when create omits it", async () => {
    fixture({ create: { team: undefined } });
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params);
    expect(lease.metadata?.snapshotIdentity).toEqual(identity);
  });

  it("refuses a qualification without a team identity and cleans the created sandbox", async () => {
    const calls = fixture({ create: { team: null }, ready: { team: null } });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow(/snapshot.*(team|organization)/i);
    expect(calls.slice(-2)).toMatchObject([
      { method: "POST", path: "/sandboxes/bx_qualification/stop", body: {} },
      { method: "GET", path: "/sandboxes/bx_qualification" },
    ]);
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
  });

  it("ordinary snapshot acquisition does not require a team identity", async () => {
    const calls = fixture({ create: { team: null }, ready: { team: null } });
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...params, resolveSnapshotIdentity: false });
    expect(lease.providerLeaseId).toBe(sandbox.id);
    expect(lease.metadata).not.toHaveProperty("snapshotIdentity");
    expect(calls[1].body.from).toBe(saved.name);
  });

  it("leaves snapshot-free creation unchanged and never invents an identity", async () => {
    const calls = fixture();
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { apiKey: "fixture-only" } });
    expect(calls.map(c => c.path)).toEqual(["/sandboxes", "/sandboxes/bx_qualification"]);
    expect(calls[0].body).not.toHaveProperty("from");
    expect(lease.metadata?.provider).toBe("boat");
    expect(lease.metadata).not.toHaveProperty("snapshotIdentity");
  });

  it("keeps legacy from (including share codes) working without snapshot lookup", async () => {
    const calls = fixture();
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { apiKey: "fixture-only", from: "bsh_fixture" } });
    expect(calls.map(c => c.path)).toEqual(["/sandboxes", "/sandboxes/bx_qualification"]);
    expect(calls[0].body.from).toBe("bsh_fixture");
    expect(lease.metadata).not.toHaveProperty("snapshotIdentity");
  });

  it.each(["", " runner-base ", null, 42])("rejects invalid snapshot configuration rather than creating a blank sandbox: %j", async snapshot => {
    const calls = fixture();
    const bad = { ...config, snapshot };
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: bad })).toMatchObject({ ok: false });
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: bad })).rejects.toThrow(/snapshot/i);
    expect(calls).toEqual([]);
  });

  it.each([{ from: "different" }, { pinnedSnapshotId: otherId }])("rejects competing legacy selectors alongside snapshot: %j", async legacy => {
    const calls = fixture();
    const bad = { ...config, ...legacy };
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: bad })).toMatchObject({ ok: false });
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: bad })).rejects.toThrow(/snapshot/i);
    expect(calls).toEqual([]);
  });

  it("preserves provider and snapshot across config normalization and advertises snapshot binding", async () => {
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config })).toMatchObject({ ok: true, normalizedConfig: { provider, snapshot: saved.name } });
    expect(manifest.environmentDrivers![0].configSchema?.properties?.snapshot).toMatchObject({ type: "string" });
    expect(manifest.environmentDrivers![0].templateConfigBinding).toMatchObject({ field: "snapshot", unsetFields: expect.arrayContaining(["from", "pinnedSnapshotId"]) });
  });

  it("retains the exact provider key when resuming a lease", async () => {
    // Unscoped legacy resume accepts the POST result, then GETs readiness.
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ sandbox })));
    vi.stubGlobal("fetch", fetch);
    const lease = await plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "company", environmentId: "environment", config, providerLeaseId: sandbox.id });
    expect(lease.metadata?.provider).toBe(provider);
  });

  it("binds the snapshot reference into the workspace identity without changing snapshot-free tokens", async () => {
    const normalized = (await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config })).normalizedConfig!;
    const scope = { ...params, agentId: "agent", executionWorkspaceId: "workspace" };
    const a = workspaceSentinelToken(scope, normalized as any, sandbox.id);
    const b = workspaceSentinelToken(scope, { ...normalized, snapshot: otherId } as any, sandbox.id);
    expect(a).not.toBe(b);
  });
});
