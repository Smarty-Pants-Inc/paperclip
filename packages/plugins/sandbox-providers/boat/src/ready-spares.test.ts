import { describe, expect, it, vi } from "vitest";
import {
  MAX_READY_SPARES, ReadySpareKeeper, readySpareConfigHash, readySpareCount,
  readySparePoolKey, type ReadySpare, type ReadySpareKey, type ReadySpareOperations,
} from "./ready-spares.js";

const start = Date.parse("2026-11-15T00:00:00.000Z");
const key: ReadySpareKey = { companyId: "company-a", environmentId: "env-a", configHash: "abc123" };
function spare(overrides: Partial<ReadySpare> = {}): ReadySpare {
  const labels = { owner: `paperclip:${key.companyId}`, environment: key.environmentId, purpose: "spare", configHash: key.configHash, expiry: new Date(start + 1_800_000).toISOString() };
  return { id: "bx_abcdefgh", key, state: "running", warmed: true, expiresAt: labels.expiry, name: `paperclip-spare:ready:${key.configHash}`, labels, ...overrides };
}
function operations(records: ReadySpare[] = []) {
  const inventory = [...records];
  const ops: ReadySpareOperations = {
    list: vi.fn(async () => [...inventory]),
    create: vi.fn(async (poolKey: ReadySpareKey) => {
      const created = spare({ id: `bx_created_${inventory.length}`, key: poolKey,
        name: `paperclip-spare:ready:${poolKey.configHash}`,
        labels: { ...spare().labels, owner: `paperclip:${poolKey.companyId}`, environment: poolKey.environmentId, configHash: poolKey.configHash } });
      inventory.push(created); return created;
    }),
    claim: vi.fn(async () => true),
    refresh: vi.fn(async (record, ttlSeconds) => ({ ...record, expiresAt: new Date(start + ttlSeconds * 1000).toISOString() })),
    stop: vi.fn(async record => { const index = inventory.findIndex(item => item.id === record.id); if (index >= 0) inventory.splice(index, 1); }),
  };
  return { ops, inventory };
}

