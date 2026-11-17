// xr-backup — S target rows, authored RED-first against 363c6f7e41.
// COPIED (not imported) from native-pi-rpc-replaced-box-followup.e2e.test.ts.
// Tests are ordinary assertions, NOT it.fails: a RED remains a failure.
// TES-164 / A1,A2,A5: expired+stopped is not an admitted idle backup source yet.
// A3,A4: a genuine older backup must not obstruct saved-history continuation.
// T-164-3: a failed restore must settle visibly once, not loop through failures.
// Every answer also requires containsFact in the follow-up MODEL REQUEST.
// Backup bytes/manifest/stamp are produced by the real controller's graceful
// checkpoint: native-session-executor.ts:19012-19175 (persistRemoteRunnerCheckpoint),
// using buildNativeHarnessBackupManifestStreamed and publishNativeHarnessBackup.
// No fixture-authored manifest, stamp, Pi JSONL, checkpoint or termination receipt.
// Local failover-backups are sufficient on a persistent server; S3 durable rows
// use native-harness-backup-storage.ts:235-340 in production, not a fixture insert.
// TL08 and its promise-note rows belong to the sibling x-red-tl08.e2e.test.ts.
// Real: DB resume admission, two OS controller processes with different bootIds,
// surviving controller state, default sandbox driver/commands, runnerd, TLS PRP
// preview, qualified Pi 1.5.2 and its JSONL, native history handoff and events.
// Faked: provider allocation/RPC boundary and loopback Messages responses only.
// The provider image swap retains the old disk and mounts an empty allocation
// at the same workspace path, except LIVE-A gives B its own path so A stays live.
// No runner/provider state or controller failover backup is removed to force the
// desired branch.
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
import { eq, sql } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it, vi } from "vitest";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import {
  agents, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, issueThreadInteractions, nativeRunFinalizations, nativeRunResults, plugins,
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
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import { ENVIRONMENT_CLEANUP_RETRY_MS } from "../services/environment-cleanup-state.js";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "../services/native-runtime/native-runner-recovery-contract.js";
import { prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { scopedRunnerdStateRoot, verifyNativeHarnessBackupStreamed } from "../services/native-runtime/native-session-executor.js";
import { nativeHarnessBackupHasLaterProviderWork } from "../services/native-runtime/native-retired-backup-source.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget } from "../services/native-runtime/native-session-resume.js";
import { materializeAsset } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const HELD_PREDECESSOR_NOTICE = "Your message and saved work are kept, but the previous run of this conversation did not finish. Send a new message to try again.";
import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "../services/native-runtime/native-provider-work-proof.js";

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
    } else if (message.method === 'clock') {
      const RealDate = Date, offset = message.input.offsetMs;
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
        static now() { return RealDate.now() + offset; }
      };
      result = { now: Date.now(), offsetMs: offset };
    } else if (message.method === 'checkpoint') {
      // Run the owning writer, not a hand-built manifest or a DB backup insert.
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

type RecoveryCase = {
  id: string; name: string; localEnvelope: "present" | "absent";
  backup: "current" | "stale" | "old-latest" | "absent";
  governed?: boolean; restoreFault?: boolean; freshNoteThenAnswer?: boolean;
  // Org rule 14:40Z: EVERY row seeds the production Pi conversation record
  // (agent_task_sessions) via the REAL selectPiConversation writer
  // (pi-conversation-record.ts:86, as heartbeat/runtime-selection.ts:546 calls
  // it), exactly as the G1/G2 rows do. Only an explicit piRecord: false opts out.
  piRecord?: boolean;
  expected: "native-answer" | "history-answer" | "one-refusal" | "no-history-one-note";
  expectedRed: string;
};
const tes164 = { localEnvelope: "present", backup: "current", expected: "native-answer",
  expectedRed: "expired+stopped source fails idle authorization: backup_without_reusable_lease; later retries may hit retained_sandbox_binding" } as const;
const recoveryCases: RecoveryCase[] = [
  { ...tes164, id: "T-164-1", name: "TES-164: FIRST follow-up restores SAME Pi session and history" },
  { ...tes164, id: "T-164-2", name: "TES-164: zero STOPPING/starting-fresh promises without an answer" },
  // RFL 16:51Z, path (a) measured in CB2: the faulted import falls back to a NEW provider session with the
  // fresh-thread history handoff, which is the intended fallback. No claim the old session was restored.
  { ...tes164, id: "T-164-3", name: "TES-164 negative: restore import faults; answered with history via the handoff (no old-session claim)",
    restoreFault: true, expected: "history-answer", expectedRed: "the real import fault must be reached; then the handoff answers with history" },
  ...(["present", "absent"] as const).flatMap(localEnvelope => ([
    { id: "A1", name: "current verified backup x plain", backup: "current", expected: "native-answer" },
    { id: "A2", name: "current verified backup x authorized governed response", backup: "current", governed: true, expected: "native-answer" },
    { id: "A3", name: "stale backup WITH durable later provider work x plain", backup: "stale", expected: "history-answer" },
    // A4 is RFL's MUST row (formerly A4-rec): the record is seeded like every row.
    // RFL 16:51Z: MUST is exactly ONE note with the EXISTING text, no new text (rule 12).
    { id: "A4", name: "stale backup WITH durable later provider work x authorized governed response", backup: "stale", governed: true, expected: "no-history-one-note" },
    { id: "A5", name: "old by wall clock, latest backup, NO later work", backup: "old-latest", expected: "native-answer" },
  ] as const).map(row => ({ ...row, localEnvelope,
    expectedRed: row.backup === "stale" ? "existing saved-history continuation must answer instead of failing behind an unusable backup"
      : "S has not admitted expired+stopped native idle sources" }))),
  { ...tes164, id: "NOTE-BACKUP", name: "with-backup: every fresh/stopping note is followed by an answer",
    freshNoteThenAnswer: true },
  { id: "NOTE-NO-BACKUP", name: "retained plain no-backup control: answer with history, zero fresh/stopping notes", localEnvelope: "present",
    backup: "absent", expected: "history-answer", freshNoteThenAnswer: true,
    expectedRed: "retained control if already green: N plain replacement carries the saved history" },
  { id: "NOTE-NO-BACKUP-LIVE-A", name: "live obsolete plain no-backup source: Stop A, answer with history, zero notes", localEnvelope: "present",
    backup: "absent", expected: "history-answer", freshNoteThenAnswer: true,
    expectedRed: "a live obsolete source must receive Stop and stay released while B carries saved history" },
];
const runRecoveryCase = async (scenario: RecoveryCase) => {
  const governedWait = scenario.governed === true;
  const liveBoxA = scenario.id === "NOTE-NO-BACKUP-LIVE-A";
  const noBackupCleanup = scenario.id === "NOTE-NO-BACKUP" || liveBoxA;
  const cleanupCase = liveBoxA ? "live-A" : "already-stopped-A";
  const reviewerShape = false;
  const sameBoxCold = false;
  expect(process.platform).toBe("linux");
  expect(process.env.TMPDIR, "dedicated parent-owned TMPDIR required").toBeTruthy();
  const runnerBinary = process.env.PAPERCLIP_RUNNER_BINARY;
  const providerPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
  if (!runnerBinary?.startsWith("/") || !providerPack?.startsWith("/")) throw new Error("Set absolute qualified runner and provider-pack paths");
  await access(runnerBinary, constants.X_OK);
  await access(providerPack, constants.R_OK | constants.X_OK);
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-replaced-box-"));
  let remoteCwd = join(root, "simulated-sandbox", "workspace");
  let stagedRuntime = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
  const localCwd = join(root, "host-workspace");
  await mkdir(remoteCwd, { recursive: true });
  const installImagePack = async () => {
    await mkdir(stagedRuntime, { recursive: true });
    await symlink(providerPack, join(stagedRuntime, "provider-pack"), "dir");
  };
  await installImagePack();
  const fact = `PI_REPLACED_FACT_${randomUUID()}`;
  const laterFact = `PI_AFTER_BACKUP_${randomUUID()}`;
  const followupPrompt = "What private fact did I tell you earlier? Repeat it exactly; do not invent it.";
  // Old-latest advances wall clock ONLY, never timers or receipt timestamps.
  // The writer stamps the actual old clock; all events are written by Runner.
  const oldClockOffsetMs = scenario.backup === "old-latest" ? 24 * 60 * 60_000 : 0;
  const stages: unknown[] = [], commands: Array<Record<string, unknown>> = [], requests: Array<Record<string, unknown>> = [];
  const providerCalls: Array<Record<string, unknown>> = [], startupEvents: Array<{ runId: string; event: AdapterRuntimeEvent }> = [];
  const targets: Array<Record<string, unknown>> = [];
  const spawned: Birth[] = [], piBirths: Birth[] = [], runnerMarkers = new Set<string>();
  let boxAProcesses: Birth[] = [], stoppedBoxAProcesses: Birth[] = [];
  let noBackupStopCallIndex: number | undefined;
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
  const stopBoxProcesses = async (processes?: Birth[]) => {
    observeRunnerProcesses();
    // Refresh descendants at Stop as well: the frozen births select A's tree,
    // not B's, while children created since the swap must also really end.
    const owned = processes ? [...processes.filter(sameBirth).flatMap(ownedProcessTree), ...processes]
      : [...spawned.flatMap(ownedProcessTree), ...piBirths, ...spawned];
    for (const child of owned) if (sameBirth(child)) process.kill(child.pid, "SIGKILL");
    // Process death is the bounded safety-net observation, not a periodic worker.
    await vi.waitFor(() => expect(owned.some(sameBirth), "owned box processes ended").toBe(false), { timeout: 15_000 });
    return owned;
  };
  let activeRunId: string | undefined;
  let openingRunId: string | undefined, openingReport: Record<string, unknown> | undefined;
  const openingToolCallId = `g-warm-finish-${randomUUID()}`;
  let laterRunId: string | undefined, laterReport: Record<string, unknown> | undefined;
  const laterToolCallId = `g-later-finish-${randomUUID()}`;
  let generation = 1;
  let harnessRestoreDirectory: string | undefined;
  const allocationIds = [`image-A-${randomUUID()}`, `image-B-${randomUUID()}`];
  const allocations = new Map(allocationIds.map(id => [id, "running" as "running" | "stopped"]));
  const leaseActive = new Map<string, boolean>();
  const model = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
      try {
        const parsed = JSON.parse(body);
        const first = requests.length === 0;
        const opening = governedWait && activeRunId === openingRunId;
        const laterWait = governedWait && laterRunId !== undefined && activeRunId === laterRunId;
        const yielding = opening || laterWait;
        const finishReport = laterWait ? laterReport : openingReport;
        const finishToolCallId = laterWait ? laterToolCallId : openingToolCallId;
        const useFinishTool = yielding && !requests.some(request => request.runId === activeRunId);
        const messages = parsed.messages as Array<{ role: string; content: unknown }>;
        const latestUserContent = messages.findLast(message => message.role === "user")?.content;
        const toolResult = Array.isArray(latestUserContent) ? latestUserContent.map(record)
          .find(block => block.type === "tool_result" && block.tool_use_id === finishToolCallId) : undefined;
        const containsFact = JSON.stringify(parsed.messages).includes(fact);
        const containsLaterFact = JSON.stringify(parsed.messages).includes(laterFact);
        const handoffHasFact = (parsed.messages as Array<{ content: unknown }>).some(message => {
          const content = JSON.stringify(message.content); return content.includes("Fresh session handoff") && content.includes(fact);
        });
        // Never return the secret just because this is turn two. Replaced/done
        // needs its handoff; SB needs the real Pi history. G asks a new question
        // and makes no claim to the earlier fact.
        const reply = (first || opening && toolResult) && containsFact ? `ACK_${fact}`
          : containsFact ? `RECALLED_${fact}` : "HISTORY_LOST";
        // Only author the provider's tool_use. Pi executes the real Runner
        // callback and returns its tool_result before our final text turn.
        const toolUse = useFinishTool ? { name: "paperclip_finish", input: finishReport } : undefined;
        if (useFinishTool) {
          expect(finishReport, "G yielded report bound to the actual run and contract").toBeDefined();
          expect((parsed.tools as Array<{ name: string }>).map(tool => tool.name), "Pi exposes the real semantic result tool")
            .toContain("paperclip_finish");
        } else if (yielding) expect(toolResult, "Pi returns the yielded result-tool receipt before final text").toBeDefined();
        requests.push({ runId: activeRunId, path: req.url, request: parsed, containsFact, containsLaterFact, handoffHasFact, reply, toolUse, toolResult });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        if (useFinishTool) {
          // completion-result.ts:2,384 and pi/extension/index.ts:206-207:
          // paperclip_finish, with the Runner's bridge schema unchanged in Pi.
          emit("content_block_start", { index: 0, content_block: { type: "tool_use", id: finishToolCallId, name: "paperclip_finish", input: {} } });
          emit("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(finishReport) } });
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
      const targetAllocationId = String(input.providerLeaseId ?? record(input.lease).providerLeaseId ?? allocationId);
      const providerEvidence: Record<string, unknown> = { at: new Date().toISOString(), method, input, generation, activeRunId,
        providerLeaseId: targetAllocationId };
      providerCalls.push(providerEvidence);
      if (method === "environmentAcquireLease") return { providerLeaseId: allocationId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
      if (method === "environmentResumeLease") {
        // Same-image warm handoff is allowed (the A3/A4 later-work turn).
        // No caller may resume the retired image-A allocation after the swap.
        if (String(input.providerLeaseId) !== allocationId)
          throw new Error("image swap must select a created allocation, never resume the old one");
        // Same allocation/disk; a cold runner is not a stopped/replaced box.
        // G's second-message diagnostic may also reuse the already-created B.
        expect(input.providerLeaseId).toBe(allocationId);
        expect(allocations.get(allocationId)).toBe("running");
        return { providerLeaseId: allocationId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: { remoteCwd } };
      }
      if (method === "environmentDestroyLease" || method === "environmentStopLease" || method === "environmentReleaseLease") {
        const id = String(input.providerLeaseId); allocations.set(id, "stopped"); leaseActive.set(id, false);
        // A stale image's Stop really ends A, never B's process generation.
        // LIVE-A freezes the actual runner/descendant births before B is admitted.
        if (liveBoxA && id === allocationIds[0]) stoppedBoxAProcesses = await stopBoxProcesses(boxAProcesses);
        else if (id === allocationId) await stopBoxProcesses();
        const result = { providerLeaseId: id, state: "stopped" };
        providerEvidence.result = result;
        return result;
      }
      if (method === "environmentInspectLease") {
        const id = String(input.providerLeaseId);
        const result = { providerLeaseId: id, state: allocations.get(id) === "running" ? "active" : "stopped", observedAt: new Date().toISOString() };
        providerEvidence.result = result;
        return result;
      }
      if (method === "environmentRealizeWorkspace") return { cwd: remoteCwd };
      if (method === "environmentRunnerIngressEndpoint") {
        const path = String(input.path); previewBindings.set(path, allocationId); leaseActive.set(allocationId, true);
        return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
          secretHeaders: [{ name: "X-Owned-Lease", value: allocationId }], generation: `box-${generation}` };
      }
      if (method === "environmentExecute") {
        const evidence: Record<string, unknown> = { at: new Date().toISOString(), command: input.command, args: input.args,
          generation, providerLeaseId: targetAllocationId, activeRunId };
        commands.push(evidence);
        try {
          // stageRemoteRunnerDirectory unpacks the VERIFIED backup at this RPC.
          // Fault the import, not the archive or source proof. On pre-S HEAD the
          // guard can refuse before this boundary; record both that and hits.
          if (scenario.restoreFault && generation === 2 && harnessRestoreDirectory && String(input.stdin ?? "").length > 0
            && JSON.stringify(input.args).includes("tar")
            && (input.args as string[]).some(arg => arg.includes(`mkdir -p '${harnessRestoreDirectory}'`))) {
            evidence.restoreFault = true;
            throw new Error("xr-backup injected restore import failure (source bytes retained)");
          }
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
    const seed = async (prompt: string, controller: Record<string, unknown>, normalizedSessionId?: string, wakeCommentId?: string) => {
      const runId = randomUUID();
      const [run] = await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
        ...(normalizedSessionId ? { nativeSessionId: normalizedSessionId } : {}),
        contextSnapshot: { issueId, ...(wakeCommentId ? { wakeCommentId } : {}),
          ...(scenario.piRecord !== false ? { conversationSessionGeneration: issue!.conversationSessionGeneration } : {}) } }).returning();
      const acquired = await runtime.acquireRunLease({ companyId, environment, heartbeatRunId: runId, issueId, agentId,
        adapterType: "paperclip_runner", persistedExecutionWorkspace: null, warmRunnerIdleTimeoutMs: WARM_IDLE_MS });
      const lease = acquired.lease;
      expect(lease.metadata).toMatchObject({ sandboxProviderPlugin: true, pluginId, provider, remoteCwd });
      // Selection precedes native preparation, as in the heartbeat; never hand-insert the row.
      const piConversation = scenario.piRecord !== false ? await selectPiConversation(db!, { companyId, agentId, issueId, runId,
        boundary: { provider: "pi_rpc", cwd: localCwd, remoteCwd, workspaceId,
          trust: nativeSha256({ trustPreset: null, trust: null, permissionMode: null, approvalPolicy: null,
            sandboxMode: null, homeMode: "isolated", account: null }) } }) : null;
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
    const admitExisting = async (fixture: Fixture, normalizedSessionId: string) => {
      const selected = await findNativeSessionResumeRun(db!, { companyId, agentId, issueId, normalizedSessionId,
        currentRunId: fixture.runId, beforeCreatedAt: fixture.run.createdAt });
      if (!selected) throw new Error("follow-up admission stuck behind the failed run: no resumable predecessor");
      fixture.native.runnerInstanceId = selected.runnerInstanceId!;
      await db!.update(heartbeatRuns).set({ runnerInstanceId: fixture.native.runnerInstanceId }).where(eq(heartbeatRuns.id, fixture.runId));
      const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId,
        executionTargetKind: "remote", buildExecution: () => fixture.execution });
      fixture.execution = admission.execution as typeof fixture.execution;
      expect(admission.checkpoint).not.toBeNull();
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ sessionCheckpoint: admission.checkpoint, nativeExecutionInput: fixture.execution })}::jsonb` }).where(eq(heartbeatRuns.id, fixture.runId));
      return { selected, admission };
    };
    // Stage 1: a real human opening comment, not a secret supplied by the oracle.
    const [openingComment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
      body: `Remember my private fact: ${fact}. Acknowledge it.` }).returning();
    const first = await seed(openingComment!.body, A.identity, undefined, openingComment!.id);
    harnessRestoreDirectory = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"), "runner");
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
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, first.runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first.runId));
    await firstOptions.sync.restoreWorkspace();
    if (scenario.backup !== "absent") {
      const saved = await A.call("checkpoint");
      console.log(`E2E-PI-BACKUP-WRITER: ${JSON.stringify(saved)}`);
      expect(saved.error, JSON.stringify(saved)).toBeUndefined();
      expect(saved.result, "the actual controller gracefully checkpoints one settled warm session").toMatchObject({ closed: 1, failed: 0, busy: 0 });
    }
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
    console.log(`E2E-PI-BACKUPS: ${JSON.stringify({ scenario, naturalInventory: backupsBeforeRestart,
      writer: "native-session-executor.ts:19012-19175", fixtureAuthoredManifest: false, removedByFixture: false })}`);
    expect(checkpointBeforeRestart, "real opening writes the LOCAL warm envelope").not.toBeNull();
    const backupManifestPath = join(backupRoot, "current", "manifest.json");
    const manifestBytes = scenario.backup === "absent" ? null : await readFile(backupManifestPath);
    const manifest = manifestBytes ? record(JSON.parse(manifestBytes.toString("utf8"))) : null;
    if (scenario.backup === "absent") expect(backupsBeforeRestart, "none removed to force a branch").toEqual([]);
    else {
      expect(backupsBeforeRestart).toContain("current/manifest.json");
      expect(manifest).toMatchObject({ normalizedSessionId: first.native.normalizedSessionId,
        runnerInstanceId: first.native.runnerInstanceId, sourceProviderLeaseId: allocationIds[0] });
      const verified = await verifyNativeHarnessBackupStreamed({ root: stateRoot, execution: first.execution,
        runnerInstanceId: first.native.runnerInstanceId });
      expect(verified, "production verifies the actual writer's manifest AND directory hashes").not.toBeNull();
      const savedConversation = await readFile(join(backupRoot, "current", "pi", `${first.native.normalizedSessionId}.jsonl`), "utf8");
      expect(savedConversation, "the backup carries the real opening fact").toContain(fact);
      const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, first.lease.id));
      expect(source?.metadata?.nativeHarnessBackup).toMatchObject({
        manifestSha256: `sha256:${createHash("sha256").update(manifestBytes!).digest("hex")}`,
        normalizedSessionId: first.native.normalizedSessionId, sourceProviderLeaseId: allocationIds[0] });
    }
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
    let latestSourceRunId = first.runId;
    if (scenario.backup === "stale") {
      // GENUINE later work: restore/reopen on A, execute an actual Pi turn, and
      // commit its durable events. Never fake staleness by changing a timestamp.
      const [laterComment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
        body: `After the backup, remember this additional fact: ${laterFact}. Recall the original private fact too.` }).returning();
      const later = await seed(laterComment!.body, A.identity, first.native.normalizedSessionId, laterComment!.id);
      await admitExisting(later, first.native.normalizedSessionId);
      if (governedWait) {
        // SMA-1 again on the latest real turn: a text-only later turn would
        // overwrite the yielded warm envelope AND DB checkpoint with a
        // synthesized completed result. Never patch either persisted snapshot.
        laterRunId = later.runId;
        laterReport = { ...openingReport, summary: `RECALLED_${fact}`,
          completionClaim: { ...record(openingReport?.completionClaim), contractRevision: later.native.completionContract.revision,
            criteria: later.native.completionContract.criterionIds.map(criterionId => ({ criterionId, status: "not_satisfied", evidenceRefs: [] })) },
          continuation: { ...record(openingReport?.continuation), idempotencyKey: `g-ops-date-check-${randomUUID().replaceAll("-", "").slice(0, 8)}` } };
      }
      activeRunId = later.runId;
      const laterOptions = await executionOptions(later);
      const laterOutcome = await A.call("execute", laterOptions.input);
      expect(laterOutcome.error, JSON.stringify(laterOutcome)).toBeUndefined();
      expect(laterOutcome.result).toMatchObject({ exitCode: 0, summary: `RECALLED_${fact}` });
      const laterRequests = requests.filter(request => request.runId === later.runId);
      expect(laterRequests, "later-work turn itself has its real history").toHaveLength(governedWait ? 2 : 1);
      for (const request of laterRequests) expect(request).toMatchObject({ containsFact: true, containsLaterFact: true });
      if (governedWait) {
        expect(laterRequests[0]?.toolUse).toEqual({ name: "paperclip_finish", input: laterReport });
        expect(laterRequests[1]?.toolResult).toMatchObject({ type: "tool_result", tool_use_id: laterToolCallId });
        expect(record(laterRequests[1]?.toolResult).is_error ?? false, "latest real yielded tool result accepted").toBe(false);
        const acceptedLater = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, later.runId));
        expect(acceptedLater, "latest DB checkpoint comes from the real yielded turn").toHaveLength(1);
        expect(acceptedLater[0]?.schemaStatus).toBe("accepted");
        expect(record(acceptedLater[0]?.resultJson).result).toMatchObject(laterReport!);
      }
      expect(await readFile(join(backupRoot, "current", "pi", `${first.native.normalizedSessionId}.jsonl`), "utf8"),
        "the real later fact is NOT in the stale archive").not.toContain(laterFact);
      const laterEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, later.runId));
      expect(laterEvents.some(event => NATIVE_PROVIDER_DURABLE_EVENT_TYPES.has(event.eventType)
        && event.createdAt > new Date(String(manifest!.completedAt))), "durable provider work strictly AFTER the checkpoint").toBe(true);
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, later.runId));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, later.runId));
      await laterOptions.sync.restoreWorkspace();
      await heartbeat.releaseEnvironmentLeasesForRun({ runId: later.runId, companyId, agentId, status: "succeeded", providerResourceDisposition: "keep_running" });
      expect((await readFile(backupManifestPath)).equals(manifestBytes!), "the backup was NOT silently refreshed by later work").toBe(true);
      latestSourceRunId = later.runId;
      activeRunId = undefined;
    }
    if (sameBoxCold) {
      // Idle-timeout shape without waiting five minutes: kill only the measured
      // box process births. Keep its allocation, disk, JSONL and runner state.
      await stopBoxProcesses();
      expect(allocations.get(allocationIds[0]!)).toBe("running");
      expect(await readFile(openingSessionFile, "utf8")).toContain(fact);
    }

    // Stage 2: retain actual writer bytes, then SIGKILL (do not silently refresh
    // a stale archive). No PAPERCLIP_HOME or state-root authority rotation.
    A.child.kill("SIGKILL"); await A.stopped;
    expect(A.child.signalCode).toBe("SIGKILL");
    expect(existsSync(stateRoot), "bind-mounted durable-sessions survives A").toBe(true);
    if (checkpointBeforeRestart && scenario.backup !== "stale") expect((await readFile(checkpointPath)).equals(checkpointBeforeRestart)).toBe(true);
    expect(backupInventory()).toEqual(backupsBeforeRestart);
    const B = await startController();
    if (oldClockOffsetMs) {
      const advanced = await B.call("clock", { offsetMs: oldClockOffsetMs });
      expect(advanced.error).toBeUndefined();
      expect(Number(record(advanced.result).now) - Date.parse(String(manifest?.completedAt))).toBeGreaterThanOrEqual(oldClockOffsetMs);
      stage("old-but-latest: controller wall clock advanced, no archive or event backdated", advanced.result);
    }
    if (scenario.localEnvelope === "absent") {
      await rename(checkpointPath, join(root, "opening-warm-envelope-retained.json"));
      expect(existsSync(checkpointPath)).toBe(false);
    }
    expect(B.identity.bootId).not.toBe(A.identity.bootId); expect(B.identity.pid).not.toBe(A.identity.pid);
    stage("real controller restart, same durable root and authority", { A: A.identity, B: B.identity, stateRoot, home: process.env.PAPERCLIP_HOME });

    let remoteState = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"), "runner", "runner-state.json");
    if (sameBoxCold) {
      expect(generation).toBe(1);
      expect(existsSync(remoteState), "SB prerequisite: original runner state retained on original disk").toBe(true);
      expect(await readFile(openingSessionFile, "utf8")).toContain(fact);
      stage("same box retained with cold runner across controller restart", { remoteCwd, providerLeaseId: allocationIds[0], remoteState });
    } else if (liveBoxA) {
      observeRunnerProcesses();
      boxAProcesses = [...spawned.flatMap(ownedProcessTree), ...piBirths, ...spawned];
      expect(sameBirth(spawned[0]!), "A runner is ALIVE at the image change").toBe(true);
      expect(sameBirth(piBirths[0]!), "A warm Pi is ALIVE at the image change").toBe(true);
      expect(allocations.get(allocationIds[0]!)).toBe("running");
      // One host namespace cannot faithfully mount A and B at the same path
      // while A is live: give B a distinct empty path, leaving A's absolute
      // paths and disk untouched. No process kill or stopped state at this swap.
      const oldDisk = remoteCwd;
      remoteCwd = join(root, "simulated-sandbox-B", "workspace");
      stagedRuntime = join(remoteCwd, ".paperclip-runtime", "paperclip-runner");
      await mkdir(remoteCwd, { recursive: true });
      expect(readdirSync(remoteCwd), "B has its own empty allocation disk").toEqual([]);
      generation = 2;
      remoteState = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"), "runner", "runner-state.json");
      await installImagePack();
      expect(existsSync(remoteState)).toBe(false);
      expect(await readFile(openingSessionFile, "utf8"), "A's original disk and conversation remain intact").toContain(fact);
      // Boot-source drift, not a fabricated source status or a plugin bump:
      // real acquisition's cleanupObsoleteReusableSandboxLeases queues Stop A.
      const [changed] = await db.update(environments).set({ config: { ...environment.config, image: "fixture:image-B" } })
        .where(eq(environments.id, environmentId)).returning();
      environment = changed as Environment;
      stage("environment image changed; A remains live on its own disk", { remoteCwd, oldDisk,
        oldProviderLeaseId: allocationIds[0], newProviderLeaseId: allocationIds[1], boxAProcesses });
    } else {
      // Stage 3: an external image swap, not product destruction. Stop measured
      // old-box births; retain the whole old disk; recreate the identical mount.
      stoppedBoxAProcesses = await stopBoxProcesses(); allocations.set(allocationIds[0]!, "stopped"); leaseActive.set(allocationIds[0]!, false);
      const oldDisk = join(root, "image-A-disk-retained"); await rename(remoteCwd, oldDisk); await mkdir(remoteCwd);
      expect(readdirSync(remoteCwd), "new allocation starts with an empty disk").toEqual([]);
      generation = 2;
      expect(existsSync(remoteState)).toBe(false);
      // The new image has the qualified pack preinstalled, but no conversation.
      await installImagePack(); expect(existsSync(remoteState)).toBe(false);
      // TES-164's trigger is the installed PLUGIN VERSION change, not a fake
      // source status/receipt write. Real acquisition retires the old lease on
      // lease_fingerprint_mismatch and records the provider's stopped response.
      await db.update(plugins).set({ version: "2.0.0" }).where(eq(plugins.id, pluginId));
      stage("plugin version replaced box at same mount", { remoteCwd, oldDisk,
        oldProviderLeaseId: allocationIds[0], newProviderLeaseId: allocationIds[1] });
    }

    // Stage 4: base harness's real acquisition -> prepare -> find/rebind/persist
    // checkpoint -> resolve target/workspace sync -> execute path, no checkpoint
    // fabricated and no providerRecoveryPolicy patched into a local snapshot.
    const admitFollowup = (fixture: Fixture) => admitExisting(fixture, first.native.normalizedSessionId);
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board", body: followupPrompt }).returning();
    expect(comment!.body).not.toContain(fact);
    const next = await seed(comment!.body, B.identity, first.native.normalizedSessionId, comment!.id);
    followupRunId = next.runId; activeRunId = next.runId;
    expect(next.lease.id).not.toBe(first.lease.id);
    expect(next.lease.providerLeaseId).toBe(allocationIds[sameBoxCold ? 0 : 1]);
    if (noBackupCleanup) {
      // Acquisition queues prepareSupersededWarmSandboxStop; this executor-only
      // fixture drives the production sweep, not an explicit/operator Retry.
      const oldLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, allocationIds[0]!));
      const oldTips = oldLeases.filter(lease => !Object.hasOwn(lease.metadata ?? {}, "reusableLeaseSuccessor"));
      expect(oldTips, "exactly one old-allocation tip before production cleanup").toHaveLength(1);
      const before = oldTips[0]!;
      expect(before.status, "production queued A's stop-only intent after admitting B").toBe("pending_cleanup");
      const intentAt = before.updatedAt.getTime();
      const retryAfterMs = Number(before.metadata?.pendingCleanupRetryAfterMs ?? 0);
      expect(Number.isFinite(retryAfterMs), "production cleanup retry-after is finite").toBe(true);
      expect(intentAt + ENVIRONMENT_CLEANUP_RETRY_MS + 1_000).toBeGreaterThan(retryAfterMs);

      if (liveBoxA) {
        expect(boxAProcesses.length, "recorded live A runner/descendant inventory").toBeGreaterThan(0);
        expect(sameBirth(spawned[0]!), "B admission did not kill A's runner").toBe(true);
        expect(sameBirth(piBirths[0]!), "B admission did not kill A's warm Pi").toBe(true);
        expect(allocations.get(allocationIds[0]!), "A is running until the production Stop").toBe("running");
      } else {
        expect(stoppedBoxAProcesses.length, "recorded old-box runner/process inventory").toBeGreaterThan(0);
        expect(stoppedBoxAProcesses.filter(sameBirth), "no old-box process remains at sweep time").toEqual([]);
        expect(allocations.get(allocationIds[0]!), "replaced box A already died; do not fake it running").toBe("stopped");
      }

      // As x-red-tl08: advance Date ONLY, around the sweep ONLY. Provider/child
      // clocks, real timers, sockets and PostgreSQL's clock are not advanced.
      const sweepCallIndex = providerCalls.length, sweepStarted = performance.now();
      let sweep: Awaited<ReturnType<typeof heartbeat.sweepPendingCleanupLeases>>;
      let sweepAt = 0, sweepFinishedAt = 0;
      try {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(intentAt + ENVIRONMENT_CLEANUP_RETRY_MS + 1_000);
        sweepAt = Date.now();
        sweep = await heartbeat.sweepPendingCleanupLeases({ backoffMs: ENVIRONMENT_CLEANUP_RETRY_MS });
        sweepFinishedAt = Date.now();
      } finally { vi.useRealTimers(); }
      const sweepRealElapsedMs = performance.now() - sweepStarted;
      const intentToSettlementMs = sweepAt - intentAt + sweepRealElapsedMs;
      const postSweepCallIndex = providerCalls.length;
      const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, before.id));
      const cleanupCalls = providerCalls.slice(sweepCallIndex, postSweepCallIndex).filter(call =>
        record(call.input).providerLeaseId === allocationIds[0]);
      const stopRpc = cleanupCalls.some(call => call.method === "environmentStopLease");
      const settledBy = stopRpc ? "environmentStopLease" : "provider_inspection";
      const receipt = record(after?.metadata?.remoteExecutionTermination);
      console.log(`E2E-PI-NO-BACKUP-CLEANUP: ${JSON.stringify({ phase: "settlement", method: "date-advance",
        case: cleanupCase, intentAt, sweepAt, sweepFinishedAt, elapsedMs: intentToSettlementMs,
        elapsedIntentToStopMs: intentToSettlementMs, sweepRealElapsedMs,
        backoffMs: ENVIRONMENT_CLEANUP_RETRY_MS, before, sweep, after, stopRpc, settledBy, receipt, cleanupCalls })}`);
      if (liveBoxA) expect(stopRpc, "live A MUST receive the production environmentStopLease RPC").toBe(true);
      noBackupStopCallIndex = stopRpc ? providerCalls.findIndex((call, index) => index >= sweepCallIndex
        && call.method === "environmentStopLease" && record(call.input).providerLeaseId === allocationIds[0]) + 1 : postSweepCallIndex;
      expect(sweepAt - intentAt, "production backoff cutoff has passed").toBeGreaterThan(ENVIRONMENT_CLEANUP_RETRY_MS);
      expect(intentToSettlementMs, "stop settles within 30 minutes of intent, including real sweep duration").toBeLessThanOrEqual(30 * 60_000);
      // sandbox-stop-and-retain.ts:380-381: stopped stop-only cleanup settles
      // released/success with failureReason null, not expired/fingerprint mismatch.
      expect(after).toMatchObject({ status: "released", cleanupStatus: "success", failureReason: null });
      expect(hasRemoteTerminationReceipt(after!), "production host-bound stopped receipt").toBe(true);
      expect(receipt).toMatchObject({ companyId, runId: before.heartbeatRunId, leaseId: before.id,
        provider: before.provider, providerLeaseId: allocationIds[0], state: "stopped" });
      // recovery.ts:1896-1910 accepts an exact stopped inspection OR dispatches
      // environmentStopLease. Only the already-dead row can use inspection;
      // sandbox-stop-and-retain.ts:380-410 must not invent a dispatch receipt.
      expect(cleanupCalls.some(call => call.method === (stopRpc ? "environmentStopLease" : "environmentInspectLease")
        && record(call.result).providerLeaseId === allocationIds[0] && record(call.result).state === "stopped"),
      "settlement has the actual provider stop or stopped-inspection response").toBe(true);
      if (stopRpc) expect(after?.metadata?.sandboxStopAndRetainReceipt).toMatchObject({
        companyId, runId: before.heartbeatRunId, leaseId: before.id, providerLeaseId: allocationIds[0], method: "environmentStopLease" });
      else expect(after?.metadata?.sandboxStopAndRetainReceipt, "inspection is not a Stop RPC dispatch receipt").toBeUndefined();

      // The opening controller actually exited above, ending its module-local
      // warm registry. At Stop settlement, independently prove the complete
      // observed A runner/descendant inventory is dead, not merely Pi's PID.
      const liveBoxAProcesses = stoppedBoxAProcesses.filter(sameBirth);
      const supervision = { scope: basename(stateRoot), controller: A.identity,
        controllerSignal: A.child.signalCode, warmEntryQuery: null,
        warmEntryEndedByControllerExit: A.child.signalCode === "SIGKILL",
        warmEntryEvidence: "opening-controller-exited; module-local registry ended",
        stoppedBoxAProcesses, liveBoxAProcesses };
      console.log(`E2E-PI-NO-BACKUP-CLEANUP: ${JSON.stringify({ case: cleanupCase, phase: "supervision-ended", supervision })}`);
      expect(stoppedBoxAProcesses.length, "Stop has an actual A process inventory").toBeGreaterThan(0);
      expect(liveBoxAProcesses, "A runner supervision and all measured processes ended at Stop").toEqual([]);
      expect(A.child.signalCode, "opening controller and its live warm registry ended").toBe("SIGKILL");
      expect(allocations.get(allocationIds[0]!)).toBe("stopped");

      // REMOTE_RUNNER_RECONNECT_GRACE_MS is 7 * 60_000 = 420_000 ms in
      // native-runner-recovery-contract.ts:1. Observe REAL time past both the
      // three-minute minimum and reconnect grace + 30 s, with a 5 s margin.
      const waitMs = Math.max(180_000, REMOTE_RUNNER_RECONNECT_GRACE_MS + 30_000) + 5_000;
      const realWaitStartedAt = new Date().toISOString(), waitStarted = performance.now();
      console.log(`E2E-PI-NO-BACKUP-CLEANUP: ${JSON.stringify({ case: cleanupCase, phase: "reconnect-observation-start",
        realWaitStartedAt, waitMs, REMOTE_RUNNER_RECONNECT_GRACE_MS })}`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      const realWaitElapsedMs = performance.now() - waitStarted;
      // Use the append-only call boundary, not timestamps: Date was restored
      // after the sweep, so later REAL timestamps can precede its advanced time.
      const forbiddenMethods = new Set(["environmentResumeLease", "environmentAcquireLease", "environmentRunnerIngressEndpoint", "environmentExecute"]);
      const callsAfterSweep = providerCalls.slice(noBackupStopCallIndex);
      const resurrectionCalls = callsAfterSweep.filter(call => forbiddenMethods.has(String(call.method))
        && [call.providerLeaseId, record(call.input).providerLeaseId, record(record(call.input).lease).providerLeaseId].includes(allocationIds[0]));
      const [stillReleased] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, before.id));
      console.log(`E2E-PI-NO-BACKUP-CLEANUP: ${JSON.stringify({ case: cleanupCase, phase: "reconnect-observation-end",
        realWaitStartedAt, realWaitFinishedAt: new Date().toISOString(), realWaitElapsedMs, waitMs,
        REMOTE_RUNNER_RECONNECT_GRACE_MS, postSweepCallIndex, callsAfterSweep, resurrectionCalls, stillReleased })}`);
      expect(realWaitElapsedMs, "real observation includes reconnect grace and the safety margin").toBeGreaterThanOrEqual(waitMs);
      expect(resurrectionCalls, "no acquire/resume/ingress/execute targets A after the production sweep").toEqual([]);
      expect(stillReleased).toMatchObject({ status: "released", cleanupStatus: "success", failureReason: null });
    }
    // CB2 16:50Z: await real settlement, not a pending claim. Only the no-backup
    // stop-only row differs: sandbox-stop-and-retain.ts:380-381 releases it.
    const expectedOldStatus = noBackupCleanup ? "released" : "expired";
    let tips: Array<typeof environmentLeases.$inferSelect> = [];
    await vi.waitFor(async () => {
      const oldLeases = await db!.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, allocationIds[0]!));
      tips = oldLeases.filter(lease => !Object.hasOwn(lease.metadata ?? {}, "reusableLeaseSuccessor"));
      expect(tips, "exactly one old-allocation tip").toHaveLength(1);
      // sandbox-stop-and-retain.ts:380-381: stop-only settlement is released.
      expect(tips[0]).toMatchObject({ status: expectedOldStatus, cleanupStatus: "success" });
    }, { timeout: 60_000, interval: 250 });
    // sandbox-stop-and-retain.ts:380-381: preserve expired for all other rows.
    expect(tips[0]).toMatchObject({ status: expectedOldStatus, cleanupStatus: "success", leasePolicy: "reuse_by_environment" });
    expect(hasRemoteTerminationReceipt(tips[0]!), "host-bound stopped receipt, not provider fixture metadata").toBe(true);
    expect(record(tips[0]!.metadata?.remoteExecutionTermination).state).toBe("stopped");
    // sandbox-stop-and-retain.ts:380-381 clears failureReason after a stop.
    expect(tips[0]!.failureReason).toBe(noBackupCleanup ? null : "lease_fingerprint_mismatch");
    const { selected, admission } = await admitFollowup(next);
    expect(selected?.id).toBe(latestSourceRunId);
    if (manifest) expect(await nativeHarnessBackupHasLaterProviderWork(db, { companyId, currentRunId: next.runId,
      normalizedSessionId: first.native.normalizedSessionId, completedAt: String(manifest.completedAt) }),
    "stale means actual durable later provider work; current/old-latest have NONE").toBe(scenario.backup === "stale");
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
      const selectedCheckpoint = record(record(selected.runnerProfileJson).sessionCheckpoint);
      expect(selectedCheckpoint.semanticResult, "G prerequisite: selected DB checkpoint owns the latest real yielded tool result").toMatchObject({
        reportedWorkDisposition: "yielded", continuation: { kind: "response_wake", ...record((laterReport ?? openingReport)?.continuation) },
      });
      if (scenario.localEnvelope === "present") expect(localSnapshot.semanticResult, "G prerequisite: warm envelope owns the latest real yielded turn").toMatchObject({
        reportedWorkDisposition: "yielded", continuation: { kind: "response_wake", ...record((laterReport ?? openingReport)?.continuation) },
      });
      expect(admission.checkpoint?.providerRecoveryPolicy, "G prerequisite: actual governed-wait admission policy")
        .toBe("allow_replacement_after_governed_wait");
      console.log(`E2E-PI-WARM-CURSOR: ${JSON.stringify({ runId: next.runId, localWarmCursor: localSnapshot.cursor ?? null,
        admittedCheckpointCursor: admission.checkpoint?.cursor ?? null })}`);
    }
    const outcome = await B.call("execute", nextOptions.input).catch(error =>
      ({ error: String(error), stack: error instanceof Error ? error.stack : null }) as Record<string, unknown>);
    if (governedWait) {
      // This witness is emitted by the child immediately before the REAL
      // executePaperclipNativeSession call, from the very target it passes.
      // Do not mistake parent-side workspace resolution for executor admission.
      expect(targets.find(target => target.runId === next.runId)?.acquisition,
        "G prerequisite: executor receives the CREATED-box acquisition required by scoped D-B6")
        .toMatchObject({ outcome: "created", providerLeaseId: allocationIds[1] });
    }
    let [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next.runId));
    // This harness drives the executor directly. Settle a refused run as the
    // heartbeat does, then drive upstream recovery and its returned deadlines.
    let sweep: unknown = null;
    if (outcome.error != null || persisted?.error != null) {
      if (persisted && !persisted.finishedAt) await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
        error: persisted.error ?? (outcome.error == null ? null : String(outcome.error)),
        errorCode: persisted.errorCode ?? (outcome.errorCode == null ? null : String(outcome.errorCode)) }).where(eq(heartbeatRuns.id, next.runId));
      [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId));
      const sweepPasses: Array<{ at: number; deferredDeadlines: number[]; result: unknown }> = [];
      const sweepStopAt = Date.now() + 2 * 60_000;
      let nextSweepAt: number | null = Date.now();
      for (let pass = 0; pass < 8 && nextSweepAt !== null && nextSweepAt <= sweepStopAt; pass += 1) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, nextSweepAt! - Date.now()) + 250));
        const at = Date.now(), deferredDeadlines: number[] = [];
        sweep = await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId,
          onDeferredDeadline: deadline => { deferredDeadlines.push(deadline); } });
        sweepPasses.push({ at, deferredDeadlines, result: sweep });
        nextSweepAt = deferredDeadlines.length ? Math.min(...deferredDeadlines) : null;
      }
      console.log(`E2E-PI-SWEEP: ${JSON.stringify({ runId: next.runId, sweep, sweepPasses })}`);
    }
    const notes = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).filter(row => row.authorType === "system");
    console.log(`E2E-PI-NOTES: ${JSON.stringify(notes.map(note => ({ id: note.id, runId: note.createdByRunId, text: note.body,
      writer: "server/src/services/native-runtime/pi-session-recovery-notice.ts:61 (writePiSessionHistoryLossNotice)",
      freshThreadWriter: "server/src/services/native-runtime/fresh-thread-stop-gate.ts:52-56 (writeFreshThreadNotice)",
      freshThreadText: note.body.includes("Starting a fresh thread") ? "server/src/services/native-runtime/fresh-thread-stop-gate.ts:15"
        : note.body.includes("stopping the earlier attempt") ? "server/src/services/native-runtime/fresh-thread-stop-gate.ts:17" : null,
      metadata: note.metadata })))}`);
    await writeFile(join(root, "notes.json"), JSON.stringify(notes, null, 2));
    const throwSite = (stack: unknown) => typeof stack === "string" ? stack.split("\n").find(line => /^\s+at /.test(line))?.trim() ?? null : null;
    console.log(`E2E-PI-OUTCOME: ${JSON.stringify({ runId: next.runId, error: persisted?.error ?? outcome.error ?? null,
      errorCode: persisted?.errorCode ?? outcome.errorCode ?? null, throwSite: throwSite(outcome.stack), outcome, events })}`);
    await writeFile(join(root, "followup-outcome.json"), JSON.stringify({ outcome, persisted, events }, null, 2));

    const followupRequests = requests.filter(request => request.runId === next.runId);
    const answered = outcome.error == null && persisted?.error == null
      && record(outcome.result).exitCode === 0 && record(outcome.result).summary === `RECALLED_${fact}`;
    const freshNotes = notes.filter(note => /starting (?:a )?fresh|stopping the earlier attempt/i.test(note.body));
    const writerOf = (note: typeof notes[number]) => String(record(note.metadata).authorizationReason ?? "").startsWith("fresh_provider_thread_pending:")
      ? "server/src/services/native-runtime/fresh-thread-stop-gate.ts:52-56 -> pi-session-recovery-notice.ts:99"
      : "server/src/services/native-runtime/pi-session-recovery-notice.ts:99 (writePiSessionHistoryLossNotice)";
    // A fresh-session answer is not a failed restore. Establish the injected
    // import premise first so a bypass is a self-explaining RED, not a false
    // claim that a deliberately faulted restore nevertheless answered.
    if (scenario.restoreFault) expect(commands.filter(command => command.activeRunId === next.runId && command.restoreFault),
      "T-164-3 prerequisite: restore was attempted and the real backup import fault was reached; a fresh-session bypass does not exercise restore failure")
      .not.toHaveLength(0);
    // Never-silent is checked BEFORE the answer, using soft assertions so the
    // same outcome shows both the refusal-note defect and lost-history defect.
    if (!answered) {
      expect.soft(notes, "any refused route emits EXACTLY ONE readable note").toHaveLength(1);
      for (const note of notes) {
        expect.soft(note.body, `readable explanation (${writerOf(note)})`).toMatch(/[A-Za-z][^\n]{30,}/);
        // RFL 16:51Z: A4's MUST is exactly ONE note with the EXISTING text, no new text (rule 12);
        // the extra 'names a person action' rule is dropped for that row.
        if (scenario.expected !== "no-history-one-note") expect.soft(note.body, "names an existing person action, not merely 'starting' or an internal error")
          .toMatch(/\bretry\b|assign this agent a new task|send (?:another|a new) message/i);
      }
    }
    // Count ALL durable runs for this conversation; opening/later-work are not
    // retries. No fourth TES-164 failure can hide behind a timeout assertion.
    const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, issueId));
    const followupRuns = allRuns.filter(run => run.id === next.runId || run.createdAt > next.run.createdAt);
    console.log(`E2E-PI-TARGET: ${JSON.stringify({ scenario, answered, containsFact: followupRequests.map(request => request.containsFact),
      runCount: followupRuns.length, freshNotes: freshNotes.map(note => ({ text: note.body, writer: writerOf(note) })),
      restoreFaultHits: commands.filter(command => command.restoreFault).length })}`);
    expect(followupRuns.length, "one run answers; a refusal must not become the TES-164 three-run loop").toBeLessThanOrEqual(1);
    expect(notes.length, "at most one person-facing note, including superseded notes").toBeLessThanOrEqual(1);
    // A fresh/stopping promise is NEVER accepted as the outcome itself.
    if (scenario.freshNoteThenAnswer && scenario.backup === "absent") {
      expect(notes, "retained plain no-backup control answers with saved history and zero system notes").toHaveLength(0);
      expect(freshNotes, "retained control emits no FRESH_THREAD_* fresh/stopping notice").toHaveLength(0);
    }
    if (freshNotes.length) expect.soft(answered, "every starting-fresh/stopping promise must be followed by an ANSWER in this run").toBe(true);

    if (scenario.expected === "no-history-one-note") {
      // RFL 16:51Z (A4 MUST): answered, history ABSENT, EXACTLY ONE note with the EXISTING text.
      expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
      expect(record(outcome.result).exitCode).toBe(0);
      expect(followupRequests, "a real follow-up model request").toHaveLength(1);
      expect(followupRequests[0], "history ABSENT in the model request").toMatchObject({ containsFact: false });
      expect(notes.map(note => note.body), "exactly the one existing missing-file note").toEqual(["My earlier conversation could not be restored: the saved Pi conversation file is missing on this computer. Starting a new one."]);
    } else if (scenario.expected === "one-refusal") {
      expect(answered, "the deliberately faulted restore must not claim an answer").toBe(false);
      expect(notes, "negative: exactly one actionable note").toHaveLength(1);
      expect(freshNotes, "a failed import must not make an unfulfilled promise").toHaveLength(0);
    } else {
      expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
      expect(outcome.result).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId, summary: `RECALLED_${fact}` });
      // HARD FAIL if the provider answered without the prior fact in its request.
      expect(followupRequests, "a real follow-up model request").toHaveLength(1);
      expect(followupRequests[0]).toMatchObject({ containsFact: true, reply: `RECALLED_${fact}` });
      if (scenario.backup === "stale") expect(followupRequests[0], "Cut B hands off later work too, not just the old checkpoint's history")
        .toMatchObject({ containsLaterFact: true });
      expect(notes.filter(note => note.body.includes(HELD_PREDECESSOR_NOTICE))).toHaveLength(0);
      const finalCheckpoint = record(record(persisted?.runnerProfileJson).sessionCheckpoint);
      if (scenario.expected === "native-answer") {
        expect(admission.checkpoint!.providerSessionId, "a real Pi provider session identity was admitted").toBeTruthy();
        expect(finalCheckpoint.providerSessionId, "same actual Pi provider session restored, not just same normalized id")
          .toBe(admission.checkpoint!.providerSessionId);
        expect(freshNotes, "current valid backup restores without a fresh-thread boundary").toHaveLength(0);
        expect(existsSync(remoteState), "verified backup materialized on allocation B").toBe(true);
      } else {
        expect(finalCheckpoint.providerSessionId, "fresh provider session; stale native state is NEVER restored")
          .not.toBe(admission.checkpoint!.providerSessionId);
        expect(followupRequests[0]).toMatchObject({ containsFact: true, handoffHasFact: true });
      }
      const sourceIds = events.map(event => event.sourceEventId).filter((id): id is string => id !== null);
      expect(new Set(sourceIds).size, "no duplicate source events").toBe(sourceIds.length);
      expect(events.filter(event => event.eventType === "turn.started")).toHaveLength(1);
      expect(events.filter(event => event.eventType === "turn.completed")).toHaveLength(1);
      // PA2 16:02Z: the follow-up's OWN accepted result (its summary, its turn) is not a replay.
      // A replay of the opening paperclip_finish is an accepted result whose summary is not this answer's.
      const acceptedSummary = (event: typeof events[number]) => record(record(record(record(event.payload).prpEvent).payload).result).summary;
      if (governedWait) expect(events.filter(event => event.eventType === "run.result.accepted"
        && acceptedSummary(event) !== record(outcome.result).summary), "opening paperclip_finish is NOT replayed").toHaveLength(0);
      expect(followupRuns.some(run => run.status === "failed"), "first run answers, no failed-run chain").toBe(false);
    }
    await nextOptions.sync.restoreWorkspace();
    if (noBackupCleanup) {
      // Include the actual history-carrying B answer, not just the quiet wait.
      const forbiddenMethods = new Set(["environmentResumeLease", "environmentAcquireLease", "environmentRunnerIngressEndpoint", "environmentExecute"]);
      const afterStop = providerCalls.slice(noBackupStopCallIndex);
      expect(afterStop.filter(call => forbiddenMethods.has(String(call.method))
        && [call.providerLeaseId, record(call.input).providerLeaseId, record(record(call.input).lease).providerLeaseId].includes(allocationIds[0])),
      "no work targets A after Stop, including B's answer and workspace restore").toEqual([]);
      const [stillReleased] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, tips[0]!.id));
      expect(stillReleased).toMatchObject({ status: "released", cleanupStatus: "success", failureReason: null });
      expect(stoppedBoxAProcesses.filter(sameBirth), "A remains dead after B's answer").toEqual([]);
    }
    stage("target assertions completed", { id: scenario.id, answered, noteCount: notes.length });
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
    // Destroy is a truthful provider STOP in this fixture (never disk deletion).
    // The production host, not fixture metadata, binds and writes its receipt.
    if (failure) await writeFile(join(root, "failure.txt"), failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "replaced-box body/cleanup failed; evidence retained");
  }
};
// One file / sequential cases: all Pi rows bind the fixed ingress port.
// Once enabled, prerequisites THROW; there are no conditional runtime skips.
for (const scenario of recoveryCases) {
  it.skipIf(!enabled)(`xr-backup ${scenario.id} [${scenario.localEnvelope}]: ${scenario.name}`,
    () => runRecoveryCase(scenario), scenario.id.startsWith("NOTE-NO-BACKUP") ? 1_200_000 : 600_000);
}
