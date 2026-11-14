import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from "../../middleware/logger.js";
import { nativeHarnessBackupCounters } from "./native-harness-backup-observability.js";
import { nativeHarnessBackupExpirationService } from "./native-harness-backup-expiration.js";

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
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (stateBase) await fs.rm(stateBase, { recursive: true, force: true });
    stateBase = undefined;
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
