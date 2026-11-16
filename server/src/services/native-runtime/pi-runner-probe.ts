import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { cleanupNativeSetupRuntime, createNativeSetupRuntime } from "./native-setup-evidence.js";
import { resolvePaperclipRunnerPiRpcThinkingLevel, type AdapterEnvironmentTestContext, type AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { PI_RPC_BUILTIN_THINKING_CATALOG, NativeEnvironmentProbeCleanupError, probeNativeRunnerEnvironment } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerProviderProfile, PaperclipRunnerProviderProfileError } from "./provider-profile.js";
import { resolveRemotePaperclipRunnerBinary } from "./native-codex-runner.js";
import { cachedFileSha256 } from "./off-loop-file-work.js";
import { logger } from "../../middleware/logger.js";
import { boundDiagnosticFields, summarizeDiagnosticError } from "./diagnostic-error-summary.js";
import { createNativeSshCommandRunner } from "./native-ssh-command-runner.js";
import { createNativeRunnerExecutionDriver, prepareNativeRemoteRunner } from "./native-runner-execution-driver.js";

import { nativePiRemoteLaunchOptions } from "./native-pi-launch.js";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { verifyRemoteProviderPack } from "./remote-provider-pack-verification.js";
import type { prepareRemoteProviderPackOnTarget as PrepareRemoteProviderPackOnTarget } from "./native-session-executor.js";

type NativePiProbePack = Awaited<ReturnType<typeof PrepareRemoteProviderPackOnTarget>>;

/** The setup probe's factory preparation, in the order task runs use (#17749).
 * Ask the Runner daemon first: its build-metadata inventory reads only the
 * protected manifest of each named root (paperclip-runnerd.rs: "Check only path
 * metadata at startup; no directory walk"), so a sealed image pack is admitted
 * with no pack walk, version command or upload (docker/daytona-runner/README.md:
 * "It does not scan the pack"). Any other pack keeps the full selection path. */
export async function prepareNativePiProbeRemote(input: {
  target: Parameters<typeof PrepareRemoteProviderPackOnTarget>[0]["target"];
  runner: CommandManagedRuntimeRunner;
  remoteBinary: string;
  controllerRunnerBinary: string;
  remoteRuntimeRoot: string;
  source: { configuredRoot: string | null; manifest: NativePiProbePack["manifest"] };
  requiredMode: "listen_ws" | "dial_wss";
}): Promise<NativePiProbePack> {
  const { prepareRemoteProviderPackOnTarget, createRemoteNativeArtifactPreparation } = await import("./native-session-executor.js");
  // The same roots as task runs (native-session-executor.ts providerPackRoots).
  const stagedRoot = posix.join(input.target.remoteCwd, ".paperclip-runtime", "paperclip-runner", "provider-pack");
  let inventoryInterrupted = false;
  const runner: CommandManagedRuntimeRunner = { ...input.runner, execute: async request => {
    const result = await input.runner.execute(request);
    if (request.args?.[0] === "--build-metadata" && request.args.includes("--provider-pack-root")
      && (result.timedOut || result.exitCode === null || result.signal)) inventoryInterrupted = true;
    return result;
  } };
  const artifacts = createRemoteNativeArtifactPreparation({ target: input.target, runner, remoteBinary: input.remoteBinary,
    controllerRunnerBinary: input.controllerRunnerBinary, remoteRuntimeRoot: input.remoteRuntimeRoot,
    runnerRemoteBinaryPath: process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH,
    targetPlatformArtifactVerified: true, providerPackRoots: [stagedRoot, "/opt/paperclip-runner/provider-pack"] });
  try {
    await artifacts.prepare(input.requiredMode);
  } catch (error) {
    // An interrupted probe proves no incompatibility (remote-provider-pack.ts).
    if (inventoryInterrupted) throw new Error("runner_remote_provider_verification_unavailable: Runner daemon pack inventory was interrupted", { cause: error });
    throw error;
  }
  for (const installation of artifacts.providerPackInventory()) {
    try {
      // Only an immutable root with the exact native Pi manifest is admitted here.
      const manifest = await verifyRemoteProviderPack({ runner: input.runner, cwd: input.target.remoteCwd,
        packRoot: installation.root, manifest: input.source.manifest, installation, provider: { kind: "pi_rpc" } });
      return { root: installation.root, manifest, source: "preinstalled" };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
    }
  }
  return prepareRemoteProviderPackOnTarget({ target: input.target, runner: input.runner,
    configuredProviderPackRoot: input.source.configuredRoot, manifest: input.source.manifest });
}

