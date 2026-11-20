import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import https, { createServer as createHttpsServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { PAPERCLIP_RUNNER_INGRESS_PORT, type RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { environmentService } from "../services/environments.js";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, issueRecoveryActions, agentWakeupRequests, environments, environmentLeases, issues, workspaceOperations, nativeRunFinalizations } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";


// Explicit-only launch-change flow, using the existing turnstop rig's real
// HTTP routes, DB, Runner and Pi with a loopback model and allocation driver.
// Model/skill edits start fresh before prepare; unchanged turns keep warm PIDs.
// This is not a cloud-sandbox, phone-browser or paid-provider qualification.
const allocation = vi.hoisted(() => ({ drivers: undefined as import("../services/environment-runtime.js").EnvironmentRuntimeDriver[] | undefined }));
vi.mock("../services/environment-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-runtime.js")>();
  return { ...actual, environmentRuntimeService: (db: Parameters<typeof actual.environmentRuntimeService>[0], options: Parameters<typeof actual.environmentRuntimeService>[1]) => actual.environmentRuntimeService(db, { ...options, drivers: allocation.drivers ?? options?.drivers }) };
});
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";
const protocol = "responses";

type Bundle = ReturnType<typeof import("../vendor/paperclip-runner/index.js").createRunnerdCodexTransport>;
function piDescendant(runnerPid: number): number | null {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      children.set(ppid, [...children.get(ppid) ?? [], Number(entry)]);
    } catch { /* process exited during snapshot */ }
  }
  const visit = (pid: number): number | null => {
    for (const child of children.get(pid) ?? []) {
      try {
        const command = readFileSync(`/proc/${child}/cmdline`, "utf8").replaceAll("\0", " ");
        const comm = readFileSync(`/proc/${child}/comm`, "utf8").trim().toLowerCase();
        if (comm === "pi" || (command.includes("--mode rpc") && /(?:cli|bundle)\.js/.test(command))) return child;
      } catch { /* process exited during snapshot */ }
      const found = visit(child); if (found) return found;
    }
    return null;
  };
  return visit(runnerPid);
}

async function stopOwnedFixtureProcesses(root: string): Promise<number[]> {
  const identity = (pid: number) => {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const stat = text.slice(text.lastIndexOf(")") + 2).split(" ");
      const birth = stat[19];
      if (!birth || pid === process.pid || stat[0] === "Z" || (cwd !== root && !cwd.startsWith(`${root}/`))) return null;
      return { pid, birth };
    } catch { return null; }
  };
  const owned = readdirSync("/proc").filter(id => /^\d+$/.test(id)).map(id => identity(Number(id))).filter(x => x !== null);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const row of owned) {
      if (identity(row.pid)?.birth !== row.birth) continue;
      try { process.kill(row.pid, signal); } catch { /* exited after identity check */ }
    }
    const end = Date.now() + (signal === "SIGTERM" ? 5_000 : 2_000);
    while (Date.now() < end && owned.some(row => identity(row.pid)?.birth === row.birth)) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  expect(owned.filter(row => identity(row.pid)?.birth === row.birth), "private fixture processes stopped").toEqual([]);
  return owned.map(row => row.pid);
}

