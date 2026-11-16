// smarty-dev#20912: a Boat worker killed mid-transfer never runs syncFiles'
// finally, so its paperclip-boat-sync-*/transfer.tar (the transferred state
// bytes) outlives it. The restarted worker removes its own stale sync temps
// and touches nothing else in os.tmpdir().
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

const HOUR = 60 * 60_000;
let root: string, tmp: string, savedTmpdir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "boat-sweep-probe-"));
  tmp = path.join(root, "tmp"); mkdirSync(tmp);
  savedTmpdir = process.env.TMPDIR; process.env.TMPDIR = tmp;
  expect(os.tmpdir()).toBe(tmp);
});
afterEach(async () => {
  await plugin.definition.onShutdown?.();
  if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
  rmSync(root, { recursive: true, force: true });
});

/** What a worker killed mid-transfer leaves: its temp dir holding transfer.tar, last written ageMs ago. */
function leave(name: string, ageMs: number, parent = tmp): string {
  const dir = path.join(parent, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "transfer.tar"), "state bytes of a transfer the worker never finished", { mode: 0o600 });
  const at = new Date(Date.now() - ageMs);
  utimesSync(path.join(dir, "transfer.tar"), at, at);
  utimesSync(dir, at, at);
  return dir;
}

async function startWorker(): Promise<string[]> {
  const info: string[] = [];
  await plugin.definition.setup({
    config: { get: async () => ({}) },
    logger: { info: vi.fn((message: string) => { info.push(message); }), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    events: { on: () => () => undefined },
    state: { get: async () => null, set: async () => undefined },
  } as any);
  return info;
}

it("RED-SWEEP worker restart removes a killed worker's stale paperclip-boat-sync-*/transfer.tar and nothing else", async () => {
  const killed = leave("paperclip-boat-sync-Ab12Cd", 3 * HOUR);
  const live = leave("paperclip-boat-sync-Ef34Gh", 60_000); // another worker's transfer still in flight
  const otherPrefixes = [leave("paperclip-native-state-Ij56Kl", 3 * HOUR), leave("paperclip-boat-syncer-Qr90St", 3 * HOUR),
    leave("paperclip-runner-probe-Uv12Wx", 3 * HOUR), leave("boat-fence-probe-Yz34Ab", 3 * HOUR)];
  // A symlink with our prefix is never followed or removed.
  const outside = leave("outside-target", 3 * HOUR, root);
  const link = path.join(tmp, "paperclip-boat-sync-Mn78Op");
  symlinkSync(outside, link);
  const old = new Date(Date.now() - 3 * HOUR);
  lutimesSync(link, old, old);

  const info = await startWorker();

  expect(existsSync(path.join(killed, "transfer.tar")), "no tar remains from the killed worker").toBe(false);
  expect(existsSync(killed)).toBe(false);
  expect(readFileSync(path.join(live, "transfer.tar"), "utf8")).toContain("state bytes");
  for (const dir of otherPrefixes) expect(existsSync(path.join(dir, "transfer.tar")), dir).toBe(true);
  expect(existsSync(link)).toBe(true);
  expect(existsSync(path.join(outside, "transfer.tar"))).toBe(true);
  expect(info.some(message => message.includes("paperclip-boat-sync") && message.includes("removed=1"))).toBe(true);
});

// Review-fleet-2 judge (F4): a tar younger than 150 min at startup must not wait
// for the next qualifying restart. The same sweep, same rules, also runs every
// 30 minutes; the timer never holds the worker open and stops at shutdown.
it("RED-SWEEP-TIMER the 30-minute timer sweeps a temp that aged past 150 min after startup; a fresh one stays", async () => {
  vi.useFakeTimers({ now: Date.now(), toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    const intervals: Array<{ ms: number | undefined; handle: ReturnType<typeof setInterval> }> = [];
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      const handle = realSetInterval(fn, ms); intervals.push({ ms, handle }); return handle;
    }) as typeof setInterval);
    // 140 min old at startup: kept by the startup sweep, stale 30 min later.
    const ageing = leave("paperclip-boat-sync-Gh56Ij", 140 * 60_000);
    const info = await startWorker();
    spy.mockRestore();
    expect(existsSync(ageing), "younger than 150 min at startup: kept").toBe(true);
    const sweepTimer = intervals.find(entry => entry.ms === 30 * 60_000);
    expect(sweepTimer, "a 30-minute sweep interval is installed at startup").toBeDefined();
    expect((sweepTimer!.handle as unknown as { hasRef(): boolean }).hasRef(), "the sweep timer is unref'd").toBe(false);
    const fresh = leave("paperclip-boat-sync-Kl78Mn", 0); // a transfer that starts after startup
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.waitFor(() => expect(existsSync(ageing), "aged past 150 min: swept by the timer").toBe(false),
      { timeout: 5_000, interval: 20 });
    expect(readFileSync(path.join(fresh, "transfer.tar"), "utf8")).toContain("state bytes");
    expect(info.some(message => message.includes("paperclip-boat-sync") && message.includes("removed=1"))).toBe(true);
    // Shutdown clears the timer: a later stale temp is left for the next worker.
    await plugin.definition.onShutdown?.();
    const later = leave("paperclip-boat-sync-Op90Qr", 3 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(existsSync(later), "no sweep after shutdown").toBe(true);
  } finally { vi.useRealTimers(); }
});
