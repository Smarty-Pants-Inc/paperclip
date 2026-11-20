import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
const cfg = { hydrationWaitSeconds: 0, apiKey: "boat_LOG_SECRET_CANARY", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const p = { driverKey: "boat", companyId: "logco", environmentId: "logenv", runId: "logrun", creationOperationId: "logattempt", config: cfg };
let info: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  info = vi.fn();
  await plugin.definition.setup({ logger: { info, warn() {}, error() {}, debug() {} } } as any);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const response = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
function stampEvidence(name: string) {
  const lines = info.mock.calls.filter(([message]) => message === "boat.acquire.phases");
  console.info("Q2_EXIT_EVIDENCE", JSON.stringify({ name, phaseLines: lines }));
  expect(JSON.stringify(lines)).not.toContain(cfg.apiKey);
  expect(lines).toHaveLength(1);
  const stamp = lines[0][1];
  expect(Object.values(stamp.phasesMs).reduce((a: number, b) => a + Number(b), 0)).toBe(stamp.totalMs);
}
it("ordinary refusal still emits exactly one safe phase line", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    if (init.method === "POST") return response({}, 403);
    return response({ sandboxes: [], pageInfo: { nextCursor: null } });
  }));
  await expect(plugin.definition.onEnvironmentAcquireLease!(p)).rejects.toThrow();
  stampEvidence("ordinary-refusal");
});
it("ordinary transport abort still emits exactly one safe phase line", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    if (init.method === "POST") throw new DOMException("transport aborted", "AbortError");
    return response({ sandboxes: [], pageInfo: { nextCursor: null } });
  }));
  await expect(plugin.definition.onEnvironmentAcquireLease!(p)).rejects.toThrow();
  stampEvidence("ordinary-transport-abort");
});
it("pre-create acquisition rejection also requires one phase line", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(plugin.definition.onEnvironmentAcquireLease!({ ...p, requestedExpiresAt: "2030-01-01T00:00:00.000Z" })).rejects.toThrow("hard requestedExpiresAt");
  expect(fetch).not.toHaveBeenCalled();
  stampEvidence("pre-create-rejection");
});
