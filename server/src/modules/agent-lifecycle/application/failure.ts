import { readAiConnectionConfigurationFailure } from "../../../lib/ai-connection-configuration-failure.js";
import type { LifecycleFailure } from "./ports.js";
import { redactDiagnosticText } from "@paperclipai/adapter-utils";

// Public copy stays fixed. Provider errors can contain secrets.
const connectionReasons = {
  ai_connection_responsible_user_missing: "Set the responsible user before selecting this agent's AI connection.",
  ai_connection_default_missing: "Connect an AI account and choose the responsible user's personal default for this provider.",
  ai_connection_missing: "The selected AI connection is unavailable. Choose an available connection in Configuration.",
  ai_connection_incompatible: "Choose an AI connection compatible with this agent's harness and model in Configuration.",
  ai_connection_unavailable: "Reconnect or validate the selected AI account in Configuration.",
  ai_connection_credential_not_shared: "The credential is not shared with the responsible user. Ask its owner for access or choose an authorized connection.",
} as const;
const reasons = {
  harness_test_failed: "The execution test did not pass. Open Configuration and run the agent test to inspect the failed checks.",
  ai_connection_required: "This agent's environment requires a managed AI connection and an isolated Runner home. Check both in Configuration, then retry.",
  harness_auth_failed: "Authentication failed. Check the agent's AI connection or sign in to its execution tool, then retry.",
  harness_model_unavailable: "The selected model is unavailable. Choose a model supported by the agent's AI connection in Configuration, then retry.",
  harness_command_unavailable: "The execution command was not found. Check the command and its installation in the agent's environment, then retry.",
  harness_cwd_invalid: "The working directory is unavailable. Check the working directory in Configuration, then retry.",
  harness_probe_timed_out: "The execution test timed out. Paperclip will retry automatically. If this continues, run the agent test in Configuration.",
  harness_probe_unexpected_output: "The execution test did not return the expected response. Run the agent test in Configuration to inspect the failed checks.",
  runner_revision_mismatch: "The remote Runner is being updated to match this Paperclip version. Paperclip will check again automatically.",
  test_environment_unavailable: "The test environment is unavailable. Check the agent's environment in Configuration. Paperclip will retry automatically.",
  required_plugin_unavailable: "A required plugin is unavailable. Check the plugin's status in Settings. Paperclip will retry automatically.",
  invalid_lifecycle_result: "A required plugin returned an invalid result. Check the plugin's status in Settings. Paperclip will retry automatically.",
} as const;

const setupFailures = {
  no_ai_connection: ["No AI connection attached", "Attach an AI connection in the agent's settings, then retry verification."],
  ai_connection_unavailable: ["AI connection needs attention", "Check the selected AI connection and its access in the agent's settings, then retry verification."],
  authentication_failed: ["AI authentication failed", "Reconnect the agent's AI connection or sign in to its execution tool, then retry verification."],
  model_unavailable: ["Selected AI model unavailable", "Choose a model supported by the agent's AI connection, then retry verification."],
  environment_unavailable: ["Agent environment unavailable", "Choose an available environment supported by the agent's runner, then retry verification."],
  command_unavailable: ["Agent execution command unavailable", "Install or correct the execution command in the agent's environment, then retry verification."],
  working_directory_unavailable: ["Agent working directory unavailable", "Correct the working directory in the agent's settings, then retry verification."],
  verification_failed: ["Agent verification failed", "Run the agent test in Harness / Runtime settings to inspect the failed checks, then retry verification."],
  setup_failed: ["Agent setup failed", "Open the agent's Harness / Runtime settings to repair its configuration, then retry verification."],
} as const;
const publicSetupCodes = {
  ai_connection_required: "ai_connection_unavailable", ai_connection_default_missing: "no_ai_connection",
  ai_connection_responsible_user_missing: "ai_connection_unavailable", ai_connection_missing: "ai_connection_unavailable",
  ai_connection_incompatible: "ai_connection_unavailable", ai_connection_unavailable: "ai_connection_unavailable",
  ai_connection_credential_not_shared: "ai_connection_unavailable", harness_auth_failed: "authentication_failed",
  harness_model_unavailable: "model_unavailable", test_environment_unavailable: "environment_unavailable",
  harness_command_unavailable: "command_unavailable", harness_cwd_invalid: "working_directory_unavailable",
  harness_test_failed: "verification_failed", harness_probe_unexpected_output: "verification_failed",
} as const;

