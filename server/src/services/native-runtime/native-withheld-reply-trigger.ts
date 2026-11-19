/**
 * WHEN the accepted reply of a native run is published.
 *
 *  - "acceptance" (the default, Ruling P): the reply is published when the
 *    result is accepted, while the files are still being copied back; the
 *    committed path then finds it already presented and posts nothing more.
 *    Publishing ONLY posts the comment and records it as presented: the run's
 *    status, the task's status, issues.executionRunId and the execution lock
 *    are left to the commit, so a later message stays parked behind this run
 *    until its files are committed.
 *  - "terminal": the committed reply path publishes after the copy-back;
 *    a run that ends without a committed reply publishes at its terminal write.
 *
 * The one switch. Both settings share publishWithheldAcceptedReply
 * (native-withheld-reply.ts), which is idempotent by (run, resultId, canonicalSha256).
 */
export type WithheldReplyTrigger = "terminal" | "acceptance";
export const WITHHELD_REPLY_TRIGGER = "acceptance" as WithheldReplyTrigger;
/** Under "acceptance" the file line starts `saving`; past this it is never shown as "Saving…". */
export const WITHHELD_REPLY_SAVING_DEADLINE_MS = 10 * 60_000;

export const NATIVE_WITHHELD_REPLY_SCHEMA = "paperclip.native_withheld_reply.v1";
/** The durable outbox entry of publishWithheldAcceptedReply. It is written by
 * the SAME statement that accepts the result ("acceptance") or ends the
 * accepted run without a committed reply ("terminal"), so a crash cannot
 * separate the two; the reply-presentation worker discovers it and publishes once. */
export function pendingNativeWithheldReply(resultId: string, failureCode: string | null, trigger: WithheldReplyTrigger = "terminal") {
  return { nativeWithheldReply: { schema: NATIVE_WITHHELD_REPLY_SCHEMA, state: "pending", resultId, failureCode, trigger } };
}
