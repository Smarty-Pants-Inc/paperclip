import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** One active-operation readiness bound, not an idle poller. Expiry NEVER releases input. */
export const STEERING_INGESTION_WAIT_MS = 1_000;
export const STEERING_INGESTION_KEY = "nativeSteeringIngestion";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function steeringIngestionPending(result: unknown): boolean {
  const ingestion = object(object(result)[STEERING_INGESTION_KEY]);
  return ingestion.state === "open";
}

/** Called BEFORE the first provider append (and before a following turn starts).
 * The durable source fence also protects a release on another server replica.
 */
export async function openSteeringIngestion(db: Db, input: { companyId: string; runId: string; sourceInstanceId: string }) {
  await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
    ${JSON.stringify({ [STEERING_INGESTION_KEY]: { state: "open", sourceInstanceId: input.sourceInstanceId } })}::jsonb` })
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
}

/** The native consumer is ordered. A terminal receipt closes the fence ONLY
 * when the transport's durable contiguous cursor reaches that terminal sequence.
 * A stopped consumer calls this only AFTER it is stopped and joined, including
 * Stop with a gapped terminal; retained read/text facts then decide, not guessed
 * lost output. This proof is independent of the source cursor.
 */
export async function settleSteeringIngestion(db: Db, input: {
  companyId: string; runId: string; sourceInstanceId: string;
  terminalSourceSeq?: number; highestContiguousSourceSeq?: number; consumerStopped?: true;
}) {
  const release = await db.transaction(async tx => {
    const [run] = await tx.select({ result: heartbeatRuns.resultJson, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    if (!run) return false;
    const result = object(run.result), prior = object(result[STEERING_INGESTION_KEY]);
    if (prior.sourceInstanceId !== input.sourceInstanceId) return false;
    const terminal = input.terminalSourceSeq ?? prior.terminalSourceSeq;
    const contiguous = Math.max(Number(prior.highestContiguousSourceSeq ?? 0), input.highestContiguousSourceSeq ?? 0);
    const terminalIngested = typeof terminal === "number" && contiguous >= terminal;
    // Stop can retain a terminal after cancellation discarded part of its source
    // suffix. Once the ordered consumer is stopped/joined, those gaps cannot
    // deliver more read/text facts. Its closure proof wins over a cursor that
    // can never become contiguous; natural completion still requires that cursor.
    const settled = terminalIngested || input.consumerStopped === true;
    await tx.update(heartbeatRuns).set({ resultJson: { ...result, [STEERING_INGESTION_KEY]: {
      ...prior, terminalSourceSeq: terminal ?? null, highestContiguousSourceSeq: contiguous,
      state: terminalIngested ? "terminal_ingested" : settled ? "consumer_stopped" : "open",
    } } }).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    return settled && result.steeringIngestionReleaseHeld === true && ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status);
  });
  if (release) {
    // Resume the SAME release owner, not a second carry/late-read guard. This
    // runs after the ingestion receipt commits and outside every run/issue lock.
    const { heartbeatService } = await import("../heartbeat.js");
    await heartbeatService(db).releaseIssueExecutionAndPromote({ id: input.runId, companyId: input.companyId });
  }
}

/** Only the existing recovery owner calls this AFTER proving controller/provider
 * absence and recording the run's true terminal line in the same transaction. */
export function closeSteeringIngestionAfterRecovery(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!steeringIngestionPending(result)) return result;
  return { ...result, [STEERING_INGESTION_KEY]: { ...object(result?.[STEERING_INGESTION_KEY]), state: "recovery_closed" } };
}

export async function waitForSteeringIngestion(db: Db, input: { companyId: string; runId: string }): Promise<void> {
  const deadline = Date.now() + STEERING_INGESTION_WAIT_MS;
  for (;;) {
    const [run] = await db.select({ result: heartbeatRuns.resultJson, context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    if (!Array.isArray(run?.context?.steeredCommentIds) || !run.context.steeredCommentIds.length || !steeringIngestionPending(run.result)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return; // The transaction's ONE guard retains custody.
    // Bounded cross-replica readiness probe for this concrete outstanding stream.
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
}
