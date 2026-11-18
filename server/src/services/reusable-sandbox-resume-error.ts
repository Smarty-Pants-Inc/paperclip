import { readEnvironmentResumeErrorDiagnostic } from "@paperclipai/plugin-sdk";
import { sandboxProviderFailureLabel } from "./remote-workspace-transport.js";

/**
 * Setup failure code for a preserved reusable sandbox that could not be
 * resumed before provider work began, where replacing it was not safe (see
 * `reusable-sandbox-resume-replacement.ts`). The failure is retried with the
 * bounded bootstrap budget; it never authorizes a replacement sandbox.
 */
export const REUSABLE_SANDBOX_RESUME_FAILED_CODE = "reusable_sandbox_resume_failed";

/** A reusable sandbox could not be resumed, but has not been proven lost. */
export class ReusableSandboxResumeError extends Error {
  readonly code = REUSABLE_SANDBOX_RESUME_FAILED_CODE;
  readonly provider: string;
  readonly providerLeaseId: string;

  constructor(input: {
    provider: string;
    providerLeaseId: string;
    cause?: unknown;
  }) {
    // Record why the provider refused with closed labels only. The provider
    // message stays on `cause` and off the run record.
    const failure = input.cause === undefined ? null : sandboxProviderFailureLabel(input.cause);
    // A plugin worker refusal crosses JSON-RPC with only a message and an RPC
    // code; its safe status and errno travel in the validated error envelope.
    const envelope = input.cause === undefined ? null : readEnvironmentResumeErrorDiagnostic(input.cause);
    if (failure && envelope) {
      failure.status ??= envelope.httpStatus ?? null;
      failure.code ??= envelope.errorCode ?? null;
    }
    const detail = failure
      ? ` (cause=${failure.label}${failure.status !== null ? ` status=${failure.status}` : ""}${failure.code ? ` code=${failure.code}` : ""})`
      : "";
    super(
      `Reusable sandbox lease "${input.providerLeaseId}" could not be resumed${detail}; ` +
        "the lease was preserved and no replacement was created.",
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "ReusableSandboxResumeError";
    this.provider = input.provider;
    this.providerLeaseId = input.providerLeaseId;
  }
}

/** Find a resume failure through the orchestrator's error wrappers. */
export function findReusableSandboxResumeError(error: unknown): ReusableSandboxResumeError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof ReusableSandboxResumeError) return cause;
  }
  return null;
}

/**
 * Setup failure code for a chat whose saved box could not be restored because
 * its durable harness backup (the chat's history) failed verification: the
 * stored object's bytes do not match, the object or its row is missing, or the
 * reference is invalid. The run refused before any provider work, destroyed
 * nothing and kept the old box. Retrying cannot repair the backup by itself,
 * so it is not retried automatically; the person sees one true instruction.
 */
export const REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_CODE = "reusable_sandbox_backup_unrestorable";

export const REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_KEPT =
  "This chat's saved box couldn't be restored. Nothing was deleted; the old box is kept.";

export const REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_INSTRUCTION =
  `${REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_KEPT} Press Retry.`;

/** Equals NEW_TASK_CONTINUE_ACTION (execution-blocker.ts), the action that is always available. */
export const REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_DEFAULT_NEXT_STEP = "Create a new task to continue the work.";

/**
 * The one true instruction for a chat whose saved box could not be restored.
 * "Press Retry" only when the chat offers Retry at that moment (the execution
 * blocker's `canRetry`); otherwise the sentence ends "the old box is kept."
 * and names the step that IS available: the blocker's own next action with
 * any Retry sentence removed (for a bound external chat, "Send a new chat
 * message..."), else creating a new task. Never "Paperclip is holding this
 * task until its saved work is settled": nothing is held for this chat.
 */
export function reusableSandboxBackupUnrestorableInstruction(retryOffered: boolean, nextStepWithoutRetry?: string | null): string {
  if (retryOffered) return REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_INSTRUCTION;
  const offered = (nextStepWithoutRetry ?? "").replace(REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_KEPT, "")
    .split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(sentence => sentence && !/\bretry\b/i.test(sentence)).join(" ");
  return `${REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_KEPT} ${offered || REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_DEFAULT_NEXT_STEP}`;
}

export type ReusableSandboxBackupFailure =
  | "hash_mismatch" | "size_mismatch" | "object_missing" | "backup_missing" | "reference_invalid";

/** Classify a real verifier failure (native-harness-backup-storage.ts) by closed reason. */
export function nativeHarnessBackupFailureReason(error: unknown): ReusableSandboxBackupFailure | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    const storage = /\bnative_harness_storage_(hash_mismatch|size_mismatch|reference_invalid)\b/.exec(message);
    if (storage) return storage[1] as ReusableSandboxBackupFailure;
    // Both storage providers raise notFound("Object not found") for a missing key.
    if ((cause as { status?: unknown }).status === 404 && /^Object not found$/.test(message)) return "object_missing";
  }
  return null;
}

/** The chat's saved box could not be restored; nothing was destroyed. */
export class ReusableSandboxBackupUnrestorableError extends Error {
  readonly code = REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_CODE;
  readonly reason: ReusableSandboxBackupFailure;
  readonly providerLeaseId: string;

  constructor(input: { providerLeaseId: string; reason: ReusableSandboxBackupFailure; cause?: unknown }) {
    // Closed reason only; the storage text stays on `cause`.
    super(`${REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_CODE}: reason=${input.reason}; ${REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_INSTRUCTION}`,
      input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ReusableSandboxBackupUnrestorableError";
    this.reason = input.reason;
    this.providerLeaseId = input.providerLeaseId;
  }
}

export function findReusableSandboxBackupUnrestorableError(error: unknown): ReusableSandboxBackupUnrestorableError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof ReusableSandboxBackupUnrestorableError) return cause;
  }
  return null;
}
