import { sandboxTransferTimeoutMs } from "@paperclipai/adapter-utils/sandbox-managed-runtime";

export function providerPackTransferTimeoutMs(archiveBytes: number): number {
  // Preserve provider packs' existing five-minute floor while sharing the
  // archive-size calculation with workspace staging and capture/restore.
  return Math.max(300_000, sandboxTransferTimeoutMs(archiveBytes));
}
