// Real-runner row for cl/retry-fresh (888d1250): a person's task Retry that
// admission routes to a fresh isolated workspace opens a NEW Pi provider thread
// on its first run, with the saved-history handoff, and posts one fresh-thread
// note. Before the fix the Retry kept the conversation's session id, the server
// restored the old box's checkpoint into the new scope root, and the identity
// check refused it (runner_state_identity_mismatch: prior_owner_scope_mismatch).
// Unit counterpart: server/src/services/retry-fresh-provider-thread.test.ts.
//
// Fixtures are those of native-pi-rpc-replaced-box-followup.e2e.test.ts (copied
// so this row stays self-contained in ONE new file): real DB admission, two OS
// controller processes, default sandbox driver, runnerd, TLS PRP preview,
// qualified Pi 1.5.2. Faked: provider allocation/RPC boundary and loopback
// Messages responses only.
//
// Readiness reason: this harness only runs REMOTE sandbox targets (the
// controller child throws "sandbox target missing" for anything else), so the
// source run's lease provider is never "local". Admission therefore selects
// fresh_isolated_workspace for the REMOTE reason
// (explicit-native-continuation.ts:566 `remote = leases.some(lease =>
// lease.provider !== "local")`, :646 `only = ... !candidate.remote`), and the
// workspace_not_task_owned check (retainedIssueWorkspaceForRetry, :650) is never
// reached. That is the unit test's "remote" case, the same fix path
// (recordRetryFreshProviderThread). Expressing "workspace not task-owned" needs
// a LOCAL runnerd target in this harness (a provider "local" lease, a local
// process-identity stop record and an execution_workspaces row the issue does
// not own), which it does not have.
//
// The stranded turn is real (runner and Pi killed mid-turn while the model
// request is open). The terminal bookkeeping the server's watchdog would write
// (failed/native_runner_lost, terminal finalization, blocked recovery action)
// is seeded exactly as the unit test seeds it; the harness runs no watchdog.
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
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, plugins,
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
import { admitExplicitNativeContinuation } from "../services/explicit-native-continuation.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { createSystemRecovery, failSystemRecovery, SystemRecoveryFailure } from "../services/system-recovery-state.js";

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


