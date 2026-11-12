import { resolveGrokDisableWebSearch } from "../../vendor/paperclip-runner/index.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { resolvePaperclipRunnerPiThinkingLevel, resolvePaperclipRunnerPiRpcThinkingLevel } from "@paperclipai/adapter-utils";
import { environmentTaskResultSchema } from "@paperclipai/plugin-sdk";
import { PI_RPC_BUILTIN_THINKING_CATALOG, NativeEnvironmentProbeCleanupError, probeNativeRunnerEnvironment, resolveClaudeEffort, resolveGrokEffort } from "../../vendor/paperclip-runner/index.js";
import { preparePluginRunnerCredentials } from "./plugin-runner-credentials.js";
import { createPluginRunnerTaskOwner } from "./plugin-runner-task.js";
import { resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";
import { resolveAcpxQualification } from "./acpx-qualification.js";
import { isRunnerRevisionMismatch, runnerRevisionMismatchTestResult } from "../runner-revision-mismatch.js";

/** Core verifies a real Runner; providers only implement their task API. */
export async function probePluginRunnerEnvironment(context: AdapterEnvironmentTestContext,
  managed?: { identity: string; accountIdentity: string; home?: string },
): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  const target = context.executionTarget;
  if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runnerTask || !target.runnerTaskProbe || !target.leaseId) {
    throw new Error("Plugin Runner setup requires a Core-issued probe lease");
  }
  const task = target.runnerTask;
  const binding = target.runnerTaskProbe;
  const runnerId = `probe-${randomUUID()}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-runner-probe-")));
  let cleanupConfirmed = false;
  let probeStarted = false;
  const nativePi = context.config.provider === "pi_rpc";
  try {
    const profile = resolvePaperclipRunnerProviderProfile(context.config);
    if (profile.provider !== "codex" && profile.provider !== "opencode" && profile.provider !== "acpx" && profile.provider !== "pi_rpc") throw new Error("Plugin Runner setup requires a workspace harness");
    const environment = (context.config.env ?? {}) as NodeJS.ProcessEnv;
    if (!managed && (context.config.managedAiConnection || Object.values(environment).some(value => Boolean(value)))) {
      return { adapterType: "paperclip_runner", status: "fail", testedAt,
        checks: [{ code: "runner_account_selection_required", level: "error",
          message: "Select a saved AI account, or remove local environment overrides to test the installed account." }] };
    }
    const description = environmentTaskResultSchema.parse(await task({ kind: "describe" }));
    if (description.kind !== "description" || description.launchPreparationVersion !== 1 || description.projectAuthCheckVersion !== 1) throw new Error("Plugin Runner launch preparation v1 unavailable");
    const credentials = await preparePluginRunnerCredentials({
      provider: profile.provider === "acpx" ? profile.acpxAgent! : profile.provider,
      identity: managed?.identity, accountIdentity: managed?.accountIdentity,
      home: managed?.home, environment,
    });
    const owner = createPluginRunnerTaskOwner({ ...credentials, taskId: description.taskId, projectAuthCheckVersion: description.projectAuthCheckVersion,
      githubCredentialBrokerVersion: description.githubCredentialBrokerVersion, task, projectIds: [],
      harness: profile.provider === "acpx" ? profile.acpxAgent! : profile.provider,
      credentialIdentity: managed?.identity });
    probeStarted = true;
    const effort = context.config.modelReasoningEffort ?? context.config.reasoningEffort ?? context.config.effort;
    const result = await probeNativeRunnerEnvironment({ runtimeDirectory: root, provider: profile.provider,
      // Plugin preparation selects the physical workspace; the probe uses its own logical scope.
      model: profile.model, timeoutMs: 45_000,
      ...(profile.provider === "codex" && typeof effort === "string" && effort ? { reasoningEffort: effort } : {}),
      environment: {},
      transportOptions: {
        ...owner.driver, runnerArtifact: description.runner,
        ...(profile.provider === "opencode" ? { opencodePermissionMode: "deny" } : {}),
        ...(profile.provider === "pi_rpc" ? { piRpcThinkingLevel: resolvePaperclipRunnerPiRpcThinkingLevel("pi_rpc",
          context.config.piRpcThinkingLevel, profile.model, context.config.thinkingLevelMap, PI_RPC_BUILTIN_THINKING_CATALOG) } : {}),
        ...(profile.provider === "acpx" ? { acpxAgent: profile.acpxAgent, acpxPermissionMode: "deny-all", acpxPermissionModePinned: true,
          ...(profile.acpxAgent === "pi" ? { piThinkingLevel: resolvePaperclipRunnerPiThinkingLevel("acpx", "pi", context.config.piThinkingLevel) } : {}),
          ...(profile.acpxAgent === "claude" ? { claudeEffort: resolveClaudeEffort("claude", context.config.modelReasoningEffort ?? context.config.reasoningEffort ?? context.config.effort) } : {}),
          ...(profile.acpxAgent === "grok" ? { grokEffort: resolveGrokEffort("grok", context.config.modelReasoningEffort ?? context.config.reasoningEffort ?? context.config.effort), grokDisableWebSearch: resolveGrokDisableWebSearch("grok", context.config.disableWebSearch) } : {}),
          acpxCandidateProfile: profile.acpxAgent === "pi" ? undefined : resolveAcpxQualification({ kind: "acpx", agent: profile.acpxAgent, model: profile.model }, process.env) } : {}),
        prpIdentity: { runnerInstanceId: runnerId, environmentLeaseId: target.leaseId, runId: binding.runId,
          normalizedSessionId: binding.sessionId, turnId: `turn-${binding.runId}`, itemId: `item-${binding.runId}` },
      },
      onCleanupConfirmed: async () => { rmSync(root, { recursive: true, force: true }); cleanupConfirmed = true; },
    });
    // A handled request or metadata-only receipt is not a successful hello.
    if (nativePi && (result.provider !== "pi_rpc" || result.providerDriver !== "pi_rpc"
      || result.effectiveModel !== profile.model || result.helloProbePassed !== true)) {
      throw new Error("Pi hello did not prove the selected account and model");
    }
    return { adapterType: "paperclip_runner", status: "pass", testedAt,
      checks: [{ code: nativePi ? "pi_rpc_hello_probe_passed" : "runner_hello_probe_passed", level: "info",
        message: nativePi ? "Native Pi completed a tool-free hello with the selected managed account and exact model, and confirmed cleanup."
          : `Runner verified ${result.providerDriver} with model ${result.effectiveModel}.` }] };
  } catch (error) {
    if (error instanceof NativeEnvironmentProbeCleanupError) throw error;
    if (isRunnerRevisionMismatch(error)) return runnerRevisionMismatchTestResult("paperclip_runner", testedAt);
    // Classify without reflecting raw provider text, credentials or addressing.
    if (nativePi) {
      const message = error instanceof Error ? error.message : "";
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const configurationInvalid = code === "pi_provider_config_invalid";
      const authentication = !configurationInvalid && /(?:no (?:api[- ]?key|auth(?:entication)?|credentials?)|(?:api[- ]?key|credentials?) (?:is |are )?(?:missing|required|not found)|invalid (?:api[- ]?key|auth(?:entication)? token)|authentication (?:failed|required)|unauthenticated|unauthorized|not authenticated|please (?:log|sign) in|not logged in|\b(?:401|403)\b)/i.test(message);
      const modelUnavailable = /(?:model.*(?:unavailable|not found|not available|not supported|unknown|does not exist|mismatch)|(?:unknown|invalid|unsupported|unavailable) model|pi_(?:probe_)?model_)/i.test(`${code} ${message}`);
      const timedOut = /timed out/i.test(message);
      return { adapterType: "paperclip_runner", status: "fail", testedAt,
        checks: [{ code: `pi_rpc_hello_probe_${configurationInvalid ? "config_invalid" : authentication ? "auth_required" : modelUnavailable ? "model_unavailable" : timedOut ? "timed_out" : "failed"}`, level: "error",
          message: configurationInvalid ? "The selected Pi provider configuration is malformed or missing a complete provider route. Check its credential and routing settings."
            : authentication ? "The selected Pi account needs authentication."
            : modelUnavailable ? "The selected Pi model is unavailable for this account."
            : timedOut ? "The native Pi hello probe timed out."
            : "The selected plugin environment did not complete the native Pi hello probe and confirmed cleanup. Check its runtime, account, and model access." }] };
    }
    // Provider failures may contain credentials or private addressing.
    return { adapterType: "paperclip_runner", status: "fail", testedAt,
      checks: [{ code: "runner_hello_probe_failed", level: "error", message: "The selected plugin environment did not complete the Runner hello probe and confirmed cleanup. Check its runtime, account, and model access." }] };
  } finally {
    if (!probeStarted || cleanupConfirmed) rmSync(root, { recursive: true, force: true });
  }
}