/** Static launch files a setup probe never needs to copy out: the staged runner
 * binary (only when its sha256 matches the shipped one) and Node's compile
 * cache. Their custody is a size + sha256 manifest kept with the evidence. */
const PROBE_RUNNER_BINARY_ENTRY = "bin/paperclip-runnerd";
const PROBE_STATIC_SYNC_EXCLUSIONS = [PROBE_RUNNER_BINARY_ENTRY, "pi/node-compile-cache"] as const;
// Lines '<size> <sha256> <path>' then 'count <n>'; any failing step exits non-zero.
const PROBE_STATIC_MANIFEST_SCRIPT = 'set -eu; root=$1; shift; cd -- "$root"; '
  + '{ for entry in "$@"; do if [ -e "$entry" ]; then find "$entry" -type f; fi; done; } | '
  + '{ n=0; while IFS= read -r f; do size=$(wc -c < "$f"); sha=$(sha256sum "$f"); '
  + 'printf "%s %s %s\\n" "$(echo $size)" "${sha%% *}" "$f"; n=$((n+1)); done; printf "count %s\\n" "$n"; }';

/** The literal step names the native transport's probe cleanup passes to
 * observeProbeCleanupStep (runnerd-codex-transport.ts). The cleanup-step log
 * line carries only one of these, or "other"; never the forwarded text. */
export type NativeProbeCleanupStep =
  | "joining native Pi retirement"
  | "confirming credential handoff"
  | "joining original probe operations"
  | "confirming physical retirement"
  | "releasing original probe authority";
const NATIVE_PROBE_CLEANUP_STEPS: ReadonlySet<string> = new Set<NativeProbeCleanupStep>([
  "joining native Pi retirement", "confirming credential handoff", "joining original probe operations",
  "confirming physical retirement", "releasing original probe authority",
]);
const CLEANUP_STEP_PREFIX = "Native probe cleanup step failed: ";
const CLEANUP_STEP_LINE = /^Native probe cleanup step failed: ([A-Za-z ]{1,64}); elapsedMs=(\d{1,12}); pass=(teardown_pass|retained_retry)$/;

/** DIAGNOSTIC (log only): reduce a transport diagnostic to the closed
 * cleanup-step fields, or null when it is not a cleanup-step line. The text is
 * matched against the fixed template; nothing from it is logged except a step
 * name from the closed set, the pass and the elapsed milliseconds. */
export function nativeProbeCleanupStepFields(message: unknown):
  { step: NativeProbeCleanupStep | "other"; pass: "teardown_pass" | "retained_retry" | "other"; elapsedMs: number | null } | null {
  if (typeof message !== "string" || !message.startsWith(CLEANUP_STEP_PREFIX)) return null;
  const match = message.length <= 256 ? CLEANUP_STEP_LINE.exec(message) : null;
  if (!match || !NATIVE_PROBE_CLEANUP_STEPS.has(match[1]!)) return { step: "other", pass: "other", elapsedMs: null };
  return { step: match[1] as NativeProbeCleanupStep, pass: match[3] as "teardown_pass" | "retained_retry", elapsedMs: Number(match[2]) };
}

export type ProbeStaticManifest = { files: { size: number; sha256: string; path: string }[] };

/** Fail closed on any short, empty-sha or foreign line (no sync, no rm). */
export function parseProbeStaticManifest(stdout: string, entries: readonly string[]): ProbeStaticManifest {
  const lines = stdout.split("\n").filter(line => line.length > 0);
  const last = /^count (\d+)$/.exec(lines.pop() ?? "");
  const files = lines.map(line => {
    const match = /^(\d+) ([0-9a-f]{64}) (.+)$/.exec(line);
    if (!match || !entries.some(entry => match[3] === entry || match[3].startsWith(`${entry}/`)) || match[3].split("/").includes(".."))
      throw new Error("native_probe_static_manifest_invalid");
    return { size: Number(match[1]), sha256: match[2], path: match[3] };
  });
  if (!last || Number(last[1]) !== files.length) throw new Error("native_probe_static_manifest_invalid");
  return { files };
}

