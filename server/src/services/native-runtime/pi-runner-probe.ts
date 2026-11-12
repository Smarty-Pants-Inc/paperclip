import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { resolvePaperclipRunnerPiRpcThinkingLevel, type AdapterEnvironmentTestContext, type AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { PI_RPC_BUILTIN_THINKING_CATALOG, NativeEnvironmentProbeCleanupError, probeNativeRunnerEnvironment } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerProviderProfile, PaperclipRunnerProviderProfileError } from "./provider-profile.js";
import { resolveRemotePaperclipRunnerBinary } from "./native-codex-runner.js";
import { createNativeSshCommandRunner } from "./native-ssh-command-runner.js";
import { createNativeRunnerExecutionDriver, prepareNativeRemoteRunner } from "./native-runner-execution-driver.js";
import { nativePiRemoteLaunchOptions } from "./native-pi-launch.js";

const SAFE_FAILURES: Record<string, string> = {
  pi_prompt_rejected: "Pi handled or rejected hello without starting a model turn.",
  pi_probe_cleanup_unconfirmed: "Pi hello retirement failed; the connection was not adopted.",
  pi_probe_stream_ended: "Pi ended the hello stream before a settled successful response.",
  pi_probe_session_missing: "Pi returned no native session identity.",
  pi_probe_model_mismatch: "Pi returned a missing or mismatched model/session identity.",
  pi_probe_thinking_mismatch: "Pi did not acknowledge the selected thinking level.",
  pi_probe_session_mismatch: "Pi returned a stale or mismatched run/session reply.",
  pi_probe_turn_mismatch: "Pi returned a stale or mismatched turn reply.",
  pi_probe_session_failed: "The selected Pi session failed during hello.",
  pi_probe_tool_used: "Pi used a tool instead of completing the tool-free hello.",
  pi_probe_turn_failed: "Pi failed or interrupted the hello turn.",
  pi_probe_empty_response: "Pi settled hello without a nonempty final assistant response.",
  pi_native_pack_unavailable: "The selected factory has no qualified native Pi distribution. No hello was sent.",
};

