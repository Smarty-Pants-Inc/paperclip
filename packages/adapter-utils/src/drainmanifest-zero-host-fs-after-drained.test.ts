import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostMutationDrain, withHostMutationDrain } from "./host-mutation-drain.js";
import {
  captureDirectorySnapshot,
  captureDirectorySnapshotOffThread,
  disposeDirectorySnapshot,
  type DirectorySnapshot,
} from "./workspace-restore-merge.js";

/**
 * adopt-stopu-drainmanifest (rf-4 Part A, judgeA-manifest-after-drain.json):
 * the drain's contract is ZERO host fs calls after `drained`. A SPY on every
 * host fs call (mkdtemp, rm, rename, writeFile, mkdir, open, symlink, copyFile,
 * unlink, rmdir, chmod) records dispatch + completion with the drained flag, on
 * a REAL disk-backed snapshot (in-thread and the off-thread worker).
 */
const METHODS = ["mkdtemp", "rm", "rename", "writeFile", "mkdir", "open", "symlink", "copyFile", "unlink", "rmdir", "chmod"] as const;
type Event = { method: string; phase: "dispatch" | "complete"; path: string; afterDrain: boolean };

function spyHostFs(state: { drained: boolean }, gate: { prefix: string; reached: () => void; wait: Promise<void> }) {
  const events: Event[] = [];
  const spies = METHODS.map((method) => {
    const original = (fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method].bind(fs);
    const spyOn = vi.spyOn as unknown as (target: object, name: string) => { mockImplementation(fn: (...args: unknown[]) => Promise<unknown>): { mockRestore(): void } };
    return spyOn(fs, method).mockImplementation((async (...args: unknown[]) => {
      const target = String(args[0]);
      events.push({ method, phase: "dispatch", path: target, afterDrain: state.drained });
      if (method === "mkdtemp" && target.includes(gate.prefix)) { gate.reached(); await gate.wait; }
      const value = await original(...args);
      events.push({ method, phase: "complete", path: typeof value === "string" ? value : target, afterDrain: state.drained });
      return value;
    }));
  });
  return { events, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function source(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drainmanifest-source-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "F"), "old turn");
  await fs.mkdir(path.join(root, "d"));
  await fs.writeFile(path.join(root, "d", "G"), "g");
  return root;
}

const cases = [
  { name: "in-thread manifest (createWorkspaceManifest)", prefix: "paperclip-workspace-baseline-", capture: (root: string) => captureDirectorySnapshot(root, { diskBacked: true }) },
  { name: "off-thread snapshot worker (runSnapshotThread)", prefix: "paperclip-snapshot-thread-", capture: (root: string) => captureDirectorySnapshotOffThread(root, { diskBacked: true }) },
];

describe("adopt-stopu-drainmanifest: zero host fs calls after drained (real disk-backed snapshot)", () => {
  for (const testCase of cases) {
    it(`${testCase.name}: the drain closes while the manifest mkdtemp is in flight`, async () => {
      const root = await source();
      const state = { drained: false };
      let release!: () => void; let reached!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const arrived = new Promise<void>((resolve) => { reached = resolve; });
      const spy = spyHostFs(state, { prefix: testCase.prefix, reached, wait });
      const drain = createHostMutationDrain();
      let snapshot: DirectorySnapshot | null = null;
      const work = withHostMutationDrain(drain, () => testCase.capture(root));
      const outcomePromise = work.then((value) => ({ value }), (error: unknown) => ({ error }));
      try {
        await arrived;
        // The mkdtemp is a tracked host step: the drain must NOT report drained.
        const capped = await drain.closeAndDrain(100);
        expect(capped).toEqual({ drained: false, inFlight: 1 });
        release();
        await drain.drained();
        state.drained = true;
        const outcome = await outcomePromise;
        if ("value" in outcome) snapshot = outcome.value;
        await disposeDirectorySnapshot(snapshot); snapshot = null;
        await new Promise((resolve) => setTimeout(resolve, 200));
        const created = spy.events.filter((e) => e.method === "mkdtemp" && e.phase === "complete" && e.path.includes(testCase.prefix)).map((e) => e.path);
        const evidence = { case: testCase.name, capped, inFlight: drain.inFlight, events: spy.events.filter((e) => !e.path.includes("drainmanifest-source-")), afterDrain: spy.events.filter((e) => e.afterDrain), created, createdExistsAfter: created.map((p) => existsSync(p)) };
        console.log("DRAINMANIFEST_EVIDENCE", JSON.stringify(evidence));
        if (process.env.TASK_OUT) await fs.appendFile(path.join(process.env.TASK_OUT, "drainmanifest-evidence.jsonl"), `${JSON.stringify(evidence)}\n`);
        expect(created).toHaveLength(1);
        expect(evidence.afterDrain).toEqual([]);
        expect(evidence.createdExistsAfter).toEqual([false]);
      } finally {
        release(); await work.catch(() => undefined); await disposeDirectorySnapshot(snapshot); spy.restore();
      }
    }, 20_000);

    it(`${testCase.name}: the drain closes while the snapshot is owned; the drain removes it, the late dispose writes nothing`, async () => {
      const root = await source();
      const state = { drained: false };
      const spy = spyHostFs(state, { prefix: "\u0000never", reached: () => undefined, wait: Promise.resolve() });
      const drain = createHostMutationDrain();
      try {
        const snapshot = await withHostMutationDrain(drain, () => testCase.capture(root));
        expect(snapshot.entries.size).toBeGreaterThan(0);
        expect(await drain.closeAndDrain(5_000)).toEqual({ drained: true });
        state.drained = true;
        await disposeDirectorySnapshot(snapshot);
        const created = spy.events.filter((e) => e.method === "mkdtemp" && e.phase === "complete" && e.path.includes(testCase.prefix)).map((e) => e.path);
        const removedBeforeDrained = spy.events.filter((e) => e.method === "rm" && e.phase === "complete" && created.includes(e.path) && !e.afterDrain);
        const evidence = { case: `${testCase.name} (owned)`, afterDrain: spy.events.filter((e) => e.afterDrain), created, removedBeforeDrained: removedBeforeDrained.length, createdExistsAfter: created.map((p) => existsSync(p)) };
        console.log("DRAINMANIFEST_EVIDENCE", JSON.stringify(evidence));
        if (process.env.TASK_OUT) await fs.appendFile(path.join(process.env.TASK_OUT, "drainmanifest-evidence.jsonl"), `${JSON.stringify(evidence)}\n`);
        expect(created).toHaveLength(1);
        expect(evidence.removedBeforeDrained).toBe(1);
        expect(evidence.afterDrain).toEqual([]);
        expect(evidence.createdExistsAfter).toEqual([false]);
      } finally { spy.restore(); }
    }, 20_000);
  }
});
