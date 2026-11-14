import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { expect, it, vi } from "vitest";
import { startWorkerRpcHost, readEnvironmentRunnerIngressFailure } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";
import manifest from "./manifest.js";

// Keep: actual SDK RPC serialization/discovery trust boundary. Strict local
// provider fixture; this is NOT a live Boat WSS or PRP/model qualification.
it("discovers and dispatches Runner ingress through the real SDK, redacts failures, and drains only after stop", async () => {
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  let failHost = false, stopped = false;
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: RequestInit) => {
    if (String(url).endsWith("/host")) return failHost ? response({ message: "private-credential-must-not-escape" }, 503) : response({ port: 43127, url: "https://swift-otter-9021-43127.on.boat.dev?_token=private-token", isProtected: true, access: "private" });
    if (String(url).endsWith("/stop") && init?.method === "POST") { stopped = true; return response({ operation: { id: "stop" } }, 202); }
    if (init?.method && init.method !== "GET") throw new Error("Unexpected mutation");
    return response({ sandbox: { id: "bx_worker", state: stopped ? "archived" : "ready", updatedAt: "2026-11-12T00:00:00Z", ...(stopped ? { stop: { id: "stop", status: "completed" } } : {}) } });
  }));
  const input = new PassThrough(), output = new PassThrough(), lines = createInterface({ input: output });
  const pending = new Map<string, { resolve(value: any): void; reject(error: any): void; timer: NodeJS.Timeout }>();
  const host = startWorkerRpcHost({ plugin, stdin: input, stdout: output, rpcTimeoutMs: 1000 });
  let sequence = 0;
  lines.on("line", line => {
    const message = JSON.parse(line), call = pending.get(message.id);
    if (call) { pending.delete(message.id); clearTimeout(call.timer); if (message.error) call.reject(message.error); else call.resolve(message.result); }
    else if (message.method && message.id !== undefined) input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }) + "\n");
  });
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = `runner-${++sequence}`, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 3000);
    pending.set(id, { resolve, reject, timer }); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await rpc("initialize", { manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: "boat-runner-contract", hostVersion: "0.3.0-canary.12" } });
    expect(initialized.supportedMethods).toEqual(expect.arrayContaining(["environmentRunnerIngressEndpoint", "environmentResumeLease", "environmentStopLease", "environmentSyncIn", "environmentSyncOut"]));
    expect(await plugin.definition.onIdleDrain!(new AbortController().signal)).toBe("none");
    const params = { driverKey: "boat", companyId: "company", environmentId: "environment", config: { apiKey: "test-only" }, lease: { providerLeaseId: "bx_worker" }, port: 43127, path: "/api/runner/v1/connect/run" };
    const endpoint = await rpc("environmentRunnerIngressEndpoint", params);
    expect(endpoint.websocketUrl).toBe("wss://swift-otter-9021-43127.on.boat.dev/api/runner/v1/connect/run");
    expect(endpoint.secretHeaders).toEqual([{ name: "Cookie", value: "_port_auth=private-token" }]);
    expect(await plugin.definition.onIdleDrain!(new AbortController().signal)).toBe("present");
    failHost = true;
    const failure = await rpc("environmentRunnerIngressEndpoint", params).catch(error => error);
    expect(readEnvironmentRunnerIngressFailure(failure)).toEqual({ phase: "private_preview", httpStatus: 503 });
    expect(JSON.stringify(failure)).not.toContain("private-credential-must-not-escape");
    expect(await rpc("environmentStopLease", { ...params, providerLeaseId: "bx_worker" })).toEqual({ providerLeaseId: "bx_worker", state: "stopped" });
    expect(await plugin.definition.onIdleDrain!(new AbortController().signal)).toBe("none");
    console.log("WORKER_RUNNER_EVIDENCE", JSON.stringify({ version: manifest.version, supportedMethods: initialized.supportedMethods, endpointKind: endpoint.kind, endpointHasQuery: new URL(endpoint.websocketUrl).search !== "", ingressFailure: readEnvironmentRunnerIngressFailure(failure), idleAfterStop: "none" }));
  } finally {
    for (const call of pending.values()) clearTimeout(call.timer);
    host.stop(); lines.close(); input.destroy(); output.destroy(); vi.unstubAllGlobals();
  }
});
