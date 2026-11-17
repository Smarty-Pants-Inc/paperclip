// frozen8 F-04: Boat's own classification of a failed command or files call.
//
// Sources (copies beside the F-04 brief):
// - boat-commands-table.md, 'Commands, files and processes' (lines 2-18): the
//   502 `sandbox_direct_failed` row (line 17) and the `sandbox_restoring` row
//   (line 18); the flag is in `error.details.retryable` (line 20).
// - boat-command-history.md, 'Timeouts and retries' (lines 14-18): "boat never
//   retries a command call automatically. A command is not idempotent. After a
//   timeout (`retryable: false`) or a network failure during the call, the
//   command can already run on the sandbox." (line 18)
// - boat-command-history.md, 'Command history and logs' (lines 21-101): the
//   history keeps each command's text, first 64 KiB (line 41), and is read with
//   GET /sandboxes/{id}/command-history?limit=20&mode=commands (lines 60-63).
//
// Only closed fields ever leave this module: Boat's code (one closed value or
// "other"), the retryable boolean and the documented message token. Never a body.

/** The 502 code Boat documents for a call the machine did not complete (table line 17). */
export const BOAT_DIRECT_FAILED = "sandbox_direct_failed";
/** The documented message of a command that did not run (table lines 17-18). */
export const BOAT_RESTORING = "sandbox_restoring";
/** "Retry after 1-3 seconds" (table line 18): the middle of Boat's range. */
export const BOAT_RESTORING_RESEND_MS = 2_000;
/** Our own bound on the evidence-only history read. */
export const COMMAND_HISTORY_READ_MS = 5_000;
/** The thrown outcome of a command call that possibly ran. */
export const COMMAND_POSSIBLY_RAN = "boat_command_possibly_ran";

export type BoatDirectFields = { boatCode?: string; boatRetryable?: boolean; boatMessage?: typeof BOAT_RESTORING };
/** 'ran': history holds this attempt's exact prefixed text. Otherwise 'unknown', never 'not run'. */
export type CommandEvidence = "ran" | "unknown";
/** Why the command possibly ran: a closed reason, never provider text. */
export type PossiblyRanReason = "network_error" | "timeout" | "aborted" | "http_409" | "http_5xx" | "unreadable_response";
/** How a command or files call that Boat answered with a 5xx is handled. */
export type DirectFailureClass = "did_not_run" | "possibly_ran" | "other";

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

/** Boat's closed 502 fields from a parsed body: error.code (or code), error.details.retryable, the restoring token. */
export function boatDirectFields(body: unknown): BoatDirectFields {
  const error = field(body, "error");
  const code = field(error, "code") ?? field(body, "code");
  const retryable = field(field(error, "details"), "retryable");
  const message = field(error, "message") ?? field(body, "message");
  return {
    ...(typeof code === "string" ? { boatCode: code === BOAT_DIRECT_FAILED ? code : "other" } : {}),
    ...(typeof retryable === "boolean" ? { boatRetryable: retryable } : {}),
    // Table lines 17-18 say message `sandbox_restoring`, not text containing it.
    // Keep only that exact documented value, never the raw message text.
    ...(message === BOAT_RESTORING ? { boatMessage: BOAT_RESTORING } : {}),
  };
}

/**
 * Table line 17-18. A 502 `sandbox_direct_failed` with `retryable: true`, or
 * with message `sandbox_restoring`, did not run: send it again. A command with
 * any other 5xx answer possibly ran ("When `retryable` is `false`, the command
 * can still be running. Do not run it again without a check."). A files call
 * with another 5xx is surfaced as before.
 */
export function classifyDirectFailure(status: number, fields: BoatDirectFields): DirectFailureClass {
  // Table line 17: explicit false means it can still be running, whatever the message.
  if (status === 502 && fields.boatCode === BOAT_DIRECT_FAILED && fields.boatRetryable !== false
    && (fields.boatRetryable === true || fields.boatMessage === BOAT_RESTORING)) return "did_not_run";
  return status >= 500 ? "possibly_ran" : "other";
}

/** The shell no-op at the START of the command text that names this attempt. */
export function commandNonceMarker(nonce: string): string { return `: paperclip-attempt=${nonce};`; }
/**
 * The command text Boat runs and keeps (history line 41, first 64 KiB, so the
 * marker at the start is always kept). `:` is the POSIX null utility: it reads
 * its arguments, does nothing and exits 0, so the command list after the `;`
 * runs exactly as before. Every plugin command is shell text (runCommand); the
 * plugin sends no argv-form command to /commands, so no path skips the marker.
 */
export function withCommandNonce(command: string, nonce: string): string { return `${commandNonceMarker(nonce)} ${command}`; }

/** Does the history page (lines 61-63: `{"commands":[{...}]}`) hold this exact attempt? Only a boolean is kept. */
export function historyHasCommand(page: unknown, command: string): boolean {
  const commands = field(page, "commands");
  // History retains only the first 64 KiB (line 41). A truncated prefix cannot
  // prove equality of the full command: conservatively keep that unknown.
  if (!Array.isArray(commands) || Buffer.byteLength(command, "utf8") > 65_536) return false;
  return commands.some(record => field(record, "command") === command);
}

/**
 * EVIDENCE ONLY: one history read after a command possibly ran. It never leads
 * to a send: Boat's docs promise no time by which a record is visible, so an
 * absent record is 'unknown', not 'did not run'.
 */
export async function commandEvidence(command: string | undefined, read: () => Promise<unknown>): Promise<CommandEvidence> {
  if (!command) return "unknown";
  try { return historyHasCommand(await read(), command) ? "ran" : "unknown"; }
  catch { return "unknown"; }
}

export type CommandPossiblyRanError = Error & {
  code: typeof COMMAND_POSSIBLY_RAN; evidence: CommandEvidence; reason: PossiblyRanReason; httpStatus: number | null; category: string;
} & BoatDirectFields;
/**
 * The named outcome. No `status` and no transport errno: neither the host's
 * transient retry classification nor anything else may read it as safe to send again.
 */
export function commandPossiblyRanError(httpStatus: number | null, category: string, reason: PossiblyRanReason,
  evidence: CommandEvidence, direct: BoatDirectFields = {}): CommandPossiblyRanError {
  // R3: the real server resume predicate (environment-runtime.d2badcf4.ts:820-838)
  // also reads RPC message text. Keep reasons (notably "timeout") structured only,
  // and omit dynamic identifiers so they cannot accidentally become retry words.
  return Object.assign(new Error(`Boat POST /sandboxes/{sandboxId}/commands failed (${httpStatus ?? "unavailable"}): result_unconfirmed, evidence=${evidence} (possibly ran)`),
    { code: COMMAND_POSSIBLY_RAN, evidence, reason, httpStatus, category }, direct) as CommandPossiblyRanError;
}
