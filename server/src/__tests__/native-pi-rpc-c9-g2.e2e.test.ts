import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import https, { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { and, eq, sql } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it, vi } from "vitest";
import {
  agents, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { PAPERCLIP_RUNNER_INGRESS_PORT, type RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { canonicalNativeRuntimeContextDigest, configuredEnvironmentProjection } from "../vendor/paperclip-runner/index.js";
import { registerLocalRuntimeApiServer } from "../runtime-api.js";
import { environmentService } from "../services/environments.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import {
  closeWarmNativeSessionsForEnvironment, executePaperclipNativeSession, cancelNativeSession,
  reserveWarmNativeInstructionDirectory, type NativeInstructionWorkingCopy,
} from "../services/native-runtime/native-session-executor.js";
import { currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import {
  buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget,
} from "../services/native-runtime/native-session-resume.js";
import { materializeAsset } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: the real runnerd/Pi -> durable result -> managed follow-up ->
// executor refusal -> stranded-message sweep boundary. Only allocation and the
// loopback Messages provider are scripted. No executor or notice writer is mocked.
// This is a simulated sandbox, not qualification of Boat or a live model.
const allocation = vi.hoisted(() => ({ drivers: undefined as import("../services/environment-runtime.js").EnvironmentRuntimeDriver[] | undefined }));
vi.mock("../services/environment-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-runtime.js")>();
  return { ...actual, environmentRuntimeService: (db: Parameters<typeof actual.environmentRuntimeService>[0],
    options: Parameters<typeof actual.environmentRuntimeService>[1]) => actual.environmentRuntimeService(db,
      { ...options, drivers: allocation.drivers ?? options?.drivers }) };
});
const enabled = process.env.PAPERCLIP_PI_LEASE_E2E === "1" && process.env.PAPERCLIP_PI_C9_G2_E2E === "1";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
type Birth = { pid: number; ppid: number; startTicks: string; command: string; bootId: string };
function birth(pid: number): Birth | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return { pid, ppid: Number(fields[1]), startTicks: fields[19]!,
      command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "),
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
  } catch { return null; }
}
function sameBirth(expected: Birth): boolean {
  const current = birth(expected.pid);
  return current !== null && current.startTicks === expected.startTicks && current.bootId === expected.bootId;
}
function ownedPi(runner: Birth): Birth | null {
  const processes = new Map<number, Birth>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const current = birth(Number(name)); if (current) processes.set(current.pid, current);
  }
  for (const current of processes.values()) {
    let parent = current.ppid;
    const seen = new Set<number>();
    while (parent !== runner.pid && processes.has(parent) && !seen.has(parent)) {
      seen.add(parent); parent = processes.get(parent)!.ppid;
    }
    const comm = (() => { try { return readFileSync(`/proc/${current.pid}/comm`, "utf8").trim(); } catch { return ""; } })();
    if (parent === runner.pid && (comm === "pi" || current.command.includes("--mode rpc") && current.command.includes("cli.js"))) return current;
  }
  return null;
}

