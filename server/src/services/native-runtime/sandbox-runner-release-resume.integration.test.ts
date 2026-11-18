import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import https, { createServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { eq } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, vi } from "vitest";
import { completionContracts, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { readRunnerdArtifactBinding, defaultCapabilityRunnerdBinary, parseNativeExecutionInput,
  type DurableRecoveryIdentity, type RunnerProcessHandle, type RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { canonicalNativeRuntimeContextDigest } from "@paperclipai/paperclip-runner";
import { materializeAsset } from "./runtime-context.js";
import { describeEmbeddedPostgres, nativeRestartFixture, realProcessIt, fakeCodexAppServer, waitForCondition } from "../../__tests__/helpers/native-restart.js";
import { executePaperclipNativeSession, cancelNativeSession, closeIdleWarmNativeSessionsForRestart, readNativeSessionIdleWork } from "./native-session-executor.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import * as remoteWarmRecovery from "./remote-warm-session-recovery.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { SANDBOX_RUNNER_GUARDIAN_CLIENT } from "./sandbox-runner-retention.js";
import { PAPERCLIP_RUNNER_INGRESS_PORT } from "@paperclipai/adapter-utils/runner-connectivity";

const { createPrivateHostControlFixture } = await import(new URL("../../../../packages/paperclip-runner/test/support/private-host-control.ts", import.meta.url).href) as {
  createPrivateHostControlFixture(): {
    launch(spec: RunnerProcessLaunchSpec): RunnerProcessHandle;
    request(frame: Record<string, unknown>): Promise<{ id: string; status: string }>;
    close(): Promise<void>;
  };
};

// Only the sandbox-provider boundary is controlled. Core entry, exact lease
// rows, native daemon, private fd4, PRP, source authentication, run.attach,
// checkpoint/finalization and provider process are real. No environmentTask.
// SIGSTOP/SIGCONT models retained memory, NOT a real Boat VM sleep proof.
describeEmbeddedPostgres("sandbox allocation park/claim through real Core + Runner + DB", () => {
  const environment = nativeRestartFixture();
  realProcessIt.for(["cached", "idle-evicted", "controller-restart", "lost-claim", "held-claim", "unavailable-cached", "unavailable-adopted", "unproven-absence", "cancel-cached", "cancel-adopted"] as const)(
    "retains immutable Runner binding across successor lease rows: %s", { timeout: 90_000 }, async mode => {
      const adopted = mode === "idle-evicted" || mode === "controller-restart" || mode.endsWith("adopted");
      const unavailable = mode.startsWith("unavailable-");
      const cancellation = mode.startsWith("cancel-");
      const first = await environment.seedRun(`SANDBOX-RELEASE-${mode}`);
      const { db, runId, issueId, native } = first;
      const { companyId, agentId, runtimeRoot } = environment.current;
      const root = join(runtimeRoot, runId), workspace = join(root, "workspace"), home = join(root, "credential-home");
      await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true });
      await writeFile(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-fixture" }), { mode: 0o600 });
      const workspaceId = randomUUID(), environmentId = randomUUID(), leaseA = randomUUID(), allocationId = randomUUID();
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
        mode: "isolated", strategyType: "directory", name: "Sandbox release fixture", cwd: workspace });
      await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
      await db.insert(environmentLeases).values({ id: leaseA, companyId, environmentId, heartbeatRunId: runId, issueId,
        executionWorkspaceId: workspaceId, provider: "fixture:boat", providerLeaseId: allocationId, status: "active", leasePolicy: "reuse_by_environment", metadata: { remoteCwd: workspace } });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const runtimeContext = nativeRuntimeContextFixture();
      runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444, content: Buffer.from("Complete only the controlled task.\n") }]);
      runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
      const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null,
        runtimeContext, binding: { companyId, agentId, issueId, runId, executionWorkspaceId: workspaceId },
        provider: { kind: "codex", model: "fixture-model", approvalPolicy: "never" },
        task: { identifier: "SANDBOX-RELEASE", title: issue!.title, description: null, prompt: "Complete the controlled task.", workMode: "standard" },
        workspace: { cwd: workspace, repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
          lifecyclePolicy: { mode: "warm", idleTimeoutMs: mode === "idle-evicted" ? 1_000 : 60_000 } },
        completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
          contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) }, interactionResponses: [], credentialBindings: [] });
      const resultFile = join(root, "result.json"), calls = join(root, "provider-calls"), providerPidFile = join(root, "provider.pid");
      const birth = async (pid: number) => {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        return `linux:${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[19]}`;
      };
      const saveProof = async (proof: Record<string, unknown>) => {
        const directory = process.env.PAPERCLIP_SANDBOX_RETENTION_PROOF_DIR;
        if (directory) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, `${mode}.json`), `${JSON.stringify({ mode, simulation: "controlled provider + SIGSTOP/SIGCONT, not Boat VM sleep or Pi admission", ...proof }, null, 2)}\n`); }
      };
      await writeFile(resultFile, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Controlled task complete.",
        completionClaim: { contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
          criteria: execution.completionContract.contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
        evidence: [], verification: [], artifacts: [], attentionRequests: [] }));
      const runtime = join(workspace, ".paperclip-runtime", "paperclip-runner"), binary = defaultCapabilityRunnerdBinary();
      const runnerRoot = join(runtime, "sessions", createHash("sha256").update(native.normalizedSessionId).digest("hex"), "runner");
      await mkdir(join(runtime, "bin"), { recursive: true });
      await copyFile(binary, join(runtime, "bin", "paperclip-runnerd"));
      execFileSync("chmod", ["0700", join(runtime, "bin", "paperclip-runnerd")]);
      const codex = join(root, "codex");
      const quote = (s: string) => `'${s.replaceAll("'", "'\"'\"'")}'`;
      await writeFile(codex, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli 0.134.0'; exit 0; fi\necho "$$" > ${quote(providerPidFile)}\nexec ${quote(fakeCodexAppServer)} --state-file ${quote(join(root, "provider.json"))} --terminal-result-file ${quote(resultFile)} --call-log ${quote(calls)} --record-process-start --durable-turn-ids "$@"\n`, { mode: 0o700 });
      await copyFile(codex, join(runtime, "bin", "codex"));
      execFileSync("chmod", ["0700", join(runtime, "bin", "codex")]);
      const artifact = readRunnerdArtifactBinding(binary);
      let host = createPrivateHostControlFixture();
      const key = join(root, "tls.key"), certificate = join(root, "tls.crt");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
        "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
      const oldCAs = getCACertificates("default"), oldAgent = https.globalAgent;
      const certificates = [...oldCAs, await readFile(certificate, "utf8")];
      const runnerPort = PAPERCLIP_RUNNER_INGRESS_PORT;
      const tls = createServer({ key: await readFile(key), cert: await readFile(certificate) });
      const sockets = new Set<WebSocket>(), websocket = new WebSocketServer({ noServer: true });
      let listenPath = "";
      const wireEvents: Array<{ direction: string; type?: string; commandType?: string; runId?: string }> = [];
      tls.on("upgrade", (request, socket, head) => {
        if (request.headers["x-fixture-token"] !== "synthetic-ingress") { socket.destroy(); return; }
        websocket.handleUpgrade(request, socket, head, front => {
          const back = new WebSocket(`ws://127.0.0.1:${runnerPort}${listenPath}`, { perMessageDeflate: false });
          sockets.add(front); sockets.add(back); const queued: Array<{ data: RawData; binary: boolean }> = [];
          const record = (direction: string, bytes: RawData) => { try {
            const value = JSON.parse(bytes.toString()); wireEvents.push({ direction, type: value.kind, commandType: value.payload?.commandType ?? value.payload?.type,
              runId: value.runId ?? value.payload?.runId });
          } catch { /* native transport validates the wire */ } };
          front.on("message", (data, binary) => { record("core", data); if (back.readyState === WebSocket.OPEN) back.send(data, { binary }); else queued.push({ data, binary }); });
          back.on("open", () => { for (const { data, binary } of queued) back.send(data, { binary }); });
          back.on("message", (data, binary) => { record("runner", data); if (front.readyState === WebSocket.OPEN) front.send(data, { binary }); });
          front.on("close", () => { sockets.delete(front); back.terminate(); }); back.on("close", () => { sockets.delete(back); front.terminate(); });
          front.on("error", () => back.terminate()); back.on("error", () => front.terminate());
        });
      });
      await new Promise<void>(done => tls.listen(0, "127.0.0.1", done));
      const tlsAddress = tls.address(); if (!tlsAddress || typeof tlsAddress === "string") throw new Error("Fixture ingress unavailable");
      let handle: RunnerProcessHandle | undefined, launches = 0, stopped = false;
      let currentLease: string = leaseA;
      const releases: DurableRecoveryIdentity[] = [], claims: DurableRecoveryIdentity[] = [], releasedLeaseRows: string[] = [], claimFrames: string[] = [];
      const commandRows: string[] = [], commands: string[] = [];
      let lost = false, claimHeld!: () => void, releaseClaim!: () => void;
      const held = new Promise<void>(done => { claimHeld = done; });
      const claimReply = new Promise<void>(done => { releaseClaim = done; });
      let pendingFollowup: ReturnType<typeof executePaperclipNativeSession> | undefined;
      let pendingStop: ReturnType<typeof cancelNativeSession> | undefined;
      const state = async () => JSON.parse(await readFile(join(runnerRoot, "runner-state.json"), "utf8"));
      const runner = (leaseId: string): CommandManagedRuntimeRunner => ({
        execute: async input => {
          expect(stopped).toBe(false); expect(leaseId).toBe(currentLease); commandRows.push(leaseId);
          commands.push(`${input.command} ${(input.args ?? []).join(" ")}`.slice(0, 180));
          return new Promise((done, fail) => {
            const child = execFile(input.command, [...input.args ?? []], { cwd: input.cwd, env: { PATH: process.env.PATH, ...input.env },
              timeout: input.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error && typeof error.code !== "number") { fail(error); return; }
              done({ exitCode: typeof error?.code === "number" ? error.code : 0, signal: error?.signal ?? null,
                timedOut: !!error?.killed, stdout, stderr, pid: child.pid ?? null, startedAt: new Date().toISOString() });
            });
            if (input.stdin !== undefined) child.stdin?.end(input.stdin);
          });
        },
        openDuplexChannel: async input => {
          expect(input.command).toEqual([SANDBOX_RUNNER_GUARDIAN_CLIENT, "client", "--protocol", "1", "--runner-id", native.runnerInstanceId]);
          expect(input).not.toHaveProperty("env"); expect(leaseId).toBe(currentLease); expect(stopped).toBe(false);
          let data: (bytes: Uint8Array) => void = () => {}, exit: (event: { exitCode: number | null; transportClosed?: boolean }) => void = () => {};
          return { onData: cb => { data = cb; }, onExit: cb => { exit = cb; }, close: async () => {}, stop: () => {},
            write: bytes => { void (async () => {
              const frame = JSON.parse(Buffer.from(bytes).toString());
              console.info("guardian-fixture-op", frame.op);
              let reply: Record<string, unknown>;
              if (frame.op === "qualify") {
                const metadata = JSON.parse(execFileSync(frame.runnerBinary, ["--build-metadata"], { encoding: "utf8" }));
                expect(metadata.privateHostControlVersion).toBe(1);
                expect(frame.runnerDigest).toBe(artifact.digest);
                reply = { id: frame.id, status: "qualified", guardianVersion: 1, privateHostControlVersion: metadata.privateHostControlVersion,
                  runnerBinary: frame.runnerBinary, runnerDigest: artifact.digest };
              } else if (frame.op === "launch") {
                if (handle?.isExitConfirmed?.()) host = createPrivateHostControlFixture();
                launches++;
                const args = [...frame.args];
                listenPath = args[args.indexOf("--listen-path") + 1]!;
                handle = host.launch({ command: frame.command, args, cwd: frame.cwd, environment: frame.environment,
                  nativeRunner: { connection: { mode: "listen" } } } as unknown as RunnerProcessLaunchSpec);
                await waitForCondition("real guardian native pid", () => !!handle!.child.pid);
                const pid = handle.child.pid!, stat = await readFile(`/proc/${pid}/stat`, "utf8");
                const birth = `linux:${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[19]}`;
                await mkdir(dirname(frame.identityPath), { recursive: true });
                await writeFile(frame.identityPath, `${frame.identityNonce}\n${pid}\n${handle.startedAt}\n${native.runnerInstanceId}\n${birth}\n`, { mode: 0o600 });
                reply = { id: frame.id, status: "launched" };
              } else if (frame.op === "observe") {
                const live = await state();
                reply = { id: frame.id, status: "observed", identity: Object.fromEntries(Object.keys(frame.identity).map(k => [k, live[k]])),
                  lastControllerCommandSeq: live.lastControllerCommandSeq, ackedSourceSeq: live.ackedSourceSeq };
              } else if (frame.op === "claim" && (unavailable || mode === "unproven-absence") && !lost) {
                // The guardian has an exact retirement receipt, not a guessed
                // absence. It waits for the native process and descendants.
                lost = true;
                const before = await state();
                const retired = await host.request({ op: "retire", id: `absent_${frame.id}`, parkId: frame.parkId });
                expect(retired.status).toBe("retired");
                await host.close();
                wireEvents.push({ direction: "guardian", type: "absent", runId: releases[0]!.runId });
                reply = { id: frame.id, status: "absent", identity: releases[0], executionStopped: true, descendantsStopped: true,
                  sessionStateAvailable: mode !== "unproven-absence", lastControllerCommandSeq: before.lastControllerCommandSeq, ackedSourceSeq: before.ackedSourceSeq };
              } else {
                reply = await host.request(frame);
                if (frame.op === "park" && reply.status === "parked") releases.push(frame.identity);
                if (frame.op === "claim" && reply.status === "claimed") {
                  claimFrames.push(JSON.stringify(frame));
                  if (mode === "lost-claim" && !lost) { lost = true; exit({ exitCode: 1, transportClosed: true }); return; }
                  claims.push(releases.at(-1)!);
                  wireEvents.push({ direction: "guardian", type: "claimed", runId: releases.at(-1)!.runId });
                  if (mode === "held-claim") await new Promise(done => setTimeout(done, 200));
                  if (cancellation) { claimHeld(); await claimReply; }
                }
                if (frame.op === "retire" && reply.status === "retired") {
                  await host.close(); reply = { ...reply, executionStopped: true, descendantsStopped: true, sessionStateAvailable: true };
                }
              }
              data(Buffer.from(`${JSON.stringify(reply)}\n`));
            })().catch(error => { console.info("guardian-fixture-error", error); exit({ exitCode: 1, transportClosed: true }); }); },
          };
        },
      });
      const supervisor = async () => {
        for (const file of await readdir(join(resolvePaperclipInstanceRoot(), "runtime/paperclip-runner/sessions"))) {
          const envelope = JSON.parse(await readFile(join(resolvePaperclipInstanceRoot(), "runtime/paperclip-runner/sessions", file), "utf8"));
          if (envelope.snapshot?.identity.sessionId === native.normalizedSessionId) return envelope;
        }
        throw new Error("Fixture supervisor record unavailable");
      };
      const execute = async (current: typeof execution, leaseId: string) => {
        currentLease = leaseId;
        await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: current }, runnerInstanceId: native.runnerInstanceId,
          completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256, nativeSessionId: current.session.normalizedSessionId })
          .where(eq(heartbeatRuns.id, current.binding.runId));
        return executePaperclipNativeSession({ db, execution: current, runnerInstanceId: native.runnerInstanceId, useRunnerd: true, runnerIngressAuthorized: true,
          runnerRemoteBinaryPath: binary, runnerRemoteCodexPath: codex,
          onLog: async (stream, text) => { console.info("sandbox-native-log", stream, text.slice(0, 300)); },
          managedAiCredentialHome: home, managedAiCredentialIdentity: "fixture-revision", managedAiAccountIdentity: "fixture-account", turnTimeoutMs: 15_000,
          runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: workspace, environmentId, leaseId, providerKey: "fixture:boat",
            runner: runner(leaseId), runnerGuardian: { version: 1 },
            effectiveCapabilities: { reusableLeases: true, duplexCommandStream: true, runnerWebSocketIngress: true, nativeSyncIn: false,
              nativeSyncOut: false, persistentProcessSessions: false, independentControlCommands: false, incrementalSessionOutput: false, concurrentSyncOperations: false },
            getRunnerIngressEndpoint: async ({ path }) => { listenPath = path; return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${tlsAddress.port}/runner`,
              secretHeaders: [{ name: "X-Fixture-Token", value: "synthetic-ingress" }], generation: leaseId,
              close: async () => {}, refresh: async () => { throw new Error("Fixture ingress refresh not expected"); } }; },
            runnerLeaseLifecycle: { releaseLease: async () => {
              expect(leaseId).toBe(currentLease); expect(releases.at(-1)?.runId).toBe(current.binding.runId);
              process.kill(handle!.child.pid!, "SIGSTOP"); stopped = true; releasedLeaseRows.push(leaseId);
              await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success" }).where(eq(environmentLeases.id, leaseId));
            }, resumeLease: async () => { expect(leaseId).toBe(currentLease); process.kill(handle!.child.pid!, "SIGCONT"); stopped = false; return "resumed"; } },
            sandboxLeaseAcquisition: { outcome: leaseId === leaseA ? "created" : "resumed", providerLeaseId: allocationId } } });
      };
      const adoption = vi.spyOn(remoteWarmRecovery, "inspectRemoteWarmSessionRecovery");
      const debug = setTimeout(() => console.info("sandbox-fixture-progress", { commands: commands.slice(-15), launches, releases: releases.length, claims: claims.length, stopped }), 20_000);
      try {
        setDefaultCACertificates(certificates); https.globalAgent = new https.Agent({ ca: certificates });
        expect(await execute(execution, leaseA)).toMatchObject({ exitCode: 0, timedOut: false });
        await waitForCondition("automatic sandbox release A", async () => stopped && releasedLeaseRows.length === 1 && !!(await supervisor()).releasedRunner);
        expect((await supervisor()).releasedRunner).toMatchObject({ kind: "sandbox", source: releases[0], taskId: allocationId });
        const pid = handle!.child.pid!, providerSessionId = (await supervisor()).snapshot.providerSessionId;
        const statA = await readFile(`/proc/${pid}/stat`, "utf8");
        const daemonBirthA = await birth(pid), providerPidA = Number(await readFile(providerPidFile, "utf8")), providerBirthA = await birth(providerPidA);
        const probeCount = commandRows.length;
        if (mode === "idle-evicted") await new Promise(done => setTimeout(done, 1_300));
        else if (adopted) expect(await closeIdleWarmNativeSessionsForRestart()).toEqual({ closed: 1, busy: 0, failed: 0 });
        else await new Promise(done => setTimeout(done, 600));
        expect(commandRows).toHaveLength(probeCount); expect(handle!.isExitConfirmed?.()).toBe(false);
        expect(readNativeSessionIdleWork()).toBe("none");
        await reconcileNativeFinalizations(db, [runId]);
        const runB = randomUUID(), leaseB = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runB, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native" });
        await db.insert(nativeRunFinalizations).values({ runId: runB, companyId, issueId, phase: "observed" });
        await db.update(issues).set({ executionRunId: runB, status: "in_progress" }).where(eq(issues.id, issueId));
        await db.update(environmentLeases).set({ status: "expired" }).where(eq(environmentLeases.id, leaseA));
        await db.insert(environmentLeases).values({ id: leaseB, companyId, environmentId, heartbeatRunId: runB, issueId, executionWorkspaceId: workspaceId,
          provider: "fixture:boat", providerLeaseId: allocationId, status: "active", leasePolicy: "reuse_by_environment", metadata: { remoteCwd: workspace } });
        pendingFollowup = execute({ ...execution, binding: { ...execution.binding, runId: runB } }, leaseB);
        void pendingFollowup.catch(() => undefined);
        if (cancellation) {
          await held;
          pendingStop = cancelNativeSession(runB, "Stop sandbox retained claim", { db });
          void pendingStop.catch(() => undefined);
          await waitForCondition("durable sandbox cancellation intent", async () => Boolean((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runB)))[0]?.resultJson?.nativeCancellation));
          releaseClaim();
          expect(await pendingFollowup.catch(error => error)).toBeInstanceOf(Error);
          await pendingStop.catch(() => undefined);
          await waitForCondition("guardian confirmed cancelled retained Runner stop", () => handle!.isExitConfirmed?.() === true);
          expect(handle!.isExitConfirmed?.()).toBe(true);
          expect(releasedLeaseRows).toEqual([leaseA]); expect(launches).toBe(1);
          expect((await readFile(calls, "utf8")).split(/\r?\n/).filter(method => method === "turn/start")).toHaveLength(1);
          expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runB))).toHaveLength(0);
          expect((await supervisor()).releasedRunner?.source.runId).not.toBe(runB);
          await saveProof({ runA: runId, runB, leaseA, leaseB, allocationId, releases, claims, launches, providerSessionId,
            daemonPid: pid, providerPid: providerPidA, providerBirth: providerBirthA, stopped: handle!.isExitConfirmed?.(), ordinaryTurns: 1 });
          return;
        }
        if (mode === "unproven-absence") {
          expect(await pendingFollowup.catch(error => error)).toBeInstanceOf(Error);
          expect(launches).toBe(1); expect(releasedLeaseRows).toEqual([leaseA]);
          expect((await readFile(calls, "utf8")).split(/\r?\n/).filter(method => method === "process-start")).toHaveLength(1);
          expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runB))).toHaveLength(0);
          await saveProof({ runA: runId, runB, leaseA, leaseB, allocationId, releases, claims, launches, replacementRefused: true });
          return;
        }
        expect(await pendingFollowup).toMatchObject({ exitCode: 0, timedOut: false });
        await waitForCondition("automatic sandbox release B", async () => stopped && releasedLeaseRows.length === 2 && (await supervisor()).releasedRunner?.source.runId === runB);
        expect(releasedLeaseRows).toEqual([leaseA, leaseB]); expect(releases[0]!.environmentLeaseId).toBe(workspaceId);
        expect(releases[1]!.environmentLeaseId).toBe(workspaceId); expect(releases[1]!.runId).toBe(runB);
        expect((await supervisor()).releasedRunner).toMatchObject({ kind: "sandbox", source: releases[1], taskId: allocationId });
        expect((await supervisor()).snapshot.providerSessionId).toBe(providerSessionId);
        const providerPidB = Number(await readFile(providerPidFile, "utf8")), providerBirthB = await birth(providerPidB);
        if (unavailable) expect(providerPidB).not.toBe(providerPidA);
        else { expect(providerPidB).toBe(providerPidA); expect(providerBirthB).toBe(providerBirthA); }
        const claimStart = wireEvents.findIndex(event => event.direction === "guardian");
        const followupWire = wireEvents.slice(claimStart);
        // PRP v3 encrypts commands after the visible authentication exchange;
        // never decode or log its ticket/secure channel merely to inspect them.
        const authenticatedSource = followupWire.findIndex(event => event.direction === "core" && event.type === "auth_challenge" && event.runId === runId);
        const authenticatedTarget = followupWire.findIndex(event => event.direction === "core" && event.type === "auth_challenge" && event.runId === runB);
        expect(authenticatedSource).toBeGreaterThanOrEqual(0); expect(authenticatedTarget).toBeGreaterThan(authenticatedSource);
        expect((await state()).runId).toBe(runB);
        expect(launches).toBe(unavailable ? 2 : 1);
        if (unavailable) expect(handle!.child.pid).not.toBe(pid);
        else {
          expect(handle!.child.pid).toBe(pid);
          expect((await readFile(`/proc/${pid}/stat`, "utf8")).slice(statA.lastIndexOf(") ") + 2).split(/\s+/)[19]).toBe(statA.slice(statA.lastIndexOf(") ") + 2).split(/\s+/)[19]);
        }
        expect(claims).toEqual(unavailable ? [] : [releases[0]]);
        expect(adoption).toHaveBeenCalledTimes(adopted ? 1 : 0);
        if (mode === "lost-claim") { expect(claimFrames).toHaveLength(2); expect(claimFrames[0]).toBe(claimFrames[1]); }
        const methods = (await readFile(calls, "utf8")).trim().split(/\r?\n/);
        expect(methods.filter(m => m === "process-start")).toHaveLength(unavailable ? 2 : 1); expect(methods.filter(m => m === "turn/start")).toHaveLength(2);
        expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runB)))[0]).toMatchObject({ schemaStatus: "accepted" });
        expect(JSON.stringify((await supervisor()).releasedRunner)).not.toContain("bootstrapTicket");
        // A third heartbeat rebinds the monitor of an adopted controller too;
        // A->B alone would miss that controller retaining B's command closure.
        await reconcileNativeFinalizations(db, [runB]);
        const runC = randomUUID(), leaseC = randomUUID(), daemonPidB = handle!.child.pid!, daemonBirthB = await birth(daemonPidB);
        await db.insert(heartbeatRuns).values({ id: runC, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native" });
        await db.insert(nativeRunFinalizations).values({ runId: runC, companyId, issueId, phase: "observed" });
        await db.update(issues).set({ executionRunId: runC, status: "in_progress" }).where(eq(issues.id, issueId));
        await db.update(environmentLeases).set({ status: "expired" }).where(eq(environmentLeases.id, leaseB));
        await db.insert(environmentLeases).values({ id: leaseC, companyId, environmentId, heartbeatRunId: runC, issueId, executionWorkspaceId: workspaceId,
          provider: "fixture:boat", providerLeaseId: allocationId, status: "active", leasePolicy: "reuse_by_environment", metadata: { remoteCwd: workspace } });
        pendingFollowup = execute({ ...execution, binding: { ...execution.binding, runId: runC } }, leaseC);
        expect(await pendingFollowup).toMatchObject({ exitCode: 0, timedOut: false });
        await waitForCondition("automatic sandbox release C", async () => stopped && releasedLeaseRows.length === 3 && (await supervisor()).releasedRunner?.source.runId === runC);
        expect(handle!.child.pid).toBe(daemonPidB); expect(await birth(daemonPidB)).toBe(daemonBirthB);
        expect(Number(await readFile(providerPidFile, "utf8"))).toBe(providerPidB); expect(await birth(providerPidB)).toBe(providerBirthB);
        expect((await supervisor()).snapshot.providerSessionId).toBe(providerSessionId); expect(launches).toBe(unavailable ? 2 : 1);
        expect(releases[2]!.environmentLeaseId).toBe(workspaceId); expect(claims.at(-1)).toEqual(releases[1]);
        expect(releasedLeaseRows).toEqual([leaseA, leaseB, leaseC]);
        expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runC)))[0]).toMatchObject({ schemaStatus: "accepted" });
        await saveProof({ runA: runId, runB, runC, leaseA, leaseB, leaseC, allocationId, workspaceId, releases, claims, launches,
          daemonPidA: pid, daemonBirthA, daemonPidB, daemonBirthB, providerPidA, providerBirthA, providerPidB, providerBirthB, providerSessionId,
          sourceChallengeBeforeTargetChallenge: true, targetRunResultAccepted: true, noStoppedAllocationExecs: true,
          wireEvents: wireEvents.slice(claimStart).filter(event => event.type !== undefined) });
      } catch (error) {
        console.info("sandbox-entry-fixture", { launches, releases: releases.length, claims: claims.length, stopped, wireEvents: wireEvents.slice(-30), live: await state().catch(() => null) });
        throw error;
      } finally {
        clearTimeout(debug);
        releaseClaim();
        await pendingFollowup?.catch(() => undefined); await pendingStop?.catch(() => undefined);
        if (stopped && handle?.child.pid) { process.kill(handle.child.pid, "SIGCONT"); stopped = false; }
        await closeIdleWarmNativeSessionsForRestart().catch(() => undefined);
        execFileSync("chmod", ["-R", "u+w", workspace]);
        await host.close().catch(() => undefined);
        for (const socket of sockets) socket.terminate(); websocket.close(); tls.closeAllConnections();
        await new Promise<void>(done => tls.close(() => done()));
        setDefaultCACertificates(oldCAs); https.globalAgent = oldAgent; adoption.mockRestore();
      }
    });
});
