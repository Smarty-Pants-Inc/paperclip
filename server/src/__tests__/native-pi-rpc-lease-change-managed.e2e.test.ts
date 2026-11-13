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
  agents, authUsers, companyMemberships, principalPermissionGrants, closeRegisteredClients, companies, completionContracts, createDb, environmentLeases,
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
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import type { AdapterRuntimeEvent } from "../adapters/index.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { reserveWarmNativeInstructionDirectory, closeWarmNativeSessionsForEnvironment, executePaperclipNativeSession, cancelNativeSession } from "../services/native-runtime/native-session-executor.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
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
// Only the allocation driver is simulated: Stop, execution, finalization,
// checkpoint publication and receipt persistence remain product code.
// Core's own idle timer closes the warm Runner between turns, except in the
// connected case, which must reuse it without a generation-probe exec.
const WARM_IDLE_MS = 4_000;
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
function ownedDescendants(runner: Birth): Birth[] {
  const processes = new Map<number, Birth>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const current = birth(Number(name)); if (current) processes.set(current.pid, current);
  }
  const descendants: Birth[] = [];
  for (const current of processes.values()) {
    let parent = current.ppid;
    const seen = new Set<number>();
    while (parent !== runner.pid && processes.has(parent) && !seen.has(parent)) {
      seen.add(parent); parent = processes.get(parent)!.ppid;
    }
    if (parent === runner.pid) descendants.push(current);
  }
  return descendants;
}
function ownedDescendant(runner: Birth, kind: "pi" | "sleep"): Birth | null {
  return ownedDescendants(runner).find(current => {
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
it.skipIf(!enabled).each(["idle", "archived", "stopped", "connected"] as const)("A %s resume of the same box continues through the executor without probing a connected warm owner", async resumedFrom => {
  await runLeaseChangeScenario(resumedFrom);
}, 600_000);

// Keep reason: managed agent_files preparation reserves the CURRENT successor.
// Exercise real materialization/adoption and real PRP identity/loss, not a test
// assignment to the executor's private warm-owner map. The original four cases
// above retain their inputs and assertions.
it.skipIf(!enabled).each(["connected", "idle"] as const)("A managed-instructions %s resume checks its warm owner and preserves recall", async resumedFrom => {
  await runLeaseChangeScenario(resumedFrom, true);
}, 600_000);

async function runLeaseChangeScenario(resumedFrom: "idle" | "archived" | "stopped" | "connected", managed = false) {
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
  const responsibleUserId = randomUUID();
  const preparationReleases: Array<() => Promise<void>> = [];
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
    const canonical = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Pi lease proof", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi lease proof", adapterType: "paperclip_runner", adapterConfig: {
      provider: "pi_rpc", ...(managed ? { instructionsBundleMode: "managed", instructionsRootPath: canonical, instructionsEntryFile: "AGENTS.md" } : {}) } });
    if (managed) {
      await db.insert(authUsers).values({ id: responsibleUserId, name: "Managed lease proof", email: `${responsibleUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: responsibleUserId, membershipRole: "operator" },
        { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" }]);
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: responsibleUserId,
        permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
      await mkdir(canonical, { recursive: true });
      await writeFile(join(canonical, "AGENTS.md"), "Use only the current conversation. Do not call tools or invent missing history.\n");
    }
    await db.insert(environments).values({ id: environmentId, name: "Owned split-filesystem simulation", driver: "sandbox" });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Retain the same Pi conversation", description: null,
      assigneeAgentId: agentId, status: "in_progress" }).returning();
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from("Use only the current conversation. Do not call tools or invent missing history.\n") }]);
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const controller = await currentNativeControllerIdentity();
    const environmentsService = environmentService(db);
    const copies = agentInstructionWorkingCopyService(db);
    let previousManagedExecution: ReturnType<typeof buildNativeExecutionInput> | undefined;
    const seed = async (prompt: string, normalizedSessionId?: string, wakeCommentId?: string, previousLeaseId?: string) => {
      const runId = randomUUID();
      const [run] = await db!.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
        ...(managed ? { responsibleUserId, invocationSource: "on_demand" } : {}),
        nativeIssueId: issueId, ...(normalizedSessionId ? { nativeSessionId: normalizedSessionId } : {}),
        contextSnapshot: { issueId, ...(wakeCommentId ? { wakeCommentId } : {}) } }).returning();
      const lease = await environmentsService.acquireLease({ companyId, environmentId, heartbeatRunId: runId, issueId,
        provider: "boat", providerLeaseId, leasePolicy: "reuse_by_environment", metadata: { remoteCwd, agentId, pluginId: "fixture-allocation-driver" },
        ...(previousLeaseId ? { replacesReusableLeaseId: previousLeaseId } : {}) });
      const native = await prepareNativeHeartbeatRun({ db: db!, run: run!, issue: issue!, environmentLeaseId: lease.id });
      await db!.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: controller.bootId,
        controllerGeneration: 0, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt,
        leaseOwner: null, leaseExpiresAt: null });
      await db!.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const [contract] = await db!.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      leaseActive.set(lease.id, true);
      const instructionTarget: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "boat", environmentId, leaseId: lease.id,
        remoteCwd, runner: commandRunner(lease.id), sandboxLeaseAcquisition: { outcome: previousManagedExecution ? "resumed" : "created", providerLeaseId } };
      const capability = (root: string) => ({ runId, preparationKey: "managed-lease-proof", root,
        checkpointWarm: async () => {
          const saved = await copies.checkpointWarm({ companyId, runId, target: instructionTarget });
          return saved?.state === "warm_saved" && saved.errorCode === null;
        },
        hasChanges: () => copies.hasChanges({ companyId, runId, target: instructionTarget }),
        collectStopped: async () => { await copies.collectStopped({ companyId, runId, target: instructionTarget }); },
        retirementFailed: async () => { await copies.reportRetirementUnconfirmed(companyId, runId); } });
      let instructionWorkingCopy: ReturnType<typeof capability> | undefined;
      if (managed) {
        const previousRunId = previousManagedExecution?.binding.runId;
        const reservation = previousRunId ? await reserveWarmNativeInstructionDirectory({ companyId, agentId, previousRunId, runId,
          target: instructionTarget, canReuse: () => copies.canReuseWarm(companyId, agentId, previousRunId) }) : null;
        if (previousRunId) {
          expect(reservation, "unchanged managed files hand off to this successor").not.toBeNull();
          preparationReleases.push(reservation!.release);
        }
        const prepared = await copies.prepare({ companyId, agentId, runId, target: instructionTarget, cwd: remoteCwd, warm: true,
          reuseRunId: reservation?.reuseRunId, onWarmHandoff: copy => {
            const adopted = capability(copy.executionRoot);
            reservation!.adopt(adopted.root, adopted.collectStopped);
          } });
        expect(prepared?.state).toBe("prepared");
        instructionWorkingCopy = capability(prepared!.executionRoot);
        runtimeContext.instructions.workingCopy = { rootPath: instructionWorkingCopy!.root, entryPath: "AGENTS.md", kind: "agent_files" };
        runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
      }
      const execution = buildNativeExecutionInput({ companyId, agentId, runId, provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh",
        issue: { id: issueId, identifier: "PIL-1", title: issue!.title, description: null, workMode: "standard" }, taskPrompt: prompt,
        workspace: { id: workspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: native.normalizedSessionId,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: managed || resumedFrom === "connected" ? 600_000 : WARM_IDLE_MS }, runtimeContext,
        completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion, contract: contract!.contractJson as never } });
      // The native authority uses the actual acquired DB id, never the
      // executionWorkspaceId or the unrelated PRP connection lease token.
      await db!.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify({ nativeExecutionInput: execution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "pi_rpc") })}::jsonb` })
        .where(eq(heartbeatRuns.id, runId));
      leaseActive.set(lease.id, true);
      if (managed) previousManagedExecution = execution;
      return { runId, run: run!, native, execution, lease, prompt, instructionWorkingCopy };
    };
    type Fixture = Awaited<ReturnType<typeof seed>>;
    const executionOptions = async (fixture: Fixture, outcome: "created" | "resumed") => {
      // Honest provider ingress: like the production provider endpoint, it
      // exposes exactly the listener path the caller requests (runnerd's
      // --listen-path), bound to this run's lease.
      const endpoint = async (request?: { leaseId: string; port: number; path: string }): Promise<RunnerIngressEndpoint> => {
        if (!leaseActive.get(fixture.lease.id)) throw new Error("retired environment lease cannot obtain ingress");
        const path = request?.path ?? `/api/runner/v1/connect/${fixture.runId}`;
        previewBindings.set(path, fixture.lease.id);
        stage("ingress endpoint requested", { runId: fixture.runId, leaseId: fixture.lease.id, path });
        return { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${path}`,
          secretHeaders: [{ name: "X-Owned-Lease", value: fixture.lease.id }], generation: fixture.lease.id,
          refresh: () => endpoint(request), close: async () => {} };
      };
      const target: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "boat", environmentId,
        leaseId: fixture.lease.id, remoteCwd, reusableLeaseConfigured: true, runner: commandRunner(fixture.lease.id),
        effectiveCapabilities: { runnerWebSocketIngress: true, reusableLeases: true, independentControlCommands: true,
          nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false, incrementalSessionOutput: false,
          concurrentSyncOperations: false, duplexCommandStream: false }, getRunnerIngressEndpoint: endpoint,
        sandboxLeaseAcquisition: { outcome, providerLeaseId,
          ...(outcome === "resumed" && (resumedFrom === "archived" || resumedFrom === "stopped")
            ? { resumedFromState: resumedFrom, restarted: true as const } : {}) } };
      return { db: db!, execution: fixture.execution, runnerInstanceId: fixture.native.runnerInstanceId, instructionWorkingCopy: fixture.instructionWorkingCopy,
        // Heartbeat normally wires this sink around the executor. Persist actual
        // controller spans with its production event allocator in this direct
        // executor fixture; PRP ingestion alone does not save controller spans.
        onEvent: managed ? async (event: AdapterRuntimeEvent) => {
          await appendHeartbeatRunEvent(db!, { ...event, companyId, agentId, runId: fixture.runId });
        } : undefined,
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
    activeRunId = first.runId;
    const firstOptions = await executionOptions(first, "created");
    const firstOutcome = await executePaperclipNativeSession({ ...firstOptions, useRunnerd: true, conversationMode: true }).then(
      result => ({ result }), error => ({ error: String(error) }));
    activeRunId = undefined;
    await writeFile(join(root, "execution-outcome.json"), JSON.stringify(firstOutcome, null, 2));
    expect(record(firstOutcome).error, JSON.stringify(firstOutcome)).toBeUndefined();
    const runner = spawned.at(-1)!; const pi = ownedDescendant(runner, "pi");
    expect(pi, "the warm Runner and its Pi stay alive after the turn").not.toBeNull();
    expect(sameBirth(runner)).toBe(true);
    processPairs.push({ runner, pi: pi! });
    const originalFile = sessionFile(pi!);
    const before = await readFile(originalFile);
    expect(before.toString()).toContain(fact);
    const remoteSessionRoot = join(stagedRuntime, "sessions", createHash("sha256").update(first.native.normalizedSessionId).digest("hex"));
    // The heartbeat service settles each finished run around the executor.
    const settle = async (fixture: Fixture) => {
      await db!.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      await db!.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId));
      if (managed && resumedFrom === "idle") {
        const owned = spawned.at(-1)!;
        const ownedPi = ownedDescendant(owned, "pi");
        expect(sameBirth(owned), "warm owner exists before actual idle loss").toBe(true);
        expect(ownedPi).not.toBeNull();
        // A real idle generation loss, without calling Core's close path or
        // deleting its warm entry. Birth checks fence each signal to this test.
        for (const child of [...ownedDescendants(owned).reverse(), owned]) if (sameBirth(child)) process.kill(child.pid, "SIGKILL");
        await vi.waitFor(() => { expect(sameBirth(owned)).toBe(false); expect(sameBirth(ownedPi!)).toBe(false); }, { timeout: 30_000, interval: 100 });
        stage("managed warm Runner and Pi actually lost while idle", { runner: owned, pi: ownedPi });
        leaseActive.set(fixture.lease.id, false);
        await environmentService(db!).releaseLease(fixture.lease.id, "released");
        return;
      }
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
      await environmentService(db!).releaseLease(fixture.lease.id, "released");
    };
    let previous = first;
    const turn = async (index: number) => {
      await settle(previous);
      const [comment] = await db!.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
        body: `Turn ${index}: recall the private fact from your own earlier assistant history. Do not invent it.` }).returning();
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
      const nextOptions = await executionOptions(next, "resumed");
      const beforeCommands = commands.length;
      activeRunId = next.runId;
      const outcome = await executePaperclipNativeSession({ ...nextOptions, useRunnerd: true, conversationMode: true }).then(
        result => ({ result }), error => ({ error: String(error) }));
      activeRunId = undefined;
      await writeFile(join(root, `turn-${index}-outcome.json`), JSON.stringify(outcome, null, 2));
      if (managed) {
        const managedEvents = await db!.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next.runId));
        const spans = managedEvents.filter(event => event.eventType === "run.performance.span"
          && record(event.payload).span === "native.controller.warm_owner_identity_check");
        expect(spans, "the current run's managed preparation must not suppress the identity check").toHaveLength(1);
        expect(record(spans[0]!.payload).outcome).toBe(resumedFrom === "connected" ? "ok" : "failed");
        const probes = commands.slice(beforeCommands).filter(command => (record(command).args as string[] | undefined)?.[2] === "paperclip-runner-generation-marker");
        expect(probes.length).toBe(resumedFrom === "connected" ? 0 : 1);
        if (resumedFrom === "idle") {
          expect(new Set(spawned.map(entry => entry.pid)).size, "lost owner retired and a fresh generation admitted").toBe(index);
          const latestRunner = spawned.at(-1)!;
          const latestPi = ownedDescendant(latestRunner, "pi");
          expect(latestPi).not.toBeNull();
          processPairs.push({ runner: latestRunner, pi: latestPi! });
        }
      }
      expect(record(outcome).error, `turn ${index}: ${JSON.stringify(outcome)}`).toBeUndefined();
      if (resumedFrom === "connected") {
        expect(commands.slice(beforeCommands).filter(command =>
          (record(command).args as string[] | undefined)?.[2] === "paperclip-runner-generation-marker"),
        "ordinary warm turns must not execute a generation probe").toEqual([]);
        expect(new Set(spawned.map(entry => entry.pid)).size, "the connected Runner is retained").toBe(1);
      }
      expect(record(outcome).result).toMatchObject({ exitCode: 0, sessionId: first.native.normalizedSessionId, summary: `RECALLED_${fact}` });
      expect(requests).toHaveLength(index);
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
    for (const index of [2, 3]) {
      const { next } = await turn(index);
      const leases = await db!.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, next.runId));
      expect(leases.map(lease => lease.providerLeaseId)).toEqual([providerLeaseId]);
    }
    const epochs = managed || resumedFrom === "connected" ? []
      : readdirSync(join(remoteSessionRoot, "authority-epochs")).filter(name => name.startsWith("epoch-"));
    await writeFile(join(root, "proof.json"), JSON.stringify({ scope: "executePaperclipNativeSession warm path; real runnerd/proxy/Pi; simulated allocation and loopback model",
      managed, resumedFrom, firstRunId: first.runId, nativeSessionId: first.native.normalizedSessionId, requests, processPairs, epochs }, null, 2));
    stage(`GREEN: three turns of the same conversation (${resumedFrom})`, { epochs });
    await closeWarmNativeSessionsForEnvironment({ environmentId, reason: "closed-owner proof complete" });
  } catch (error) { failure = error; throw error; }
  finally {
    const errors: unknown[] = [];
    const cleanupBirths = [...spawned.flatMap(runner => ownedDescendants(runner)), ...spawned, ...processPairs.map(pair => pair.pi)];
    for (const release of preparationReleases) try { await release(); } catch (error) { errors.push(error); }
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
    const emergencyCleanup = cleanupBirths.filter(sameBirth);
    if (emergencyCleanup.length) {
      errors.push(new Error("owned native processes required emergency cleanup after normal retirement"));
      for (const owned of emergencyCleanup.reverse()) if (sameBirth(owned)) process.kill(owned.pid, "SIGKILL");
      await vi.waitFor(() => { expect(cleanupBirths.filter(sameBirth)).toEqual([]); }, { timeout: 30_000, interval: 100 });
      stage("birth-fenced emergency cleanup (test remains RED)", emergencyCleanup);
    }
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
}
