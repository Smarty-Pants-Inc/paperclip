import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { cutAnswerContinuationInstruction, readFailedTurnStreamedAnswer, readThinkingOnlyCapStop,
  THINKING_CAP_STOP_AGAIN_NOTE, type CompletedFinalAgentMessageCandidate } from "../heartbeat-run-summary.js";
import { readRunAnswerEvents } from "../thinking-cap-stop.js";
import { isAiAuthenticationFailure } from "../ai-auth-failure.js";
import { readProviderFailure } from "@paperclipai/shared";

export { NATIVE_MID_STREAM_CUT_CODE, NATIVE_MID_STREAM_CUT_MESSAGE,
  type NativeMidStreamCut } from "./native-mid-stream-cut-cause.js";
import { NATIVE_MID_STREAM_CUT_CODE, type NativeMidStreamCut } from "./native-mid-stream-cut-cause.js";
import { isPiPolicyRefusal, PROVIDER_POLICY_REFUSAL_CODE, PROVIDER_POLICY_REFUSAL_MESSAGE } from "./native-provider-failure.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// compose (unit 1 + dl-refusal2 round 6): Terms-of-Service text is a refusal only
// when it is about THE REQUEST. An account or key rejection that merely names
// the Terms of Service ("your account has not accepted the Terms of Service")
// is an ordinary provider error and keeps its retry.
const REFUSAL_PATTERN = /reasoning_extraction|\b(?:this|your|the) request\b[^\n]*\bterms of service\b|\bprovider refused (?:this |the )?request\b/iu;

/**
 * The provider's own refusal. The refusal path's classifier decides first
 * (anything it calls a refusal is never a cut that gets a successor or a
 * dropped-connection note); the cut lane adds only the stop category and
 * Terms-of-Service evidence it sees on a cut turn. Either way the result is
 * the refusal path's: `provider_policy_refusal` and its one neutral note.
 */
export function isNativeProviderRefusal(error: unknown): boolean {
  const detail = record(error);
  if (isPiPolicyRefusal(detail)) return true;
  if (detail.stopReason === "refusal" || detail.stopCategory === "reasoning_extraction"
    || detail.category === "reasoning_extraction") return true;
  try { return REFUSAL_PATTERN.test(JSON.stringify(detail)); } catch { return false; }
}

/** Account rejections keep their existing failure/recovery owner, never the cut lane. */
export function isNativeProviderAccountFailure(error: unknown): boolean {
  const detail = record(error);
  const category = readProviderFailure(detail.providerFailure)?.category;
  if (category === "quota_exhausted" || category === "authentication" || category === "permission") return true;
  if ([detail.code, detail.providerCode].some(code =>
    isAiAuthenticationFailure(typeof code === "string" ? code : null))) return true;
  const status = Number(detail.httpStatus ?? detail.statusCode ?? detail.status);
  if (status === 401 || status === 402 || status === 403) return true;
  // Pi's untyped provider terminals carry only code + message, not ProviderFailure.
  // Typed quota/auth categories above reuse the existing provider classifier.
  const message = typeof detail.message === "string" ? detail.message : "";
  return /insufficient[_ ]quota|\bbilling\b|\bquota (?:limit )?(?:exceeded|exhausted)|\b(?:credit balance|account on hold)\b|\b(?:401|402|403)\b|\b(?:authentication[_ ](?:error|failed|required)|unauthorized|forbidden|invalid[_ ]api[_ ]key)\b/iu.test(message);
}

/** An account rejection is a normal provider failure, not an exhausted-cut reply. */
export function readNativeProviderAccountFailureCandidate(
  rows: readonly { seq: number; payload: unknown }[],
): CompletedFinalAgentMessageCandidate | null {
  const terminal = [...rows].sort((a, b) => b.seq - a.seq).find(row =>
    /^turn\.(completed|failed|cancelled|interrupted)$/u.test(String(record(record(row.payload).prpEvent).eventType)));
  if (!terminal) return null;
  const event = record(record(terminal.payload).prpEvent);
  const error = record(record(event.payload).error);
  if (event.eventType !== "turn.failed" || !["pi_provider_error", "pi_rpc_transport_failed"].includes(String(error.code))
    || !isNativeProviderAccountFailure(error)) return null;
  const message = typeof error.message === "string" ? error.message : readProviderFailure(error.providerFailure)?.message;
  if (!message?.trim()) return null;
  const prefix = readFailedTurnStreamedAnswer(rows)?.text;
  return { seq: terminal.seq, sourceEventId: typeof event.sourceEventId === "string" ? event.sourceEventId : null,
    channel: "final", text: prefix ? `${prefix}${prefix.endsWith("\n") ? "" : "\n"}\n— ${message}` : message };
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
    if (isNativeProviderAccountFailure(error)) return null;
    return isNativeProviderRefusal(error) ? "provider_refusal" : "provider_error";
  }
  return null;
}

export async function readNativeMidStreamCut(db: Pick<Db, "select">, input: { companyId: string; runId: string }) {
  return classifyNativeMidStreamCut(await readRunAnswerEvents(db, input.companyId, input.runId));
}

const ORDINARY_STATUS_REJECTION = /^\s*(?:429|529)\b/u;

/**
 * compose (unit 1 + dl-refusal2): the provider answered the request with an
 * ordinary capacity status (HTTP 429 rate limit, 529 overloaded) and no answer
 * text was streamed. Nothing was cut mid-stream: the request was turned away.
 */