const runRetryFreshCase = async () => {
  const scenario = { name: "retry-fresh-thread", priorRun: "failed-launched", box: "replaced", responseWait: undefined as string | undefined,
    restoreRefused: undefined as true | undefined, piConversationFile: "present" as const };
  const governedWait = scenario.priorRun === "yielded-response-wake";
  const reviewerShape = scenario.responseWait === "github-review-shape";
  const sameBoxCold = scenario.box === "same-box-cold";
  const restoreRefused = scenario.restoreRefused === true;
  expect(process.platform).toBe("linux");
  expect(process.env.TMPDIR, "dedicated parent-owned TMPDIR required").toBeTruthy();
  const runnerBinary = process.env.PAPERCLIP_RUNNER_BINARY;
  const providerPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
  if (!runnerBinary?.startsWith("/") || !providerPack?.startsWith("/")) throw new Error("Set absolute qualified runner and provider-pack paths");
  await access(runnerBinary, constants.X_OK);
  await access(providerPack, constants.R_OK | constants.X_OK);
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-retry-fresh-"));
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
  let activeRunId: string | undefined, holdRunId: string | undefined;
  const held: Array<import("node:http").ServerResponse> = [];
  let openingRunId: string | undefined, openingReport: Record<string, unknown> | undefined;
  const openingToolCallId = `g-warm-finish-${randomUUID()}`;
  let generation = 1;
  const allocationIds = [`image-A-${randomUUID()}`, `image-B-${randomUUID()}`];
  const allocations = new Map(allocationIds.map(id => [id, "running" as "running" | "stopped"]));
  const destroyRefusals: string[] = [];
  const leaseActive = new Map<string, boolean>();
  const model = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
      try {
        const parsed = JSON.parse(body);
        if (holdRunId && activeRunId === holdRunId) {
          requests.push({ runId: activeRunId, path: req.url, request: parsed, held: true }); held.push(res); return;
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
  let currentWorkspaceId = workspaceId;
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
        // Box A keeps running between the prior turn and the stranded turn (the
        // same warm box); after the swap only box B exists.
        if (generation !== 1) throw new Error("image swap must select a created allocation, never resume the old one");
        // Same allocation/disk; a cold runner is not a stopped/replaced box.
        // G's second-message diagnostic may also reuse the already-created B.
        expect(input.providerLeaseId).toBe(allocationId);
        expect(allocations.get(allocationId)).toBe("running");
        return { providerLeaseId: allocationId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
      }
      if (method === "environmentDestroyLease") {
        // SMA-60: with a current backup (custody verified) the runtime asks to
        // destroy the obsolete image-A box; this provider KEEPS it (as a kept
        // Boat box does) and refuses. No termination receipt exists, so no
        // retired-source proof: host preparation refuses the backup by name.
        if (restoreRefused && String(input.providerLeaseId) === allocationIds[0]) {
          destroyRefusals.push(String(input.providerLeaseId));
          throw new Error("provider keeps the old box: destroy refused");
        }
        throw new Error("box destroy is forbidden in row R");
      }
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
      boundary: { provider: "pi_rpc", cwd: localCwd, remoteCwd, workspaceId: currentWorkspaceId,
        trust: nativeSha256({ trustPreset: null, trust: null, permissionMode: null, approvalPolicy: null,
          sandboxMode: null, homeMode: "isolated", account: null }) },
    });
    const seed = async (prompt: string, controller: Record<string, unknown>, normalizedSessionId?: string, wakeCommentId?: string,
      admitted?: typeof heartbeatRuns.$inferSelect) => {
      const runId = admitted?.id ?? randomUUID();
      const [run] = admitted ? [admitted] : await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
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
        workspace: { id: currentWorkspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: native.normalizedSessionId,
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
      const sync = await prepareNativeWorkspaceSync({ db: db!, runId: fixture.runId, companyId, workspaceId: currentWorkspaceId, workspaceLocalDir: localCwd,
        target, lease: fixture.lease as EnvironmentLease, resourceDisposition: "keep_running" });
      if (!sync) throw new Error("workspace sync missing");
      return { target, sync, input: { environmentId, leaseId: fixture.lease.id, execution: fixture.execution, runnerInstanceId: fixture.native.runnerInstanceId,
        runnerEnvironment: { PATH: process.env.PATH, ...configuredEnvironmentProjection({ PI_OFFLINE: "1", TMPDIR: process.env.TMPDIR! }),
          PI_CODING_AGENT_DIR: agentHome, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none",
          PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${modelAddress.port}`, PAPERCLIP_PROVIDER_TRACE_PATH: join(root, `${fixture.runId}.provider-trace.jsonl`) } } };
    };
    // The task's person (requestTaskRetry authority), as the unit test seeds it.
    await db.update(companies).set({ defaultResponsibleUserId: "local-board" }).where(eq(companies.id, companyId));
    // Exactly the heartbeat's resume selection (runtime-selection.ts:581-601):
    // the newest exact-session run supplies the checkpoint restored into the run.
    const admitResume = async (fixture: Fixture, normalizedSessionId: string) => {
      const selected = await findNativeSessionResumeRun(db!, { companyId, agentId, issueId, normalizedSessionId,
        currentRunId: fixture.runId, beforeCreatedAt: fixture.run.createdAt });
      if (!selected) return { selected: null, admission: null };
      fixture.native.runnerInstanceId = selected.runnerInstanceId!;
      await db!.update(heartbeatRuns).set({ runnerInstanceId: fixture.native.runnerInstanceId }).where(eq(heartbeatRuns.id, fixture.runId));
      const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId,
        executionTargetKind: "remote", buildExecution: () => fixture.execution });
      fixture.execution = admission.execution as typeof fixture.execution;
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ sessionCheckpoint: admission.checkpoint, nativeExecutionInput: fixture.execution })}::jsonb` }).where(eq(heartbeatRuns.id, fixture.runId));
      return { selected, admission };
    };

    // Stage 1: the chat's prior turn on box A: a real person comment, answered by real Pi.
    const [openingComment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
      body: `Remember my private fact: ${fact}. Acknowledge it.` }).returning();
    const first = await seed(openingComment!.body, A.identity, undefined, openingComment!.id);
    openingRunId = first.runId; activeRunId = first.runId;
    const firstOptions = await executionOptions(first);
    const firstOutcome = await A.call("execute", firstOptions.input);
    expect(firstOutcome.error, JSON.stringify(firstOutcome)).toBeUndefined();
    expect(firstOutcome.result).toMatchObject({ exitCode: 0, summary: `ACK_${fact}` });
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, first.runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first.runId));
    await firstOptions.sync.restoreWorkspace();
    await heartbeat.releaseEnvironmentLeasesForRun({ runId: first.runId, companyId, agentId, status: "succeeded", providerResourceDisposition: "keep_running" });
    stage("prior turn answered on box A", { runId: first.runId, sessionId: first.native.normalizedSessionId });

    // Stage 2: the next turn strands. Real Pi sends its model request on box A;
    // the controller, runner and Pi are then killed while that request is open.
    const [askComment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
      body: followupPrompt }).returning();
    expect(askComment!.body).not.toContain(fact);
    const source = await seed(askComment!.body, A.identity, first.native.normalizedSessionId, askComment!.id);
    activeRunId = source.runId; holdRunId = source.runId;
    const sourceResume = await admitResume(source, first.native.normalizedSessionId);
    expect(sourceResume.selected?.id, "the stranded turn continues the prior turn's thread").toBe(first.runId);
    const sourceOptions = await executionOptions(source);
    const stranded = A.call("execute", sourceOptions.input).catch(error => ({ error: String(error) }) as Record<string, unknown>);
    await vi.waitFor(() => expect(requests.some(request => request.runId === source.runId && request.held === true),
      "the stranded turn reached its model request").toBe(true), { timeout: 120_000, interval: 250 });
    observeRunnerProcesses();
    A.child.kill("SIGKILL"); await A.stopped;
    await stopBoxProcesses();
    for (const response of held.splice(0)) response.destroy();
    holdRunId = undefined; activeRunId = undefined;
    const strandedOutcome = await stranded;
    stage("source turn stranded mid-turn: controller A, runner and Pi killed", { runId: source.runId, strandedOutcome });
    // What the server's watchdog records for a lost runner (the unit test's seed).
    const wakeId = randomUUID();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_runner_lost", error: "The runner was lost mid-turn.",
      finishedAt: new Date() }).where(eq(heartbeatRuns.id, source.runId));
    // The dead controller A's coordinator lease is released with the terminal record.
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", attempt: 3, leaseOwner: null, leaseExpiresAt: null,
      failureDetail: { replacementDenied: "uncertain_external_action" } }).where(eq(nativeRunFinalizations.runId, source.runId));
    const recovery = failSystemRecovery(createSystemRecovery(source.runId, wakeId),
      new SystemRecoveryFailure("historical_source_missing", "use_alternative_strategy"));
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "uncertain_external_action", fingerprint: source.runId, status: "resolved", outcome: "blocked",
      nextAction: "Automatic recovery stopped.", evidence: { runId: source.runId, systemRecovery: recovery,
        automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, issueId));
    await sourceOptions.sync.restoreWorkspace().catch(error => stage("source workspace restore failed", String(error)));
    // Box A is gone: release its lease through the product path; the provider reports it stopped.
    allocations.set(allocationIds[0]!, "stopped"); leaseActive.set(allocationIds[0]!, false);
    await heartbeat.releaseEnvironmentLeasesForRun({ runId: source.runId, companyId, agentId, status: "failed" })
      .catch(error => stage("source lease release failed", String(error)));
    const [sourceLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, source.lease.id));
    const productReceipt = record(sourceLease?.metadata).remoteExecutionTermination ?? null;
    // The product release records the provider's stop receipt; the fixture never writes one.
    expect(productReceipt, "product-written remote termination receipt").toMatchObject({ runId: source.runId, leaseId: source.lease.id,
      providerLeaseId: allocationIds[0], state: "stopped" });
    // hasRemoteTerminationReceipt's own predicate (remote-execution-termination.ts:45-48).
    expect(sourceLease?.releasedAt).toBeTruthy(); expect(sourceLease?.cleanupStatus).toBe("success");
    expect(["released", "expired", "failed"]).toContain(sourceLease?.status);
    stage("source lease released", { productReceipt, lease: sourceLease });
    // The new box: same path, empty disk, qualified pack preinstalled; the old disk is kept aside.
    const oldDisk = join(root, "image-A-disk-retained"); await rename(remoteCwd, oldDisk); await mkdir(remoteCwd);
    generation = 2; await installImagePack();
    const [changedEnvironment] = await db.update(environments).set({ config: { ...environment.config, image: "fixture:image-B" } })
      .where(eq(environments.id, environmentId)).returning(); environment = changedEnvironment as Environment;
    const B = await startController();
    expect(B.identity.bootId).not.toBe(A.identity.bootId);

    // Stage 3: the person presses Retry. Real requestTaskRetry, then queue
    // admission's transaction: admitExplicitNativeContinuation + the ONE successor run.
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "local-board", idempotencyKey: randomUUID(),
      observedRunId: source.runId });
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ accepted: true });
    const retryCreatedAfter = new Date();
    const successorRunId = randomUUID();
    let blockedWith: string | null = null;
    const admitted = await db.transaction(async tx => {
      if (!db) throw new Error("Expected initialized test database");
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      const continuation = await admitExplicitNativeContinuation({ db: tx as unknown as typeof db, companyId, issueId, agentId,
        actorType: "user", actorId: "local-board", reason: "task_retry", commentId: null, successorRunId,
        taskRetryRequestId: receipt.requestId!, onBlocked: (reason, message) => { blockedWith = `${reason}: ${message}`; } });
      await tx.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
        status: "queued", invocationSource: "on_demand", contextSnapshot: { issueId, wakeReason: "task_retry", forceFreshSession: true,
          previousRunId: continuation?.previousRunId, explicitUserContinuation: continuation,
          conversationSessionGeneration: issue!.conversationSessionGeneration } });
      return continuation;
    });
    stage("Retry admitted", { receipt, admitted, blockedWith });
    expect(blockedWith).toBeNull();
    expect(admitted?.readiness, "the Retry is admitted into a fresh isolated workspace").toMatchObject({
      mode: "fresh_isolated_workspace", sourceRunId: source.runId });
    const [retryRun] = await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, successorRunId)).returning();
    // The fresh isolated workspace: a new execution workspace, so a new session scope.
    currentWorkspaceId = randomUUID();
    followupRunId = successorRunId; activeRunId = successorRunId;
    const retry = await seed(askComment!.body, B.identity, undefined, undefined, retryRun!);
    const retrySessionId = retry.native.normalizedSessionId;
    const retryResume = await admitResume(retry, retrySessionId);
    stage("Retry run selected", { runId: retry.runId, sessionId: retrySessionId, oldSessionId: first.native.normalizedSessionId,
      restoredFromRunId: retryResume.selected?.id ?? null });
    const retryOptions = await executionOptions(retry);
    const outcome = await B.call("execute", retryOptions.input)
      .catch(error => ({ error: String(error), stack: error instanceof Error ? error.stack : null }) as Record<string, unknown>);
    await retryOptions.sync.restoreWorkspace().catch(error => stage("retry workspace restore failed", String(error)));

    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.runId));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, retry.runId));
    const notes = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).filter(row => row.authorType === "system");
    const logs = stages.map(record).filter(entry => entry.kind === "log" && entry.runId === retry.runId).map(entry => String(entry.text));
    const runsAfterRetry = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, issueId)))
      .filter(run => run.createdAt >= retryCreatedAfter || ![first.runId, source.runId].includes(run.id));
    const retryRequests = requests.filter(request => request.runId === retry.runId);
    const [taskSession] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, issueId)));
    const conversation = readPiConversation(taskSession?.sessionParamsJson);
    const evidence = { runId: retry.runId, oldSessionId: first.native.normalizedSessionId, retrySessionId,
      restoredFromRunId: retryResume.selected?.id ?? null, readiness: admitted?.readiness ?? null,
      error: persisted?.error ?? outcome.error ?? null, errorCode: persisted?.errorCode ?? null, outcome,
      modelRequests: retryRequests.length, handoffHasFact: retryRequests.map(request => request.handoffHasFact),
      conversation, runsAfterRetry: runsAfterRetry.map(run => ({ id: run.id, status: run.status, errorCode: run.errorCode })),
      notes: notes.map(note => ({ body: note.body, metadata: note.metadata })) };
    console.log(`E2E-PI-RETRY-FRESH: ${JSON.stringify(evidence)}`);
    await writeFile(join(root, "retry-outcome.json"), JSON.stringify({ ...evidence, persisted, events, logs }, null, 2));

    // RED names the deployed refusal first.
    expect(JSON.stringify({ outcome, error: persisted?.error ?? null, errorCode: persisted?.errorCode ?? null,
      resultJson: persisted?.resultJson ?? null, events, logs }), "no prior_owner_scope_mismatch anywhere").not.toContain("prior_owner_scope_mismatch");
    expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
    expect(persisted?.error ?? null).toBeNull();
    expect(runsAfterRetry.map(run => run.id), "exactly ONE run after the Retry").toEqual([retry.runId]);
    expect(retrySessionId, "a NEW Pi session id").not.toBe(first.native.normalizedSessionId);
    expect(record(outcome.result)).toMatchObject({ exitCode: 0, sessionId: retrySessionId, summary: `RECALLED_${fact}` });
    expect(retryResume.selected, "nothing old restored into the new scope").toBeNull();
    expect(retryRequests, "the Retry ANSWERS: one model request").toHaveLength(1);
    expect(retryRequests[0], "the submitted prompt opens with the saved-history handoff carrying the earlier fact")
      .toMatchObject({ handoffHasFact: true, reply: `RECALLED_${fact}` });
    expect(JSON.stringify(record(retryRequests[0]!.request).messages), "the submitted prompt carries the handoff heading")
      .toContain("## Fresh session handoff");
    expect(conversation).toMatchObject({ id: retrySessionId, previousId: first.native.normalizedSessionId, runId: retry.runId,
      reason: expect.stringMatching(/^fresh_continuation:/) });
    expect(notes.filter(note => String(record(note.metadata).authorizationReason ?? "").startsWith("fresh_provider_thread:")),
      "exactly one fresh-thread note").toHaveLength(1);
    stage("GREEN: Retry answered on a new Pi thread with the saved-history handoff", { runId: retry.runId });
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
    console.log(`Pi retry-fresh evidence retained: ${root}`);
    if (providerCalls.some(call => call.method === "environmentDestroyLease"
      && !(restoreRefused && destroyRefusals.includes(String(record(call.input).providerLeaseId))))) errors.push(new Error("forbidden provider destroy was requested"));
    if (failure) await writeFile(join(root, "failure.txt"), failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "retry-fresh body/cleanup failed; evidence retained");
  }
};
it.skipIf(!enabled)("Retry into a fresh isolated workspace: the first run answers on a NEW Pi thread with the saved-history handoff (cl/retry-fresh)",
  runRetryFreshCase, 600_000);
