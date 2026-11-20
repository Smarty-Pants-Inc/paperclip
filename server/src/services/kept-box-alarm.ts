import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** The kept-box alarm: a box that holds a cut turn's only copy of unexported
 * work and could not be stopped (no provider stop). `kept` is the first alarm
 * (box kept, exported at its bound); `export_failed` is the louder second one
 * (the bound's export failed, the box stays kept).
 *
 * A kept box is an OPERATOR matter, not the person's: nothing is written to
 * the task, its chat or its recovery card. The server has no operator
 * page/alert route today (no watchdog page, operator alert or ops notification
 * path exists in server/src), so the alarm is a structured log line with a
 * stable event name that the fleet's capacity-lead page reads. */
export type KeptBoxAlarmLevel = "kept" | "export_failed";
export const KEPT_BOX_ALARM_EVENT = "kept_box_still_running";
export const KEPT_BOX_EXPORT_FAILED_EVENT = "kept_box_export_failed";

/** Raise the alarm once per box and level. The once-only mark lives on the
 * lease row (metadata.keptBoxAlarm.<level>), set atomically before the log, so
 * a repeated keep, a retry or another process never repeats it. */
export async function raiseKeptBoxAlarm(db: Db, input: {
  companyId: string; leaseId: string; providerLeaseId: string | null; runIds: string[];
  keptUntil: Date; level: KeptBoxAlarmLevel;
}): Promise<boolean> {
  const at = new Date().toISOString();
  const [marked] = await db.update(environmentLeases).set({
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || jsonb_build_object('keptBoxAlarm',
      coalesce(${environmentLeases.metadata}->'keptBoxAlarm', '{}'::jsonb) || ${JSON.stringify({ [input.level]: at, providerLeaseId: input.providerLeaseId })}::jsonb)`,
  }).where(and(eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
    sql`not (coalesce(${environmentLeases.metadata}->'keptBoxAlarm', '{}'::jsonb) ? ${input.level}::text
      and (${environmentLeases.metadata}->'keptBoxAlarm'->>'providerLeaseId') is not distinct from ${input.providerLeaseId}::text)`))
    .returning({ id: environmentLeases.id });
  if (!marked) return false;
  const fields = { alarm: input.level === "kept" ? KEPT_BOX_ALARM_EVENT : KEPT_BOX_EXPORT_FAILED_EVENT,
    companyId: input.companyId, leaseId: input.leaseId, providerLeaseId: input.providerLeaseId,
    runIds: input.runIds, expiresAt: input.keptUntil.toISOString() };
  if (input.level === "kept") {
    logger.error(fields, "ALARM: box still running and kept (not stopped, not released): it holds unexported prepared work and the provider offered no stop");
  } else {
    logger.fatal(fields, "ALARM (second): the kept box's unexported work could not be exported at its bound; the box stays kept, not released");
  }
  return true;
}
