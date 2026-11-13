import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, agentWakeupRequests, agentTaskSessions, nativeRunFinalizations } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

// Explicit-only regression adapted from H8S's real-server Stop/warm proof.
// Keep reason: data safety; Stop must not discard Pi's private conversation.
// Real HTTP routes, Postgres, runnerd, proxy, pinned Pi; scripted loopback model.
// No model credentials, sandbox qualification, or native-home fixture claim.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";
const protocol = process.env.PAPERCLIP_PI_E2E_PROTOCOL ?? "messages";
const loseIdleOwner = process.env.PAPERCLIP_PI_E2E_LOSE_IDLE_OWNER === "1";
const flushAfterStop = true;
const refusalCases = process.env.PAPERCLIP_PI_E2E_FORCE_CHECKPOINT_REFUSAL === undefined
  ? [false, true] : [process.env.PAPERCLIP_PI_E2E_FORCE_CHECKPOINT_REFUSAL === "1"];

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

it.skipIf(!enabled).each(refusalCases)(`Stop preserves Pi-only history through warm and cold turns (forced checkpoint refusal=%s, thinking=${thinking})`, async forceRefusal => {
  expect(thinking).toBe("xhigh");
  expect(protocol).toBe("messages");
  expect(process.env.TMPDIR, "dedicated test tmpdir is required").toBeTruthy();
  if (process.platform !== "linux") throw new Error("This real PID proof requires Linux");
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH)
    throw new Error("Set absolute PAPERCLIP_RUNNER_BINARY and PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to qualified local artifacts");
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-stop-continue-"));
  const privateFact = `PI_PRIVATE_MEMORY_${randomUUID()}`;
  const readSessionFile = (piPid: number) => {
    const args = readFileSync(`/proc/${piPid}/cmdline`, "utf8").split("\0");
    const at = args.indexOf("--session");
    if (at >= 0 && args[at + 1]) return args[at + 1]!;
    // Pi changes process.title after startup, overwriting /proc/cmdline.
    // Its inherited, runner-owned binding still identifies the exact file.
    const environment = Object.fromEntries(readFileSync(`/proc/${piPid}/environ`, "utf8").split("\0")
      .filter(Boolean).map(entry => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
    if (!environment.PAPERCLIP_PI_RUNTIME_DIR || !environment.PAPERCLIP_NORMALIZED_SESSION_ID)
      throw new Error("Pi session binding missing from both argv and environment");
    return join(environment.PAPERCLIP_PI_RUNTIME_DIR, `${environment.PAPERCLIP_NORMALIZED_SESSION_ID}.jsonl`);
  };
  const stages: Array<{ at: string; stage: string; detail: unknown }> = [];
  const stage = (name: string, detail: unknown = {}) => {
    const row = { at: new Date().toISOString(), stage: name, detail };
    stages.push(row); console.log(`[pi-full-server] ${name} ${JSON.stringify(detail)}`);
  };
  const bundles: Bundle[] = [];
  const authorities: import("../vendor/paperclip-runner/index.js").DurablePrpControlPlane[] = [];
  let postStopCheckpointError: unknown;
  let rejectCheckpoints = false;
  const expectedRefusals = new Set<string>();
  const requests: Array<{ path: string; model: unknown; lastMessage: unknown; messages: unknown[]; remembersPrivateFact: boolean; tools: string[] }> = [];
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let helloProbeRequests = 0;
  let replyCount = 0;
  let modelServer: Server | undefined, http: Server | undefined;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let companyId = "", agentId = "", issueId = "";
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const adapterEnv = { TMPDIR: process.env.TMPDIR! };
  // The test never needs or inherits the operator's native home or telemetry.
  for (const key of Object.keys(process.env)) if (key.startsWith("LANGFUSE_")) vi.stubEnv(key, undefined);
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
        const failure = runs.find(run => !expectedRefusals.has(run.id) && (run.status === "failed" || run.status === "timed_out"));
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
        const useTool = requests.length === 0;
        // The fact is generated only in the first MODEL response. Never send it
        // in a task, comment, tool result, instruction, or subsequent user turn.
        const remembersPrivateFact = (parsed.messages ?? []).some((message: { role: string; content: unknown }) =>
          message.role === "assistant" && JSON.stringify(message.content).includes(privateFact));
        requests.push({ path: req.url!, model: parsed.model, lastMessage: parsed.messages?.at(-1),
          messages: parsed.messages ?? [], remembersPrivateFact,
          tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? "") });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        if (useTool) {
          const input = { command: `echo $$ > ${join(root, "bash.pid")}; sleep 60; echo SHOULD_NOT_RUN > ${join(root, "after-stop.txt")}` };
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: `Private memory fact: ${privateFact}` } });
          emit("content_block_stop", { index: 0 });
          emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-stop-sleep", name: "bash", input: {} } });
          emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
          stage("faux model called bash sleep 60", input);
        } else {
          replyCount++;
          const reply = replyCount === 1 || replyCount === 3
            ? remembersPrivateFact ? privateFact : "HISTORY_LOST"
            : `LOCAL_PI_FULL_SERVER_REPLY_${replyCount}`;
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
    // Keep the real production transport and process owner. The harness adds
    // the real remote DB checkpoint writer to local execution; the refusal
    // variant injects only a bounded storage outage, never a replay result.
    vi.spyOn(runner, "createRunnerdCodexTransport").mockImplementation(options => {
      stage("transport kind=pi_rpc", { provider: options?.provider, thinking: options?.piRpcThinkingLevel });
      expect(options?.provider).toBe("pi_rpc"); expect(options?.piRpcThinkingLevel).toBe(thinking);
      const registration = options?.controlPlaneRegistration;
      const bundle = realFactory(!flushAfterStop ? options : { ...options, controlPlaneRegistration: async (authority, identity, signal) => {
        // Local transport normally persists only files. Install the exact real
        // remote DB writer to exercise REG-30 without a sandbox or paid model.
        // No result/fence is forged: the full server owns these coordinators.
        if (!authorities.includes(authority)) {
          authorities.push(authority);
          // Remote admission restores a local projection from the DB. This
          // local-process harness instead mirrors each *committed* checkpoint
          // so its ordinary local prior-owner verifier can inspect that state.
          const install = authority.setCheckpointPersistence.bind(authority);
          vi.spyOn(authority, "setCheckpointPersistence").mockImplementation(persist => install(async checkpoint => {
            if (rejectCheckpoints) throw Object.assign(new Error("REG-30 forced checkpoint outage"), { code: "ECONNREFUSED" });
            await persist(checkpoint);
            checkpoint.restoreSessionDirectory(dirname(dirname(authority.store.path)));
          }));
        }
        const current = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
          .find(run => run.status === "running");
        if (!current) throw new Error("REG-30: no active server authority");
        const [owner] = await db!.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, current.id));
        const { registerNativeRunnerCheckpoint } = await import("../services/native-runtime/native-runner-checkpoint.js");
        await registerNativeRunnerCheckpoint({ db: db!, authority, bootId: owner!.controllerBootId!, authorityRunId: current.id,
          binding: { companyId, issueId, runId: identity?.runId ?? current.id } });
        return registration ? registration(authority, identity, signal) : { release: () => undefined };
      } }); bundles.push(bundle); return bundle;
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
    const admitted = await waitFor("run admitted", async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).find(run => run.runtimeMode === "native") ?? null);
    stage("run admitted", { runId: admitted.id, status: admitted.status, runtimeMode: admitted.runtimeMode });
    const pid = await waitFor("runnerd session up / Pi PID", async () => {
      for (const bundle of bundles) { const process = bundle.transport.processInfo?.(); if (process?.pid) { const pid = piDescendant(process.pid); if (pid) return { runnerPid: process.pid, piPid: pid }; } }
      return null;
    });
    const originalSessionFile = readSessionFile(pid.piPid);
    stage("runnerd session up", { runnerPid: pid.runnerPid }); stage("Pi PID", { pid: pid.piPid, sessionFile: originalSessionFile });
    const readPiEnvironment = () => Object.fromEntries(readFileSync(`/proc/${pid.piPid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
    const launchEnvironment = readPiEnvironment();
    stage("AGENT_HOME proc at launch", { piPid: pid.piPid, agentHome: launchEnvironment.AGENT_HOME || "EMPTY", tmpdir: launchEnvironment.TMPDIR || "EMPTY" });
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
    expect(readFileSync(originalSessionFile, "utf8"), "Pi durably saved the private fact before Stop").toContain(privateFact);
    await writeFile(join(root, "pi-session-before-stop.jsonl"), readFileSync(originalSessionFile));
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).some(row => row.body.includes(privateFact)),
      "the private fact must not be in the Paperclip thread").toBe(false);
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
    expect(alive(pid.piPid), "clean board Stop keeps the original Pi alive after run drain").toBe(true);
    expect(alive(pid.runnerPid), "clean board Stop keeps the original runnerd warm").toBe(true);
    expect(existsSync(join(root, "after-stop.txt")), "cancelled command cannot run its trailing effect").toBe(false);
    expect(readFileSync(originalSessionFile, "utf8")).toContain(privateFact);
    stage("Pi session file intact after Stop", { sessionFile: originalSessionFile, nativeSessionId: stopped.nativeSessionId,
      taskSessions: await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId)) });
    if (flushAfterStop) {
      const authority = authorities.at(-1)!;
      expect(authority, "the retained runner has the real fenced DB checkpoint writer").toBeDefined();
      authority.issueBootstrapTicket(5_000); // maintenance write, no provider work
      try { await authority.flushCheckpoint(); }
      catch (error) { postStopCheckpointError = error; }
      stage("post-Stop real checkpoint flush", { error: postStopCheckpointError instanceof Error ? postStopCheckpointError.message : null,
        connections: authority.activeRunnerConnectionCount() });
    }
    if (forceRefusal) {
      rejectCheckpoints = true;
      const authority = authorities.at(-1)!;
      authority.issueBootstrapTicket(5_000);
      await expect(authority.flushCheckpoint()).rejects.toThrow("REG-30 forced checkpoint outage");
      await waitFor("real repeated checkpoint failure latches integrity refusal", async () =>
        bundles.at(-1)!.evidence().diagnostics.some(text => text.includes("runner_event_commit_stalled")) ? true : null, 90_000);
      await api("POST", `/issues/${issueId}/comments`, { body: "First message during the checkpoint outage: recall your private fact." }, 201);
      const refused = await waitFor("actual checkpoint-stall integrity refusal", async () => {
        const run = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
          .find(run => run.id !== admitted.id && run.status === "failed");
        return run ?? null;
      });
      expect(refused.errorCode).toBe("native_event_replay_conflict");
      expect(refused.error).toContain("runner_event_commit_stalled");
      await heartbeatService(db).waitForRunExecutionDrain(refused.id, { timeoutMs: 30_000 });
      expectedRefusals.add(refused.id);
      rejectCheckpoints = false;
      stage("forced integrity refusal preserved; NEXT message must recover", { runId: refused.id, errorCode: refused.errorCode,
        originalRunnerAlive: alive(pid.runnerPid), originalPiAlive: alive(pid.piPid) });
      expect(alive(pid.runnerPid)).toBe(false);
      expect(alive(pid.piPid)).toBe(false);
    }
    await api("POST", `/issues/${issueId}/comments`, { body: "Recall the private memory fact you said before Stop. Reply with that fact only; no tool needed." }, 201);
    const reply = await waitFor("NEW turn after Stop completes", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find(row => row.authorAgentId === agentId && (row.body.includes(privateFact) || row.body.includes("HISTORY_LOST"))) ?? null;
    });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const next = runs.find(run => run.id !== admitted.id && !expectedRefusals.has(run.id))!;
    expect(next, "a NEW run, not continuation of stopped run").toBeDefined();
    await heartbeatService(db).waitForRunExecutionDrain(next.id, { timeoutMs: 15_000 });
    const final = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.id)))[0]!;
    const newPids = bundles.map(bundle => { const info = bundle.transport.processInfo?.(); return { runnerPid: info?.pid, piPid: info?.pid ? piDescendant(info.pid) : null }; });
    stage("NEW turn completed after Stop", { runId: final.id, status: final.status, old: pid, newPids, reply: reply.body,
      oldNativeSessionId: stopped.nativeSessionId, nativeSessionId: final.nativeSessionId, originalSessionFile });
    expect(final.status).toBe("succeeded");
    expect(postStopCheckpointError, "retained-idle maintenance persists after Stop without disconnecting the runner").toBeUndefined();
    const replacement = newPids.find(value => value.piPid !== null)!;
    expect(replacement, "the new wake owns a real resident Pi").toBeDefined();
    if (forceRefusal) {
      expect(replacement.piPid).not.toBe(pid.piPid);
      expect(replacement.runnerPid).not.toBe(pid.runnerPid);
    } else {
      expect(replacement.piPid).toBe(pid.piPid);
      expect(replacement.runnerPid).toBe(pid.runnerPid);
    }
    const replacementSessionFile = readSessionFile(replacement.piPid!);
    stage("history continuity proof", { oldNativeSessionId: stopped.nativeSessionId, nativeSessionId: final.nativeSessionId,
      originalSessionFile, replacementSessionFile, remembersPrivateFact: requests[1]?.remembersPrivateFact, reply: reply.body });
    await writeFile(join(root, "pi-session-after-reopen.jsonl"), readFileSync(replacementSessionFile));
    expect(final.nativeSessionId, "Stop preserves the logical Pi conversation").toBe(stopped.nativeSessionId);
    expect(replacementSessionFile, "warm reuse or proven cold recovery keeps the exact original file").toBe(originalSessionFile);
    expect(requests[1]?.remembersPrivateFact, "resident Pi sends its private assistant history to the model").toBe(true);
    expect(JSON.stringify(requests[1]?.lastMessage), "Paperclip did not replay the secret into the new wake").not.toContain(privateFact);
    expect(reply.body).toContain(privateFact);
    // The next ordinary turn must still reuse the replacement process.
    await api("POST", `/issues/${issueId}/comments`, { body: "Another normal turn: reply with the next local faux token, no tool." }, 201);
    const warmReply = await waitFor("warm turn after replacement", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find(row => row.authorAgentId === agentId && row.body.includes("LOCAL_PI_FULL_SERVER_REPLY_2")) ?? null;
    });
    const warm = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).find(run => run.id !== admitted.id && run.id !== final.id && !expectedRefusals.has(run.id))!;
    expect(warm).toBeDefined();
    await heartbeatService(db).waitForRunExecutionDrain(warm.id, { timeoutMs: 15_000 });
    const settledWarm = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, warm.id)))[0]!;
    expect(settledWarm.status).toBe("succeeded");
    expect(settledWarm.nativeSessionId).toBe(final.nativeSessionId);
    expect(piDescendant(replacement.runnerPid!)).toBe(replacement.piPid);
    expect(existsSync(join(root, "after-stop.txt"))).toBe(false);
    expect(alive(sleepPid)).toBe(false);
    expect(requests).toHaveLength(3);
    stage("replacement stays warm", { ...replacement, runId: settledWarm.id, nativeSessionId: settledWarm.nativeSessionId, reply: warmReply.body });
    // Stop no longer retires a healthy resident. Exercise the genuine cold
    // reopen boundary; the explicit lost-owner leg kills only our exact PID.
    if (loseIdleOwner) {
      process.kill(replacement.runnerPid!, "SIGKILL");
      await waitFor("lost idle runner exited", async () => alive(replacement.runnerPid!) ? null : true);
      stage("idle owner lost before close", { runnerPid: replacement.runnerPid, piAlive: alive(replacement.piPid!) });
    }
    const { closeIdleWarmNativeSessionsForRestart } = await import("../services/native-runtime/native-session-executor.js");
    const closure = await closeIdleWarmNativeSessionsForRestart();
    expect(closure).toEqual({ closed: 1, busy: 0, failed: 0 });
    expect(alive(replacement.piPid!)).toBe(false);
    expect(alive(replacement.runnerPid!)).toBe(false);
    await api("POST", `/issues/${issueId}/comments`, { body: "Recall the private memory fact again after the idle session closed." }, 201);
    const coldReply = await waitFor("cold wake after controller-restart closure", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find(row => row.authorAgentId === agentId && row.id !== reply.id &&
        (row.body.includes(privateFact) || row.body.includes("HISTORY_LOST"))) ?? null;
    });
    const coldRun = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .find(run => ![admitted.id, final.id, warm.id].includes(run.id) && !expectedRefusals.has(run.id))!;
    expect(coldRun).toBeDefined();
    await heartbeatService(db).waitForRunExecutionDrain(coldRun.id, { timeoutMs: 15_000 });
    const settledCold = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, coldRun.id)))[0]!;
    expect(settledCold.status).toBe("succeeded");
    expect(settledCold.nativeSessionId).toBe(stopped.nativeSessionId);
    const coldPids = bundles.map(bundle => { const info = bundle.transport.processInfo?.();
      return info?.pid ? { runnerPid: info.pid, piPid: piDescendant(info.pid) } : null; }).find(value => value?.piPid)!;
    expect(coldPids.piPid).not.toBe(replacement.piPid);
    expect(coldPids.runnerPid).not.toBe(replacement.runnerPid);
    expect(readSessionFile(coldPids.piPid!)).toBe(originalSessionFile);
    expect(requests[3]?.remembersPrivateFact).toBe(true);
    expect(coldReply.body).toContain(privateFact);
    expect(requests).toHaveLength(4);
    expect(requests.every(request => request.model === "faux")).toBe(true);
    stage("idle/restart cold-open continuity", { ...coldPids, closure, nativeSessionId: settledCold.nativeSessionId,
      sessionFile: readSessionFile(coldPids.piPid!), reply: coldReply.body });
    const finalClosure = await closeIdleWarmNativeSessionsForRestart();
    expect(finalClosure, "release this case's final warm owner before closing its database").toEqual({ closed: 1, busy: 0, failed: 0 });
    stage("GREEN", { companyId, agentId, issueId, requests: requests.length, cancelMs, retired: pid, replacement, coldPids, bashPid, sleepPid, finalClosure });
  } catch (error) {
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ stages, requests }, null, 2) + "\n");
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
    await app?.locals.paperclipShutdown?.();
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    if (modelServer) { modelServer.closeAllConnections(); await new Promise<void>(resolve => modelServer!.close(() => resolve())); }
    await stopRetainedPostgres?.();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    console.log(`[pi-full-server] evidence retained at ${root}`);
  }
}, 600_000);
