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
