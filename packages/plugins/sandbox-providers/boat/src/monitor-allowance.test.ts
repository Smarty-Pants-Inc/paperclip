// F-04G / F1b: exercise the emitted-call owner's real HTTP retry/recovery path.
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

afterEach(async () => { await plugin.definition.onShutdown?.(); vi.unstubAllGlobals(); });

it("aborts a monitor plugin call at its remaining six-second command allowance", async () => {
  let sends = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    sends++;
    const route = new URL(String(url)).pathname;
    if (route.endsWith("/commands")) return new Response("{}", { status: 409 });
    if (route.endsWith("/bx_allowance")) return Response.json({ sandbox: { id: "bx_allowance", state: "archiving" } });
    throw new Error(`Unexpected HTTP ${init?.method ?? "GET"} ${route}`);
  }));
  await plugin.definition.setup!({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as never);
  const started = Date.now();
  const error = await plugin.definition.onEnvironmentExecute!({
    driverKey: "boat", companyId: "allowance", environmentId: "allowance",
    config: { apiKey: "synthetic-no-network", type: "small", ttlSeconds: 1800, labels: {} },
    lease: { providerLeaseId: "bx_allowance" }, command: "sh",
    args: ["-c", "exit 0", "paperclip-runner-monitor"], bypassSession: true,
    timeoutMs: 6_000, commandTimeoutMs: 6_000,
  } as never).catch(error => error);
  const elapsed = Date.now() - started;
  expect(error).toMatchObject({ code: "boat_sandbox_state_transition" });
  expect(error.message).toMatch(/^boat_sandbox_state_transition: /);
  expect(sends).toBeGreaterThan(2);
  expect(elapsed).toBeLessThan(6_500);
}, 20_000);

it("keeps concurrent monitors' abort allowances and resume effects independent", async () => {
  const started = Date.now();
  const ready = new Set<string>();
  const resumes: string[] = [];
  const effects: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const route = new URL(String(url)).pathname;
    const id = route.split("/")[4]!;
    if (route.endsWith("/commands")) {
      if (!ready.has(id)) return new Response("{}", { status: 409 });
      effects.push(id); return Response.json({ exitCode: 0, timedOut: false, stdout: "healthy", stderr: "" });
    }
    if (route.endsWith("/resume")) {
      resumes.push(id); ready.add(id); return Response.json({ sandbox: { id, state: "ready" } });
    }
    const state = ready.has(id) ? "ready" : id === "bx_second" && Date.now() - started >= 900 ? "archived" : "archiving";
    return Response.json({ sandbox: { id, state } });
  }));
  await plugin.definition.setup!({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as never);
  const execute = (id: string, allowance: number) => plugin.definition.onEnvironmentExecute!({
    driverKey: "boat", companyId: "parallel-allowance", environmentId: id,
    config: { apiKey: "synthetic-no-network", type: "small", ttlSeconds: 1800, labels: {} },
    lease: { providerLeaseId: id }, command: "sh", args: ["-c", "exit 0", "paperclip-runner-monitor"],
    bypassSession: true, timeoutMs: allowance, commandTimeoutMs: allowance,
  } as never).catch(error => error);
  const [first, second] = await Promise.all([execute("bx_first", 500), execute("bx_second", 2_500)]);
  expect(first).toMatchObject({ code: "boat_sandbox_state_transition" });
  expect(second).toMatchObject({ exitCode: 0, timedOut: false, stdout: "healthy" });
  expect(resumes).toEqual(["bx_second"]);
  expect(effects).toEqual(["bx_second"]);
  expect(Date.now() - started).toBeLessThan(2_500);
}, 10_000);
