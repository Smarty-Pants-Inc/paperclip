import type { LifecycleRuntimeFence } from "../runtime-types.js";

/** The four PR actions admitted by the automatic review policy. Comments keep
 * their existing created-only recovery contract. */
export function githubRecoveryEventIsEligible(event: string, action: string | null): boolean {
  return event === "pull_request"
    ? action !== null && ["opened", "synchronize", "reopened", "ready_for_review"].includes(action)
    : ["issue_comment", "pull_request_review_comment"].includes(event) && action === "created";
}

export const GITHUB_RECOVERY_STATE_KEY = "paperclip:github-webhook-recovery:v1";
export const GITHUB_RECOVERY_INTERVAL_MS = 60_000;
export const GITHUB_RECOVERY_WINDOW_MS = 60 * 60_000;
export const GITHUB_RECOVERY_SCAN_LEASE_MS = 5 * 60_000;
export type GitHubRecoveryWindow = LifecycleRuntimeFence & {
  appId: string;
  webhookUrl: string;
  floor: string;
  nextScanAt: string;
};

export function githubRecoveryWindow(value: unknown): GitHubRecoveryWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as GitHubRecoveryWindow;
  return Number.isSafeInteger(item.generation) &&
    item.generation >= 0 &&
    typeof item.credentialFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(item.credentialFingerprint) &&
    typeof item.appId === "string" &&
    /^\d+$/.test(item.appId) &&
    typeof item.webhookUrl === "string" &&
    typeof item.floor === "string" &&
    Number.isFinite(Date.parse(item.floor)) &&
    typeof item.nextScanAt === "string" &&
    Number.isFinite(Date.parse(item.nextScanAt))
    ? item
    : null;
}
