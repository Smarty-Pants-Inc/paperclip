import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { pluginConfigDelivery } from "../services/plugin-config-delivery.js";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => ({ getConfig: read }) }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const row = (revision: number) => ({ id: "row", updatedAt: new Date(revision), configJson: { revision } });
function fixture() {
  const worker = { status: "running" };
  const call = vi.fn().mockResolvedValue(undefined);
  const callbacks: Array<(id: string) => void> = [];
  const manager = {
    getWorker: () => worker, call,
    onWorkerReady: (callback: (id: string) => void) => { callbacks.push(callback); return () => {}; },
  } as unknown as PluginWorkerManager;
  read.mockReset().mockResolvedValue(row(1));
  const delivery = pluginConfigDelivery({} as Db, manager);
  const ready = () => callbacks.forEach(callback => callback("plugin"));
  ready();
  return { call, delivery, ready };
}

// Failure-path/data-safety keep reason: directly measures admitted work and
// promise identity while controlling a failing RPC, which HTTP cannot expose.
describe("bounded company config delivery admission", () => {
  it("absorbs 1000 requests into one shared pending delivery and two reads", async () => {
    const f = fixture(); const gate = deferred();
    f.call.mockReturnValueOnce(gate.promise);
    const first = f.delivery.deliver("plugin", "company");
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    const burst = Array.from({ length: 1000 }, () => f.delivery.deliver("plugin", "company"));
    const identities = new Set(burst).size;
    gate.resolve(); await Promise.all([first, ...burst]);
    console.log("BOUNDED_SUCCESS", JSON.stringify({ requests: 1000, reads: read.mock.calls.length, rpcCalls: f.call.mock.calls.length, identities }));
    expect(identities).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.delivery.current("plugin")!.pending.size).toBe(0);
  });

  it("bounds 64 concurrent failed requests to two RPC attempts and no retry loop", async () => {
    const f = fixture(); const gate = deferred();
    f.call.mockImplementation(async () => { await gate.promise; throw new Error("unavailable"); });
    const results = Array.from({ length: 64 }, () => f.delivery.deliver("plugin", "company").catch(() => undefined));
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    gate.resolve(); await Promise.all(results);
    await new Promise(resolve => setTimeout(resolve, 20));
    console.log("BOUNDED_FAILURE", JSON.stringify({ requests: 64, reads: read.mock.calls.length, rpcCalls: f.call.mock.calls.length }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(f.delivery.current("plugin")!.pending.size).toBe(0);
  });

  it("reads the newest row when pending work starts and admits a successor during that delivery", async () => {
    const f = fixture(); const firstGate = deferred(); const secondGate = deferred();
    f.call.mockReturnValueOnce(firstGate.promise).mockReturnValueOnce(secondGate.promise);
    const first = f.delivery.deliver("plugin", "company");
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    const second = f.delivery.deliver("plugin", "company");
    const same = f.delivery.deliver("plugin", "company");
    read.mockResolvedValue(row(3));
    firstGate.resolve(); await first;
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2));
    const third = f.delivery.deliver("plugin", "company");
    read.mockResolvedValue(row(4)); secondGate.resolve();
    await Promise.all([second, same, third]);
    expect(same).toBe(second);
    expect(f.call.mock.calls.map(call => call[2].config.revision)).toEqual([1, 3, 4]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("a blocked company's burst does not delay another company or a new worker generation", async () => {
    const f = fixture(); const gate = deferred();
    f.call.mockReturnValueOnce(gate.promise);
    const old = f.delivery.deliver("plugin", "a");
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    const queued = Array.from({ length: 1000 }, () => f.delivery.deliver("plugin", "a"));
    await f.delivery.deliver("plugin", "b");
    f.ready(); await f.delivery.deliver("plugin", "a");
    gate.resolve(); await Promise.all([old, ...queued]);
    expect(f.call).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
