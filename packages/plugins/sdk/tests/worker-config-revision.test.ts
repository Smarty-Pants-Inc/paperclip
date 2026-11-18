import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { createRequest, isJsonRpcResponse, parseMessage, serializeMessage, type JsonRpcResponse } from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

// RFL 09:08Z ruling. Keep reason: config data safety across the RPC boundary.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(fail = false) {
  const input = new PassThrough(), output = new PassThrough();
  const lines = createInterface({ input: output });
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let next = 0;
  const entered = deferred(), gate = deferred();
  const events: string[] = [];
  const latest = new Map<string | null, number>();
  const worker = startWorkerRpcHost({ stdin: input, stdout: output, plugin: definePlugin({
    multiCompanyConfig: true,
    async setup() {},
    async onConfigChanged(config, { companyId }) {
      const revision = config.value as number;
      events.push(`${companyId}:${revision}:start`);
      if (companyId === "a" && revision === 2) {
        entered.resolve(); await gate.promise;
        if (fail) throw new Error("apply failed");
      }
      latest.set(companyId, revision);
      events.push(`${companyId}:${revision}:return`);
    },
  }) });
  lines.on("line", line => {
    const message = parseMessage(line);
    if (!isJsonRpcResponse(message)) return;
    pending.get(Number(message.id))?.(message);
    pending.delete(Number(message.id));
  });
  function call(method: string, params: unknown) {
    const id = ++next;
    const response = new Promise<JsonRpcResponse>(resolve => { pending.set(id, resolve); });
    input.write(serializeMessage(createRequest(method, params, id)));
    return response;
  }
  await call("initialize", {
    manifest: { id: "test.config-revision", apiVersion: 1, version: "1.0.0", displayName: "Revision", description: "Test", author: "Tests", categories: ["automation"], capabilities: [], entrypoints: {} },
    config: {}, databaseNamespace: null,
  });
  return {
    call, events, latest, entered, gate,
    apply: (companyId: string, value: number, revision?: number) => call("configChanged", { companyId, config: { value }, ...(revision === undefined ? {} : { revision }) }),
    close() { gate.resolve(); worker.stop(); lines.close(); input.destroy(); output.destroy(); },
  };
}

describe("worker company config revision settlement", () => {
  it("serializes callback settlement, drops queued old revisions and leaves other companies independent", async () => {
    const f = await fixture();
    try {
      const two = f.apply("a", 2, 2); await f.entered.promise;
      const three = f.apply("a", 3, 3);
      const stale = f.apply("a", 1, 1);
      await f.apply("b", 1, 1);
      expect(f.events).toEqual(["a:2:start", "b:1:start", "b:1:return"]);
      f.gate.resolve(); await Promise.all([two, three, stale]);
      await f.apply("a", 3, 3);
      expect(f.events).toEqual(["a:2:start", "b:1:start", "b:1:return", "a:2:return", "a:3:start", "a:3:return"]);
      expect(f.latest.get("a")).toBe(3);
      console.log("SDK_CONFIG_SETTLEMENT", JSON.stringify(f.events));
    } finally { f.close(); }
  });

  it("does not poison the queue or mark a failed revision applied", async () => {
    const f = await fixture(true);
    try {
      const two = f.apply("a", 2, 2); await f.entered.promise;
      const stale = f.apply("a", 1, 1);
      const retry = f.apply("a", 3, 2);
      f.gate.resolve();
      expect(await two).toHaveProperty("error");
      expect(await stale).toHaveProperty("result");
      expect(await retry).toHaveProperty("result");
      expect(f.events).toEqual(["a:2:start", "a:3:start", "a:3:return"]);
      expect(f.latest.get("a")).toBe(3);
    } finally { f.close(); }
  });

  it("preserves repeated unrevisioned deliveries", async () => {
    const f = await fixture();
    try {
      await f.apply("a", 3, 3);
      await f.apply("a", 1); await f.apply("a", 1);
      expect(f.events).toEqual(["a:3:start", "a:3:return", "a:1:start", "a:1:return", "a:1:start", "a:1:return"]);
    } finally { f.close(); }
  });
});
