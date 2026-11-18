import { MAX_SANDBOX_SYNC_TIMEOUT_MS } from "@paperclipai/adapter-utils/sandbox-managed-runtime";

export function providerPackTransferTimeoutMs(archiveBytes: number): number {
  return Math.min(
    MAX_SANDBOX_SYNC_TIMEOUT_MS,
    Math.max(300_000, 60_000 + Math.ceil(archiveBytes / (1024 * 1024)) * 1_000),
  );
}
