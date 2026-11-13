import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import https, { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { eq, sql } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it, vi } from "vitest";
import {
  agents, authUsers, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations, plugins, issueRecoveryActions, workspaceOperations,
} from "@paperclipai/db";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { heartbeatService } from "../services/heartbeat.js";
import { prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { preserveNativeFailedWorkspace } from "../services/native-runtime/native-failed-workspace-recovery.js";
import { reconcileRetainedWorkspaces } from "../services/workspace-recovery.js";
import { PAPERCLIP_RUNNER_INGRESS_PORT } from "@paperclipai/adapter-utils/runner-connectivity";
import {
  canonicalNativeRuntimeContextDigest, configuredEnvironmentProjection,
} from "../vendor/paperclip-runner/index.js";
import { registerLocalRuntimeApiServer } from "../runtime-api.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { closeWarmNativeSessionsForEnvironment, executePaperclipNativeSession, cancelNativeSession } from "../services/native-runtime/native-session-executor.js";
import { currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import {
  buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget,
} from "../services/native-runtime/native-session-resume.js";
import { materializeAsset } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: crosses real DB admission -> real remote runnerd -> real proxy ->
// Pi 1.5.2 -> its own JSONL. Scripted boundaries are loopback Messages and
// sandbox provider RPCs; the default sandbox EnvironmentRuntimeDriver is real.
// This is the SAME simulated allocation resumed under a NEW environment lease,
// not a claim that Boat/SSH, a destroyed VM, or backup relocation was qualified.
// A lease-bound command runner is invalidated only after measured process exit;
// closing the PRP transport by itself is never called sandbox retirement.
// Use the default sandbox driver, including acquisition, command execution,
// capability verification, stop-and-retain receipts and recovery teardown.
// Only its plugin-worker RPC boundary is simulated, following
// heartbeat-warm-lease-failure.test.ts. No production module is mocked.
// Existing lifecycle: doc/DEVELOPING.md:3129-3137.
const WARM_IDLE_MS = 4_000;
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
function ownedProcessTree(runner: Birth): Birth[] {
  const processes = new Map<number, Birth>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const current = birth(Number(name)); if (current) processes.set(current.pid, current);
  }
  const owned: Birth[] = [];
  for (const current of processes.values()) {
    let parent = current.ppid;
    const seen = new Set<number>();
    while (parent !== runner.pid && processes.has(parent) && !seen.has(parent)) {
      seen.add(parent); parent = processes.get(parent)!.ppid;
    }
    if (parent === runner.pid) owned.push(current);
  }
  return owned;
}
function ownedDescendant(runner: Birth, kind: "pi" | "sleep"): Birth | null {
  return ownedProcessTree(runner).find(current => {
    const comm = (() => { try { return readFileSync(`/proc/${current.pid}/comm`, "utf8").trim(); } catch { return ""; } })();
    return kind === "sleep" ? comm === "sleep" : comm === "pi" || current.command.includes("--mode rpc") && current.command.includes("cli.js");
  }) ?? null;
}
function sessionFile(pi: Birth): string {
  const env = Object.fromEntries(readFileSync(`/proc/${pi.pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => {
    const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  if (!env.PAPERCLIP_PI_RUNTIME_DIR || !env.PAPERCLIP_NORMALIZED_SESSION_ID) throw new Error("Pi child lacks its admitted file binding");
  return join(env.PAPERCLIP_PI_RUNTIME_DIR, `${env.PAPERCLIP_NORMALIZED_SESSION_ID}.jsonl`);
}

// I-8j "PRP identity" through the executor, platform-lead's Clone L rows
// (lease3.out): the conversation's warm Runner is closed by Core (its idle
// timer here), so the next turn's box is a verified reuse with no Runner
// reuse and a fresh Runner meets the closed owner's durable root.
// "idle": the box resumes from idle (still running; the first hit).
// "archived": the box resumes from archived (the sticky loop after a failed
// run). Turns 2 and 3 must each continue with history.
for (const resumedFrom of ["idle", "archived", "stopped", "connected", "stop-archived"] as const) {
// needs the probe gate
it.skipIf(!enabled || resumedFrom === "connected")(`Core's idle close or Stop, then a ${resumedFrom} resume of the same box: later turns continue through the executor`, async () => {
  // REG-03 differs from idle expiry: Stop leaves an in-memory warm entry,
  // then provider archival removes its processes before the next message.
  const stopArchived = resumedFrom === "stop-archived";
  const stopDelayMs = Number(process.env.REG03_DELAY_MS ?? "0");
  if (!Number.isSafeInteger(stopDelayMs) || stopDelayMs < 0) throw new Error("REG03_DELAY_MS must be a nonnegative safe integer");
  const startupEvents: Array<{ runId: string; event: AdapterRuntimeEvent }> = [];
  let boxState: "running" | "archived" | "destroyed" = "running";
  let stoppedAt: string | undefined;
  let lastRebootAt: string | undefined;
  let boxGeneration = 0;
  const providerCalls: unknown[] = [];
  const syncs = new Map<string, NonNullable<Awaited<ReturnType<typeof prepareNativeWorkspaceSync>>>>();
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
  const spawned: Birth[] = [], processPairs: Array<{ runner: Birth; pi: Birth }> = [];
  const runnerMarkers = new Set<string>();
  const observeRunnerProcesses = () => {
    for (const marker of runnerMarkers) {
      try {
        const fields = readFileSync(marker, "utf8").trim().split("\n");
        const current = birth(Number(fields[1]));
        if (!current?.command.includes("runnerd") || fields[4] !== `linux:${current.bootId}:${current.startTicks}`) continue;
        if (!spawned.some(owned => owned.pid === current.pid && owned.startTicks === current.startTicks && owned.bootId === current.bootId)) {
          spawned.push(current); stage("real runner observed from durable marker", current);
        }
        const pi = ownedDescendant(current, "pi");
        if (pi && !processPairs.some(pair => pair.pi.pid === pi.pid && pair.pi.startTicks === pi.startTicks)) processPairs.push({ runner: current, pi });
      } catch { /* Marker not published yet, or the archived box has no process. */ }
    }
  };
  const stage = (name: string, detail: unknown = {}) => { stages.push({ at: new Date().toISOString(), name, detail }); console.log(`[pi-lease] ${name}`); };
  const runtimeRequests: string[] = [];
  // Stop mid-TOOL by default, after a real bash/sleep is observed. The optional
  // REG03_STOP_PHASE=text variant holds a real streaming response instead.
  const judgeHold = { active: false, inFlight: 0, closed: 0 };
  const midText = process.env.REG03_STOP_PHASE === "text";
  const toolMarker = join(remoteCwd, "reg03-tool-started.pid");
  let toolBirth: Birth | undefined;
  let finishHeldResponse: (() => void) | undefined;
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
        const useTool = judgeHold.active && !midText;
        const finish = () => {
          emit("content_block_stop", { index: 0 });
          if (useTool) {
            const input = { command: `echo $$ > ${toolMarker}; echo REG03_UNSAVED_CHANGE >> ${join(remoteCwd, "saved.txt")}; sleep 300; echo SHOULD_NOT_RUN > ${join(remoteCwd, "after-stop.txt")}` };
            emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: "reg03-blocked-bash", name: "bash", input: {} } });
            emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
            emit("content_block_stop", { index: 1 });
            requests.at(-1)!.toolUse = input;
          }
          emit("message_delta", { delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
          emit("message_stop", {}); res.end();
        };
        if (judgeHold.active) {
          judgeHold.active = false; judgeHold.inFlight++; requests.at(-1)!.heldMidTurn = true;
          if (midText) { finishHeldResponse = finish; res.on("close", () => { judgeHold.closed++; }); return; }
        }
        finish();
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
  let http: ReturnType<typeof createServer> | undefined;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
  let execution: Promise<unknown> | undefined;
  let earlyOutcome: unknown;
  let activeRunId: string | undefined;
  const execute = async (command: string, args: string[], options: Omit<Parameters<CommandManagedRuntimeRunner["execute"]>[0], "command" | "args"> = {}) =>
    runChildProcess(`pi-lease-${randomUUID()}`, command, args, { cwd: options.cwd ?? remoteCwd,
      env: options.env ?? {}, stdin: options.stdin, timeoutSec: (options.commandTimeoutMs ?? options.timeoutMs ?? 30_000) / 1000, graceSec: 1,
      onLog: options.onLog ?? (async () => {}), onSpawn: options.onSpawn });
  let providerWorker: PluginWorkerManager;
  let runtime: ReturnType<typeof environmentRuntimeService>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let environment: Environment;
  const pluginId = randomUUID(), provider = `reg03-${pluginId}`;
  const localCwd = join(root, "host-workspace");
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
    await mkdir(localCwd);
    await writeFile(join(localCwd, "saved.txt"), "REG03 original workspace\n");
    // Reuse the existing fake PluginWorkerManager seam from
    // heartbeat-warm-lease-failure.test.ts:34-65, not a replacement driver.
    const supportedMethods = ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease",
      "environmentStopLease", "environmentInspectLease", "environmentExecute", "environmentRunnerIngressEndpoint", "environmentRealizeWorkspace"];
    await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: "reg03-provider-fixture", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "disabled", manifestJson: { id: provider, apiVersion: 1, version: "1.0.0",
        displayName: "REG03 provider fixture", description: "Simulated provider RPC; real sandbox driver", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "REG03 provider",
          sandboxCapabilities: { reusableLeases: true, runnerWebSocketIngress: true, persistentProcessSessions: false, incrementalSessionOutput: false },
          configSchema: { type: "object", properties: { image: { type: "string" }, reuseLease: { type: "boolean" } } } }] } });
    const [environmentRow] = await db.insert(environments).values({ id: environmentId, name: "Owned split-filesystem simulation", driver: "sandbox",
      status: "active", config: { provider, image: "fixture:reg03", reuseLease: true, runnerLifecycleMode: "warm",
        runnerIdleTimeoutMs: stopArchived ? 300_000 : WARM_IDLE_MS } }).returning();
    environment = environmentRow as Environment;
    providerWorker = { isRunning: (id: string) => id === pluginId,
      getWorker: (id: string) => id === pluginId ? { supportedMethods } : undefined,
      stopAll: async () => {}, stopWorker: async () => {},
      // This fixed provider has no configuration changes; honour the real
      // PluginWorkerManager subscription/unsubscribe interface used by app.
      onConfigApplied: () => () => {},
      call: async (_pluginId: string, method: string, input: Record<string, unknown>, _timeout?: number,
        onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void>) => {
        expect(_pluginId).toBe(pluginId);
        providerCalls.push({ at: new Date().toISOString(), method, input, boxState, boxGeneration });
        if (method === "environmentAcquireLease" || method === "environmentResumeLease") {
          if (boxState === "destroyed") throw new Error("simulated provider allocation was destroyed; same-box resume is impossible");
          if (method === "environmentAcquireLease") expect(boxGeneration, "never replace this conversation's allocation").toBe(0);
          const resumedFromState = method === "environmentResumeLease" ? boxState : undefined;
          if (method === "environmentResumeLease") expect(input.providerLeaseId).toBe(providerLeaseId);
          if (method === "environmentAcquireLease" || boxState === "archived") {
            boxGeneration++; lastRebootAt = new Date().toISOString();
          }
          boxState = "running";
          return { providerLeaseId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd, resumedFromState } };
        }
        if (method === "environmentStopLease" || method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          // A simulated VM stop really destroys its process generation, but not disk.
          observeRunnerProcesses();
          const owned = [...spawned.flatMap(runner => ownedProcessTree(runner)), ...spawned];
          for (const child of owned) if (sameBirth(child)) process.kill(child.pid, "SIGKILL");
          await vi.waitFor(() => expect(owned.some(sameBirth)).toBe(false), { timeout: 15_000 });
          boxState = method === "environmentDestroyLease" ? "destroyed" : "archived"; stoppedAt = new Date().toISOString();
          leaseActive.set(providerLeaseId, false);
          stage("provider stop ended the actual process generation", { method, boxGeneration, providerLeaseId, owned });
          return { providerLeaseId, state: boxState === "destroyed" ? "destroyed" : "stopped" };
        }
        if (method === "environmentInspectLease") {
          expect(input.providerLeaseId).toBe(providerLeaseId);
          return { providerLeaseId, state: boxState === "archived" ? "stopped" : boxState === "running" ? "active" : "destroyed",
            stoppedAt, lastRebootAt, observedAt: new Date().toISOString() };
        }
        if (method === "environmentRealizeWorkspace") return { cwd: remoteCwd };
        if (method === "environmentRunnerIngressEndpoint") {
          expect(boxState).toBe("running");
          const path = String(input.path);
          previewBindings.set(path, providerLeaseId);
          leaseActive.set(providerLeaseId, true);
          return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
            secretHeaders: [{ name: "X-Owned-Lease", value: providerLeaseId }], generation: `box-${boxGeneration}` };
        }
        if (method === "environmentExecute") {
          const commandEvidence: Record<string, unknown> = { at: new Date().toISOString(), command: input.command, args: input.args,
            boxState, activeRunId, stack: new Error("provider execute provenance").stack };
          commands.push(commandEvidence);
          if (boxState !== "running") {
            commandEvidence.error = "simulated provider: archived box cannot execute";
            throw new Error(String(commandEvidence.error));
          }
          try {
            const result = await execute(String(input.command), input.args as string[] ?? [], { cwd: input.cwd as string | undefined,
              env: input.env as Record<string, string>, stdin: input.stdin as string | undefined,
              timeoutMs: input.timeoutMs as number | undefined, commandTimeoutMs: input.commandTimeoutMs as number | undefined, onLog });
            Object.assign(commandEvidence, { exitCode: result.exitCode, timedOut: result.timedOut });
            observeRunnerProcesses();
            return result;
          } catch (error) {
            commandEvidence.error = String(error);
            throw error;
          }
        }
        throw new Error(`Unexpected simulated provider RPC: ${method}`);
      } } as unknown as PluginWorkerManager;
    runtime = environmentRuntimeService(db, { pluginWorkerManager: providerWorker });
    heartbeat = heartbeatService(db, { environmentRuntime: runtime, pluginWorkerManager: providerWorker });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Retain the same Pi conversation", description: null,
      assigneeAgentId: agentId, status: "in_progress" }).returning();
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from("Use only the current conversation. Use bash only when explicitly requested. Do not invent missing history.\n") }]);
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const controller = await currentNativeControllerIdentity();
    const seed = async (prompt: string, normalizedSessionId?: string, wakeCommentId?: string, previousLeaseId?: string) => {
      const runId = randomUUID();
      const [run] = await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, ...(normalizedSessionId ? { nativeSessionId: normalizedSessionId } : {}),
        contextSnapshot: { issueId, ...(wakeCommentId ? { wakeCommentId } : {}) } }).returning();
      const acquired = await runtime.acquireRunLease({ companyId, environment, heartbeatRunId: runId, issueId, agentId,
        adapterType: "paperclip_runner", persistedExecutionWorkspace: null, warmRunnerIdleTimeoutMs: stopArchived ? 300_000 : WARM_IDLE_MS });
      const lease = acquired.lease;
      expect(lease.metadata).toMatchObject({ sandboxProviderPlugin: true, pluginId, provider, remoteCwd });
      expect(lease.providerLeaseId).toBe(providerLeaseId);
      const native = await prepareNativeHeartbeatRun({ db: db!, run: run!, issue: issue!, environmentLeaseId: lease.id });
      runnerMarkers.add(join(stagedRuntime, "sessions", createHash("sha256").update(native.normalizedSessionId).digest("hex"), "runner", "runner-process.identity"));
      await db!.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: controller.bootId,
        controllerGeneration: 0, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt,
        leaseOwner: null, leaseExpiresAt: null });
      await db!.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const [contract] = await db!.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const execution = buildNativeExecutionInput({ companyId, agentId, runId, provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh",
        issue: { id: issueId, identifier: "PIL-1", title: issue!.title, description: null, workMode: "standard" }, taskPrompt: prompt,
        workspace: { id: workspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: native.normalizedSessionId,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: resumedFrom === "connected" ? 600_000 : stopArchived ? 300_000 : WARM_IDLE_MS }, runtimeContext,
        completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion, contract: contract!.contractJson as never } });
      // The native authority uses the actual acquired DB id, never the
      // executionWorkspaceId or the unrelated PRP connection lease token.
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ nativeExecutionInput: execution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "pi_rpc") })}::jsonb` })
        .where(eq(heartbeatRuns.id, runId));
      leaseActive.set(lease.id, true);
      return { runId, run: run!, native, execution, lease, prompt, acquired };
    };
    type Fixture = Awaited<ReturnType<typeof seed>>;
    const executionOptions = async (fixture: Fixture) => {
      const target = await resolveEnvironmentExecutionTarget({ db: db!, companyId, adapterType: "paperclip_runner", environment,
        leaseId: fixture.lease.id, leaseMetadata: fixture.lease.metadata, lease: fixture.lease as EnvironmentLease, environmentRuntime: runtime });
      if (target?.kind !== "remote" || target.transport !== "sandbox") throw new Error("real sandbox target missing");
      const sync = await prepareNativeWorkspaceSync({ db: db!, runId: fixture.runId, companyId, workspaceId,
        workspaceLocalDir: localCwd, target, lease: fixture.lease as EnvironmentLease, resourceDisposition: "keep_running" });
      if (!sync) throw new Error("workspace sync missing");
      syncs.set(fixture.runId, sync);
      return { db: db!, execution: fixture.execution, runnerInstanceId: fixture.native.runnerInstanceId,
        durableEnvironmentLeaseId: fixture.lease.id, controllerPersistence: { bootId: controller.bootId }, runnerIngressAuthorized: true,
        runnerExecutionTarget: target, runnerRemoteBinaryPath: runnerBinary, runnerRemoteProviderPackPath: providerPack,
        // The projection admits ordinary configured variables only. Pi home,
        // provider routing and raw trace are generated controller-owned keys;
        // placing them inside the projection silently removes them.
        runnerEnvironment: { PATH: process.env.PATH, ...configuredEnvironmentProjection({ PI_OFFLINE: "1", TMPDIR: process.env.TMPDIR! }),
          PI_CODING_AGENT_DIR: agentHome, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none",
          PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${modelAddress.port}`, PAPERCLIP_PROVIDER_TRACE_PATH: join(root, `${fixture.runId}.provider-trace.jsonl`) },
        onEvent: async (event: AdapterRuntimeEvent) => { startupEvents.push({ runId: fixture.runId, event }); },
        onSpawn: async (meta: { pid: number }) => {
          const owned = birth(meta.pid);
          // A launch and its attach can report the same birth. Count process
          // generations, not callbacks; retain the exact birth identity.
          if (owned && !spawned.some(previous => previous.pid === owned.pid
            && previous.startTicks === owned.startTicks && previous.bootId === owned.bootId)) {
            spawned.push(owned); stage("real runner spawned", owned);
          } else stage(owned ? "repeated runner birth callback" : "transient spawn callback", meta);
        },
        onLog: async (stream: "stdout" | "stderr", text: string) => { stages.push({ stream, text }); await appendFile(join(root, "native.log"), `${stream}: ${text}`); } };
    };

    let stopRun: ((runId: string) => Promise<void>) | undefined;
    if (stopArchived) {
      // Same real board route as native-pi-rpc-stop-continue.e2e.test.ts.
      const [{ createApp }, { createStorageService }, { createLocalDiskStorageProvider }] = await Promise.all([
        import("../app.js"), import("../storage/service.js"), import("../storage/local-disk-provider.js"),
      ]);
      await db.insert(authUsers).values({ id: "local-board", name: "REG-03 Stop operator", email: "reg03@example.invalid",
        createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      app = await createApp(db, { uiMode: "none", serverPort: 0,
        storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
        deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
        authReady: true, companyDeletionEnabled: false, instanceId: `reg03-${randomUUID()}`,
        localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [], pluginWorkerManager: providerWorker,
        decisionServiceOptions: { wakeOriginAgent: async () => undefined } });
      await app.locals.bundledPluginsStartup;
      http = createServer(app);
      await new Promise<void>(done => http!.listen(0, "127.0.0.1", done));
      const address = http.address(); if (!address || typeof address === "string") throw new Error("Stop listener missing");
      const apiUrl = `http://127.0.0.1:${address.port}`;
      vi.stubEnv("PAPERCLIP_API_URL", apiUrl);
      stopRun = async runId => {
        const response = await fetch(`${apiUrl}/api/heartbeat-runs/${runId}/cancel`, { method: "POST",
          headers: { "content-type": "application/json", origin: apiUrl }, body: "{}", signal: AbortSignal.timeout(15_000) });
        const text = await response.text(); expect(response.status, text).toBe(200);
        expect(JSON.parse(text).status).toBe("cancelled");
      };
    }
    // The fixture owns worker startup. Register it after createApp's ordinary
    // plugin loading, so no nonexistent provider package is auto-installed.
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId));
    const first = await seed("Invent a private fact, say it once, and retain it only in your assistant history.");
    activeRunId = first.runId;
    const firstOptions = await executionOptions(first);
    const firstOutcome = await executePaperclipNativeSession({ ...firstOptions, useRunnerd: true, conversationMode: true }).then(
      result => ({ result }), error => ({ error: String(error) }));
    activeRunId = undefined;
    await writeFile(join(root, "execution-outcome.json"), JSON.stringify(firstOutcome, null, 2));
    expect(record(firstOutcome).error, JSON.stringify(firstOutcome)).toBeUndefined();
    // The real plugin execution protocol returns process identity through its
    // durable marker, not an in-process CommandRunner onSpawn callback.
    const markerRoot = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"));
    const marker = (await readFile(join(markerRoot, "runner", "runner-process.identity"), "utf8")).trim().split("\n");
    const runner = birth(Number(marker[1]));
    if (!runner?.command.includes("runnerd")) throw new Error("real runner process marker does not identify runnerd");
    observeRunnerProcesses();
    const pi = ownedDescendant(runner, "pi");
    expect(pi, "the warm Runner and its Pi stay alive after the turn").not.toBeNull();
    expect(sameBirth(runner!)).toBe(true);
    if (!processPairs.some(pair => pair.pi.pid === pi!.pid)) processPairs.push({ runner, pi: pi! });
    const originalFile = sessionFile(pi!);
    const before = await readFile(originalFile);
    expect(before.toString()).toContain(fact);
    const remoteSessionRoot = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"));
    // The heartbeat service settles each finished run around the executor.
    const settle = async (fixture: Fixture) => {
      if (stopArchived) {
        if (fixture === first) {
          await db!.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, fixture.runId));
          await db!.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId));
          await syncs.get(fixture.runId)!.restoreWorkspace();
          await heartbeat.releaseEnvironmentLeasesForRun({ runId: fixture.runId, companyId, agentId,
            status: "succeeded", providerResourceDisposition: "keep_running" });
        } else {
          const [stopped] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
          expect(stopped!.status).toBe("cancelled");
          // The direct-executor fixture drives the same public outer lifecycle
          // calls as heartbeat failure settlement. The real preservation owner
          // creates the active_run_watchdog/no-replay action; it is never seeded.
          await preserveNativeFailedWorkspace(db!, stopped!, { allowPreterminal: true, requireCancelledStop: true });
          const actions = await db!.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
          expect(actions.find(action => action.evidence.runId === fixture.runId)).toMatchObject({ kind: "active_run_watchdog",
            evidence: { automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked" } } });
          const work = await reconcileRetainedWorkspaces(db!, runtime, async () => {});
          await Promise.all(work ?? []);
          const [lease] = await db!.select().from(environmentLeases).where(eq(environmentLeases.id, fixture.lease.id));
          expect(lease!.metadata).toMatchObject({ sandboxStopAndRetainReceipt: { method: "environmentStopLease" } });
          if (!midText) expect(await readFile(join(localCwd, "saved.txt"), "utf8")).toContain("REG03_UNSAVED_CHANGE");
          const operations = await db!.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, fixture.runId));
          expect(operations.some(operation => operation.phase === "workspace_recovery" && operation.status === "succeeded")).toBe(true);
          expect(boxState).toBe("archived");
          stage("real watchdog preservation and stop completed", { lease, operations });
        }
        return;
      }
      await db!.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      await db!.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId));
      if (resumedFrom === "connected") {
        expect(sameBirth(spawned.at(-1)!)).toBe(true);
        await environmentService(db!).releaseLease(fixture.lease.id, "released");
        return;
      }
      // Core's idle timer closes the warm Runner; it suspends and exits.
      const owned = spawned.at(-1)!;
      await vi.waitFor(() => { expect(sameBirth(owned)).toBe(false); }, { timeout: WARM_IDLE_MS + 30_000, interval: 200 });
      expect(JSON.parse(await readFile(join(remoteSessionRoot, "runner", "runner-state.json"), "utf8")).lifecycle,
        "Core's idle close suspended the owner").toBe("suspended");
      stage("Core's idle timer closed the warm Runner", owned);
      leaseActive.set(fixture.lease.id, false);
      await syncs.get(fixture.runId)!.restoreWorkspace();
      await heartbeat.releaseEnvironmentLeasesForRun({ runId: fixture.runId, companyId, agentId, status: "succeeded",
        providerResourceDisposition: resumedFrom === "archived" ? "stop_and_retain" : "keep_running" });
    };
    let previous = first;
    const turn = async (index: number, holdForStop = false) => {
      await settle(previous);
      if (stopArchived && !holdForStop) {
        stage("delay after confirmed Stop before next message", { stopDelayMs });
        await new Promise(resolve => setTimeout(resolve, stopDelayMs));
      }
      const [comment] = await db!.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
        body: holdForStop && !midText ? "Call bash to record an unsaved edit and wait; the board will Stop the tool."
          : `Turn ${index}: recall the private fact from your own earlier assistant history. Do not invent it.` }).returning();
      const next = await seed(comment!.body, first.native.normalizedSessionId, comment!.id, previous.lease.id);
      expect(next.lease.id, "the next acquisition has a different lease id").not.toBe(previous.lease.id);
      const selected = await findNativeSessionResumeRun(db!, { companyId, agentId, issueId, normalizedSessionId: first.native.normalizedSessionId,
        currentRunId: next.runId, beforeCreatedAt: next.run.createdAt });
      expect(selected?.id).toBe(previous.runId);
      next.native.runnerInstanceId = selected!.runnerInstanceId!;
      await db!.update(heartbeatRuns).set({ runnerInstanceId: next.native.runnerInstanceId }).where(eq(heartbeatRuns.id, next.runId));
      const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: first.native.normalizedSessionId,
        executionTargetKind: "remote", buildExecution: () => next.execution });
      if (admission.checkpoint) await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ sessionCheckpoint: admission.checkpoint })}::jsonb` }).where(eq(heartbeatRuns.id, next.runId));
      // The same box resumes from idle or archived. Archived sets the restarted
      // trigger; the owner's process generation must still be proven gone.
      const nextOptions = await executionOptions(next);
      const beforeCommands = commands.length;
      if (stopArchived && !holdForStop) {
        expect(nextOptions.runnerExecutionTarget.sandboxLeaseAcquisition).toMatchObject({ outcome: "resumed", providerLeaseId, restarted: true });
        stage("same thread resumes the same box from archived", { runId: next.runId, issueId, providerLeaseId });
      }
      activeRunId = next.runId; earlyOutcome = undefined;
      judgeHold.active = holdForStop;
      execution = executePaperclipNativeSession({ ...nextOptions, useRunnerd: true, conversationMode: true }).then(
        result => (earlyOutcome = { result }), error => (earlyOutcome = { error: String(error) }));
      if (holdForStop) {
        await vi.waitFor(() => expect(judgeHold.inFlight === 1 || earlyOutcome !== undefined).toBe(true), { timeout: 120_000, interval: 100 });
        if (earlyOutcome) throw new Error(`turn 1 ended before Stop: ${JSON.stringify(earlyOutcome)}`);
        expect(requests.at(-1)).toMatchObject({ heldMidTurn: true });
        if (!midText) {
          await vi.waitFor(() => {
            const bashPid = Number(readFileSync(toolMarker, "utf8").trim());
            const bash = birth(bashPid);
            expect(bash).not.toBeNull();
            const sleep = ownedDescendant(runner!, "sleep");
            expect(sleep, "real blocked tool must exist before Stop").not.toBeNull();
            toolBirth = sleep!;
          }, { timeout: 30_000, interval: 100 });
          expect(earlyOutcome).toBeUndefined();
        }
        stage(midText ? "turn held mid-text before real board Stop" : "turn blocked mid-TOOL before real board Stop",
          { runId: next.runId, toolBirth });
        await stopRun!(next.runId);
      }
      const outcome = await execution; execution = undefined; activeRunId = undefined;
      await writeFile(join(root, `turn-${index}-outcome.json`), JSON.stringify(outcome, null, 2));
      const reuse = startupEvents.filter(row => row.runId === next.runId && row.event.eventType === "run.startup.reuse").map(row => row.event.payload);
      await writeFile(join(root, `turn-${index}-startup-reuse.json`), JSON.stringify(reuse, null, 2));
      if (holdForStop) {
        const [stopped] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId));
        expect(stopped!.status).toBe("cancelled");
        expect(record(record(stopped!.resultJson).nativeCancellation).dispatchState).toBe("acknowledged");
        expect(sameBirth(runner!), "Stop settled before allocation archival").toBe(true);
        if (toolBirth) await vi.waitFor(() => expect(sameBirth(toolBirth!)).toBe(false), { timeout: 15_000 });
        stage("Stop settled; warm runner still resident before archival", { outcome, runId: next.runId });
        previous = next;
        return { next, runnerReuse: undefined };
      }
      if (stopArchived) {
        expect(reuse.filter(payload => record(payload).layer === "runner")).not.toContainEqual(
          expect.objectContaining({ layer: "runner", state: "reused", reason: "verified_reuse" }));
        expect(reuse.find(payload => record(payload).layer === "provider_session"), "provider continuity receipt").toMatchObject({
          layer: "provider_session", state: "reused", reason: "verified_reuse",
        });
        expect(spawned, "the next turn launched a replacement Runner").toHaveLength(2);
        expect(sameBirth(spawned.at(-1)!)).toBe(true);
        expect(sameBirth(runner)).toBe(false);
        stage("archived resume replaced Runner and retained provider history", reuse);
      }
      expect(record(outcome).error, `turn ${index}: ${JSON.stringify(outcome)}`).toBeUndefined();
      if (resumedFrom === "connected") {
        expect(commands.slice(beforeCommands).filter(command =>
          (record(command).args as string[] | undefined)?.[2] === "paperclip-runner-generation-marker"),
        "ordinary warm turns must not execute a generation probe").toEqual([]);
        expect(new Set(spawned.map(entry => entry.pid)).size, "the connected Runner is retained").toBe(1);
      }
      expect(record(outcome).result).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId, summary: `RECALLED_${fact}` });
      expect(requests).toHaveLength(stopArchived ? index + 1 : index);
      expect(requests.at(-1)).toMatchObject({ historyHasFact: true, latestPromptHasFact: false, reply: `RECALLED_${fact}` });
      expect((await readFile(originalFile)).subarray(0, before.length).equals(before)).toBe(true);
      const events = await db!.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next.runId));
      const runnerReuse = events.find(event => event.eventType === "run.startup.reuse" && record(event.payload).layer === "runner");
      stage(`turn ${index} continued the same conversation`, { runId: next.runId, runnerReuse: runnerReuse ? record(runnerReuse.payload) : null });
      previous = next;
      return { next, runnerReuse };
    };
    // The real route (I-8j, Clone L): the box is env-reused, but each next
    // acquisition gets a different lease id. Core then closes the warm owner
    // itself; nothing in this test closes it.
    if (stopArchived) await turn(1, true);
    for (const index of stopArchived ? [2] : [2, 3]) {
      const { next } = await turn(index);
      const leases = await db!.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, next.runId));
      expect(leases.map(lease => lease.providerLeaseId)).toEqual([providerLeaseId]);
    }
    const epochs = resumedFrom === "connected" ? []
      : readdirSync(join(remoteSessionRoot, "authority-epochs")).filter(name => name.startsWith("epoch-"));
    await writeFile(join(root, "proof.json"), JSON.stringify({ scope: "executePaperclipNativeSession warm path; real runnerd/proxy/Pi; simulated allocation and loopback model",
      firstRunId: first.runId, nativeSessionId: first.native.normalizedSessionId, requests, processPairs, epochs, startupEvents, stopArchived, stopDelayMs }, null, 2));
    stage(`GREEN: three turns of the same conversation across Core's idle closes (${resumedFrom})`, { epochs });
    await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "closed-owner proof complete" });
  } catch (error) { failure = error; throw error; }
  finally {
    const errors: unknown[] = [];
    if (activeRunId && !earlyOutcome) try { await cancelNativeSession(activeRunId, "test cleanup", { db: db! }); } catch (error) { errors.push(error); }
    try { await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "test cleanup" }); } catch (error) { errors.push(error); }
    // A failed transport can strand the simulated VM's detached processes.
    // Cleanup only this fixture's exact births, after product closure attempted.
    observeRunnerProcesses();
    for (const owned of [...spawned.flatMap(runner => ownedProcessTree(runner)), ...processPairs.map(pair => pair.pi), ...spawned])
      if (sameBirth(owned)) process.kill(owned.pid, "SIGKILL");
    await vi.waitFor(() => { expect(spawned.some(sameBirth) || processPairs.some(pair => sameBirth(pair.pi))).toBe(false); }, { timeout: 15_000 });
    finishHeldResponse?.();
    if (execution) await execution;
    await app?.locals.paperclipShutdown?.();
    if (http?.listening) { http.closeAllConnections(); await new Promise<void>(done => http!.close(() => done())); }
    for (const socket of sockets) socket.terminate();
    ws.close();
    if (preview?.listening) await new Promise<void>(done => preview!.close(() => done()));
    model.closeAllConnections();
    if (model.listening) await new Promise<void>(done => model.close(() => done()));
    if (db) {
      for (const [name, table] of [["runs", heartbeatRuns], ["leases", environmentLeases], ["events", heartbeatRunEvents], ["owners", nativeRunFinalizations],
        ["recovery-actions", issueRecoveryActions], ["workspace-operations", workspaceOperations]] as const) {
        try { await writeFile(join(root, `${name}.json`), JSON.stringify(await db.select().from(table), null, 2)); } catch (error) { errors.push(error); }
      }
    }
    try { await stopPostgres?.(); } catch (error) { errors.push(error); }
    fixtureHttpsAgent?.destroy(); https.globalAgent = previousHttpsAgent;
    setDefaultCACertificates(previousCertificates); vi.unstubAllEnvs();
    await writeFile(join(root, "startup-events.json"), JSON.stringify(startupEvents, null, 2));
    await writeFile(join(root, "stages.json"), JSON.stringify(stages, null, 2));
    await writeFile(join(root, "commands.json"), JSON.stringify(commands, null, 2));
    await writeFile(join(root, "provider-calls.json"), JSON.stringify(providerCalls, null, 2));
    await writeFile(join(root, "requests.json"), JSON.stringify(requests, null, 2));
    await writeFile(join(root, "processes.json"), JSON.stringify({ spawned, processPairs, remainingOwned: spawned.filter(sameBirth), runtimeRequests }, null, 2));
    console.log(`Pi sandbox lease evidence retained: ${root}`);
    if (spawned.some(sameBirth) || processPairs.some(pair => sameBirth(pair.pi))) errors.push(new Error("owned runner/Pi still alive after cleanup"));
    if (failure) await writeFile(join(root, "failure.txt"), failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "lease proof body/cleanup failed; evidence retained");
  }
}, 600_000);
}
