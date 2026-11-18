import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PluginWorkerHandle, PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { pluginConfigDelivery } from "../services/plugin-config-delivery.js";

const { getConfig } = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => ({ getConfig }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const row = (revision: number, id = "row") => ({ id, updatedAt: new Date(revision), configJson: { revision } });
function fixture() {
  getConfig.mockReset().mockResolvedValue(row(1));
  let worker = { status: "running" } as PluginWorkerHandle;
  const listeners: Array<(id: string) => void> = [];
  const call = vi.fn().mockResolvedValue({});
  const manager = {
    getWorker: () => worker,
    call,
    onWorkerReady: (listener: (id: string) => void) => { listeners.push(listener); return () => {}; },
  } as unknown as PluginWorkerManager;
  const delivery = pluginConfigDelivery({} as Db, manager);
  const ready = () => listeners.forEach(listener => listener("plugin"));
  ready();
  return { delivery, call, manager, ready, replace: () => { worker = { status: "running" } as PluginWorkerHandle; ready(); } };
}

// Data-safety keep reason: deterministic control of reads and failed RPCs at
// every async boundary supplements the real HTTP/SIGKILL judge regressions.
describe("company config delivery revision and process fences", () => {
  it("shares one coordinator between loader and settings consumers", () => {
    const f = fixture();
    expect(pluginConfigDelivery({} as Db, f.manager)).toBe(f.delivery);
  });

  it("only delivers strictly newer revisions to the same process", async () => {
    const f = fixture();
    await f.delivery.deliver("plugin", "company");
    await f.delivery.deliver("plugin", "company");
    getConfig.mockResolvedValue(row(0));
    await f.delivery.deliver("plugin", "company");
    getConfig.mockResolvedValue(row(2));
    await f.delivery.deliver("plugin", "company");
    expect(f.call.mock.calls.map(call => call[2].config.revision)).toEqual([1, 2]);
  });

  it("coalesces overlapping replay and save of the same revision", async () => {
    const f = fixture();
    const applied = deferred<{}>();
    f.call.mockReturnValueOnce(applied.promise);
    const replay = f.delivery.deliver("plugin", "company");
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    const save = f.delivery.deliver("plugin", "company");
    applied.resolve({});
    await Promise.all([replay, save]);
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("reads after waiting for the company, omitting a deleted row", async () => {
    const f = fixture();
    const applied = deferred<{}>();
    f.call.mockReturnValueOnce(applied.promise);
    const first = f.delivery.deliver("plugin", "company");
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    const queued = f.delivery.deliver("plugin", "company");
    getConfig.mockResolvedValue(null);
    applied.resolve({});
    await Promise.all([first, queued]);
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("drops a read that completes in a later generation of the same handle", async () => {
    const f = fixture();
    const read = deferred<ReturnType<typeof row>>();
    getConfig.mockReturnValueOnce(read.promise);
    const old = f.delivery.deliver("plugin", "company");
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    f.ready();
    getConfig.mockResolvedValue(row(2));
    await f.delivery.deliver("plugin", "company");
    read.resolve(row(1));
    await old;
    expect(f.call.mock.calls.map(call => call[2].config.revision)).toEqual([2]);
  });

  it("does not let an old RPC/queue block or contaminate a new generation", async () => {
    const f = fixture();
    const applied = deferred<{}>();
    f.call.mockReturnValueOnce(applied.promise);
    const old = f.delivery.deliver("plugin", "company");
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    const queued = f.delivery.deliver("plugin", "company");
    f.ready();
    getConfig.mockResolvedValue(row(2));
    await f.delivery.deliver("plugin", "company");
    applied.resolve({});
    await Promise.all([old, queued]);
    await f.delivery.deliver("plugin", "company");
    expect(f.call.mock.calls.map(call => call[2].config.revision)).toEqual([1, 2]);
  });

  it("retries a failed delivery rather than recording it as applied", async () => {
    const f = fixture();
    f.call.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.delivery.deliver("plugin", "company")).rejects.toThrow("unavailable");
    await f.delivery.deliver("plugin", "company");
    expect(f.call).toHaveBeenCalledTimes(2);
  });

  it("delivers the same revision again to a replacement worker", async () => {
    const f = fixture();
    await f.delivery.deliver("plugin", "company");
    const retired = f.delivery.current("plugin");
    f.replace();
    await f.delivery.deliver("plugin", "company", retired);
    await f.delivery.deliver("plugin", "company");
    expect(f.call).toHaveBeenCalledTimes(2);
  });

  it("treats a recreated row as a new revision identity", async () => {
    const f = fixture();
    await f.delivery.deliver("plugin", "company");
    getConfig.mockResolvedValue(row(0, "replacement-row"));
    await f.delivery.deliver("plugin", "company");
    expect(f.call).toHaveBeenCalledTimes(2);
  });
});
