/**
 * dl famlong-u1: a native turn that the provider cut mid-stream. The status
 * arbiter's `schedule_retry` carries this cause instead of the generic
 * `native_run_failed`, and the committer hands the run to ONE recovery
 * successor (a scheduled retry of the failed run) instead of inserting the
 * generic `native_status_decision` wake that resumed the same Pi session at
 * the same thinking level.
 */
export const NATIVE_MID_STREAM_CUT_CODE = "native_mid_stream_cut";
export const NATIVE_MID_STREAM_CUT_MESSAGE =
  "The model's reply was cut off before it finished. Paperclip continues it once.";
/** A provider refusal ends here: nothing continues or re-sends it from this path. */
export const NATIVE_PROVIDER_REFUSAL_TERMINAL_REASON = "native_provider_refusal_terminal";

/**
 * - `output_cap_no_text`: the turn stopped at the output cap (`pi_output_truncated`)
 *   having streamed no answer text. Recovery runs at 'high': a new process on
 *   the SAME conversation; the cut turn is not sent.
 * - `output_cap`: the cap cut an answer that had started. Recovery resumes the session.
 * - `provider_error`: the provider failed mid-turn (an EOF, any provider error).
 *   Recovery resumes the session.
 * - `provider_refusal`: the provider refused the turn. Terminal: no successor.
 */
export type NativeMidStreamCut = "output_cap_no_text" | "output_cap" | "provider_error" | "provider_refusal";
