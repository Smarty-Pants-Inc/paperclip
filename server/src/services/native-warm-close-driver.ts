/**
 * The seam through which the cleanup sweep's native warm close opener
 * (`native-warm-close-opener.ts`) asks this server process to close the warm
 * native session that owns a retained lease's sandbox. The native session
 * executor registers its close path here when it loads; the opener never imports
 * the executor, and a process without the executor (or a test) reports `absent`.
 */

/** The exact retained lease whose warm native session should be closed. */
export type NativeWarmCloseLease = {
  leaseId: string;
  companyId: string;
  runId: string;
  providerLeaseId: string;
};

/**
 * - `closed`: this process closed the session through its close path (the
 *   executor recorded the close receipt).
 * - `busy`: this process owns the session but it is in use, or its agent
 *   directory is busy; try again later without counting a failure.
 * - `not_owned`: this process holds a Runner on the sandbox it must not close
 *   (a released Runner another owner may adopt, or another run's owner).
 * - `absent`: this process holds no warm session for the sandbox.
 * - `failed`: the close was attempted here and failed.
 */
export type NativeWarmCloseOutcome = "closed" | "busy" | "not_owned" | "absent" | "failed";

export type NativeWarmCloseDriver = (lease: NativeWarmCloseLease) => Promise<{ outcome: NativeWarmCloseOutcome; detail?: string }>;

let driver: NativeWarmCloseDriver | null = null;

/** Register the close path; returns a function restoring the previous one. */
export function registerNativeWarmCloseDriver(next: NativeWarmCloseDriver): () => void {
  const previous = driver;
  driver = next;
  return () => { if (driver === next) driver = previous; };
}

export async function driveNativeWarmClose(lease: NativeWarmCloseLease): Promise<{ outcome: NativeWarmCloseOutcome; detail?: string }> {
  if (!driver) return { outcome: "absent" };
  try {
    return await driver(lease);
  } catch (error) {
    return { outcome: "failed", detail: error instanceof Error ? error.message.slice(0, 500) : "close driver failed" };
  }
}
