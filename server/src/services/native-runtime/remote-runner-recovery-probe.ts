import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { findSandboxStoppedError } from "../sandbox-stopped-error.js";
import {
  attachRemoteRunnerRecoveryDiagnostic,
  RemoteRunnerRecoveryError,
  type RemoteRunnerRecoveryDiagnostic,
} from "./remote-runner-recovery-diagnostics.js";

export const REMOTE_RUNNER_RECOVERY_PROBE_BUDGET_MS = 30_000;

export async function readRemoteRunnerRecoveryProbe(input: {
  runner: CommandManagedRuntimeRunner;
  request: Parameters<CommandManagedRuntimeRunner["execute"]>[0];
  stage: RemoteRunnerRecoveryDiagnostic["stage"];
  deadline: number;
  readOnly: boolean;
}) {
  let lastError: unknown = new RemoteRunnerRecoveryError({
    stage: input.stage, reason: "probe_timeout",
  });
  // A few fast gateway failures can exhaust an attempt count in under a
  // second. Read-only observations share the caller's deadline instead;
  // signals still have one attempt because their outcome may be unknown.
  for (let attempt = 0; ; attempt++) {
    const remaining = input.deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) break;
    try {
      const result = await input.runner.execute({
        ...input.request,
        timeoutMs: Math.min(10_000, remaining),
      });
      if (!result.timedOut) return result;
      lastError = new RemoteRunnerRecoveryError({ stage: input.stage, reason: "probe_timeout" });
    } catch (error) {
      // The command boundary already tried the exact lease's resume once. A
      // definite stopped rejection cannot improve by polling it for 30s (or
      // by restarting another provider-startup retry episode).
      if (findSandboxStoppedError(error)) throw error;
      lastError = attachRemoteRunnerRecoveryDiagnostic(error, {
        stage: input.stage, reason: "probe_transport_failed",
      });
    }
    const delayMs = Math.min(250 * 2 ** Math.min(attempt, 3), 2_000);
    if (!input.readOnly || input.deadline - Date.now() <= delayMs) break;
    await new Promise<void>(resolve => setTimeout(resolve, delayMs));
  }
  throw lastError;
}
