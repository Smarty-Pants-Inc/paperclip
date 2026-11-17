import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { cutAnswerContinuationInstruction, readThinkingOnlyCapStop } from "../heartbeat-run-summary.js";
import { readRunAnswerEvents } from "../thinking-cap-stop.js";

export { NATIVE_MID_STREAM_CUT_CODE, NATIVE_MID_STREAM_CUT_MESSAGE, NATIVE_PROVIDER_REFUSAL_TERMINAL_REASON,
  type NativeMidStreamCut } from "./native-mid-stream-cut-cause.js";
import { NATIVE_MID_STREAM_CUT_CODE, type NativeMidStreamCut } from "./native-mid-stream-cut-cause.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const REFUSAL_PATTERN = /reasoning_extraction|terms of service|\bprovider refused (?:this |the )?request\b/iu;

/** The provider's own refusal: its stop category, or its Terms-of-Service text. */
export function isNativeProviderRefusal(error: unknown): boolean {
  const detail = record(error);
  if (detail.stopReason === "refusal" || detail.stopCategory === "reasoning_extraction"
    || detail.category === "reasoning_extraction") return true;
  try { return REFUSAL_PATTERN.test(JSON.stringify(detail)); } catch { return false; }
}

/** How the run's LAST turn was cut, from its turn terminals and answer items. */
export function classifyNativeMidStreamCut(rows: readonly { seq: number; payload: unknown }[]): NativeMidStreamCut | null {
  let last: Record<string, unknown> | null = null;
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const event = record(record(row.payload).prpEvent);
    if (typeof event.eventType === "string" && /^turn\.(completed|failed|cancelled|interrupted)$/u.test(event.eventType)) last = event;
  }
  if (!last || last.eventType !== "turn.failed") return null;
  const error = record(record(last.payload).error);
  if (error.code === "pi_output_truncated") return readThinkingOnlyCapStop(rows) ? "output_cap_no_text" : "output_cap";
  if (error.code === "pi_provider_error" || error.code === "pi_rpc_transport_failed") {
    return isNativeProviderRefusal(error) ? "provider_refusal" : "provider_error";
  }
  return null;
}

export async function readNativeMidStreamCut(db: Pick<Db, "select">, input: { companyId: string; runId: string }) {
  return classifyNativeMidStreamCut(await readRunAnswerEvents(db, input.companyId, input.runId));
}

/** A cap stop with no answer text is the one cut that must not resume its session. */
export function nativeMidStreamCutStartsFresh(cut: NativeMidStreamCut | null): boolean {
  return cut === "output_cap_no_text";
}

/** The run is the ONE recovery successor of a mid-stream cut. */
export function isNativeMidStreamCutRecoveryRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "retryOfRunId" | "scheduledRetryReason">,
): boolean {
  return Boolean(run.retryOfRunId) && run.scheduledRetryReason === NATIVE_MID_STREAM_CUT_CODE;
}

/** Failed-turn retries that follow their predecessor's task ownership the same way. */
export function isNativeFailedTurnRetryReason(reason: string | null | undefined): boolean {
  return reason === "native_provider_overloaded" || reason === NATIVE_MID_STREAM_CUT_CODE;
}

/**
 * The recovery successor's opening, read when the successor STARTS (the cut
 * run has posted its reply by then, so the opening says truthfully what the
 * person was shown): cont3's opening after a thinking-only cap stop (the ask,
 * verbatim, for the fresh session), cont/cont4's "continue from exactly this
 * point" after a cut answer. Nothing when the cut left no answer text.
 */
export async function applyNativeMidStreamCutOpening(db: Pick<Db, "select">, input: {
  run: Pick<typeof heartbeatRuns.$inferSelect, "companyId" | "retryOfRunId" | "scheduledRetryReason">;
  issueId: string | null;
  context: Record<string, unknown>;
}): Promise<void> {
  const { run, context } = input;
  if (!isNativeMidStreamCutRecoveryRun(run) || !run.retryOfRunId) return;
  const { readSourceRunCutAnswer, thinkingCapStopRecoveryOpening } = await import("../fresh-continuation-fallback.js");
  const [source] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.retryOfRunId))).limit(1);
  if (!source) return;
  const [issue] = input.issueId ? await db.select({ id: issues.id, title: issues.title, description: issues.description })
    .from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, input.issueId))).limit(1) : [];
  const cut = await readSourceRunCutAnswer(db, source, issue ?? null);
  context.livenessContinuationSourceRunId = source.id;
  context.livenessContinuationReason = NATIVE_MID_STREAM_CUT_CODE;
  if (!cut) return;
  context.livenessContinuationInstruction = "thinkingOnlyCapStop" in cut
    ? thinkingCapStopRecoveryOpening(cut.ask) : cutAnswerContinuationInstruction(cut);
}
