import { PluginEnvironmentCreationCleanupError, environmentCreationCleanupErrorData } from "./environment-creation-cleanup.js";
import {
  providerErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
  type PluginEnvironmentResumeErrorDiagnostic,
} from "./environment-resume-error.js";

/**
 * Diagnostic evidence for a refused `environmentAcquireLease`: the provider's
 * HTTP status or a closed errno code. It crosses the worker RPC boundary as
 * structured error data because a JSON-RPC error carries only a message and a
 * numeric RPC code. Provider text and identifiers never cross. The host uses it
 * only to decide whether a bounded retry is worthwhile; ownership of any
 * provisional allocation stays with the creation-cleanup envelope.
 */
export type PluginEnvironmentAcquireErrorDiagnostic = PluginEnvironmentResumeErrorDiagnostic;

const SCHEMA = "paperclip/environment-acquire-error/v1";
const CLEANUP_SCHEMA = "paperclip/environment-creation-cleanup/v1";

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

/**
 * Closed set of provider idempotency outcomes a failed create may name (as the
 * thrown error's or a cause's string `code`). The host decides from it whether
 * a retry re-sends the creation key (in_progress) or spends it (box_stopped,
 * key_reused): key_reused is spent and reported as its own named error, and
 * the host's next retry mints a fresh creation key.
 */
export const ENVIRONMENT_CREATION_IDEMPOTENCY_CODES = ["idempotency_in_progress", "idempotency_key_reused", "boat_idempotency_box_stopped"] as const;
export type EnvironmentCreationIdempotencyCode = typeof ENVIRONMENT_CREATION_IDEMPOTENCY_CODES[number];
const IDEMPOTENCY_CODES = new Set<unknown>(ENVIRONMENT_CREATION_IDEMPOTENCY_CODES);

function creationIdempotencyCode(error: unknown): EnvironmentCreationIdempotencyCode | undefined {
  for (let cause = error, depth = 0; cause && depth < 4; cause = field(cause, "cause"), depth++) {
    const code = field(cause, "code");
    if (IDEMPOTENCY_CODES.has(code)) return code as EnvironmentCreationIdempotencyCode;
  }
  return undefined;
}

/**
 * Worker side: the RPC error data for a failed acquisition. A creation whose
 * cleanup could not be confirmed keeps its ownership envelope and adds the
 * status of the create call only, never of the compensating lookup or delete.
 */
export function environmentAcquireErrorData(error: unknown): unknown {
  const createError = error instanceof PluginEnvironmentCreationCleanupError ? error.errors[0] : error;
  const providerDiagnostic = providerErrorDiagnostic(createError);
  const idempotency = creationIdempotencyCode(createError);
  const extra = { ...(providerDiagnostic ? { providerDiagnostic } : {}), ...(idempotency ? { creationIdempotencyCode: idempotency } : {}) };
  const cleanup = environmentCreationCleanupErrorData(error, true);
  if (cleanup && typeof cleanup === "object") return { ...cleanup, ...extra };
  return providerDiagnostic || idempotency ? { schema: SCHEMA, ...extra } : undefined;
}

/** Host side: the provider idempotency outcome named on an acquisition RPC error. */
export function readEnvironmentCreationIdempotencyCode(error: unknown): EnvironmentCreationIdempotencyCode | null {
  const data = field(error, "data");
  const schema = field(data, "schema");
  if (schema !== SCHEMA && schema !== CLEANUP_SCHEMA) return null;
  const code = field(data, "creationIdempotencyCode");
  return IDEMPOTENCY_CODES.has(code) ? code as EnvironmentCreationIdempotencyCode : null;
}

/** Host side: read and re-validate the provider diagnostic from an RPC error. */
export function readEnvironmentAcquireErrorDiagnostic(error: unknown): PluginEnvironmentAcquireErrorDiagnostic | null {
  const data = field(error, "data");
  const schema = field(data, "schema");
  if (schema !== SCHEMA && schema !== CLEANUP_SCHEMA) return null;
  const diagnostic = field(data, "providerDiagnostic");
  return sanitizeProviderErrorDiagnostic({ httpStatus: field(diagnostic, "httpStatus"), errorCode: field(diagnostic, "errorCode") });
}
