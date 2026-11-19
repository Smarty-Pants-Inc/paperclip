import { ENVIRONMENT_CREATION_IDEMPOTENCY_CODES, JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, readEnvironmentAcquireErrorDiagnostic, readEnvironmentAcquisitionDiagnostic,
  readEnvironmentCreationIdempotencyCode, type EnvironmentCreationIdempotencyCode } from "@paperclipai/plugin-sdk";
import type { ProviderFailure } from "@paperclipai/shared";
import { getEnvironmentAcquisitionDiagnostic } from "./environment-acquisition-diagnostics.js";

/**
 * Setup failure code for a lease acquisition that the environment provider
 * refused with a transient status (HTTP 408/425/429/5xx or a connection-level
 * errno), or that reached its own acquisition deadline, before any agent work
 * started. The run is retried with the bounded
 * bootstrap budget. A provisional allocation whose cleanup could not be
 * confirmed stays owned by its own creation record, which the cleanup
 * reconciler settles independently; every retry is a new creation attempt
 * with its own idempotent identity, so it can neither reuse nor leak it.
 */
export const ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE = "environment_provider_unavailable";

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
// Connection-level failures only. ENOTFOUND (a wrong host) and ABORT_ERR (our
// own cancellation) are excluded: retrying cannot repair either.
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

/**
 * `reason` names evidence that has neither a provider status nor a deadline:
 * the provider reported a provisional creation that did not finish, or a
 * control-plane database query failed while the lease was taken.
 */
type TransientLeaseFailureReason = "acquisition_incomplete" | "database_error" | "creation_reclaimed" | "creation_in_progress" | "creation_key_reused";
type TransientProviderEvidence = { httpStatus?: number; errorCode?: string; acquisitionTimedOut?: true; reason?: TransientLeaseFailureReason };

/** A retry's carried creation was reclaimed by recovery before it attached. */
export class SandboxCreationReclaimedError extends Error {
  readonly code = "sandbox_creation_reclaimed";
  constructor() { super("Sandbox creation ownership has already transferred"); this.name = "SandboxCreationReclaimedError"; }
}

/**
 * The provider refused a retry's carried creation key as reused with a
 * different body (Boat's 409 idempotency_key_reused). The creation is spent
 * like a firm refusal and that key is never sent again: the host's next retry
 * mints a fresh key. A box the earlier create may have made self-stops at its ttl.
 */
export class SandboxCreationKeyReusedError extends Error {
  readonly code = "sandbox_creation_key_reused";
  constructor(cause: unknown) {
    super("The sandbox provider refused the retried creation key as reused (409 idempotency_key_reused); the next attempt uses a fresh creation key", { cause });
    this.name = "SandboxCreationKeyReusedError";
  }
}

function own(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  } catch { return undefined; }
}

/**
 * Read transient provider evidence from structured fields only: the validated
 * plugin RPC envelope, or the status/errno an in-process provider attached to
 * its error. An acquisition whose first failure was its own deadline is
 * transient too. Message text is never parsed.
 */
export function readTransientEnvironmentProviderFailure(error: unknown): TransientProviderEvidence | null {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const acquisition = readEnvironmentAcquisitionDiagnostic(cause);
    if (acquisition && acquisition.elapsedMs >= acquisition.budgetMs) return { acquisitionTimedOut: true };
    const envelope = readEnvironmentAcquireErrorDiagnostic(cause);
    const statusValue = envelope?.httpStatus ?? [own(cause, "status"), own(cause, "statusCode")]
      .find(value => Number.isInteger(value));
    const codeValue = envelope?.errorCode ?? own(cause, "code");
    const httpStatus = typeof statusValue === "number" && TRANSIENT_HTTP_STATUSES.has(statusValue) ? statusValue : undefined;
    const errorCode = typeof codeValue === "string" && TRANSIENT_ERROR_CODES.has(codeValue) ? codeValue : undefined;
    if (httpStatus !== undefined || errorCode !== undefined) {
      return { ...(httpStatus !== undefined ? { httpStatus } : {}), ...(errorCode !== undefined ? { errorCode } : {}) };
    }
    // A definite non-transient status is authoritative for this layer.
    if (typeof statusValue === "number" && statusValue >= 400) return null;
  }
  return null;
}

