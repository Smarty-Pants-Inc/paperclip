import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
// Desired contract: after completed bash tools, real Stop ends the turn,
// not the resident; new input retains tool history on the same live Pi.
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

it.skipIf(!enabled).each(["R-redo", "R-double", "R-stop", "R-late-ack", "R-fallback", "R-no-ack", "R-no-ack-double", "R-no-ack-restart", "finished"] as const)(`warm turnstop T1-F: %s (real Runner/Pi, two prior turns)`, async scenario => {
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
  const fact = `TOOL_RESULT_${randomUUID()}`;
  type ModelRequest = { at: number; firstTokenWrittenAt?: number; deliveredAt?: number; turn: number; completed: number[]; input: any[]; tools: string[]; model: unknown; reply?: string };
  const requests: ModelRequest[] = [];
  const barriers: ModelRequest[] = [];
  const observations: Record<string, unknown>[] = [];
  const stepsPath = join(root, "steps.log");
  const completedSteps = (input: any[]) => [1, 2, 3, 4, 5, 6].filter(step => input.some(item =>
    item.type === "function_call_output" && JSON.stringify(item.output).includes(`${fact}_STEP${step}`)));
  const turnOf = (input: any[]) => {
    const users = input.filter(item => item.role === "user").map(item => JSON.stringify(item.content)).join("\n");
    return users.includes("T1F_INPUT_2") ? 2 : users.includes("T1F_INPUT_1") ? 1 : 0;
  };
  const procBirth = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19];
  const boxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let helloProbeRequests = 0;
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
        const inputItems = parsed.input ?? [];
        const turn = turnOf(inputItems);
        const completed = completedSteps(inputItems);
        const request: ModelRequest = { at: submittedAt, turn, completed, input: inputItems, model: parsed.model,
          tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? "") };
        if (!warmup) {
          requests.push(request);
          await writeFile(join(root, `model-request-${requests.length}.json`), JSON.stringify(parsed, null, 2));
          stage("actual Pi model request", { index: requests.length, turn, completed });
        }
        const boundary = scenario === "R-double" ? (turn === 0 ? 1 : turn === 1 ? 2 : null) : turn === 0 ? 2 : null;
        if (!warmup && scenario !== "finished" && boundary !== null && completed.includes(boundary)) {
          barriers.push(request);
          stage("completed-tool boundary reached", { turn, completed });
          await new Promise<void>(done => res.on("close", done));
          return;
        }
        const step = [1, 2, 3, 4, 5, 6].find(value => !completed.includes(value));
        const plainQuestion = (scenario === "R-stop" || scenario.startsWith("R-no-ack")) && turn === 1;
        const useTool = !warmup && scenario !== "finished" && !plainQuestion && step !== undefined;
        const reply = warmup ? `WARMUP_${warmupCount}` : plainQuestion ? "T1F_PLAIN_ANSWER: six is an even number."
          : useTool ? `Perform STEP${step}` : `T1F_SIX_STEPS_DONE_${turn}`;
        request.reply = reply;
        const message = { id: `msg-${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
        const input = { command: `printf 'STEP${step}\\n' >> '${stepsPath}'; printf '${fact}_STEP${step}\\n'` };
        const call = { id: `fc-${randomUUID()}`, type: "function_call", status: "completed", call_id: `call-${randomUUID()}`, name: "bash", arguments: JSON.stringify(input) };
        const response = { id: `resp-${randomUUID()}`, object: "response", status: "completed", model: "faux", output: useTool ? [message, call] : [message],
          usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
        emit("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
        emit("response.content_part.added", { item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        // Timestamp the first actual socket write, not generation before SSE.
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: reply })}\n\n`, () => {
          request.firstTokenWrittenAt = Date.now();
        });
        emit("response.output_text.done", { item_id: message.id, output_index: 0, content_index: 0, text: reply });
        emit("response.content_part.done", { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
        emit("response.output_item.done", { output_index: 0, item: message });
        if (useTool) {
          emit("response.output_item.added", { output_index: 1, item: { ...call, status: "in_progress", arguments: "" } });
          emit("response.function_call_arguments.delta", { item_id: call.id, output_index: 1, delta: call.arguments });
          emit("response.function_call_arguments.done", { item_id: call.id, output_index: 1, arguments: call.arguments });
          emit("response.output_item.done", { output_index: 1, item: call });
          stage("context-driven model called real bash step", { turn, step, ...input });
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
    const stopProcessIdentities: Array<{ pid: number; birth: string }> = [];
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
      retryPendingSandboxTeardown: async ({ lease }) => {
        stopCalls.push(lease.id); stage("provider stop requested", { leaseId: lease.id });
        // The simulated provider Stop models stopping this owned allocation,
        // not a second transport.close (which can join its own release hook).
        // Signal only the recorded process birth, through this existing provider
        // stop path, and attest Stop only after the real owner actually exits.
        for (const identity of stopProcessIdentities) {
          if (!existsSync(`/proc/${identity.pid}`)) continue;
          if (procBirth(identity.pid) !== identity.birth) throw new Error("fixture provider stop process birth changed");
          process.kill(identity.pid, "SIGTERM");
          const deadline = Date.now() + 5_000;
          while (existsSync(`/proc/${identity.pid}`) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          if (existsSync(`/proc/${identity.pid}`)) throw new Error("fixture provider stop has not retired its real owner");
        }
        stage("provider Stop proved real process exit", { leaseId: lease.id, stopProcessIdentities });
        return { providerLeaseId: lease.providerLeaseId!, state: "stopped" };
      },
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
      if (scenario === "R-late-ack") {
        const request = bundle.transport.request.bind(bundle.transport);
        bundle.transport.request = async (method, params) => {
          const result = await request(method, params);
          if (method === "turn/interrupt") {
            const receivedAt = Date.now();
            await new Promise(resolve => setTimeout(resolve, 2_000));
            stage("late interrupt RPC reply delivered", { receivedAt, deliveredAt: Date.now() });
          }
          return result;
        };
      }
      if (scenario === "R-fallback") {
        const request = bundle.transport.request.bind(bundle.transport);
        bundle.transport.request = async (method, params) => {
          // Suppress this control RPC before it reaches Runner; delaying its
          // reply is insufficient because the real terminal event is an ACK.
          if (method === "turn/interrupt") {
            stage("interrupt RPC withheld: qualification must miss");
            throw new Error("T1F injected interrupt delivery failure");
          }
          return request(method, params);
        };
      }
      if (scenario.startsWith("R-no-ack")) {
        const request = bundle.transport.request.bind(bundle.transport);
        bundle.transport.request = (method, params) => {
          if (method === "turn/interrupt") {
            stage("I-B turn.interrupt never resolves", { at: Date.now() });
            // Real pending Runner-transport RPC, not a rejection or late ACK.
            // Nothing is delivered to Runner, so neither its terminal event
            // nor an RPC reply can accidentally qualify this owner for reuse.
            return new Promise<Record<string, unknown>>(() => {});
          }
          return request(method, params);
        };
      }
      bundles.push(bundle); return bundle;
    });
    const fileWork = await import("../services/native-runtime/off-loop-file-work.js");
    const fingerprint = fileWork.artifactMetadataFingerprint;
    const fingerprints: Array<{ path: string; tree: boolean; value: string }> = [];
    vi.spyOn(fileWork, "artifactMetadataFingerprint").mockImplementation(async (path, tree) => {
      const value = await fingerprint(path, tree);
      fingerprints.push({ path, tree, value });
      await writeFile(join(root, "pack-metadata-fingerprints.json"), JSON.stringify(fingerprints, null, 2));
      return value;
    });
    const harnessTests = await import("../services/agent-environment-test.js");
    const realHarnessTests = harnessTests.agentEnvironmentTestService;
    vi.spyOn(harnessTests, "agentEnvironmentTestService").mockImplementation((...args) => {
      const service = realHarnessTests(...args);
      const test = service.testManagedEnvironment.bind(service);
      return { ...service, testManagedEnvironment: async (...input) => {
        const result = await test(...input);
        await writeFile(join(root, "hire-probe-result.json"), JSON.stringify(result, null, 2));
        return result;
      } };
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
      if (text.includes("T1F_SIX_STEPS_DONE_") || text.includes("T1F_PLAIN_ANSWER") || text.includes("Perform STEP")) {
        const request = requests.find(value => !value.deliveredAt && value.reply && text.includes(value.reply));
        if (request) request.deliveredAt = Date.now();
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
    const issue = await api("POST", `/companies/${companyId}/issues`, { title: "Six steps through native Pi", description: "Execute STEP1 through STEP6 once each. After Interrupt continue from the completed tool results, never redo completed steps. Stop revokes this work; answer only the newly authorized question after Stop.", status: "todo", assigneeAgentId: agentId }, 201);
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
    const originalIdentity = { ...pid, runnerBirth: procBirth(pid.runnerPid), piBirth: procBirth(pid.piPid), boxBootId, nativeSessionId: admitted.nativeSessionId };
    stopProcessIdentities.push({ pid: pid.piPid, birth: originalIdentity.piBirth },
      { pid: pid.runnerPid, birth: originalIdentity.runnerBirth });
    stage("runnerd/Pi live identity", originalIdentity);
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
    const { heartbeatService } = await import("../services/heartbeat.js");
    let current = admitted;
    if (scenario.startsWith("R-no-ack")) {
      await waitFor("completed tools before no-ack press", async () => barriers[0] ?? null);
      const sessions = join(remoteWorkspace, ".paperclip-runtime/paperclip-runner/sessions");
      const originalFile = readdirSync(sessions, { recursive: true }).map(file => join(sessions, String(file)))
        .find(file => file.endsWith(`/pi/${admitted.nativeSessionId}.jsonl`));
      expect(originalFile, "the original Pi session file is in the old allocation").toBeDefined();
      const originalInode = statSync(originalFile!).ino;
      const originalBytes = readFileSync(originalFile!, "utf8");
      const pressAt = Date.now();
      let terminalAt: number | undefined, admittedAt: number | undefined;
      const cancellationRequestId = randomUUID();
      const cancel = (requestId = cancellationRequestId) => api("POST", `/heartbeat-runs/${current.id}/cancel`, { cancellationRequestId: requestId })
        .then(result => ({ result, at: Date.now() }), error => ({ error: String(error), at: Date.now() }));
      const route = cancel();
      await waitFor("real interrupt dispatch entered", async () => stages.find(row => row.stage === "I-B turn.interrupt never resolves") ?? null, 10_000);
      const duplicate = scenario === "R-no-ack-double" ? cancel(randomUUID()) : Promise.resolve(null);
      const restart = scenario === "R-no-ack-restart" ? (async () => {
        stage("I-B graceful restart detach entered during hanging Stop");
        const { detachNativeSessionsForRestart } = await import("../services/native-runtime/native-session-executor.js");
        const result = await detachNativeSessionsForRestart([current.id]);
        stage("I-B graceful restart detach settled", result);
        return result;
      })() : Promise.resolve(null);
      const message = await api("POST", `/issues/${issueId}/comments`, { body: "T1F_INPUT_1: Answer this new message in the safe successor." }, 201);
      const terminal = waitFor("no-ack predecessor terminal", async () => {
        const [run] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.id));
        if (run?.status !== "cancelled") return null;
        terminalAt = Date.now(); return run;
      }, 60_000);
      const successor = waitFor("no-ack successor admitted within 60s", async () => {
        const run = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
          .find(row => !warmupRunIds.has(row.id) && row.id !== current.id && row.startedAt);
        if (!run) return null;
        admittedAt = Date.now(); return run;
      }, 60_000);
      const results = await Promise.allSettled([terminal, successor, route, duplicate, restart]);
      stage("I-B no-ack bound observation", { pressAt, terminalAt, admittedAt,
        terminalMs: terminalAt && terminalAt - pressAt, admissionMs: admittedAt && admittedAt - pressAt,
        results: results.map(result => result.status === "rejected" ? { status: result.status, reason: String(result.reason) } : result) });
      await writeFile(join(root, "no-ack-bound.json"), JSON.stringify({ scenario, pressAt, terminalAt, admittedAt,
        originalFile, originalInode, results: results.map(result => result.status === "rejected"
          ? { status: result.status, reason: String(result.reason) } : result) }, null, 2));
      expect(results[1]!.status, "authorized successor starts despite a never-resolving interrupt").toBe("fulfilled");
      expect(admittedAt! - pressAt, "one press-to-successor bound").toBeLessThanOrEqual(30_000);
      const next = (results[1] as PromiseFulfilledResult<typeof current>).value;
      expect(next.contextSnapshot?.forceFreshSession).toBe(true);
      const bound = next.contextSnapshot?.commentId === message.id || next.contextSnapshot?.wakeCommentId === message.id
        || Array.isArray(next.contextSnapshot?.wakeCommentIds) && next.contextSnapshot.wakeCommentIds.includes(message.id);
      expect(bound, "successor carries the new authorized message receipt").toBe(true);
      const notes = await waitFor("true fresh-session note is durable", async () => {
        const comments = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        return comments.some(row => /didn.t confirm the stop|stop.*fresh session|fresh session.*stop/i.test(row.body)) ? comments : null;
      }, Math.max(1, 30_000 - (Date.now() - pressAt)));
      if (scenario === "R-no-ack-double") expect(results[3]!.status).toBe("fulfilled");
      if (scenario === "R-no-ack-restart") {
        expect(results[4]!.status).toBe("fulfilled");
        expect((results[4] as PromiseFulfilledResult<{ inactiveRunIds: string[] }>).value.inactiveRunIds).toContain(current.id);
      }
      await heartbeatService(db).waitForRunExecutionDrain(next.id, { timeoutMs: 30_000 });
      const request = requests.find(row => row.turn === 1);
      expect(request, "the actual fresh Pi received the authorized input").toBeDefined();
      expect(request!.completed, "fresh fallback never claims warm tool context").toEqual([]);
      const [settledNext] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.id));
      expect(settledNext?.status).toBe("succeeded");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .filter(run => !warmupRunIds.has(run.id) && run.id !== current.id)).toHaveLength(1);
      expect(statSync(originalFile!).ino, "old session file stays in place for custody").toBe(originalInode);
      expect(readFileSync(originalFile!, "utf8").startsWith(originalBytes), "old session bytes are preserved").toBe(true);
      const live = bundles.map(bundle => bundle.transport.processInfo?.()?.pid).filter((value): value is number => !!value)
        .map(runnerPid => ({ runnerPid, piPid: piDescendant(runnerPid) })).find(value => value.piPid !== null);
      expect(live?.piPid, "uncertain resident is not reused").not.toBe(pid.piPid);
      expect(existsSync(`/proc/${pid.piPid}`), "old Pi process really exited before fallback").toBe(false);
      expect(stopCalls.length, "the existing stop-and-retain provider path ran").toBeGreaterThan(0);
      stage("I-B FALLBACK GREEN", { scenario, admissionMs: admittedAt! - pressAt, originalIdentity, live,
        originalFile, originalInode, successorRunId: next.id, requestAt: request!.at, notes: notes.filter(row => row.authorType === "system").map(row => row.body) });
      return;
    }
    const interrupts = scenario === "R-double" ? 2 : 1;
    for (let press = 1; press <= interrupts; press++) {
      const boundary = await waitFor(`completed tool boundary ${press}`, async () => barriers[press - 1] ?? null);
      expect(requests[0]!.tools).toContain("bash");
      expect(requests[0]!.tools).toContain("paperclip_finish");
      const expectedSteps = scenario === "R-double" ? [1, ...press === 2 ? [2] : []] : [1, 2];
      expect(boundary.completed).toEqual(expectedSteps);
      const beforeSteps = readFileSync(stepsPath, "utf8").trim().split("\n");
      expect(beforeSteps).toEqual(expectedSteps.map(step => `STEP${step}`));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, current.id));
      expect(lease).toBeDefined();
      const interrupt = scenario !== "R-stop";
      const message = `T1F_INPUT_${press}: ${scenario === "R-stop" ? "What kind of number is six? This is a plain question, not permission to resume the stopped work." : "Continue the six steps without repeating completed tools."}`;
      let successorCommentId: string;
      if (interrupt) successorCommentId = (await api("POST", `/issues/${issueId}/comments`, { body: message, deliveryIntent: "queue" }, 201)).id;
      const queue = interrupt ? await api("GET", `/issues/${issueId}/queued-comments`) : null;
      const requestCountAtPress = requests.length;
      const pressAt = Date.now();
      if (interrupt) await api("POST", `/issues/${issueId}/queued-comments/interrupt`, { queueId: queue.queueId, targetRunId: current.id, revision: queue.revision });
      else await api("POST", `/heartbeat-runs/${current.id}/cancel`, { cancellationRequestId: randomUUID() });
      const cancelledAt = Date.now();
      const drained = await heartbeatService(db).waitForRunExecutionDrain(current.id, { timeoutMs: scenario === "R-fallback" ? 120_000 : 15_000 });
      expect(drained, "join the interrupted execution, not only its status row").not.toBe(false);
      const drainedAt = Date.now();
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.id));
      expect(stopped?.status).toBe("cancelled");
      const { hasRetainedNativeTurnStop } = await import("../services/native-runtime/native-session-executor.js");
      const [stoppedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id));
      const qualified = hasRetainedNativeTurnStop(stopped!, stoppedLease);
      if (scenario !== "R-fallback") expect(qualified, "spike's exact stopped live owner + lease qualified").toBe(true);
      else expect(qualified, "undelivered interrupt never qualifies").toBe(false);
      // Stop itself must dispatch nothing. The separate Send is new authority.
      if (!interrupt) expect(requests).toHaveLength(requestCountAtPress);
      const sendAt = interrupt ? pressAt : Date.now();
      if (!interrupt) successorCommentId = (await api("POST", `/issues/${issueId}/comments`, { body: message }, 201)).id;
      // Do not skip a wrong/stale first request while waiting for a later
      // correctly attributed one: the very next provider input is the oracle.
      const first = await waitFor(`successor ${press} FIRST model request`, async () => requests[requestCountAtPress] ?? null);
      const next = await waitFor(`successor ${press} admitted`, async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .find(run => !warmupRunIds.has(run.id) && run.id !== current.id && !observations.some(row => row.predecessorRunId === run.id)) ?? null);
      const live = bundles.map(bundle => bundle.transport.processInfo?.()?.pid).filter((value): value is number => !!value)
        .map(runnerPid => ({ runnerPid, piPid: piDescendant(runnerPid) })).find(value => value.piPid !== null)!;
      const actualIdentity = live && { ...live, runnerBirth: procBirth(live.runnerPid), piBirth: procBirth(live.piPid!), boxBootId, nativeSessionId: next.nativeSessionId };
      const [nextLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, next.id));
      const commentBoundToSuccessor = next.contextSnapshot?.commentId === successorCommentId!
        || next.contextSnapshot?.wakeCommentId === successorCommentId!
        || Array.isArray(next.contextSnapshot?.wakeCommentIds) && next.contextSnapshot.wakeCommentIds.includes(successorCommentId!);
      const observation = { press, predecessorRunId: current.id, successorRunId: next.id, qualified,
        forceFreshSession: next.contextSnapshot?.forceFreshSession === true, originalIdentity, actualIdentity,
        successorCommentId: successorCommentId!, commentBoundToSuccessor,
        beforeBoxId: lease!.providerLeaseId, nextBoxId: nextLease?.providerLeaseId,
        expectedSteps, actualFirstTurn: first.turn, actualFirstInputSteps: first.completed, pressAt, cancelledAt, drainedAt, sendAt,
        requestAt: first.at, firstTokenWrittenAt: first.firstTokenWrittenAt,
        cancelRouteMs: cancelledAt - pressAt, drainMs: drainedAt - pressAt, sendToRequestMs: first.at - sendAt };
      observations.push(observation);
      stage("BOUNDARY OBSERVATION", observation);
      await writeFile(join(root, "observations.json"), JSON.stringify(observations, null, 2));
      expect(commentBoundToSuccessor, "the FIRST successor is bound to the newly authorized comment").toBe(true);
      expect(first.turn, "the FIRST successor input carries the newly authorized message").toBe(press);
      if (scenario === "R-fallback") {
        expect(observation.forceFreshSession).toBe(true);
        expect(live.piPid).not.toBe(pid.piPid);
        stage("FALLBACK GREEN", observation);
      } else {
        expect(first.completed, "FIRST successor model input retains completed tool RESULTS").toEqual(expectedSteps);
        for (const step of expectedSteps) {
          const call = first.input.find(item => item.type === "function_call" && JSON.stringify(item.arguments).includes(`${fact}_STEP${step}`));
          expect(call, `FIRST successor input retains STEP${step} tool CALL`).toBeDefined();
          expect(first.input.some(item => item.type === "function_call_output" && item.call_id === call.call_id && JSON.stringify(item.output).includes(`${fact}_STEP${step}`))).toBe(true);
        }
        expect(observation.forceFreshSession).toBe(false);
        expect(actualIdentity).toEqual(originalIdentity);
        expect(nextLease?.providerLeaseId, "the same physical allocation, not merely a new durable lease").toBe(lease!.providerLeaseId);
        expect(stopCalls).toEqual([]);
      }
      current = next;
    }
    const reply = await waitFor("authorized successor publishes its result", async () => (await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .find(row => row.authorAgentId === agentId && row.body.includes(scenario === "R-stop" ? "T1F_PLAIN_ANSWER" : `T1F_SIX_STEPS_DONE_${interrupts}`)) ?? null);
    const publicationObservedAt = Date.now();
    await heartbeatService(db).waitForRunExecutionDrain(current.id, { timeoutMs: 15_000 });
    const [final] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.id));
    expect(final?.status).toBe("succeeded");
    const actualSteps = readFileSync(stepsPath, "utf8").trim().split("\n");
    if (scenario !== "R-fallback") expect(actualSteps, "finished steps are never rerun; Stop does not resume work")
      .toEqual((scenario === "R-stop" ? [1, 2] : [1, 2, 3, 4, 5, 6]).map(step => `STEP${step}`));
    for (const observation of observations) {
      const request = requests.find(value => value.at === observation.requestAt)!;
      expect(request.firstTokenWrittenAt, "actual successor first-token socket write observed").toBeDefined();
      expect(request.deliveredAt, "actual successor first-word live-event delivery observed").toBeDefined();
      const modelTtftMs = request.firstTokenWrittenAt! - request.at;
      const firstDeliveredMs = request.deliveredAt! - Number(observation.sendAt);
      Object.assign(observation, { firstTokenWrittenAt: request.firstTokenWrittenAt, deliveredAt: request.deliveredAt,
        modelTtftMs, firstDeliveredMs, overheadMs: firstDeliveredMs - modelTtftMs });
      stage("PERFORMANCE REPORT ONLY: sub-second bar is out of I-B scope", observation);
    }
    await writeFile(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    stage("GREEN", { scenario, actualSteps, reply: reply.body, publicationObservedAt, observations,
      timingScope: "loopback HTTP, actual provider request/first-token write, durable comment publication; no browser/render or inference-latency claim" });
  } catch (error) {
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ scenario, stopTurn, warmupIdentities, stages, observations, requests }, null, 2) + "\n");
    await writeFile(join(root, "remote-pack-verification.json"), JSON.stringify(packVerificationCommands, null, 2) + "\n");
    if (db && agentId) {
      const [hire] = await db.select().from(agents).where(eq(agents.id, agentId));
      await writeFile(join(root, "hire-status.json"), JSON.stringify({ id: hire?.id, lifecycleState: hire?.lifecycleState, lifecycleError: hire?.lifecycleError }, null, 2));
      if (issueId) await writeFile(join(root, "comments.json"), JSON.stringify(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)), null, 2));
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
