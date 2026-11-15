/**
 * The provider confirmed that a retained sandbox no longer exists: its resume
 * reply named no provider lease and marked the lease expired. Resume never
 * acquires a replacement; callers decide what confirmed absence permits.
 */
export class RetainedSandboxAbsentError extends Error {
  constructor() {
    super("The provider confirmed the retained sandbox no longer exists. No replacement was acquired.");
    this.name = "RetainedSandboxAbsentError";
  }
}

/** Durable server authority forbids a start; this does not claim physical absence. */
export class SandboxLeaseStartDeniedError extends Error {
  readonly code = "sandbox_lease_start_denied";
  constructor() {
    super("The source sandbox lease is retired or superseded and cannot start.");
    this.name = "SandboxLeaseStartDeniedError";
  }
}

export function isSandboxLeaseStartDeniedError(error: unknown): error is SandboxLeaseStartDeniedError {
  return error instanceof Error && "code" in error && error.code === "sandbox_lease_start_denied";
}

/** A resume reply that confirms the sandbox is gone, as sandbox providers report it. */
export function resumeReplyConfirmsAbsence(reply: unknown): boolean {
  if (!reply || typeof reply !== "object") return false;
  const value = reply as { providerLeaseId?: unknown; metadata?: unknown };
  const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : {};
  return (value.providerLeaseId === null || value.providerLeaseId === undefined) && metadata.expired === true;
}
