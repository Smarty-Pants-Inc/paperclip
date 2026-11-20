// Keep: a pre-PATCH sentinel is usable only with a successful, live PATCH.
// Controlled provider I/O, not real Boat or an end-to-end latency benchmark.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import plugin from "./plugin.js";

const id = "bx_23456789", foreign = "bx_98765432", cwd = "/home/user/paperclip-workspace", token = "e".repeat(64);
const now = Date.parse("2026-11-20T12:00:00Z"), old = "2026-11-20T12:10:00.000Z", next = "2026-11-20T12:30:00.000Z";
const sentinel = { path: `${cwd}/.paperclip-runtime/reusable-sandbox-lease.json`, token, result: "written" };
const params = { driverKey: "boat", companyId: "authority-company", environmentId: "authority-env", providerLeaseId: id,
  config: { apiKey: "boat_authority_fixture", reuseLease: true, ttlSeconds: 1800, duplexCarrier: "off" },
  leaseMetadata: { adapterType: "paperclip_runner", sandboxId: id, remoteCwd: cwd, reuseLease: true, boatOrgId: "org_saved", workspaceSentinel: sentinel } };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let events: string[], logs: any[], patchDone: boolean, cats: number, result: unknown;
beforeEach(async () => {
  events = []; logs = []; patchDone = false; cats = 0; result = undefined;
  vi.spyOn(Date, "now").mockReturnValue(now);
  await plugin.definition.setup({ logger: { info: (message: string, data: unknown) => logs.push({ message, data }),
    warn: (message: string, data: unknown) => logs.push({ message, data }), error: () => {}, debug: () => {} } } as any);
});
afterEach(async ctx => {
  await plugin.definition.onShutdown?.();
  if (process.env.AUTHORITY_TRACE) appendFileSync(process.env.AUTHORITY_TRACE, JSON.stringify({ row: ctx.task.name, events, logs, result }) + "\n");
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
type Mode = "failed" | "redirected" | "wrong-id" | "archived" | "unknown" | "failing" | "failed-stop";
function transport(mode: Mode, early: "match" | "timeout" = "match") {
  vi.stubGlobal("fetch", async (url: any, init: RequestInit = {}) => {
    const path = String(url).replace("https://boat.dev/api/v1", ""), method = init.method ?? "GET";
    events.push(`${method} ${path}${path.endsWith("/commands") ? patchDone ? " post-patch" : " early" : ""}`);
    if (method === "GET" && path === `/sandboxes/${id}`) return reply({ sandbox: { id, state: "running", archiveAfter: old, team: { id: "org_get" } } });
    if (method === "PATCH" && path === `/sandboxes/${id}`) {
      await new Promise<void>(resolve => setImmediate(resolve)); patchDone = true; events.push("PATCH outcome");
      if (mode === "failed") return reply({ code: "bad_request" }, 400);
      if (mode === "redirected") {
        expect(init.redirect).toBe("error");
        return new Response(null, { status: 307, headers: { location: `https://boat.dev/api/v1/sandboxes/${foreign}` } });
      }
      return reply({ sandbox: { id: mode === "wrong-id" ? foreign : id,
        state: mode === "archived" ? "archived" : mode === "unknown" ? "unknown" : "running", archiveAfter: next,
        team: { id: "org_patch" }, ...(mode === "failing" || mode === "failed-stop" ? { stop: { status: mode === "failing" ? "failing" : "failed" } } : {}) } });
    }
    if (method === "POST" && path === `/sandboxes/${id}/commands`) {
      cats++;
      expect(JSON.parse(String(init.body)).command).toContain(`cat '${sentinel.path}'`);
      // The early result matches (or rejects); base's later read sees replacement
      // workspace contents. No fallback is allowed to build a lease from the early proof.
      return reply({ exitCode: 0, timedOut: !patchDone && early === "timeout", stdout: JSON.stringify({ version: 1, provider: "boat", token: patchDone ? "f".repeat(64) : token }), stderr: "" });
    }
    throw Error(`Unexpected authority request ${method} ${path}`);
  });
}
it.each(["failed", "redirected", "wrong-id", "archived", "unknown", "failing", "failed-stop"] as const)(
  "PATCH %s discards matched early cat and uses base's post-outcome sentinel", async mode => {
    transport(mode);
    const lease = await plugin.definition.onEnvironmentResumeLease!(params); result = lease;
    const failed = ["failed", "redirected", "wrong-id"].includes(mode);
    expect(lease).toMatchObject({ providerLeaseId: null, metadata: { expired: true, workspaceSentinel: { result: "mismatch" }, ttlRefresh: { status: failed ? "failed" : "ok" } } });
    expect(events.filter(e => e.startsWith("PATCH /"))).toHaveLength(1);
    expect(events.slice(events.indexOf("PATCH outcome") + 1)).toEqual([`POST /sandboxes/${id}/commands post-patch`]);
    if (process.env.EXPECT_PARALLEL === "1") {
      expect(cats).toBe(2);
      expect(logs).toContainEqual({ message: "Boat lease resume path", data: { providerLeaseId: id, resumePath: "fallback",
        reason: failed ? "patch-failed" : ["failing", "failed-stop"].includes(mode) ? "patch-stop-refused" : "patch-not-live" } });
    }
  });
it("failed PATCH discards an early rejected cat too; post-PATCH mismatch is base's result", async () => {
  transport("failed", "timeout");
  result = await plugin.definition.onEnvironmentResumeLease!(params);
  expect(result).toMatchObject({ providerLeaseId: null,
    metadata: { expired: true, workspaceSentinel: { result: "mismatch" }, ttlRefresh: { status: "failed" } } });
  expect(events.slice(events.indexOf("PATCH outcome") + 1)).toEqual([`POST /sandboxes/${id}/commands post-patch`]);
});