describe("Boat ready spare keeper", () => {
  it("has a hard company-config bound and keys create-shaping fields independent of object order", () => {
    expect(MAX_READY_SPARES).toBe(3);
    expect(readySpareCount({ spares: 1 })).toBe(1);
    expect(readySpareCount({ spares: 4 })).toBe(0);
    expect(readySpareCount({ spares: 1.5 })).toBe(0);
    expect(readySpareCount({})).toBe(0);
    expect(readySpareConfigHash({ type: "small", labels: { b: "2", a: "1" } }))
      .toBe(readySpareConfigHash({ labels: { a: "1", b: "2" }, type: "small" }));
    expect(readySpareConfigHash({ type: "small" })).not.toBe(readySpareConfigHash({ type: "large" }));
    expect(readySparePoolKey(key)).not.toBe(readySparePoolKey({ ...key, companyId: "company-b" }));
    expect(readySparePoolKey(key)).not.toBe(readySparePoolKey({ ...key, environmentId: "env-b" }));
    expect(readySparePoolKey(key)).not.toBe(readySparePoolKey({ ...key, configHash: "different" }));
  });

  it("adopts only exact company/environment/config warmed running spares; stops stale owned spares", async () => {
    let now = start;
    const healthy = spare();
    const otherCompany = spare({ id: "bx_other_company", key: { ...key, companyId: "company-b" }, labels: { ...spare().labels, owner: "paperclip:company-b" } });
    const otherEnvironment = spare({ id: "bx_other_env", key: { ...key, environmentId: "env-b" }, labels: { ...spare().labels, environment: "env-b" } });
    const wrongHash = spare({ id: "bx_wrong_hash", key: { ...key, configHash: "wrong" }, labels: { ...spare().labels, configHash: "wrong" } });
    const notWarmed = spare({ id: "bx_cold", warmed: false, name: `paperclip-spare:warming:${key.configHash}` });
    const stopped = spare({ id: "bx_stopped", state: "archived" });
    const expired = spare({ id: "bx_expired", expiresAt: new Date(start - 1).toISOString() });
    const claimed = spare({ id: "bx_claimed", name: "paperclip-claim:run-1" });
    const { ops } = operations([healthy, otherCompany, otherEnvironment, wrongHash, notWarmed, stopped, expired, claimed]);
    const keeper = new ReadySpareKeeper(() => now);
    await keeper.reconcile(key, 1, ops);
    expect(keeper.ready(key).map(item => item.id)).toEqual([healthy.id]);
    expect(ops.stop).toHaveBeenCalledTimes(4);
    expect((ops.stop as ReturnType<typeof vi.fn>).mock.calls.map(([item]) => item.id).sort()).toEqual(["bx_cold", "bx_expired", "bx_stopped", "bx_wrong_hash"]);
    expect(ops.stop).not.toHaveBeenCalledWith(otherCompany);
    expect(ops.stop).not.toHaveBeenCalledWith(otherEnvironment);
    expect(ops.stop).not.toHaveBeenCalledWith(claimed);
    now += 2_000_000;
    expect(keeper.ready(key)).toHaveLength(1); // expiry is rechecked at claim time
  });

  it("hands only live warmed spares over and atomically reserves concurrent claims", async () => {
    let now = start;
    const { ops } = operations([spare()]);
    const keeper = new ReadySpareKeeper(() => now);
    await keeper.reconcile(key, 1, ops);
    let resolveClaim!: (value: boolean) => void;
    (ops.claim as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<boolean>(resolve => { resolveClaim = resolve; }));
    const first = keeper.claim(key, "run-one", 1800, ops);
    const second = await keeper.claim(key, "run-two", 1800, ops);
    expect(second).toBeUndefined();
    expect(ops.claim).toHaveBeenCalledTimes(1);
    resolveClaim(true);
    await expect(first).resolves.toMatchObject({ id: "bx_abcdefgh" });
    now += 1_800_001;
    expect(await keeper.claim(key, "late", 1800, ops)).toBeUndefined();
  });

  it("treats an API claim failure as a cache miss so ordinary create can proceed", async () => {
    const { ops } = operations([spare()]);
    const keeper = new ReadySpareKeeper(() => start);
    await keeper.reconcile(key, 1, ops);
    (ops.claim as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Boat unavailable"));
    await expect(keeper.claim(key, "run", 1800, ops)).resolves.toBeUndefined();
    expect(keeper.ready(key)).toHaveLength(0);
  });

  it("stops surplus spares when disabled or lowered and never deletes them", async () => {
    const initial = [spare(), spare({ id: "bx_second" }), spare({ id: "bx_third" })];
    const { ops } = operations(initial);
    const keeper = new ReadySpareKeeper(() => start);
    await keeper.reconcile(key, 3, ops);
    await keeper.reconcile(key, 1, ops);
    expect(ops.stop).toHaveBeenCalledTimes(2);
    await keeper.reconcile(key, 0, ops);
    expect(ops.stop).toHaveBeenCalledTimes(3);
    expect(keeper.ready(key)).toEqual([]);
    expect(ops).not.toHaveProperty("delete");
  });

  it("caps creates per company per rolling hour and exponentially backs off failed creates", async () => {
    let now = start;
    const keeper = new ReadySpareKeeper(() => now, 1);
    const first = operations();
    await keeper.reconcile(key, 1, first.ops);
    expect(first.ops.create).toHaveBeenCalledTimes(1);
    const secondKey = { ...key, environmentId: "env-b" };
    const second = operations();
    await keeper.reconcile(secondKey, 1, second.ops);
    expect(second.ops.create).not.toHaveBeenCalled();

    const failKey = { ...key, companyId: "company-b" };
    const retryKeeper = new ReadySpareKeeper(() => now, 12);
    const failing = operations();
    (failing.ops.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("429"));
    await expect(retryKeeper.reconcile(failKey, 1, failing.ops)).rejects.toThrow("429");
    now += 999;
    await retryKeeper.reconcile(failKey, 1, failing.ops);
    expect(failing.ops.create).toHaveBeenCalledTimes(1);
    now += 1;
    (failing.ops.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(spare({ id: "bx_after_backoff", key: failKey,
      labels: { ...spare().labels, owner: `paperclip:${failKey.companyId}`, environment: failKey.environmentId } }));
    await retryKeeper.reconcile(failKey, 1, failing.ops);
    expect(failing.ops.create).toHaveBeenCalledTimes(2);
  });

  it("refreshes near-expiry TTLs and makes a failed refresh unclaimable", async () => {
    let now = start;
    const nearExpiry = spare({ expiresAt: new Date(start + 600_000).toISOString() });
    const { ops } = operations([nearExpiry]);
    const keeper = new ReadySpareKeeper(() => now);
    await keeper.reconcile(key, 1, ops);
    await keeper.refreshDue(1800, ops);
    expect(ops.refresh).toHaveBeenCalledTimes(1);
    expect(keeper.ready(key)[0]?.expiresAt).toBe(new Date(start + 1_800_000).toISOString());
    now += 1_000_001;
    (ops.refresh as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Boat unavailable"));
    await keeper.refreshDue(1800, ops);
    expect(keeper.ready(key)).toEqual([]);
    expect(ops.stop).toHaveBeenCalled();
  });
});
