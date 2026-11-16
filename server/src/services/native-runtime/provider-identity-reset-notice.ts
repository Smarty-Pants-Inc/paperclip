import type { ProviderIdentityResetReason } from "./provider-identity-lineage.js";

/**
 * The ONE person-visible run-log line for a recorded provider-identity step
 * (#20853 PART 2). It is written only when a NEW providerIdentityResets record
 * is written (provider-identity-lineage.ts, appendProviderIdentityReset
 * onRecorded), so it keys on the provider identity actually changing, never
 * on configFreshness.reset: a restore of the same thread says nothing, and a
 * retried capture of the same step says nothing again.
 */
const REASON_TEXT: Record<ProviderIdentityResetReason, string> = {
  config_changed: "its settings changed",
  resume_failed_on_new_box: "its earlier session could not be resumed on a new machine",
  forced_fresh_session: "a fresh session was requested",
};

/**
 * carriedHistory: true when the fresh-session handoff was delivered to the run
 * that started the thread, false when that run asked and got none, null when
 * this process does not know (for example the step is recorded after a
 * restart): then the line makes no claim about the earlier messages.
 */
export function providerIdentityResetLine(record: { reason: ProviderIdentityResetReason },
  options: { carriedHistory: boolean | null }): string {
  const head = `[paperclip] The agent restarted its session because ${REASON_TEXT[record.reason]}.`;
  if (options.carriedHistory === null) return `${head}\n`;
  return `${head} `
    + (options.carriedHistory
      ? "This chat's earlier messages were given to the new session as history.\n"
      : "The new session does not have this chat's earlier context.\n");
}
