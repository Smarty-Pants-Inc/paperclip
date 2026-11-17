import { afterEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// Replacement outcomes for the retained, unedited frozen8 409-A nested and
// no-OUR-resume tests. Boat readiness.md:21-22 proves refusal; :31 requires
// resume first without requiring an earlier Paperclip-owned resume. Keep:
// #20974 real incident / data-safety boundary, not shell-text replay inference.
const config = { apiKey: "synthetic-f04f", type: "small", ttlSeconds: 1800, labels: {} };
const scope = { driverKey: "boat", companyId: "f04f", environmentId: "f04f", config };
let sequence = 0;
afterEach(async () => { await plugin.definition.onShutdown?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(["nested-machine", "unknown", "no-ours", "stale-ours"])("frozen8 F-04D named replacement outcome: %s refuses then resumes once", async shape => {
  const id = `bx_f04f_${++sequence}`;
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
  let posts = 0, resumes = 0, state = "archived";
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
    const route = new URL(String(url)).pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    calls.push(`${method} ${route}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (route.endsWith("/resume")) { resumes++; state = "ready"; return json({ sandbox: { id, state } }); }
    if (route.endsWith("/commands")) {
      if (++posts === 1) return json(shape === "unknown" ? { code: "unlisted" } : { error: { code: "machine_not_running", state: "archived", retryable: false } }, 409);
      return json({ exitCode: 0, stdout: "recovered", stderr: "" });
    }
    return json({ sandbox: { id, state } });
  });
  if (shape === "stale-ours") {
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id });
    state = "archived";
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
  }
  try {
    const result = await plugin.definition.onEnvironmentExecute!({ ...scope, lease: { providerLeaseId: id }, command: "true", timeoutMs: 5000 } as any);
    expect(result).toMatchObject({ exitCode: 0, stdout: "recovered" });
    expect(posts).toBe(2); expect(resumes).toBe(shape === "stale-ours" ? 2 : 1);
    expect(calls.at(-2)).toBe(`GET /sandboxes/${id}`);
    expect(calls.at(-1)).toBe(`POST /sandboxes/${id}/commands`);
  } finally { vi.restoreAllMocks(); }
});

it.each([false, true])("frozen8 F-04D replacement: terminal 409 still exposes only closed nested fields (unknown=%s)", async unknown => {
  const id = `bx_f04f_fields_${++sequence}`, canary = "private-provider-message";
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
  let posts = 0, resumes = 0;
  vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
    const route = new URL(String(url)).pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (route.endsWith("/commands")) {
      posts++;
      return json({ error: unknown ? { code: `${canary}_code`, state: `${canary} state`, retryable: "yes", message: canary }
        : { code: "machine_not_running", state: "archived", retryable: false, message: canary } }, 409);
    }
    if (route.endsWith("/resume")) { resumes++; return json({ sandbox: { id, state: "ready" } }); }
    return json({ sandbox: { id, state: resumes ? "ready" : "archived" } });
  });
  const error = await plugin.definition.onEnvironmentExecute!({ ...scope, lease: { providerLeaseId: id }, command: "true", timeoutMs: 5000 } as any).catch(e => e);
  expect(error).toMatchObject({ status: 409, boatCode: unknown ? "other" : "machine_not_running", code: "boat_sandbox_state_transition" });
  expect(error.boatState).toBe(unknown ? undefined : "archived");
  expect(error.boatRetryable).toBe(unknown ? undefined : false);
  expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(canary);
  expect(error).not.toHaveProperty("cause");
  expect(posts).toBe(2); expect(resumes).toBe(1);
});