export function isOrdinaryProviderStatusRejection(rows: readonly { seq: number; payload: unknown }[]): boolean {
  let last: Record<string, unknown> | null = null;
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const event = record(record(row.payload).prpEvent);
    if (typeof event.eventType === "string" && /^turn\.(completed|failed|cancelled|interrupted)$/u.test(event.eventType)) last = event;
  }
  if (!last || last.eventType !== "turn.failed") return false;
  const error = record(record(last.payload).error);
  return error.code === "pi_provider_error" && typeof error.message === "string"
    && ORDINARY_STATUS_REJECTION.test(error.message) && !isNativeProviderRefusal(error)
    && readFailedTurnStreamedAnswer(rows) === null;
}

/**
 * The cut that takes the recovery lane. An ordinary 429/529 status rejection
 * is not one: it keeps the generic failed-turn retry (`native_run_failed`,
 * the refusal family's judged control), which the arbiter bounds to one
 * continuation exactly as before. `classifyNativeMidStreamCut` is unchanged,
 * so a cut successor that then meets a 429/529 still gets its own true
 * exhausted note, never the generic resend line.
 */
export function classifyNativeMidStreamCutRecovery(rows: readonly { seq: number; payload: unknown }[]): NativeMidStreamCut | null {
  return isOrdinaryProviderStatusRejection(rows) ? null : classifyNativeMidStreamCut(rows);
}

export async function readNativeMidStreamCutRecovery(db: Pick<Db, "select">, input: { companyId: string; runId: string }) {
  return classifyNativeMidStreamCutRecovery(await readRunAnswerEvents(db, input.companyId, input.runId));
}

/** A cap stop with no text needs a new process on the SAME conversation; the cut turn is not sent. */
export function nativeMidStreamCutStartsFresh(cut: NativeMidStreamCut | null): boolean {
  return cut === "output_cap_no_text";
}

/** The run is the ONE recovery successor of a mid-stream cut. */
export function isNativeMidStreamCutRecoveryRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "retryOfRunId" | "scheduledRetryReason">,
): boolean {
  return Boolean(run.retryOfRunId) && run.scheduledRetryReason === NATIVE_MID_STREAM_CUT_CODE;
}

export const NATIVE_MID_STREAM_CUT_CONNECTION_EXHAUSTED_NOTE =
  "The connection to the model dropped before the answer finished. Press Retry to try once more.";
export const NATIVE_MID_STREAM_CUT_PROVIDER_EXHAUSTED_NOTE =
  "The model provider returned an error before the answer finished. Press Retry to try once more.";

function isNativeProviderConnectionFailure(error: Record<string, unknown>): boolean {
  return error.code === "pi_rpc_transport_failed" || (typeof error.message === "string"
    && /\bEOF\b|\bECONNRESET\b|\bEPIPE\b|\b(?:stream|connection) (?:reset|closed|dropped|disconnected)|\bsocket hang up\b|\bfetch failed\b/iu.test(error.message));
}

/**
 * The cut lane's ONE automatic successor also failed: publish the last cut's
 * true note, not a promise to continue. Keep any streamed answer whole, but
 * replace its continuing note. A refusal is owned by the refusal path: its
 * note is that path's one neutral note under that path's code, never a
 * dropped connection. A person's Retry has no cut-lane marking.
 * Publication uses the normal attributed completion reply, so the unanswered
 * sweep sees this message's notice duty discharged through its run lineage.
 */
export async function readExhaustedNativeMidStreamCutCandidate(
  db: Pick<Db, "select">, input: { companyId: string; runId: string },
  rows: readonly { seq: number; payload: unknown }[],
): Promise<(CompletedFinalAgentMessageCandidate & { reasonCode: string }) | null> {
  const cut = classifyNativeMidStreamCut(rows);
  if (!cut) return null;
  const [run] = await db.select({ retryOfRunId: heartbeatRuns.retryOfRunId, scheduledRetryReason: heartbeatRuns.scheduledRetryReason })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1);
  if (!run || !isNativeMidStreamCutRecoveryRun(run)) return null;
  const terminal = [...rows].sort((a, b) => b.seq - a.seq).find(row =>
    record(record(row.payload).prpEvent).eventType === "turn.failed")!;
  const event = record(record(terminal.payload).prpEvent);
  const prefix = readFailedTurnStreamedAnswer(rows)?.text;
  const note = cut === "provider_refusal" ? PROVIDER_POLICY_REFUSAL_MESSAGE
    : cut !== "provider_error" ? THINKING_CAP_STOP_AGAIN_NOTE
    : isNativeProviderConnectionFailure(record(record(event.payload).error))
      ? NATIVE_MID_STREAM_CUT_CONNECTION_EXHAUSTED_NOTE : NATIVE_MID_STREAM_CUT_PROVIDER_EXHAUSTED_NOTE;
  return {
    seq: terminal.seq,
    sourceEventId: typeof event.sourceEventId === "string" ? event.sourceEventId : null,
    channel: "final",
    text: prefix ? `${prefix}${prefix.endsWith("\n") ? "" : "\n"}\n— ${note}` : note,
    reasonCode: cut === "provider_refusal" ? PROVIDER_POLICY_REFUSAL_CODE : `native_mid_stream_cut_exhausted_${cut}`,
  };
}

/** Failed-turn retries that follow their predecessor's task ownership the same way. */
export function isNativeFailedTurnRetryReason(reason: string | null | undefined): boolean {
  return reason === "native_provider_overloaded" || reason === NATIVE_MID_STREAM_CUT_CODE;
}

/**
 * The recovery successor's opening, read when the successor STARTS (the cut
 * run has posted its reply by then, so the opening says truthfully what the
 * person was shown): cont3's opening after a thinking-only cap stop (the ask,
 * verbatim, for a new process on the SAME conversation; the cut turn is not
 * sent), cont/cont4's "continue from exactly this
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
