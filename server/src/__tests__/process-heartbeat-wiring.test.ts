import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

// Plugin sandbox provider stand-in. The provider ("boat") is installed and its
// plugin is ready; only the heartbeat instance decides whether a promoted run
// reaches environment setup WITH the process's plugin worker manager. Without
// it, setup fails exactly as environment-runtime.ts does (see
// environment-runtime.test.ts "sandbox plugin workers are unavailable").
const UNAVAILABLE = 'Sandbox provider "boat" is installed, but sandbox plugin workers are unavailable in this server process.';
const started = vi.hoisted(() => [] as Array<{ runId: string; via: string; setup: "passed" | string }>);
const built = vi.hoisted(() => [] as Array<{ wired: boolean }>);

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: (_db: unknown, options: { pluginWorkerManager?: unknown } = {}) => {
    built.push({ wired: Boolean(options.pluginWorkerManager) });
    // A promoted deferred head starts a run whose environment is the plugin provider.
    const startPromoted = (via: string) => {
      const runId = randomUUID();
      const setup = options.pluginWorkerManager ? "passed" : UNAVAILABLE;
      started.push({ runId, via, setup });
      return runId;
    };
    return {
      sweepStaleIssueLocks: async ({ issueId }: { issueId: string }) => {
        startPromoted("settlement");
        return { cleared: 1, issueIds: [issueId], terminalizedRunIds: [] };
      },
      releaseIssueExecutionAndPromote: async () => { startPromoted("release"); return null; },
    };
  },
}));

import { heartbeatService } from "../services/heartbeat.js";
import { clearProcessHeartbeat, registerProcessHeartbeat } from "../services/heartbeat-registry.js";
import { settleIssueLock } from "../services/recovery/issue-lock-settlement.js";
import { settleSteeringIngestion } from "../services/native-runtime/steering-ingestion.js";

const pluginWorkerManager = { isRunning: () => true, call: vi.fn() };

function standInDb(run?: { status: string; result: Record<string, unknown> }) {
  // Only steering-ingestion's own receipt transaction touches the database.
  const chain: any = new Proxy(() => chain, {
    get: (_t, key) => key === "then" ? undefined
      : key === "for" ? async () => (run ? [run] : []) : () => chain,
    apply: () => chain,
  });
  return { transaction: async (fn: (tx: unknown) => unknown) => fn(chain) } as unknown as Db;
}

function lockRecord() {
  return { recordId: randomUUID(), companyId: randomUUID(), runId: randomUUID(), issueId: randomUUID(),
    owner: { kind: "run", runId: randomUUID() }, updatedAt: new Date() } as any;
}

describe("promotion paths use the process's wired heartbeat (plugin sandbox provider)", () => {
  afterEach(() => { started.length = 0; built.length = 0; });

  it("(i) settleIssueLock: the promoted wake passes environment setup on the registered process heartbeat", async () => {
    const db = standInDb();
    registerProcessHeartbeat(db, heartbeatService(db as any, { pluginWorkerManager } as any) as any);
    built.length = 0;
    const outcome = await settleIssueLock(db, lockRecord(), { now: new Date(), proof: {} as any });
    console.info("row-i", JSON.stringify({ outcome, started, bareInstancesBuilt: built.length }));
    expect(outcome).toEqual({ settled: true, reason: "stale_lock_cleared" });
    expect(built).toEqual([]); // no bare instance at all
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ via: "settlement", setup: "passed" });
    clearProcessHeartbeat(db);
  });

  it("(iii) steering-ingestion's release drain starts the promoted run on the registered process heartbeat", async () => {
    const sourceInstanceId = randomUUID();
    const db = standInDb({ status: "succeeded", result: { steeringIngestionReleaseHeld: true,
      nativeSteeringIngestion: { state: "open", sourceInstanceId, terminalSourceSeq: 3, highestContiguousSourceSeq: 3 } } });
    registerProcessHeartbeat(db, heartbeatService(db as any, { pluginWorkerManager } as any) as any);
    built.length = 0;
    await settleSteeringIngestion(db, { companyId: randomUUID(), runId: randomUUID(), sourceInstanceId,
      terminalSourceSeq: 3, highestContiguousSourceSeq: 3 });
    console.info("row-iii", JSON.stringify({ started, bareInstancesBuilt: built.length }));
    expect(built).toEqual([]);
    expect(started).toEqual([expect.objectContaining({ via: "release", setup: "passed" })]);
    clearProcessHeartbeat(db);
  });

  it("(iv) with nothing registered (tests that never boot a server) the bare instance is used, as today", async () => {
    const db = standInDb();
    const outcome = await settleIssueLock(db, lockRecord(), { now: new Date(), proof: {} as any });
    console.info("row-iv", JSON.stringify({ outcome, started, built }));
    expect(outcome.settled).toBe(true);
    expect(built).toEqual([{ wired: false }]);
    expect(started[0]).toMatchObject({ via: "settlement", setup: UNAVAILABLE });
  });
});