it.skipIf(!enabled)("C9 G2: the first real refusal after a committed good managed turn is visible", async () => {
  expect(process.platform).toBe("linux");
  expect(process.env.TMPDIR, "dedicated harness TMPDIR is required").toBeTruthy();
  const runnerBinary = process.env.PAPERCLIP_RUNNER_BINARY ?? process.env.PAPERCLIP_RUNNERD_PATH;
  const providerPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
  if (!runnerBinary?.startsWith("/") || !providerPack?.startsWith("/")) throw new Error("absolute qualified runner and pack paths required");
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-c9-g2-"));
  const remoteCwd = join(root, "simulated-sandbox", "workspace");
  const stagedRuntime = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
  await mkdir(stagedRuntime, { recursive: true });
  await symlink(providerPack, join(stagedRuntime, "provider-pack"), "dir");
  const fact = `PI_G2_PRIVATE_${randomUUID()}`;
  const stages: unknown[] = [], commands: unknown[] = [], requests: unknown[] = [];
  const spawned: Birth[] = [], pis: Birth[] = [];
  const stage = (name: string, detail: unknown = {}) => { stages.push({ at: new Date().toISOString(), name, detail }); console.log(`[c9-g2] ${name}`); };
  const model = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
      try {
        const parsed = JSON.parse(body); requests.push({ path: req.url, request: parsed });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: fact } });
        emit("content_block_stop", { index: 0 });
        emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
        emit("message_stop", {}); res.end();
      } catch (error) { res.writeHead(500).end(String(error)); }
    });
  });
  registerLocalRuntimeApiServer(model);
  const sockets = new Set<WebSocket>();
  const ws = new WebSocketServer({ noServer: true });
  const leaseActive = new Map<string, boolean>();
  const previousCertificates = getCACertificates("default");
  const previousHttpsAgent = https.globalAgent;
  let fixtureHttpsAgent: InstanceType<typeof https.Agent> | undefined;
  let preview: ReturnType<typeof createHttpsServer> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let stopPostgres: (() => Promise<void>) | undefined;
  let activeRunId: string | undefined;
  let failure: unknown;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID(), workspaceId = randomUUID();
  const providerLeaseId = `owned-g2-allocation-${randomUUID()}`;
  const execute = async (command: string, args: string[], options: Omit<Parameters<CommandManagedRuntimeRunner["execute"]>[0], "command" | "args"> = {}) =>
    runChildProcess(`c9-g2-${randomUUID()}`, command, args, { cwd: options.cwd ?? remoteCwd,
      env: options.env ?? {}, stdin: options.stdin, timeoutSec: (options.commandTimeoutMs ?? options.timeoutMs ?? 30_000) / 1000, graceSec: 1,
      onLog: options.onLog ?? (async () => {}), onSpawn: options.onSpawn });
  const commandRunner = (leaseId: string): CommandManagedRuntimeRunner => ({ execute: async input => {
    if (leaseActive.get(leaseId) !== true) throw new Error(`simulated sandbox lease retired: ${leaseId}`);
    const result = await execute(input.command, input.args ?? [], input);
    commands.push({ leaseId, command: input.command, args: input.args, exitCode: result.exitCode, timedOut: result.timedOut });
    return result;
  } });
  try {
    vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "controller-state"));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    vi.stubEnv("PI_OFFLINE", "1"); vi.stubEnv("OTEL_SDK_DISABLED", "true");
    await new Promise<void>(done => model.listen(0, "127.0.0.1", done));
    const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === "string") throw new Error("Messages listener missing");
    const agentHome = join(root, "pi-agent-fixture"); await mkdir(agentHome);
    await writeFile(join(agentHome, "models.json"), JSON.stringify({ providers: { paperclip: { models: [{ id: "faux", reasoning: true,
      contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } }] } } }));
    const key = join(root, "preview.key"), cert = join(root, "preview.crt");
    const certificate = await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"]);
    expect(certificate.exitCode).toBe(0);
    const certificates = [...previousCertificates, await readFile(cert, "utf8")];
    setDefaultCACertificates(certificates); fixtureHttpsAgent = new https.Agent({ ca: certificates }); https.globalAgent = fixtureHttpsAgent;
    preview = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) });
    const previewBindings = new Map<string, string>();
    preview.on("upgrade", (req, socket, head) => {
      const leaseId = previewBindings.get(req.url ?? "");
      if (!leaseId || !leaseActive.get(leaseId) || req.headers["x-owned-lease"] !== leaseId) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      ws.handleUpgrade(req, socket, head, front => {
        const back = new WebSocket(`ws://127.0.0.1:${PAPERCLIP_RUNNER_INGRESS_PORT}${req.url}`, { perMessageDeflate: false });
        const pending: Array<{ data: RawData; binary: boolean }> = [];
        sockets.add(front); sockets.add(back);
        front.on("message", (data, binary) => { if (back.readyState === WebSocket.OPEN) back.send(data, { binary }); else pending.push({ data, binary }); });
        back.on("open", () => { for (const message of pending.splice(0)) back.send(message.data, { binary: message.binary }); });
        back.on("message", (data, binary) => { if (front.readyState === WebSocket.OPEN) front.send(data, { binary }); });
        front.on("close", () => { sockets.delete(front); back.terminate(); });
        back.on("close", () => { sockets.delete(back); front.terminate(); });
        front.on("error", error => { stage("preview front error", error.message); back.terminate(); });
        back.on("error", error => { stage("preview back error", error.message); front.terminate(); });
      });
    });
    await new Promise<void>(done => preview!.listen(0, "127.0.0.1", done));
    const previewAddress = preview.address(); if (!previewAddress || typeof previewAddress === "string") throw new Error("Preview missing");
    temporary = await startEmbeddedPostgresTestDatabase("native-pi-g2-db-"); db = createDb(temporary.connectionString);
    // Preserve this proof's PostgreSQL data rather than invoking the helper's deletion cleanup.
    const pgPort = new URL(temporary.connectionString).port;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
        if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== pgPort) continue;
        const dataDir = args[args.indexOf("-D") + 1]!;
        stopPostgres = async () => {
          await closeRegisteredClients(temporary!.connectionString);
          const stopped = await execute(args[0]!.replace(/postgres$/, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"]);
          expect(stopped.exitCode, "owned PostgreSQL stopped with data retained").toBe(0);
        }; break;
      } catch { /* unrelated process */ }
    }
    expect(stopPostgres).toBeDefined();
    await db.insert(companies).values({ id: companyId, name: "C9 G2 proof", issuePrefix: "G2" });
    await db.insert(agents).values({ id: agentId, companyId, name: "C9 G2 managed", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", instructionsBundleMode: "managed" } });
    await db.insert(environments).values({ id: environmentId, name: "G2 simulated sandbox", driver: "sandbox" });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Continue after a good turn", description: null,
      assigneeAgentId: agentId, status: "in_progress" }).returning();
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from("Use the current conversation. Do not call tools or invent missing history.\n") }]);
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const controller = await currentNativeControllerIdentity();
    const environmentsService = environmentService(db);
    const seed = async (prompt: string, normalizedSessionId?: string, wakeCommentId?: string, previousLeaseId?: string) => {
      const runId = randomUUID();
      const [run] = await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, ...(normalizedSessionId ? { nativeSessionId: normalizedSessionId } : {}),
        contextSnapshot: { issueId, ...(wakeCommentId ? { wakeCommentId } : {}) } }).returning();
      const lease = await environmentsService.acquireLease({ companyId, environmentId, heartbeatRunId: runId, issueId,
        provider: "boat", providerLeaseId, leasePolicy: "reuse_by_environment", metadata: { remoteCwd, agentId, pluginId: "fixture-allocation-driver" },
        ...(previousLeaseId ? { replacesReusableLeaseId: previousLeaseId } : {}) });
      const native = await prepareNativeHeartbeatRun({ db: db!, run: run!, issue: issue!, environmentLeaseId: lease.id });
      await db!.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: controller.bootId,
        controllerGeneration: 0, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, leaseOwner: null, leaseExpiresAt: null });
      await db!.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const [contract] = await db!.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const execution = buildNativeExecutionInput({ companyId, agentId, runId, provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh",
        issue: { id: issueId, identifier: "G2-1", title: issue!.title, description: null, workMode: "standard" }, taskPrompt: prompt,
        workspace: { id: workspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: native.normalizedSessionId,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 600_000 }, runtimeContext,
        completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion, contract: contract!.contractJson as never } });
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ nativeExecutionInput: execution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "pi_rpc") })}::jsonb` })
        .where(eq(heartbeatRuns.id, runId));
      leaseActive.set(lease.id, true); return { runId, run: run!, native, execution, lease };
    };
    type Fixture = Awaited<ReturnType<typeof seed>>;
    const instructionRoot = join(root, "managed-instructions");
    const reservations: unknown[] = [];
    let previousManagedRunId: string | undefined;
    const managedCopy = (runId: string): NativeInstructionWorkingCopy => ({ runId, preparationKey: "managed-fixture", root: instructionRoot,
      checkpointWarm: async () => true, hasChanges: async () => false, collectStopped: async () => {} });
    const run = async (fixture: Fixture, outcome: "created" | "resumed") => {
      activeRunId = fixture.runId;
      const endpoint = async (request?: { leaseId: string; port: number; path: string }): Promise<RunnerIngressEndpoint> => {
        if (!leaseActive.get(fixture.lease.id)) throw new Error("retired lease cannot obtain ingress");
        const path = request?.path ?? `/api/runner/v1/connect/${fixture.runId}`; previewBindings.set(path, fixture.lease.id);
        return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
          secretHeaders: [{ name: "X-Owned-Lease", value: fixture.lease.id }], generation: fixture.lease.id,
          refresh: () => endpoint(request), close: async () => {} };
      };
      const target = { kind: "remote", transport: "sandbox", providerKey: "boat", environmentId,
        leaseId: fixture.lease.id, remoteCwd, reusableLeaseConfigured: true, runner: commandRunner(fixture.lease.id),
        effectiveCapabilities: { runnerWebSocketIngress: true, reusableLeases: true, independentControlCommands: true,
          nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false, incrementalSessionOutput: false,
          concurrentSyncOperations: false, duplexCommandStream: false }, getRunnerIngressEndpoint: endpoint,
        sandboxLeaseAcquisition: { outcome, providerLeaseId, ...(outcome === "resumed" ? { resumedFromState: "archived", restarted: true as const } : {}) },
      } as AdapterExecutionTarget;
      let release: (() => Promise<void>) | undefined;
      if (previousManagedRunId) {
        const reservation = await reserveWarmNativeInstructionDirectory({ companyId, agentId, previousRunId: previousManagedRunId,
          runId: fixture.runId, target, canReuse: async () => true });
        reservations.push({ runId: fixture.runId, previousRunId: previousManagedRunId, reserved: reservation !== null });
        stage("managed instruction reservation", reservations.at(-1));
        if (reservation) { reservation.adopt(instructionRoot, async () => {}); release = reservation.release; }
      }
      previousManagedRunId = fixture.runId;
      const result = await executePaperclipNativeSession({ db: db!, execution: fixture.execution, runnerInstanceId: fixture.native.runnerInstanceId,
        durableEnvironmentLeaseId: fixture.lease.id, controllerPersistence: { bootId: controller.bootId }, runnerIngressAuthorized: true,
        runnerExecutionTarget: target, runnerRemoteBinaryPath: runnerBinary, runnerRemoteProviderPackPath: providerPack,
        runnerEnvironment: { PATH: process.env.PATH, ...configuredEnvironmentProjection({ PI_OFFLINE: "1", TMPDIR: process.env.TMPDIR! }),
          PI_CODING_AGENT_DIR: agentHome, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none",
          PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${modelAddress.port}`, PAPERCLIP_PROVIDER_TRACE_PATH: join(root, `${fixture.runId}.provider-trace.jsonl`) },
        onSpawn: async (meta: { pid: number }) => { const owned = birth(meta.pid); if (owned) { spawned.push(owned); stage("real runner spawned", owned); } },
        onLog: async (stream: "stdout" | "stderr", text: string) => { stages.push({ stream, text }); await appendFile(join(root, "native.log"), `${stream}: ${text}`); },
        useRunnerd: true, conversationMode: true, instructionWorkingCopy: managedCopy(fixture.runId),
      }).then(value => ({ result: value }), error => ({ error: String(error) }));
      // Reservation cleanup may inspect the archived predecessor via its old
      // lease. Keep that cleanup error as evidence, not as the executor outcome.
      await release?.().catch(error => stage("managed reservation release after archive", String(error)));
      activeRunId = undefined; return result;
    };
    allocation.drivers = [{ driver: "sandbox", acquireRunLease: async () => { throw new Error("no allocation acquisition in this proof"); },
      realizeWorkspace: async () => ({ cwd: remoteCwd }), releaseRunLease: async () => { throw new Error("no allocation release in this proof"); },
      resolveCapabilities: async () => ({ nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false,
        incrementalSessionOutput: false, concurrentSyncOperations: false, independentControlCommands: true,
        runnerWebSocketIngress: true, reusableLeases: true, duplexCommandStream: false }) }];
    const first = await seed("Invent a private fact, say it once, and retain it only in your assistant history.");
    const firstOutcome = await run(first, "created");
    await writeFile(join(root, "turn-1-outcome.json"), JSON.stringify(firstOutcome, null, 2));
    expect(record(firstOutcome).error, JSON.stringify(firstOutcome)).toBeUndefined();
    expect(record(record(firstOutcome).result).exitCode).toBe(0);
    expect(record(record(firstOutcome).result).summary).toBe(fact);
    expect(requests.length).toBeGreaterThan(0);
    const runner = spawned.at(-1)!; expect(runner).toBeDefined();
    const pi = ownedPi(runner); expect(pi, "a real warm Pi survived the good turn").not.toBeNull(); pis.push(pi!);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, first.runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first.runId));
    await environmentsService.releaseLease(first.lease.id, "released");
    const [goodRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId));
    const [goodOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, first.runId));
    expect(goodRun?.status).toBe("succeeded"); expect(goodOwner?.phase).toBe("committed"); expect(goodOwner?.resultId).toBeTruthy();
    stage("turn 1 good and committed", { runId: first.runId, status: goodRun!.status, phase: goodOwner!.phase, resultId: goodOwner!.resultId, runner, pi });

    // Real precondition: the archived allocation loses its idle Runner/Pi and
    // the source finalization retains an expired owner lease after its result.
    // Do not throw a refusal or mock any executor/fence/notice function.
    leaseActive.set(first.lease.id, false);
    for (const owned of [pi!, runner]) if (sameBirth(owned)) process.kill(owned.pid, "SIGKILL");
    await vi.waitFor(() => { expect([pi!, runner].filter(sameBirth)).toEqual([]); }, { timeout: 15_000, interval: 100 });
    await db.update(nativeRunFinalizations).set({ leaseOwner: "g2-retained-expired-owner", leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(nativeRunFinalizations.runId, first.runId));
    stage("archived idle allocation; source has a result and leaked expired owner lease");
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
      body: "Continue the work from your own earlier assistant history." }).returning();
    const next = await seed(comment!.body, first.native.normalizedSessionId, comment!.id, first.lease.id);
    const selected = await findNativeSessionResumeRun(db, { companyId, agentId, issueId, normalizedSessionId: first.native.normalizedSessionId,
      currentRunId: next.runId, beforeCreatedAt: next.run.createdAt });
    expect(selected?.id, "the predecessor is exactly the successful turn, not an intervening failure").toBe(first.runId);
    if (selected?.runnerInstanceId) {
      next.native.runnerInstanceId = selected.runnerInstanceId;
      await db.update(heartbeatRuns).set({ runnerInstanceId: next.native.runnerInstanceId }).where(eq(heartbeatRuns.id, next.runId));
    }
    const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: first.native.normalizedSessionId,
      executionTargetKind: "remote", buildExecution: () => next.execution });
    if (admission.checkpoint) await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ sessionCheckpoint: admission.checkpoint })}::jsonb` }).where(eq(heartbeatRuns.id, next.runId));
    const requestsBefore = requests.length, spawnedBefore = spawned.length;
    const nextOutcome = await run(next, "resumed");
    await writeFile(join(root, "turn-2-outcome.json"), JSON.stringify(nextOutcome, null, 2));
    const refusal = record(nextOutcome).error;
    stage("real executor outcome", nextOutcome);
    expect(String(refusal ?? ""), "a product executor refusal, not a test-thrown error").toMatch(/^(?:Error: )?(?:runner_state_identity_mismatch: prior_owner_|native_controller_recovery_missing_evidence:retained_sandbox_binding|native_runner_warm_attachment_runner_exited:|runner_process_termination_unconfirmed:|native_session_cleanup_quarantined:)/);
    expect(requests.length, "the first refused message never reached the provider").toBe(requestsBefore);
    expect(spawned.length, "no replacement Runner launched on refusal").toBe(spawnedBefore);
    const visibleComments = async () => (await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(item => item.authorType === "system" && !item.deletedAt && record(item.metadata).recoveryResponsibility !== "system");
    const beforeSweep = await visibleComments();
    expect(beforeSweep, "the held-predecessor notice skips a GOOD predecessor with a result").toHaveLength(0);
    // Executor-level harness: heartbeat is NOT running. Reproduce its failure
    // settlement explicitly and expire the coordinator's unstarted same-run retry.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(Date.now() - 20_000), errorCode: "adapter_failed", error: String(refusal) })
      .where(eq(heartbeatRuns.id, next.runId));
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, next.runId));
    const [finalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, next.runId));
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() - 10 * 60_000) })
      .where(and(eq(nativeRunFinalizations.runId, next.runId), eq(nativeRunFinalizations.phase, "retryable_failure")));
    leaseActive.set(next.lease.id, false); await environmentsService.releaseLease(next.lease.id, "released");
    const sweep = await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId });
    const visibleAfterSweep = await visibleComments(); const visible = visibleAfterSweep.length;
    const [afterFinalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, next.runId));
    const proof = { shape: "G2: first refusal after a GOOD committed turn", managed: true, reservations,
      scope: "real runnerd + real Pi + loopback Messages; simulated allocation; executor-level harness, heartbeat not running",
      first: { runId: first.runId, status: goodRun!.status, phase: goodOwner!.phase, resultId: goodOwner!.resultId },
      priorRefusalPrecondition: { phase: "committed", resultId: goodOwner!.resultId, leaseOwner: "g2-retained-expired-owner", leaseExpired: true,
        archivedProcessesGone: [pi!, runner].every(owned => !sameBirth(owned)) },
      next: { runId: next.runId, predecessorRunId: selected!.id, refusal, finalizationPhase: finalization?.phase ?? null,
        failureCode: finalization?.failureCode ?? null, finalizationPhaseAfterSweep: afterFinalization?.phase ?? null,
        retryMadeOverdue: finalization?.phase === "retryable_failure", finishedAtAgeSeconds: 20 },
      visibleBeforeSweep: beforeSweep.length, visible, bodies: visibleAfterSweep.map(item => item.body),
      metadata: visibleAfterSweep.map(item => item.metadata), sweep, providerRequestsOnRefusedTurn: requests.length - requestsBefore,
      newRunnerOnRefusedTurn: spawned.length - spawnedBefore, runner, pi };
    await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2));
    stage("C9 G2 first-refusal notice", proof);
    expect(visible, JSON.stringify(proof)).toBe(1);
  } catch (error) { failure = error; throw error; }
  finally {
    const errors: unknown[] = [];
    if (activeRunId && db) try { await cancelNativeSession(activeRunId, "G2 cleanup", { db }); } catch (error) { errors.push(error); }
    try { await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "G2 cleanup" }); } catch (error) { errors.push(error); }
    allocation.drivers = undefined;
    for (const socket of sockets) socket.terminate(); ws.close();
    if (preview?.listening) await new Promise<void>(done => preview!.close(() => done()));
    model.closeAllConnections(); if (model.listening) await new Promise<void>(done => model.close(() => done()));
    if (db) for (const [name, table] of [["runs", heartbeatRuns], ["leases", environmentLeases], ["events", heartbeatRunEvents], ["owners", nativeRunFinalizations], ["comments", issueComments]] as const) {
      try { await writeFile(join(root, `${name}.json`), JSON.stringify(await db.select().from(table), null, 2)); } catch (error) { errors.push(error); }
    }
    try { await stopPostgres?.(); } catch (error) { errors.push(error); }
    fixtureHttpsAgent?.destroy(); https.globalAgent = previousHttpsAgent; setDefaultCACertificates(previousCertificates); vi.unstubAllEnvs();
    await writeFile(join(root, "stages.json"), JSON.stringify(stages, null, 2));
    await writeFile(join(root, "commands.json"), JSON.stringify(commands, null, 2));
    await writeFile(join(root, "requests.json"), JSON.stringify(requests, null, 2));
    await writeFile(join(root, "processes.json"), JSON.stringify({ spawned, pis, remainingOwned: [...spawned, ...pis].filter(sameBirth) }, null, 2));
    if ([...spawned, ...pis].some(sameBirth)) errors.push(new Error("owned Runner/Pi remains alive"));
    console.log(`C9 G2 evidence retained: ${root}`);
    if (failure) await writeFile(join(root, "failure.txt"), failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "G2 body/cleanup failed; evidence retained");
  }
}, 300_000);
