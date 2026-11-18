import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import https, { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { eq, sql } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it, vi } from "vitest";
import {
  activityLog, agents, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { PAPERCLIP_RUNNER_INGRESS_PORT, type RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import {
  canonicalNativeRuntimeContextDigest, configuredEnvironmentProjection, type NativeSession, type PersistedNativeSession, type PrpEvent,
} from "../vendor/paperclip-runner/index.js";
import { registerLocalRuntimeApiServer } from "../runtime-api.js";
import { environmentService } from "../services/environments.js";
import { remoteTerminationReceipt, hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { createRunnerdBackend, nativeControllerMigrationDescriptor, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import { createNativeControllerRecovery } from "../services/native-runtime/native-controller-recovery.js";
import { loadNativeRunnerCheckpoint } from "../services/native-runtime/native-runner-checkpoint.js";
import { currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import {
  buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget,
} from "../services/native-runtime/native-session-resume.js";
import { materializeAsset } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: crosses real DB admission -> real remote runnerd -> real proxy ->
// Pi 1.5.2 -> its own JSONL. The only scripted provider is loopback Messages.
// This is the SAME simulated allocation resumed under a NEW environment lease,
// not a claim that Boat/SSH, a destroyed VM, or backup relocation was qualified.
// A lease-bound command runner is invalidated only after measured process exit;
// closing the PRP transport by itself is never called sandbox retirement.
const enabled = process.env.PAPERCLIP_PI_LEASE_E2E === "1";
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
function piDescendant(runner: Birth): Birth | null {
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
    if (parent !== runner.pid) continue;
    const comm = (() => { try { return readFileSync(`/proc/${current.pid}/comm`, "utf8").trim(); } catch { return ""; } })();
    if (comm === "pi" || current.command.includes("--mode rpc") && current.command.includes("cli.js")) return current;
  }
  return null;
}
function sessionFile(pi: Birth): string {
  const env = Object.fromEntries(readFileSync(`/proc/${pi.pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => {
    const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  if (!env.PAPERCLIP_PI_RUNTIME_DIR || !env.PAPERCLIP_NORMALIZED_SESSION_ID) throw new Error("Pi child lacks its admitted file binding");
  return join(env.PAPERCLIP_PI_RUNTIME_DIR, `${env.PAPERCLIP_NORMALIZED_SESSION_ID}.jsonl`);
}

it.skipIf(!enabled)("retires a simulated sandbox lease, admits its safe DB successor and really recovers Pi-only history", async () => {
  expect(process.platform).toBe("linux");
  expect(process.env.TMPDIR, "dedicated parent-owned TMPDIR is required").toBeTruthy();
  const runnerBinary = process.env.PAPERCLIP_RUNNER_BINARY ?? process.env.PAPERCLIP_RUNNERD_PATH;
  const providerPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
  if (!runnerBinary?.startsWith("/") || !providerPack?.startsWith("/")) throw new Error("Set absolute qualified runner and provider-pack paths");
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-new-sandbox-lease-"));
  const remoteCwd = join(root, "simulated-sandbox", "workspace");
  await mkdir(remoteCwd, { recursive: true });
  // This command-only simulated allocation has no syncIn. Preinstall the real
  // qualified pack at the production staging path; all identity/tree checks run.
  const stagedRuntime = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
  await mkdir(stagedRuntime, { recursive: true });
  await symlink(providerPack, join(stagedRuntime, "provider-pack"), "dir");
  const fact = `PI_LEASE_PRIVATE_${randomUUID()}`;
  const stages: unknown[] = [], commands: unknown[] = [], requests: Array<Record<string, unknown>> = [];
  const eventSets: PrpEvent[][] = [], pumps: Promise<void>[] = [], sessions: NativeSession[] = [];
  const closedSessions = new Set<NativeSession>();
  const spawned: Birth[] = [], processPairs: Array<{ runner: Birth; pi: Birth }> = [];
  const stage = (name: string, detail: unknown = {}) => { stages.push({ at: new Date().toISOString(), name, detail }); console.log(`[pi-lease] ${name}`); };
  const cancelThenClose = async (session: NativeSession, reason: string) => {
    try {
      if (!session.cancel) throw new Error("real session has no cancellation boundary");
      try {
        await session.cancel({ reason, signal: AbortSignal.timeout(30_000) }).cleanup;
      } catch (error) {
        // Retirement is intentionally BETWEEN turns. The public cancellation
        // boundary revokes publication, but an idle harness refuses interrupt
        // with its typed already_terminal outcome. That is not process-exit
        // proof: still close the stopped session and check exact births below.
        if (record(error).code !== "already_terminal") throw error;
        const idle = await session.snapshot();
        expect(idle.activeTurnId).toBeNull();
        expect(idle.pendingRuntimeRequests ?? []).toEqual([]);
        stage("cancellation observed an already settled turn", { reason });
      }
    } finally {
      await session.close({ reason });
      closedSessions.add(session);
    }
  };
  const runtimeRequests: string[] = [];
  const model = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      runtimeRequests.push(req.url ?? "");
      // Native Pi's Messages SDK adds ?beta=true; route by path without
      // discarding the original request URL retained below as evidence.
      if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
      try {
        const parsed = JSON.parse(body);
        const messages = parsed.messages as Array<{ role: string; content: unknown }>;
        const historyHasFact = messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(fact));
        const latestPromptHasFact = JSON.stringify(messages.at(-1)?.content).includes(fact);
        const first = requests.length === 0;
        const reply = first ? fact : historyHasFact ? `RECALLED_${fact}` : "HISTORY_LOST";
        requests.push({ path: req.url, request: parsed, historyHasFact, latestPromptHasFact, reply });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
        emit("content_block_stop", { index: 0 });
        emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
        emit("message_stop", {}); res.end();
      } catch (error) { res.writeHead(500).end(String(error)); }
    });
  });
  // Tool definitions use the ordinary listener-ownership seam. No tool endpoint
  // is faked: this read-only conversation never calls a Paperclip HTTP tool.
  registerLocalRuntimeApiServer(model);
  const sockets = new Set<WebSocket>();
  const ws = new WebSocketServer({ noServer: true });
  let preview: ReturnType<typeof createHttpsServer> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let stopPostgres: (() => Promise<void>) | undefined;
  const previousCertificates = getCACertificates("default");
  const previousHttpsAgent = https.globalAgent;
  let fixtureHttpsAgent: InstanceType<typeof https.Agent> | undefined;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID(), workspaceId = randomUUID();
  const providerLeaseId = `owned-simulated-allocation-${randomUUID()}`;
  const leaseActive = new Map<string, boolean>();
  let failure: unknown;
  const execute = async (command: string, args: string[], options: Omit<Parameters<CommandManagedRuntimeRunner["execute"]>[0], "command" | "args"> = {}) =>
    runChildProcess(`pi-lease-${randomUUID()}`, command, args, { cwd: options.cwd ?? remoteCwd,
      env: options.env ?? {}, stdin: options.stdin, timeoutSec: (options.commandTimeoutMs ?? options.timeoutMs ?? 30_000) / 1000, graceSec: 1,
      onLog: options.onLog ?? (async () => {}), onSpawn: options.onSpawn });
  const commandRunner = (leaseId: string): CommandManagedRuntimeRunner => ({ execute: async input => {
    if (leaseActive.get(leaseId) !== true) throw new Error(`simulated sandbox environment lease retired: ${leaseId}`);
    const result = await execute(input.command, input.args ?? [], input);
    commands.push({ leaseId, command: input.command, args: input.args, exitCode: result.exitCode, timedOut: result.timedOut });
    return result;
  } });
  try {
    vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "controller-state"));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
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
    setDefaultCACertificates(certificates);
    fixtureHttpsAgent = new https.Agent({ ca: certificates });
    https.globalAgent = fixtureHttpsAgent;
    preview = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) });
    const previewBindings = new Map<string, string>();
    preview.on("upgrade", (req, socket, head) => {
      const leaseId = previewBindings.get(req.url ?? "");
      if (!leaseId || !leaseActive.get(leaseId) || req.headers["x-owned-lease"] !== leaseId) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
      }
      ws.handleUpgrade(req, socket, head, front => {
        // The production sandbox ingress contract chooses this listener port.
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
    temporary = await startEmbeddedPostgresTestDatabase("native-pi-lease-db-");
    db = createDb(temporary.connectionString);
    // The normal helper cleanup deletes its data tree. Retain evidence instead:
    // find only this helper's exact port-matched postgres, then stop its pg_ctl.
    const pgPort = new URL(temporary.connectionString).port;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
        if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== pgPort) continue;
        const dataDir = args[args.indexOf("-D") + 1]!;
        stopPostgres = async () => {
          await closeRegisteredClients(temporary!.connectionString);
          const result = await execute(args[0]!.replace(/postgres$/, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"]);
          expect(result.exitCode, "owned postgres stopped without deleting data").toBe(0);
          stage("retained Postgres stopped", { pid: Number(entry), dataDir });
        };
        break;
      } catch { /* unrelated process or already exited */ }
    }
    expect(stopPostgres).toBeDefined();
    await db.insert(companies).values({ id: companyId, name: "Pi lease proof", issuePrefix: "PIL" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi lease proof", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } });
    await db.insert(environments).values({ id: environmentId, name: "Owned split-filesystem simulation", driver: "sandbox" });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Retain the same Pi conversation", description: null,
      assigneeAgentId: agentId, status: "in_progress" }).returning();
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from("Use only the current conversation. Do not call tools or invent missing history.\n") }]);
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const controller = await currentNativeControllerIdentity();
    const environmentsService = environmentService(db);
    const seed = async (prompt: string, normalizedSessionId?: string, wakeCommentId?: string, previousLeaseId?: string) => {
      const runId = randomUUID();
      const [run] = await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, ...(normalizedSessionId ? { nativeSessionId: normalizedSessionId } : {}),
        contextSnapshot: { issueId, ...(wakeCommentId ? { wakeCommentId } : {}) } }).returning();
      const lease = await environmentsService.acquireLease({ companyId, environmentId, heartbeatRunId: runId, issueId,
        provider: "boat", providerLeaseId, leasePolicy: "reuse_by_environment", metadata: { remoteCwd, agentId },
        ...(previousLeaseId ? { replacesReusableLeaseId: previousLeaseId } : {}) });
      const native = await prepareNativeHeartbeatRun({ db: db!, run: run!, issue: issue!, environmentLeaseId: lease.id });
      await db!.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: controller.bootId,
        controllerGeneration: 1, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt,
        leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 10 * 60_000) });
      await db!.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const [contract] = await db!.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const execution = buildNativeExecutionInput({ companyId, agentId, runId, provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh",
        issue: { id: issueId, identifier: "PIL-1", title: issue!.title, description: null, workMode: "standard" }, taskPrompt: prompt,
        workspace: { id: workspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: native.normalizedSessionId,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null }, runtimeContext,
        completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion, contract: contract!.contractJson as never } });
      // The native authority uses the actual acquired DB id, never the
      // executionWorkspaceId or the unrelated PRP connection lease token.
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ nativeExecutionInput: execution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "pi_rpc") })}::jsonb` })
        .where(eq(heartbeatRuns.id, runId));
      leaseActive.set(lease.id, true);
      return { runId, run: run!, native, execution, lease, prompt };
    };
    type Fixture = Awaited<ReturnType<typeof seed>>;
    const backend = async (fixture: Fixture, outcome: "created" | "resumed") => {
      const path = `/api/runner/v1/connect/${fixture.runId}`;
      previewBindings.set(path, fixture.lease.id);
      const endpoint = async (): Promise<RunnerIngressEndpoint> => {
        if (!leaseActive.get(fixture.lease.id)) throw new Error("retired environment lease cannot obtain ingress");
        return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
          secretHeaders: [{ name: "X-Owned-Lease", value: fixture.lease.id }], generation: fixture.lease.id,
          refresh: endpoint, close: async () => {} };
      };
      const target: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "boat", environmentId,
        leaseId: fixture.lease.id, remoteCwd, reusableLeaseConfigured: true, runner: commandRunner(fixture.lease.id),
        effectiveCapabilities: { runnerWebSocketIngress: true, reusableLeases: true, independentControlCommands: true,
          nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false, incrementalSessionOutput: false,
          concurrentSyncOperations: false, duplexCommandStream: false }, getRunnerIngressEndpoint: endpoint,
        sandboxLeaseAcquisition: { outcome, providerLeaseId } };
      return createRunnerdBackend({ db: db!, execution: fixture.execution, runnerInstanceId: fixture.native.runnerInstanceId,
        durableEnvironmentLeaseId: fixture.lease.id, controllerPersistence: { bootId: controller.bootId }, runnerIngressAuthorized: true,
        runnerExecutionTarget: target, runnerRemoteBinaryPath: runnerBinary, runnerRemoteProviderPackPath: providerPack,
        // The projection admits ordinary configured variables only. Pi home,
        // provider routing and raw trace are generated controller-owned keys;
        // placing them inside the projection silently removes them.
        runnerEnvironment: { PATH: process.env.PATH, ...configuredEnvironmentProjection({ PI_OFFLINE: "1", TMPDIR: process.env.TMPDIR! }),
          PI_CODING_AGENT_DIR: agentHome, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none",
          PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${modelAddress.port}`, PAPERCLIP_PROVIDER_TRACE_PATH: join(root, `${fixture.runId}.provider-trace.jsonl`) },
        onSpawn: async meta => { const owned = birth(meta.pid); if (!owned) throw new Error("spawned runner unavailable"); spawned.push(owned); stage("real runner spawned", owned); },
        onLog: async (stream, text) => { stages.push({ stream, text }); } });
    };
    const runTurn = async (session: NativeSession, fixture: Fixture) => {
      const events: PrpEvent[] = []; eventSets.push(events);
      let pumpFailure: unknown;
      const pump = (async () => { for await (const event of session.events()) events.push(event); })().catch(error => { pumpFailure = error; });
      pumps.push(pump);
      const started = await session.startTurn({ message: { role: "user", text: fixture.prompt } });
      await vi.waitFor(() => {
        if (pumpFailure) throw pumpFailure;
        const current = events.filter(event => event.runId === fixture.runId && event.turnId === started.turnId);
        const bad = current.find(event => ["turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.eventType));
        if (bad) throw new Error(JSON.stringify(bad));
        expect(current.some(event => event.eventType === "turn.completed")).toBe(true);
      }, { timeout: 120_000, interval: 100 });
      const runner = spawned.at(-1)!;
      const pi = piDescendant(runner); expect(pi).not.toBeNull();
      processPairs.push({ runner, pi: pi! });
      const snapshot = await session.snapshot();
      expect(snapshot.identity.sessionId).toBe(fixture.native.normalizedSessionId);
      expect(snapshot.activeTurnId).toBeNull();
      expect(snapshot.pendingRuntimeRequests ?? []).toEqual([]);
      return { snapshot, file: sessionFile(pi!), events };
    };
    const first = await seed("Invent a private fact, say it once, and retain it only in your assistant history.");
    const firstBackend = await backend(first, "created");
    const firstSession = await firstBackend.openSession({ identity: { companyId, agentId, issueId, runId: first.runId, sessionId: first.native.normalizedSessionId }, workingDirectory: remoteCwd });
    sessions.push(firstSession);
    const initial = await runTurn(firstSession, first);
    expect(readFileSync(initial.file, "utf8")).toContain(fact);
    const before = readFileSync(initial.file);
    await writeFile(join(root, "conversation-before-retirement.jsonl"), before);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.request)).not.toContain(fact);
    const [intent] = await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "lease-proof-operator",
      action: "pi_lease_proof.stop_requested", entityType: "run", entityId: first.runId, runId: first.runId }).returning();
    await cancelThenClose(firstSession, "operator retires the simulated sandbox environment lease");
    await vi.waitFor(() => {
      expect(sameBirth(processPairs[0]!.runner)).toBe(false); expect(sameBirth(processPairs[0]!.pi)).toBe(false);
    }, { timeout: 5000, interval: 50 });
    const [ack] = await db.insert(activityLog).values({ companyId, actorType: "system", actorId: "owned-simulated-sandbox-provider",
      action: "pi_lease_proof.stop_confirmed", entityType: "run", entityId: first.runId, runId: first.runId,
      details: { processPair: processPairs[0], runnerAbsent: true, piAbsent: true } }).returning();
    // This receipt is NOT pre-seeded. The simulated provider closes this exact
    // lease's execution/ingress authority only after checking its real births.
    leaseActive.set(first.lease.id, false);
    const receipt = remoteTerminationReceipt(first.lease, { providerLeaseId, state: "stopped" });
    expect(receipt).toBeDefined();
    const retired = await environmentsService.releaseLease(first.lease.id, "released", { cleanupStatus: "success", remoteExecutionTermination: receipt });
    expect(retired).not.toBeNull();
    const [retiredRow] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, first.lease.id));
    expect(hasRemoteTerminationReceipt(retiredRow!)).toBe(true);
    await expect(commandRunner(first.lease.id).execute({ command: "true" })).rejects.toThrow("environment lease retired");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "lease-proof-operator", nativeCancellation: { schema: "paperclip.native-cancellation.v1",
        companyId, issueId, runId: first.runId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: intent!.id, acknowledgementAuditId: ack!.id } },
      runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({ sessionCheckpoint: initial.snapshot,
        nativeControllerRecovery: createNativeControllerRecovery(initial.snapshot, {
          configDigest: nativeControllerMigrationDescriptor(first.execution, nativeToolContractFingerprintForTarget("remote", "pi_rpc")).configDigest,
          processConfigDigest: null,
        }, { runId: first.runId, runnerInstanceId: first.native.runnerInstanceId, normalizedSessionId: first.native.normalizedSessionId }),
      })}::jsonb`,
    }).where(eq(heartbeatRuns.id, first.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
      recoveryState: null, resultId: null }).where(eq(nativeRunFinalizations.runId, first.runId));
    const sourceCheckpoint = await loadNativeRunnerCheckpoint(db, { companyId, issueId, runId: first.runId });
    expect(sourceCheckpoint).not.toBeNull();
    const sourceWork = [...sourceCheckpoint!.records].filter(([part]) => part.startsWith("command:")).map(([, value]) => JSON.parse(value));
    expect(sourceWork.length).toBeGreaterThan(0);
    expect(sourceWork.every(command => command.status !== "pending")).toBe(true);
    // Remote controllers keep only an external projection on disk. Compare
    // against the authoritative DB checkpoint materialized by its public seam.
    const sourceCheckpointRoot = join(root, "predecessor-checkpoint");
    sourceCheckpoint!.restoreSessionDirectory(sourceCheckpointRoot);
    const sourceControllerBytes = await readFile(join(sourceCheckpointRoot, "control-plane", "control-plane-state.json"));
    const remoteSessionRoot = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"));
    const sourceRunnerBytes = await readFile(join(remoteSessionRoot, "runner", "runner-state.json"));
    await writeFile(join(root, "predecessor-control-plane.json"), sourceControllerBytes);
    await writeFile(join(root, "predecessor-runner-state.json"), sourceRunnerBytes);
    await writeFile(join(root, "retirement.json"), JSON.stringify({ receipt, retiredRow, commands: sourceWork, processPair: processPairs[0] }, null, 2));
    stage("environment lease retired after actual process exit", { oldLeaseId: first.lease.id, providerLeaseId });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "lease-proof-operator",
      body: "Recall the private fact from your own earlier assistant history. Do not invent it." }).returning();
    const next = await seed(comment!.body, first.native.normalizedSessionId, comment!.id, first.lease.id);
    expect(next.lease.id).not.toBe(first.lease.id);
    expect(next.native.normalizedSessionId).toBe(first.native.normalizedSessionId);
    const selected = await findNativeSessionResumeRun(db, { companyId, agentId, issueId, normalizedSessionId: first.native.normalizedSessionId,
      currentRunId: next.runId, beforeCreatedAt: next.run.createdAt });
    expect(selected?.id).toBe(first.runId);
    // executeNativeSession adopts the retained durable Runner binding before
    // createRunnerdBackend (and saves that ID on the successor run). This
    // fixture calls the backend directly, so perform the same bookkeeping;
    // a fresh prepared ID is not the retained process-scoped PRP identity.
    expect(selected!.runnerInstanceId).toBe(first.native.runnerInstanceId);
    next.native.runnerInstanceId = selected!.runnerInstanceId!;
    await db.update(heartbeatRuns).set({ runnerInstanceId: next.native.runnerInstanceId }).where(eq(heartbeatRuns.id, next.runId));
    const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: first.native.normalizedSessionId,
      executionTargetKind: "remote", buildExecution: () => next.execution });
    expect(admission.checkpoint).not.toBeNull();
    expect(admission.checkpoint!.providerSessionId).toBe(initial.snapshot.providerSessionId);
    const snapshot = admission.checkpoint as PersistedNativeSession;
    await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ sessionCheckpoint: snapshot })}::jsonb` }).where(eq(heartbeatRuns.id, next.runId));
    // ===================== RFL JUDGE PROBE (not builder code) =====================
    // DB-level refusal table for assertNativeRetainedSandboxBinding's no-result Pi lane.
    // Runs on the REAL fixture state (real DB rows, real runnerd files) just before
    // the real successor recovery. Each case: mutate ONE fact -> expect refusal -> restore.
    {
      const { assertNativeRetainedSandboxBinding } = await import("../services/native-runtime/native-controller-recovery.js");
      const judgeTarget = (runner: CommandManagedRuntimeRunner = commandRunner(next.lease.id)) => ({ kind: "remote", transport: "sandbox", providerKey: "boat", environmentId,
        leaseId: next.lease.id, remoteCwd, reusableLeaseConfigured: true, runner,
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId } });
      const admit = (override: Record<string, unknown> = {}, targetOverride: Record<string, unknown> = {}, runner?: CommandManagedRuntimeRunner) =>
        assertNativeRetainedSandboxBinding(db!, { companyId, issueId, agentId, runId: first.runId, successorRunId: next.runId,
          normalizedSessionId: first.native.normalizedSessionId, target: { ...judgeTarget(runner), ...targetOverride } as never, ...override } as never);
      const judgeRows: Array<{ n: number; group: string; case: string; outcome: string; detail?: string }> = [];
      const dbDigest = async () => createHash("sha256").update(JSON.stringify([
        (await db!.select().from(heartbeatRuns)).sort((a, b) => a.id.localeCompare(b.id)),
        (await db!.select().from(environmentLeases)).sort((a, b) => a.id.localeCompare(b.id)),
        (await db!.select().from(nativeRunFinalizations)).sort((a, b) => a.runId.localeCompare(b.runId)),
        (await db!.select().from(issues)).sort((a, b) => a.id.localeCompare(b.id))])).digest("hex");
      const runnerDir = join(remoteSessionRoot, "runner");
      const runnerStatePath = join(runnerDir, "runner-state.json"), providerStatePath = join(runnerDir, "codex-provider-state.json");
      const fileDigest = async () => createHash("sha256").update(await readFile(runnerStatePath)).update(await readFile(providerStatePath))
        .update(JSON.stringify(readdirSync(join(runnerDir, "process-lineage")).sort())).digest("hex");
      const dbBefore = await dbDigest(), filesBefore = await fileDigest();
      const [ownerRow] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, first.runId));
      const [srcRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId));
      const [curRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId));
      const [srcLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, first.lease.id));
      const [curLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, next.lease.id));
      const [issueRow] = await db.select().from(issues).where(eq(issues.id, issueId));
      await writeFile(join(root, "judge-fixture-rows.json"), JSON.stringify({ ownerRow, srcLease, curLease, issueExecutionRunId: issueRow!.executionRunId,
        srcRun: { id: srcRun!.id, status: srcRun!.status, finishedAt: srcRun!.finishedAt, runnerInstanceId: srcRun!.runnerInstanceId, nativeSessionId: srcRun!.nativeSessionId },
        curRun: { id: curRun!.id, status: curRun!.status, runnerInstanceId: curRun!.runnerInstanceId, nativeSessionId: curRun!.nativeSessionId },
        runnerState: JSON.parse(await readFile(runnerStatePath, "utf8")), providerState: JSON.parse(await readFile(providerStatePath, "utf8")),
        lineage: readdirSync(join(runnerDir, "process-lineage")) }, null, 2));
      const restoreOwner = () => db!.update(nativeRunFinalizations).set(ownerRow!).where(eq(nativeRunFinalizations.runId, first.runId));
      const restoreRun = (row: typeof srcRun) => () => db!.update(heartbeatRuns).set(row!).where(eq(heartbeatRuns.id, row!.id));
      const restoreLease = (row: typeof srcLease) => () => db!.update(environmentLeases).set(row!).where(eq(environmentLeases.id, row!.id));
      const restoreIssue = () => db!.update(issues).set({ executionRunId: issueRow!.executionRunId }).where(eq(issues.id, issueId));
      const none = async () => {};
      let n = 0;
      const control = async (name: string) => {
        await admit(); judgeRows.push({ n: ++n, group: "control", case: name, outcome: "ADMITTED" });
        expect(await dbDigest(), "admission must be read-only (DB)").toBe(dbBefore);
        expect(await fileDigest(), "admission must be read-only (remote files)").toBe(filesBefore);
      };
      const refuse = async (group: string, name: string, mutate: () => Promise<unknown>, restore: () => Promise<unknown>, call: () => Promise<unknown> = () => admit()) => {
        let outcome = "ADMITTED  <-- BAD", detail: string | undefined;
        try { await mutate(); }
        catch (error) { await restore().catch(() => {}); judgeRows.push({ n: ++n, group, case: name, outcome: "UNCONSTRUCTIBLE (DB constraint forbids this state)", detail: String(error instanceof Error ? error.message : error).slice(0, 200) }); return; }
        try { await call(); } catch (error) { outcome = "REFUSED"; detail = error instanceof Error ? error.message : String(error); }
        finally { await restore(); }
        judgeRows.push({ n: ++n, group, case: name, outcome, detail });
      };
      const editFile = (path: string, edit: (value: Record<string, unknown>) => void) => async () => {
        const value = JSON.parse(await readFile(path, "utf8")); edit(value); await writeFile(path, JSON.stringify(value)); };
      const runnerBytes = await readFile(runnerStatePath), providerBytes = await readFile(providerStatePath);
      const restoreRunnerFile = () => writeFile(runnerStatePath, runnerBytes), restoreProviderFile = () => writeFile(providerStatePath, providerBytes);
      const setOwner = (values: Record<string, unknown>) => () => db!.update(nativeRunFinalizations).set(values as never).where(eq(nativeRunFinalizations.runId, first.runId));
      const setRun = (id: string, values: Record<string, unknown>) => () => db!.update(heartbeatRuns).set(values as never).where(eq(heartbeatRuns.id, id));
      const setLease = (id: string, values: Record<string, unknown>) => () => db!.update(environmentLeases).set(values as never).where(eq(environmentLeases.id, id));
      const without = (metadata: Record<string, unknown> | null, key: string) => { const copy = { ...(metadata ?? {}) }; delete copy[key]; return copy; };

      await control("unmodified stopped-quiescent evidence (must admit, else table is vacuous)");

      // --- coordinator (nativeRunFinalizations of the STOPPED run)
      await refuse("coordinator", "has a result id (dangling, no result row)", setOwner({ resultId: randomUUID() }), restoreOwner);
      await refuse("coordinator", "live owner: leaseOwner set, lease unexpired", setOwner({ leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 600_000) }), restoreOwner);
      await refuse("coordinator", "stale owner: leaseOwner set, lease expired", setOwner({ leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() - 600_000) }), restoreOwner);
      await refuse("coordinator", "phase observed (not terminal)", setOwner({ phase: "observed" }), restoreOwner);
      await refuse("coordinator", "phase committed but no result", setOwner({ phase: "committed" }), restoreOwner);
      await refuse("coordinator", "recovery in progress (recoveryState set)", setOwner({ recoveryState: "resuming_session" }), restoreOwner);
      await refuse("coordinator", "coordinator row missing (asked for a run with none)", none, none, () => admit({ runId: next.runId }));

      // --- coordinator with a REAL result row (the dangling id above is forbidden by the DB foreign key)
      {
        const { nativeRunResults } = await import("@paperclipai/db");
        const [contractRow] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
        const realResultId = randomUUID();
        await db.insert(nativeRunResults).values({ id: realResultId, companyId, issueId, runId: first.runId, completionContractId: contractRow!.id,
          serverFingerprint: first.runId, schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "cancelled" } }, canonicalSha256: "67".repeat(32) });
        await refuse("coordinator", "has a REAL result row, phase terminal_failure", setOwner({ resultId: realResultId }), restoreOwner);
        await refuse("coordinator", "has a REAL result row, phase observed", setOwner({ resultId: realResultId, phase: "observed" }), restoreOwner);
        await refuse("coordinator", "has a REAL result row and a live owner", setOwner({ resultId: realResultId, leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 600_000) }), restoreOwner);
        // committed + result is the EXISTING committed-result lane (its guard is unchanged from base). Recorded for information only.
        try {
          await setOwner({ resultId: realResultId, phase: "committed" })();
          let outcome = "INFO admitted by the unchanged committed-result lane (same guard as base 7b1afed3)", detail: string | undefined;
          try { await admit(); } catch (error) { outcome = "REFUSED"; detail = error instanceof Error ? error.message : String(error); }
          judgeRows.push({ n: ++n, group: "coordinator", case: "has a REAL result row, phase committed (pre-existing lane, not this fix's lane)", outcome, detail });
        } catch (error) { judgeRows.push({ n: ++n, group: "coordinator", case: "has a REAL result row, phase committed", outcome: "UNCONSTRUCTIBLE (DB constraint forbids this state)", detail: String(error instanceof Error ? error.message : error).slice(0, 200) }); }
        finally { await restoreOwner(); }
        await db.delete(nativeRunResults).where(eq(nativeRunResults.id, realResultId));
      }

      // --- predecessor run
      await refuse("predecessor", "still running", setRun(first.runId, { status: "running" }), restoreRun(srcRun));
      await refuse("predecessor", "queued", setRun(first.runId, { status: "queued" }), restoreRun(srcRun));
      await refuse("predecessor", "succeeded (not a failed/cancelled source)", setRun(first.runId, { status: "succeeded" }), restoreRun(srcRun));
      await refuse("predecessor", "no finishedAt", setRun(first.runId, { finishedAt: null }), restoreRun(srcRun));
      await refuse("predecessor", "checkpoint snapshot has an active turn", setRun(first.runId, { runnerProfileJson: { ...(srcRun!.runnerProfileJson as object),
        sessionCheckpoint: { ...((srcRun!.runnerProfileJson as Record<string, unknown>).sessionCheckpoint as object), activeTurnId: "turn-still-active" } } }), restoreRun(srcRun));
      await refuse("predecessor", "checkpoint snapshot has a pending runtime request", setRun(first.runId, { runnerProfileJson: { ...(srcRun!.runnerProfileJson as object),
        sessionCheckpoint: { ...((srcRun!.runnerProfileJson as Record<string, unknown>).sessionCheckpoint as object), pendingRuntimeRequests: [{ id: "req" }] } } }), restoreRun(srcRun));
      await refuse("predecessor", "no session checkpoint at all", setRun(first.runId, { runnerProfileJson: without(srcRun!.runnerProfileJson as Record<string, unknown>, "sessionCheckpoint") }), restoreRun(srcRun));
      await refuse("predecessor", "no controller-recovery metadata", setRun(first.runId, { runnerProfileJson: without(srcRun!.runnerProfileJson as Record<string, unknown>, "nativeControllerRecovery") }), restoreRun(srcRun));
      await refuse("predecessor", "runner instance id changed", setRun(first.runId, { runnerInstanceId: randomUUID() }), restoreRun(srcRun));
      await refuse("predecessor", "legacy (non-native) runtime mode", setRun(first.runId, { runtimeMode: "legacy" }), restoreRun(srcRun));

      // --- identities: task / run / lease / agent / conversation
      await refuse("identity", "different task asks for this run (issue id differs)", none, none, () => admit({ issueId: randomUUID() }));
      await refuse("identity", "different company", none, none, () => admit({ companyId: randomUUID() }));
      await refuse("identity", "different agent", none, none, () => admit({ agentId: randomUUID() }));
      await refuse("identity", "different conversation (normalized session id differs)", none, none, () => admit({ normalizedSessionId: `${first.native.normalizedSessionId}-other` }));
      await refuse("identity", "successor == source (same run)", none, none, () => admit({ successorRunId: first.runId }));
      await refuse("identity", "successor run id unknown", none, none, () => admit({ successorRunId: randomUUID() }));
      await refuse("identity", "no successor scope supplied (I-7 call shape)", none, none, () => admit({ successorRunId: undefined, normalizedSessionId: undefined, agentId: undefined }));
      await refuse("identity", "task's executionRunId is not the successor", () => db!.update(issues).set({ executionRunId: first.runId }).where(eq(issues.id, issueId)), restoreIssue);
      await refuse("identity", "task has no executionRunId", () => db!.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId)), restoreIssue);
      await refuse("identity", "successor run not running (queued)", setRun(next.runId, { status: "queued" }), restoreRun(curRun));
      await refuse("identity", "successor run already cancelled", setRun(next.runId, { status: "cancelled" }), restoreRun(curRun));
      await refuse("identity", "RESET BETWEEN: successor run is bound to a new conversation id", setRun(next.runId, { nativeSessionId: null }), restoreRun(curRun));
      await refuse("identity", "RESET BETWEEN: source run's conversation id cleared", setRun(first.runId, { nativeSessionId: null }), restoreRun(srcRun));
      await refuse("identity", "successor lease belongs to another run", setLease(next.lease.id, { heartbeatRunId: first.runId }), restoreLease(curLease));
      await refuse("identity", "successor lease not active (released)", setLease(next.lease.id, { status: "released", releasedAt: new Date() }), restoreLease(curLease));
      await refuse("identity", "successor lease has releasedAt", setLease(next.lease.id, { releasedAt: new Date() }), restoreLease(curLease));
      await refuse("identity", "successor lease is for another agent", setLease(next.lease.id, { metadata: { ...(curLease!.metadata ?? {}), agentId: randomUUID() } }), restoreLease(curLease));
      await refuse("identity", "target names a lease id that is not the successor", none, none, () => admit({}, { leaseId: first.lease.id }));
      await refuse("identity", "target is another provider allocation", none, none, () => admit({}, { sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: `other-${randomUUID()}` } }));
      await refuse("identity", "target sandbox was created fresh, not resumed", none, none, () => admit({}, { sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } }));
      await refuse("identity", "target workspace is unrelated", none, none, () => admit({}, { remoteCwd: "/unrelated/workspace" }));
      await refuse("identity", "target is not a sandbox transport", none, none, () => admit({}, { transport: "ssh" }));

      // --- provider termination
      await refuse("termination", "no provider termination receipt", setLease(first.lease.id, { metadata: without(srcLease!.metadata, "remoteExecutionTermination") }), restoreLease(srcLease));
      for (const state of ["unknown", "running", "destroyed", "stopping"]) await refuse("termination", `termination receipt state=${state} (not stopped)`,
        setLease(first.lease.id, { metadata: { ...(srcLease!.metadata ?? {}), remoteExecutionTermination: { ...(srcLease!.metadata!.remoteExecutionTermination as object), state } } }), restoreLease(srcLease));
      await refuse("termination", "termination receipt names another lease", setLease(first.lease.id, { metadata: { ...(srcLease!.metadata ?? {}),
        remoteExecutionTermination: { ...(srcLease!.metadata!.remoteExecutionTermination as object), leaseId: randomUUID() } } }), restoreLease(srcLease));
      await refuse("termination", "termination receipt names another run", setLease(first.lease.id, { metadata: { ...(srcLease!.metadata ?? {}),
        remoteExecutionTermination: { ...(srcLease!.metadata!.remoteExecutionTermination as object), runId: randomUUID() } } }), restoreLease(srcLease));
      await refuse("termination", "source lease cleanup did not succeed", setLease(first.lease.id, { cleanupStatus: "failed" }), restoreLease(srcLease));
      await refuse("termination", "source lease still active (never released)", setLease(first.lease.id, { status: "active", releasedAt: null }), restoreLease(srcLease));

      // --- reusable handoff
      await refuse("handoff", "successor has no incoming handoff", setLease(next.lease.id, { metadata: without(curLease!.metadata, "reusableLeasePredecessor") }), restoreLease(curLease));
      await refuse("handoff", "predecessor has no outgoing handoff", setLease(first.lease.id, { metadata: without(srcLease!.metadata, "reusableLeaseSuccessor") }), restoreLease(srcLease));
      await refuse("handoff", "handoff id differs between the two sides", setLease(next.lease.id, { metadata: { ...(curLease!.metadata ?? {}),
        reusableLeasePredecessor: { ...(curLease!.metadata!.reusableLeasePredecessor as object), handoffId: randomUUID() } } }), restoreLease(curLease));
      await refuse("handoff", "predecessor lease is not reuse_by_environment", setLease(first.lease.id, { leasePolicy: "ephemeral" }), restoreLease(srcLease));
      await refuse("handoff", "predecessor lease status released (not handed off as expired)", setLease(first.lease.id, { status: "released" }), restoreLease(srcLease));
      await refuse("handoff", "successor already handed on to a later lease", setLease(next.lease.id, { metadata: { ...(curLease!.metadata ?? {}), reusableLeaseSuccessor: { schema: "x" } } }), restoreLease(curLease));
      await refuse("handoff", "predecessor released at a different time than the successor acquired", setLease(first.lease.id, { releasedAt: new Date(srcLease!.releasedAt!.getTime() - 1000) }), restoreLease(srcLease));

      // --- measured remote Runner / Pi state (real files written by real runnerd)
      await refuse("runner", "Runner lifecycle ready (not suspended)", editFile(runnerStatePath, v => { v.lifecycle = "ready"; }), restoreRunnerFile);
      await refuse("runner", "Runner lifecycle running", editFile(runnerStatePath, v => { v.lifecycle = "running"; }), restoreRunnerFile);
      await refuse("runner", "Runner has an unsent outbox entry", editFile(runnerStatePath, v => { v.outbox = [{ sourceSeq: 1 }]; }), restoreRunnerFile);
      await refuse("runner", "Runner has a pending terminal delivery", editFile(runnerStatePath, v => { v.pendingTerminalDelivery = { turnId: "t" }; }), restoreRunnerFile);
      await refuse("runner", "Runner has pending provider cleanup", editFile(runnerStatePath, v => { v.pendingProviderCleanup = {}; }), restoreRunnerFile);
      await refuse("runner", "Runner state is for another run", editFile(runnerStatePath, v => { v.runId = randomUUID(); }), restoreRunnerFile);
      await refuse("runner", "Runner state is for another lease", editFile(runnerStatePath, v => { v.environmentLeaseId = next.lease.id; }), restoreRunnerFile);
      await refuse("runner", "Runner state is for another conversation", editFile(runnerStatePath, v => { v.normalizedSessionId = "other"; }), restoreRunnerFile);
      await refuse("runner", "Runner state file missing", () => import("node:fs/promises").then(fs => fs.rename(runnerStatePath, `${runnerStatePath}.judge`)),
        () => import("node:fs/promises").then(fs => fs.rename(`${runnerStatePath}.judge`, runnerStatePath)));
      await refuse("runner", "Pi provider has an active turn", editFile(providerStatePath, v => { v.activeProviderTurnId = "turn"; }), restoreProviderFile);
      await refuse("runner", "Pi provider lifecycle turn_active", editFile(providerStatePath, v => { v.lifecycle = "turn_active"; }), restoreProviderFile);
      await refuse("runner", "Pi completed turn not authoritative", editFile(providerStatePath, v => { v.completedTurnAuthoritative = false; }), restoreProviderFile);
      await refuse("runner", "Pi provider has queued events", editFile(providerStatePath, v => { v.queuedEvents = [{}]; }), restoreProviderFile);
      await refuse("runner", "Pi provider has a pending tool call", editFile(providerStatePath, v => { v.toolBridge = { pending: { call: {} } }; }), restoreProviderFile);
      await refuse("runner", "Pi native conversation id changed", editFile(providerStatePath, v => { v.providerSessionId = "other"; v.threadId = "other"; }), restoreProviderFile);
      await refuse("runner", "provider is not Pi", editFile(providerStatePath, v => { v.config = { ...(v.config as object), provider: "codex", driver: "codex_app_server" }; }), restoreProviderFile);
      const journal = join(runnerDir, "process-lineage", "lineage-99999-0.json");
      await refuse("runner", "an unretired process-lineage journal remains", () => writeFile(journal, "{}"), () => import("node:fs/promises").then(fs => fs.rm(journal)));
      const liveWriter = join(runnerDir, "process-lineage", `writer-${process.pid}.json`);
      const selfStart = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(/\s+/)[19]);
      await refuse("runner", "a recorded writer process is still alive", () => writeFile(liveWriter, JSON.stringify({ schema: "paperclip.runner.process-lineage-writer.v1",
        writer: { pid: process.pid, started: selfStart } })), () => import("node:fs/promises").then(fs => fs.rm(liveWriter)));
      await refuse("runner", "remote read fails (command exits 1)", none, none, () => admit({}, {}, { execute: async () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "" }) } as never));
      await refuse("runner", "remote read times out", none, none, () => admit({}, {}, { execute: async () => ({ exitCode: 0, timedOut: true, stdout: "{}", stderr: "" }) } as never));
      await refuse("runner", "remote read throws", none, none, () => admit({}, {}, { execute: async () => { throw new Error("sandbox gone"); } } as never));
      await refuse("runner", "target has no command runner", none, none, () => admit({}, { runner: undefined }));

      // --- race: a fact changes WHILE the remote measurement is in flight
      const racing = (mutate: () => Promise<unknown>): CommandManagedRuntimeRunner => ({ execute: async input => {
        const result = await commandRunner(next.lease.id).execute(input); await mutate(); return result; } });
      await refuse("race", "an owner claims the stopped run during the remote read", none, restoreOwner,
        () => admit({}, {}, racing(setOwner({ leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 600_000) }))));
      await refuse("race", "the task moves to another run during the remote read", none, restoreIssue,
        () => admit({}, {}, racing(() => db!.update(issues).set({ executionRunId: first.runId }).where(eq(issues.id, issueId)))));
      await refuse("race", "the successor lease is released during the remote read", none, restoreLease(curLease),
        () => admit({}, {}, racing(setLease(next.lease.id, { status: "released", releasedAt: new Date() }))));
      await refuse("race", "the successor run is cancelled during the remote read", none, restoreRun(curRun),
        () => admit({}, {}, racing(setRun(next.runId, { status: "cancelled" }))));

      // --- liveness (INFO, not safety): an UNRELATED column changes while the remote measurement is in flight
      const info = async (name: string, runnerWith: CommandManagedRuntimeRunner, restore: () => Promise<unknown>) => {
        let outcome = "INFO admitted", detail: string | undefined;
        try { await admit({}, {}, runnerWith); } catch (error) { outcome = "INFO refused (false refusal: nothing about the stop evidence changed)"; detail = error instanceof Error ? error.message : String(error); }
        finally { await restore(); }
        judgeRows.push({ n: ++n, group: "liveness", case: name, outcome, detail });
      };
      await info("successor run's updatedAt is bumped during the remote read (e.g. a heartbeat write)", racing(setRun(next.runId, { updatedAt: new Date(Date.now() + 1000) })), restoreRun(curRun));
      await info("successor lease's lastUsedAt is bumped during the remote read (e.g. a lease touch)", racing(setLease(next.lease.id, { lastUsedAt: new Date(Date.now() + 1000) })), restoreLease(curLease));

      expect(await dbDigest(), "every mutation restored (DB)").toBe(dbBefore);
      expect(await fileDigest(), "every mutation restored (files)").toBe(filesBefore);
      await control("unmodified evidence again, after the whole table (state fully restored)");
      await writeFile(join(root, "judge-refusal-table.json"), JSON.stringify(judgeRows, null, 2));
      if (process.env.JUDGE_TABLE_OUT) await writeFile(process.env.JUDGE_TABLE_OUT, JSON.stringify(judgeRows, null, 2));
      console.log(`[judge] refusal table: ${judgeRows.length} rows; admitted-but-should-refuse=${judgeRows.filter(row => row.outcome.includes("BAD")).length}`);
      expect(judgeRows.filter(row => row.outcome.includes("BAD")), "cases that were ADMITTED but must be refused").toEqual([]);
    }
    // =================== END RFL JUDGE PROBE ===================
    const nextBackend = await backend(next, "resumed");
    // This is the real returned production backend, not a spy or a fake result.
    if (!nextBackend.recoverSession) throw new Error("native backend has no recoverSession");
    const recovered = await nextBackend.recoverSession(snapshot, { signal: AbortSignal.timeout(120_000) });
    expect(recovered.recovered, recovered.reason).toBe(true); expect(recovered.session).toBeDefined();
    sessions.push(recovered.session!);
    const continued = await runTurn(recovered.session!, next);
    expect(continued.file).toBe(initial.file);
    expect(continued.snapshot.providerSessionId).toBe(initial.snapshot.providerSessionId);
    expect(processPairs[1]!.runner.pid).not.toBe(processPairs[0]!.runner.pid);
    expect(processPairs[1]!.pi.pid).not.toBe(processPairs[0]!.pi.pid);
    expect(readFileSync(initial.file).subarray(0, before.length).equals(before)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ historyHasFact: true, latestPromptHasFact: false, reply: `RECALLED_${fact}` });
    expect(JSON.stringify(continued.events)).toContain(fact);
    await cancelThenClose(recovered.session!, "lease continuity proof complete");
    await vi.waitFor(() => {
      expect(sameBirth(processPairs[1]!.runner)).toBe(false); expect(sameBirth(processPairs[1]!.pi)).toBe(false);
    }, { timeout: 5000, interval: 50 });
    await Promise.all(pumps);
    // Existing Rust raw provider trace: successful matching thread/resume is
    // emitted by the real child proxy only after PiRpcDriver.recoverSession.
    const tracePath = join(root, `${next.runId}.provider-trace.jsonl`);
    const trace = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const frames = trace.filter(frame => frame.kind === "frame").map(frame => {
      const raw = Buffer.from(frame.rawBase64, "base64").toString("utf8");
      try { return { direction: frame.direction, frame: JSON.parse(raw) }; } catch { return { direction: frame.direction, frame: { raw } }; }
    });
    const resumes = frames.filter(entry => entry.frame.method === "thread/resume");
    expect(resumes, "exactly one real Rust -> Pi proxy resume required; no replay").toHaveLength(1);
    const resume = resumes[0];
    expect(resume!.frame.params?.threadId).toBe(initial.snapshot.providerSessionId);
    const response = frames.find(entry => entry.direction !== resume!.direction
      && entry.frame.id === resume!.frame.id && entry.frame.result !== undefined);
    expect(response, "matching successful real proxy resume response required").toBeDefined();
    expect(response!.frame.error).toBeUndefined();
    expect(record(record(response!.frame.result).thread).sessionId).toBe(initial.snapshot.providerSessionId);
    const controllerRoot = scopedRunnerdStateRoot(next.execution);
    // Ordinary remote recoverSession rotates authority-epochs, not the
    // executor's different continuity-breaks lane. Require exact preserved
    // bytes on BOTH sides, rather than accepting a directory name alone.
    const archives = join(controllerRoot, "authority-epochs");
    const epochs = readdirSync(archives).filter(name => name.startsWith("epoch-"));
    expect(epochs, "exactly one predecessor authority rotation").toHaveLength(1);
    const controllerArchive = join(archives, epochs[0]!, "control-plane", "control-plane-state.json");
    const runnerArchive = join(remoteSessionRoot, "authority-epochs", epochs[0]!, "runner-state.json");
    expect((await readFile(controllerArchive)).equals(sourceControllerBytes)).toBe(true);
    expect((await readFile(runnerArchive)).equals(sourceRunnerBytes)).toBe(true);
    expect(JSON.parse(sourceControllerBytes.toString()).identity).toMatchObject({ runId: first.runId,
      environmentLeaseId: first.lease.id, normalizedSessionId: first.native.normalizedSessionId, runnerInstanceId: first.native.runnerInstanceId });
    expect((await readFile(initial.file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(line => line.type === "session")).toHaveLength(1);
    await writeFile(join(root, "proof.json"), JSON.stringify({ scope: "actual DB admission + split filesystem, same simulated allocation/new sandbox lease; no Boat service",
      oldLeaseId: first.lease.id, newLeaseId: next.lease.id, providerLeaseId, normalizedSessionId: first.native.normalizedSessionId,
      sessionFile: initial.file, providerSessionId: continued.snapshot.providerSessionId, selectedRunId: selected!.id,
      processPairs, requests, actualRecoverSession: { tracePath, resume, response }, receipt, controllerRoot, controllerArchive, runnerArchive, fact,
      sha256Before: createHash("sha256").update(before).digest("hex") }, null, 2));
    stage("safe successor recalled Pi-only fact after actual recoverSession");
  } catch (error) { failure = error; throw error; }
  finally {
    const errors: unknown[] = [];
    for (const session of sessions) {
      if (closedSessions.has(session)) continue;
      // Plain close deliberately retains an unsettled remote runner. Commit
      // real cancellation first; never use transport teardown as exit proof.
      try { await cancelThenClose(session, "owned lease proof cleanup"); } catch (error) { errors.push(error); }
    }
    await Promise.all(pumps);
    for (const socket of sockets) socket.terminate();
    ws.close();
    if (preview?.listening) await new Promise<void>(done => preview!.close(() => done()));
    model.closeAllConnections();
    if (model.listening) await new Promise<void>(done => model.close(() => done()));
    if (db) {
      for (const [name, table] of [["runs", heartbeatRuns], ["leases", environmentLeases], ["events", heartbeatRunEvents], ["owners", nativeRunFinalizations]] as const) {
        try { await writeFile(join(root, `${name}.json`), JSON.stringify(await db.select().from(table), null, 2)); } catch (error) { errors.push(error); }
      }
    }
    try { await stopPostgres?.(); } catch (error) { errors.push(error); }
    fixtureHttpsAgent?.destroy(); https.globalAgent = previousHttpsAgent;
    setDefaultCACertificates(previousCertificates); vi.unstubAllEnvs();
    await writeFile(join(root, "stages.json"), JSON.stringify(stages, null, 2));
    await writeFile(join(root, "commands.json"), JSON.stringify(commands, null, 2));
    await writeFile(join(root, "requests.json"), JSON.stringify(requests, null, 2));
    await writeFile(join(root, "prp-events.json"), JSON.stringify(eventSets, null, 2));
    await writeFile(join(root, "processes.json"), JSON.stringify({ spawned, processPairs, remainingOwned: spawned.filter(sameBirth), runtimeRequests }, null, 2));
    console.log(`Pi sandbox lease evidence retained: ${root}`);
    if (spawned.some(sameBirth) || processPairs.some(pair => sameBirth(pair.pi))) errors.push(new Error("owned runner/Pi still alive after cleanup"));
    if (failure) await writeFile(join(root, "failure.txt"), failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "lease proof body/cleanup failed; evidence retained");
  }
}, 600_000);
