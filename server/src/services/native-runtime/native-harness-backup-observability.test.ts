import { describe, expect, it, vi } from "vitest";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
import { logger } from "../../middleware/logger.js";
import { reportNativeHarnessBackupCapture } from "./native-harness-backup-observability.js";

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
    expect(fields).toEqual({ ...identity, outcome: "failed", reason: "capture_failed", errorCode: expected });
    expect(JSON.stringify(fields)).not.toContain("sentinel");
  });

  it("never exposes a secret-derived Error constructor name", () => {
    const secretName = "ConstructorSentinel9284";
    const SecretError = ({ [secretName]: class extends Error {} })[secretName];
    reportNativeHarnessBackupCapture({ ...identity, outcome: "failed", reason: "capture_failed",
      error: new SecretError("synthetic") });
    const fields = vi.mocked(logger.warn).mock.calls.at(-1)?.[0];
    expect(fields).toEqual({ ...identity, outcome: "failed", reason: "capture_failed", errorCode: "unknown" });
    expect(JSON.stringify(fields)).not.toContain(secretName);
  });

  it("uses unknown for non-Error throws without stringifying their contents", () => {
    reportNativeHarnessBackupCapture({ ...identity, outcome: "failed", reason: "capture_failed", error: privateText });
    expect(vi.mocked(logger.warn).mock.calls.at(-1)?.[0]).toEqual({ ...identity, outcome: "failed", reason: "capture_failed", errorCode: "unknown" });
  });

  it("closes incomplete reason codes and ignores extra skipped fields", () => {
    reportNativeHarnessBackupCapture({ ...identity, outcome: "skipped", reason: "checkpoint_incomplete",
      incompleteReason: privateText, detail: privateText } as Parameters<typeof reportNativeHarnessBackupCapture>[0]);
    expect(vi.mocked(logger.warn).mock.calls.at(-1)?.[0]).toEqual({ ...identity, outcome: "skipped",
      reason: "checkpoint_incomplete", incompleteReason: "unknown" });
  });
});
