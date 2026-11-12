import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, agentWakeupRequests, agentTaskSessions } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Explicit-only regression adapted from H8S's real-server Stop/warm proof.
// Keep reason: data safety; Stop must not discard Pi's private conversation.
// Real HTTP routes, Postgres, runnerd, proxy, pinned Pi; scripted loopback model.
// No model credentials, sandbox qualification, or native-home fixture claim.
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

it.skipIf(!enabled)(`ASK -> ACCEPT -> CONTINUE keeps the same resident Pi and private history (thinking=${thinking})`, async () => {
  expect(thinking).toBe("xhigh");
  expect(protocol).toBe("messages");
  expect(process.env.TMPDIR, "dedicated test tmpdir is required").toBeTruthy();
  if (process.platform !== "linux") throw new Error("This real PID proof requires Linux");
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH)
    throw new Error("Set absolute PAPERCLIP_RUNNER_BINARY and PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to qualified local artifacts");
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-ask-continue-"));
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
  const requests: Array<{ path: string; model: unknown; lastMessage: unknown; messages: unknown[]; remembersPrivateFact: boolean; tools: string[] }> = [];
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let replyCount = 0;
  let humanAccepted = false;
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
        const parsed = JSON.parse(body), useTool = requests.length === 0;
        // The fact is generated only in the first MODEL response. Never send it
        // in a task, comment, tool result, instruction, or subsequent user turn.
        const remembersPrivateFact = (parsed.messages ?? []).some((message: { role: string; content: unknown }) =>
          message.role === "assistant" && JSON.stringify(message.content).includes(privateFact));
        requests.push({ path: req.url!, model: parsed.model, lastMessage: parsed.messages?.at(-1),
          messages: parsed.messages ?? [], remembersPrivateFact,
          tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? "") });
        if (!useTool && !humanAccepted && process.env.PAPERCLIP_PI_E2E_HOLD_AFTER_ASK !== "0") {
          stage("model held after ASK pending real host interrupt", { request: requests.length });
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write(": waiting for host cancellation\n\n");
          res.on("close", () => stage("pending ASK model connection closed", { humanAccepted }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        if (useTool) {
          const input = { idempotencyKey: "ladder-confirm-v1", interactionKind: "confirmation", title: "Continue the proof?", prompt: "Accept this confirmation to continue on the same Pi resident.", resolverPolicy: "human_only", continuationPolicy: "wake_assignee" };
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: `Private memory fact: ${privateFact}` } });
          emit("content_block_stop", { index: 0 });
          emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-ask-human", name: "request_human_input", input: {} } });
          emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
          stage("faux model called request_human_input", input);
        } else {
          replyCount++;
          const reply = remembersPrivateFact ? privateFact : "HISTORY_LOST";
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
    // Model hq's existing-ready agent BEFORE the production PATCH. A genuinely
    // fresh agent needs the parked C5 native setup hello; this fixture does not
    // claim that onboarding works and does not modify a product lifecycle gate.
    await db.update(agents).set({ lifecycleState: "ready", status: "idle", lifecycleHolds: [],
      lifecycleOperation: null, lifecycleError: null, lifecycleVersion: agent.lifecycleVersion + 1,
    }).where(eq(agents.id, agentId));
    stage("fixture: existing ready agent", { agentId, freshAgentVerificationCovered: false, reason: "C5 native setup hello is parked" });
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
    const { heartbeatService } = await import("../services/heartbeat.js");
    const interaction = await waitFor("durable pending confirmation", async () => {
      const cards = await api("GET", `/issues/${issueId}/interactions`);
      return cards.find((card: any) => card.kind === "request_confirmation" && card.status === "pending") ?? null;
    });
    stage("ASK saved", interaction);
    await heartbeatService(db).waitForRunExecutionDrain(admitted.id, { timeoutMs: 30_000 });
    const waitingRun = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id)))[0]!;
    const waitingEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, admitted.id));
    const alive = (value: number) => { try { return readFileSync(`/proc/${value}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z"; } catch { return false; } };
    stage("ASK interrupted and drained", { runId: waitingRun.id, status: waitingRun.status, nativeSessionId: waitingRun.nativeSessionId,
      ...pid, piAlive: alive(pid.piPid), runnerAlive: alive(pid.runnerPid), events: waitingEvents });
    expect(requests[0]!.tools).toContain("request_human_input");
    expect(waitingRun.nativeSessionId).toBeTruthy();
    stage("host interrupt acknowledgement observed", { observed: JSON.stringify(waitingEvents).includes("interrupt_acknowledgement") });
    expect(JSON.stringify(waitingEvents), "real host wait records turn cancellation").toContain("turn.cancelled");
    expect(readFileSync(originalSessionFile, "utf8")).toContain(privateFact);
    await writeFile(join(root, "pi-session-before-accept.jsonl"), readFileSync(originalSessionFile));
    const start = Date.now();
    humanAccepted = true;
    const accepted = await api("POST", `/issues/${issueId}/interactions/${interaction.id}/accept`, {});
    stage("ANSWER accepted through product route", { interactionId: interaction.id, accepted, elapsedMs: Date.now() - start });
    const reply = await waitFor("continuation reply", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find(row => row.authorAgentId === agentId && (row.body.includes(privateFact) || row.body.includes("HISTORY_LOST"))) ?? null;
    });
    const next = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).find(run => run.id !== admitted.id)!;
    expect(next, "acceptance creates the continuation run").toBeDefined();
    await heartbeatService(db).waitForRunExecutionDrain(next.id, { timeoutMs: 30_000 });
    const final = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.id)))[0]!;
    const newPids = bundles.map(bundle => { const info = bundle.transport.processInfo?.(); return { runnerPid: info?.pid, piPid: info?.pid ? piDescendant(info.pid) : null }; });
    stage("CONTINUE completed", { runId: final.id, status: final.status, error: final.error, old: pid, newPids,
      oldNativeSessionId: waitingRun.nativeSessionId, nativeSessionId: final.nativeSessionId, elapsedMs: Date.now() - start,
      reply: reply.body, remembersPrivateFact: requests.at(-1)?.remembersPrivateFact });
    expect(final.status).toBe("succeeded");
    expect(newPids.some(value => value.piPid === pid.piPid && value.runnerPid === pid.runnerPid), "continuation uses SAME Pi and runnerd").toBe(true);
    expect(final.nativeSessionId, "continuation keeps SAME native session ID").toBe(waitingRun.nativeSessionId);
    expect(readSessionFile(pid.piPid)).toBe(originalSessionFile);
    expect(requests.at(-1)?.remembersPrivateFact, "Pi supplies private assistant history").toBe(true);
    expect(JSON.stringify(requests.at(-1)?.lastMessage), "human did not replay private fact").not.toContain(privateFact);
    expect(reply.body).toContain(privateFact);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.length).toBeLessThanOrEqual(3);
    await writeFile(join(root, "pi-session-after-continue.jsonl"), readFileSync(originalSessionFile));
    stage("GREEN", { companyId, agentId, issueId, piPid: pid.piPid, runnerPid: pid.runnerPid,
      nativeSessionId: final.nativeSessionId, elapsedMs: Date.now() - start });
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
