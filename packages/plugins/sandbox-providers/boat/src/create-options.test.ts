import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import manifest from "./manifest.js";
// Keep: provider boundary. Fixed identity/time allows literal wire-byte comparison
// with 0.1.6, rather than merely asserting absence of one parsed property.
const config = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, labels: {} };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function create(extra: Record<string, unknown>) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ sandbox: { id: "bx_test", state: "ready", setupStatus: "done" } })));
  vi.stubGlobal("fetch", fetch);
  await plugin.definition.onEnvironmentAcquireLease!({ driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", creationOperationId: "op", config: { ...config, ...extra } });
  return String(fetch.mock.calls[0][1].body);
}
const original = '{"type":"small","ttlSeconds":1800,"labels":{"owner":"paperclip:co","purpose":"run","expiry":"2030-01-01T00:30:00.000Z","environment":"env","run":"run","creation":"op","paperclip-acquire":"op"},"noEnv":true}';
describe("0.1.7 optional create fields", () => {
  it("A unset: exact 0.1.6 create bytes", async () => expect(await create({})).toBe(original));
  it("A set: sends saved-snapshot name as from", async () => expect(await create({ from: "web-stack" })).toBe(original.slice(0, -1) + ',"from":"web-stack"}'));
  it("C unset: undefined fields retain exact 0.1.6 create bytes", async () => expect(await create({ boatEnvironment: undefined, from: undefined })).toBe(original));
  it("C set: sends environment and omits noEnv", async () => expect(await create({ boatEnvironment: "customer-demos" })).toBe(original.replace(',"noEnv":true}', ',"environment":"customer-demos"}')));
  it("composes both fields with setupScript without changing defaults", async () => {
    const result = JSON.parse(await create({ from: "snapshot", boatEnvironment: "base", setupScript: "true" }));
    expect(result).toMatchObject({ from: "snapshot", environment: "base", setupScript: "true", type: "small", ttlSeconds: 1800 });
    expect(result).not.toHaveProperty("noEnv");
  });
  it.each(["from", "boatEnvironment"])("validates and advertises %s without silently dropping invalid values", async field => {
    expect(manifest.environmentDrivers?.[0].configSchema?.properties?.[field]).toMatchObject({ type: "string" });
    for (const value of [3, null, "", "  "]) expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...config, [field]: value } })).toMatchObject({ ok: false });
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...config, [field]: "saved" } })).toMatchObject({ ok: true, normalizedConfig: { [field]: "saved" } });
  });
});
