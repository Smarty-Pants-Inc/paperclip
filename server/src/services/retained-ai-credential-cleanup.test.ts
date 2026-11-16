import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
import { logger } from "../middleware/logger.js";
import { reconcileRetainedAiCleanup, retainAiCredentialCleanup } from "./retained-ai-credential-cleanup.js";

afterEach(() => vi.clearAllMocks());

it.each(["retirement_rejected", "cleanup_threw"] as const)("logs one redacted pending-cleanup warning for %s without changing the cleanup error", async (reason) => {
  const accountKey = `account-${reason}`;
  const scope = { companyId: `company-${reason}`, accountKey };
  const failure = new Error("fixture cleanup failure");
  let rejectRetirement!: (error: Error) => void;
  const retired = new Promise<void>((_resolve, reject) => { rejectRetirement = reject; });
  const cleanup = vi.fn(async () => { throw failure; });
  retainAiCredentialCleanup({ scope, cleanup, agentId: "agent-fixture", ...(reason === "retirement_rejected" ? { retired } : {}) });

  if (reason === "retirement_rejected") {
    rejectRetirement(failure);
    await vi.waitFor(() => expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce());
    expect(cleanup).not.toHaveBeenCalled();
  } else {
    await expect(reconcileRetainedAiCleanup(scope)).rejects.toMatchObject({
      status: 422,
      details: { code: "ai_credential_cleanup_pending" },
    });
    expect(cleanup).toHaveBeenCalledOnce();
  }

  expect(vi.mocked(logger.warn)).toHaveBeenCalledWith({
    companyId: scope.companyId,
    code: "AI_CREDENTIAL_CLEANUP_PENDING",
    accountKeyHash: createHash("sha256").update(accountKey).digest("hex").slice(0, 12),
    reason,
    agentId: "agent-fixture",
  }, "Selected AI credential cleanup remains pending");
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(accountKey);
});
