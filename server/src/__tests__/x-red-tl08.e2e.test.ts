// xr-tl08 — TARGET assertions for S, not an implementation or a GREEN claim.
// Copied/adapted from native-pi-rpc-replaced-box-followup.e2e.test.ts (not imported).
// Real: issue PATCH/comments as board actor, claimed terminal teardown, DB admission,
// controller process, runnerd, TLS PRP, qualified Pi 1.5.2, Pi JSONL and model
// request history. Faked: provider allocation/RPC and loopback Messages only.
// No production mocks, fabricated checkpoint/receipt, backup removal or it.fails.
// All Pi rows are serial in THIS file: runnerd uses a fixed ingress port.
// Expected RED: 1/1b/1c need S's stopped-source restore and/or first-attempt
// retirement at forgetUnretiredOwnerOnOtherSandbox (NSE:919-933). -2 also catches
// silence/duplicate notices. -5/-6 are retained controls, not manufactured REDs.
// DB-only -3/-4 belong to s-build2, deliberately NOT duplicated here.
// expected-skip: PAPERCLIP_PI_LEASE_E2E != 1: opt-in real Runner/Pi/DB fixture.
// Once enabled, ALL prerequisites fail loudly; never runtime-skip a row.
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import https, { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations, nativeRunResults, plugins,
} from "@paperclipai/db";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { PAPERCLIP_RUNNER_INGRESS_PORT } from "@paperclipai/adapter-utils/runner-connectivity";
import { canonicalNativeRuntimeContextDigest, configuredEnvironmentProjection } from "../vendor/paperclip-runner/index.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { selectPiConversation } from "../services/native-runtime/pi-conversation-record.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { scopedRunnerdStateRoot, verifyNativeHarnessBackupStreamed } from "../services/native-runtime/native-session-executor.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget } from "../services/native-runtime/native-session-resume.js";
import { materializeAsset } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { HELD_PREDECESSOR_NOTICE } from "../services/native-runtime/held-predecessor-notice-text.js";
import { FRESH_THREAD_STARTED_NOTE } from "../services/native-runtime/fresh-thread-stop-gate.js";