/** Metadata is a separate no-inference session; only a retired L4b hello passes. */
export async function probeManagedNativePiRunner(context: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  const checks: AdapterEnvironmentTestResult["checks"] = [];
  let stage = "metadata";
  try {
    // Reuse exact model/profile/config admission; capability caps belong to config.
    const profile = resolvePaperclipRunnerProviderProfile(context.config, { companyId: context.companyId });
    const model = profile.model;
    if (profile.provider !== "pi_rpc" || !model || model !== context.config.model) throw new Error("Pi needs an unchanged explicit model ID");
    const piRpcThinkingLevel = resolvePaperclipRunnerPiRpcThinkingLevel("pi_rpc", context.config.piRpcThinkingLevel, context.config.model, context.config.thinkingLevelMap, PI_RPC_BUILTIN_THINKING_CATALOG);
    const environment = Object.fromEntries(Object.entries(context.config.env as Record<string, unknown> ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const target = context.executionTarget;
    if (target?.kind !== "remote" || target.transport === "sandbox" && target.runnerTask) throw new Error("Native Pi setup requires a remote command factory");
    const runner = target.transport === "ssh" ? createNativeSshCommandRunner({ spec: target.spec, defaultCwd: target.remoteCwd }) : target.runner;
    if (!runner) throw new Error("The selected factory has no process runner");
    const { resolveRemoteProviderPackSource, prepareRemoteProviderPackOnTarget, stageRemoteRunnerFile, createRemoteRunnerProcessLauncher, readRemoteRunnerState } = await import("./native-session-executor.js");
    const source = resolveRemoteProviderPackSource(process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH);
    // Validate native entries before staging or acquiring an inference authority.
    nativePiRemoteLaunchOptions("/unused", source.manifest, "/unused");
    const runnerBinary = await resolveRemotePaperclipRunnerBinary({ runner, remoteCwd: target.remoteCwd,
      configuredPath: process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH });
    const connectivity = { target, runnerIngressAuthorized: true,
      runnerPublicUrl: process.env.PAPERCLIP_RUNNER_PUBLIC_URL?.trim() || null,
      runnerCaBundlePath: process.env.PAPERCLIP_RUNNER_CA_BUNDLE_PATH?.trim() || null };
    const requireSuccess = (result: { timedOut: boolean; exitCode: number | null }) => {
      if (result.timedOut || result.exitCode !== 0) throw new Error("Pi setup could not prepare or clean its private factory runtime");
    };
    const probe = async (admissionOnly: boolean) => {
      const id = `setup-${randomUUID()}`, runnerInstanceId = `runner-${id}`;
      const runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), "paperclip-native-pi-setup-")));
      const remoteRoot = posix.join(target!.remoteCwd, ".paperclip-runtime", id);
      const remoteFilesystemRoot = posix.join(remoteRoot, "filesystem"), runnerStateDirectory = posix.join(remoteRoot, "runner");
      const remoteBinary = posix.join(remoteRoot, "bin", "paperclip-runnerd");
      let cleanupTransferred = false, remoteCreated = false, prepared = false;
      let pack: Awaited<ReturnType<typeof prepareRemoteProviderPackOnTarget>> | undefined;
      const prepareRemote = async () => {
        if (prepared) return;
        requireSuccess(await runner!.execute({ command: "mkdir", args: ["-p", "-m", "700", "--", remoteRoot, remoteFilesystemRoot], bypassSession: true, timeoutMs: 10_000 }));
        remoteCreated = true;
        pack = await prepareRemoteProviderPackOnTarget({ target: target!, runner: runner!, configuredProviderPackRoot: source.configuredRoot, manifest: source.manifest });
        await stageRemoteRunnerFile({ target: target!, runner: runner!, sourcePath: runnerBinary, targetPath: remoteBinary, mode: 0o700 });
        prepared = true;
      };
      const cleanup = async () => {
        if (remoteCreated) requireSuccess(await runner!.execute({ command: "rm", args: ["-rf", "--", remoteRoot], bypassSession: true, timeoutMs: 10_000 }));
        await rm(runtimeDirectory, { recursive: true, force: true });
      };
      try {
        await prepareNativeRemoteRunner({ ...connectivity, runId: id, prepareRemote });
        if (!pack) throw new Error("Native Pi factory preparation did not return a verified pack");
        let spawned!: () => void;
        const processStarted = new Promise<void>(resolve => { spawned = resolve; });
        const runnerProcessLauncher = createRemoteRunnerProcessLauncher({ target: target!, runner: runner!, remoteBinary,
          processIdentityPath: posix.join(runnerStateDirectory, "runner-process.identity"), stateDirectory: runnerStateDirectory,
          diagnosticsDirectory: posix.join(remoteRoot, "diagnostics"), runnerInstanceId, onRunnerProcessSpawned: spawned });
        const executionDriver = createNativeRunnerExecutionDriver({ ...connectivity, binding: { companyId: context.companyId, runId: id },
          prepareRemote, processStarted,
          mapCaBundle: async sourcePath => {
            const targetPath = posix.join(remoteRoot, "bin", "runner-ca-bundle.pem");
            await stageRemoteRunnerFile({ target: target!, runner: runner!, sourcePath, targetPath, mode: 0o600 }); return targetPath;
          },
          process: { runnerProcessLauncher, runnerStateDirectory, readRunnerState: () => readRemoteRunnerState({ runner: runner!, stateDirectory: runnerStateDirectory }) } });
        return await probeNativeRunnerEnvironment({ runtimeDirectory, provider: "pi_rpc", model, admissionOnly,
          workingDirectory: target!.remoteCwd, environment, timeoutMs: 45_000,
          transportOptions: { ...executionDriver, runnerProcessLauncher, runnerBinary, runnerFilesystemRoot: remoteFilesystemRoot,
            ...nativePiRemoteLaunchOptions(pack.root, source.manifest, remoteRoot), piRpcThinkingLevel,
            externallySandboxed: target!.transport === "sandbox",
            prpIdentity: { runnerInstanceId, runId: id, normalizedSessionId: id,
              environmentLeaseId: target!.transport === "sandbox" && target!.leaseId ? target!.leaseId : id, turnId: `turn-${id}`, itemId: `item-${id}` } },
          onCleanupConfirmed: cleanup,
        });
      } catch (error) {
        if (error instanceof NativeEnvironmentProbeCleanupError) { cleanupTransferred = true; throw error; }
        throw error;
      } finally {
        // The transport alone owns post-dispatch physical retirement. A pending
        // cleanup keeps the lease/root with its retained owner, never local success.
        if (!cleanupTransferred) await cleanup();
      }
    };
    const metadata = await probe(true);
    if (!metadata.sessionAdmissionPassed || metadata.helloProbePassed || metadata.providerDriver !== "pi_rpc" || metadata.effectiveModel !== model || !metadata.piMetadata) {
      throw new Error("Pi metadata admission was incomplete; hello was not sent");
    }
    checks.push({ code: "pi_rpc_metadata_verified", level: "info", message: "The selected factory reported the qualified Pi version, provider list and credential shape. No model prompt was sent.",
      detail: JSON.stringify(metadata.piMetadata) });
    stage = "hello";
    const hello = await probe(false);
    if (hello.providerDriver !== "pi_rpc" || hello.effectiveModel !== model || !hello.helloProbePassed) throw new Error("Pi hello did not prove a nonempty retired response");
    checks.push({ code: "pi_hello_probe_passed", level: "info", message: "Native Pi completed a tool-free hello using the selected factory, managed connection, exact model and thinking level, and retired successfully." });
    return { adapterType: "paperclip_runner", testedAt, status: "pass", checks };
  } catch (error) {
    if (error instanceof NativeEnvironmentProbeCleanupError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    // No raw provider error, argv, environment, request body or credential is reflected.
    const message = error instanceof PaperclipRunnerProviderProfileError ? error.message : SAFE_FAILURES[code]
      ?? (stage === "hello" ? "Native Pi did not prove a nonempty tool-free hello and successful retirement. The connection was not adopted." : "The selected factory could not complete native Pi metadata admission. No hello prompt was sent.");
    checks.push({ code: stage === "hello" ? "pi_hello_probe_failed" : "pi_rpc_metadata_failed", level: "error", message });
    return { adapterType: "paperclip_runner", testedAt, status: "fail", checks };
  }
}
