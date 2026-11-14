import { describe, expect, it, vi } from "vitest";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
import { logger } from "../../middleware/logger.js";
import { reportNativeHarnessBackupCapture, reportNativeHarnessBackupStalePending } from "./native-harness-backup-observability.js";

const identity = { scopeDigest: "a".repeat(64), runId: "run", nativeSessionId: "session" };
const privateText = "DB_PASSWORD db-password-sentinel proxyPassword proxy-password-sentinel transcript-marker-sentinel";

// Keep: credential/transcript trust boundary at the unconditional WARN sink (RFL F1).
describe("closed native backup warning fields", () => {
  it.each([
    ["EACCES", "permission_denied"], ["EPERM", "permission_denied"], ["ENOENT", "not_found"],
    ["EIO", "io_error"], ["ETIMEDOUT", "timeout"], [privateText, "unknown"],
  ])("projects %s without logging exception text", (code, expected) => {
    class StorageFailure extends Error {}
    const error = Object.assign(new StorageFailure(privateText), { code, name: privateText, stderr: privateText });
    reportNativeHarnessBackupCapture({ ...identity, outcome: "failed", reason: "capture_failed", error });
    const fields = vi.mocked(logger.warn).mock.calls.at(-1)?.[0];
    expect(fields).toEqual({ ...identity, outcome: "failed", reason: "capture_failed", errorCode: expected,
      ...(expected === "unknown" ? { errorClass: "StorageFailure" } : {}) });
    expect(JSON.stringify(fields)).not.toContain("sentinel");
  });

  it("uses unknown for non-Error throws without stringifying their contents", () => {
    reportNativeHarnessBackupCapture({ ...identity, outcome: "failed", reason: "capture_failed", error: privateText });
    expect(vi.mocked(logger.warn).mock.calls.at(-1)?.[0]).toEqual({ ...identity, outcome: "failed", reason: "capture_failed", errorCode: "unknown" });
  });

  it("closes incomplete reason codes and ignores extra skipped/stale fields", () => {
    reportNativeHarnessBackupCapture({ ...identity, outcome: "skipped", reason: "checkpoint_incomplete",
      incompleteReason: privateText, detail: privateText } as Parameters<typeof reportNativeHarnessBackupCapture>[0]);
    expect(vi.mocked(logger.warn).mock.calls.at(-1)?.[0]).toEqual({ ...identity, outcome: "skipped",
      reason: "checkpoint_incomplete", incompleteReason: "unknown" });
    reportNativeHarnessBackupStalePending({ scopeDigest: identity.scopeDigest, pendingRoot: "/state/.pending-id",
      ageMs: 8_000_000, hasCurrent: false, err: new Error(privateText) } as Parameters<typeof reportNativeHarnessBackupStalePending>[0]);
    expect(vi.mocked(logger.warn).mock.calls.at(-1)?.[0]).toEqual({ scopeDigest: identity.scopeDigest,
      pendingRoot: "/state/.pending-id", ageMs: 8_000_000, hasCurrent: false, reason: "stale_pending_backup",
      operatorAction: "no_current_backup_operator_recovery_required" });
  });
});