const IDEMPOTENCY_CODES = new Set<unknown>(ENVIRONMENT_CREATION_IDEMPOTENCY_CODES);
function creationIdempotencyCode(error: unknown): EnvironmentCreationIdempotencyCode | null {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const code = readEnvironmentCreationIdempotencyCode(cause) ?? own(cause, "code");
    if (IDEMPOTENCY_CODES.has(code)) return code as EnvironmentCreationIdempotencyCode;
  }
  return null;
}

// Timeout-shaped or retry-later 4xx: the create may still have made a box.
// A 409 that names no idempotency outcome is never taken as a refusal either.
const CARRIED_CLIENT_STATUSES = new Set([408, 409, 425, 429, 499]);

/**
 * What a host retry does with a failed create's creation operation.
 * - carried: re-send the same id/key. Any timeout or unknown outcome, 408 and
 *   other timeout-shaped 4xx, 429, 5xx, unavailable/network, and Boat's
 *   409 idempotency_in_progress: the outcome may have made a box.
 * - refused / box_stopped (spent): a FIRM refusal (any other 4xx: Boat said no and made nothing) or the
 *   plugin's typed boat_idempotency_box_stopped. The next retry mints a fresh key.
 * - key_reused: Boat's 409 idempotency_key_reused. Spent like a refusal and
 *   reported as its own named error; the next retry mints a fresh key.
 * Typed idempotency codes are authoritative; then any carried evidence on the
 * chain wins over a refusal, and a closed transient errno is read before the
 * status, so a 4xx with ETIMEDOUT is carried. Message text is never parsed.
 */
export function readCreationRetryOutcome(error: unknown): "carried" | "refused" | "box_stopped" | "key_reused" {
  const idempotency = creationIdempotencyCode(error);
  if (idempotency === "idempotency_key_reused") return "key_reused";
  if (idempotency === "idempotency_in_progress") return "carried";
  if (idempotency === "boat_idempotency_box_stopped") return "box_stopped";
  let refused = false;
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    if (cause instanceof JsonRpcCallError && cause.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT) return "carried";
    if (readEnvironmentAcquisitionDiagnostic(cause)) return "carried";
    // A closed transient errno (ETIMEDOUT, ECONNRESET, ...) is checked BEFORE
    // the status: a timeout-shaped 4xx (e.g. 422 + ETIMEDOUT) may have made the box.
    const errno = readEnvironmentAcquireErrorDiagnostic(cause)?.errorCode ?? own(cause, "code");
    if (typeof errno === "string" && TRANSIENT_ERROR_CODES.has(errno)) return "carried";
    const status = readEnvironmentAcquireErrorDiagnostic(cause)?.httpStatus
      ?? [own(cause, "status"), own(cause, "statusCode")].find(value => Number.isInteger(value));
    if (typeof status !== "number") continue;
    if (status < 400 || status >= 500 || CARRIED_CLIENT_STATUSES.has(status)) return "carried";
    refused = true;
  }
  return refused ? "refused" : "carried";
}

/** A definite non-transient HTTP status anywhere on the chain is authoritative: retrying cannot change it. */
function definiteNonTransientStatus(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const status = readEnvironmentAcquireErrorDiagnostic(cause)?.httpStatus
      ?? [own(cause, "status"), own(cause, "statusCode")].find(value => Number.isInteger(value));
    if (typeof status === "number" && status >= 400 && !TRANSIENT_HTTP_STATUSES.has(status)) return true;
  }
  return false;
}

// postgres.js connection-level codes, and SQLSTATEs a repeated statement can
// pass: connection (08), insufficient resources (53), operator intervention
// (57P01-57P03, 57014 query cancelled or timed out), lock not available (55P03),
// serialization failure and deadlock (40001, 40P01). A deterministic SQL error
// (syntax, schema, constraint) is not retried.
const DATABASE_CONNECTION_CODES = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT"]);
const TRANSIENT_SQLSTATES = new Set(["57P01", "57P02", "57P03", "57014", "55P03", "40001", "40P01"]);

function transientDatabaseFailure(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const code = own(cause, "code");
    if (typeof code !== "string") continue;
    if (DATABASE_CONNECTION_CODES.has(code)) return true;
    if (/^[0-9A-Z]{5}$/.test(code) && (code.startsWith("08") || code.startsWith("53") || TRANSIENT_SQLSTATES.has(code))) {
      // A five-character code is a SQLSTATE only on a database driver error.
      const name = own(cause, "name");
      if (name === "PostgresError" || name === "DatabaseError" || own(cause, "severity") !== undefined) return true;
    }
  }
  return false;
}

