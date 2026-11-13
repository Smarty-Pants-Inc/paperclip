import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { expect, it, vi } from "vitest";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import { classifyEnvironmentCapabilities, ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT } from "../../../../../server/src/services/environment-runtime.js";
import plugin from "./plugin.js";
import manifest from "./manifest.js";

// Keep: provider/core contract boundary. The packaged run resolves this plugin,
// manifest, and SDK from the exact extracted archive, not workspace SDK sources.
it("advertises and dispatches BOTH native sync verbs through the SDK and grants native sync in core", async () => {
  const network = vi.fn(async () => { throw new Error("Unexpected network in worker discovery test"); });
  vi.stubGlobal("fetch", network);
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output });
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const host = startWorkerRpcHost({ plugin, stdin: input, stdout: output, rpcTimeoutMs: 1000 });
  let sequence = 0;
  lines.on("line", line => {
    const message = JSON.parse(line);
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error(JSON.stringify(message.error)));
      else call.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }) + "\n");
    }
  });
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = `native-sync-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 3000);
    pending.set(id, { resolve, reject, timer });
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await rpc("initialize", { manifest, config: {}, apiVersion: 1,
      instanceInfo: { instanceId: "boat-native-sync-check", hostVersion: "0.3.0-canary.12" } });
    expect(initialized.supportedMethods).toEqual(expect.arrayContaining(["environmentSyncIn", "environmentSyncOut"]));
    const effective = classifyEnvironmentCapabilities({
      verifiedMethods: initialized.supportedMethods,
      declared: manifest.environmentDrivers![0].sandboxCapabilities,
      supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.sandbox.supportedCapabilities,
    });
    expect(effective.nativeSyncIn).toBe(true);
    expect(effective.nativeSyncOut).toBe(true);
    expect(effective.concurrentSyncOperations).toBe(false);
    // SSH hooks are implemented, but cannot grant capability without a genuine
    // config-aware host gate. This disabled artifact must stay denied in Core.
    expect(effective.duplexCommandStream).toBe(true);
    for (const method of ["environmentSyncIn", "environmentSyncOut"]) {
      expect(await rpc(method, { driverKey: "boat", companyId: "c", environmentId: "e", config: {},
        lease: { providerLeaseId: "bx_test" }, operations: [] })).toEqual({ operations: [] });
    }
    expect(network).not.toHaveBeenCalled();
    console.log("WORKER_SYNC_EVIDENCE", JSON.stringify({ version: manifest.version,
      supportedMethods: initialized.supportedMethods, declared: manifest.environmentDrivers![0].sandboxCapabilities,
      effective, dispatched: ["environmentSyncIn", "environmentSyncOut"], networkCalls: network.mock.calls.length }));
  } finally {
    for (const call of pending.values()) clearTimeout(call.timer);
    host.stop(); lines.close(); input.destroy(); output.destroy(); vi.unstubAllGlobals();
  }
});
