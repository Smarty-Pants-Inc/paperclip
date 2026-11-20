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
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, agentWakeupRequests, environments, environmentLeases, issues, workspaceOperations, nativeRunFinalizations, plugins } from "@paperclipai/db";
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

it.skipIf(!enabled).each(["R-redo", "R-double", "R-stop", "R-late-ack", "R-fallback", "finished", "FILESTOP", "FILESTOP-fallback", "FILESTOP-forged-proof", "FILESTOP-restart-hook", "FILESTOP-validation-fails", "FILESTOP-late-export", "FILESTOP-fast-question"] as const)(`warm turnstop T1-F: %s (real Runner/Pi, two prior turns)`, async scenario => {
  const stopTurn = 3;
  const filestop = scenario.startsWith("FILESTOP");
  const forgedProof = scenario === "FILESTOP-forged-proof";
  const restartHook = scenario === "FILESTOP-restart-hook";
  const validationFails = scenario === "FILESTOP-validation-fails";
  const fallback = scenario === "R-fallback" || scenario === "FILESTOP-fallback" || forgedProof || restartHook;
  const fileBytes = Buffer.from("Paul's completed write survives Stop.\nFILESTOP utf8: café 🌱\n", "utf8");
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
  type ModelRequest = { fileBeforeTools?: { at: number; path: string; exists: boolean; base64: string | null }; at: number; firstTokenWrittenAt?: number; deliveredAt?: number; turn: number; completed: number[]; input: any[]; tools: string[]; model: unknown; reply?: string };
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
  let remoteWorkspace = join(root, "box-workspace");
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
        if (filestop && !warmup && turn === 1 && !requests.some(row => row.turn === 1)) {
          // This request has not received any response/tool call yet: observe
          // the real box workspace, not the server snapshot or a successor tool.
          const path = join(remoteWorkspace, "filestop.txt");
          request.fileBeforeTools = { at: Date.now(), path, exists: existsSync(path),
            base64: existsSync(path) ? readFileSync(path).toString("base64") : null };
          await writeFile(join(root, "file-before-successor-tools.json"), JSON.stringify(request.fileBeforeTools, null, 2));
          stage("FILESTOP bytes before successor first tool", request.fileBeforeTools);
        }
        if (!warmup) {
          requests.push(request);
          await writeFile(join(root, `model-request-${requests.length}.json`), JSON.stringify(parsed, null, 2));
          stage("actual Pi model request", { index: requests.length, turn, completed });
        }
        const boundary = scenario === "R-double" ? (turn === 0 ? 1 : turn === 1 ? 2 : null) : turn === 0 ? (filestop ? 1 : 2) : null;
        if (!warmup && scenario !== "finished" && boundary !== null && completed.includes(boundary)) {
          barriers.push(request);
          stage("completed-tool boundary reached", { turn, completed });
          await new Promise<void>(done => res.on("close", done));
          return;
        }
        const step = (filestop ? (turn === 0 ? [1] : [2]) : [1, 2, 3, 4, 5, 6]).find(value => !completed.includes(value));
        const plainQuestion = scenario === "R-stop" && turn === 1;
        const useTool = !warmup && scenario !== "finished" && !plainQuestion && step !== undefined;
        const reply = warmup ? `WARMUP_${warmupCount}` : plainQuestion ? "T1F_PLAIN_ANSWER: six is an even number."
          : useTool ? `Perform STEP${step}` : `T1F_SIX_STEPS_DONE_${turn}`;
        request.reply = reply;
        const message = { id: `msg-${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
        const command = filestop && step === 1
          ? `printf '%s' '${fileBytes.toString("base64")}' | base64 -d > filestop.txt; printf 'STEP1\\n' >> '${stepsPath}'; printf '${fact}_STEP1\\n'`
          : filestop && step === 2
            ? `cat filestop.txt; ${scenario === "FILESTOP-late-export" ? "printf 'successor file wins\\n' > successor.txt; " : ""}printf 'STEP2\\n' >> '${stepsPath}'; printf '${fact}_STEP2\\n'`
            : `printf 'STEP${step}\\n' >> '${stepsPath}'; printf '${fact}_STEP${step}\\n'`;
        const input = { command };
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
    // Only the provider allocation transport is simulated. Lease selection,
    // including workspace_export_pending, must run in the production driver.
    const pluginId = randomUUID();
    const providerConfig = { provider: "turnstop-loopback", reuseLease: true,
      runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 300000 };
    await db.insert(plugins).values({ id: pluginId, pluginKey: "turnstop.loopback", packageName: "@paperclip/turnstop-loopback",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "installed", installOrder: 10000,
      manifestJson: { id: "turnstop.loopback", apiVersion: 1, version: "1.0.0", displayName: "Loopback allocation",
        description: "Real lease policy with local provider transport", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "unused.js" },
        environmentDrivers: [{ driverKey: "turnstop-loopback", kind: "sandbox_provider", displayName: "Loopback",
          supportsReusableLeases: true, configSchema: { type: "object" } }] } } as never);
    const { environmentRuntimeService: realEnvironmentRuntimeService } = await vi.importActual<typeof import("../services/environment-runtime.js")>("../services/environment-runtime.js");
    const realAllocation = realEnvironmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
      call: async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          box = `spike-box-${randomUUID()}`;
          remoteWorkspace = join(root, box); await mkdir(remoteWorkspace);
          const runtime = join(remoteWorkspace, ".paperclip-runtime", "paperclip-runner");
          await mkdir(runtime, { recursive: true });
          await symlink(process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH!, join(runtime, "provider-pack"));
          return { providerLeaseId: box, metadata: { ...providerConfig, remoteCwd: remoteWorkspace } };
        }
        if (method === "environmentResumeLease") {
          remoteWorkspace = params.leaseMetadata.remoteCwd;
          return { providerLeaseId: params.providerLeaseId, metadata: { ...providerConfig, remoteCwd: remoteWorkspace } };
        }
        throw new Error(`Unexpected allocation RPC ${method}`);
      },
    } as never });
    allocation.drivers = [{ driver: "sandbox",
      acquireRunLease: async input => {
        const result = await realAllocation.acquireRunLease({ ...input,
          persistedExecutionWorkspace: input.executionWorkspaceId ? { id: input.executionWorkspaceId, mode: input.executionWorkspaceMode! } : null });
        const lease = result.lease;
        stage("allocation (production reusable filter)", { leaseId: lease.id, box: lease.providerLeaseId,
          runId: input.heartbeatRunId, acquisition: lease.metadata?.sandboxLeaseAcquisition });
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
      config: providerConfig });

    const [{ createApp }, { createStorageService }, { createLocalDiskStorageProvider }, runner, { setupRunnerPrpWebSocketServer }, { subscribeCompanyLiveEvents }] = await Promise.all([
      import("../app.js"), import("../storage/service.js"), import("../storage/local-disk-provider.js"),
      import("../vendor/paperclip-runner/index.js"), import("../realtime/runner-prp-ws.js"), import("../services/live-events.js"),
    ]);
    if (scenario === "FILESTOP-fallback") {
      const realExecute = runner.executeNativeSession;
      vi.spyOn(runner, "executeNativeSession").mockImplementation(options => realExecute({
        ...options,
        // Force only the clean-stop retention qualification off. Interrupt,
        // provider closure, file collection and successor admission stay real.
        retainCancelledSession: async () => {
          stage("FILESTOP qualification forced off; normal retirement fallback");
          return false;
        },
      }));
    }
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
            await new Promise(resolve => setTimeout(resolve, 3_000));
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
    // The fixture worker is the provider boundary; do not ask the app loader
    // to launch a nonexistent packaged worker during startup.
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId));
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
    const interrupts = scenario === "R-double" ? 2 : 1;
    for (let press = 1; press <= interrupts; press++) {
      const boundary = await waitFor(`completed tool boundary ${press}`, async () => barriers[press - 1] ?? null);
      expect(requests[0]!.tools).toContain("bash");
      expect(requests[0]!.tools).toContain("paperclip_finish");
      const expectedSteps = filestop ? [1] : scenario === "R-double" ? [1, ...press === 2 ? [2] : []] : [1, 2];
      expect(boundary.completed).toEqual(expectedSteps);
      const beforeSteps = readFileSync(stepsPath, "utf8").trim().split("\n");
      expect(beforeSteps).toEqual(expectedSteps.map(step => `STEP${step}`));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, current.id));
      expect(lease).toBeDefined();
      if (filestop) {
        const done = await waitFor("file write's tool completion event visible before Stop", async () =>
          (await db!.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, current.id)))
            .find(event => event.eventType === "tool.execution.completed" && JSON.stringify(event.payload).includes(`${fact}_STEP1`)) ?? null);
        await writeFile(join(root, "write-tool-completed-before-stop.json"), JSON.stringify(done, null, 2));
        const beforeStop = { at: Date.now(), path: join(remoteWorkspace, "filestop.txt"),
          base64: readFileSync(join(remoteWorkspace, "filestop.txt")).toString("base64"),
          serverSnapshotExists: existsSync(join(workspace, "filestop.txt")) };
        await writeFile(join(root, "file-before-stop.json"), JSON.stringify(beforeStop, null, 2));
        expect(beforeStop.base64).toBe(fileBytes.toString("base64"));
        stage("FILESTOP write tool completed before Stop", { eventId: done.id, seq: done.seq, createdAt: done.createdAt, ...beforeStop });
      }
      const interrupt = scenario !== "R-stop" && !filestop;
      const message = filestop ? `T1F_INPUT_${press}: read filestop.txt` : `T1F_INPUT_${press}: ${scenario === "R-stop" ? "What kind of number is six? This is a plain question, not permission to resume the stopped work." : "Continue the six steps without repeating completed tools."}`;
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
      let qualified = hasRetainedNativeTurnStop(stopped!, stoppedLease);
      if (forgedProof) {
        expect(qualified).toBe(true);
        const receipt = stopped!.runnerProfileJson!.nativeRetainedIdleCheckpoint as Record<string, unknown>;
        const profile = { ...stopped!.runnerProfileJson, nativeRetainedIdleCheckpoint: { ...receipt, generation: Number(receipt.generation) + 1 } };
        await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, stopped!.id));
        const [forged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stopped!.id));
        qualified = hasRetainedNativeTurnStop(forged!, stoppedLease);
        stage("R2 durable clean-stop receipt without exact live-generation proof", { qualified, receiptPresent: true });
      }
      if (restartHook) {
        expect(qualified).toBe(true);
        const { closeIdleWarmNativeSessionsForRestart } = await import("../services/native-runtime/native-session-executor.js");
        const restarted = await closeIdleWarmNativeSessionsForRestart();
        qualified = hasRetainedNativeTurnStop(stopped!, stoppedLease);
        stage("R4 restart lifecycle hook (not a server-process restart)", { restarted, qualified });
        expect(restarted.failed).toBe(0);
        expect(qualified).toBe(false);
      }
      if (validationFails) {
        await writeFile(join(remoteWorkspace, ".paperclip-runtime", "paperclip-runner", "workspace-sync-v1.json"), "{}\n");
        stage("R6 corrupt remote warm stamp after qualified Stop", { qualified });
      }
      const { nativeWorkspaceExportPendingForResource } = await import("../services/native-runtime/native-workspace-finalization-state.js");
      const exportPending = await nativeWorkspaceExportPendingForResource(db, stoppedLease!, null);
      stage("Stop export obligation (production predicate)", { qualified, exportPending, reference: stopped?.runnerProfileJson?.nativeWorkspaceSync });
      if (filestop && !fallback) expect(exportPending, "real prepared Stop export must still be pending at successor acquisition").toBe(true);
      if (!fallback) expect(qualified, "spike's exact stopped live owner + lease qualified").toBe(true);
      else expect(qualified, "fallback fixture must not qualify for retained turn-stop").toBe(false);
      if (scenario === "FILESTOP") {
        // R3: use the exact qualified real owner, including a shared workspace,
        // while varying only the issue or agent at the production acquire door.
        const sourceCwd = remoteWorkspace;
        const otherAgentId = randomUUID(), otherIssueId = randomUUID();
        await db.insert(agents).values({ id: otherAgentId, companyId, name: "Scope control", adapterType: "paperclip_runner" });
        await db.insert(issues).values({ id: otherIssueId, companyId, title: "Other issue scope", assigneeAgentId: agentId });
        const environment = (await db.select().from(environments).where(eq(environments.id, environmentId)))[0]!;
        for (const scope of [{ agentId, issueId: otherIssueId }, { agentId: otherAgentId, issueId }]) {
          const probeRunId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: probeRunId, companyId, ...scope, status: "running" });
          warmupRunIds.add(probeRunId);
          const probe = await realAllocation.acquireRunLease({ companyId, environment, ...scope,
            adapterType: "paperclip_runner", heartbeatRunId: probeRunId,
            persistedExecutionWorkspace: stoppedLease!.executionWorkspaceId ? { id: stoppedLease!.executionWorkspaceId, mode: "shared_workspace" } : null });
          stage("R3 scope acquisition", { ...scope, sourceLeaseId: stoppedLease!.id, sourceBox: stoppedLease!.providerLeaseId,
            leaseId: probe.lease.id, box: probe.lease.providerLeaseId });
          expect(probe.lease.providerLeaseId, "a different agent or issue cannot take the retained allocation").not.toBe(stoppedLease!.providerLeaseId);
          await envService.releaseLease(probe.lease.id, "expired");
          await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, probeRunId));
          remoteWorkspace = sourceCwd;
        }
      }
      // Stop itself must dispatch nothing. The separate Send is new authority.
      if (!interrupt) expect(requests).toHaveLength(requestCountAtPress);
      const sendAt = interrupt ? pressAt : Date.now();
      if (!interrupt) successorCommentId = (await api("POST", `/issues/${issueId}/comments`, { body: message }, 201)).id;
      // Do not skip a wrong/stale first request while waiting for a later
      // correctly attributed one: the very next provider input is the oracle.
      const first = await waitFor(`successor ${press} FIRST model request`, async () => {
        if (forgedProof) {
          const successor = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
            .find(run => !warmupRunIds.has(run.id) && run.id !== current.id);
          const [selected] = successor ? await db!.select().from(environmentLeases)
            .where(eq(environmentLeases.heartbeatRunId, successor.id)) : [];
          if (selected?.providerLeaseId === lease!.providerLeaseId) {
            const decision = { qualified, hintPresent: true, sourceLeaseId: lease!.id,
              sourceBox: lease!.providerLeaseId, selectedLeaseId: selected.id, selectedBox: selected.providerLeaseId };
            await writeFile(join(root, "R2-gate-decision.json"), JSON.stringify(decision, null, 2));
            stage("R2 wrong adoption at the production acquisition boundary", decision);
            expect(selected.providerLeaseId, "R2 durable hint without live-owner proof cannot adopt").not.toBe(lease!.providerLeaseId);
          }
        }
        return requests[requestCountAtPress] ?? null;
      });
      const next = await waitFor(`successor ${press} admitted`, async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .find(run => !warmupRunIds.has(run.id) && run.id !== current.id && !observations.some(row => row.predecessorRunId === run.id)) ?? null);
      const live = bundles.toReversed().map(bundle => bundle.transport.processInfo?.()?.pid).filter((value): value is number => !!value)
        .map(runnerPid => ({ runnerPid, piPid: piDescendant(runnerPid) })).find(value => value.piPid !== null)!;
      const actualIdentity = live && { ...live, runnerBirth: procBirth(live.runnerPid), piBirth: procBirth(live.piPid!), boxBootId, nativeSessionId: next.nativeSessionId };
      const [nextLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, next.id));
      const commentBoundToSuccessor = next.contextSnapshot?.commentId === successorCommentId!
        || next.contextSnapshot?.wakeCommentId === successorCommentId!
        || Array.isArray(next.contextSnapshot?.wakeCommentIds) && next.contextSnapshot.wakeCommentIds.includes(successorCommentId!);
      if (filestop) {
        const syncEvents = (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next.id)))
          .filter(event => typeof event.payload?.span === "string" && event.payload.span.startsWith("workspace_sync."));
        await writeFile(join(root, "successor-workspace-sync-events.json"), JSON.stringify(syncEvents, null, 2));
        stage("FILESTOP successor workspace sync", { spans: syncEvents.map(event => event.payload?.span) });
      }
      const observation = { press, predecessorRunId: current.id, successorRunId: next.id, qualified,
        forceFreshSession: next.contextSnapshot?.forceFreshSession === true, originalIdentity, actualIdentity,
        successorCommentId: successorCommentId!, commentBoundToSuccessor,
        beforeLeaseId: lease!.id, nextLeaseId: nextLease?.id,
        beforeBoxId: lease!.providerLeaseId, nextBoxId: nextLease?.providerLeaseId,
        expectedSteps, actualFirstTurn: first.turn, actualFirstInputSteps: first.completed, pressAt, cancelledAt, drainedAt, sendAt,
        requestAt: first.at, firstTokenWrittenAt: first.firstTokenWrittenAt,
        cancelRouteMs: cancelledAt - pressAt, drainMs: drainedAt - pressAt, sendToRequestMs: first.at - sendAt };
      observations.push(observation);
      stage("BOUNDARY OBSERVATION", observation);
      await writeFile(join(root, "observations.json"), JSON.stringify(observations, null, 2));
      expect(commentBoundToSuccessor, "the FIRST successor is bound to the newly authorized comment").toBe(true);
      expect(first.turn, "the FIRST successor input carries the newly authorized message").toBe(press);
      if (fallback) {
        if (scenario === "FILESTOP-fallback" || forgedProof || restartHook) {
          expect(nextLease?.providerLeaseId, "unqualified Stop requires a different physical allocation").not.toBe(lease!.providerLeaseId);
          expect(live.piPid, "unqualified Stop cannot reuse the old Pi").not.toBe(pid.piPid);
          expect(first.fileBeforeTools?.exists, "fresh box makes no stopped-file promise").toBe(false);
          stage("FILESTOP FALLBACK",  { qualified, fileBeforeTools: first.fileBeforeTools,
            fileSurvived: first.fileBeforeTools?.base64 === fileBytes.toString("base64"),
            firstInputRetainsWrite: first.completed.includes(1), originalIdentity, actualIdentity });
        }
        if (scenario === "R-fallback") {
          expect(observation.forceFreshSession).toBe(true);
          expect(live.piPid).not.toBe(pid.piPid);
          stage("FALLBACK GREEN", observation);
        }
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
        if (filestop) {
          expect(first.fileBeforeTools?.exists, validationFails ? "R6 failed stamp validation restores host seed, losing stopped files" : "file exists on the box BEFORE successor's first tool").toBe(!validationFails);
          if (!validationFails) expect(first.fileBeforeTools?.base64, "completed write survives Stop byte-for-byte before any successor tool").toBe(fileBytes.toString("base64"));
        }
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
    if (!fallback) expect(actualSteps, "finished steps are never rerun; Stop does not resume work")
      .toEqual((scenario === "R-stop" || filestop ? [1, 2] : [1, 2, 3, 4, 5, 6]).map(step => `STEP${step}`));
    if (filestop) {
      const readResult = requests.find(row => row.turn === 1 && row.completed.includes(2));
      const readOutput = readResult?.input.find(item => item.type === "function_call_output" && JSON.stringify(item.output).includes(`${fact}_STEP2`));
      if (!fallback && !validationFails) expect(readOutput?.output, "authorized successor really read the completed file").toContain(fileBytes.toString("utf8"));
      await writeFile(join(root, "filestop-result.json"), JSON.stringify({ scenario, qualified: observations[0]?.qualified,
        expectedBase64: fileBytes.toString("base64"), fileBeforeTools: requests.find(row => row.fileBeforeTools)?.fileBeforeTools,
        fileSurvived: requests.find(row => row.fileBeforeTools)?.fileBeforeTools?.base64 === fileBytes.toString("base64"),
        readOutput, observations }, null, 2));
    }
    if (scenario === "FILESTOP-late-export") {
      // R1 uses the same legacy native-sync path as FILESTOP, not the unrelated
      // modern remote-workspace snapshot service. A late completion must not
      // replace the successor's published stamp.
      const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, admitted.id));
      const environment = (await db.select().from(environments).where(eq(environments.id, environmentId)))[0]!;
      const { environmentRuntimeService } = await import("../services/environment-runtime.js");
      const { resolveEnvironmentExecutionTarget } = await import("../services/environment-execution-target.js");
      const target = await resolveEnvironmentExecutionTarget({ db, companyId, adapterType: "paperclip_runner", environment,
        leaseId: source!.id, leaseMetadata: source!.metadata, lease: source!, environmentRuntime: environmentRuntimeService(db) });
      const stampPath = join(remoteWorkspace, ".paperclip-runtime", "paperclip-runner", "workspace-sync-v1.json");
      const newerStamp = JSON.parse(await readFile(stampPath, "utf8"));
      expect(newerStamp.finalizedRunId).toBe(current.id);
      const { resumeNativeWorkspaceSync } = await import("../services/native-runtime/native-workspace-sync.js");
      let completed = false, exportError: string | undefined;
      try { completed = await resumeNativeWorkspaceSync({ db, runId: admitted.id, target: target! }); }
      catch (error) { exportError = error instanceof Error ? error.message : String(error); }
      const lateStamp = JSON.parse(await readFile(stampPath, "utf8"));
      const successorBytes = await readFile(join(remoteWorkspace, "successor.txt"), "utf8");
      const [lateRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id));
      const custody = { completed, exportError, newerStamp, lateStamp, successorBytes, olderExport: lateRun?.runnerProfileJson?.nativeWorkspaceSync };
      await writeFile(join(root, "R1-late-export.json"), JSON.stringify(custody, null, 2));
      stage("R1 late native export after successor snapshot", custody);
      expect(completed, "pending predecessor export completes").toBe(true);
      expect(successorBytes).toBe("successor file wins\n");
      expect(lateStamp, "a late predecessor export cannot overwrite the newer successor stamp").toEqual(newerStamp);
    }
    for (const observation of observations) {
      const request = requests.find(value => value.at === observation.requestAt)!;
      expect(request.firstTokenWrittenAt, "actual successor first-token socket write observed").toBeDefined();
      expect(request.deliveredAt, "actual successor first-word live-event delivery observed").toBeDefined();
      const modelTtftMs = request.firstTokenWrittenAt! - request.at;
      const firstDeliveredMs = request.deliveredAt! - Number(observation.sendAt);
      Object.assign(observation, { firstTokenWrittenAt: request.firstTokenWrittenAt, deliveredAt: request.deliveredAt,
        modelTtftMs, firstDeliveredMs, overheadMs: firstDeliveredMs - modelTtftMs });
      stage("Timing evidence (R7 under-2s gate is FILESTOP-fast-question)", observation);
    }
    await writeFile(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    if (scenario === "FILESTOP-fast-question") {
      const observation = observations[0]!;
      const answers = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
        .filter(row => row.authorAgentId === agentId && row.body.includes("T1F_SIX_STEPS_DONE_1"));
      const acceptance = { ...observation, answerCount: answers.length,
        gapUnder2s: Number(observation.sendToRequestMs) < 2000,
        sameDatabaseLeaseId: observation.beforeLeaseId === observation.nextLeaseId,
        sameProviderLeaseId: observation.beforeBoxId === observation.nextBoxId };
      await writeFile(join(root, "R7-fast-question.json"), JSON.stringify(acceptance, null, 2));
      stage("R7 literal acceptance", acceptance);
      expect(answers).toHaveLength(1);
      expect(observation.sendToRequestMs, "R7 send-to-provider-turn gap is under 2 seconds").toBeLessThan(2000);
      expect(observation.nextLeaseId, "R7 literal same database lease id").toBe(observation.beforeLeaseId);
    }
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
    if (db && companyId) {
      const { closeWarmNativeSessionsForEnvironment } = await import("../services/native-runtime/native-session-executor.js");
      const ownedLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId));
      const cleanup = [];
      for (const environmentId of new Set(ownedLeases.map(row => row.environmentId))) {
        cleanup.push(await closeWarmNativeSessionsForEnvironment({ environmentId,
          reason: "owned FILESTOP fixture teardown", forceStopUnsettled: true, db })
          .catch(error => ({ error: String(error) })));
      }
      await writeFile(join(root, "cleanup-warm-owners.json"), JSON.stringify(cleanup, null, 2));
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
