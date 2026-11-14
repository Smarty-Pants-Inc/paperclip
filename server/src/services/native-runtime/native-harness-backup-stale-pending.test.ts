import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from "../../middleware/logger.js";
import { nativeHarnessBackupCounters } from "./native-harness-backup-observability.js";
import { nativeHarnessBackupExpirationService } from "./native-harness-backup-expiration.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { noteNativeHarnessBackupChange } from "../native-harness-backup-expiration-notifications.js";
import { loadConfig } from "../../config.js";
import { installDatabaseWorkSignals } from "@paperclipai/db/work-signals";

const OLD = new Date(Date.now() - 2 * 60 * 60 * 1000 - 1_000);

async function makePending(stateBase: string, name: string, continuity = false) {
  const target = path.join(stateBase, "a".repeat(64), ...(continuity ? ["continuity-breaks", "archive-1"] : []), "failover-backups", name);
  await fs.mkdir(path.join(target, "partial"), { recursive: true });
  await fs.writeFile(path.join(target, "partial", "transcript.jsonl"), "unfinished transcript\n");
  await fs.utimes(target, OLD, OLD);
  return target;
}

describe("native harness stale-pending startup scan", () => {
  let stateBase: string | undefined;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let stopLegacy: (() => void) | undefined;
  afterEach(async () => {
    stopLegacy?.(); stopLegacy = undefined;
    await coordinator?.stop(); coordinator = undefined;
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (stateBase) await fs.rm(stateBase, { recursive: true, force: true });
    stateBase = undefined;
  });

  // Keep: filesystem/data-safety and shutdown trust boundaries (RFL F2).
  function register(db: object, shouldContinue = () => true) {
    installDatabaseWorkSignals(Object.assign(db, { execute: vi.fn(async () => []), transaction: vi.fn() }));
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: shouldContinue, onError: vi.fn() });
    const service = nativeHarnessBackupExpirationService(db as never, { stateBase, shouldContinue });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const worker = service.registerStalePendingScan(coordinator as never);
    // The base returns a timer disposer. Keep RED cleanup safe too.
    if (typeof worker === "function") stopLegacy = worker;
    expect(timers).not.toHaveBeenCalled(); // registration must delegate to the shared lifecycle
    return worker as unknown as { ready: Promise<void>; stop: () => Promise<void> };
  }

  it("shared lifecycle scans with expiration disabled, sleeps when empty, and stops with the server coordinator", async () => {
    vi.stubEnv("PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_ENABLED", "false");
    expect(loadConfig().nativeHarnessBackupExpirationEnabled).toBe(false);
    stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "native-stale-lifecycle-"));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const db = {};
    const worker = register(db);
    const reads = vi.spyOn(fs, "readdir");
    await worker.ready;
    expect(reads).toHaveBeenCalled();
    expect(coordinator!.nextWakeAt()).toBeNull();
    reads.mockClear();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(reads).not.toHaveBeenCalled();
    const pending = await makePending(stateBase, ".pending-first-producer");
    noteNativeHarnessBackupChange(db, { companyId: "company", scopeDigest: "a".repeat(64) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ pendingRoot: pending }), expect.any(String)));
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await coordinator!.stop();
    reads.mockClear();
    noteNativeHarnessBackupChange(db, { companyId: "company", scopeDigest: "a".repeat(64) });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(reads).not.toHaveBeenCalled();
    expect(coordinator!.nextWakeAt()).toBeNull();
  });

  it("does not scan while shouldContinue is false", async () => {
    stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "native-stale-paused-"));
    await makePending(stateBase, ".pending-paused");
    const reads = vi.spyOn(fs, "readdir");
    await nativeHarnessBackupExpirationService({} as never, { stateBase, shouldContinue: () => false }).reportStalePendingBackups();
    expect(reads).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reconstructs the pending deadline at startup and scans from the shared tick after drain resumes", async () => {
    stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "native-stale-deadline-"));
    const pending = await makePending(stateBase, ".pending-young");
    const now = Date.now();
    await fs.utimes(pending, new Date(now), new Date(now));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(now);
    let admitted = true;
    await register({}, () => admitted).ready;
    const dueAt = now + 2 * 60 * 60 * 1000 + 1;
    expect(coordinator!.nextWakeAt()).toBe(dueAt);
    expect(logger.warn).not.toHaveBeenCalled();
    const reads = vi.spyOn(fs, "readdir");
    admitted = false;
    await vi.advanceTimersByTimeAsync(dueAt - now);
    expect(reads).not.toHaveBeenCalled();
    admitted = true;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ pendingRoot: pending }), expect.any(String)));
    // A published/removed pending tree discharges its only future obligation.
    await fs.rm(pending, { recursive: true });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    reads.mockClear();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(reads).not.toHaveBeenCalled();
  });

  it("awaits an in-flight scan on stop and emits no stale warning after stop", async () => {
    stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "native-stale-stop-"));
    await makePending(stateBase, ".pending-stop");
    const original = fs.readdir.bind(fs);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fs, "readdir").mockImplementationOnce((async (...args: Parameters<typeof fs.readdir>) => {
      entered(); await held; return original(...args);
    }) as typeof fs.readdir);
    const worker = register({});
    await started;
    let stopped = false;
    const stop = coordinator!.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop; await worker.ready;
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not copy scan exception text to WARN", async () => {
    stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "native-stale-private-"));
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(
      new Error("DB_PASSWORD db-password-sentinel proxyPassword proxy-password-sentinel transcript-marker-sentinel"),
      { code: "EACCES", stderr: "stderr-secret-sentinel" },
    ));
    await register({}).ready;
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    for (const sentinel of ["DB_PASSWORD", "db-password-sentinel", "proxyPassword", "proxy-password-sentinel", "transcript-marker-sentinel", "stderr-secret-sentinel"]) {
      expect(logged).not.toContain(sentinel);
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "stale_pending_scan_failed", errorCode: "permission_denied" }), expect.any(String));
  });

  it("reports stale pending directories with expiration disabled and leaves them untouched on repeated scans", async () => {
    const warn = vi.mocked(logger.warn);
    const before = nativeHarnessBackupCounters().harnessBackupStalePendingObserved;
    stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "native-stale-pending-"));
    const first = await makePending(stateBase, ".pending-first");
    const service = nativeHarnessBackupExpirationService(null as never, { stateBase });
    // No expiration worker is enabled or registered; this report-only scan is independent of that setting.
    await service.reportStalePendingBackups();
    expect(nativeHarnessBackupCounters().harnessBackupStalePendingObserved).toBe(before + 1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      scopeDigest: "a".repeat(64), pendingRoot: first, reason: "stale_pending_backup",
    }), "Native harness backup pending capture is stale; left in place for operator inspection");
    const originalStat = await fs.lstat(first);
    expect(await fs.readFile(path.join(first, "partial", "transcript.jsonl"), "utf8")).toBe("unfinished transcript\n");

    const second = await makePending(stateBase, ".pending-second", true);
    await service.reportStalePendingBackups();
    expect(nativeHarnessBackupCounters().harnessBackupStalePendingObserved).toBe(before + 3);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ pendingRoot: second, reason: "stale_pending_backup" }),
      "Native harness backup pending capture is stale; left in place for operator inspection");
    const afterStat = await fs.lstat(first);
    expect(afterStat.mtimeMs).toBe(originalStat.mtimeMs);
    expect(await fs.readFile(path.join(second, "partial", "transcript.jsonl"), "utf8")).toBe("unfinished transcript\n");
    expect(await fs.readdir(path.dirname(first))).toEqual([".pending-first"]);
    expect(await fs.readdir(path.dirname(second))).toEqual([".pending-second"]);
  });
});
