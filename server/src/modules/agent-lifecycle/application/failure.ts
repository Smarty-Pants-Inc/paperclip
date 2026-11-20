import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { readHttpErrorCode } from "../../../lib/http-error-code.js";
import { readAiConnectionConfigurationFailure } from "../../../lib/ai-connection-configuration-failure.js";
import type { LifecycleFailure } from "./ports.js";

// Only fixed text may leave this boundary. Provider errors can contain secrets.
const connectionReasons = {
  ai_connection_responsible_user_missing: "Set the responsible user before selecting this agent's AI connection.",
  ai_connection_default_missing: "Connect an AI account and choose the responsible user's personal default for this provider.",
  ai_connection_missing: "The selected AI connection is unavailable. Choose an available connection in Configuration.",
  ai_connection_incompatible: "Choose an AI connection compatible with this agent's harness and model in Configuration.",
  ai_connection_unavailable: "Reconnect or validate the selected AI account in Configuration.",
  ai_connection_credential_not_shared: "The credential is not shared with the responsible user. Ask its owner for access or choose an authorized connection.",
} as const;
const reasons = {
  provider_allocation_failed: "The provider allocation failed. Check the environment's provider capacity and quota, then retry.",
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
  native_probe_cleanup_failed: "The execution test failed and its runtime could not be closed cleanly. Paperclip finished the test's cleanup.",
  native_probe_cleanup_unfinished: "The execution test failed and its runtime could not be closed cleanly. Paperclip could not finish the test's cleanup: the test's temporary runtime home is still on this server, and Paperclip tries again to remove it the next time this AI connection is used.",
  native_probe_cleanup_box_gone: "Paperclip could not finish the test's cleanup on its test machine: the machine was released before it confirmed the test's credential handoff. Paperclip finished the test's cleanup on this server and removed its temporary runtime home.",
  native_probe_cleanup_stalled: "Paperclip could not finish the test's cleanup within 10 minutes: its credential handoff or runtime home removal is still unconfirmed. The test's temporary runtime home stays on this server, and Paperclip tries again to finish the cleanup the next time this AI connection is used.",
} as const;

const transientCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "PLUGIN_RPC_TIMEOUT", "40001", "40P01", "53300", "57P01"]);
const configurationFailures = new Set([
  "ai_connection_required", "harness_auth_failed", "harness_model_unavailable",
  "harness_command_unavailable", "harness_cwd_invalid", "harness_probe_unexpected_output",
  // A failed test whose native close was unrecoverable: a true failure, not cleanup still running.
  "native_probe_cleanup_failed", "native_probe_cleanup_unfinished",
  // A probe cleanup whose box is gone, or that stayed pending past its bound: park for Retry.
  "native_probe_cleanup_box_gone", "native_probe_cleanup_stalled",
]);

export function lifecycleVerificationNeedsRetry(context: LifecycleFailure, error: unknown): boolean {
  const code = lifecycleFailureCode(error) ?? "";
  return ["verifying", "resuming"].includes(context.phase ?? "") && context.stage === "host"
    && (readAiConnectionConfigurationFailure(error) !== null || configurationFailures.has(code)
      || (context.phase === "verifying" && code === "harness_test_failed" && (context.verificationFailures ?? 0) >= 3));
}

export function lifecycleFailureCode(error: unknown): string | undefined {
  const selectionFailure = readAiConnectionConfigurationFailure(error);
  if (selectionFailure) return selectionFailure;
  const detailCode = readHttpErrorCode(error);
  if (detailCode === "native_probe_cleanup_pending" || detailCode === "native_probe_cleanup_failed"
    || detailCode === "native_probe_cleanup_unfinished" || detailCode === "native_probe_cleanup_box_gone"
    || detailCode === "native_probe_cleanup_stalled") return detailCode;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const codes = [candidate?.code, candidate?.cause?.code];
  if (codes.includes(PLUGIN_RPC_ERROR_CODES.TIMEOUT)) return "PLUGIN_RPC_TIMEOUT";
  return codes.find((code): code is string =>
    typeof code === "string" && (Object.hasOwn(reasons, code) || transientCodes.has(code)));
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
  const retryRequired = lifecycleVerificationNeedsRetry(context, error);
  const reason = code && Object.hasOwn(connectionReasons, code) ? connectionReasons[code as keyof typeof connectionReasons]
    : code && Object.hasOwn(reasons, code) ? reasons[code as keyof typeof reasons]
    : retryRequired ? `The host step failed (${code ?? "unclassified"}). Contact your instance administrator.`
      : "Paperclip could not complete this step. It will retry automatically. If this continues, contact your instance administrator.";
  const visibleReason = retryRequired ? reason.replace(/Paperclip will (?:retry|check again) automatically\.?/g, "").trim() : reason;
  return `${step} failed. ${visibleReason}${retryRequired
    ? " Automatic verification is paused. Update Configuration or choose Retry now." : ""}`;
}