/** The binary is excluded only on a digest match; otherwise it is evidence. */
export function probeStaticExclusions(manifest: ProbeStaticManifest, expectedRunnerSha256: string | null) {
  const found = manifest.files.find(file => file.path === PROBE_RUNNER_BINARY_ENTRY)?.sha256 ?? null;
  const match = expectedRunnerSha256 !== null && found === expectedRunnerSha256;
  const excludeEntries = PROBE_STATIC_SYNC_EXCLUSIONS.filter(entry => match || entry !== PROBE_RUNNER_BINARY_ENTRY);
  const record = [...manifest.files.map(file => `${file.size} ${file.sha256} ${file.path}`),
    `count ${manifest.files.length}`,
    `runnerd expected ${expectedRunnerSha256 ?? "unknown"} / found ${found ?? "absent"} / match ${match ? "yes" : "no"}`,
    `excluded ${excludeEntries.join(" ")}`, ""].join("\n");
  return { excludeEntries, record };
}

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
    const { resolveRemoteProviderPackSource, stageRemoteRunnerFile, createRemoteRunnerProcessLauncher, readRemoteRunnerState, syncRemoteRunnerDirectoryOut } = await import("./native-session-executor.js");
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
      const runtimeDirectory = await createNativeSetupRuntime(context.companyId);
      const remoteRoot = posix.join(target!.remoteCwd, ".paperclip-runtime", id);
      const remoteFilesystemRoot = posix.join(remoteRoot, "filesystem"), runnerStateDirectory = posix.join(remoteRoot, "runner");
      const remoteBinary = posix.join(remoteRoot, "bin", "paperclip-runnerd");
      // With no configured PI_CODING_AGENT_DIR, Pi's managed agent home would be
      // <remoteRoot>/pi/agent (pi-rpc-driver.ts:227), inside the synced root,
      // holding absolute-target links (npm, company skills) the sync-out refuses.
      // Give it a per-probe private dir BESIDE the root instead: launch material
      // only (config, links, the session's models.json); the hello session file
      // stays at <remoteRoot>/pi/<id>.jsonl and is retained as before.
      const privateAgentDir = environment.PI_CODING_AGENT_DIR ? null : posix.join(target!.remoteCwd, ".paperclip-runtime", `${id}-pi-agent`);
      const probeEnvironment = privateAgentDir ? { ...environment, PI_CODING_AGENT_DIR: privateAgentDir } : environment;
      let cleanupTransferred = false, remoteCreated = false, prepared = false;
      let pack: NativePiProbePack | undefined;
      const prepareRemote = async (requiredMode: "listen_ws" | "dial_wss") => {
        if (prepared) return;
        requireSuccess(await runner!.execute({ command: "mkdir", args: ["-p", "-m", "700", "--", remoteRoot, remoteFilesystemRoot,
          ...(privateAgentDir ? [privateAgentDir] : [])], bypassSession: true, timeoutMs: 10_000 }));
        remoteCreated = true;
        pack = await prepareNativePiProbeRemote({ target: target!, runner: runner!, remoteBinary,
          controllerRunnerBinary: runnerBinary, remoteRuntimeRoot: remoteRoot, source, requiredMode });
        prepared = true;
      };
      const cleanup = async () => {
        if (remoteCreated) {
          // DIAGNOSTIC (log only): one line per cleanup with each step's ms,
          // so the acceptance rows read retention seconds per check.
          const timing: Record<string, unknown> = { event: "native_probe_cleanup_timing", runId: id, admissionOnly };
          const started = Date.now();
          let step = "static_manifest", stepStarted = started;
          const done = (name: string) => { timing[`${step}Ms`] = Date.now() - stepStarted; step = name; stepStarted = Date.now(); };
          try {
          // Reuse the retained-backup sync-out path. A failed/partial pull must
          // never authorize removal of the sole copy. The staged runner binary
          // and Node's compile cache are static, not records: record their
          // path, size and sha256 instead of copying ~33 MB per launch.
          const listed = await runner!.execute({ command: "sh", args: ["-c", PROBE_STATIC_MANIFEST_SCRIPT,
            "paperclip-probe-static-manifest", remoteRoot, ...PROBE_STATIC_SYNC_EXCLUSIONS], bypassSession: true, timeoutMs: 60_000 });
          requireSuccess(listed);
          // cachedFileSha256 returns "sha256:<hex>" (as matchesControllerRunnerArtifact strips it).
          const expectedRunnerSha256 = await cachedFileSha256(runnerBinary)
            .then(digest => /^sha256:[0-9a-f]{64}$/.test(digest) ? digest.slice("sha256:".length) : null, () => null);
          const manifest = parseProbeStaticManifest(listed.stdout ?? "", PROBE_STATIC_SYNC_EXCLUSIONS);
          const { excludeEntries, record } = probeStaticExclusions(manifest, expectedRunnerSha256);
          Object.assign(timing, { excluded: excludeEntries, staticFiles: manifest.files.length,
            staticBytes: manifest.files.reduce((total, file) => total + file.size, 0),
            runnerdMatch: /match yes$/m.test(record) });
          done("sync_out");
          await syncRemoteRunnerDirectoryOut({ runner: runner!, sourcePath: remoteRoot,
            targetPath: join(runtimeDirectory, "remote-runtime"), mode: 0o700, excludeEntries });
          await mkdir(join(runtimeDirectory, "remote-runtime"), { recursive: true, mode: 0o700 });
          await writeFile(join(runtimeDirectory, "remote-runtime", ".excluded-static-files.txt"), record, { mode: 0o600 });
          done("evidence_commit");
          // Commit the pulled bytes to permanent evidence BEFORE remote rm.
          await cleanupNativeSetupRuntime(runtimeDirectory, true);
          done("remote_rm");
          // The remote root can hold a full Pi session history; removal shares the 60 s probe retirement budget.
          requireSuccess(await runner!.execute({ command: "rm", args: ["-rf", "--", remoteRoot, ...(privateAgentDir ? [privateAgentDir] : [])], bypassSession: true, timeoutMs: 60_000 }));
          remoteCreated = false;
          done("done");
          timing.outcome = "ok";
          } catch (error) {
            timing.outcome = "failed";
            timing.failedStep = step;
            try { timing.error = summarizeDiagnosticError(error); } catch { /* log only: never replace the real error */ }
            timing[`${step}Ms`] = Date.now() - stepStarted;
            throw error;
          } finally {
            timing.totalMs = Date.now() - started;
            try {
              const message = "Native setup probe cleanup timing";
              logger.info(boundDiagnosticFields(timing, message), message);
            } catch { /* Diagnostics must not change cleanup. */ }
          }
        }
        await cleanupNativeSetupRuntime(runtimeDirectory, true);
      };
      try {
        await prepareNativeRemoteRunner({ ...connectivity, runId: id, prepareRemote });
        if (!pack) throw new Error("Native Pi factory preparation did not return a verified pack");
        let spawned!: () => void;
        const processStarted = new Promise<void>(resolve => { spawned = resolve; });
        const runnerProcessLauncher = createRemoteRunnerProcessLauncher({ target: target!, runner: runner!, remoteBinary,
          processIdentityPath: posix.join(runnerStateDirectory, "runner-process.identity"), stateDirectory: runnerStateDirectory,
          diagnosticsDirectory: posix.join(remoteRoot, "diagnostics"), runnerInstanceId, onRunnerProcessSpawned: spawned,
          // A setup check stops a timed-out launch by its identity, then launches once more (smarty-dev#20916).
          retryTimedOutLaunchOnce: true });
        const executionDriver = createNativeRunnerExecutionDriver({ ...connectivity, binding: { companyId: context.companyId, runId: id },
          prepareRemote, processStarted,
          mapCaBundle: async sourcePath => {
            const targetPath = posix.join(remoteRoot, "bin", "runner-ca-bundle.pem");
            await stageRemoteRunnerFile({ target: target!, runner: runner!, sourcePath, targetPath, mode: 0o600 }); return targetPath;
          },
          process: { runnerProcessLauncher, runnerStateDirectory, readRunnerState: () => readRemoteRunnerState({ runner: runner!, stateDirectory: runnerStateDirectory }) } });
        return await probeNativeRunnerEnvironment({ runtimeDirectory, provider: "pi_rpc", model, admissionOnly,
          workingDirectory: target!.remoteCwd, environment: probeEnvironment, timeoutMs: 45_000,
          transportOptions: { ...executionDriver, runnerProcessLauncher, runnerBinary, runnerFilesystemRoot: remoteFilesystemRoot,
            ...nativePiRemoteLaunchOptions(pack.root, source.manifest, remoteRoot), piRpcThinkingLevel,
            externallySandboxed: target!.transport === "sandbox",
            // DIAGNOSTIC (log only): of the cleanup step lines, only the closed step
            // name, the pass and the elapsed ms are logged; never the forwarded
            // text (a transport diagnostic can carry step error text or stderr).
            onDiagnostic: (message: string) => {
              try {
                const step = nativeProbeCleanupStepFields(message);
                if (!step) return;
                const line = "Native probe cleanup step failed";
                logger.warn(boundDiagnosticFields({ event: "native_probe_cleanup_step", runId: id, admissionOnly, ...step }, line), line);
              } catch { /* log only */ }
            },
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