it.skipIf(!enabled).each(["model-1", "model-2", "model-3", "skill", "unchanged"] as const)(`claim29 launch selection: %s (real Runner/Pi, settled warm turn)`, async scenario => {
  const stopTurn = Number(process.env.PAPERCLIP_CLAIM29_WARM_TURNS ?? 2) + 1;
  expect(thinking).toBe("xhigh");
  expect(protocol).toBe("responses");
  expect(process.env.TMPDIR, "dedicated test tmpdir is required").toBeTruthy();

  if (process.platform !== "linux") throw new Error("This real PID proof requires Linux");
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH)
    throw new Error("Set absolute PAPERCLIP_RUNNER_BINARY and PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to qualified local artifacts");
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-turnstop-spike-"));
  const stages: Array<{ at: string; stage: string; detail: unknown }> = [];
  const stage = (name: string, detail: unknown = {}) => {
    const row = { at: new Date().toISOString(), stage: name, detail };
    stages.push(row); console.log(`[pi-full-server] ${name} ${JSON.stringify(detail)}`);
  };
  const bundles: Bundle[] = [];
  const assistantFact = `ASSISTANT_ONLY_STOP_FACT_${randomUUID()}`;
  const requests: Array<{ at: number; firstWordsAt: number; deliveredAt?: number; path: string; model: unknown; input: unknown; lastMessage: unknown; tools: string[]; recalledAssistantFact: boolean }> = [];
  const boxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const birth = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19];
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let helloProbeRequests = 0;
  let replyCount = 0;
  let warmupCount = 0;
  let sendAt = 0;
  let normalFirstTurnMs = 0;
  const warmupRunIds = new Set<string>();
  const warmupIdentities: Array<{ runId: string; nativeSessionId: string | null; runnerPid: number; piPid: number }> = [];
  const previousCertificates = getCACertificates("default"), previousHttpsAgent = https.globalAgent;
  let fixtureHttpsAgent: https.Agent | undefined;
  let preview: ReturnType<typeof createHttpsServer> | undefined;
  const sockets = new Set<WebSocket>();
  let modelServer: Server | undefined, http: Server | undefined;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let companyId = "", agentId = "", issueId = "";
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const remoteWorkspace = join(root, "box-workspace");
  await mkdir(remoteWorkspace);
  const agentHome = join(root, "minimal-agent");
  await mkdir(agentHome);
  await writeFile(join(agentHome, "models.json"), JSON.stringify({ providers: { paperclip: { models: ["faux", "faux2"].map(id => ({ id, reasoning: true, contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } })) } } }));
  const adapterEnv = { PI_CODING_AGENT_DIR: agentHome, TMPDIR: process.env.TMPDIR! };
  vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home"));
  vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
  vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_HTTPS", "off");
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("OTEL_SDK_DISABLED", "true");
  let unsubscribe: (() => void) | undefined;
  let changed: (() => void) | undefined;
  // Company live events drive the checks; a 250ms bounded safety net covers
  // process startup / DB writes that intentionally do not emit a live event.
  const waitFor = async <T>(label: string, probe: () => Promise<T | null>, timeoutMs = Number(process.env.PAPERCLIP_PI_E2E_WAIT_MS ?? 120_000)): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await probe(); if (value !== null) return value;
      if (db && agentId) {
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        const failure = runs.find(run => run.status === "failed" || run.status === "timed_out");
        if (failure) throw new Error(`${label}: run failed ${JSON.stringify({ id: failure.id, status: failure.status, errorCode: failure.errorCode, error: failure.error })}`);
        if (runs.some(run => run.resultJson?.failureCode === "native_workspace_sync_out_failed")) {
          const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.companyId, companyId));
          const finalizations = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId));
          await writeFile(join(root, "setup-finalization-failure.json"), JSON.stringify({ operations, finalizations }, null, 2));
          throw new Error(`fixture workspace finalization failed: ${JSON.stringify({ operations, finalizations })}`);
        }
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { changed = undefined; resolve(); }, 250);
        changed = () => { clearTimeout(timer); changed = undefined; resolve(); };
      });
    }
    const wakeups = db && agentId ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)) : [];
    throw new Error(`Timed out at ${label}; wakeups=${JSON.stringify(wakeups)}`);
  };
  try {
    // Exercise the exact cold sandbox admission entry, not a copied verifier.
    // Only the command transport is local: runner.execute launches the real
    // pack-owned Node/Pi through the production child-process executor.
    // No installation object is supplied, so the immutable shortcut cannot hide
    // a broken generated script or a mismatch in its actual manifest comparison.
    const [{ verifyRemoteProviderPack }, { resolveRemoteProviderPackSource }] = await Promise.all([
      import("../services/native-runtime/remote-provider-pack-verification.js"),
      import("../services/native-runtime/native-session-executor.js"),
    ]);
    const { configuredRoot: packRoot, manifest } = resolveRemoteProviderPackSource(process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH);
    const verificationRunner: CommandManagedRuntimeRunner = {
      execute: async input => {
        const command = { command: input.command, args: input.args, cwd: input.cwd, timeoutMs: input.timeoutMs,
          bypassSession: input.bypassSession, scriptSha256: input.args?.[0] === "-e"
            ? createHash("sha256").update(input.args[1]!).digest("hex") : null };
        const result = await runChildProcess(`pi-pack-verify-${randomUUID()}`, input.command, input.args ?? [], {
          cwd: input.cwd ?? workspace, env: input.env ?? {}, stdin: input.stdin,
          timeoutSec: (input.timeoutMs ?? 30_000) / 1000, graceSec: 1, onLog: async () => {},
        });
        packVerificationCommands.push({ ...command, ...result });
        stage("remote pack verification command", { command: command.command, scriptSha256: command.scriptSha256,
          exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr });
        return result;
      },
    };
    stage("remote pack verification starting", { packRoot, manifestDigest: manifest.digest, provider: "pi_rpc", actualSandbox: false });
    await verifyRemoteProviderPack({ runner: verificationRunner, packRoot, manifest, cwd: workspace, provider: { kind: "pi_rpc" } });
    stage("remote pack verification passed", { packRoot, manifestDigest: manifest.digest });
    modelServer = createServer((req, res) => {
      let body = ""; req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", async () => {
        if (new URL(req.url ?? "", "http://127.0.0.1").pathname !== "/v1/responses") { res.writeHead(404).end(); return; }
        const parsed = JSON.parse(body);
        if (respondToNativePiHello(parsed, res, protocol)) {
          helloProbeRequests++; stage("faux model answered setup hello", { helloProbeRequests }); return;
        }
        const submittedAt = Date.now();
        await new Promise(resolve => setTimeout(resolve, 2_000));
        const warmup = warmupCount < stopTurn - 1;
        if (warmup) warmupCount++;
        const useTool = false;
        if (!warmup) requests.push({ at: submittedAt, firstWordsAt: 0, path: req.url!, model: parsed.model, input: parsed.input, lastMessage: parsed.input?.at(-1),
          tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? ""),
          recalledAssistantFact: (parsed.input ?? []).some((message: { role: string; content: unknown }) => message.role === "assistant" && JSON.stringify(message.content).includes(assistantFact)) });
        const reply = warmup ? `WARMUP_${warmupCount}` : `LOCAL_PI_FULL_SERVER_REPLY_${++replyCount} 6 × 7 = 42.`;
        const message = { id: `msg-${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
        const input = { command: `echo $$ > ${join(root, "bash.pid")}; sleep 60; echo SHOULD_NOT_RUN > ${join(root, "after-stop.txt")}` };
        const call = { id: "fc-stop-sleep", type: "function_call", status: "completed", call_id: "call-stop-sleep", name: "bash", arguments: JSON.stringify(input) };
        const response = { id: `resp-${randomUUID()}`, object: "response", status: "completed", model: "faux", output: useTool ? [message, call] : [message],
          usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
        emit("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
        emit("response.content_part.added", { item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        // Timestamp the first actual socket write, not generation before SSE.
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: reply })}\n\n`, () => {
          if (!warmup) requests.find(request => request.at === submittedAt)!.firstWordsAt = Date.now();
        });
        emit("response.output_text.done", { item_id: message.id, output_index: 0, content_index: 0, text: reply });
        emit("response.content_part.done", { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
        emit("response.output_item.done", { output_index: 0, item: message });
        if (useTool) {
          emit("response.output_item.added", { output_index: 1, item: { ...call, status: "in_progress", arguments: "" } });
          emit("response.function_call_arguments.delta", { item_id: call.id, output_index: 1, delta: call.arguments });
          emit("response.function_call_arguments.done", { item_id: call.id, output_index: 1, arguments: call.arguments });
          emit("response.output_item.done", { output_index: 1, item: call });
          stage("faux model called bash sleep 60", input);
        }
        emit("response.completed", { response }); res.end();
      });
    });
    await new Promise<void>(resolve => modelServer!.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("No faux model listener");
    const baseUrl = `http://127.0.0.1:${modelAddress.port}/v1`;
    stage("loopback faux model up", { baseUrl, root });
    stage("thinking qualification", { thinking, protocol, prodShapeXhigh: thinking === "xhigh", diagnosticStandIn: thinking !== "xhigh" });
    temporary = await startEmbeddedPostgresTestDatabase("native-pi-full-server-db-");
    db = createDb(temporary.connectionString);
    // Preserve this gate's database files: the ordinary helper cleanup removes
    // its temporary tree, forbidden in L3's no-deletions scope. Stop only our
    // exact port-matched postgres using its own pg_ctl, after closing clients.
    const pgPort = new URL(temporary.connectionString).port;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
        if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== pgPort) continue;
        const dataDir = args[args.indexOf("-D") + 1]!;
        const pgCtl = args[0].replace(/postgres$/, "pg_ctl");
        stopRetainedPostgres = async () => {
          const { closeRegisteredClients } = await import("@paperclipai/db");
          await closeRegisteredClients(temporary!.connectionString);
          const result = await runChildProcess(`l3-pg-stop-${entry}`, pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], { cwd: root, env: {}, timeoutSec: 30, graceSec: 1, onLog: async () => {} });
          expect(result.exitCode, "owned retained Postgres shutdown").toBe(0);
          stage("owned Postgres stopped; files retained", { pid: Number(entry), dataDir });
        };
        break;
      } catch { /* not our postgres */ }
    }
    expect(stopRetainedPostgres, "identify our postgres for no-deletions shutdown").toBeDefined();
    stage("embedded Postgres up");
    // Simulated allocation ONLY: all lease rows, retention, execution and routes
    // below remain product code. The real Runner/Pi run on this host behind the
    // same authenticated sandbox ingress contract used by the real-Pi fixtures.
    const environmentId = randomUUID();
    const envService = environmentService(db);
    const caps = { nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false,
      incrementalSessionOutput: false, concurrentSyncOperations: false, independentControlCommands: true,
      runnerWebSocketIngress: true, reusableLeases: true, duplexCommandStream: false };
    const stopCalls: string[] = [];
    let box = `spike-box-${randomUUID()}`;
    let commandCount = 0;
    const staged = join(remoteWorkspace, ".paperclip-runtime", "paperclip-runner");
    await mkdir(staged, { recursive: true });
    await symlink(process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH!, join(staged, "provider-pack"));
    const key = join(root, "preview.key"), cert = join(root, "preview.crt");
    const openssl = await runChildProcess(`cert-${randomUUID()}`, "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { cwd: root, env: {}, timeoutSec: 30, graceSec: 1, onLog: async () => {} });
    expect(openssl.exitCode).toBe(0);
    setDefaultCACertificates([...previousCertificates, await readFile(cert, "utf8")]);
    fixtureHttpsAgent = new https.Agent({ ca: getCACertificates("default") }); https.globalAgent = fixtureHttpsAgent;
    preview = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) });
    const websocket = new WebSocketServer({ noServer: true });
    const ingressBindings = new Map<string, string>();
    preview.on("upgrade", (req, socket, head) => {
      const leaseId = ingressBindings.get(req.url ?? "");
      if (!leaseId || req.headers["x-spike-lease"] !== leaseId) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      websocket.handleUpgrade(req, socket, head, front => {
        const back = new WebSocket(`ws://127.0.0.1:${PAPERCLIP_RUNNER_INGRESS_PORT}${req.url}`, { perMessageDeflate: false });
        const pending: Array<{ data: RawData; binary: boolean }> = [];
        sockets.add(front); sockets.add(back);
        front.on("message", (data, binary) => { if (back.readyState === WebSocket.OPEN) back.send(data, { binary }); else pending.push({ data, binary }); });
        back.on("open", () => { for (const frame of pending.splice(0)) back.send(frame.data, { binary: frame.binary }); });
        back.on("message", (data, binary) => { if (front.readyState === WebSocket.OPEN) front.send(data, { binary }); });
        front.on("close", () => { sockets.delete(front); back.terminate(); });
        back.on("close", () => { sockets.delete(back); front.terminate(); });
        front.on("error", () => back.terminate()); back.on("error", () => front.terminate());
      });
    });
    await new Promise<void>(done => preview!.listen(0, "127.0.0.1", done));
    const previewAddress = preview.address(); if (!previewAddress || typeof previewAddress === "string") throw new Error("preview missing");
    allocation.drivers = [{ driver: "sandbox",
      acquireRunLease: async input => {
        const candidates = await db!.select().from(environmentLeases).where(eq(environmentLeases.environmentId, environmentId));
        const prior = candidates.find(row => row.issueId === input.issueId && row.metadata?.agentId === input.agentId && row.status === "retained");
        if (!prior) box = `spike-box-${randomUUID()}`;
        const lease = await envService.acquireLease({ companyId: input.companyId, environmentId,
          heartbeatRunId: input.heartbeatRunId, executionWorkspaceId: input.executionWorkspaceId, issueId: input.issueId,
          provider: "boat", providerLeaseId: prior?.providerLeaseId ?? box, leasePolicy: "reuse_by_environment",
          ...(prior ? { replacesReusableLeaseId: prior.id } : {}), metadata: { remoteCwd: remoteWorkspace, agentId: input.agentId,
            sandboxLeaseAcquisition: { outcome: prior ? "resumed" : "created", providerLeaseId: box } } });
        stage("allocation", { leaseId: lease.id, box: lease.providerLeaseId, runId: input.heartbeatRunId, warm: !!prior });
        return lease;
      },
      releaseRunLease: async input => envService.releaseLease(input.lease.id, input.status),
      realizeWorkspace: async () => ({ cwd: remoteWorkspace }),
      resolveCapabilities: async () => caps,
      providerSupportsReusableLeases: async () => true,
      execute: async input => {
        const startedAt = Date.now();
        const number = ++commandCount;
        const result = await runChildProcess(`box-command-${randomUUID()}`, input.command, input.args ?? [], { cwd: input.cwd ?? remoteWorkspace,
          env: input.env ?? {}, stdin: input.stdin, timeoutSec: (input.commandTimeoutMs ?? input.timeoutMs ?? 30000) / 1000,
          graceSec: 1, onLog: async (stream, chunk) => { await input.onLog?.(stream, chunk); } });
        await writeFile(join(root, `command-${number}.json`), JSON.stringify({ input, durationMs: Date.now() - startedAt, result }, null, 2));
        if (result.exitCode !== 0) stage("command failed", { number, durationMs: Date.now() - startedAt, result });
        return result;
      },
      getRunnerIngressEndpoint: async input => {
        ingressBindings.set(input.path, input.lease.id);
        const endpoint: RunnerIngressEndpoint = { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${previewAddress.port}${input.path}`,
          secretHeaders: [{ name: "X-Spike-Lease", value: input.lease.id }], generation: input.lease.id,
          refresh: async () => endpoint, close: async () => {} };
        return endpoint;
      },
      retryPendingSandboxTeardown: async ({ lease }) => { stopCalls.push(lease.id); stage("provider stop requested", { leaseId: lease.id }); return { providerLeaseId: lease.providerLeaseId!, state: "stopped" }; },
    }];
    await db.insert(environments).values({ id: environmentId, name: "Turnstop loopback allocation", driver: "sandbox",
      config: { provider: "boat", reuseLease: true, remoteCwd: workspace, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 300000 } });

    const [{ createApp }, { createStorageService }, { createLocalDiskStorageProvider }, runner, { setupRunnerPrpWebSocketServer }, { subscribeCompanyLiveEvents }] = await Promise.all([
      import("../app.js"), import("../storage/service.js"), import("../storage/local-disk-provider.js"),
      import("../vendor/paperclip-runner/index.js"), import("../realtime/runner-prp-ws.js"), import("../services/live-events.js"),
    ]);
    const realFactory = runner.createRunnerdCodexTransport;
    // Observation only: every invocation enters the unmodified production
    // transport with its actual arguments and retains its actual process owner.
    vi.spyOn(runner, "createRunnerdCodexTransport").mockImplementation(options => {
      stage("transport kind=pi_rpc", { provider: options?.provider, thinking: options?.piRpcThinkingLevel });
      expect(options?.provider).toBe("pi_rpc"); expect(options?.piRpcThinkingLevel).toBe(thinking);
      const bundle = realFactory(options);
      bundles.push(bundle); return bundle;
    });
    app = await createApp(db, {
      uiMode: "none", serverPort: 0, storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
      authReady: true, companyDeletionEnabled: false, instanceId: `local-pi-${randomUUID()}`,
      localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [], decisionServiceOptions: { wakeOriginAgent: async () => undefined },
    });
    await app.locals.bundledPluginsStartup;
    http = createServer(app);
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    const address = http.address(); if (!address || typeof address === "string") throw new Error("No full server listener");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("PAPERCLIP_API_URL", apiUrl);
    setupRunnerPrpWebSocketServer(http, { apiUrl });
    stage("full Paperclip server up", { apiUrl });
    const api = async (method: string, path: string, body?: unknown, expected = 200, timeoutMs = 30_000) => {
      const requestBody = method === "POST" && path.endsWith("/comments") && body && typeof body === "object"
        ? { ...body, clientRequestId: randomUUID() } : body;
      const response = await fetch(`${apiUrl}/api${path}`, { method, headers: { "content-type": "application/json", origin: apiUrl }, signal: AbortSignal.timeout(timeoutMs), ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }) });
      const text = await response.text();
      expect(response.status, `${method} ${path}: ${text}`).toBe(expected);
      return JSON.parse(text);
    };
    const company = await api("POST", "/companies", { name: "Local native Pi full-server proof" }, 201);
    companyId = company.id;
    await api("PATCH", `/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "local-board", name: "Local proof operator", email: "local-pi@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
      const text = JSON.stringify(event.payload);
      if (text.includes("LOCAL_PI_FULL_SERVER_REPLY_")) {
        const request = requests.at(-1);
        if (request && !request.deliveredAt) request.deliveredAt = Date.now();
      }
      changed?.();
    });
    const connection = await api("POST", `/companies/${companyId}/ai-connections`, {
      provider: "openai", method: "api_key", name: "Loopback faux only", ownership: "personal", routing: {
        kind: "local", protocol, baseUrl, auth: "none", models: [{ id: "faux", label: "Local faux", thinkingLevels: [thinking] }, { id: "faux2", label: "Local faux 2", thinkingLevels: [thinking] }],
      },
    }, 201);
    stage("fixed AI connection created", connection);
    const binding = { mode: "delegated", provider: "openai", method: "api_key", connectionId: connection.connectionId, grantId: connection.grantId };
    const agent = await api("POST", `/companies/${companyId}/agents`, {
      name: "Local Pi proof", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", cwd: workspace, model: "paperclip/faux", env: adapterEnv },
      runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false, wakeOnDemand: true } },
    }, 201);
    agentId = agent.id;
    // Hire verification is asynchronous. Join the real managed hello before
    // PATCH or business turns; never force ready over a still-running verifier.
    await waitFor("managed native Pi hire verified", async () => {
      const [current] = await db!.select().from(agents).where(eq(agents.id, agentId));
      if (current?.lifecycleError) throw new Error(`Native Pi hire verification failed: ${JSON.stringify(current.lifecycleError)}`);
      return current?.lifecycleState === "ready" ? current : null;
    });
    expect(helloProbeRequests, "managed hire made a real native hello model request").toBeGreaterThan(0);
    stage("native Pi hire verified", { agentId, helloProbeRequests });
    const patched = await api("PATCH", `/agents/${agentId}`, {
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", cwd: workspace, model: "paperclip/faux", lifecycleMode: "warm", piRpcThinkingLevel: thinking, env: adapterEnv },
      runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false, wakeOnDemand: true } },
    });
    expect(patched.adapterConfig).toMatchObject({ provider: "pi_rpc", lifecycleMode: "warm", piRpcThinkingLevel: thinking, model: "paperclip/faux" });
    expect(patched.lifecycleState).toBe("ready");
    stage("PATCH 200", { agentId, lifecycleState: patched.lifecycleState, adapterConfig: patched.adapterConfig });
    await db.update(agents).set({ defaultEnvironmentId: environmentId }).where(eq(agents.id, agentId));
    const issue = await api("POST", `/companies/${companyId}/issues`, { title: "Reply through native Pi", description: "Reply with the local faux token.", status: "todo", assigneeAgentId: agentId }, 201);
    issueId = issue.id;
    await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: "local-board", conversationState: "active" }).where(eq(issues.id, issueId));
    const drainControl = async (runId: string, label: string) => {
      const { heartbeatService } = await import("../services/heartbeat.js");
      const startedAt = Date.now();
      stage("CONTROL drain started", { runId, label, startedAt });
      try {
        await heartbeatService(db!).waitForRunExecutionDrain(runId, { timeoutMs: 15_000 });
        stage("CONTROL drain completed", { runId, label, elapsedMs: Date.now() - startedAt });
      } catch (error) {
        const [run] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const finalizations = await db!.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
        const events = await db!.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
        const leases = await db!.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
        await writeFile(join(root, `drain-timeout-${runId}.json`), JSON.stringify({ label, startedAt, run, finalizations, events, leases }, null, 2));
        throw error;
      }
    };
    for (let turn = 1; turn < stopTurn; turn++) {
      const warmup = await waitFor(`warmup ${turn} settled`, async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .find(run => run.status === "succeeded" && !warmupRunIds.has(run.id)) ?? null);
      if (!(scenario === "model-2" && turn === stopTurn - 1)) await drainControl(warmup.id, `warmup ${turn}`);
      if (turn === 1) normalFirstTurnMs = warmup.finishedAt!.getTime() - warmup.startedAt!.getTime();
      warmupRunIds.add(warmup.id);
      const runnerPid = bundles.at(-1)?.transport.processInfo?.()?.pid;
      const piPid = runnerPid ? piDescendant(runnerPid) : null;
      expect(runnerPid).toBeTruthy(); expect(piPid).toBeTruthy();
      const identity = { runId: warmup.id, nativeSessionId: warmup.nativeSessionId, runnerPid: runnerPid!, piPid: piPid! };
      if (warmupIdentities.length) expect(identity).toMatchObject({ ...warmupIdentities[0], runId: warmup.id });
      warmupIdentities.push(identity);
      stage("prior warm turn settled", { turn, ...identity });
      if (turn === stopTurn - 1) {
        if (scenario.startsWith("model")) {
          if (process.env.PAPERCLIP_CLAIM29_MODEL_API === "agent") {
            // Literal brief replay: global model edits clear task sessions.
            const current = await api("GET", `/agents/${agentId}`);
            await api("PATCH", `/agents/${agentId}`, { adapterConfig: { ...current.adapterConfig, model: "paperclip/faux2" } });
          } else {
            // Actual composer sequence (IssueDetail.addComment): persist this
            // task's agent model override, then admit the message immediately.
            const current = await api("GET", `/issues/${issueId}?view=core`);
            await api("PATCH", `/issues/${issueId}`, { assigneeAdapterOverrides: {
              ...current.assigneeAdapterOverrides,
              adapterConfig: { ...current.assigneeAdapterOverrides?.adapterConfig, model: "paperclip/faux2", piRpcThinkingLevel: thinking },
            } });
          }
        } else if (scenario === "skill") {
          const snapshot = await api("GET", `/agents/${agentId}/skills`);
          stage("skills before change", snapshot);
          await api("POST", `/agents/${agentId}/skills/sync`, { desiredSkills: ["paperclipai/paperclip/para-memory-files"], mode: "replace" });
        }
        sendAt = Date.now();
        stage("configuration committed; send immediately", { scenario, sendAt });
      }
      await api("POST", `/issues/${issueId}/comments`, { body: "What is 6 x 7?" }, 201);
    }
    const answer = await waitFor("immediate-send answer", async () => (await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .find(row => row.authorAgentId === agentId && row.body.includes("LOCAL_PI_FULL_SERVER_REPLY_1")) ?? null);
    const deliveredMs = Date.now() - sendAt;
    const next = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).find(run => !warmupRunIds.has(run.id))!;
    await drainControl(next.id, "changed-profile turn");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const notes = comments.filter(row => row.authorType === "system");
    const latestPid = bundles.at(-1)?.transport.processInfo?.()?.pid;
    const piPid = latestPid ? piDescendant(latestPid) : null;
    stage("acceptance", { deliveredMs, normalFirstTurnMs, answer: answer.body, runs: runs.map(row => ({ id: row.id, status: row.status, errorCode: row.errorCode })),
      actions, notes: notes.map(row => row.body), requests: requests.map(row => ({ model: row.model, at: row.at })), piPid });
    expect(runs.filter(row => row.status === "failed" || row.status === "timed_out")).toEqual([]);
    expect(runs).toHaveLength(stopTurn);
    expect(actions.filter(row => row.status === "active" || row.status === "escalated")).toEqual([]);
    // The person-case latency budget applies to model changes. The skill
    // control verifies the truthful note; its payload differs from the baseline.
    if (scenario.startsWith("model")) {
      expect(deliveredMs, `answer within measured normal first-turn time ${normalFirstTurnMs}ms (+5s jitter)`).toBeLessThan(normalFirstTurnMs + 5_000);
    }
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.input)).toContain("What is 6 x 7?");
    expect(answer.body).toContain("6 × 7 = 42.");
    expect(requests[0]!.model).toBe(scenario.startsWith("model") ? "faux2" : "faux");
    if (scenario === "unchanged") {
      expect(notes).toEqual([]);
      expect(piPid).toBe(warmupIdentities.at(-1)!.piPid);
    } else {
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toContain(scenario === "skill" ? "skill" : "model");
      if (scenario.startsWith("model")) expect(notes[0]!.body).not.toContain("skill change");
      expect(piPid).not.toBe(warmupIdentities.at(-1)!.piPid);
    }
    stage("GREEN", { scenario, deliveredMs, runId: next.id });
  } catch (error) {
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ scenario, stopTurn, warmupIdentities, stages, requests }, null, 2) + "\n");
    await writeFile(join(root, "remote-pack-verification.json"), JSON.stringify(packVerificationCommands, null, 2) + "\n");
    if (db && agentId) {
      const [hire] = await db.select().from(agents).where(eq(agents.id, agentId));
      await writeFile(join(root, "hire-status.json"), JSON.stringify({ id: hire?.id, lifecycleState: hire?.lifecycleState, lifecycleError: hire?.lifecycleError }, null, 2));
      if (issueId) await writeFile(join(root, "comments.json"), JSON.stringify(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)), null, 2));
      await writeFile(join(root, "wakeups.json"), JSON.stringify(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)), null, 2));
      await writeFile(join(root, "leases.json"), JSON.stringify(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId)), null, 2));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      await writeFile(join(root, "runs.json"), JSON.stringify(runs, null, 2));
      if (issueId) await writeFile(join(root, "recoveries.json"), JSON.stringify(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)), null, 2));
      for (const run of runs) await writeFile(join(root, `events-${run.id}.json`), JSON.stringify(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)), null, 2));
    }
    unsubscribe?.();
    if (db && agentId) {
      const { heartbeatService } = await import("../services/heartbeat.js");
      const heartbeat = heartbeatService(db);
      for (const run of await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))) {
        await heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 15_000 }).catch(error => console.error("Owned run drain", error));
      }
    }
    for (const bundle of bundles) await bundle.transport.close().catch(error => console.error("Owned runner teardown", error));
    await app?.locals.paperclipShutdown?.();
    allocation.drivers = undefined;
    for (const socket of sockets) socket.terminate();
    if (preview?.listening) await new Promise<void>(done => preview!.close(() => done()));
    fixtureHttpsAgent?.destroy(); https.globalAgent = previousHttpsAgent; setDefaultCACertificates(previousCertificates);
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    if (modelServer) { modelServer.closeAllConnections(); await new Promise<void>(resolve => modelServer!.close(() => resolve())); }
    await stopRetainedPostgres?.();
    // A failed warm attach may leave a daemon intentionally surviving the app.
    // This fake box owns a private cwd, not a real retained user workspace.
    stage("owned fixture processes stopped", { pids: await stopOwnedFixtureProcesses(root) });
    await writeFile(join(root, "proof.json"), JSON.stringify({ scenario, stopTurn, warmupIdentities, stages, requests }, null, 2) + "\n");
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    console.log(`[pi-full-server] evidence retained at ${root}`);
  }
}, 600_000);
