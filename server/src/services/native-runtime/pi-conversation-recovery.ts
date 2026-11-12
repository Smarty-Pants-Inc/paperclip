import { logger } from "../../middleware/logger.js";
import type { NativeSessionBackend } from "../../vendor/paperclip-runner/index.js";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";
import type { issueService } from "../issues.js";

export type PiSessionFileFailureCode = "pi_session_file_missing" | "pi_session_file_invalid";
/** Typed locally; exact named codes also survive the authenticated Runner RPC
 * envelope, which serializes an Error rather than preserving its prototype. */
export function piSessionFileFailureCode(error: unknown, depth = 0): PiSessionFileFailureCode | null {
  if (depth > 5 || error == null) return null;
  const value = typeof error === "object" ? error as Record<string, unknown> : {};
  const text = [value.code, value.reason, value.message, typeof error === "string" ? error : null].filter(v => typeof v === "string").join(" ");
  if (/\bpi_session_file_invalid\b/.test(text)) return "pi_session_file_invalid";
  if (/\bpi_session_file_missing\b/.test(text)) return "pi_session_file_missing";
  return piSessionFileFailureCode(value.cause, depth + 1);
}
export class PiSessionFileRecoveryError extends Error {
  constructor(readonly code: PiSessionFileFailureCode) {
    super(`${code}: ${code === "pi_session_file_missing" ? "the saved Pi conversation file is missing" : "the saved Pi conversation failed integrity or ownership validation"}`);
    this.name = "PiSessionFileRecoveryError";
  }
}
type Recovery = Awaited<ReturnType<NonNullable<NativeSessionBackend["recoverSession"]>>>;

/** Policy at the server's provider-recovery seam. No filesystem guesses here:
 * the Pi driver (including on a sandbox) supplies the typed file verdict. */
export function createPiConversationRecoveryPolicy(input: {
  companyId: string; agentId: string; issueId: string; runId: string; sessionId: string;
  onEvent?: (event: AdapterRuntimeEvent) => Promise<void>;
  issuesSvc: Pick<ReturnType<typeof issueService>, "addComment">;
}) {
  let missingFile = false;
  let noticePosted = false;
  const alarms = new Set<PiSessionFileFailureCode>();
  const alarm = async (code: PiSessionFileFailureCode) => {
    if (alarms.has(code)) return;
    // Existing persisted run-event channel; error level is the owner's alarm,
    // even when missing-file recovery later completes the run successfully.
    logger.error({ code, companyId: input.companyId, agentId: input.agentId, issueId: input.issueId,
      runId: input.runId, nativeSessionId: input.sessionId, ownerAlarm: true }, new PiSessionFileRecoveryError(code).message);
    await input.onEvent?.({ eventType: "native.pi_conversation_recovery_failed", stream: "system", level: "error",
      message: new PiSessionFileRecoveryError(code).message,
      payload: { code, companyId: input.companyId, agentId: input.agentId, issueId: input.issueId,
        runId: input.runId, nativeSessionId: input.sessionId, ownerAlarm: true,
        action: code === "pi_session_file_missing" ? "start_fresh_with_notice" : "refused_preserve_saved_state" } });
    alarms.add(code);
  };
  return {
    async open<T>(operation: () => Promise<T>): Promise<T> {
      try { return await operation(); }
      catch (error) {
        const code = piSessionFileFailureCode(error);
        if (!code) throw error;
        await alarm(code);
        throw new PiSessionFileRecoveryError(code);
      }
    },
    async recover(operation: () => Promise<Recovery>): Promise<Recovery> {
      missingFile = false;
      let result: Recovery;
      try { result = await operation(); }
      catch (error) {
        const code = piSessionFileFailureCode(error);
        if (!code) throw error;
        await alarm(code);
        if (code === "pi_session_file_invalid") throw new PiSessionFileRecoveryError(code);
        missingFile = true;
        return { recovered: false, reason: new PiSessionFileRecoveryError(code).message };
      }
      const code = !result.recovered ? piSessionFileFailureCode(result.reason) : null;
      if (code) {
        await alarm(code);
        if (code === "pi_session_file_invalid") throw new PiSessionFileRecoveryError(code);
        missingFile = true;
        // Do not inherit a generic incompatible/attach-refused classification:
        // the org explicitly permits a noticed fresh start for missing files.
        return { recovered: false, reason: new PiSessionFileRecoveryError(code).message };
      }
      return result;
    },
    async beforeReplacement(): Promise<void> {
      // Every other recovery refusal keeps the old transcript, including a
      // transport outage. Only an actual missing-file verdict may replace it.
      if (!missingFile) throw new Error("pi_conversation_replacement_refused: only a verified missing file permits replacement");
      if (noticePosted) throw new Error("pi_conversation_replacement_refused: fresh-start authorization already consumed");
      await input.issuesSvc.addComment(input.issueId,
        "My earlier conversation could not be restored: the saved Pi conversation file is missing. Starting a new one.",
        { runId: input.runId }, { authorType: "system", presentation: { kind: "system_notice", tone: "warning",
          title: "Earlier conversation unavailable", density: "compact", detailsDefaultOpen: false } });
      noticePosted = true;
      missingFile = false; // the one fresh-start authorization is consumed
    },
  };
}
