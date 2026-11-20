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
      // cancelRun promotes the cancelled run's deferred successor.
      cancelRun: async () => { startPromoted("cancel"); return null; },
    };
  },
}));

import { heartbeatService } from "../services/heartbeat.js";
import { clearProcessHeartbeat, registerProcessHeartbeat } from "../services/heartbeat-registry.js";
import { settleIssueLock } from "../services/recovery/issue-lock-settlement.js";
import { settleSteeringIngestion } from "../services/native-runtime/steering-ingestion.js";
import { executeIssuePostCommitActions } from "../services/issues.js";
import { logger } from "../middleware/logger.js";

const warnSpy = vi.spyOn(logger, "warn");
const registryMisses = () => warnSpy.mock.calls.filter(([obj]) =>
  (obj as { event?: string } | undefined)?.event === "process_heartbeat_registry_miss");

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
  afterEach(() => { started.length = 0; built.length = 0; warnSpy.mockClear(); });

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
    expect(registryMisses()).toEqual([]); // hit: no warn
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
    expect(registryMisses()).toEqual([]); // hit: no warn
    clearProcessHeartbeat(db);
  });

  it("(iv) with nothing registered (tests that never boot a server) the bare instance is used, as today", async () => {
    const db = standInDb();
    const outcome = await settleIssueLock(db, lockRecord(), { now: new Date(), proof: {} as any });
    console.info("row-iv", JSON.stringify({ outcome, started, built }));
    expect(outcome.settled).toBe(true);
    expect(built).toEqual([{ wired: false }]);
    expect(started[0]).toMatchObject({ via: "settlement", setup: UNAVAILABLE });
    expect(registryMisses()).toEqual([]); // nothing registered: no warn
  });

  it("(v) a call with a DIFFERENT Db object (e.g. a tx handle) warns once per site and keeps the bare fallback", async () => {
    const dbA = standInDb();
    const dbB = standInDb(); // e.g. a tx handle or dedicated connection
    registerProcessHeartbeat(dbA, heartbeatService(dbA as any, { pluginWorkerManager } as any) as any);
    built.length = 0;
    try {
      const first = await settleIssueLock(dbB, lockRecord(), { now: new Date(), proof: {} as any });
      const second = await settleIssueLock(dbB, lockRecord(), { now: new Date(), proof: {} as any });
      console.info("row-v", JSON.stringify({ first, second, started, built, warns: registryMisses() }));
      expect(first.settled && second.settled).toBe(true); // never throws
      // Not substituted: a root-bound heartbeat would run outside the caller's tx.
      expect(built).toEqual([{ wired: false }, { wired: false }]);
      expect(registryMisses()).toHaveLength(1); // once per call site, not per call
      expect(registryMisses()[0]![0]).toEqual({ event: "process_heartbeat_registry_miss", site: "issue-lock-settlement" });
    } finally { clearProcessHeartbeat(dbA); }
  });

  it("(vii) cancelling a live run starts its successor on the registered process heartbeat", async () => {
    const db = standInDb();
    registerProcessHeartbeat(db, heartbeatService(db as any, { pluginWorkerManager } as any) as any);
    built.length = 0;
    try {
      await executeIssuePostCommitActions(db, [{ type: "cancel_native_question_run",
        runId: randomUUID(), issueId: randomUUID(), issueStatus: "done" }]);
      console.info("row-vii", JSON.stringify({ started, built }));
      expect(built).toEqual([]);
      expect(started).toEqual([expect.objectContaining({ via: "cancel", setup: "passed" })]);
      expect(registryMisses()).toEqual([]);
    } finally { clearProcessHeartbeat(db); }
  });

  it("(viii) misses at DIFFERENT call sites each warn once (no shared label silences a later site)", async () => {
    const dbA = standInDb();
    const dbB = standInDb(); // a Db object other than the registered one
    registerProcessHeartbeat(dbA, heartbeatService(dbA as any, { pluginWorkerManager } as any) as any);
    try {
      const { summarySlotRoutes } = await import("../routes/summary-slots.js");
      const { statusCardRoutes } = await import("../routes/status-cards.js");
      const { secretRoutes } = await import("../routes/secrets.js");
      for (let round = 0; round < 2; round += 1) {
        summarySlotRoutes(dbB);
        statusCardRoutes(dbB);
        secretRoutes(dbB);
      }
      const sites = registryMisses().map(([obj]) => (obj as { site: string }).site);
      const perSite = Object.fromEntries(["summary-slot-routes", "status-card-routes", "secret-routes"]
        .map(site => [site, sites.filter(s => s === site).length]));
      console.info("row-viii", JSON.stringify({ sites, perSite }));
      expect(perSite).toEqual({ "summary-slot-routes": 1, "status-card-routes": 1, "secret-routes": 1 });
      expect(sites).toHaveLength(3);
    } finally { clearProcessHeartbeat(dbA); }
  });
});
