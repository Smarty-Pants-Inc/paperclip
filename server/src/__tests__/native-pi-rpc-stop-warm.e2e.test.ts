import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, agentWakeupRequests } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";
import { prepareNativePiHomeProof, readNativePiHomeProof, assertNativePiHomeProof } from "./helpers/native-pi-home-load-proof.js";

// Explicit-only real process/user flow; faux model, real HTTP route/DB/runner/Pi.
// Desired contract: real Stop cancels bash, not the resident; the next run
// recalls assistant-only history on the same Pi PID and native session ID.
// This is not a sandbox/remote-target qualification and uses no paid model.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";
const protocol = process.env.PAPERCLIP_PI_E2E_PROTOCOL ?? "messages";

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

// REG-03 (prod I-8g run df2cf036): after a Stop the retained runner's attach
// failed and the plain follow-up died. With killRetainedRunner the retained
// runnerd is SIGKILLed after the Stop; Core must retire it and resume the same
// conversation once on a NEW runner from its checkpoint, visibly.
async function stopWarmProof(stopTurn: number, killRetainedRunner = false) {
  expect(thinking).toBe("xhigh");
  expect(protocol).toBe("messages");
  expect(process.env.TMPDIR, "dedicated test tmpdir is required").toBeTruthy();
  expect(process.env.PAPERCLIP_PI_E2E_HOME_FIXTURE).toBeTruthy();
  if (process.platform !== "linux") throw new Error("This real PID proof requires Linux");
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH)
    throw new Error("Set absolute PAPERCLIP_RUNNER_BINARY and PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to qualified local artifacts");
  const root = await mkdtemp(join(tmpdir(), "native-pi-stop-warm-"));
  const stages: Array<{ at: string; stage: string; detail: unknown }> = [];
  const stage = (name: string, detail: unknown = {}) => {
    const row = { at: new Date().toISOString(), stage: name, detail };
    stages.push(row); console.log(`[pi-full-server] ${name} ${JSON.stringify(detail)}`);
  };
  const bundles: Bundle[] = [];
  const assistantFact = `ASSISTANT_ONLY_STOP_FACT_${randomUUID()}`;
  const requests: Array<{ path: string; model: unknown; lastMessage: unknown; tools: string[]; recalledAssistantFact: boolean }> = [];
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let helloProbeRequests = 0;
  let replyCount = 0;
  let warmupCount = 0;
  const warmupRunIds = new Set<string>();
  const warmupIdentities: Array<{ runId: string; nativeSessionId: string | null; runnerPid: number; piPid: number }> = [];
  let modelServer: Server | undefined, http: Server | undefined;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let companyId = "", agentId = "", issueId = "";
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const homeFixture = process.env.PAPERCLIP_PI_E2E_HOME_FIXTURE;
  const nativeHomeProof = homeFixture ? await prepareNativePiHomeProof(root, homeFixture) : undefined;
  const adapterEnv = nativeHomeProof ? { PI_CODING_AGENT_DIR: nativeHomeProof.agentDir, PI_LANGFUSE_DEBUG: "true", TMPDIR: process.env.TMPDIR! } : {};
  if (nativeHomeProof) {
    for (const key of Object.keys(process.env)) if (key.startsWith("LANGFUSE_")) vi.stubEnv(key, undefined);
    stage("native Pi fixture prepared", nativeHomeProof);
  }
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
      req.on("end", () => {
        if (new URL(req.url ?? "", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
        const parsed = JSON.parse(body);
        if (respondToNativePiHello(parsed, res, "messages")) {
          helloProbeRequests++; stage("faux model answered setup hello", { helloProbeRequests }); return;
        }
        if (warmupCount < stopTurn - 1) {
          warmupCount++;
          res.writeHead(200, { "content-type": "text/event-stream" });
          const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
          emit("message_start", { message: { id: `warmup-${warmupCount}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } });
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: `WARMUP_${warmupCount}` } });
          emit("content_block_stop", { index: 0 });
          emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
          emit("message_stop", {}); res.end(); return;
        }
        const useTool = requests.length === 0;
        requests.push({ path: req.url!, model: parsed.model, lastMessage: parsed.messages?.at(-1),
          tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? ""),
          recalledAssistantFact: (parsed.messages ?? []).some((message: { role: string; content: unknown }) => message.role === "assistant" && JSON.stringify(message.content).includes(assistantFact)) });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        if (useTool) {
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: assistantFact } });
          emit("content_block_stop", { index: 0 });
          const input = { command: `echo $$ > ${join(root, "bash.pid")}; sleep 60; echo SHOULD_NOT_RUN > ${join(root, "after-stop.txt")}` };
          emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-stop-sleep", name: "bash", input: {} } });
          emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
          stage("faux model called bash sleep 60", input);
        } else {
          const reply = `LOCAL_PI_FULL_SERVER_REPLY_${++replyCount} ${requests.at(-1)!.recalledAssistantFact ? assistantFact : "HISTORY_LOST"}`;
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
        }
        emit("content_block_stop", { index: useTool ? 1 : 0 });
        emit("message_delta", { delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
        emit("message_stop", {}); res.end();
      });
    });
    await new Promise<void>(resolve => modelServer!.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("No faux model listener");
    const baseUrl = `http://127.0.0.1:${modelAddress.port}${protocol === "messages" ? "" : "/v1"}`;
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
      const bundle = realFactory(options); bundles.push(bundle); return bundle;
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
      const response = await fetch(`${apiUrl}/api${path}`, { method, headers: { "content-type": "application/json", origin: apiUrl }, signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      expect(response.status, `${method} ${path}: ${text}`).toBe(expected);
      return JSON.parse(text);
    };
    const company = await api("POST", "/companies", { name: "Local native Pi full-server proof" }, 201);
    companyId = company.id;
    await api("PATCH", `/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "local-board", name: "Local proof operator", email: "local-pi@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    unsubscribe = subscribeCompanyLiveEvents(companyId, () => changed?.());
    const connection = await api("POST", `/companies/${companyId}/ai-connections`, {
      provider: protocol === "messages" ? "anthropic" : "openai", method: "api_key", name: "Loopback faux only", ownership: "personal", routing: {
        kind: "local", protocol, baseUrl, auth: "none", models: [{ id: "faux", label: "Local faux", thinkingLevels: [thinking] }],
      },
    }, 201);
    stage("fixed AI connection created", connection);
    const binding = { mode: "delegated", provider: protocol === "messages" ? "anthropic" : "openai", method: "api_key", connectionId: connection.connectionId, grantId: connection.grantId };
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
    const issue = await api("POST", `/companies/${companyId}/issues`, { title: "Reply through native Pi", description: "Reply with the local faux token.", status: "todo", assigneeAgentId: agentId }, 201);
    issueId = issue.id;
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
    const bashPid = await waitFor("bash tool actually started", async () => {
      const native = nativeHomeProof ? readNativePiHomeProof(nativeHomeProof.receiptPath) : null;
      if (!native?.toolExecutions.some((event: any) => event.type === "tool_execution_start" && event.toolName === "bash")) return null;
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
    expect(requests[0]!.tools).toContain("subagent");
    expect(requests[0]!.tools).toContain("paperclip_finish");
    stage("native Pi fixture load proof before Stop", await assertNativePiHomeProof(nativeHomeProof!, pid.piPid));
    const nativeSessionIdBeforeStop = readNativePiHomeProof(nativeHomeProof!.receiptPath)!.sessionId;
    await writeFile(join(root, "native-home-before-stop.json"), JSON.stringify(readNativePiHomeProof(nativeHomeProof!.receiptPath), null, 2));
    const alive = (value: number) => {
      try { return readFileSync(`/proc/${value}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z"; }
      catch { return false; }
    };
    expect(alive(bashPid)).toBe(true);
    stage("Stop before real cancel route", { ...pid, bashPid, sleepPid });
    const started = Date.now();
    const cancelled = await api("POST", `/heartbeat-runs/${admitted.id}/cancel`, {}, 200, 5000);
    const stopped = await waitFor("cancelled run within 5 seconds", async () => {
      const run = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id)))[0];
      return run?.status === "cancelled" ? run : null;
    }, Math.max(1, 5000 - (Date.now() - started)));
    const cancelMs = Date.now() - started;
    stage("Stop route returned and run cancelled", { runId: stopped.id, status: stopped.status, cancelMs, routeStatus: cancelled.status,
      bashAlive: alive(bashPid), residentAlive: alive(pid.piPid), runnerAlive: alive(pid.runnerPid) });
    expect(cancelMs, "real cancel route + persisted cancelled status in 5s").toBeLessThan(5000);
    await waitFor("bash and sleep processes gone", async () => alive(bashPid) || alive(sleepPid) ? null : true, Math.max(1, 5000 - (Date.now() - started)));
    stage("bash and sleep gone within Stop budget", { bashPid, sleepPid, elapsedMs: Date.now() - started });
    const { heartbeatService } = await import("../services/heartbeat.js");
    await heartbeatService(db).waitForRunExecutionDrain(admitted.id, { timeoutMs: 15_000 });
    stage("Stop drained before NEW wake", { residentAlive: alive(pid.piPid), runnerAlive: alive(pid.runnerPid), bashAlive: alive(bashPid), bundles: bundles.length });
    expect(alive(pid.piPid), "Stop must keep Pi alive after server run drain, before harness teardown").toBe(true);
    expect(alive(pid.runnerPid), "Stop must keep the original runnerd warm").toBe(true);
    expect(existsSync(join(root, "after-stop.txt")), "cancelled command cannot run its trailing effect").toBe(false);
    if (killRetainedRunner) {
      process.kill(pid.runnerPid, "SIGKILL");
      await waitFor("retained runnerd killed", async () => alive(pid.runnerPid) ? null : true, 10_000);
      stage("retained runnerd SIGKILLed after Stop", { runnerPid: pid.runnerPid, residentAlive: alive(pid.piPid) });
    }
    await api("POST", `/issues/${issueId}/comments`, { body: "New turn after Stop: reply with the next local faux token. No tool needed." }, 201);
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
    const warmAttachFailures = (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, final.id)))
      .filter(event => event.eventType === "native.warm_attach.failed");
    const replacement = newPids.find(value => value.piPid !== null && (!killRetainedRunner || value.runnerPid !== pid.runnerPid))!;
    if (killRetainedRunner) {
      expect(replacement, "the follow-up runs on a NEW runner and Pi").toBeDefined();
      expect(replacement.runnerPid).not.toBe(pid.runnerPid);
      expect(replacement.piPid).not.toBe(pid.piPid);
      expect(alive(pid.runnerPid)).toBe(false);
      expect(alive(pid.piPid), "the retired runner's Pi was reaped, not left running").toBe(false);
      expect(warmAttachFailures, "the failed warm attach is visible exactly once").toHaveLength(1);
      expect(warmAttachFailures[0]!.payload).toMatchObject({ schema: "paperclip.warm-attach-failure.v1", layer: "runner",
        state: "warm_attach_failed_cold_fallback" });
      stage("warm attach failed; cold fallback on a NEW runner", { old: pid, replacement, event: warmAttachFailures[0]!.payload });
    } else {
      expect(replacement, "next run uses the same healthy resident").toBeDefined();
      expect(replacement.piPid).toBe(pid.piPid);
      expect(replacement.runnerPid).toBe(pid.runnerPid);
      expect(warmAttachFailures).toHaveLength(0);
    }
    expect(readNativePiHomeProof(nativeHomeProof!.receiptPath)!.sessionId).toBe(nativeSessionIdBeforeStop);
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
    stage("native Pi fixture load proof on replacement", await assertNativePiHomeProof(nativeHomeProof!, replacement.piPid!));
    stage("GREEN", { companyId, agentId, issueId, requests: requests.length, cancelMs, original: pid, resident: replacement, nativeSessionId: nativeSessionIdBeforeStop, assistantHistoryRecalled: true, bashPid, sleepPid });
  } catch (error) {
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ stopTurn, killRetainedRunner, warmupIdentities, stages, requests }, null, 2) + "\n");
    await writeFile(join(root, "remote-pack-verification.json"), JSON.stringify(packVerificationCommands, null, 2) + "\n");
    if (db && agentId) {
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
    if (nativeHomeProof && stages.some(row => row.stage === "GREEN")) {
      const final = readNativePiHomeProof(nativeHomeProof.receiptPath);
      expect(final?.extensionErrors, "no native extension_error through teardown").toEqual([]);
      expect(final?.networkRequests.filter((request: any) => request.method === "POST" && !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(request.origin)), "no external POST through native teardown").toEqual([]);
      await writeFile(join(root, "native-pi-home-load-proof.final.json"), JSON.stringify(final, null, 2) + "\n");
    }
    await app?.locals.paperclipShutdown?.();
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    if (modelServer) { modelServer.closeAllConnections(); await new Promise<void>(resolve => modelServer!.close(() => resolve())); }
    await stopRetainedPostgres?.();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    console.log(`[pi-full-server] evidence retained at ${root}`);
  }
}

it.skipIf(!enabled).each([1, 2, 3])(`Stop in turn %s mid-bash keeps the same resident/session and assistant history (thinking=${thinking})`,
  stopTurn => stopWarmProof(stopTurn), 600_000);

it.skipIf(!enabled)(`REG-03: a Stop, a killed retained runnerd, then a plain message resumes the same session on a new runner (thinking=${thinking})`,
  () => stopWarmProof(1, true), 600_000);
