import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { isRecoveryRun } from "./continuation-cause.js";
import {
  readThinkingOnlyCapStop,
  THINKING_CAP_STOP_AGAIN_NOTE,
  THINKING_CAP_STOP_NOTE,
  type CompletedFinalAgentMessageCandidate,
} from "./heartbeat-run-summary.js";

/**
 * The run events that decide how a run's last turn ended and whether it
 * streamed answer text: turn terminals and agent-message items. The same
 * selection the cut-answer readers use (dl-n5-cont).
 */
export function readRunAnswerEvents(tx: Pick<Db, "select">, companyId: string, runId: string) {
  return tx.select({ seq: heartbeatRunEvents.seq, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId), or(
      inArray(heartbeatRunEvents.eventType, ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]),
      and(inArray(heartbeatRunEvents.eventType, ["item.delta", "item.completed"]),
        sql`${heartbeatRunEvents.payload} #>> '{prpEvent,payload,kind}' = 'agentMessage'`))))
    .orderBy(heartbeatRunEvents.seq);
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * dl-n5-cont2 item 3: a run whose last turn stopped at the output cap having
 * streamed no answer text (the model used its whole output budget thinking).
 *
 * `repeated` is the COST GUARD: the run is the ONE automatic continuation of
 * an ask whose previous run also stopped that way. Then nothing continues
 * automatically again; the person gets one note with the choice to Retry. A
 * person's Retry (not a recovery run) starts a new ask with its own one
 * automatic continuation.
 */
export async function readThinkingCapStop(tx: Pick<Db, "select">, input: { companyId: string; runId: string }): Promise<{
  seq: number;
  sourceEventId: string | null;
  repeated: boolean;
} | null> {
  const stop = readThinkingOnlyCapStop(await readRunAnswerEvents(tx, input.companyId, input.runId));
  if (!stop) return null;
  const [run] = await tx.select({ retryOfRunId: heartbeatRuns.retryOfRunId, scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1);
  const context = object(run?.contextSnapshot);
  const parentRunId = run?.retryOfRunId
    ?? (typeof context.previousRunId === "string" && context.previousRunId ? context.previousRunId : null);
  const repeated = Boolean(run && parentRunId && parentRunId !== input.runId && isRecoveryRun(run)
    && readThinkingOnlyCapStop(await readRunAnswerEvents(tx, input.companyId, parentRunId)));
  return { ...stop, repeated };
}

/** The run's reply for a thinking-only cap stop: ONE true note (with Retry when the continuation stopped too). */
export function thinkingCapStopCandidate(stop: { seq: number; sourceEventId: string | null; repeated: boolean }):
  CompletedFinalAgentMessageCandidate & { reasonCode: string } {
  return {
    seq: stop.seq,
    text: stop.repeated ? THINKING_CAP_STOP_AGAIN_NOTE : THINKING_CAP_STOP_NOTE,
    sourceEventId: stop.sourceEventId,
    channel: "final",
    reasonCode: stop.repeated ? "thinking_only_output_cap_stop_repeated" : "thinking_only_output_cap_stop",
  };
}
