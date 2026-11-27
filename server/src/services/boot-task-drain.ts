import { companies, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { startTaskDrain } from "./task-admission.js";

/** Run before app construction can register dispatchers or accept requests. */
export async function startBootTaskDrain(db: Db): Promise<void> {
  const drain = startTaskDrain();
  const publications: ActivityPublication[] = [];
  const companyRows = await db.select({ id: companies.id }).from(companies);
  await db.transaction(async tx => {
    for (const { id: companyId } of companyRows) {
      await logActivity(tx as unknown as Db, {
        companyId, actorType: "system", actorId: "system",
        action: "instance.task_drain.started", entityType: "instance_settings", entityId: "default",
        details: { startedAt: drain.startedAt, expiresAt: drain.expiresAt },
      }, publications);
    }
  });
  // A failed audit refuses startup with admission still held. A publication
  // failure cannot undo the already-committed audit or release the drain.
  for (const publication of publications) {
    try { publishActivity(publication); }
    catch (err) { logger.error({ err }, "failed to publish boot task drain activity"); }
  }
  logger.info("PAPERCLIP_START_TASK_DRAINED: task starts held with no expiry; wakes remain queued");
}