/**
 * Classify a failed lease acquisition for the bounded bootstrap retry. Lease
 * acquisition precedes any provider (agent) work by construction, and every
 * retry is a new creation attempt with its own idempotent identity, so a
 * failure is retried unless it carries a definite non-transient status. Only
 * structured evidence is read: the provider's status or errno, the validated
 * acquisition diagnostic the runtime recorded for this run, the plugin RPC
 * deadline, or a transient database driver code. Message text is never parsed.
 */
export function readTransientLeaseAcquisitionFailure(
  error: unknown,
  run: { id: string; companyId: string },
): TransientProviderEvidence | null {
  const provider = readTransientEnvironmentProviderFailure(error);
  if (provider) return provider;
  // The host retries: in_progress re-sends the same key (Boat's documented
  // "retry shortly"); a reused key is spent, so that retry mints a fresh key.
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    if (cause instanceof SandboxCreationKeyReusedError) return { reason: "creation_key_reused" };
  }
  if (creationIdempotencyCode(error) === "idempotency_in_progress") return { reason: "creation_in_progress" };
  if (definiteNonTransientStatus(error)) return null;
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const acquisition = getEnvironmentAcquisitionDiagnostic(cause, run);
    if (acquisition) {
      return acquisition.elapsedMs >= acquisition.budgetMs ? { acquisitionTimedOut: true } : { reason: "acquisition_incomplete" };
    }
    if (cause instanceof JsonRpcCallError && cause.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT) return { acquisitionTimedOut: true };
    if (cause instanceof SandboxCreationReclaimedError) return { reason: "creation_reclaimed" };
  }
  return transientDatabaseFailure(error) ? { reason: "database_error" } : null;
}

const REASON_LABELS: Record<TransientLeaseFailureReason, string> = {
  acquisition_incomplete: "sandbox creation did not finish",
  database_error: "a database query failed while recording the lease",
  creation_reclaimed: "recovery was stopping the earlier attempt's sandbox",
  creation_in_progress: "the provider was still creating the sandbox",
  creation_key_reused: "the provider refused the retried creation key as reused; the next attempt uses a fresh key",
};

function category(evidence: TransientProviderEvidence): ProviderFailure["category"] {
  if (evidence.httpStatus === 429) return "rate_limit";
  if (evidence.acquisitionTimedOut || evidence.httpStatus === 408 || evidence.httpStatus === 504
      || evidence.errorCode === "ETIMEDOUT" || evidence.errorCode === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  return "overloaded";
}

/** A lease acquisition the environment provider refused transiently. */
export class EnvironmentProviderUnavailableError extends Error {
  readonly code = ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  /** Read by the setup-failure path and shown on the task as the reason. */
  readonly providerFailure: ProviderFailure;

  constructor(input: { environmentName: string; driver: string; evidence: TransientProviderEvidence; cause: unknown }) {
    const status = input.evidence.httpStatus !== undefined ? `HTTP ${input.evidence.httpStatus}`
      : input.evidence.errorCode ?? (input.evidence.reason ? REASON_LABELS[input.evidence.reason] : undefined);
    super(status
      ? `Environment provider for "${input.environmentName}" was temporarily unavailable (${status}).`
      : `Environment provider for "${input.environmentName}" did not finish starting the sandbox in time.`, { cause: input.cause });
    this.name = "EnvironmentProviderUnavailableError";
    this.httpStatus = input.evidence.httpStatus ?? null;
    this.errorCode = input.evidence.errorCode ?? null;
    const providerCode = input.evidence.errorCode ?? (input.evidence.httpStatus === undefined ? input.evidence.reason : undefined);
    this.providerFailure = {
      schema: "paperclip.provider-failure.v1",
      provider: /^[a-zA-Z0-9_.:/-]{1,80}$/.test(input.driver) ? input.driver : "environment",
      phase: "startup",
      category: category(input.evidence),
      message: (status
        ? `The provider for "${input.environmentName}" was temporarily unavailable while Paperclip was starting it (${status}). `
        : `The sandbox for "${input.environmentName}" did not finish starting in time. `)
        + "No agent work had started. If the task stays blocked, use Retry once the provider is available.",
      ...(input.evidence.httpStatus !== undefined ? { httpStatus: input.evidence.httpStatus } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
      retryability: "transient",
    };
  }
}

/** Find a transient provider refusal through the orchestrator's error wrappers. */
export function findEnvironmentProviderUnavailableError(error: unknown): EnvironmentProviderUnavailableError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof EnvironmentProviderUnavailableError) return cause;
  }
  return null;
}