/** Public setup presentation is fixed copy, never persisted provider prose. */
export function lifecycleSetupFailure(storedCode: unknown) {
  const code = typeof storedCode === "string" && Object.hasOwn(publicSetupCodes, storedCode)
    ? publicSetupCodes[storedCode as keyof typeof publicSetupCodes] : "setup_failed";
  const [title, nextAction] = setupFailures[code];
  return { code, title, nextAction: storedCode === "ai_connection_required" ? reasons.ai_connection_required : nextAction };
}

const transientCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "40001", "40P01", "53300", "57P01"]);
const configurationFailures = new Set([
  "ai_connection_required", "harness_auth_failed", "harness_model_unavailable",
  "harness_command_unavailable", "harness_cwd_invalid", "harness_probe_unexpected_output",
]);

export function lifecycleVerificationNeedsRetry(context: LifecycleFailure, error: unknown): boolean {
  const code = lifecycleFailureCode(error) ?? "";
  return ["verifying", "resuming"].includes(context.phase ?? "") && context.stage === "host"
    && (readAiConnectionConfigurationFailure(error) !== null || context.phase === "verifying"
      && (configurationFailures.has(code) || (code === "harness_test_failed" && (context.verificationFailures ?? 0) >= 3)));
}

export function lifecycleFailureCode(error: unknown): string | undefined {
  const selectionFailure = readAiConnectionConfigurationFailure(error);
  if (selectionFailure) return selectionFailure;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return [candidate?.code, candidate?.cause?.code].find((code): code is string =>
    typeof code === "string" && (Object.hasOwn(reasons, code) || transientCodes.has(code)));
}

/** Private setup diagnostic from an already-redacted native probe, never public action copy. */
export function lifecycleFailureReason(error: unknown): string | undefined {
  const reason = (error as { redactedNativeProbeReason?: unknown } | null)?.redactedNativeProbeReason;
  if (typeof reason !== "string" || !lifecycleFailureCode(error)?.startsWith("harness_")) return undefined;
  const redacted = redactDiagnosticText(reason, "[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[REDACTED]@");
  return Array.from(redacted.split(/[\r\n\u2028\u2029]/u, 1)[0] ?? "").slice(0, 300).join("") || undefined;
}

export function lifecycleFailureMessage(context: LifecycleFailure, error: unknown): string {
  const phases = {
    preparing: "Agent preparation", verifying: "Execution configuration check", pausing: "Stopping agent execution",
    resuming: "Starting agent resources", terminating: "Stopping agent execution", cleaning_up: "Agent resource cleanup",
  };
  const phase = context.phase && Object.hasOwn(phases, context.phase)
    ? phases[context.phase as keyof typeof phases] : "Agent setup";
  const step = context.stage === "plugin" ? `${phase}: required plugin step`
    : context.stage === "select_plugins" ? `${phase}: finding required plugins`
    : ["save_plugins", "complete_host", "complete_plugin", "transition"].includes(context.stage)
      ? `${phase}: saving progress` : phase;
  const code = lifecycleFailureCode(error);
  const reason = code && Object.hasOwn(connectionReasons, code) ? connectionReasons[code as keyof typeof connectionReasons]
    : code && Object.hasOwn(reasons, code) ? reasons[code as keyof typeof reasons]
    : "Paperclip could not complete this step. It will retry automatically. If this continues, contact your instance administrator.";
  return `${step} failed. ${reason}${lifecycleVerificationNeedsRetry(context, error)
    ? " Automatic verification is paused. Update Configuration or choose Retry now." : ""}`;
}
