import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { createDb, environments, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import { canonicalNativeRuntimeContextDigest, createNativeSessionBackend, createRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary, readRunnerdArtifactBinding } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture, processAlive, stopOwnedProcessGroup } from "../../__tests__/helpers/native-restart.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { nativePiProviderPackFixture } from "./native-pi-provider-pack.test-fixture.js";
import { nativePiRemoteLaunchOptions } from "./native-pi-launch.js";
import { canonicalProviderPackDigestJson } from "./remote-provider-pack-verification.js";
import { resolveRemoteProviderPackAuthority } from "./remote-provider-pack-authority.js";
import { nativeRunnerCheckpointWriter, restoreNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { nativeSha256 } from "./canonical.js";
import * as executionDriver from "./native-runner-execution-driver.js";
import * as runner from "../../vendor/paperclip-runner/index.js";
import { createRunnerdBackend, scopedRunnerdStateRoot, sha256DirectoryTree } from "./native-session-executor.js";

// No tool calls are part of this regression. Keep the native backend, transport,
// runnerd, encrypted PostgreSQL checkpoint, pack verification and recovery real.
vi.mock("./paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    constructor(_db: unknown, readonly binding: unknown) {}
    async definitions() { return []; }
    close() {}
  },
}));

const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// The same explicitly faux facade used by runnerd-pi-resident-attach.test.ts:
// no AI credentials or model requests; actual runnerd owns the Pi session.
async function executablePack(root: string, cwd: string) {
  const { manifest } = await nativePiProviderPackFixture(root);
  const a = manifest.payload.artifacts;
  for (const [name, version] of Object.entries({ acpx: manifest.payload.pins.acpx,
    "@agentclientprotocol/claude-agent-acp": manifest.payload.pins.claudeAcp,
    "@agentclientprotocol/codex-acp": manifest.payload.pins.codexAcp, "opencode-ai": manifest.payload.pins.opencode })) {
    const file = join(root, "node_modules", name, "package.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version }));
  }
  await writeFile(join(root, a.opencodeCommand.path), `#!/bin/sh\nprintf '%s\\n' '${manifest.payload.pins.opencode}'\n`);
  await chmod(join(root, a.opencodeCommand.path), 0o700);
  await copyFile(process.execPath, join(root, a.nodeCommand.path));
  await chmod(join(root, a.nodeCommand.path), 0o700);
  await writeFile(join(root, a.piRpcExecutable.path), "// faux facade does not invoke a model\n", { mode: 0o600 });
  await writeFile(join(root, a.piRpcProxy.path), `
const readline = require("node:readline");
require("node:fs").appendFileSync(${JSON.stringify(join(cwd, "judge-provider-launches.jsonl"))}, JSON.stringify({ pid: process.pid }) + "\\n");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "initialize") result = { user: { sessionId: "pi_rpc" }, serverInfo: { name: "faux", version: "1" } };
  else if (["thread/start", "thread/resume", "thread/read"].includes(m.method)) result = {
    thread: { id: "pi-restart-fixture", sessionId: "pi-restart-fixture", cwd: ${JSON.stringify(cwd)}, turns: [] },
    model: "localFaux/faux", piNativeAdmission: { model: "localFaux/faux", piRpcThinkingLevel: "low" } };
  else if (["run.attach", "session.revalidate", "thread/close", "turn/interrupt"].includes(m.method)) result = true;
  else if (m.method === "paperclip/host_park_ready") result = { ready: true, reasons: [] };
  else if (m.method === "collaborationMode/list") result = { data: [] };
  send({ id: m.id, result });
});
`, { mode: 0o600 });
  await chmod(join(root, a.piRpcProxy.path), 0o600);
  await chmod(join(root, a.piRpcExecutable.path), 0o600);
  for (const artifact of Object.values(a)) artifact.sha256 = digest(await readFile(join(root, artifact.path)));
  manifest.payload.distDigest = sha256DirectoryTree(join(root, "dist"));
  manifest.payload.nativeProviders.pi_rpc.sha256 = sha256DirectoryTree(join(root, manifest.payload.nativeProviders.pi_rpc.path));
  manifest.payload.bridgeDigest = digest(`${a.opencodeProxy.sha256}\n${a.acpxSidecar.sha256}\n${manifest.payload.distDigest}`);
  manifest.digest = digest(canonicalProviderPackDigestJson(manifest.payload));
  await writeFile(join(root, "provider-pack.json"), JSON.stringify(manifest));
  return manifest;
}

// Keep reason: recorded production I-8h run 83473b48 after server restart:
// runner_native_pi_executable_required. This is a real DB/runner recovery check,
// not real Pi/model qualification or a production deployment claim.
describeEmbeddedPostgres("JUDGE: remote Pi adoption preserves one live provider facade process", () => {
  const environment = nativeRestartFixture();
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(["staged", "home"] as const)("recovers pi_rpc from PostgreSQL without a warm entry using its qualified %s executable", async packLocation => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "73".repeat(32));
    const f = await environment.seedRun(`PI-EXECUTABLE-${packLocation}`);
    const { companyId, agentId, runtimeRoot } = environment.current;
    const cwd = join(runtimeRoot, `pi-sandbox-${packLocation}`);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "X");
    const remoteRoot = join(cwd, ".paperclip-runtime", "paperclip-runner");
    const home = join(runtimeRoot, "pi-home");
    vi.stubEnv("HOME", home);
    const stagedPackRoot = join(remoteRoot, "provider-pack");
    const packRoot = packLocation === "home"
      ? join(home, ".local", "share", "paperclip-runner", "provider-pack") : stagedPackRoot;
    const manifest = await executablePack(packRoot, cwd);
    if (packLocation === "home") await expect(access(stagedPackRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const context = nativeRuntimeContextFixture();
    context.instructions.bundle.rootPath = cwd;
    context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
    const execution = buildNativeExecutionInput({
      provider: "pi_rpc", model: "localFaux/faux", piRpcThinkingLevel: "low",
      companyId, agentId, runId: f.runId, normalizedSessionId: f.native.normalizedSessionId,
      issue: { id: f.issueId, identifier: `NRR-PI-EXECUTABLE-${packLocation}`, title: "Recover native Pi", description: null, workMode: "standard" },
      taskPrompt: "Recover the admitted Pi session.", workspace: { id: f.native.environmentLeaseId, cwd, repoUrl: null, repoRef: null, branchName: null },
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      completionContract: { id: randomUUID(), sha256: digest("fixture"), schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Recover", criteria: [{ id: "resume", requirement: "Preserve the session" }] } },
      runtimeContext: context,
    });
    const stateDirectory = scopedRunnerdStateRoot(execution);
    const identity = { runId: f.runId, normalizedSessionId: f.native.normalizedSessionId,
      runnerInstanceId: f.native.runnerInstanceId, environmentLeaseId: f.native.environmentLeaseId,
      turnId: f.native.turnId, itemId: f.native.itemId };
    const binding = { companyId, issueId: f.issueId, runId: f.runId };
    const owner = { ...binding, authorityRunId: f.runId, bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId, controllerGeneration: 1,
      leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const artifact = readRunnerdArtifactBinding(defaultCapabilityRunnerdBinary());
    let initial: ReturnType<typeof createRunnerdCodexTransport> | undefined;
    let recoveredSession: Awaited<ReturnType<NonNullable<ReturnType<typeof createNativeSessionBackend>["recoverSession"]>>>["session"];
    let pid: number | null = null;
    let childExit: Promise<unknown> | undefined;
    const firstBackend = createNativeSessionBackend(execution, { dynamicTools: [], runnerInstanceId: identity.runnerInstanceId,
      codexTransportFactory: context => {
        initial = createRunnerdCodexTransport({ provider: "pi_rpc", piRpcThinkingLevel: "low", stateDirectory,
          baseInstructions: context?.baseInstructions, runtimeContext: execution.runtimeContext,
          runnerBinary: defaultCapabilityRunnerdBinary(), runnerArtifact: artifact, prpIdentity: identity,
          runnerFilesystemRoot: join(remoteRoot, "sessions", digest(identity.normalizedSessionId).slice(7), "filesystem"),
          runnerStateDirectory: join(remoteRoot, "sessions", digest(identity.normalizedSessionId).slice(7), "runner"),
          ...nativePiRemoteLaunchOptions(packRoot, manifest, join(remoteRoot, "sessions", digest(identity.normalizedSessionId).slice(7), "filesystem")),
          lifecyclePolicy: execution.session.lifecyclePolicy, runnerProcessReconnectGraceMs: null,
          // Own/reap the real runner directly; a detached local default launcher
          // otherwise leaves zombie-reaping to the fixture worker's parent.
          runnerProcessLauncher: spec => {
            const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd,
              env: { PATH: process.env.PATH, ...spec.environment }, detached: true, stdio: "ignore" });
            const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
              child.once("error", reject);
              child.once("exit", (code, signal) => resolve({ code, signal, stdout: "", stderr: "" }));
            });
            childExit = completion;
            return { child, processGroupId: child.pid ?? null, completion };
          },
          controlPlaneRegistration: async authority => {
            authority.setCheckpointPersistence(nativeRunnerCheckpointWriter(f.db, owner));
            await authority.flushCheckpoint();
            return registerRunnerPrpAuthority({ ...binding, authority });
          },
        });
        return initial.transport;
      },
    });
    const nativeIdentity = { companyId, agentId, issueId: f.issueId, runId: f.runId, sessionId: identity.normalizedSessionId };
    try {
      const session = await firstBackend.openSession({ identity: nativeIdentity, workingDirectory: cwd });
      const snapshot = await session.snapshot();
      pid = initial!.evidence().runnerPid;
      expect(pid).toBeGreaterThan(0);
      expect(snapshot.driverKind).toBe("pi_rpc");
      const providerLaunches = () => readFile(join(cwd, "judge-provider-launches.jsonl"), "utf8");
      const beforeProviderLaunches = await providerLaunches();
      expect(beforeProviderLaunches.trim().split("\n")).toHaveLength(1);
      const providerPid = JSON.parse(beforeProviderLaunches).pid as number;
      expect(processAlive(providerPid)).toBe(true);
      // Local launch lacks the sandbox launcher's identity marker. Record the
      // actual live process fingerprint; recovery still verifies /proc itself.
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fingerprint = `linux:${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]}`;
      await writeFile(join(remoteRoot, "sessions", digest(identity.normalizedSessionId).slice(7), "runner", "runner-process.identity"),
        `fixture_nonce\n${pid}\n${new Date().toISOString()}\n${identity.runnerInstanceId}\n${fingerprint}\n`, { mode: 0o600 });
      resolveRemoteProviderPackAuthority({ stateDirectory, reattach: false,
        binding: { companyId, agentId, workspaceId: execution.binding.executionWorkspaceId, sessionId: identity.normalizedSessionId,
          runnerInstanceId: identity.runnerInstanceId, environmentLeaseId: identity.environmentLeaseId, remoteCwd: cwd,
          providerDigest: nativeSha256(execution.provider) }, current: () => manifest, runnerArtifact: () => artifact }).verified();
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.preparedProfile, nativeExecutionInput: execution, sessionCheckpoint: snapshot } })
        .where(eq(heartbeatRuns.id, f.runId));
      const [env] = await f.db.insert(environments).values({ name: `Qualified Pi snapshot ${packLocation}`, driver: "daytona", status: "active",
        config: { platformQualificationRecorded: true }, metadata: {} }).returning();
      expect(env.metadata).toEqual({});
      await initial!.detachControllerForRestart();
      // The controller is reconstructed from DB, not the old backend/session.
      await rm(join(stateDirectory, "control-plane"), { recursive: true, force: true });
      const db = createDb(environment.current.temporary.connectionString);
      try {
        expect(await restoreNativeRunnerCheckpoint(db, binding, stateDirectory)).toBeTruthy();
        const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        const bootId = randomUUID();
        await db.update(nativeRunFinalizations).set({ controllerBootId: bootId, controllerGeneration: 2,
          leaseOwner: "successor", leaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
        // Only routing differs from a remote sandbox: connect to actual runnerd
        // over loopback. Preserve the real remote process and checkpoint driver.
        const originalDriver = executionDriver.createNativeRunnerExecutionDriver;
        vi.spyOn(executionDriver, "createNativeRunnerExecutionDriver").mockImplementation(input => originalDriver({ ...input, target: { kind: "local" } }));
        const execute = async (request: { command: string; args: string[]; cwd?: string; timeoutMs?: number; stdin?: string }) =>
          new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(resolve => {
            const child = execFile(request.command, request.args, { cwd: request.cwd, timeout: request.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
              (error, stdout, stderr) => resolve({ stdout, stderr, exitCode: error ? Number(error.code) || 1 : 0, timedOut: error?.killed ?? false }));
            child.stdin?.end(request.stdin);
          });
        const transport = vi.spyOn(runner, "createRunnerdCodexTransport");
        const backend = await createRunnerdBackend({ db, execution, runnerInstanceId: identity.runnerInstanceId,
          // A replacement controller need not contain the previous launch files.
          runnerRemoteBinaryPath: join(cwd, "absent-controller-runnerd"), runnerRemoteProviderPackPath: join(cwd, "absent-controller-pack"),
          controllerPersistence: { bootId, runnerArtifact: artifact }, runnerIngressAuthorized: true,
          runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: cwd, environmentId: env.id,
            leaseId: identity.environmentLeaseId, providerKey: "daytona", runner: { execute }, effectiveCapabilities: { runnerWebSocketIngress: true },
            sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "surviving-pi-sandbox" } } as never,
          restartRecovery: { kind: "reattach_remote_runner", runId: f.runId, leaseOwner: "successor", controllerGeneration: 2,
            providerAttempt: 1, restartKind: "hard", recoveryRequestId: null, remote: { providerLeaseId: "surviving-pi-sandbox", remoteCwd: cwd } },
        });
        const result = await backend.recoverSession!(saved.runnerProfileJson!.sessionCheckpoint as typeof snapshot, { signal: AbortSignal.timeout(30_000) });
        expect(result, `restart must select the qualified executable: ${JSON.stringify(result)}`).toMatchObject({ recovered: true });
        recoveredSession = result.session;
        expect((await recoveredSession!.snapshot()).providerSessionId).toBe(snapshot.providerSessionId);
        expect(processAlive(pid)).toBe(true);
        expect(await providerLaunches(), "adoption must not launch another provider facade").toBe(beforeProviderLaunches);
        expect(processAlive(providerPid), "the original provider facade must still be alive").toBe(true);
        console.info(JSON.stringify({ proof: "judge_single_provider_process", packLocation, runnerPid: pid, providerPid, starts: 1 }));
        expect(transport).toHaveBeenCalledOnce();
        const adoptionOptions = transport.mock.calls[0]![0];
        expect(adoptionOptions).toMatchObject({
          provider: "pi_rpc", runnerArtifact: artifact, adoptExistingRunner: { pid },
        });
        expect(adoptionOptions).not.toMatchObject(nativePiRemoteLaunchOptions(packRoot, manifest, join(remoteRoot, "sessions", digest(identity.normalizedSessionId).slice(7), "filesystem")));
        // The surviving runner owns its admitted Pi launch. Runtime-state routing
        // is retained, but no executable/proxy binding or launch profile is supplied.
        const { piRuntimeDirectory: _runtimeStateDirectory, ...launchOptions } = nativePiRemoteLaunchOptions(
          packRoot, manifest, join(remoteRoot, "sessions", digest(identity.normalizedSessionId).slice(7), "filesystem"));
        for (const key of [...Object.keys(launchOptions), "piProfile", "piLaunchProfile", "runnerPiLaunchProfile"])
          expect(adoptionOptions).not.toHaveProperty(key);
        console.info(JSON.stringify({ proof: "pi_restart_executable_selected", checkpoint: "PostgreSQL",
          provider: "pi_rpc", packLocation, runnerPidUnchanged: pid, providerSessionIdUnchanged: snapshot.providerSessionId,
          selectedPackDigest: manifest.digest, piExecutable: join(packRoot, manifest.payload.artifacts.piRpcExecutable.path) }));
      } finally {
        await recoveredSession?.close({ reason: "restart regression complete" }).catch(() => undefined);
        recoveredSession = undefined;
        await db.$client.end();
      }
    } finally {
      await recoveredSession?.close({ reason: "restart regression cleanup" }).catch(() => undefined);
      pid ??= initial?.evidence().runnerPid ?? null;
      await initial?.transport.close().catch(() => undefined);
      await stopOwnedProcessGroup(pid, remoteRoot);
      await childExit;
    }
  }, 90_000);
});
