import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, agentWakeupRequests, environments, environmentLeases, issues, workspaceOperations, nativeRunFinalizations } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";


// Explicit-only real process/user flow; faux model, real HTTP route/DB/runner/Pi.
// Desired contract: real Stop cancels bash, not the resident; the next run
// recalls assistant-only history on the same Pi PID and native session ID.
// This is not a sandbox/remote-target qualification and uses no paid model.
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

it.skipIf(!enabled).each(["interrupt", "stop", "no-ack", "finished"] as const)(`warm turnstop spike: %s (real Runner/Pi, two prior turns)`, async scenario => {
  const stopTurn = 3;
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
  await writeFile(join(agentHome, "models.json"), JSON.stringify({ providers: { paperclip: { models: [{ id: "faux", reasoning: true, contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } }] } } }));
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
    // pack-owned Node/OpenCode through the production child-process executor.
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
        const useTool = !warmup && requests.length === 0 && scenario !== "finished";
        if (!warmup) requests.push({ at: submittedAt, firstWordsAt: 0, path: req.url!, model: parsed.model, input: parsed.input, lastMessage: parsed.input?.at(-1),
          tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? ""),
          recalledAssistantFact: (parsed.input ?? []).some((message: { role: string; content: unknown }) => message.role === "assistant" && JSON.stringify(message.content).includes(assistantFact)) });
        const reply = warmup ? `WARMUP_${warmupCount}` : useTool ? assistantFact
          : `LOCAL_PI_FULL_SERVER_REPLY_${++replyCount} ${requests.at(-1)!.recalledAssistantFact ? assistantFact : "HISTORY_LOST"}`;
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
      if (scenario === "no-ack") {
        const request = bundle.transport.request.bind(bundle.transport);
        bundle.transport.request = async (method, params) => {
          const result = await request(method, params);
          // Block delivery of the real Runner's reply, not Pi or a fake driver.
          if (method === "turn/interrupt") await new Promise(resolve => setTimeout(resolve, 3_000));
          return result;
        };
      }
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
        kind: "local", protocol, baseUrl, auth: "none", models: [{ id: "faux", label: "Local faux", thinkingLevels: [thinking] }],
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
    for (let turn = 1; turn < stopTurn; turn++) {
      const warmup = await waitFor(`warmup ${turn} settled`, async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .find(run => run.status === "succeeded" && !warmupRunIds.has(run.id)) ?? null);
      const { heartbeatService } = await import("../services/heartbeat.js");
      await heartbeatService(db).waitForRunExecutionDrain(warmup.id, { timeoutMs: 15_000 });
      warmupRunIds.add(warmup.id);
      const runnerPid = bundles.at(-1)?.transport.processInfo?.()?.pid;
      const piPid = runnerPid ? piDescendant(runnerPid) : null;
      expect(runnerPid).toBeTruthy(); expect(piPid).toBeTruthy();
      const identity = { runId: warmup.id, nativeSessionId: warmup.nativeSessionId, runnerPid: runnerPid!, piPid: piPid! };
      if (warmupIdentities.length) expect(identity).toMatchObject({ ...warmupIdentities[0], runId: warmup.id });
      warmupIdentities.push(identity);
      stage("prior warm turn settled", { turn, ...identity });
      await api("POST", `/issues/${issueId}/comments`, { body: "Continue with the next step." }, 201);
    }
    const admitted = await waitFor("run admitted", async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .find(run => run.runtimeMode === "native" && !warmupRunIds.has(run.id)) ?? null);
    stage("run admitted", { runId: admitted.id, status: admitted.status, runtimeMode: admitted.runtimeMode });
    const pid = await waitFor("runnerd session up / Pi PID", async () => {
      for (const bundle of bundles) { const process = bundle.transport.processInfo?.(); if (process?.pid) { const pid = piDescendant(process.pid); if (pid) return { runnerPid: process.pid, piPid: pid }; } }
      return null;
    });
    stage("runnerd session up", { runnerPid: pid.runnerPid }); stage("Pi PID", { pid: pid.piPid });
    for (const prior of warmupIdentities) expect({ ...pid, nativeSessionId: admitted.nativeSessionId })
      .toEqual({ runnerPid: prior.runnerPid, piPid: prior.piPid, nativeSessionId: prior.nativeSessionId });
    const readPiEnvironment = () => Object.fromEntries(readFileSync(`/proc/${pid.piPid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
    const launchEnvironment = readPiEnvironment();
    stage("AGENT_HOME proc at launch", { piPid: pid.piPid, agentHome: launchEnvironment.AGENT_HOME || "EMPTY", tmpdir: launchEnvironment.TMPDIR || "EMPTY" });
    if (scenario === "finished") {
      const { heartbeatService } = await import("../services/heartbeat.js");
      const finished = await waitFor("ordinary finished control", async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id))).find(row => row.status === "succeeded") ?? null);
      await heartbeatService(db).waitForRunExecutionDrain(finished.id, { timeoutMs: 15000 });
      expect(piDescendant(warmupIdentities[0]!.runnerPid)).toBe(warmupIdentities[0]!.piPid);
      expect(stopCalls).toEqual([]);
      stage("CONTROL GREEN", { pid, finished: finished.id });
      return;
    }
    const bashPid = await waitFor("bash tool actually started", async () => {
      try { const value = Number(readFileSync(join(root, "bash.pid"), "utf8").trim()); return value > 0 ? value : null; }
      catch { return null; }
    });
    const sleepPid = await waitFor("real sleep 60 child started", async () => {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1]!.split(" ");
          const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
          if (Number(stat[1]) === bashPid && /(?:^|\/)sleep$/.test(cmd[0]!) && cmd[1] === "60") return Number(entry);
        } catch { /* process exited during snapshot */ }
      }
      return null;
    });
    expect(requests[0]!.tools).toContain("bash");

    expect(requests[0]!.tools).toContain("paperclip_finish");
    const alive = (value: number) => {
      try { return readFileSync(`/proc/${value}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z"; }
      catch { return false; }
    };
    expect(alive(bashPid)).toBe(true);
    const [beforeStopLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, admitted.id));
    expect(beforeStopLease).toBeDefined();
    const piBirth = birth(pid.piPid);
    stage("Stop before real cancel route", { ...pid, piBirth, boxBootId, bashPid, sleepPid, leaseId: beforeStopLease!.id, boxId: beforeStopLease!.providerLeaseId });
    const successorDirection = scenario === "interrupt" ? "Interrupt carry: next local faux token, no tool." : "What is two plus two?";
    let successorCommentId: string | undefined;
    if (scenario === "interrupt") {
      const saved = await api("POST", `/issues/${issueId}/comments`, { body: successorDirection, deliveryIntent: "queue" }, 201);
      successorCommentId = saved.id;
      expect(successorCommentId).toBeTruthy();
    }
    const queue = scenario === "interrupt" ? await api("GET", `/issues/${issueId}/queued-comments`) : null;
    const started = Date.now();
    const cancelled = scenario === "interrupt"
      ? await api("POST", `/issues/${issueId}/queued-comments/interrupt`, { queueId: queue.queueId, targetRunId: admitted.id, revision: queue.revision }, 200, 5000)
      : await api("POST", `/heartbeat-runs/${admitted.id}/cancel`, {}, 200, 5000);
    const stopped = await waitFor("cancelled run within 5 seconds", async () => {
      const run = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id)))[0];
      return run?.status === "cancelled" ? run : null;
    }, Math.max(1, 5000 - (Date.now() - started)));
    const cancelMs = Date.now() - started;
    stage("Stop route returned and run cancelled", { runId: stopped.id, status: stopped.status, cancelMs, routeStatus: cancelled.status,
      bashAlive: alive(bashPid), residentAlive: alive(pid.piPid), runnerAlive: alive(pid.runnerPid) });
    // Keep observing identity/fallback even when latency fails; assert the
    // one-second settlement floor once the end-to-end row is captured.
    await waitFor("bash and sleep processes gone", async () => alive(bashPid) || alive(sleepPid) ? null : true, Math.max(1, 5000 - (Date.now() - started)));
    stage("bash and sleep gone within Stop budget", { bashPid, sleepPid, elapsedMs: Date.now() - started });
    const { heartbeatService } = await import("../services/heartbeat.js");
    await heartbeatService(db).waitForRunExecutionDrain(admitted.id, { timeoutMs: 15_000 });
    stage("Stop drained before NEW wake", { residentAlive: alive(pid.piPid), runnerAlive: alive(pid.runnerPid), bashAlive: alive(bashPid), bundles: bundles.length });
    const [drainedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id));
    const drainedLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, admitted.id));
    const executor = await import("../services/native-runtime/native-session-executor.js") as unknown as {
      hasRetainedNativeTurnStop?: (run: NonNullable<typeof drainedRun>, lease: typeof drainedLeases[number]) => boolean;
    };
    stage("retained qualification after drain (read-only)", { checkpoint: drainedRun?.runnerProfileJson?.nativeRetainedIdleCheckpoint,
      leases: drainedLeases.map(lease => ({ id: lease.id, status: lease.status, metadata: lease.metadata,
        retained: drainedRun && executor.hasRetainedNativeTurnStop?.(drainedRun, lease) })) });
    if (scenario !== "no-ack") {
      expect(alive(pid.piPid), "Stop must keep Pi alive after server run drain, before harness teardown").toBe(true);
      expect(alive(pid.runnerPid), "Stop must keep the original runnerd warm").toBe(true);
    }
    expect(existsSync(join(root, "after-stop.txt")), "cancelled command cannot run its trailing effect").toBe(false);
    const successorPressAt = scenario === "interrupt" ? started : Date.now();
    stage("successor authorization", { successorPressAt, stopToSendMs: successorPressAt - started, drainedAt: Date.now() });
    if (scenario !== "interrupt") {
      const saved = await api("POST", `/issues/${issueId}/comments`, { body: successorDirection }, 201);
      successorCommentId = saved.id;
      expect(successorCommentId).toBeTruthy();
    }
    const reply = await waitFor("NEW turn after Stop completes", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find(row => row.authorAgentId === agentId && row.body.includes("LOCAL_PI_FULL_SERVER_REPLY_1")) ?? null;
    });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const next = runs.find(run => !warmupRunIds.has(run.id) && run.id !== admitted.id)!;
    expect(next, "a NEW run, not continuation of stopped run").toBeDefined();
    await heartbeatService(db).waitForRunExecutionDrain(next.id, { timeoutMs: 15_000 });
    const final = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.id)))[0]!;
    const newPids = bundles.map(bundle => { const info = bundle.transport.processInfo?.(); return { runnerPid: info?.pid, piPid: info?.pid ? piDescendant(info.pid) : null }; });
    stage("NEW turn completed after Stop", { runId: final.id, status: final.status, old: pid, newPids, reply: reply.body });
    expect(final.status).toBe("succeeded");
    const replacement = newPids.find(value => value.piPid !== null)!;
    expect(replacement, "next run uses the same healthy resident").toBeDefined();
    const [nextLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, final.id));
    expect(nextLease).toBeDefined();
    const successor = requests[1]!;
    const requestHasAuthorizedDirection = JSON.stringify(successor.input).includes(successorDirection);
    const commentBoundToSuccessor = final.contextSnapshot?.commentId === successorCommentId
      || final.contextSnapshot?.wakeCommentId === successorCommentId
      || Array.isArray(final.contextSnapshot?.wakeCommentIds) && final.contextSnapshot.wakeCommentIds.includes(successorCommentId);
    stage("successor authorized-input coverage", { successorCommentId, requestHasAuthorizedDirection, commentBoundToSuccessor,
      requestedDirectionSha256: createHash("sha256").update(successorDirection).digest("hex"),
      actualCommentId: final.contextSnapshot?.commentId, actualWakeCommentId: final.contextSnapshot?.wakeCommentId });
    const modelTtftMs = successor.firstWordsAt - successor.at;
    const firstDeliveredMs = (successor.deliveredAt ?? Date.now()) - successorPressAt;
    const overheadMs = firstDeliveredMs - modelTtftMs;
    stage("TIMING MEASURED (live delivery, not browser render)", { scenario, cancelMs, submittedMs: successor.at - successorPressAt,
      firstDeliveredMs, modelTtftMs, overheadMs, original: { ...pid, piBirth, boxBootId },
      replacement: { ...replacement, piBirth: birth(replacement.piPid!), boxBootId },
      beforeLeaseId: beforeStopLease!.id, nextLeaseId: nextLease!.id, beforeBoxId: beforeStopLease!.providerLeaseId, nextBoxId: nextLease!.providerLeaseId });
    expect(commentBoundToSuccessor, "the apparent reply belongs to the newly authorized comment, not an old restored wake").toBe(true);
    expect(requestHasAuthorizedDirection, "the real model request contains the newly authorized direction").toBe(true);
    if (scenario === "no-ack") {
      expect(nextLease!.id).not.toBe(beforeStopLease!.id);
      expect(replacement.piPid).not.toBe(pid.piPid);
      stage("FALLBACK GREEN", { original: pid, replacement, stopCalls });
    } else {
      // A new durable lease row is the ordinary cross-run handoff, not a new
      // physical box. Qualify allocation identity and the actual process birth.
      expect(nextLease!.providerLeaseId).toBe(beforeStopLease!.providerLeaseId);
      expect(replacement.piPid).toBe(pid.piPid);
      expect(replacement.runnerPid).toBe(pid.runnerPid);
      expect(birth(replacement.piPid!)).toBe(piBirth);
      expect(successor.deliveredAt, "first-word live-event delivery was observed").toBeDefined();
      expect(overheadMs, "first delivered words minus actual successor model TTFT <=1s").toBeLessThanOrEqual(1000);
      expect(cancelMs, "real cancel route + persisted cancellation <=1s").toBeLessThanOrEqual(1000);
      expect(stopCalls).toEqual([]);
    }

    expect(requests[1]!.recalledAssistantFact, "private assistant history, not echoed in user input").toBe(true);
    expect(reply.body).toContain(assistantFact);
    expect(final.nativeSessionId, "Stop keeps the same Pi session").toBe(stopped.nativeSessionId);
    // A further ordinary run must also retain the same resident.
    await api("POST", `/issues/${issueId}/comments`, { body: "Another normal turn: reply with the next local faux token, no tool." }, 201);
    const warmReply = await waitFor("warm turn after replacement", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find(row => row.authorAgentId === agentId && row.body.includes("LOCAL_PI_FULL_SERVER_REPLY_2")) ?? null;
    });
    const warm = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .find(run => !warmupRunIds.has(run.id) && run.id !== admitted.id && run.id !== final.id)!;
    expect(warm).toBeDefined();
    await heartbeatService(db).waitForRunExecutionDrain(warm.id, { timeoutMs: 15_000 });
    const settledWarm = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, warm.id)))[0]!;
    expect(settledWarm.status).toBe("succeeded");
    expect(settledWarm.nativeSessionId).toBe(final.nativeSessionId);
    expect(piDescendant(replacement.runnerPid!)).toBe(replacement.piPid);
    expect(existsSync(join(root, "after-stop.txt"))).toBe(false);
    expect(alive(sleepPid)).toBe(false);
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.model === "faux")).toBe(true);
    stage("replacement stays warm", { ...replacement, runId: settledWarm.id, nativeSessionId: settledWarm.nativeSessionId, reply: warmReply.body });

    stage("GREEN", { companyId, agentId, issueId, requests: requests.length, cancelMs, original: pid, resident: replacement, nativeSessionId: settledWarm.nativeSessionId, assistantHistoryRecalled: true, bashPid, sleepPid });
  } catch (error) {
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ scenario, stopTurn, warmupIdentities, stages, requests }, null, 2) + "\n");
    await writeFile(join(root, "remote-pack-verification.json"), JSON.stringify(packVerificationCommands, null, 2) + "\n");
    if (db && agentId) {
      await writeFile(join(root, "comments.json"), JSON.stringify(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)), null, 2));
      await writeFile(join(root, "wakeups.json"), JSON.stringify(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)), null, 2));
      await writeFile(join(root, "leases.json"), JSON.stringify(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId)), null, 2));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      await writeFile(join(root, "runs.json"), JSON.stringify(runs, null, 2));
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
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    console.log(`[pi-full-server] evidence retained at ${root}`);
  }
}, 600_000);
