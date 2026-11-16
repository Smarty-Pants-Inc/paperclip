import { logger } from "../middleware/logger.js";

export async function diagnosticVerifyDelay(boxId: string): Promise<void> {
  const raw = process.env.PAPERCLIP_DIAG_VERIFY_DELAY_MS;
  let ms = 0;
  if (raw !== undefined && !/^\d+$/.test(raw)) logger.warn("[paperclip] invalid PAPERCLIP_DIAG_VERIFY_DELAY_MS; using 0 ms");
  else if (raw !== undefined) ms = Math.min(300_000, Number(raw));
  if (ms <= 0) return;
  logger.info(`[paperclip] diag verify delay ${ms} ms on box ${boxId}`);
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}