const enabled = process.env.PAPERCLIP_PI_LEASE_E2E === "1";
// The +5 min row must NOT accidentally expire the in-memory owner. Paul's
// incident held that owner for 8 h, rather than the base harness's 5 min.
const WARM_IDLE_MS = 8 * 60 * 60_000;
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
  return [...processes.values()].filter(current => {
    let parent = current.ppid;
    const seen = new Set<number>();
    while (parent !== runner.pid && processes.has(parent) && !seen.has(parent)) {
      seen.add(parent); parent = processes.get(parent)!.ppid;
    }
    return parent === runner.pid;
  });
}
function sessionFile(pi: Birth): string {
  const env = Object.fromEntries(readFileSync(`/proc/${pi.pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => {
    const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  if (!env.PAPERCLIP_PI_RUNTIME_DIR || !env.PAPERCLIP_NORMALIZED_SESSION_ID) throw new Error("Pi child lacks admitted file binding");
  return join(env.PAPERCLIP_PI_RUNTIME_DIR, `${env.PAPERCLIP_NORMALIZED_SESSION_ID}.jsonl`);
}

// The controller stays ALIVE across DONE and the first follow-up. No-backup
// rows retain the warm owner to exercise TL08; backup rows use the production
// sleep writer, which checkpoints and retires that entry without a restart.
// Only the explicitly named TES-208-path row restarts.
function controllerSource(): string {
  const require = createRequire(import.meta.url);
  const source = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
  return `
import { createDb, environments, environmentLeases, heartbeatRuns, closeRegisteredClients } from ${JSON.stringify(require.resolve("@paperclipai/db"))};
import { eq } from ${JSON.stringify(require.resolve("drizzle-orm"))};
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { environmentRuntimeService } from ${source("../services/environment-runtime.ts")};
import { resolveEnvironmentExecutionTarget } from ${source("../services/environment-execution-target.ts")};
import { executePaperclipNativeSession, closeIdleWarmNativeSessionsForRestart, prepareIdleWarmNativeSessionsForSleep } from ${source("../services/native-runtime/native-session-executor.ts")};
import { currentNativeControllerIdentity } from ${source("../services/native-runtime/native-restart-recovery.ts")};
import { createNativeSessionHandoffLoader } from ${source("../services/native-runtime/native-session-handoff.ts")};
import { registerLocalRuntimeApiServer } from ${source("../runtime-api.ts")};
let db, config, runtime, api, sequence = 0;
const pending = new Map();
const send = message => process.send(message);
const rpc = (method, input) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); send({ kind: 'provider', id, method, input });
});
process.on('message', async message => {
  if (message.kind === 'providerReply') {
    const waiter = pending.get(message.id); pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.result);
    return;
  }
  if (message.kind !== 'call') return;
  try {
    let result;
    if (message.method === 'init') {
      config = message.input;
      const certificates = [...getCACertificates('default'), await readFile(config.ca, 'utf8')];
      setDefaultCACertificates(certificates); https.globalAgent = new https.Agent({ ca: certificates });
      db = createDb(config.connectionString);
      const worker = { isRunning: id => id === config.pluginId,
        getWorker: id => id === config.pluginId ? { supportedMethods: config.supportedMethods } : undefined,
        stopAll: async () => {}, stopWorker: async () => {}, onConfigApplied: () => () => {},
        call: async (pluginId, method, input) => {
          if (pluginId !== config.pluginId) throw new Error('wrong plugin');
          return rpc(method, input);
        } };
      runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
      api = createServer((_req, res) => res.writeHead(404).end());
      registerLocalRuntimeApiServer(api);
      await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
      result = await currentNativeControllerIdentity();
    } else if (message.method === 'execute') {
      const input = message.input;
      const [environment] = await db.select().from(environments).where(eq(environments.id, input.environmentId));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, input.leaseId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.execution.binding.runId));
      const target = await resolveEnvironmentExecutionTarget({ db, companyId: config.companyId, adapterType: 'paperclip_runner',
        environment, leaseId: lease.id, leaseMetadata: lease.metadata, lease, environmentRuntime: runtime });
      if (target?.kind !== 'remote' || target.transport !== 'sandbox') throw new Error('sandbox target missing');
      send({ kind: 'target', runId: run.id, acquisition: target.sandboxLeaseAcquisition });
      result = await executePaperclipNativeSession({ db, execution: input.execution, runnerInstanceId: input.runnerInstanceId,
        adapterType: 'paperclip_runner', useRunnerd: true, conversationMode: true, runnerExecutionTarget: target,
        durableEnvironmentLeaseId: lease.id, controllerPersistence: { bootId: (await currentNativeControllerIdentity()).bootId },
        runnerIngressAuthorized: true, runnerRemoteBinaryPath: config.runnerBinary, runnerRemoteProviderPackPath: config.providerPack,
        runnerCaBundlePath: config.ca, runnerEnvironment: input.runnerEnvironment,
        getFreshSessionHandoff: createNativeSessionHandoffLoader({ db, companyId: config.companyId, agentId: config.agentId,
          issueId: config.issueId, before: run.createdAt }),
        onEvent: async event => send({ kind: 'event', runId: run.id, event }),
        onLog: async (stream, text) => send({ kind: 'log', runId: run.id, stream, text }) });
    } else if (message.method === 'checkpoint') {
      // Use the same production backup writer as x-red-with-backup. It closes
      // and forgets the warm entry; only backup rows take this path. No-backup
      // rows still retain the actual live stale owner across terminal teardown.
      result = await prepareIdleWarmNativeSessionsForSleep({ canRetire: () => true });
    } else if (message.method === 'close') {
      result = await closeIdleWarmNativeSessionsForRestart();
      api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
      await closeRegisteredClients(config.connectionString);
    } else throw new Error('unexpected controller command');
    send({ kind: 'reply', id: message.id, result });
  } catch (error) {
    send({ kind: 'reply', id: message.id, error: String(error), errorCode: error?.code ?? null, stack: error?.stack });
  }
});
send({ kind: 'ready' });
`;
}

type Scenario = {
  id: string; backup: boolean; offsetMs: number; kind: "terminal" | "ordinary" | "agent-finish" | "tes208-path";
  configChange?: boolean; duringTeardown?: boolean; neverSilentOnly?: boolean;
};
const scenarios: Scenario[] = [
  ...[false, true].flatMap(backup => [
    { id: "T-TL08-1", backup, offsetMs: 9_000, kind: "terminal" as const, configChange: true, duringTeardown: true },
    { id: "T-TL08-1b", backup, offsetMs: 60_000, kind: "terminal" as const },
    { id: "T-TL08-1c", backup, offsetMs: 300_000, kind: "terminal" as const },
  ]),
  { id: "T-TL08-2 (never silent)", backup: false, offsetMs: 9_000, kind: "terminal", configChange: true, duringTeardown: true, neverSilentOnly: true },
  { id: "T-TL08-5 (retained control: no teardown, no added wait)", backup: false, offsetMs: 0, kind: "ordinary" },
  { id: "T-TL08-6 (retained control: agent finish stays warm)", backup: false, offsetMs: 0, kind: "agent-finish" },
  { id: "promise notes -> ANSWER (with backup)", backup: true, offsetMs: 60_000, kind: "terminal" },
  // TES-208's replaced-box/plain saved-history path, not a claim to reproduce
  // its entire deployed DB. Hard controller restart retains disk/checkpoints;
  // there is no warm entry and no backup, exactly as the base green N fixture.
  { id: "promise notes -> ANSWER (TES-208 path: plain replaced box)", backup: false, offsetMs: 0, kind: "tes208-path", configChange: true },
];

// Locate the actual note INSERT owner in the checked-out bytes, not a guessed
// file:line. Preserve both semantic caller and shared writer in the diagnostics.
function sourceLine(relative: string, needle: string): string {
  const lines = readFileSync(new URL(relative, import.meta.url), "utf8").split("\n");
  const at = lines.findIndex(line => line.includes(needle));
  if (at < 0) throw new Error(`note writer moved: ${relative} / ${needle}`);
  return `server/src/${relative.replace(/^\.\.\//, "")}:${at + 1}`;
}
function noteWriter(note: typeof issueComments.$inferSelect) {
  const reason = String(record(note.metadata).authorizationReason ?? "");
  if (reason.startsWith("native_prior_owner_held:") || note.body === HELD_PREDECESSOR_NOTICE) {
    const writer = sourceLine("../services/native-runtime/native-session-executor.ts", "await issueService(input.db).addComment(issueId, HELD_PREDECESSOR_NOTICE");
    return { writer, caller: writer, authorizationReason: reason };
  }
  const shared = sourceLine("../services/native-runtime/pi-session-recovery-notice.ts", "const next = await issueService(db).addComment");
  const caller = reason.startsWith("fresh_provider_thread_pending:")
    ? sourceLine("../services/native-runtime/fresh-thread-stop-gate.ts", "await writePiSessionHistoryLossNotice(tx, tx as never")
    : shared;
  return { writer: shared, caller, authorizationReason: reason };
}

const runScenario = async (scenario: Scenario) => {
  const terminal = scenario.kind === "terminal";
  const keepWarm = scenario.kind === "ordinary" || scenario.kind === "agent-finish";
  const ownFinish = scenario.kind === "agent-finish";
  expect(process.platform).toBe("linux");
  expect(process.env.TMPDIR, "dedicated parent-owned TMPDIR required").toBeTruthy();
  const runnerBinary = process.env.PAPERCLIP_RUNNER_BINARY, providerPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
  if (!runnerBinary?.startsWith("/") || !providerPack?.startsWith("/")) throw new Error("Set absolute qualified runner and provider-pack paths");
  await access(runnerBinary, constants.X_OK); await access(providerPack, constants.R_OK | constants.X_OK);
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "xr-tl08-"));
  const remoteCwd = join(root, "simulated-sandbox", "workspace"), localCwd = join(root, "host-workspace");
  const stagedRuntime = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
  await mkdir(remoteCwd, { recursive: true });
  const installImagePack = async () => {
    await mkdir(stagedRuntime, { recursive: true }); await symlink(providerPack, join(stagedRuntime, "provider-pack"), "dir");
  };
  await installImagePack();
  const fact = `XR_TL08_FACT_${randomUUID()}`;
  const followupPrompt = "What private fact did I tell you earlier? Repeat it exactly; do not invent it.";
  const stages: unknown[] = [], commands: Array<Record<string, unknown>> = [], requests: Array<Record<string, unknown>> = [];
  const providerCalls: Array<Record<string, unknown>> = [], startupEvents: Array<{ runId: string; event: AdapterRuntimeEvent }> = [];
  const targets: Array<Record<string, unknown>> = [];
  const spawned: Birth[] = [], piBirths: Birth[] = [], runnerMarkers = new Set<string>();
  const stage = (name: string, detail: unknown = {}) => { stages.push({ at: new Date().toISOString(), name, detail }); console.log(`[xr-tl08] ${name}`); };
  const observeRunnerProcesses = () => {
    for (const marker of runnerMarkers) try {
      const fields = readFileSync(marker, "utf8").trim().split("\n");
      const runner = birth(Number(fields[1]));
      if (!runner?.command.includes("runnerd") || fields[4] !== `linux:${runner.bootId}:${runner.startTicks}`) continue;
      if (!spawned.some(owned => owned.pid === runner.pid && owned.startTicks === runner.startTicks)) spawned.push(runner);
      for (const child of ownedProcessTree(runner)) {
        const comm = (() => { try { return readFileSync(`/proc/${child.pid}/comm`, "utf8").trim(); } catch { return ""; } })();
        if ((comm === "pi" || child.command.includes("--mode rpc") && child.command.includes("cli.js"))
          && !piBirths.some(owned => owned.pid === child.pid && owned.startTicks === child.startTicks)) piBirths.push(child);
      }
    } catch { /* marker may not exist before startup */ }
  };
  const stopBoxProcesses = async () => {
    observeRunnerProcesses();
    const owned = [...spawned.flatMap(ownedProcessTree), ...piBirths, ...spawned];
    for (const child of owned) if (sameBirth(child)) process.kill(child.pid, "SIGKILL");
    await vi.waitFor(() => expect(owned.some(sameBirth), "owned box processes ended").toBe(false), { timeout: 15_000 });
  };
  let activeRunId: string | undefined, openingRunId: string | undefined, openingReport: Record<string, unknown> | undefined;
  const openingToolCallId = `xr-tl08-finish-${randomUUID()}`;
  let generation = 1;
  const allocationIds = [`image-A-${randomUUID()}`, `image-B-${randomUUID()}`];
  const allocations = new Map(allocationIds.map(id => [id, "running" as "running" | "stopped"]));
  const leaseActive = new Map<string, boolean>();
  let destroyRelease!: () => void, destroyEnteredResolve!: () => void;
  const destroyGate = new Promise<void>(resolve => { destroyRelease = resolve; });
  const destroyEntered = new Promise<void>(resolve => { destroyEnteredResolve = resolve; });
  let teardownObserved = false, providerStopped = false, acquiredAllocations = 0;
  let allocationReadyResolve!: () => void;
  const allocationReady = new Promise<void>(resolve => { allocationReadyResolve = resolve; });
  let teardownCompletion: Promise<void> | undefined;
  let patch: Promise<{ status: number; body: unknown }> | undefined;
  const model = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
      try {
        const parsed = JSON.parse(body);
        const opening = activeRunId === openingRunId;
        const useFinishTool = ownFinish && opening && requests.length === 0;
        const messages = parsed.messages as Array<{ role: string; content: unknown }>;
        const latestUserContent = messages.findLast(message => message.role === "user")?.content;
        const toolResult = Array.isArray(latestUserContent) ? latestUserContent.map(record)
          .find(block => block.type === "tool_result" && block.tool_use_id === openingToolCallId) : undefined;
        const containsFact = JSON.stringify(parsed.messages).includes(fact);
        const handoffHasFact = messages.some(message => {
          const content = JSON.stringify(message.content); return content.includes("Fresh session handoff") && content.includes(fact);
        });
        // The oracle never answers from its own fact variable unless the actual
        // follow-up MODEL REQUEST carries it. A history-free answer is a FAIL.
        const reply = containsFact ? `${opening ? "ACK" : "RECALLED"}_${fact}` : "HISTORY_LOST";
        if (useFinishTool) expect((parsed.tools as Array<{ name: string }>).map(tool => tool.name)).toContain("paperclip_finish");
        else if (ownFinish && opening) expect(toolResult, "real result-tool receipt before final text").toBeDefined();
        requests.push({ runId: activeRunId, path: req.url, request: parsed, containsFact, handoffHasFact, reply, toolResult,
          toolUse: useFinishTool ? { name: "paperclip_finish", input: openingReport } : undefined });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        if (useFinishTool) {
          emit("content_block_start", { index: 0, content_block: { type: "tool_use", id: openingToolCallId, name: "paperclip_finish", input: {} } });
          emit("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(openingReport) } });
        } else {
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
        }
        emit("content_block_stop", { index: 0 });
        emit("message_delta", { delta: { stop_reason: useFinishTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
        emit("message_stop", {}); res.end();
      } catch (error) { res.writeHead(500).end(String(error)); }
    });
  });
  const sockets = new Set<WebSocket>(), ws = new WebSocketServer({ noServer: true });
  let preview: ReturnType<typeof createHttpsServer> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let stopPostgres: (() => Promise<void>) | undefined;
  const previousCertificates = getCACertificates("default"), previousHttpsAgent = https.globalAgent;
  let fixtureHttpsAgent: InstanceType<typeof https.Agent> | undefined;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID(), workspaceId = randomUUID();
  const pluginId = randomUUID(), provider = `xr-tl08-${pluginId}`;
  let failure: unknown, followupRunId: string | undefined;
  const controllers: Array<{ child: ChildProcess; stopped: Promise<void>; call: (method: string, input?: unknown) => Promise<Record<string, unknown>> }> = [];
  const execute = async (command: string, args: string[], options: Omit<Parameters<CommandManagedRuntimeRunner["execute"]>[0], "command" | "args"> = {}) =>
    runChildProcess(`xr-tl08-${randomUUID()}`, command, args, { cwd: options.cwd ?? remoteCwd, env: options.env ?? {}, stdin: options.stdin,
      timeoutSec: (options.commandTimeoutMs ?? options.timeoutMs ?? 30_000) / 1000, graceSec: 1, onLog: options.onLog ?? (async () => {}), onSpawn: options.onSpawn });
  try {
    const piBinary = process.env.PI_TEST_BINARY;
    if (!piBinary?.startsWith("/")) throw new Error("Set absolute PI_TEST_BINARY to the qualified Pi 1.5.2 executable");
    await access(piBinary, constants.X_OK);
    const piVersion = await execute(piBinary, ["--version"]);
    const binaries = { runnerd: runnerBinary, runnerdSha256: createHash("sha256").update(await readFile(runnerBinary)).digest("hex"),
      PI_TEST_BINARY: piBinary, piVersion: piVersion.stdout.trim(), providerPack, scenario };
    console.log(`E2E-PI-BINARIES: ${JSON.stringify(binaries)}`);
    await writeFile(join(root, "binaries.json"), JSON.stringify(binaries, null, 2));
    expect(piVersion.exitCode).toBe(0); expect(binaries.piVersion).toBe("1.5.2");
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "controller-state", "durable-sessions"));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    vi.stubEnv("PI_OFFLINE", "1"); vi.stubEnv("OTEL_SDK_DISABLED", "true");
    await new Promise<void>(done => model.listen(0, "127.0.0.1", done));
    const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === "string") throw new Error("Messages listener missing");
    const agentHome = join(root, "pi-agent-fixture"); await mkdir(agentHome);
    await writeFile(join(agentHome, "models.json"), JSON.stringify({ providers: { paperclip: { models: [{ id: "faux", reasoning: true,
      contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } }] } } }));
    const ca = join(root, "preview-ca.crt"), caKey = join(root, "preview-ca.key");
    const key = join(root, "preview.key"), cert = join(root, "preview.crt"), csr = join(root, "preview.csr"), extensions = join(root, "preview.ext");
    await writeFile(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n");
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "1", "-subj", "/CN=TL08 test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
      ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=localhost"],
      ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", extensions],
    ]) expect((await execute("openssl", args)).exitCode).toBe(0);
    const certificates = [...previousCertificates, await readFile(ca, "utf8")];
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
        front.on("close", () => { sockets.delete(front); back.terminate(); }); back.on("close", () => { sockets.delete(back); front.terminate(); });
        front.on("error", error => { stage("preview front error", error.message); back.terminate(); });
        back.on("error", error => { stage("preview back error", error.message); front.terminate(); });
      });
    });
    await new Promise<void>(done => preview!.listen(0, "127.0.0.1", done));
    const previewAddress = preview.address(); if (!previewAddress || typeof previewAddress === "string") throw new Error("Preview missing");
    temporary = await startEmbeddedPostgresTestDatabase("xr-tl08-db-"); db = createDb(temporary.connectionString);
    // Preserve evidence; do not call helper.cleanup(), which deletes the DB.
    const pgPort = new URL(temporary.connectionString).port;
    for (const entry of readdirSync("/proc")) try {
      if (!/^\d+$/.test(entry)) continue;
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== pgPort) continue;
      const dataDir = args[args.indexOf("-D") + 1]!;
      stopPostgres = async () => {
        await closeRegisteredClients(temporary!.connectionString);
        expect((await execute(args[0]!.replace(/postgres$/, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"])).exitCode).toBe(0);
      };
      break;
    } catch { /* unrelated process */ }
    expect(stopPostgres).toBeDefined();
    await db.insert(companies).values({ id: companyId, name: "TL08 real Pi proof", issuePrefix: "TLX" });
    // Product dispatch policy, not a wake mock: comments still persist/reopen
    // through the real route, but queue.ts records a skipped wake without a run.
    // This fixture alone drives each accepted comment through seed + executor.
    await db.insert(agents).values({ id: agentId, companyId, name: "TL08 real Pi proof", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    await mkdir(localCwd); await writeFile(join(localCwd, "saved.txt"), "No private fact in the workspace.\n");
    const supportedMethods = ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease",
      "environmentStopLease", "environmentInspectLease", "environmentExecute", "environmentRunnerIngressEndpoint", "environmentRealizeWorkspace"];
    await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: "xr-tl08-provider-fixture", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", manifestJson: { id: provider, apiVersion: 1, version: "1.0.0",
        displayName: "TL08 fixture provider", description: "Simulated allocation; real sandbox driver", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "TL08 fixture provider",
          sandboxCapabilities: { reusableLeases: true, runnerWebSocketIngress: true, persistentProcessSessions: false, incrementalSessionOutput: false },
          configSchema: { type: "object", properties: { image: { type: "string" }, reuseLease: { type: "boolean" } } } }] } });
    const [environmentRow] = await db.insert(environments).values({ id: environmentId, name: "TL08 sandbox", driver: "sandbox", status: "active",
      config: { provider, image: "fixture:image-A", reuseLease: true, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: WARM_IDLE_MS } }).returning();
    let environment = environmentRow as Environment;
    const providerCall = async (method: string, input: Record<string, unknown>, onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void>) => {
      const allocationId = allocationIds[generation - 1]!;
      providerCalls.push({ at: new Date().toISOString(), method, input, generation, activeRunId });
      if (method === "environmentAcquireLease") {
        const ordinal = ++acquiredAllocations;
        // A real provider creates B even if A's teardown is still running.
        // This host-namespace fixture has ONE mount/listener, so hold B's reply
        // until the real stop and evidence-preserving mount swap finish. Do
        // not accidentally return A just because acquisition beat the wait.
        if (ordinal > 1 && !keepWarm) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // A failed teardown must reject acquisition with its own cause,
            // not leave replaceDisk uncalled behind a generic mount timeout.
            // Allow the bounded 60 s settlement probe to report its assertion.
            await Promise.race([allocationReady, ...(teardownCompletion ? [teardownCompletion] : []),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("new allocation mount not ready after terminal teardown")),
                  teardownCompletion ? 65_000 : 30_000);
              })]);
          } finally { clearTimeout(timer); }
        }
        return { providerLeaseId: allocationIds[ordinal === 1 || keepWarm ? 0 : 1],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
      }
      if (method === "environmentResumeLease") {
        if (!keepWarm && !(generation === 2 && input.providerLeaseId === allocationIds[1]))
          throw new Error("terminal/replaced predecessor must not be resumed");
        // B may be reused by the explicit second-person-message assertion;
        // terminal A must never be resumed, even when its image matches again.
        expect(input.providerLeaseId).toBe(allocationId); expect(allocations.get(allocationId)).toBe("running");
        return { providerLeaseId: allocationId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
      }
      if (["environmentDestroyLease", "environmentStopLease", "environmentReleaseLease"].includes(method)) {
        const id = String(input.providerLeaseId);
        if (terminal && id === allocationIds[0] && !teardownObserved) {
          // Hold only the provider boundary. The real PATCH must FIRST persist
          // pending_cleanup + pendingCleanupInFlight, with its exact attempt.
          teardownObserved = true; destroyEnteredResolve(); await destroyGate;
        }
        allocations.set(id, "stopped"); leaseActive.set(id, false);
        if (id === allocationId) await stopBoxProcesses();
        if (id === allocationIds[0]) providerStopped = true;
        // Boat stop, not physical DELETE: the production driver binds the
        // truthful stopped response to its run/lease in the same finalization.
        return { providerLeaseId: id, state: "stopped" };
      }
      if (method === "environmentInspectLease") {
        const id = String(input.providerLeaseId);
        return { providerLeaseId: id, state: allocations.get(id) === "running" ? "active" : "stopped", observedAt: new Date().toISOString() };
      }
      if (method === "environmentRealizeWorkspace") return { cwd: remoteCwd };
      if (method === "environmentRunnerIngressEndpoint") {
        // Execution/ingress RPCs nest the lease; lifecycle RPCs use a top-level id.
        const id = String(record(input.lease).providerLeaseId);
        if (allocations.get(id) !== "running") throw new Error("Boat sandbox lease is no longer active");
        const path = String(input.path); previewBindings.set(path, id); leaseActive.set(id, true);
        return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
          secretHeaders: [{ name: "X-Owned-Lease", value: id }], generation: `box-${generation}` };
      }
      if (method === "environmentExecute") {
        const id = String(record(input.lease).providerLeaseId);
        if (allocations.get(id) !== "running") throw new Error("Boat sandbox lease is no longer active");
        const evidence: Record<string, unknown> = { at: new Date().toISOString(), command: input.command, args: input.args,
          generation, providerLeaseId: id, activeRunId };
        commands.push(evidence);
        try {
          const result = await execute(String(input.command), input.args as string[] ?? [], { cwd: input.cwd as string | undefined,
            env: input.env as Record<string, string>, stdin: input.stdin as string | undefined,
            timeoutMs: input.timeoutMs as number | undefined, commandTimeoutMs: input.commandTimeoutMs as number | undefined, onLog });
          Object.assign(evidence, { exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr }); observeRunnerProcesses();
          return result;
        } catch (error) { evidence.error = String(error); throw error; }
      }
      throw new Error(`Unexpected provider RPC: ${method}`);
    };
    const providerWorker = { isRunning: (id: string) => id === pluginId,
      getWorker: (id: string) => id === pluginId ? { supportedMethods } : undefined,
      stopAll: async () => {}, stopWorker: async () => {}, onConfigApplied: () => () => {},
      call: async (_id: string, method: string, input: Record<string, unknown>, _timeout?: number,
        onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void>) => {
        expect(_id).toBe(pluginId); return providerCall(method, input, onLog);
      } } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: providerWorker });
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime, pluginWorkerManager: providerWorker });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Recall the pre-DONE private fact", description: null,
      assigneeAgentId: agentId, status: "in_progress" }).returning();
    // Copy of issue-status-version-route-service.test.ts's real board app.
    // No mock issue service, teardown service, status write or actor bypass.
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: [companyId], isInstanceAdmin: true, source: "local_implicit" }; next();
    });
    app.use("/api", issueRoutes(db, {} as never, { pluginWorkerManager: providerWorker })); app.use(errorHandler);
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from(ownFinish
        ? "Use only supplied conversation history. Report the opening task done with paperclip_finish, then acknowledge the private fact in final text. Do not invent facts.\n"
        : "Use only supplied conversation history. Do not invent missing facts or use tools.\n") }]);
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const controllerFile = join(root, "controller.mjs"); await writeFile(controllerFile, controllerSource());
    const startController = async () => {
      const child = fork(controllerFile, [], { cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env } });
      const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
      let sequence = 0;
      let readyResolve!: () => void, readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const stopped = new Promise<void>(resolve => child.once("exit", () => {
        const error = new Error(`controller exited (${child.exitCode}/${child.signalCode})`); readyReject(error);
        for (const waiter of pending.values()) waiter.reject(error); pending.clear(); resolve();
      }));
      child.once("error", error => { readyReject(error); for (const waiter of pending.values()) waiter.reject(error); });
      child.stdout?.on("data", chunk => { stages.push({ controller: child.pid, stdout: String(chunk) }); });
      child.stderr?.on("data", chunk => { stages.push({ controller: child.pid, stderr: String(chunk) }); });
      child.on("message", (raw: unknown) => {
        const message = record(raw);
        if (message.kind === "ready") readyResolve();
        if (message.kind === "reply") { const waiter = pending.get(Number(message.id)); pending.delete(Number(message.id)); waiter?.resolve(message); }
        if (message.kind === "provider") void providerCall(String(message.method), record(message.input)).then(
          result => { if (child.connected) child.send({ kind: "providerReply", id: message.id, result }); },
          error => { if (child.connected) child.send({ kind: "providerReply", id: message.id, error: String(error) }); });
        if (message.kind === "event") startupEvents.push({ runId: String(message.runId), event: message.event as AdapterRuntimeEvent });
        if (message.kind === "target") targets.push(message);
        if (message.kind === "log") { stages.push(message); void appendFile(join(root, "native.log"), `${message.stream}: ${message.text}`); }
      });
      const call = async (method: string, input: unknown = {}) => {
        const id = ++sequence;
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`controller ${method} deadline`)); }, 180_000);
          pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
          child.send({ kind: "call", id, method, input }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
        });
      };
      const handle = { child, stopped, call }; controllers.push(handle);
      const readyTimer = setTimeout(() => readyReject(new Error("controller import deadline")), 120_000);
      try { await ready; } finally { clearTimeout(readyTimer); }
      const initialized = await call("init", { connectionString: temporary!.connectionString, companyId, agentId, issueId,
        pluginId, supportedMethods, ca, runnerBinary, providerPack });
      expect(initialized.error, JSON.stringify(initialized)).toBeUndefined();
      return { ...handle, identity: record(initialized.result) };
    };
    const A = await startController(); let controller = A;
    const postPersonComment = async (body: string, expectedStatus: string) => {
      const [before] = await db!.select().from(issues).where(eq(issues.id, issueId));
      const runIdsBefore = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).map(run => run.id).sort();
      const response = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const [comment] = await db!.select().from(issueComments).where(eq(issueComments.id, response.body.id));
      expect(comment).toMatchObject({ companyId, issueId, body, authorType: "user", authorUserId: "local-board" });
      // The route wakes asynchronously after committing the human comment.
      // Join its actual policy refusal before seeding; never race a second run.
      const wake = await vi.waitFor(async () => {
        const wakes = (await db!.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
          .filter(item => record(item.payload).commentId === comment!.id);
        expect(wakes, "one real route wake per person message").toHaveLength(1);
        expect(wakes[0]).toMatchObject({ agentId, status: "skipped", reason: "heartbeat.wakeOnDemand.disabled", runId: null,
          requestedByActorType: "user", requestedByActorId: "local-board" });
        return wakes[0]!;
      }, { timeout: 20_000 });
      const [current] = await db!.select().from(issues).where(eq(issues.id, issueId));
      const wakeContext = record(record(wake.payload)._paperclipWakeContext);
      const reopened = before!.status === "done";
      expect(wakeContext).toMatchObject({ issueId, taskId: issueId, commentId: comment!.id, wakeCommentId: comment!.id,
        source: reopened ? "issue.comment.reopen" : "issue.comment", wakeReason: reopened ? "issue_reopened_via_comment" : "issue_commented",
        ...(reopened ? { reopenedFrom: "done" } : {}) });
      const evidence = { commentId: comment!.id, beforeStatus: before!.status, issueStatus: current?.status, wake, wakeContext };
      stage(`real board comment: ${before!.status} -> ${current?.status}; automatic dispatch skipped`, evidence);
      console.log(`E2E-PI-COMMENT: ${JSON.stringify(evidence)}`);
      expect(current?.status, "status reread after the real comment route, not a fixture reopen").toBe(expectedStatus);
      expect((await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).map(run => run.id).sort(),
        "comment route must not create a competing heartbeat run").toEqual(runIdsBefore);
      return { comment: comment!, wakeContext, issueStatus: current!.status };
    };
    const seed = async (prompt: string, normalizedSessionId?: string, wakeCommentId?: string, wakeContext: Record<string, unknown> = {}) => {
      const runId = randomUUID();
      const [currentIssue] = await db!.select().from(issues).where(eq(issues.id, issueId));
      const [run] = await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
        ...(normalizedSessionId ? { nativeSessionId: normalizedSessionId } : {}),
        // Retain the route's actual reopen/comment admission context. Reread
        // generation from the reopened issue; do not force a fresh Pi session.
        contextSnapshot: { ...wakeContext, issueId, ...(wakeCommentId ? { wakeCommentId } : {}),
          conversationSessionGeneration: currentIssue!.conversationSessionGeneration } }).returning();
      if (wakeCommentId) {
        const attempts = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
          .filter(item => record(item.contextSnapshot).wakeCommentId === wakeCommentId);
        expect(attempts.map(item => item.id), "exactly one seeded attempt for this person message").toEqual([runId]);
      }
      const acquired = await runtime.acquireRunLease({ companyId, environment, heartbeatRunId: runId, issueId, agentId,
        adapterType: "paperclip_runner", persistedExecutionWorkspace: null, warmRunnerIdleTimeoutMs: WARM_IDLE_MS });
      const lease = acquired.lease;
      expect(lease.metadata).toMatchObject({ sandboxProviderPlugin: true, pluginId, provider, remoteCwd });
      // Org rule 14:40Z: every row seeds the production Pi conversation record via the REAL
      // selectPiConversation writer (pi-conversation-record.ts:86, as heartbeat/runtime-selection.ts:546
      // calls it), before native preparation, exactly as the G1/G2 rows do. Never hand-insert the row.
      const piConversation = await selectPiConversation(db!, { companyId, agentId, issueId, runId,
        boundary: { provider: "pi_rpc", cwd: localCwd, remoteCwd, workspaceId,
          trust: nativeSha256({ trustPreset: null, trust: null, permissionMode: null, approvalPolicy: null,
            sandboxMode: null, homeMode: "isolated", account: null }) } });
      if (normalizedSessionId) expect(piConversation.id, "production record retains C on follow-up").toBe(normalizedSessionId);
      const native = await prepareNativeHeartbeatRun({ db: db!, run: { ...run!, nativeSessionId: piConversation.id },
        issue: currentIssue!, environmentLeaseId: lease.id });
      runnerMarkers.add(join(stagedRuntime, "sessions", createHash("sha256").update(native.normalizedSessionId).digest("hex"), "runner", "runner-process.identity"));
      await db!.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: String(controller.identity.bootId),
        controllerGeneration: 0, controllerPid: Number(controller.identity.pid), controllerProcessStartedAt: new Date(String(controller.identity.processStartedAt)), leaseOwner: null, leaseExpiresAt: null });
      await db!.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const [contract] = await db!.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const execution = buildNativeExecutionInput({ companyId, agentId, runId, provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh",
        issue: { id: issueId, identifier: "TLX-1", title: issue!.title, description: null, workMode: "standard" }, taskPrompt: prompt,
        workspace: { id: workspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: native.normalizedSessionId,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: WARM_IDLE_MS }, runtimeContext,
        completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion, contract: contract!.contractJson as never } });
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ adapterDispatch: { adapterType: "paperclip_runner" }, nativeExecutionInput: execution,
          nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "pi_rpc") })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
      return { runId, run: run!, native, execution, lease };
    };
    type Fixture = Awaited<ReturnType<typeof seed>>;
    const executionOptions = async (fixture: Fixture) => {
      const target = await resolveEnvironmentExecutionTarget({ db: db!, companyId, adapterType: "paperclip_runner", environment,
        leaseId: fixture.lease.id, leaseMetadata: fixture.lease.metadata, lease: fixture.lease as EnvironmentLease, environmentRuntime: runtime });
      if (target?.kind !== "remote" || target.transport !== "sandbox") throw new Error("real sandbox target missing");
      const sync = await prepareNativeWorkspaceSync({ db: db!, runId: fixture.runId, companyId, workspaceId, workspaceLocalDir: localCwd,
        target, lease: fixture.lease as EnvironmentLease, resourceDisposition: "keep_running" });
      if (!sync) throw new Error("workspace sync missing");
      return { target, sync, input: { environmentId, leaseId: fixture.lease.id, execution: fixture.execution, runnerInstanceId: fixture.native.runnerInstanceId,
        runnerEnvironment: { PATH: process.env.PATH, ...configuredEnvironmentProjection({ PI_OFFLINE: "1", TMPDIR: process.env.TMPDIR! }),
          PI_CODING_AGENT_DIR: agentHome, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none",
          PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${modelAddress.port}`, PAPERCLIP_PROVIDER_TRACE_PATH: join(root, `${fixture.runId}.provider-trace.jsonl`) } } };
    };
    const openingMessage = await postPersonComment(`Remember my private fact: ${fact}. Acknowledge it.`, "in_progress");
    const openingComment = openingMessage.comment;
    const first = await seed(openingComment.body, undefined, openingComment.id, openingMessage.wakeContext); openingRunId = first.runId; activeRunId = first.runId;
    if (ownFinish) openingReport = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: `ACK_${fact}`,
      completionClaim: { contractRevision: first.native.completionContract.revision, objectiveSatisfied: true,
        criteria: first.native.completionContract.criterionIds.map(criterionId => ({ criterionId, status: "satisfied", evidenceRefs: [`comment:${openingComment!.id}`] })), remainingWork: [] },
      evidence: [{ ref: `comment:${openingComment!.id}` }], verification: [], attentionRequests: [], artifacts: [] };
    const firstOptions = await executionOptions(first), firstOutcome = await A.call("execute", firstOptions.input);
    expect(firstOutcome.error, JSON.stringify(firstOutcome)).toBeUndefined();
    expect(firstOutcome.result).toMatchObject({ exitCode: 0, summary: `ACK_${fact}` });
    observeRunnerProcesses(); expect(spawned).toHaveLength(1); expect(piBirths).toHaveLength(1);
    expect(sameBirth(spawned[0]!)).toBe(true); expect(sameBirth(piBirths[0]!)).toBe(true);
    const openingSessionFile = sessionFile(piBirths[0]!); expect(await readFile(openingSessionFile, "utf8")).toContain(fact);
    stage("real opening answered and Pi remains warm", { requestedBinary: process.env.PI_TEST_BINARY, actual: piBirths[0]!.command, controller: A.identity });
    await firstOptions.sync.restoreWorkspace();
    if (ownFinish) {
      // Run the actual agent-result finalizer, not a fixture status assignment
      // and not the board PATCH (which would invalidate this keep-green row).
      const finalized = await finalizeNativeRun({ db, runId: first.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect(finalized.phase).toBe("committed");
      const openingRequests = requests.filter(item => item.runId === first.runId);
      const results = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, first.runId));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, first.runId));
      expect(openingRequests).toHaveLength(2);
      expect(record(openingRequests[1]?.toolResult).is_error ?? false).toBe(false);
      expect(results).toHaveLength(1); expect(results[0]?.schemaStatus).toBe("accepted");
      expect(record(results[0]?.resultJson).result).toMatchObject(openingReport!);
      expect(events.filter(event => event.eventType === "run.result.proposed")).toHaveLength(1);
      expect(events.filter(event => event.eventType === "run.result.accepted")).toHaveLength(1);
      const [finishedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(finishedIssue?.status, "native completion really set DONE; fixture does not PATCH it").toBe("done");
    }
    // Executor accepted native completion above. These are the base fixture's
    // outer heartbeat finalizer/lease-release bookkeeping, not a DONE write.
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, first.runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first.runId));
    const releaseOpeningLease = () => heartbeat.releaseEnvironmentLeasesForRun({ runId: first.runId, companyId, agentId,
      status: "succeeded", providerResourceDisposition: "keep_running" });
    // Match the backup fixture's ordering: checkpoint before lease release.
    // All no-backup rows, including retained controls, release here as before.
    if (!scenario.backup) await releaseOpeningLease();
    activeRunId = undefined;
    const stateRoot = scopedRunnerdStateRoot(first.execution);
    const checkpointPath = join(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "sessions", `${basename(stateRoot)}.json`);
    const backupRoot = join(stateRoot, "failover-backups");
    const backupInventory = () => existsSync(backupRoot) ? readdirSync(backupRoot, { recursive: true }).map(String) : [];
    expect(existsSync(checkpointPath), "real local warm envelope retained").toBe(true);
    expect(backupInventory(), "natural no-backup prerequisite; NEVER delete backups to force fallback").toEqual([]);
    if (scenario.backup) {
      const checkpointed = await A.call("checkpoint");
      console.log(`E2E-PI-CHECKPOINT: ${JSON.stringify(checkpointed)}`);
      expect(checkpointed.error, JSON.stringify(checkpointed)).toBeUndefined();
      expect(checkpointed.result, "production sleep writer retired one settled warm session").toMatchObject({ closed: 1, failed: 0, busy: 0 });
      const backup = await verifyNativeHarnessBackupStreamed({ root: stateRoot, execution: first.execution, runnerInstanceId: first.native.runnerInstanceId });
      expect(backup, "real production checkpoint is verified before teardown").not.toBeNull();
      expect(backup!.manifest.sourceProviderLeaseId).toBe(allocationIds[0]);
      expect(record(JSON.parse(await readFile(join(backup!.root, "runner", "runner-state.json"), "utf8"))).lifecycle,
        "backup captured a truly suspended Runner, not a copied live state").toBe("suspended");
      expect(await readFile(join(backup!.root, "pi", `${first.native.normalizedSessionId}.jsonl`), "utf8")).toContain(fact);
      const [stamped] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, first.lease.id));
      expect(stamped?.metadata?.nativeHarnessBackup).toMatchObject({ normalizedSessionId: first.native.normalizedSessionId,
        sourceProviderLeaseId: allocationIds[0], authorizedProviderLeaseId: allocationIds[0] });
      await writeFile(join(root, "backup-prerequisite.json"), JSON.stringify({ backup, stamped }, null, 2));
      await releaseOpeningLease();
    }
    console.log(`E2E-PI-BACKUPS: ${JSON.stringify({ scenario, inventory: backupInventory(), createdThroughRealSessionClose: scenario.backup,
      writer: scenario.backup ? "prepareIdleWarmNativeSessionsForSleep" : null, warmEntryRetiredForBackup: scenario.backup, removedByFixture: false })}`);

    let doneAtMs = Date.now();
    if (terminal) {
      const [beforePatch] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(beforePatch?.status).toBe("in_progress");
      patch = request(app).patch(`/api/issues/${issueId}`).send({ status: "done" }).then(response => ({ status: response.status, body: response.body }));
      await vi.waitFor(() => expect(teardownObserved, "real board PATCH reached the provider destroy seam").toBe(true), { timeout: 20_000 });
      await destroyEntered;
      const [claimed] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, first.lease.id));
      const [doneIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(doneIssue?.status).toBe("done");
      expect(claimed).toMatchObject({ status: "pending_cleanup", failureReason: "issue_terminal_done",
        metadata: { pendingCleanupInFlight: true } });
      expect(claimed?.metadata?.pendingCleanupAttemptId).toBeTruthy();
      doneAtMs = Date.now();
      await writeFile(join(root, "terminal-teardown-claimed.json"), JSON.stringify({ doneIssue, claimed, doneAtMs }, null, 2));
    }
    if (scenario.configChange) {
      const [changed] = await db.update(environments).set({ config: { ...environment.config, image: "fixture:image-B" } })
        .where(eq(environments.id, environmentId)).returning(); environment = changed as Environment;
    }
    if (scenario.kind === "tes208-path") {
      A.child.kill("SIGKILL"); await A.stopped; expect(A.child.signalCode).toBe("SIGKILL");
      controller = await startController(); expect(controller.identity.bootId).not.toBe(A.identity.bootId);
      await stopBoxProcesses(); allocations.set(allocationIds[0]!, "stopped"); leaseActive.set(allocationIds[0]!, false);
    }
    if (terminal && !scenario.duringTeardown) destroyRelease();
    const assertTerminalSettlement = async () => {
      const response = await patch!;
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // routes/issues.ts launches terminal cleanup in a detached async block;
      // HTTP 200 only acknowledges the issue update. destroyClaimedSandboxLease
      // deliberately stamps cleanupStatus=failed while its recovery claim is
      // in flight. The driver later settles the same attempt via releaseLease.
      const settled = await vi.waitFor(async () => {
        const [lease] = await db!.select().from(environmentLeases).where(eq(environmentLeases.id, first.lease.id));
        expect(lease, "prerequisite: real terminal teardown settled with its bound stop receipt").toMatchObject({
          status: "expired", cleanupStatus: "success", failureReason: "issue_terminal_done",
          metadata: { pendingCleanupInFlight: false, remoteExecutionTermination: { state: "stopped", runId: first.runId,
            leaseId: first.lease.id, providerLeaseId: allocationIds[0], companyId } } });
        expect(hasRemoteTerminationReceipt(lease!), "exact still-bound stop receipt, not an injected JSON object").toBe(true);
        expect(providerStopped).toBe(true);
        return lease!;
      }, { timeout: 60_000, interval: 100 });
      await writeFile(join(root, "terminal-teardown-settled.json"), JSON.stringify(settled, null, 2));
    };
    if (terminal && !scenario.duringTeardown) await assertTerminalSettlement();
    const replaceDisk = async () => {
      expect(providerStopped || scenario.kind === "tes208-path", "old box stopped before the same mount changes").toBe(true);
      await rename(remoteCwd, join(root, "image-A-disk-retained")); await mkdir(remoteCwd);
      expect(readdirSync(remoteCwd)).toEqual([]); generation = 2; await installImagePack(); allocationReadyResolve();
    };
    if (!keepWarm && !scenario.duringTeardown) await replaceDisk();
    if (scenario.duringTeardown) {
      // Real +9 s, with real timers, while the terminal claim is STILL in flight.
      // This is a single bounded fixture delay, not production polling.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, doneAtMs + scenario.offsetMs - Date.now())));
      const [inFlight] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, first.lease.id));
      expect(inFlight).toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupInFlight: true } });
    }
    const admitFollowup = async (fixture: Fixture) => {
      const selected = await findNativeSessionResumeRun(db!, { companyId, agentId, issueId, normalizedSessionId: first.native.normalizedSessionId,
        currentRunId: fixture.runId, beforeCreatedAt: fixture.run.createdAt });
      if (!selected) throw new Error("follow-up stuck: no resumable predecessor");
      fixture.native.runnerInstanceId = selected.runnerInstanceId!;
      await db!.update(heartbeatRuns).set({ runnerInstanceId: fixture.native.runnerInstanceId }).where(eq(heartbeatRuns.id, fixture.runId));
      const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: first.native.normalizedSessionId,
        executionTargetKind: "remote", buildExecution: () => fixture.execution });
      fixture.execution = admission.execution as typeof fixture.execution; expect(admission.checkpoint).not.toBeNull();
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ sessionCheckpoint: admission.checkpoint, nativeExecutionInput: fixture.execution })}::jsonb` }).where(eq(heartbeatRuns.id, fixture.runId));
      return admission;
    };
    const followupMessage = await postPersonComment(followupPrompt, terminal || ownFinish ? "todo" : "in_progress");
    const comment = followupMessage.comment;
    expect(comment.body).not.toContain(fact);
    const notesBefore = new Set((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).map(item => item.id));
    if (scenario.duringTeardown) {
      // The next admission starts INSIDE the genuine in-flight teardown window.
      // Complete the provider operation on the next bounded timer. S's settling
      // wait must reread the terminal row; the base path races ahead instead.
      teardownCompletion = new Promise<void>((resolve, reject) => setTimeout(() => {
        destroyRelease();
        void assertTerminalSettlement().then(replaceDisk).then(resolve, reject);
      }, 250));
      // Acquisition races this completion above, so its original failure is
      // not masked by allocationReady. The admission below may itself throw;
      // also observe rejection now and join the owned completion in finally.
      void teardownCompletion.catch(() => undefined);
    }
    const admissionStartMs = performance.now();
    let next!: Fixture;
    let admissionClockMs = 0;
    let admission!: Awaited<ReturnType<typeof admitFollowup>>;
    try {
      if (terminal && !scenario.duringTeardown) {
        // ER's selection/settling/expiry gates read Date.now/new Date in THIS
        // process. Move ONLY Date, ONLY around follow-up admission. Do not fake
        // provider timers, TLS, child clocks, Runner clocks, or the 20 s wait.
        // DB timestamps remain PostgreSQL's real clock, as in production.
        vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(doneAtMs + scenario.offsetMs);
      }
      admissionClockMs = Date.now();
      next = await seed(comment.body, first.native.normalizedSessionId, comment.id, followupMessage.wakeContext);
      followupRunId = next.runId; activeRunId = next.runId;
      admission = await admitFollowup(next);
    } finally { vi.useRealTimers(); }
    const admissionElapsedMs = performance.now() - admissionStartMs;
    await teardownCompletion;
    if (!keepWarm) {
      expect(next.lease.providerLeaseId).toBe(allocationIds[1]);
      expect(next.lease.id).not.toBe(first.lease.id);
    }
    const nextOptions = await executionOptions(next);
    const outcome = await controller.call("execute", nextOptions.input);
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next.runId));
    const followupRequests = requests.filter(item => item.runId === next.runId);
    const answered = outcome.error == null && persisted?.error == null
      && record(outcome.result).exitCode === 0 && record(outcome.result).summary === `RECALLED_${fact}`;
    // This harness drives the executor directly. Settle a refused run as the
    // heartbeat does, then drive upstream recovery and its returned deadlines.
    let sweep: unknown = null;
    const sweepPasses: Array<{ at: number; deferredDeadlines: number[]; result: unknown }> = [];
    if (!answered) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId));
      if (row && !row.finishedAt) await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
        error: row.error ?? (outcome.error == null ? null : String(outcome.error)),
        errorCode: row.errorCode ?? (outcome.errorCode == null ? null : String(outcome.errorCode)) }).where(eq(heartbeatRuns.id, next.runId));
      // Keep the real coordinator unchanged; the live-row acceptance budget is two minutes.
      const sweepStopAt = Date.now() + 2 * 60_000;
      let nextSweepAt: number | null = Date.now();
      for (let pass = 0; pass < 8 && nextSweepAt !== null && nextSweepAt <= sweepStopAt; pass += 1) {
        const delayMs = Math.max(0, nextSweepAt - Date.now()) + 250;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        const at = Date.now(), deferredDeadlines: number[] = [];
        sweep = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId,
          onDeferredDeadline: deadline => { deferredDeadlines.push(deadline); } });
        sweepPasses.push({ at, deferredDeadlines, result: sweep });
        nextSweepAt = deferredDeadlines.length ? Math.min(...deferredDeadlines) : null;
      }
    }
    const notes = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(item => item.authorType === "system" && !notesBefore.has(item.id));
    const historyPresent = followupRequests.length > 0 && followupRequests.every(item => item.containsFact === true);
    const throwSite = typeof outcome.stack === "string" ? outcome.stack.split("\n").find(line => /^\s+at /.test(line))?.trim() : null;
    const noteEvidence = notes.map(note => ({ id: note.id, runId: note.createdByRunId, text: note.body, metadata: note.metadata, ...noteWriter(note) }));
    const diagnostic = { scenario, runId: next.runId, outcome, commentAdmission: { issueStatus: followupMessage.issueStatus, context: next.run.contextSnapshot },
      error: persisted?.error ?? outcome.error ?? null,
      errorCode: persisted?.errorCode ?? outcome.errorCode ?? null, throwSite, answered, historyPresent,
      containsFact: followupRequests.map(item => item.containsFact), admissionElapsedMs, doneAtMs, admissionClockMs,
      admissionOffsetMs: admissionClockMs - doneAtMs,
      clock: scenario.duringTeardown ? "real +9 s inside teardown" : terminal ? `Date-only admission +${scenario.offsetMs}ms` : "no offset",
      controllerA: A.identity, controllerFollowup: controller.identity, targets, notes: noteEvidence, sweep, sweepPasses, persisted, events };
    console.log(`E2E-PI-OUTCOME: ${JSON.stringify(diagnostic)}`);
    console.log(`E2E-PI-NOTES: ${JSON.stringify(noteEvidence)}`);
    await writeFile(join(root, "followup-outcome.json"), JSON.stringify(diagnostic, null, 2));
    // Refusal is NEVER a silent success. Count ALL visible notes, including
    // superseded history: two committed promises were two notes to the person.
    if (!answered) {
      expect(notes, "refused route must write EXACTLY ONE readable note").toHaveLength(1);
      expect(notes[0]!.body.trim().length).toBeGreaterThan(30);
      expect(notes[0]!.body, "readable next step, not an internal error code").not.toMatch(/native_predecessor_retirement_unproven|runner_harness_state_mismatch|stack trace/);
      // Resolve that next step through the real authorized issue-create route,
      // with no assignee wake (the agent is paused for this route-only probe).
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      const nextTask = await request(app).post(`/api/companies/${companyId}/issues`).send({ title: "Continue the saved TL08 work", assigneeAgentId: agentId, status: "backlog" });
      expect(nextTask.status, JSON.stringify(nextTask.body)).toBe(201);
      expect(nextTask.body).toMatchObject({ companyId, assigneeAgentId: agentId });
    }
    if (scenario.neverSilentOnly && !answered) return;
    // ALL answer rows, including controls and the never-silent green branch,
    // require the history fact in the actual follow-up model request body.
    expect(answered, JSON.stringify(diagnostic)).toBe(true);
    expect(historyPresent, "HARD FAIL: an answer without pre-replacement history in the MODEL REQUEST is not recovery").toBe(true);
    expect(followupRequests).toHaveLength(1);
    expect(followupRequests[0]).toMatchObject({ containsFact: true, reply: `RECALLED_${fact}` });
    expect(JSON.stringify(record(followupRequests[0]!.request).messages)).toContain(fact);
    expect(outcome.result).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId });
    expect(notes.length).toBeLessThanOrEqual(1);
    expect(JSON.stringify({ outcome, persisted, events })).not.toContain("native_predecessor_retirement_unproven");
    // The six terminal answer rows must not route the person through a second
    // stuck message or a fresh-thread stop-gate loop. They succeed FIRST try.
    if (terminal) {
      // Cut B deletes the stopping note (FRESH_THREAD_STOPPING_NOTE is gone; importing it made this
      // check vacuous on the composed head). RFL 16:07Z: pin the EXACT set: an answered terminal row
      // writes no system note, so any stray note, a reintroduced stopping note included, fails.
      expect(notes.map(note => note.body), "answered terminal row: the route's exact system-note set").toEqual([]);
      expect(notes.filter(note => note.body.includes(FRESH_THREAD_STARTED_NOTE)
        || String(record(note.metadata).authorizationReason ?? "").startsWith("fresh_provider_thread_pending:"))).toEqual([]);
      expect(notes.filter(note => note.body === HELD_PREDECESSOR_NOTICE)).toEqual([]);
    }
    // Every promise on BOTH routes must be followed by an answer, not merely
    // the writing of 'starting fresh'/'stopping'. Above also proves its history.
    for (const note of notes.filter(note => /starting (?:a )?fresh|stopping/i.test(note.body))) {
      const answers = events.filter(event => event.eventType === "turn.completed" && event.createdAt >= note.createdAt);
      expect(answers, `promise ${note.id} from ${noteWriter(note).caller} must be followed by an answer`).not.toHaveLength(0);
      expect(answered && historyPresent).toBe(true);
    }
    if (scenario.backup) {
      const finalCheckpoint = record(record(persisted?.runnerProfileJson).sessionCheckpoint);
      expect(finalCheckpoint.providerSessionId, "verified restore keeps the SAME Pi session, not a fresh history handoff")
        .toBe(admission.checkpoint!.providerSessionId);
      const messages = record(followupRequests[0]!.request).messages as Array<{ content: unknown }>;
      expect(JSON.stringify(messages.at(-1)?.content), "restored native session does not resend saved history as a fresh thread").not.toContain("Fresh session handoff");
    } else if (!keepWarm) {
      expect(followupRequests[0], "N's plain fallback MUST hand off saved history").toMatchObject({ handoffHasFact: true });
      const finalCheckpoint = record(record(persisted?.runnerProfileJson).sessionCheckpoint);
      expect(finalCheckpoint.providerSessionId).toBeTruthy();
      expect(finalCheckpoint.providerSessionId).not.toBe(admission.checkpoint!.providerSessionId);
    }
    if (keepWarm) {
      expect(controller.identity.bootId).toBe(A.identity.bootId);
      expect(nextOptions.target.sandboxLeaseAcquisition).toMatchObject({ outcome: "resumed", providerLeaseId: allocationIds[0] });
      expect(sameBirth(spawned[0]!)).toBe(true); expect(sameBirth(piBirths[0]!)).toBe(true);
      expect(providerCalls.filter(call => call.method === "environmentAcquireLease")).toHaveLength(1);
      expect(providerCalls.filter(call => ["environmentStopLease", "environmentReleaseLease", "environmentDestroyLease"].includes(String(call.method)))).toEqual([]);
      // A conservative distinction between no-wait and the existing 20-second
      // settling wait, not a sub-second performance benchmark on a loaded host.
      expect(admissionElapsedMs, "ordinary follow-up must not add the 20 s teardown wait").toBeLessThan(15_000);
      const messages = record(followupRequests[0]!.request).messages as Array<{ content: unknown }>;
      expect(JSON.stringify(messages.at(-1)?.content)).not.toContain("Fresh session handoff");
    }
    await nextOptions.sync.restoreWorkspace();
    if (terminal && !scenario.neverSilentOnly) {
      // Do not infer 'no stuck second message' from the first answer. Settle
      // its real accepted result with the base harness's outer bookkeeping,
      // then admit a second real person message through the SAME resume path.
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, next.runId));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, next.runId));
      await heartbeat.releaseEnvironmentLeasesForRun({ runId: next.runId, companyId, agentId, status: "succeeded", providerResourceDisposition: "keep_running" });
      const secondMessage = await postPersonComment(`One more person message. ${followupPrompt}`, "todo");
      const secondComment = secondMessage.comment;
      expect(secondComment.body).not.toContain(fact);
      const second = await seed(secondComment.body, first.native.normalizedSessionId, secondComment.id, secondMessage.wakeContext);
      followupRunId = second.runId; activeRunId = second.runId;
      await admitFollowup(second);
      const secondOptions = await executionOptions(second);
      const secondOutcome = await controller.call("execute", secondOptions.input);
      const [secondPersisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second.runId));
      const secondRequests = requests.filter(item => item.runId === second.runId);
      const secondEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, second.runId));
      const allNotes = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
        .filter(item => item.authorType === "system" && !notesBefore.has(item.id));
      const secondEvidence = { scenario, message: 2, runId: second.runId, outcome: secondOutcome,
        commentAdmission: { issueStatus: secondMessage.issueStatus, context: second.run.contextSnapshot },
        error: secondPersisted?.error ?? secondOutcome.error ?? null, errorCode: secondPersisted?.errorCode ?? secondOutcome.errorCode ?? null,
        containsFact: secondRequests.map(item => item.containsFact), notes: allNotes.map(note => ({ text: note.body, ...noteWriter(note) })), events: secondEvents };
      console.log(`E2E-PI-OUTCOME: ${JSON.stringify(secondEvidence)}`);
      await writeFile(join(root, "second-followup-outcome.json"), JSON.stringify(secondEvidence, null, 2));
      expect(secondOutcome.error, "second person message must not stick behind the first recovery").toBeUndefined();
      expect(secondPersisted?.error).toBeNull();
      expect(secondOutcome.result).toMatchObject({ exitCode: 0, summary: `RECALLED_${fact}`, sessionId: first.native.normalizedSessionId });
      expect(secondRequests).toHaveLength(1);
      expect(secondRequests[0], "second ANSWER also requires history in its actual MODEL REQUEST").toMatchObject({ containsFact: true });
      expect(JSON.stringify(record(secondRequests[0]!.request).messages)).toContain(fact);
      expect(allNotes.length).toBeLessThanOrEqual(1);
      // RFL 16:07Z exact set (Cut B deletes the stopping note): the second answer leaves no system note.
      expect(allNotes.map(note => note.body), "second answer: the route's exact system-note set").toEqual([]);
      expect(allNotes.filter(note => note.body.includes(FRESH_THREAD_STARTED_NOTE)
        || String(record(note.metadata).authorizationReason ?? "").startsWith("fresh_provider_thread_pending:")
        || note.body === HELD_PREDECESSOR_NOTICE)).toEqual([]);
      expect(JSON.stringify(secondEvidence)).not.toContain("native_predecessor_retirement_unproven");
      await secondOptions.sync.restoreWorkspace();
    }
    stage(terminal && !scenario.neverSilentOnly
      ? "TARGET passed: both follow-ups ANSWERED WITH HISTORY, second message not stuck"
      : "TARGET passed: follow-up ANSWERED WITH HISTORY", { scenario, runId: next.runId });
  } catch (error) { failure = error; throw error; }
  finally {
    vi.useRealTimers(); destroyRelease(); allocationReadyResolve();
    const errors: unknown[] = [];
    // Join already-owned HTTP/provider operations even after assertion failure.
    try { await patch; } catch (error) { errors.push(error); }
    try { await teardownCompletion; } catch (error) { errors.push(error); }
    if (failure) {
      const [run] = db && followupRunId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, followupRunId)) : [];
      const events = db && followupRunId ? await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, followupRunId)) : [];
      console.log(`E2E-PI-OUTCOME: ${JSON.stringify({ scenario, runId: followupRunId ?? activeRunId ?? null, assertionFailure: String(failure), error: run?.error ?? null, errorCode: run?.errorCode ?? null, events })}`);
    }
    for (const controller of controllers) {
      if (controller.child.exitCode === null && controller.child.signalCode === null) {
        try { const result = await controller.call("close"); if (result.error) errors.push(result); } catch (error) { errors.push(error); }
        controller.child.kill("SIGKILL");
      }
      await controller.stopped;
    }
    try { await stopBoxProcesses(); } catch (error) { errors.push(error); }
    for (const socket of sockets) socket.terminate(); ws.close();
    if (preview?.listening) await new Promise<void>(done => preview!.close(() => done()));
    model.closeAllConnections(); if (model.listening) await new Promise<void>(done => model.close(() => done()));
    if (db) for (const [name, table] of [["runs", heartbeatRuns], ["leases", environmentLeases], ["events", heartbeatRunEvents], ["owners", nativeRunFinalizations], ["comments", issueComments]] as const) {
      try { await writeFile(join(root, `${name}.json`), JSON.stringify(await db.select().from(table), null, 2)); } catch (error) { errors.push(error); }
    }
    try { await stopPostgres?.(); } catch (error) { errors.push(error); }
    fixtureHttpsAgent?.destroy(); https.globalAgent = previousHttpsAgent; setDefaultCACertificates(previousCertificates); vi.unstubAllEnvs();
    await writeFile(join(root, "startup-events.json"), JSON.stringify(startupEvents, null, 2));
    await writeFile(join(root, "stages.json"), JSON.stringify(stages, null, 2));
    await writeFile(join(root, "commands.json"), JSON.stringify(commands, null, 2));
    const bounded = (value: unknown) => JSON.stringify(value, (_key, field) => typeof field === "string" && field.length > 65_536
      ? `${field.slice(0, 65_536)}...[truncated ${field.length - 65_536} chars]` : field) ?? "null";
    await writeFile(join(root, "provider-calls.jsonl"), providerCalls.map(bounded).join("\n") + "\n");
    await writeFile(join(root, "requests.jsonl"), requests.map(bounded).join("\n") + "\n");
    await writeFile(join(root, "processes.json"), JSON.stringify({ spawned, piBirths, remainingOwned: [...spawned, ...piBirths].filter(sameBirth) }, null, 2));
    console.log(`xr-tl08 evidence retained: ${root}`);
    if (failure) await writeFile(join(root, "failure.txt"), failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "xr-tl08 body/cleanup failed; evidence retained");
  }
};
it.skipIf(!enabled).each(scenarios)("xr-tl08: $id / backup=$backup", async scenario => {
  console.log(`E2E-PI-PREREQUISITES: ${JSON.stringify({ scenario, runnerd: process.env.PAPERCLIP_RUNNER_BINARY ?? null,
    providerPack: process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH ?? null, PI_TEST_BINARY: process.env.PI_TEST_BINARY ?? null })}`);
  try { await runScenario(scenario); }
  catch (error) {
    // Includes qualification failures before any processes/DB have started.
    console.log(`E2E-PI-OUTCOME: ${JSON.stringify({ scenario, assertionFailure: String(error),
      stack: error instanceof Error ? error.stack : null, target: "ANSWERED WITH HISTORY; or exactly one actionable refusal note for -2" })}`);
    throw error;
  }
}, 600_000);
