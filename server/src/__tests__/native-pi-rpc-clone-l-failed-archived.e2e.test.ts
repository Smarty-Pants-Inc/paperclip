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
  agents, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { PAPERCLIP_RUNNER_INGRESS_PORT, type RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import {
  canonicalNativeRuntimeContextDigest, configuredEnvironmentProjection,
} from "../vendor/paperclip-runner/index.js";
import { registerLocalRuntimeApiServer } from "../runtime-api.js";
import { environmentService } from "../services/environments.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { closeWarmNativeSessionsForEnvironment, executePaperclipNativeSession, cancelNativeSession, reserveWarmNativeInstructionDirectory,
  type NativeInstructionWorkingCopy } from "../services/native-runtime/native-session-executor.js";
import { currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import {
  buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget,
} from "../services/native-runtime/native-session-resume.js";
import { materializeAsset } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { spawn, type ChildProcess } from "node:child_process";

// Keep reason: crosses real DB admission -> real remote runnerd -> real proxy ->
// Pi 1.5.2 -> its own JSONL. The only scripted provider is loopback Messages.
// This is the SAME simulated allocation resumed under a NEW environment lease,
// not a claim that Boat/SSH, a destroyed VM, or backup relocation was qualified.
// A lease-bound command runner is invalidated only after measured process exit;
// closing the PRP transport by itself is never called sandbox retirement.
// Only the allocation driver is simulated: Stop, execution, finalization,
// checkpoint publication and receipt persistence remain product code.
const allocation = vi.hoisted(() => ({ drivers: undefined as import("../services/environment-runtime.js").EnvironmentRuntimeDriver[] | undefined }));
vi.mock("../services/environment-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-runtime.js")>();
  return { ...actual, environmentRuntimeService: (db: Parameters<typeof actual.environmentRuntimeService>[0],
    options: Parameters<typeof actual.environmentRuntimeService>[1]) => actual.environmentRuntimeService(db,
      { ...options, drivers: allocation.drivers ?? options?.drivers }) };
});
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
function ownedDescendant(runner: Birth, kind: "pi" | "sleep"): Birth | null {
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
    if (kind === "sleep" ? comm === "sleep" : comm === "pi" || current.command.includes("--mode rpc") && current.command.includes("cli.js")) return current;
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

// Clone L (RFL C-matrix J2), the exact production order: a FAILED run on the
// conversation's box, then the box ARCHIVED, then the next plain message
// RESUMES the box from archived and a fresh Runner meets the stale root. The
// message must be answered in the same conversation with history (or exactly
// one durable notice when history is unrecoverable), with one live Runner and
// never the PRP identity error. Only the allocation is simulated: the archive
// ends every process on the box, as a provider stop does.
// "suspended": Core closes the failed turn's warm Runner (it suspends) before
// the archive (the normal order). "unsuspended": the archive kills the Runner
// and Pi right after the provider failure, before Core's close can suspend it,
// so the stale root keeps an unsuspended owner. Counterexamples on that
// unsuspended root: "live-owner" (the box's launch marker names a live process
// of the same generation: a same-machine resume) and "other-box" (the failed
// run's lease names another sandbox): neither may retire the owner; the
// conversation is held with exactly one notice and no second Runner.
// Every variant runs a MANAGED-instructions agent by default (an agent with
// instructionsBundleMode "managed", as d981): each turn runs with a registered
// agent-files working copy, and the next turn first reserves the warm owner's
// instruction directory exactly as heartbeat/instruction-working-copy.ts does
// (reserveWarmNativeInstructionDirectory), which marks the warm owner as
// preparing for that run. "unmanaged-*" runs the same shape without it. "idle-loss": the warm
// owner's Runner and Pi die while idle on a still-running box, then a plain
// message. "idle-archived": the box is archived while the warm owner is idle
// (no idle close ran; every process on it ends and its lease can run nothing
// more), then a plain message resumes it from archived.
it.skipIf(!enabled).each(["suspended", "unsuspended", "live-owner", "other-box", "escape", "idle-loss", "idle-archived",
  "unmanaged-suspended", "unmanaged-unsuspended", "unmanaged-idle-loss", "unmanaged-idle-archived"] as const)("Clone L: a failed run, then the box archived (%s), then a plain message", async variant => {
  const managed = !variant.startsWith("unmanaged-");
  const ownerAtArchive = variant.replace("unmanaged-", "") as "suspended" | "unsuspended" | "live-owner" | "other-box" | "escape" | "idle-loss" | "idle-archived";
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
  const stage = (name: string, detail: unknown = {}) => { stages.push({ at: new Date().toISOString(), name, detail }); console.log(`[pi-lease] ${name}`); };
  const runtimeRequests: string[] = [];
  // RFL JUDGE: hold one model response mid-stream so Stop lands while the turn is really active.
  const judgeHold = { active: false, inFlight: 0, closed: 0 };
  const providerFailure = { active: false, answered: 0, killOwnerAfterMs: undefined as number | undefined };
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
        if (providerFailure.active) {
          // A provider failure mid-turn after the Runner launched: a
          // non-retryable error from the model API.
          providerFailure.answered++;
          requests.push({ path: req.url, request: parsed, historyHasFact, latestPromptHasFact, reply: "PROVIDER_FAILURE", failed: true });
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error",
            error: { type: "invalid_request_error", message: "clone-l scripted provider failure" } }));
          if (providerFailure.killOwnerAfterMs !== undefined && providerFailure.answered === 1) {
            // The box is archived right after the failure, before Core's close
            // can suspend the owner: every process on it ends at once.
            setTimeout(() => {
              for (const owned of spawned) {
                if (!sameBirth(owned)) continue;
                const ownedPi = ownedDescendant(owned, "pi");
                try { if (ownedPi && sameBirth(ownedPi)) process.kill(ownedPi.pid, "SIGKILL"); } catch { /* already gone */ }
                try { process.kill(owned.pid, "SIGKILL"); } catch { /* already gone */ }
                stage("archive killed the failed turn's owner before suspension", { runner: owned, pi: ownedPi });
              }
            }, providerFailure.killOwnerAfterMs);
          }
          return;
        }
        const reply = first ? fact : historyHasFact ? `RECALLED_${fact}` : "HISTORY_LOST";
        requests.push({ path: req.url, request: parsed, historyHasFact, latestPromptHasFact, reply });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
        const finish = () => {
          emit("content_block_stop", { index: 0 });
          emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
          emit("message_stop", {}); res.end();
        };
        if (judgeHold.active) { judgeHold.active = false; judgeHold.inFlight++; requests.at(-1)!.heldMidTurn = true;
          finishHeldResponse = finish; res.on("close", () => { judgeHold.closed++; }); return; }
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
  const otherBoxLeaseId = `owned-simulated-allocation-other-${randomUUID()}`;
  let decoy: ChildProcess | undefined;
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
    const seed = async (prompt: string, normalizedSessionId?: string, wakeCommentId?: string, previousLeaseId?: string, box = providerLeaseId,
      who: { agentId: string; issueId: string; issue: typeof issue } = { agentId, issueId, issue }) => {
      const { agentId: whoAgentId, issueId: whoIssueId, issue: whoIssue } = who;
      const runId = randomUUID();
      const [run] = await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId: whoAgentId, status: "running", runtimeMode: "native",
        nativeIssueId: whoIssueId, ...(normalizedSessionId ? { nativeSessionId: normalizedSessionId } : {}),
        contextSnapshot: { issueId: whoIssueId, ...(wakeCommentId ? { wakeCommentId } : {}) } }).returning();
      const lease = await environmentsService.acquireLease({ companyId, environmentId, heartbeatRunId: runId, issueId: whoIssueId,
        provider: "boat", providerLeaseId: box, leasePolicy: "reuse_by_environment", metadata: { remoteCwd, agentId: whoAgentId, pluginId: "fixture-allocation-driver" },
        ...(previousLeaseId && box === providerLeaseId ? { replacesReusableLeaseId: previousLeaseId } : {}) });
      const native = await prepareNativeHeartbeatRun({ db: db!, run: run!, issue: whoIssue!, environmentLeaseId: lease.id });
      await db!.insert(nativeRunFinalizations).values({ companyId, issueId: whoIssueId, runId, phase: "observed", controllerBootId: controller.bootId,
        controllerGeneration: 0, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt,
        leaseOwner: null, leaseExpiresAt: null });
      await db!.update(issues).set({ executionRunId: runId }).where(eq(issues.id, whoIssueId));
      const [contract] = await db!.select().from(completionContracts).where(eq(completionContracts.issueId, whoIssueId));
      const execution = buildNativeExecutionInput({ companyId, agentId: whoAgentId, runId, provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh",
        issue: { id: whoIssueId, identifier: "PIL-1", title: whoIssue!.title, description: null, workMode: "standard" }, taskPrompt: prompt,
        workspace: { id: workspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: native.normalizedSessionId,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 600_000 }, runtimeContext,
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
    const executionOptions = async (fixture: Fixture, outcome: "created" | "resumed", resumedFromArchived = false) => {
      // Honest provider ingress: exactly the listener path the caller requests
      // (runnerd's --listen-path, which a warm attachment switches), bound to
      // this run's lease.
      const endpoint = async (request?: { leaseId: string; port: number; path: string }): Promise<RunnerIngressEndpoint> => {
        if (!leaseActive.get(fixture.lease.id)) throw new Error("retired environment lease cannot obtain ingress");
        const path = request?.path ?? `/api/runner/v1/connect/${fixture.runId}`;
        previewBindings.set(path, fixture.lease.id);
        return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
          secretHeaders: [{ name: "X-Owned-Lease", value: fixture.lease.id }], generation: fixture.lease.id,
          refresh: () => endpoint(request), close: async () => {} };
      };
      const target: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "boat", environmentId,
        leaseId: fixture.lease.id, remoteCwd, reusableLeaseConfigured: true, runner: commandRunner(fixture.lease.id),
        effectiveCapabilities: { runnerWebSocketIngress: true, reusableLeases: true, independentControlCommands: true,
          nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false, incrementalSessionOutput: false,
          concurrentSyncOperations: false, duplexCommandStream: false }, getRunnerIngressEndpoint: endpoint,
        // Boat reports the pre-resume state; archived is its API name for stopped.
        sandboxLeaseAcquisition: { outcome, providerLeaseId: fixture.lease.providerLeaseId ?? providerLeaseId,
          ...(resumedFromArchived ? { resumedFromState: "archived", restarted: true as const } : {}) } } as AdapterExecutionTarget;
      return { db: db!, execution: fixture.execution, runnerInstanceId: fixture.native.runnerInstanceId,
        durableEnvironmentLeaseId: fixture.lease.id, controllerPersistence: { bootId: controller.bootId }, runnerIngressAuthorized: true,
        runnerExecutionTarget: target, runnerRemoteBinaryPath: runnerBinary, runnerRemoteProviderPackPath: providerPack,
        // The projection admits ordinary configured variables only. Pi home,
        // provider routing and raw trace are generated controller-owned keys;
        // placing them inside the projection silently removes them.
        runnerEnvironment: { PATH: process.env.PATH, ...configuredEnvironmentProjection({ PI_OFFLINE: "1", TMPDIR: process.env.TMPDIR! }),
          PI_CODING_AGENT_DIR: agentHome, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none",
          PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${modelAddress.port}`, PAPERCLIP_PROVIDER_TRACE_PATH: join(root, `${fixture.runId}.provider-trace.jsonl`) },
        onSpawn: async (meta: { pid: number }) => { const owned = birth(meta.pid); if (owned) { spawned.push(owned); stage("real runner spawned", owned); } else stage("transient spawn callback", meta); },
        onLog: async (stream: "stdout" | "stderr", text: string) => { stages.push({ stream, text }); await appendFile(join(root, "native.log"), `${stream}: ${text}`); } };
    };

    const first = await seed("Invent a private fact, say it once, and retain it only in your assistant history.");
    allocation.drivers = [{ driver: "sandbox",
      acquireRunLease: async () => { throw new Error("this proof acquires no allocation"); },
      realizeWorkspace: async () => ({ cwd: remoteCwd }),
      releaseRunLease: async () => { throw new Error("this proof releases no allocation"); },
      resolveCapabilities: async () => ({ nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false,
        incrementalSessionOutput: false, concurrentSyncOperations: false, independentControlCommands: true,
        runnerWebSocketIngress: true, reusableLeases: true, duplexCommandStream: false }) }];
    const remoteSessionRoot = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"));
    // The managed instruction copy, as heartbeat registers it for each run.
    const instructionRoot = join(root, "managed-instructions");
    let lastManagedRunId: string | undefined;
    const managedReservations: Array<Record<string, unknown>> = [];
    const managedCopy = (runId: string): NativeInstructionWorkingCopy => ({ runId, preparationKey: "managed-fixture", root: instructionRoot,
      checkpointWarm: async () => true, hasChanges: async () => false, collectStopped: async () => {} });
    const run = async (fixture: Fixture, outcome: "created" | "resumed", resumedFromArchived = false, boundMs?: number) => {
      activeRunId = fixture.runId;
      const options = await executionOptions(fixture, outcome, resumedFromArchived);
      let release: (() => Promise<void>) | undefined;
      if (managed && fixture.execution.binding.agentId === agentId && fixture.execution.binding.issueId === issueId) {
        if (lastManagedRunId) {
          const reservation = await reserveWarmNativeInstructionDirectory({ companyId, agentId, previousRunId: lastManagedRunId,
            runId: fixture.runId, target: options.runnerExecutionTarget, canReuse: async () => true });
          managedReservations.push({ runId: fixture.runId, previousRunId: lastManagedRunId, reserved: reservation !== null });
          stage("managed instruction reservation", managedReservations.at(-1));
          if (reservation) { reservation.adopt(instructionRoot, async () => {}); release = reservation.release; }
        }
        lastManagedRunId = fixture.runId;
      }
      const executing = executePaperclipNativeSession({ ...options, useRunnerd: true, conversationMode: true,
        ...(managed ? { instructionWorkingCopy: managedCopy(fixture.runId) } : {}) }).then(
        value => ({ result: value }), error => ({ error: String(error) }));
      const result = boundMs === undefined ? await executing : await Promise.race([executing,
        new Promise<{ hung: true }>(done => setTimeout(() => done({ hung: true }), boundMs))]);
      if ("hung" in result) {
        stage("turn did not finish within its bound", { runId: fixture.runId, boundMs });
        await cancelNativeSession(fixture.runId, "clone-l bound", { db: db! }).catch(() => undefined);
        await Promise.race([executing, new Promise(done => setTimeout(done, 30_000))]);
      }
      await release?.().catch(() => undefined);
      activeRunId = undefined;
      return result;
    };
    // The next message on the same conversation: a new run and a new lease on the same box.
    const follow = async (previous: Fixture, body: string, box = providerLeaseId) => {
      const [comment] = await db!.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board", body }).returning();
      const next = await seed(comment!.body, first.native.normalizedSessionId, comment!.id, previous.lease.id, box);
      const selected = await findNativeSessionResumeRun(db!, { companyId, agentId, issueId, normalizedSessionId: first.native.normalizedSessionId,
        currentRunId: next.runId, beforeCreatedAt: next.run.createdAt });
      stage("resume run selected", { next: next.runId, selected: selected?.id ?? null, status: selected?.status ?? null });
      if (selected?.runnerInstanceId) {
        next.native.runnerInstanceId = selected.runnerInstanceId;
        await db!.update(heartbeatRuns).set({ runnerInstanceId: next.native.runnerInstanceId }).where(eq(heartbeatRuns.id, next.runId));
      }
      const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected, normalizedSessionId: first.native.normalizedSessionId,
        executionTargetKind: "remote", buildExecution: () => next.execution });
      if (admission.checkpoint) await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ sessionCheckpoint: admission.checkpoint })}::jsonb` }).where(eq(heartbeatRuns.id, next.runId));
      return next;
    };

    // Turn 1: the conversation is established on a new box; its warm Runner stays.
    const firstOutcome = await run(first, "created");
    await writeFile(join(root, "turn-1-outcome.json"), JSON.stringify(firstOutcome, null, 2));
    expect(record(firstOutcome).error, JSON.stringify(firstOutcome)).toBeUndefined();
    const runner = spawned.at(-1)!; const pi = ownedDescendant(runner, "pi");
    expect(pi, "the warm Runner and its Pi stay alive after turn 1").not.toBeNull();
    processPairs.push({ runner, pi: pi! });
    const originalFile = sessionFile(pi!);
    expect(await readFile(originalFile, "utf8")).toContain(fact);
    // The heartbeat service settles the successful turn around the executor.
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, first.runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first.runId));
    await environmentsService.releaseLease(first.lease.id, "released");
    stage("turn 1 succeeded", { runId: first.runId, runner, pi });

    if (ownerAtArchive === "idle-loss" || ownerAtArchive === "idle-archived") {
      // The warm owner's Runner and Pi die while idle; "idle-loss" keeps the
      // box running, "idle-archived" archives it first (its lease runs nothing more).
      if (ownerAtArchive === "idle-archived") leaseActive.set(first.lease.id, false);
      for (const owned of spawned) {
        if (!sameBirth(owned)) continue;
        const ownedPi = ownedDescendant(owned, "pi");
        try { if (ownedPi && sameBirth(ownedPi)) process.kill(ownedPi.pid, "SIGKILL"); } catch { /* already gone */ }
        try { process.kill(owned.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await vi.waitFor(() => { expect(spawned.filter(sameBirth)).toEqual([]); }, { timeout: 15_000, interval: 100 });
      stage(ownerAtArchive === "idle-archived" ? "box archived while the warm owner was idle" : "warm owner died while idle; the box keeps running", { runner, pi });
      await new Promise(resolve => setTimeout(resolve, 2_000));
      const before = commands.length, spawnedBeforeIdle = spawned.length;
      const next = await follow(first, "Recall the private fact from your own earlier assistant history. Do not invent it.");
      const outcome = await run(next, "resumed", ownerAtArchive === "idle-archived", 120_000);
      await writeFile(join(root, "turn-2-outcome.json"), JSON.stringify(outcome, null, 2));
      const probes = commands.slice(before).filter(entry =>
        (record(entry).args as string[] | undefined)?.[2] === "paperclip-runner-generation-check").map(entry => record(entry).exitCode);
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next.runId));
      const identitySpan = JSON.stringify(events).includes("warm_owner_identity_check") || JSON.stringify(stages).includes("warm_owner_identity_check");
      const held = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
        .filter(comment => String(record(comment.metadata).authorizationReason ?? "").startsWith("native_prior_owner_held:"));
      const summary = record(record(outcome).result).summary;
      // The next message after a failed one: the heartbeat marks the failed
      // run failed and releases its lease; the person sends another message.
      let second: Record<string, unknown> | undefined;
      if (record(outcome).error !== undefined || "hung" in outcome) {
        await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed",
          error: String(record(outcome).error ?? "hung") }).where(eq(heartbeatRuns.id, next.runId));
        await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
          .where(eq(nativeRunFinalizations.runId, next.runId));
        leaseActive.set(next.lease.id, false);
        await environmentsService.releaseLease(next.lease.id, "released").catch(error => stage("second-message lease release", String(error)));
        const before2 = commands.length;
        const again = await follow(next, "Are you there? Recall the private fact from your own earlier assistant history.");
        const againOutcome = await run(again, "resumed", ownerAtArchive === "idle-archived", 120_000);
        await writeFile(join(root, "turn-3-outcome.json"), JSON.stringify(againOutcome, null, 2));
        const heldAgain = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
          .filter(comment => String(record(comment.metadata).authorizationReason ?? "").startsWith("native_prior_owner_held:"));
        second = { hung: "hung" in againOutcome, error: record(againOutcome).error ?? null,
          exitCode: record(record(againOutcome).result).exitCode ?? null,
          recall: record(record(againOutcome).result).summary === `RECALLED_${fact}`,
          probes: commands.slice(before2).filter(entry =>
            (record(entry).args as string[] | undefined)?.[2] === "paperclip-runner-generation-check").map(entry => record(entry).exitCode),
          notices: heldAgain.length };
        stage("second message finding", second);
      }
      const finding = { variant, managed, reservations: managedReservations, hung: "hung" in outcome, error: record(outcome).error ?? null,
        exitCode: record(record(outcome).result).exitCode ?? null, recall: summary === `RECALLED_${fact}`, probes, identitySpan,
        reuse: events.filter(event => event.eventType === "run.startup.reuse").map(event => event.payload),
        newRunner: spawned.length > spawnedBeforeIdle, notices: held.length, second };
      stage("idle-loss finding", finding);
      await writeFile(join(root, "proof.json"), JSON.stringify(finding, null, 2));
      // A message after a failed one is never a silent error: it continues
      // or carries exactly one held notice. Soft, so the first message's
      // verdict below is reported in the same run.
      if (second) expect.soft(second.recall === true || second.notices === 1,
        `the next message recalls or carries exactly one held notice: ${JSON.stringify(finding)}`).toBe(true);
      expect.soft(finding.hung, `the next message never hangs: ${JSON.stringify(finding)}`).toBe(false);
      expect.soft(finding.recall || held.length === 1, `recall or exactly one notice: ${JSON.stringify(finding)}`).toBe(true);
      return;
    }

    // Turn 2 FAILS after its Runner launched: the provider rejects the turn mid-run.
    const failed = await follow(first, "Turn 2: continue the work.");
    providerFailure.active = true;
    if (ownerAtArchive !== "suspended") providerFailure.killOwnerAfterMs = 150;
    const failedOutcome = await run(failed, "resumed");
    providerFailure.active = false; providerFailure.killOwnerAfterMs = undefined;
    await writeFile(join(root, "turn-2-outcome.json"), JSON.stringify(failedOutcome, null, 2));
    expect(providerFailure.answered, "the turn reached the provider through a launched Runner").toBeGreaterThan(0);
    const failedResult = record(record(failedOutcome).result);
    expect(record(failedOutcome).error !== undefined || failedResult.exitCode !== 0, `turn 2 must fail: ${JSON.stringify(failedOutcome)}`).toBe(true);
    // The product's own failure settlement for the run (the executor writes it
    // when it observes the failure; the heartbeat marks the run failed).
    const [failedRunRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed.runId));
    const [failedOwnerRow] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, failed.runId));
    stage("turn 2 failed: product settlement", { run: { status: failedRunRow?.status, errorCode: failedRunRow?.errorCode },
      owner: { phase: failedOwnerRow?.phase, resultId: failedOwnerRow?.resultId ?? null, failureCode: failedOwnerRow?.failureCode, leaseOwner: failedOwnerRow?.leaseOwner } });
    // The heartbeat service then settles the failed run around the executor, as
    // for turn 1: the run fails, and the workspace finalization of the owner's
    // committed failure result completes (workspace_finalizing -> committed).
    if (failedRunRow?.status === "running") {
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
        errorCode: failedOwnerRow?.failureCode ?? "native_session_failed" }).where(eq(heartbeatRuns.id, failed.runId));
    }
    if (failedOwnerRow?.phase === "workspace_finalizing" && failedOwnerRow.resultId) {
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, failed.runId));
    }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failed.runId)))[0]?.status, "turn 2's run is failed").toBe("failed");

    // The box is archived after the failed run: the provider stops it and every
    // process on it ends (a Runner Core still held dies unsuspended).
    for (const owned of spawned) {
      if (!sameBirth(owned)) continue;
      const ownedPi = ownedDescendant(owned, "pi");
      try { if (ownedPi && sameBirth(ownedPi)) process.kill(ownedPi.pid, "SIGKILL"); } catch { /* already gone */ }
      try { process.kill(owned.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await vi.waitFor(() => { expect(spawned.filter(sameBirth)).toEqual([]); }, { timeout: 15_000, interval: 100 });
    for (const lease of [first.lease, failed.lease]) leaseActive.set(lease.id, false);
    // The provider confirms the stop only after the box's processes ended; the
    // failed run's lease is retired with that stopped termination receipt.
    const archiveReceipt = remoteTerminationReceipt(failed.lease, { providerLeaseId: failed.lease.providerLeaseId!, state: "stopped" });
    expect(archiveReceipt).toBeDefined();
    await environmentsService.releaseLease(failed.lease.id, "released", { cleanupStatus: "success", remoteExecutionTermination: archiveReceipt })
      .catch(error => stage("failed lease release", String(error)));
    const staleRunnerState = await readFile(join(remoteSessionRoot, "runner", "runner-state.json"), "utf8").then(JSON.parse, () => null);
    stage("box archived after the failed run", { runnerLifecycle: staleRunnerState?.lifecycle ?? null, runnerRun: staleRunnerState?.runId ?? null });
    // The variant's precondition: the stale root holds the owner as left at the archive.
    if (ownerAtArchive === "suspended") expect(staleRunnerState?.lifecycle).toBe("suspended");
    else expect(staleRunnerState?.lifecycle, "the archive left the owner unsuspended").not.toBe("suspended");
    if (ownerAtArchive === "live-owner") {
      // A same-machine resume: the box's launch marker names a live process
      // of this runner instance with its real start generation.
      const markerPath = join(remoteSessionRoot, "runner", "runner-process.identity");
      const [nonce, , startedAt, runnerInstanceId] = (await readFile(markerPath, "utf8")).split("\n");
      decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600_000)", "--", "--runner-id", runnerInstanceId!], { stdio: "ignore" });
      await new Promise(resolve => decoy!.once("spawn", resolve));
      const stat = readFileSync(`/proc/${decoy.pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      await writeFile(markerPath, `${nonce}\n${decoy.pid}\n${startedAt}\n${runnerInstanceId}\nlinux:${boot}:${ticks}\n`);
      stage("live same-generation process named by the box's marker", { pid: decoy.pid });
    }
    const commandsBefore = commands.length;

    // Turn 3: a plain message resumes the same box from archived; a fresh Runner meets the stale root.
    const spawnedBefore = spawned.length;
    const plain = await follow(failed, "Recall the private fact from your own earlier assistant history. Do not invent it.",
      ownerAtArchive === "other-box" ? otherBoxLeaseId : providerLeaseId);
    const plainOutcome = await run(plain, "resumed", true);
    await writeFile(join(root, "turn-3-outcome.json"), JSON.stringify(plainOutcome, null, 2));
    const evidenceText = JSON.stringify(plainOutcome) + JSON.stringify(stages)
      + JSON.stringify(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, plain.runId)));
    expect(evidenceText, "the PRP identity error never appears").not.toContain("does not match the requested PRP identity");
    const turn3Probes = commands.slice(commandsBefore).filter(entry =>
      (record(entry).args as string[] | undefined)?.[2] === "paperclip-runner-generation-check").map(entry => record(entry).exitCode);
    if (ownerAtArchive === "escape") {
      // Day-one escape on a conversation that is held: a NEW TASK assigned to
      // the same agent is its own conversation (its own reusable scope, so its
      // own box) and must answer.
      stage("escape: turn 3 outcome", { error: record(plainOutcome).error ?? null, summary: record(record(plainOutcome).result).summary ?? null });
      const issue2Id = randomUUID();
      const [issue2] = await db.insert(issues).values({ id: issue2Id, companyId, title: "A new task", description: null,
        assigneeAgentId: agentId, status: "in_progress" }).returning();
      const fresh = await seed("A new task: reply.", undefined, undefined, undefined, otherBoxLeaseId, { agentId, issueId: issue2Id, issue: issue2! });
      const freshOutcome = await run(fresh, "created");
      const escape = { turn3: record(plainOutcome).error ?? record(record(plainOutcome).result).summary,
        newTask: record(freshOutcome).error ?? record(record(freshOutcome).result) };
      stage("escape: a new task on the same agent", escape.newTask);
      await writeFile(join(root, "escapes.json"), JSON.stringify(escape, null, 2));
      expect(String(record(plainOutcome).error ?? ""), "the old conversation is stuck").toContain("retained_sandbox_binding");
      expect(record(freshOutcome).error, "a new task answers").toBeUndefined();
      expect(record(record(freshOutcome).result).exitCode, "a new task answers").toBe(0);
      return;
    }
    if (ownerAtArchive === "live-owner" || ownerAtArchive === "other-box" || ownerAtArchive === "unsuspended") {
      stage("held finding", { variant, managed, reservations: managedReservations, error: record(plainOutcome).error ?? null, turn3Probes,
        identitySpan: JSON.stringify(stages).includes("warm_owner_identity_check") });
      // Held, visibly: one durable notice, no second Runner. Tonight's ruling
      // (P1 off): a failed predecessor that started provider work stays held
      // even when its Runner is proven gone; it is never a silent stuck loop.
      expect(String(record(plainOutcome).error ?? ""), "the owner is held").toMatch(/retained_sandbox_binding|prior_owner_/);
      const held = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
        .filter(comment => String(record(comment.metadata).authorizationReason ?? "").startsWith("native_prior_owner_held:"));
      expect(held, "exactly one durable notice for the held conversation").toHaveLength(1);
      expect(spawned.length, "no second Runner was launched").toBe(spawnedBefore);
      if (ownerAtArchive === "live-owner") expect(turn3Probes, "the marker probe found the owner alive").toEqual([0]);
      else if (ownerAtArchive === "other-box") expect(turn3Probes, "no probe of this box decides another box's owner").toEqual([]);
      else expect(turn3Probes, "the marker probe proved the owner's process gone").toContain(45);
      expect(held[0]!.body).toBe("Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.");
      // A second message on the held conversation adds no second notice, even
      // after the heartbeat marks the refused run failed.
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "native_session_failed" })
        .where(eq(heartbeatRuns.id, plain.runId));
      leaseActive.set(plain.lease.id, false);
      await environmentsService.releaseLease(plain.lease.id, "released");
      const again = await follow(plain, "Are you there?", plain.lease.providerLeaseId ?? providerLeaseId);
      const againOutcome = await run(again, "resumed", true);
      expect(String(record(againOutcome).error ?? ""), "the conversation stays held").toMatch(/retained_sandbox_binding|prior_owner_/);
      const heldAgain = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
        .filter(comment => String(record(comment.metadata).authorizationReason ?? "").startsWith("native_prior_owner_held:"));
      expect(heldAgain, "still exactly one notice").toHaveLength(1);
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "native_session_failed" })
        .where(eq(heartbeatRuns.id, again.runId));
      leaseActive.set(again.lease.id, false);
      await environmentsService.releaseLease(again.lease.id, "released");
      // The escape: a new task assigned to the same agent answers.
      const escapeIssueId = randomUUID();
      const [escapeIssue] = await db.insert(issues).values({ id: escapeIssueId, companyId, title: "A new task", description: null,
        assigneeAgentId: agentId, status: "in_progress" }).returning();
      const escapeRun = await seed("A new task: reply.", undefined, undefined, undefined, `${otherBoxLeaseId}-escape`,
        { agentId, issueId: escapeIssueId, issue: escapeIssue! });
      const escapeOutcome = await run(escapeRun, "created");
      expect(record(escapeOutcome).error, "a new task answers").toBeUndefined();
      expect(record(record(escapeOutcome).result).exitCode).toBe(0);
      stage(`GREEN: the unproven owner was held with one notice (${ownerAtArchive})`, { turn3Probes });
      await writeFile(join(root, "proof.json"), JSON.stringify({ variant, managed, reservations: managedReservations, ownerAtArchive, held: true, notices: held.length, turn3Probes,
        error: record(plainOutcome).error, requests: requests.map(entry => entry.reply) }, null, 2));
      return;
    }
    expect(record(plainOutcome).error, `turn 3: ${JSON.stringify(plainOutcome)}`).toBeUndefined();
    const plainResult = record(record(plainOutcome).result);
    expect(plainResult).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId });
    const notices = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(comment => /^(pi_session_file_missing|pi_session_file_invalid)/.test(String(record(comment.metadata).authorizationReason ?? "")));
    const answered = requests.filter(entry => !entry.failed).at(-1)!;
    if (plainResult.summary === `RECALLED_${fact}`) {
      expect(answered).toMatchObject({ historyHasFact: true, latestPromptHasFact: false, reply: `RECALLED_${fact}` });
      expect(notices, "recall with no history-loss notice").toEqual([]);
    } else {
      expect(notices, "an unrecoverable history gets exactly one durable notice").toHaveLength(1);
    }
    // The proof that retired the stale owner, by name.
    const probes = turn3Probes;
    const retirement = stages.map(entry => String(record(entry).text ?? "")).filter(text =>
      /not retired|retiring its runner|fresh PRP run authority|starting a new runner/.test(text));
    stage("stale owner retirement proof", { ownerAtArchive, generationProbeExitCodes: probes, retirement });
    // Runner ownership: exactly one new live Runner; the old one is gone.
    const liveAfter = spawned.filter(sameBirth);
    expect(new Set(liveAfter.map(entry => entry.pid)).size, "exactly one live Runner after the plain message").toBe(1);
    expect(spawned.length, "a fresh Runner was launched").toBeGreaterThan(spawnedBefore);
    expect(sameBirth(runner)).toBe(false);
    const epochs = readdirSync(join(remoteSessionRoot, "authority-epochs")).filter(name => name.startsWith("epoch-"));
    await writeFile(join(root, "proof.json"), JSON.stringify({ scope: "Clone L order through executePaperclipNativeSession: turn 1 ok, turn 2 provider failure, box archived (all processes end), turn 3 plain message resumed from archived; real runnerd/proxy/Pi; simulated allocation and loopback model",
      ownerAtArchive, staleRunnerLifecycle: staleRunnerState?.lifecycle ?? null, generationProbeExitCodes: probes,
      runs: { first: first.runId, failed: failed.runId, plain: plain.runId }, failedRun: failedRunRow?.status, notices: notices.length,
      recall: plainResult.summary === `RECALLED_${fact}`, requests: requests.map(entry => entry.reply), processPairs, liveAfter, epochs }, null, 2));
    stage(`GREEN: Clone L order answered in the same conversation (${ownerAtArchive})`, { epochs, notices: notices.length });
    await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "clone-l proof complete" });
  } catch (error) { failure = error; throw error; }
  finally {
    const errors: unknown[] = [];
    try { decoy?.kill("SIGKILL"); } catch { /* already gone */ }
    if (activeRunId && !earlyOutcome) try { await cancelNativeSession(activeRunId, "test cleanup", { db: db! }); } catch (error) { errors.push(error); }
    try { await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "test cleanup" }); } catch (error) { errors.push(error); }
    finishHeldResponse?.();
    if (execution) await execution;
    await app?.locals.paperclipShutdown?.();
    allocation.drivers = undefined;
    if (http?.listening) { http.closeAllConnections(); await new Promise<void>(done => http!.close(() => done())); }
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
    await writeFile(join(root, "processes.json"), JSON.stringify({ spawned, processPairs, remainingOwned: spawned.filter(sameBirth), runtimeRequests }, null, 2));
    console.log(`Pi sandbox lease evidence retained: ${root}`);
    if (spawned.some(sameBirth) || processPairs.some(pair => sameBirth(pair.pi))) errors.push(new Error("owned runner/Pi still alive after cleanup"));
    if (failure) await writeFile(join(root, "failure.txt"), failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "lease proof body/cleanup failed; evidence retained");
  }
}, 600_000);
