import { afterEach, expect, it, vi } from "vitest";
import plugin, { resolveBoatSnapshotIdentity } from "./plugin.js";
import manifest from "./manifest.js";
// Keep: provider identity trust boundary and data safety. A moved name must not allocate an unqualified image.
const config = { apiKey: "test-only", from: "runner-base", pinnedSnapshotId: "artifact-1" };
const snapshot = { name: "runner-base", snapshotId: "artifact-1", createdAt: "2026-11-12T00:00:00Z", status: "ready" };
const params = { driverKey: "boat", companyId: "company", environmentId: "environment", config };
afterEach(() => vi.unstubAllGlobals());
function fixture(overrides: Record<string, unknown> = {}, status = 200) {
  const calls: { path: string; method: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace("/api/v1", ""), method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/saved-snapshots/runner-base" && method === "GET") return new Response(JSON.stringify({ snapshot: { ...snapshot, ...overrides } }), { status });
    if ((path === "/sandboxes" && method === "POST") || (path === "/sandboxes/bx_pin" && method === "GET")) return new Response(JSON.stringify({ sandbox: { id: "bx_pin", state: "ready" } }));
    throw new Error(`Unexpected provider operation: ${method} ${path}`);
  }));
  return calls;
}
it("exports a ready immutable Boat snapshot identity", async () => {
  const calls = fixture();
  expect(await resolveBoatSnapshotIdentity(config)).toEqual({ provider: "boat", requestedRef: "runner-base", id: "artifact-1", name: "runner-base", createdAt: snapshot.createdAt });
  expect(calls).toEqual([{ path: "/saved-snapshots/runner-base", method: "GET", body: undefined }]);
});
it("checks a matching pin before create and sends the name, never the UUID", async () => {
  const calls = fixture();
  expect(await plugin.definition.onEnvironmentAcquireLease!(params)).toMatchObject({ providerLeaseId: "bx_pin" });
  expect(calls[0].path).toBe("/saved-snapshots/runner-base");
  expect(calls[1]).toMatchObject({ path: "/sandboxes", method: "POST", body: { from: "runner-base" } });
  expect(calls[1].body).not.toHaveProperty("pinnedSnapshotId");
});
it("fails closed on a moved name without create or cleanup mutations", async () => {
  const calls = fixture({ snapshotId: "artifact-2" });
  await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow(/pinnedSnapshotId mismatch/);
  expect(calls.map(c => c.method)).toEqual(["GET"]);
});
it.each([{ status: "saving" }, { status: "failed" }, { snapshotId: null }, { name: "foreign" }, { createdAt: "invalid" }])("fails closed for unusable snapshot identity %j", async overrides => {
  const calls = fixture(overrides);
  await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow(/identity/);
  expect(calls.map(c => c.method)).toEqual(["GET"]);
});
it.each([404, 503])("fails closed on snapshot lookup HTTP %i", async status => {
  const calls = fixture({}, status);
  await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow(`(${status})`);
  expect(calls.map(c => c.method)).toEqual(["GET"]);
});
it.each(["", null, 3])("rejects invalid pins without a provider operation: %j", async pinnedSnapshotId => {
  const calls = fixture();
  await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...config, pinnedSnapshotId } })).rejects.toThrow(/pinnedSnapshotId/);
  expect(calls).toEqual([]);
});
it("requires from for a pin, normalizes it, and advertises the guard", async () => {
  expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config })).toMatchObject({ ok: true, normalizedConfig: { pinnedSnapshotId: "artifact-1" } });
  expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...config, from: undefined } })).toMatchObject({ ok: false });
  expect(manifest.environmentDrivers![0].configSchema?.properties?.pinnedSnapshotId).toMatchObject({ type: "string" });
});
