// RFL row R / N-gating: deployed follow-up 562da3cc-5ad3-4bf8-acba-962e3c4c2c86.
// Deployed row: RED on 74ccf170; GREEN on D-B1 + D-B2 + D-B4 + D-B5.
// G1: governed wait + replaced box, Pi JSONL survives: history present, no notes.
// G2: governed wait + truly replaced box, Pi JSONL renamed aside: no history,
// exactly one real missing-file notice. Both await D-B8 v2 (it.fails).
// G1/G2 task-session records use selectPiConversation, the heartbeat's real
// writer (pi-conversation-record.ts:86,161-163; heartbeat/runtime-selection.ts:546).
// G-warm-reviewer-shape: diagnostic rejected key, NOT an authorized GitHub wait.
// SB-cold: keep-green same allocation/disk with killed Runner and Pi.
// Real: DB resume admission, two OS controller processes with different bootIds,
// surviving controller state, default sandbox driver/commands, runnerd, TLS PRP
// preview, qualified Pi 1.5.2 and its JSONL, native history handoff and events.
// Faked: provider allocation/RPC boundary and loopback Messages responses only.
// The provider image swap moves the old disk aside, never deletes it, and mounts
// an empty allocation at EXACTLY the same workspace path. Runner state and
// controller failover backups are never removed to force the branch. Only G2
// renames the measured Pi JSONL aside; its original bytes remain in evidence.
// This is not a Boat/SSH or container/PID-namespace qualification: both real
// controller processes run in this test's host namespace (same hostHash).
// Keep reason: deployed incident; crosses real controller/runner restore boundary.
// Opt-in: PAPERCLIP_PI_LEASE_E2E=1; absolute PAPERCLIP_RUNNER_BINARY and
// PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH are required, never runtime skips.
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
import { and, eq, sql } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it, vi } from "vitest";
import {
  agents, agentTaskSessions, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, issueThreadInteractions, nativeRunFinalizations, nativeRunResults, plugins,
} from "@paperclipai/db";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { AdapterRuntimeEvent } from "@paperclipai/adapter-utils";
import { PAPERCLIP_RUNNER_INGRESS_PORT } from "@paperclipai/adapter-utils/runner-connectivity";
import { canonicalNativeRuntimeContextDigest, configuredEnvironmentProjection } from "../vendor/paperclip-runner/index.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import { prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { readPiConversation, selectPiConversation } from "../services/native-runtime/pi-conversation-record.js";
import { buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget } from "../services/native-runtime/native-session-resume.js";
import { materializeAsset } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { HELD_PREDECESSOR_NOTICE } from "../services/native-runtime/held-predecessor-notice-text.js";
import { FRESH_THREAD_STARTED_NOTE } from "../services/native-runtime/fresh-thread-stop-gate.js";

const enabled = process.env.PAPERCLIP_PI_LEASE_E2E === "1";
const WARM_IDLE_MS = 300_000;
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

// A runtime-written entry keeps this regression self-contained in ONE new file.
// Only the plugin worker RPC crosses IPC: each child constructs the production
// environmentRuntimeService and resolveEnvironmentExecutionTarget itself, not a
// replacement backend or a mocked readRemoteRunnerState. A really exits before
// B starts, so all module-local warm registries and controller boot ids are new.
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
import { executePaperclipNativeSession, closeIdleWarmNativeSessionsForRestart } from ${source("../services/native-runtime/native-session-executor.ts")};
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

type ExpectedOutcome = "answers-with-history" | "answers-no-history" | "refused-once" | "stuck" | "record";
type RecoveryCase = {
  name: string; localEnvelope: "present" | "absent"; dbCheckpoint: "present" | "absent";
  priorRun: "done" | "yielded-response-wake" | "failed-launched";
  failoverBackups: "present" | "absent"; control: "none" | "unfinished-goal" | "pending-request" | "active-turn";
  expected: ExpectedOutcome; box: "replaced" | "same-box-cold";
  responseWait?: "board" | "github-review-shape";
  piConversationFile?: "present" | "absent";
  /** Expected red BY NAME (org 11:23Z): the piece it waits for, its image and owner. */
  awaits?: string;
};
// Keep the deployed-shape gate FIRST. All rows share the real controller/runner
// path, opt-in gate, binary qualification, and non-skipping prerequisites.
const recoveryCases: RecoveryCase[] = [{ name: "deployed: warm envelope + DB checkpoint, done, no established backup",
  localEnvelope: "present", dbCheckpoint: "present", priorRun: "done", failoverBackups: "absent", control: "none", expected: "answers-with-history", box: "replaced" },
// RFL 12:59Z: on a replaced box the Pi JSONL (on the box disk) cannot survive, so
// G1 is the governed wait on the SAME box with a COLD runner: the file survives.
{ name: "G1: governed wait, SAME box with a COLD runner, Pi conversation file survives",
  localEnvelope: "present", dbCheckpoint: "present", priorRun: "yielded-response-wake", failoverBackups: "absent", control: "none", expected: "answers-with-history", box: "same-box-cold", responseWait: "board", piConversationFile: "present" },
{ name: "G2: governed wait, TRULY replaced box, Pi conversation file ABSENT",
  localEnvelope: "present", dbCheckpoint: "present", priorRun: "yielded-response-wake", failoverBackups: "absent", control: "none", expected: "answers-no-history", box: "replaced", responseWait: "board", piConversationFile: "absent" },
{ name: "G-warm-reviewer-shape (diagnostic: no GitHub authority)",
  localEnvelope: "present", dbCheckpoint: "present", priorRun: "yielded-response-wake", failoverBackups: "absent", control: "none", expected: "record", box: "replaced", responseWait: "github-review-shape" },
{ name: "SB-cold: warm envelope + DB checkpoint, done, same box with cold runner",
  localEnvelope: "present", dbCheckpoint: "present", priorRun: "done", failoverBackups: "absent", control: "none", expected: "answers-with-history", box: "same-box-cold" },
// Gate 6 (prp-resume-unavailable): the first turn is interrupted IN FLIGHT (no
// tool call), its box is replaced, and the same-run retry must answer on a
// replacement with ONE person-visible line. Run on gcp2 (F7, row AT).
{ name: "AT: first turn interrupted in flight (control active-turn) on a replaced box, same-run retry",
  localEnvelope: "present", dbCheckpoint: "present", priorRun: "failed-launched", failoverBackups: "absent", control: "active-turn", expected: "answers-no-history", box: "replaced" }];
const runRecoveryCase = async (scenario: RecoveryCase) => {
  const governedWait = scenario.priorRun === "yielded-response-wake";
  const reviewerShape = scenario.responseWait === "github-review-shape";
  const sameBoxCold = scenario.box === "same-box-cold";
  expect(process.platform).toBe("linux");
  expect(process.env.TMPDIR, "dedicated parent-owned TMPDIR required").toBeTruthy();
  const runnerBinary = process.env.PAPERCLIP_RUNNER_BINARY;
  const providerPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
  if (!runnerBinary?.startsWith("/") || !providerPack?.startsWith("/")) throw new Error("Set absolute qualified runner and provider-pack paths");
  await access(runnerBinary, constants.X_OK);
  await access(providerPack, constants.R_OK | constants.X_OK);
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-replaced-box-"));
  const remoteCwd = join(root, "simulated-sandbox", "workspace");
  const stagedRuntime = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
  const localCwd = join(root, "host-workspace");
  await mkdir(remoteCwd, { recursive: true });
  const installImagePack = async () => {
    await mkdir(stagedRuntime, { recursive: true });
    await symlink(providerPack, join(stagedRuntime, "provider-pack"), "dir");
  };
  await installImagePack();
  const fact = `PI_REPLACED_FACT_${randomUUID()}`;
  const governedReply = `ANSWERED_${randomUUID()}`;
  const followupPrompt = governedWait ? `Reply with exactly ${governedReply}.`
    : "What private fact did I tell you earlier? Repeat it exactly; do not invent it.";
  const stages: unknown[] = [], commands: Array<Record<string, unknown>> = [], requests: Array<Record<string, unknown>> = [];
  const providerCalls: Array<Record<string, unknown>> = [], startupEvents: Array<{ runId: string; event: AdapterRuntimeEvent }> = [];
  const targets: Array<Record<string, unknown>> = [];
  const spawned: Birth[] = [], piBirths: Birth[] = [], runnerMarkers = new Set<string>();
  const stage = (name: string, detail: unknown = {}) => { stages.push({ at: new Date().toISOString(), name, detail }); console.log(`[pi-replaced-box] ${name}`); };
  const observeRunnerProcesses = () => {
    for (const marker of runnerMarkers) try {
      const fields = readFileSync(marker, "utf8").trim().split("\n");
      const runner = birth(Number(fields[1]));
      if (!runner?.command.includes("runnerd") || fields[4] !== `linux:${runner.bootId}:${runner.startTicks}`) continue;
      if (!spawned.some(owned => owned.pid === runner.pid && owned.startTicks === runner.startTicks)) spawned.push(runner);
      for (const child of ownedProcessTree(runner)) {
        // Pi renames its process (comm "pi"), as the base harness's ownedDescendant knows.
        const comm = (() => { try { return readFileSync(`/proc/${child.pid}/comm`, "utf8").trim(); } catch { return ""; } })();
        if ((comm === "pi" || child.command.includes("--mode rpc") && child.command.includes("cli.js"))
          && !piBirths.some(owned => owned.pid === child.pid && owned.startTicks === child.startTicks)) piBirths.push(child);
      }
    } catch { /* no marker yet, or replaced allocation */ }
  };
  const stopBoxProcesses = async () => {
    observeRunnerProcesses();
    const owned = [...spawned.flatMap(ownedProcessTree), ...piBirths, ...spawned];
    for (const child of owned) if (sameBirth(child)) process.kill(child.pid, "SIGKILL");
    // Process death is the bounded safety-net observation, not a periodic worker.
    await vi.waitFor(() => expect(owned.some(sameBirth), "owned box processes ended").toBe(false), { timeout: 15_000 });
  };
  let activeRunId: string | undefined;
  let openingRunId: string | undefined, openingReport: Record<string, unknown> | undefined;
  const openingToolCallId = `g-warm-finish-${randomUUID()}`;
  let generation = 1;
  const allocationIds = [`image-A-${randomUUID()}`, `image-B-${randomUUID()}`];
  const allocations = new Map(allocationIds.map(id => [id, "running" as "running" | "stopped"]));
  const leaseActive = new Map<string, boolean>();
  // AT: the opening turn's model stream starts and is held open, so the turn is
  // in flight (no tool call) when controller and box are lost.
  let holdOpeningTurn = scenario.control === "active-turn";
  let heldResponse: import("node:http").ServerResponse | undefined;
  let openingTurnHeld!: () => void;
  const openingTurnInFlight = new Promise<void>(resolve => { openingTurnHeld = resolve; });
  const model = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
      try {
        const parsed = JSON.parse(body);
        if (holdOpeningTurn && activeRunId === openingRunId) {
          holdOpeningTurn = false;
          requests.push({ runId: activeRunId, path: req.url, request: parsed, held: true,
            containsFact: JSON.stringify(parsed.messages).includes(fact) });
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-held", type: "message",
            role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } })}\n\n`);
          heldResponse = res; openingTurnHeld(); return;
        }
        const first = requests.length === 0;
        const opening = governedWait && activeRunId === openingRunId;
        const useFinishTool = opening && first;
        const messages = parsed.messages as Array<{ role: string; content: unknown }>;
        const latestUserContent = messages.findLast(message => message.role === "user")?.content;
        const toolResult = Array.isArray(latestUserContent) ? latestUserContent.map(record)
          .find(block => block.type === "tool_result" && block.tool_use_id === openingToolCallId) : undefined;
        const containsFact = JSON.stringify(parsed.messages).includes(fact);
        const handoffHasFact = (parsed.messages as Array<{ content: unknown }>).some(message => {
          const content = JSON.stringify(message.content); return content.includes("Fresh session handoff") && content.includes(fact);
        });
        // Never return the secret just because this is turn two. Replaced/done
        // needs its handoff; SB needs the real Pi history. G asks a new question
        // and makes no claim to the earlier fact.
        const reply = (first || opening && toolResult) && containsFact ? `ACK_${fact}`
          : governedWait && JSON.stringify(parsed.messages).includes(governedReply) ? governedReply
          : handoffHasFact || sameBoxCold && containsFact ? `RECALLED_${fact}` : "HISTORY_LOST";
        // Only author the provider's tool_use. Pi executes the real Runner
        // callback and returns its tool_result before our final text turn.
        const toolUse = useFinishTool ? { name: "paperclip_finish", input: openingReport } : undefined;
        if (useFinishTool) {
          expect(openingReport, "G opening report bound to the actual run and contract").toBeDefined();
          expect((parsed.tools as Array<{ name: string }>).map(tool => tool.name), "Pi exposes the real semantic result tool")
            .toContain("paperclip_finish");
        } else if (opening) expect(toolResult, "Pi returns the opening result-tool receipt before final text").toBeDefined();
        requests.push({ runId: activeRunId, path: req.url, request: parsed, containsFact, handoffHasFact, reply, toolUse, toolResult });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        if (useFinishTool) {
          // completion-result.ts:2,384 and pi/extension/index.ts:206-207:
          // paperclip_finish, with the Runner's bridge schema unchanged in Pi.
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
  const sockets = new Set<WebSocket>();
  const ws = new WebSocketServer({ noServer: true });
  let preview: ReturnType<typeof createHttpsServer> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let stopPostgres: (() => Promise<void>) | undefined;
  const previousCertificates = getCACertificates("default"), previousHttpsAgent = https.globalAgent;
  let fixtureHttpsAgent: InstanceType<typeof https.Agent> | undefined;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID(), workspaceId = randomUUID();
  const pluginId = randomUUID(), provider = `pi-replaced-${pluginId}`;
  let failure: unknown, followupRunId: string | undefined;
  const controllers: Array<{ child: ChildProcess; stopped: Promise<void>; call: (method: string, input?: unknown) => Promise<Record<string, unknown>> }> = [];
  const execute = async (command: string, args: string[], options: Omit<Parameters<CommandManagedRuntimeRunner["execute"]>[0], "command" | "args"> = {}) =>
    runChildProcess(`pi-replaced-${randomUUID()}`, command, args, { cwd: options.cwd ?? remoteCwd, env: options.env ?? {}, stdin: options.stdin,
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
    // PAPERCLIP_HOME is deliberately UNCHANGED, including across A -> B. It owns
    // checkpoint encryption authority as well as the warm checkpoint directory.
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "controller-state", "durable-sessions"));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    vi.stubEnv("PI_OFFLINE", "1"); vi.stubEnv("OTEL_SDK_DISABLED", "true");
    await new Promise<void>(done => model.listen(0, "127.0.0.1", done));
    const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === "string") throw new Error("Messages listener missing");
    const agentHome = join(root, "pi-agent-fixture"); await mkdir(agentHome);
    await writeFile(join(agentHome, "models.json"), JSON.stringify({ providers: { paperclip: { models: [{ id: "faux", reasoning: true,
      contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } }] } } }));
    // Unlike a CA:true self-signed server cert (rustls CaUsedAsEndEntity), this
    // preview uses a real test CA and a separate CA:false serverAuth leaf.
    const ca = join(root, "preview-ca.crt"), caKey = join(root, "preview-ca.key");
    const key = join(root, "preview.key"), cert = join(root, "preview.crt"), csr = join(root, "preview.csr"), extensions = join(root, "preview.ext");
    await writeFile(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n");
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "1", "-subj", "/CN=Pi replacement test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
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
    temporary = await startEmbeddedPostgresTestDatabase("native-pi-replaced-box-db-"); db = createDb(temporary.connectionString);
    // Copy the base's evidence-preserving DB stop, not helper.cleanup() deletion.
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
    await db.insert(companies).values({ id: companyId, name: "Pi replaced-box proof", issuePrefix: "PIR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi replaced-box proof", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } });
    await mkdir(localCwd); await writeFile(join(localCwd, "saved.txt"), "Opening workspace; no private fact is stored here.\n");
    const supportedMethods = ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease",
      "environmentStopLease", "environmentInspectLease", "environmentExecute", "environmentRunnerIngressEndpoint", "environmentRealizeWorkspace"];
    await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: "pi-replaced-provider-fixture", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", manifestJson: { id: provider, apiVersion: 1, version: "1.0.0",
        displayName: "Pi replaced-box provider", description: "Simulated allocation; real sandbox driver", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Pi replaced-box provider",
          sandboxCapabilities: { reusableLeases: true, runnerWebSocketIngress: true, persistentProcessSessions: false, incrementalSessionOutput: false },
          configSchema: { type: "object", properties: { image: { type: "string" }, reuseLease: { type: "boolean" } } } }] } });
    const [environmentRow] = await db.insert(environments).values({ id: environmentId, name: "Same mount, replaced image", driver: "sandbox", status: "active",
      config: { provider, image: "fixture:image-A", reuseLease: true, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: WARM_IDLE_MS } }).returning();
    let environment = environmentRow as Environment;
    const providerCall = async (method: string, input: Record<string, unknown>, onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void>) => {
      const allocationId = allocationIds[generation - 1]!;
      providerCalls.push({ at: new Date().toISOString(), method, input, generation, activeRunId });
      if (method === "environmentAcquireLease") return { providerLeaseId: allocationId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
      if (method === "environmentResumeLease") {
        if (!sameBoxCold && !(governedWait && generation === 2))
          throw new Error("image swap must select a created allocation, never resume the old one");
        // Same allocation/disk; a cold runner is not a stopped/replaced box.
        // G's second-message diagnostic may also reuse the already-created B.
        expect(input.providerLeaseId).toBe(allocationId);
        expect(allocations.get(allocationId)).toBe("running");
        return { providerLeaseId: allocationId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
      }
      if (method === "environmentDestroyLease") throw new Error("box destroy is forbidden in row R");
      if (method === "environmentStopLease" || method === "environmentReleaseLease") {
        const id = String(input.providerLeaseId); allocations.set(id, "stopped"); leaseActive.set(id, false);
        // A stale image's stop must not kill B's process generation.
        if (id === allocationId) await stopBoxProcesses();
        return { providerLeaseId: id, state: "stopped" };
      }
      if (method === "environmentInspectLease") {
        const id = String(input.providerLeaseId);
        return { providerLeaseId: id, state: allocations.get(id) === "running" ? "active" : "stopped", observedAt: new Date().toISOString() };
      }
      if (method === "environmentRealizeWorkspace") return { cwd: remoteCwd };
      if (method === "environmentRunnerIngressEndpoint") {
        const path = String(input.path); previewBindings.set(path, allocationId); leaseActive.set(allocationId, true);
        return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
          secretHeaders: [{ name: "X-Owned-Lease", value: allocationId }], generation: `box-${generation}` };
      }
      if (method === "environmentExecute") {
        const evidence: Record<string, unknown> = { at: new Date().toISOString(), command: input.command, args: input.args,
          generation, providerLeaseId: allocationId, activeRunId };
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
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Recall the pre-replacement fact", description: null,
      assigneeAgentId: agentId, status: "in_progress", // issues_conversation_identity_check: a conversation issue names its agent AND
      // person, and is active or waiting.
      ...(governedWait ? { conversationAgentId: agentId, conversationUserId: "local-board", conversationState: "active" as const } : {}) }).returning();
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from(governedWait
        ? "Use only supplied conversation history. Do not invent missing facts. Report the opening response wait through paperclip_finish, then acknowledge the private fact in final text.\n"
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
          // A bounded request deadline, not polling or a daemon.
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
    const A = await startController();
    // One production-shaped record/boundary owner for both G rows. Match the
    // heartbeat's unmanaged, isolated-home defaults; never hand-insert a row or
    // synthesize a recovery event/notice. Selection precedes native preparation.
    const selectFixturePiConversation = (runId: string) => selectPiConversation(db!, {
      companyId, agentId, issueId, runId,
      boundary: { provider: "pi_rpc", cwd: localCwd, remoteCwd, workspaceId,
        trust: nativeSha256({ trustPreset: null, trust: null, permissionMode: null, approvalPolicy: null,
          sandboxMode: null, homeMode: "isolated", account: null }) },
    });
    const seed = async (prompt: string, controller: Record<string, unknown>, normalizedSessionId?: string, wakeCommentId?: string) => {
      const runId = randomUUID();
      const [run] = await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
        ...(normalizedSessionId ? { nativeSessionId: normalizedSessionId } : {}),
        contextSnapshot: { issueId, ...(wakeCommentId ? { wakeCommentId } : {}),
          ...(scenario.piConversationFile ? { conversationSessionGeneration: issue!.conversationSessionGeneration } : {}) } }).returning();
      const acquired = await runtime.acquireRunLease({ companyId, environment, heartbeatRunId: runId, issueId, agentId,
        adapterType: "paperclip_runner", persistedExecutionWorkspace: null, warmRunnerIdleTimeoutMs: WARM_IDLE_MS });
      const lease = acquired.lease;
      expect(lease.metadata).toMatchObject({ sandboxProviderPlugin: true, pluginId, provider, remoteCwd });
      const piConversation = scenario.piConversationFile ? await selectFixturePiConversation(runId) : null;
      if (piConversation && normalizedSessionId) expect(piConversation.id, "production record retains C on follow-up").toBe(normalizedSessionId);
      const native = await prepareNativeHeartbeatRun({ db: db!, run: { ...run!,
        ...(piConversation ? { nativeSessionId: piConversation.id } : {}) }, issue: issue!, environmentLeaseId: lease.id });
      runnerMarkers.add(join(stagedRuntime, "sessions", createHash("sha256").update(native.normalizedSessionId).digest("hex"), "runner", "runner-process.identity"));
      await db!.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: String(controller.bootId),
        controllerGeneration: 0, controllerPid: Number(controller.pid), controllerProcessStartedAt: new Date(String(controller.processStartedAt)), leaseOwner: null, leaseExpiresAt: null });
      await db!.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const [contract] = await db!.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const execution = buildNativeExecutionInput({ companyId, agentId, runId, provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh",
        issue: { id: issueId, identifier: "PIR-1", title: issue!.title, description: null, workMode: "standard" }, taskPrompt: prompt,
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
    // Stage 1: a real human opening comment, not a secret supplied by the oracle.
    const [openingComment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
      body: `Remember my private fact: ${fact}. Acknowledge it.` }).returning();
    const first = await seed(openingComment!.body, A.identity, undefined, openingComment!.id);
    openingRunId = first.runId;
    if (governedWait) {
      const continuation = { kind: "response_wake", idempotencyKey: reviewerShape
        ? `github-review-response:${first.runId}:${randomUUID()}:${createHash("sha256").update(fact).digest("hex").slice(0, 40)}`
        : `g-ops-date-check-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      summary: reviewerShape ? "Wait for the next authorized GitHub response to the published review." : "Wake only on a new ops or Paul comment." };
      openingReport = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: `ACK_${fact}`,
        completionClaim: { contractRevision: first.native.completionContract.revision, objectiveSatisfied: false,
          criteria: first.native.completionContract.criterionIds.map(criterionId => ({ criterionId, status: "not_satisfied", evidenceRefs: [] })),
          remainingWork: [{ description: continuation.summary, blocksCompletion: true }] },
        evidence: [], verification: [], attentionRequests: [], artifacts: [], continuation };
    }
    activeRunId = first.runId;
    const firstOptions = await executionOptions(first);
    if (scenario.control === "active-turn") {
      // Gate 6 (prp-resume-unavailable): the worker's first canonical run is
      // interrupted mid-turn, its controller and box are lost, and its same-run
      // retry (attempt 2) lands on a replaced box with no Runner state (exit 66).
      // It used to end native_session_interrupted -> retry_exhausted, no answer.
      const interrupted = A.call("execute", firstOptions.input).catch(error => ({ error: String(error) }));
      await openingTurnInFlight;
      await vi.waitFor(async () => {
        const [row] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId));
        expect(record(record(row?.runnerProfileJson).sessionCheckpoint).activeTurnId, "AT prerequisite: opening turn in flight")
          .toEqual(expect.any(String));
      }, { timeout: 60_000, interval: 250 });
      A.child.kill("SIGKILL"); await A.stopped; heldResponse?.destroy();
      stage("AT opening turn interrupted in flight", { interrupted: await interrupted });
      await stopBoxProcesses(); allocations.set(allocationIds[0]!, "stopped"); leaseActive.set(allocationIds[0]!, false);
      const oldDisk = join(root, "image-A-disk-retained"); await rename(remoteCwd, oldDisk); await mkdir(remoteCwd);
      generation = 2; await installImagePack();
      const [changedEnvironment] = await db.update(environments).set({ config: { ...environment.config, image: "fixture:image-B" } })
        .where(eq(environments.id, environmentId)).returning(); environment = changedEnvironment as Environment;
      const B = await startController();
      // The scheduled same-run retry: B owns attempt 2 of the SAME run on a new allocation.
      await db.update(nativeRunFinalizations).set({ phase: "observed", attempt: 1, controllerBootId: String(B.identity.bootId),
        controllerPid: Number(B.identity.pid), controllerProcessStartedAt: new Date(String(B.identity.processStartedAt)) })
        .where(eq(nativeRunFinalizations.runId, first.runId));
      const retryLease = (await runtime.acquireRunLease({ companyId, environment, heartbeatRunId: first.runId, issueId, agentId,
        adapterType: "paperclip_runner", persistedExecutionWorkspace: null, warmRunnerIdleTimeoutMs: WARM_IDLE_MS })).lease;
      expect(retryLease.providerLeaseId, "AT prerequisite: the retry runs on the replaced box").toBe(allocationIds[1]);
      const retryOptions = await executionOptions({ ...first, lease: retryLease });
      const retryOutcome = await B.call("execute", retryOptions.input);
      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId));
      // Read here so this file still loads at the RED commit, before the export exists.
      const executorModule = await import("../services/native-runtime/native-session-executor.js") as unknown as {
        nativeProviderIdentityChangePersonLine?: (reason: "resume_failed_on_new_box") => string };
      const personLine = executorModule.nativeProviderIdentityChangePersonLine?.("resume_failed_on_new_box").trim()
        ?? "missing nativeProviderIdentityChangePersonLine";
      const nativeLog = existsSync(join(root, "native.log")) ? await readFile(join(root, "native.log"), "utf8") : "";
      console.log(`E2E-PI-ACTIVE-TURN: ${JSON.stringify({ runId: first.runId, outcome: retryOutcome, error: persisted?.error ?? null,
        errorCode: persisted?.errorCode ?? null })}`);
      expect(retryOutcome.error, JSON.stringify(retryOutcome)).toBeUndefined();
      expect(persisted?.errorCode ?? null, "never a bare interruption or retry exhaustion").not.toMatch(/native_session_interrupted|native_session_retry_exhausted/);
      expect(retryOutcome.result).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId, summary: expect.any(String) });
      expect(String(record(retryOutcome.result).summary).length, "the run answers").toBeGreaterThan(0);
      // The replacement changed the provider session: ONE person-visible line (its
      // durable identity record is J3-17's, dl/identity-changed; not written by F7a).
      expect(nativeLog.split("\n").filter(line => line.includes(personLine)), "one person-visible line").toHaveLength(1);
      expect(providerCalls.some(call => call.method === "environmentDestroyLease"), "never destroy either box").toBe(false);
      await retryOptions.sync.restoreWorkspace();
      stage("GREEN: interrupted first turn answered on a replacement", { runId: first.runId });
      return;
    }
    const firstOutcome = await A.call("execute", firstOptions.input);
    if (governedWait) {
      const openingRequests = requests.filter(request => request.runId === first.runId);
      const openingEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, first.runId));
      const acceptedResults = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, first.runId));
      const [openingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId));
      const openingInteractions = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
      // Persist rejected receipts too: a synthesized reply must never stand in
      // for the deployed Runner-proposed wait. No result rows are fixture-written.
      const openingEvidence = { scenario, runId: first.runId, report: openingReport, requests: openingRequests,
        outcome: firstOutcome, events: openingEvents, acceptedResults, resultJson: openingRun?.resultJson, interactions: openingInteractions };
      console.log(`E2E-PI-OPENING-RESULT: ${JSON.stringify({ scenario, runId: first.runId, report: openingReport,
        toolResults: openingRequests.map(request => request.toolResult ?? null), acceptedResults,
        resultJson: openingRun?.resultJson, interactionCount: openingInteractions.length, outcome: firstOutcome })}`);
      await writeFile(join(root, "opening-result.json"), JSON.stringify(openingEvidence, null, 2));
      expect(openingRequests).toHaveLength(2);
      expect(openingRequests[0]?.toolUse).toEqual({ name: "paperclip_finish", input: openingReport });
      expect(openingRequests[1]?.toolResult).toMatchObject({ type: "tool_result", tool_use_id: openingToolCallId });
      if (reviewerShape) {
        // A GitHub-shaped key is not authority. This row qualifies only the
        // real completion-feedback rejection, never deployed reviewer recovery.
        expect(record(openingRequests[1]?.toolResult).is_error).toBe(true);
        expect(JSON.stringify(openingRequests[1]?.toolResult)).toContain("The published GitHub review wait is no longer authorized for this run.");
        stage("diagnostic: GitHub-shaped continuation rejected without authority", { runId: first.runId });
        await firstOptions.sync.restoreWorkspace();
        return;
      }
      expect(record(openingRequests[1]?.toolResult).is_error ?? false, "real result-tool acceptance").toBe(false);
      const proposedEvents = openingEvents.filter(event => event.eventType === "run.result.proposed");
      const acceptedEvents = openingEvents.filter(event => event.eventType === "run.result.accepted");
      expect(proposedEvents, "G opening result is Runner-proposed, not synthesized from final text").toHaveLength(1);
      expect(record(proposedEvents[0]?.payload).prpEvent).toMatchObject({ sourceKind: "runner", payload: openingReport });
      expect(acceptedEvents).toHaveLength(1);
      expect(record(record(acceptedEvents[0]?.payload).prpEvent).payload).toMatchObject({ result: openingReport });
      expect(acceptedEvents[0]!.seq).toBeGreaterThan(proposedEvents[0]!.seq);
      expect(acceptedResults).toHaveLength(1);
      expect(acceptedResults[0]?.schemaStatus).toBe("accepted");
      expect(record(acceptedResults[0]?.resultJson).result, "accepted opening preserves the exact authored continuation").toMatchObject(openingReport!);
      expect(openingRun?.resultJson).toMatchObject({ prpReportedWorkDisposition: "yielded",
        nativeTerminal: { runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } });
      expect(openingInteractions, "deployed governed waits have no interaction cards").toEqual([]);
    }
    expect(firstOutcome.error, JSON.stringify(firstOutcome)).toBeUndefined();
    expect(firstOutcome.result).toMatchObject({ exitCode: 0, summary: `ACK_${fact}` });
    observeRunnerProcesses();
    expect(spawned).toHaveLength(1); expect(piBirths, "real warm Pi lives after opening turn").toHaveLength(1);
    expect(sameBirth(spawned[0]!)).toBe(true); expect(sameBirth(piBirths[0]!)).toBe(true);
    stage("actual Pi process command", { requestedBinary: process.env.PI_TEST_BINARY, actual: piBirths[0]!.command });
    const openingSessionFile = sessionFile(piBirths[0]!);
    expect(await readFile(openingSessionFile, "utf8")).toContain(fact);
    stage("Pi JSONL located from admitted child environment", { openingSessionFile,
      location: openingSessionFile.startsWith(`${remoteCwd}/`) ? "box workspace" : "controller runtime" });
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, first.runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first.runId));
    await firstOptions.sync.restoreWorkspace();
    await heartbeat.releaseEnvironmentLeasesForRun({ runId: first.runId, companyId, agentId, status: "succeeded", providerResourceDisposition: "keep_running" });
    activeRunId = undefined;

    // Read EXACTLY nativeSessionCheckpointPath/loadWarmNativeCheckpoint's scoped
    // file: same SHA-256 scope as scopedRunnerdStateRoot, under instance sessions
    // (not inside the remote allocation or the durable-sessions directory).
    const stateRoot = scopedRunnerdStateRoot(first.execution);
    const checkpointPath = join(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "sessions", `${basename(stateRoot)}.json`);
    const checkpointBeforeRestart = existsSync(checkpointPath) ? await readFile(checkpointPath) : null;
    const backupRoot = join(stateRoot, "failover-backups");
    const backupInventory = () => existsSync(backupRoot) ? readdirSync(backupRoot, { recursive: true }).map(String) : [];
    const backupsBeforeRestart = backupInventory();
    // A backup is not established in the deployed incident. Never delete one
    // to manufacture that condition: fail this prerequisite and report it.
    console.log(`E2E-PI-BACKUPS: ${JSON.stringify({ scenario, naturalInventory: backupsBeforeRestart, createdByFixture: false, removedByFixture: false })}`);
    expect(checkpointBeforeRestart, "deployed case MUST retain the LOCAL warm envelope").not.toBeNull();
    expect(backupsBeforeRestart, "Pi's natural backup state must match the incident; none removed").toEqual([]);
    if (governedWait) {
      // REAL paperclip_finish tool execution above, followed by the model's
      // final text. The warm envelope must retain the accepted Runner result,
      // never the conversation-mode missing-result synthesis fallback.
      const openingSnapshot = record(record(JSON.parse(checkpointBeforeRestart!.toString("utf8"))).snapshot);
      expect(openingSnapshot.semanticResult, "G prerequisite: actual opening yielded for the next person message").toMatchObject({
        reportedWorkDisposition: "yielded", continuation: { kind: "response_wake", ...record(openingReport?.continuation) },
      });
    }
    stage("opening completed; controller files retained", { stateRoot, checkpointPath, backupsBeforeRestart });
    if (sameBoxCold) {
      // Idle-timeout shape without waiting five minutes: kill only the measured
      // box process births. Keep its allocation, disk, JSONL and runner state.
      await stopBoxProcesses();
      expect(allocations.get(allocationIds[0]!)).toBe("running");
      expect(await readFile(openingSessionFile, "utf8")).toContain(fact);
    }

    // Stage 2: hard controller restart, not idle closure of the box. SIGKILL A
    // after its accepted turn deliberately avoids graceful drain generating a
    // backup absent from the incident evidence. Product closure is used only at
    // final cleanup. No PAPERCLIP_HOME/runner-state-root rotation or file edits.
    A.child.kill("SIGKILL"); await A.stopped;
    expect(A.child.signalCode).toBe("SIGKILL");
    expect(existsSync(stateRoot), "bind-mounted durable-sessions survives A").toBe(true);
    if (checkpointBeforeRestart) expect((await readFile(checkpointPath)).equals(checkpointBeforeRestart)).toBe(true);
    expect(backupInventory()).toEqual(backupsBeforeRestart);
    const B = await startController();
    expect(B.identity.bootId).not.toBe(A.identity.bootId); expect(B.identity.pid).not.toBe(A.identity.pid);
    stage("real controller restart, same durable root and authority", { A: A.identity, B: B.identity, stateRoot, home: process.env.PAPERCLIP_HOME });

    const remoteState = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"), "runner", "runner-state.json");
    if (sameBoxCold) {
      expect(generation).toBe(1);
      expect(existsSync(remoteState), "SB prerequisite: original runner state retained on original disk").toBe(true);
      expect(await readFile(openingSessionFile, "utf8")).toContain(fact);
      stage("same box retained with cold runner across controller restart", { remoteCwd, providerLeaseId: allocationIds[0], remoteState });
    } else {
      // Stage 3: an external image swap, not product destruction. Stop measured
      // old-box births; retain the whole old disk; recreate the identical mount.
      await stopBoxProcesses(); allocations.set(allocationIds[0]!, "stopped"); leaseActive.set(allocationIds[0]!, false);
      if (scenario.piConversationFile === "absent") {
        // The actual child binding, not a guessed controller/box path. Preserve
        // its bytes outside the disk swap after every old Pi writer has died.
        const retainedSessionFile = join(root, "G2-pi-conversation-retained.jsonl");
        await rename(openingSessionFile, retainedSessionFile);
        expect(existsSync(openingSessionFile), "G2 removes only Pi's file by rename, never delete").toBe(false);
        expect(await readFile(retainedSessionFile, "utf8")).toContain(fact);
        stage("G2 Pi conversation file renamed aside", { openingSessionFile, retainedSessionFile });
      }
      const oldDisk = join(root, "image-A-disk-retained"); await rename(remoteCwd, oldDisk); await mkdir(remoteCwd);
      expect(readdirSync(remoteCwd), "new allocation starts with an empty disk").toEqual([]);
      generation = 2;
      expect(existsSync(remoteState)).toBe(false);
      // The new image has the qualified pack preinstalled, but no conversation.
      await installImagePack(); expect(existsSync(remoteState)).toBe(false);
      const [changedEnvironment] = await db.update(environments).set({ config: { ...environment.config, image: "fixture:image-B" } })
        .where(eq(environments.id, environmentId)).returning(); environment = changedEnvironment as Environment;
      stage("image swap replaced box at same workspace path", { remoteCwd, oldDisk, oldProviderLeaseId: allocationIds[0], newProviderLeaseId: allocationIds[1] });
    }

    // G1 (same box): the Pi JSONL survives on the kept disk (the SB prerequisite above).
    if (scenario.piConversationFile === "absent") expect(existsSync(openingSessionFile), "G2 Pi JSONL remains absent before follow-up").toBe(false);

    // Stage 4: base harness's real acquisition -> prepare -> find/rebind/persist
    // checkpoint -> resolve target/workspace sync -> execute path, no checkpoint
    // fabricated and no providerRecoveryPolicy patched into a local snapshot.
    const admitFollowup = async (fixture: Fixture) => {
      const selected = await findNativeSessionResumeRun(db!, { companyId, agentId, issueId, normalizedSessionId: first.native.normalizedSessionId,
        currentRunId: fixture.runId, beforeCreatedAt: fixture.run.createdAt });
      if (!selected) throw new Error("follow-up admission stuck behind the failed run: no resumable predecessor");
      fixture.native.runnerInstanceId = selected.runnerInstanceId!;
      await db!.update(heartbeatRuns).set({ runnerInstanceId: fixture.native.runnerInstanceId }).where(eq(heartbeatRuns.id, fixture.runId));
      const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: first.native.normalizedSessionId,
        executionTargetKind: "remote", buildExecution: () => fixture.execution });
      // The rebind keeps the admitted execution's schema version (built above).
      fixture.execution = admission.execution as typeof fixture.execution;
      expect(admission.checkpoint).not.toBeNull();
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ sessionCheckpoint: admission.checkpoint, nativeExecutionInput: fixture.execution })}::jsonb` }).where(eq(heartbeatRuns.id, fixture.runId));
      return { selected, admission };
    };
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board", body: followupPrompt }).returning();
    expect(comment!.body).not.toContain(fact);
    const next = await seed(comment!.body, B.identity, first.native.normalizedSessionId, comment!.id);
    followupRunId = next.runId; activeRunId = next.runId;
    expect(next.lease.id).not.toBe(first.lease.id);
    expect(next.lease.providerLeaseId).toBe(allocationIds[sameBoxCold ? 0 : 1]);
    const { selected, admission } = await admitFollowup(next);
    expect(selected?.id).toBe(first.runId);
    const nextOptions = await executionOptions(next);
    expect(nextOptions.target.sandboxLeaseAcquisition).toMatchObject({ outcome: sameBoxCold ? "resumed" : "created", providerLeaseId: allocationIds[sameBoxCold ? 0 : 1] });
    const envelope = existsSync(checkpointPath) ? record(JSON.parse(await readFile(checkpointPath, "utf8"))) : null;
    const localSnapshot = record(envelope?.snapshot);
    if (sameBoxCold) {
      const openingWarmSnapshot = record(record(JSON.parse(checkpointBeforeRestart!.toString("utf8"))).snapshot);
      expect(localSnapshot.cursor, "SB keeps the opening warm cursor EXACTLY through restart and follow-up admission")
        .toEqual(openingWarmSnapshot.cursor);
    }
    // Diagnostic only, intentionally NOT an assertion about local warm policy.
    // Runtime prefers a compatible local snapshot over its DB load. The command
    // provenance below establishes whether recovery actually reached the box.
    const diagnostic = { path: checkpointPath, present: envelope !== null, configDigest: envelope?.configDigest ?? null,
      localIdentity: localSnapshot.identity ?? null, localProviderSessionId: localSnapshot.providerSessionId ?? null,
      localHasProviderRecoveryPolicy: Object.hasOwn(localSnapshot, "providerRecoveryPolicy"), localProviderRecoveryPolicy: localSnapshot.providerRecoveryPolicy ?? null,
      selectedRunId: selected!.id, admittedProviderSessionId: admission.checkpoint?.providerSessionId ?? null,
      admittedProviderRecoveryPolicy: admission.checkpoint?.providerRecoveryPolicy ?? null,
      runtimePrecedence: "compatible loadWarmNativeCheckpoint snapshot, else control-plane DB checkpoint",
      failoverBackups: backupInventory(), backupsRemoved: false };
    console.log(`E2E-PI-WARM-CHECKPOINT: ${JSON.stringify(diagnostic)}`);
    await writeFile(join(root, "warm-checkpoint-diagnostic.json"), JSON.stringify(diagnostic, null, 2));
    if (governedWait) {
      expect(localSnapshot.semanticResult, "G prerequisite: warm envelope still owns the yielded opening").toMatchObject({
        reportedWorkDisposition: "yielded", continuation: { kind: "response_wake", ...record(openingReport?.continuation) },
      });
      expect(admission.checkpoint?.providerRecoveryPolicy, "G prerequisite: actual governed-wait admission policy")
        .toBe("allow_replacement_after_governed_wait");
      console.log(`E2E-PI-WARM-CURSOR: ${JSON.stringify({ runId: next.runId, localWarmCursor: localSnapshot.cursor ?? null,
        admittedCheckpointCursor: admission.checkpoint?.cursor ?? null })}`);
    }
    const [taskSessionBeforeFollowup] = scenario.piConversationFile ? await db.select().from(agentTaskSessions).where(and(
      eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, agentId),
      eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, issueId))) : [];
    const conversationBeforeFollowup = readPiConversation(taskSessionBeforeFollowup?.sessionParamsJson);
    if (scenario.piConversationFile) {
      const [boundRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId));
      const [boundIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      // All materializePiSessionRecoveryNotice authority gates stay REAL.
      expect(boundRun).toMatchObject({ companyId, agentId, status: "running", nativeIssueId: issueId,
        nativeSessionId: first.native.normalizedSessionId, contextSnapshot: { conversationSessionGeneration: issue!.conversationSessionGeneration } });
      expect(boundRun?.resultJson?.startupCancellation).toBeUndefined();
      expect(boundIssue).toMatchObject({ companyId, conversationAgentId: agentId, conversationSessionGeneration: issue!.conversationSessionGeneration });
      expect(conversationBeforeFollowup).toMatchObject({ schema: "paperclip.pi-conversation.v1", id: first.native.normalizedSessionId,
        generation: 1, previousId: null, reason: "first_message", runId: first.runId });
    }
    const outcome = await B.call("execute", nextOptions.input).catch(error => {
      if (!governedWait) throw error;
      return { error: String(error), stack: error instanceof Error ? error.stack : null } as Record<string, unknown>;
    });
    if (governedWait) {
      // This witness is emitted by the child immediately before the REAL
      // executePaperclipNativeSession call, from the very target it passes.
      // Do not mistake parent-side workspace resolution for executor admission.
      // G1 runs on the SAME box (a resumed allocation); the replaced-box rows get 'created'.
      if (!sameBoxCold) expect(targets.find(target => target.runId === next.runId)?.acquisition,
        "G prerequisite: executor receives the CREATED-box acquisition required by scoped D-B6")
        .toMatchObject({ outcome: "created", providerLeaseId: allocationIds[1] });
    }
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next.runId));
    const notes = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).filter(row => row.authorType === "system");
    console.log(`E2E-PI-NOTES: ${JSON.stringify(notes.map(note => ({ id: note.id, runId: note.createdByRunId, text: note.body,
      writer: "server/src/services/native-runtime/pi-session-recovery-notice.ts:61 (writePiSessionHistoryLossNotice)",
      freshThreadWriter: "server/src/services/native-runtime/fresh-thread-stop-gate.ts:52-56 (writeFreshThreadNotice)",
      freshThreadText: note.body.includes("Starting a fresh thread") ? "server/src/services/native-runtime/fresh-thread-stop-gate.ts:15"
        : note.body.includes("stopping the earlier attempt") ? "server/src/services/native-runtime/fresh-thread-stop-gate.ts:17" : null,
      metadata: note.metadata })))}`);
    await writeFile(join(root, "notes.json"), JSON.stringify(notes, null, 2));
    if (scenario.piConversationFile === "absent") console.log(`E2E-PI-G2: ${JSON.stringify({
      notes: notes.map(note => ({ text: note.body, metadata: note.metadata })),
      recordExistedBeforeFollowup: conversationBeforeFollowup?.id === first.native.normalizedSessionId,
      messageRoles: requests.filter(request => request.runId === next.runId).map(request =>
        (record(request.request).messages as Array<{ role: string }>).map(message => message.role)),
    })}`);
    const throwSite = (stack: unknown) => typeof stack === "string" ? stack.split("\n").find(line => /^\s+at /.test(line))?.trim() ?? null : null;
    console.log(`E2E-PI-OUTCOME: ${JSON.stringify({ runId: next.runId, error: persisted?.error ?? outcome.error ?? null,
      errorCode: persisted?.errorCode ?? outcome.errorCode ?? null, throwSite: throwSite(outcome.stack), outcome, events })}`);
    await writeFile(join(root, "followup-outcome.json"), JSON.stringify({ outcome, persisted, events }, null, 2));

    if (sameBoxCold) {
      const eventCountByType = events.reduce<Record<string, number>>((counts, event) => {
        counts[event.eventType] = (counts[event.eventType] ?? 0) + 1; return counts;
      }, {});
      console.log(`E2E-PI-SB-COUNT: ${JSON.stringify({ runId: next.runId, eventCountByType, localWarmCursor: localSnapshot.cursor ?? null })}`);
    }
    if (governedWait && (outcome.error != null || persisted?.error != null
      || record(outcome.result).exitCode !== 0 || record(outcome.result).summary !== governedReply)) {
      // Capture the FIRST failure before a second person message. Do not repair,
      // bypass, or overwrite the failed predecessor: use the same admission.
      const firstError = String(persisted?.error ?? outcome.error ?? `non-answer: ${JSON.stringify(outcome)}`);
      let secondRunId: string | undefined;
      let secondOutcome: Record<string, unknown>;
      let secondSelectedRunId: string | undefined;
      try {
        const [secondComment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
          body: `One more person message. ${followupPrompt}` }).returning();
        const second = await seed(secondComment!.body, B.identity, first.native.normalizedSessionId, secondComment!.id);
        secondRunId = second.runId; activeRunId = second.runId;
        const secondAdmission = await admitFollowup(second);
        secondSelectedRunId = secondAdmission.selected.id;
        const secondOptions = await executionOptions(second);
        secondOutcome = await B.call("execute", secondOptions.input);
      } catch (error) {
        secondOutcome = { error: String(error), stack: error instanceof Error ? error.stack : null };
      }
      const [secondPersisted] = secondRunId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRunId)) : [];
      const secondEvents = secondRunId ? await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, secondRunId)) : [];
      const secondAnswered = secondOutcome.error == null && secondPersisted?.error == null
        && record(secondOutcome.result).exitCode === 0 && record(secondOutcome.result).summary === governedReply;
      const secondEvidence = { message: 2, runId: secondRunId ?? null, selectedRunId: secondSelectedRunId ?? null,
        expected: "stuck behind the failed run", expectedBlockedByRunId: next.runId, disposition: secondAnswered ? "answered" : "refused",
        error: secondPersisted?.error ?? secondOutcome.error ?? null, errorCode: secondPersisted?.errorCode ?? secondOutcome.errorCode ?? null,
        throwSite: throwSite(secondOutcome.stack), outcome: secondOutcome, events: secondEvents };
      console.log(`E2E-PI-OUTCOME: ${JSON.stringify(secondEvidence)}`);
      await writeFile(join(root, "second-followup-outcome.json"), JSON.stringify(secondEvidence, null, 2));
      throw new Error(`G-warm first follow-up failed: ${firstError}; throw site: ${throwSite(outcome.stack) ?? "see outcome stack"}; second message ${secondEvidence.disposition}: ${secondEvidence.error ?? "see outcome"}`);
    }

    // Row-R prerequisites ALWAYS precede the target outcome assertions. A RED
    // from backup_without_reusable_lease, admission or TLS cannot masquerade as
    // the deployed missing-runner-state reproduction.
    const failedStateReads = commands.filter(command => command.activeRunId === next.runId && command.generation === 2
      && command.providerLeaseId === allocationIds[1] && command.command === "sh"
      && (command.args as string[] | undefined)?.[0] === "-c"
      // S1's reader runs `test -f P && base64 < P`; D-B4's runs `test -f P || exit 66; base64 < P`.
      && (command.args as string[])[1].startsWith(`test -f '${remoteState}' `)
      && (command.args as string[])[1].endsWith(`base64 < '${remoteState}'`)
      && typeof command.exitCode === "number" && command.exitCode !== 0 && command.timedOut === false);
    if (!sameBoxCold) expect(failedStateReads, `real readRemoteRunnerState must fail on the NEW box; backups retained: ${JSON.stringify(diagnostic)}`).not.toHaveLength(0);
    expect(events.some(event => event.eventType === "native.process_start_requested"), "deployed seq-59 execution start evidence").toBe(true);
    if (!governedWait) expect(admission.checkpoint?.providerRecoveryPolicy, "Paul's plain 17/19 admission policy").toBe("allow_replacement_after_resume_failure");
    expect(targets.find(target => target.runId === next.runId)?.acquisition).toMatchObject({ outcome: sameBoxCold ? "resumed" : "created", providerLeaseId: allocationIds[sameBoxCold ? 0 : 1] });

    if (governedWait) {
      // G TARGETS: both answer, never a fresh-thread refusal. G1 resumes the
      // surviving Pi history; G2 starts without history and explains it once.
      expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
      expect(outcome.result).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId, summary: governedReply });
      expect(requests.filter(request => request.runId === next.runId)).toHaveLength(1);
      expect(notes.length).toBeLessThanOrEqual(1);
      if (scenario.piConversationFile === "absent") {
        expect(requests.filter(request => request.runId === next.runId)[0], "G2 history ABSENT in the model request").toMatchObject({ containsFact: false });
        expect(notes, "G2 exactly one real Pi missing-file system note").toHaveLength(1);
        expect(notes[0]?.body).toBe("My earlier conversation could not be restored: the saved Pi conversation file is missing on this computer. Starting a new one.");
        expect(String(record(notes[0]?.metadata).authorizationReason)).toMatch(new RegExp(`^pi_session_file_missing:${first.native.normalizedSessionId}:`));
      } else {
        expect(requests.filter(request => request.runId === next.runId)[0], "G1 history PRESENT in the model request").toMatchObject({ containsFact: true });
        expect(notes, "G1 preserved history needs no system notice").toHaveLength(0);
      }
      // Cut B deletes the stopping note (FRESH_THREAD_STOPPING_NOTE is gone). RFL 16:07Z: pin the
      // route's EXACT system-note set instead, so any stray note fails, a reintroduced stopping note
      // included: G1 none; G2 exactly the missing-file note.
      expect(notes.map(note => note.body), "the route's exact system-note set").toEqual(scenario.piConversationFile === "absent"
        ? ["My earlier conversation could not be restored: the saved Pi conversation file is missing on this computer. Starting a new one."] : []);
      expect(notes.filter(note => note.body.includes(FRESH_THREAD_STARTED_NOTE))).toHaveLength(0);
    } else if (sameBoxCold) {
      // SB KEEP-GREEN TARGET: same normalized conversation, no replay and no
      // fresh-session history re-send even though both Runner and Pi were cold.
      expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
      expect(outcome.result).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId, summary: `RECALLED_${fact}` });
      expect(next.native.normalizedSessionId).toBe(first.native.normalizedSessionId);
      expect(persisted?.nativeSessionId).toBe(first.native.normalizedSessionId);
      const sequenceErrors = [outcome.error, outcome.errorCode, persisted?.error, persisted?.errorCode,
        ...events.flatMap(event => {
          const payload = record(record(event.payload).prpEvent).payload;
          return [event.message, record(payload).error, record(payload).message, record(payload).code];
        })];
      expect(JSON.stringify(sequenceErrors), "SB has no sourceSeq/ackedSourceSeq error")
        .not.toMatch(/sourceSeq|ackedSourceSeq|source_seq|acked_source_seq/i);
      const sourceIds = events.map(event => event.sourceEventId).filter((id): id is string => id !== null);
      expect(new Set(sourceIds).size, "no duplicate follow-up sourceEventId").toBe(sourceIds.length);
      const openingEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, first.runId));
      const openingSourceIds = new Set(openingEvents.map(event => event.sourceEventId).filter(Boolean));
      expect(sourceIds.filter(id => openingSourceIds.has(id)), "no opening PRP events replayed into follow-up").toEqual([]);
      expect(events.filter(event => event.eventType === "turn.started")).toHaveLength(1);
      expect(events.filter(event => event.eventType === "turn.completed")).toHaveLength(1);
      const prpEvents = events.filter(event => record(event.payload).prpEvent != null).map(event => record(record(event.payload).prpEvent));
      expect(prpEvents.length, "real follow-up PRP events").toBeGreaterThan(0);
      expect(prpEvents.every(event => event.runId === next.runId && event.normalizedSessionId === first.native.normalizedSessionId)).toBe(true);
      const followupTurns = prpEvents.filter(event => event.eventType === "turn.started" || event.eventType === "turn.completed");
      expect(followupTurns.every(event => typeof event.turnId === "string" && event.turnId.length > 0)).toBe(true);
      expect(new Set(followupTurns.map(event => event.turnId)).size, "one follow-up turn, started and completed").toBe(1);
      const openingTurnIds = new Set(openingEvents.map(event => record(record(event.payload).prpEvent).turnId).filter(Boolean));
      expect(followupTurns.some(event => openingTurnIds.has(event.turnId)), "no opening turn replay").toBe(false);
      const followupRequests = requests.filter(request => request.runId === next.runId);
      expect(followupRequests).toHaveLength(1);
      // The fact comes from Pi's own resumed conversation. The opening message in
      // that history is itself a first-turn handoff envelope, so only the NEW
      // message is checked for a re-sent history handoff.
      expect(followupRequests[0]).toMatchObject({ containsFact: true, reply: `RECALLED_${fact}` });
      const followupMessages = record(followupRequests[0]!.request).messages as Array<{ role: string; content: unknown }>;
      expect(followupMessages.map(message => message.role), "the resumed Pi history plus the new message").toEqual(["user", "assistant", "user"]);
      expect(JSON.stringify(followupMessages.at(-1)?.content), "no fresh-session history handoff in the new message").not.toContain("Fresh session handoff");
      expect(generation).toBe(1);
      expect(providerCalls.filter(call => call.method === "environmentAcquireLease"), "one allocation only").toHaveLength(1);
      expect(providerCalls.filter(call => ["environmentStopLease", "environmentReleaseLease", "environmentDestroyLease"].includes(String(call.method))),
        "box kept throughout cold-runner recovery").toHaveLength(0);
    } else {
      // Target (RED S1 / GREEN target D-B1+D-B2+D-B4+D-B5), never relaxed to accept refusal.
      expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
      expect(outcome.result).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId, summary: `RECALLED_${fact}` });
      const finalCheckpoint = record(record(persisted?.runnerProfileJson).sessionCheckpoint);
      expect(finalCheckpoint.providerSessionId).toBeTruthy();
      expect(finalCheckpoint.providerSessionId, "fresh provider session, same normalized conversation").not.toBe(admission.checkpoint!.providerSessionId);
      const followupRequests = requests.filter(request => request.runId === next.runId);
      expect(followupRequests).toHaveLength(1);
      expect(followupRequests[0]).toMatchObject({ containsFact: true, handoffHasFact: true, reply: `RECALLED_${fact}` });
      expect(notes.length).toBeLessThanOrEqual(1);
      // RFL 16:07Z exact set: the plain row (history handed over) writes no system note at all.
      expect(notes.map(note => note.body), "plain row: the route's exact system-note set").toEqual([]);
      expect(notes.filter(note => note.body.includes(HELD_PREDECESSOR_NOTICE)), "no held notice on the answered path").toHaveLength(0);
      expect(notes.some(note => String(record(note.metadata).authorizationReason ?? "").startsWith("native_prior_owner_held:"))).toBe(false);
      const persistedEvidence = JSON.stringify({ resultJson: persisted?.resultJson, runnerProfileJson: persisted?.runnerProfileJson, events });
      expect(persistedEvidence).not.toContain("recoveryRefusalCode");
      expect(persistedEvidence).not.toContain('"code":"runner_remote_state_unavailable"');
    }
    expect(providerCalls.some(call => call.method === "environmentDestroyLease"), "never destroy either box").toBe(false);
    await nextOptions.sync.restoreWorkspace();
    stage(governedWait ? "GREEN: governed-wait replaced-box follow-up answered"
      : sameBoxCold ? "GREEN: same-box cold-runner follow-up answered without replay or history re-send"
      : "GREEN: replaced-box follow-up answered from real history handoff", { runId: next.runId, failedStateReads });
  } catch (error) { failure = error; throw error; }
  finally {
    const errors: unknown[] = [];
    // Even prerequisite failures print the persisted run and error inventory.
    if (failure) {
      const [run] = db && followupRunId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, followupRunId)) : [];
      const events = db && followupRunId ? await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, followupRunId)) : [];
      console.log(`E2E-PI-OUTCOME: ${JSON.stringify({ runId: followupRunId ?? activeRunId ?? null, assertionFailure: String(failure), error: run?.error ?? null, errorCode: run?.errorCode ?? null, events })}`);
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
    console.log(`Pi replaced-box evidence retained: ${root}`);
    if (providerCalls.some(call => call.method === "environmentDestroyLease")) errors.push(new Error("forbidden provider destroy was requested"));
    if (failure) await writeFile(join(root, "failure.txt"), failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "replaced-box body/cleanup failed; evidence retained");
  }
};
it.skipIf(!enabled).each(recoveryCases.filter(scenario => !scenario.awaits))("RFL R: $name", runRecoveryCase, 600_000);
// Expected red BY NAME: it.fails passes while the row is red and fails as soon as its
// piece makes it green; that commit removes the .fails.
const awaitingCases = recoveryCases.filter(scenario => scenario.awaits);
if (awaitingCases.length) (enabled ? it.fails : it.skip).each(awaitingCases)(
  "RFL R (expected red, awaits $awaits): $name", runRecoveryCase, 600_000);
