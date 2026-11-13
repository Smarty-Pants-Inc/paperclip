import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, agentWakeupRequests, agentTaskSessions, nativeRunFinalizations, issues as issueRows } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

// Explicit-only real server/DB/runnerd/proxy/Pi regression.
// Keep reason: data safety at the native persistence boundary. A private fact
// must survive done -> comment reopen across three separately published runs.
// Only the loopback model is scripted; no paid provider or daily-work claim.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";
const protocol = process.env.PAPERCLIP_PI_E2E_PROTOCOL ?? "messages";
const lifecycleMode = process.env.PAPERCLIP_PI_E2E_LIFECYCLE ?? "warm";

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

it.skipIf(!enabled).each([false, true, "invalid", "foreign", "runner-root", "legacy-pre-spawn"] as const)(`three done/comment-reopened turns (saved file missing=%s, lifecycle=${lifecycleMode}, thinking=${thinking})`, async savedFile => {
  const legacyPreSpawn = savedFile === "legacy-pre-spawn";
  const replacedRunnerRoot = savedFile === "runner-root" || legacyPreSpawn;
  const missingFile = savedFile === true || replacedRunnerRoot;
  const invalidFile = savedFile === "invalid" || savedFile === "foreign";
  let preservedBytes: Buffer | undefined;
  let originalSessionFile: string | undefined;
  expect(["warm", "per_turn"]).toContain(lifecycleMode);
  expect(thinking).toBe("xhigh");
  expect(protocol).toBe("messages");
  expect(process.env.TMPDIR, "dedicated test tmpdir is required").toBeTruthy();
  if (process.platform !== "linux") throw new Error("This real PID proof requires Linux");
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH)
    throw new Error("Set absolute PAPERCLIP_RUNNER_BINARY and PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to qualified local artifacts");
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-continuing-"));
  await writeFile(join(root, "fixture.json"), JSON.stringify({ savedFile, lifecycleMode, thinking, protocol }, null, 2));
  const privateFact = `PI_PRIVATE_MEMORY_${randomUUID()}`;
  const freshFact = `PI_FRESH_MEMORY_${randomUUID()}`;
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
    stages.push(row); console.log(`[pi-full-server] ${name} ${JSON.stringify(detail,
      (key, value) => key === "contextSnapshot" || key === "prompt" ? "[omitted from logs]" : value)}`);
  };
  const bundles: Bundle[] = [];
  const requests: Array<{ path: string; model: unknown; lastMessage: unknown; messages: unknown[]; remembersPrivateFact: boolean; remembersFreshFact: boolean; tools: string[] }> = [];
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let helloProbeRequests = 0;
  let activeTurn = 1;
  const turnProofs: Array<Record<string, unknown>> = [];
  const expectedPreSpawnFailures = new Set<string>();
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
        const failure = runs.find(run => !expectedPreSpawnFailures.has(run.id) && (run.status === "failed" || run.status === "timed_out"));
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
    const ownerAlarm = vi.spyOn((await import("../middleware/logger.js")).logger, "error");
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
        const latest = parsed.messages?.at(-1);
        const isToolResult = latest?.role === "user" && Array.isArray(latest.content)
          && latest.content.some((part: { type: string }) => part.type === "tool_result");
        const remembersPrivateFact = (parsed.messages ?? []).some((message: { role: string; content: unknown }) =>
          message.role === "assistant" && JSON.stringify(message.content).includes(privateFact));
        const remembersFreshFact = (parsed.messages ?? []).some((message: { role: string; content: unknown }) =>
          message.role === "assistant" && JSON.stringify(message.content).includes(freshFact));
        if (missingFile && activeTurn === 3) {
          expect(remembersFreshFact, "third turn continues the new private history").toBe(true);
          expect(JSON.stringify(latest), "fresh fact is not replayed in the new input").not.toContain(freshFact);
        }
        requests.push({ path: req.url!, model: parsed.model, lastMessage: latest,
          messages: parsed.messages ?? [], remembersPrivateFact, remembersFreshFact,
          tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? "") });
        let contract: { revision: string; criteria: Array<{ id: string }> } | undefined;
        for (const message of parsed.messages ?? []) {
          if (message.role !== "user") continue;
          for (const part of typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? []) {
            if (part.type !== "text") continue;
            try {
              // The provider may prepend its owned cold-start directive after history
              // loss; the native envelope after it must stay intact and parseable.
              const envelopeStart = part.text.indexOf('{"schema":"paperclip.native-');
              const value = JSON.parse(envelopeStart < 0 ? part.text : part.text.slice(envelopeStart));
              if (value.completionContract) contract = value.completionContract;
              if (value.schema === "paperclip.native-continuation.v1" && value.completion)
                contract = { revision: value.completion.revision, criteria: value.completion.criterionIds.map((id: string) => ({ id })) };
            } catch { /* not a native envelope */ }
          }
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        let index = 0;
        const textBlock = (text: string) => {
          emit("content_block_start", { index, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index, delta: { type: "text_delta", text } });
          emit("content_block_stop", { index: index++ });
        };
        const isFinishResult = isToolResult && latest.content.some((part: { type: string; tool_use_id?: string }) =>
          part.type === "tool_result" && part.tool_use_id === `finish-${activeTurn}`);
        const completedReads = new Set((parsed.messages ?? []).filter((message: { role: string }) => message.role === "assistant")
          .flatMap((message: { content: unknown }) => Array.isArray(message.content) ? message.content : [])
          .filter((part: { type: string }) => part.type === "tool_use").map((part: { name: string }) => part.name));
        const nextRead = legacyPreSpawn && activeTurn === 2 ? ["get_task_context", "get_task_history", "read_document"].find(name => !completedReads.has(name)) : undefined;
        if (nextRead) {
          // The recovered thread has to execute these real tools before even
          // private assistant text, never just mention a reread in its answer.
          const input = nextRead === "read_document" ? { key: "plan" } : {};
          emit("content_block_start", { index, content_block: { type: "tool_use", id: `cold-read-${nextRead}`, name: nextRead, input: {} } });
          emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
          emit("content_block_stop", { index });
        } else if (legacyPreSpawn ? !isFinishResult : !isToolResult) {
          // The fact originates ONLY in the first assistant response and is not
          // published in the first final chat reply or any Paperclip tool result.
          textBlock(activeTurn === 1 ? `Private fact: ${privateFact}` : missingFile && activeTurn === 2 ? `Fresh private fact: ${freshFact}` : "Completing the reopened issue.");
          if (!contract) throw new Error("Model request lacks the current completion contract");
          const input = { reportedWorkDisposition: "done", summary: `Turn ${activeTurn} complete`,
            evidence: [{ ref: "provider:pi_rpc:agent-message" }], verification: [], attentionRequests: [], artifacts: [],
            completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
              criteria: contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: ["provider:pi_rpc:agent-message"] })), remainingWork: [] } };
          emit("content_block_start", { index, content_block: { type: "tool_use", id: `finish-${activeTurn}`, name: "paperclip_finish", input: {} } });
          emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
          emit("content_block_stop", { index });
        } else {
          textBlock(activeTurn === 1 ? "TURN_1_PUBLISHED"
            : missingFile && activeTurn === 3 && remembersFreshFact ? `TURN_3_RECALLED_${freshFact}`
            : remembersPrivateFact ? `TURN_${activeTurn}_RECALLED_${privateFact}` : `TURN_${activeTurn}_HISTORY_LOST`);
        }
        emit("message_delta", { delta: { stop_reason: (legacyPreSpawn ? isFinishResult : isToolResult) ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } });
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
      // Local idle runner loss normally retires this transport. For the
      // invalid-file cell, use the existing reconnect policy to reach real
      // runnerd restore + thread/resume under the full server (no RPC fakes).
      // This is local execution, not remote-target qualification.
      const bundle = realFactory(invalidFile ? { ...options, runnerReconnectGraceMs: 10_000 } : options);
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
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", cwd: workspace, model: "paperclip/faux", lifecycleMode, piRpcThinkingLevel: thinking, env: adapterEnv },
      runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false, wakeOnDemand: true } },
    });
    expect(patched.adapterConfig).toMatchObject({ provider: "pi_rpc", lifecycleMode, piRpcThinkingLevel: thinking, model: "paperclip/faux" });
    expect(patched.lifecycleState).toBe("ready");
    stage("PATCH 200", { agentId, lifecycleState: patched.lifecycleState, adapterConfig: patched.adapterConfig });
    const issue = await api("POST", `/companies/${companyId}/issues`, {
      title: "Three continuing native Pi turns", description: "Keep a private assistant fact, complete the issue, and answer the board.",
      status: "backlog", assigneeAgentId: agentId,
    }, 201);
    issueId = issue.id;
    if (legacyPreSpawn) await api("PUT", `/issues/${issueId}/documents/plan`, {
      title: "Recovery acceptance plan", format: "markdown", body: "Read the actual task, history and this plan before answering the recovered turn.",
    }, 201);
    const { heartbeatService } = await import("../services/heartbeat.js");
    let replayedRecoveryNotices = 0;
    if (missingFile || invalidFile) {
      const projection = await import("../services/native-runtime/pi-session-recovery-notice.js");
      const materialize = projection.materializePiSessionRecoveryNotice;
      vi.spyOn(projection, "materializePiSessionRecoveryNotice").mockImplementation(async input => {
        await materialize(input);
        if (!projection.piSessionRecovery(input.event)
          && !JSON.stringify(input.event.payload).includes("pi_session_file_invalid")) return;
        // Replay the exact real receipt concurrently against the live DB,
        // including a repeat after the first projection already committed.
        await Promise.all([materialize(input), materialize(input)]);
        replayedRecoveryNotices += 2;
      });
    }
    const previousRuns: string[] = [];
    for (activeTurn = 1; activeTurn <= 3; activeTurn++) {
      if (missingFile && activeTurn === 2) {
        // Close the settled resident through the production restart boundary.
        // The next real runner must thread/resume, not reuse an in-memory Pi.
        const { closeIdleWarmNativeSessionsForRestart } = await import("../services/native-runtime/native-session-executor.js");
        // per_turn already retired the settled resident at the end of turn 1;
        // only a warm lifecycle still has an idle Pi to close here.
        expect(await closeIdleWarmNativeSessionsForRestart()).toEqual({ closed: lifecycleMode === "per_turn" ? 0 : 1, busy: 0, failed: 0 });
        const files = turnProofs[0]!.sessionFiles as string[];
        if (replacedRunnerRoot) {
          // A replacement computer has none of the old runner/controller/Pi
          // bytes. Preserve the complete old allocation as evidence, never
          // seed the replacement with its control-plane state or backup.
          await rename(join(root, "runner-state"), join(root, "replaced-runner-state"));
          await mkdir(join(root, "runner-state"));
          stage("runner root replaced with empty allocation", { files, previousPids: turnProofs[0]!.pids });
          if (legacyPreSpawn) {
            const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, turnProofs[0]!.runId as string));
            const sourceExecution = source!.runnerProfileJson!.nativeExecutionInput as { binding: Record<string, unknown>; session: Record<string, unknown> };
            for (let n = 0; n < 2; n++) {
              const failedId = randomUUID(), failedSessionId = randomUUID();
              const createdAt = new Date();
              expectedPreSpawnFailures.add(failedId); previousRuns.push(failedId);
              const failedProfile = { ...source!.runnerProfileJson, sessionCheckpoint: null, nativeControllerRecovery: null,
                nativeExecutionInput: { ...sourceExecution, binding: { ...sourceExecution.binding, runId: failedId },
                  session: { ...sourceExecution.session, normalizedSessionId: failedSessionId } } };
              await db.insert(heartbeatRuns).values({ id: failedId, companyId, agentId, issueId, nativeIssueId: issueId,
                status: "failed", runtimeMode: "native", nativePhase: "terminal_failure", nativeSessionId: failedSessionId,
                runnerInstanceId: randomUUID(), createdAt, finishedAt: createdAt,
                contextSnapshot: { issueId, conversationSessionGeneration: source!.contextSnapshot?.conversationSessionGeneration },
                runnerProfileJson: failedProfile, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
                errorCode: "native_continuation_requires_reconciliation" });
              await db.insert(nativeRunFinalizations).values({ runId: failedId, companyId, issueId, phase: "terminal_failure",
                attempt: 0, controllerGeneration: 0, failureCode: "native_continuation_requires_reconciliation" });
              await db.update(agentTaskSessions).set({ lastRunId: failedId, sessionParamsJson: { sessionId: failedSessionId } })
                .where(eq(agentTaskSessions.taskKey, issueId));
              stage("SUPPLEMENTARY pre-spawn fixture; not a production coordinator claim", { failedId, failedSessionId, attempt: 0, controllerGeneration: 0 });
            }
          }
        } else {
          for (const file of files) await unlink(file); // turn-1 snapshots retain the deleted history
          stage("saved Pi file deleted after resident shutdown", { files, previousPids: turnProofs[0]!.pids });
        }
      }
      if (invalidFile && activeTurn === 2) {
        originalSessionFile = (turnProofs[0]!.sessionFiles as string[])[0]!;
        const original = readFileSync(originalSessionFile, "utf8");
        if (savedFile === "foreign") {
          const [header, ...entries] = original.split("\n");
          preservedBytes = Buffer.from([JSON.stringify({ ...JSON.parse(header!), id: randomUUID() }), ...entries].join("\n"));
        } else {
          preservedBytes = Buffer.concat([Buffer.from(original), Buffer.from("{corrupt Pi history between turns}\n")]);
        }
        await writeFile(originalSessionFile, preservedBytes);
        // Under per_turn the settled runner already exited after turn 1, so the
        // next turn cold-opens the corrupted file with no kill or restore. A warm
        // lifecycle keeps the resident, which must die so the restore reads the file.
        const residentRunner = (turnProofs[0]!.pids as Array<{ runnerPid?: number }> | undefined)?.[0]?.runnerPid;
        if (lifecycleMode !== "per_turn") {
          expect(residentRunner).toBeTypeOf("number");
          process.kill(residentRunner!, "SIGKILL");
          await vi.waitFor(() => expect(bundles[0]!.evidence().diagnostics).toContain("runner process restored its durable PRP session"), { timeout: 20_000, interval: 50 });
        }
        stage(lifecycleMode === "per_turn" ? "saved Pi file corrupted; next turn cold-opens it" : "saved Pi file corrupted; original runner killed and restored", { savedFile, originalSessionFile,
          sha256: createHash("sha256").update(preservedBytes).digest("hex"), oldPids: turnProofs[0]!.pids });
      }
      const requestOffset = requests.length;
      const before = await api("GET", `/issues/${issueId}`);
      expect(before.status).toBe(activeTurn === 1 ? "backlog" : "done");
      // No prior fact is ever present in the incoming message.
      const body = activeTurn === 1
        ? "Invent and privately remember a fact. Finish the issue via paperclip_finish, then publish TURN_1_PUBLISHED."
        : `Reopen for turn ${activeTurn}. Recall the private fact from your own earlier assistant history; finish the issue and publish your recall.`;
      expect(body).not.toContain(privateFact);
      const inbound = await api("POST", `/issues/${issueId}/comments`, { body, clientRequestId: randomUUID() }, 201);
      const admitted = await waitFor(`turn ${activeTurn} admitted`, async () =>
        (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
          .find(run => run.nativeIssueId === issueId && !previousRuns.includes(run.id)) ?? null);
      if (activeTurn === 3) {
        const comments = await api("GET", `/issues/${issueId}/comments`) as Array<typeof issueComments.$inferSelect>;
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        await writeFile(join(root, "comments-next-turn-admitted.json"), JSON.stringify(comments, null, 2));
        await writeFile(join(root, "runs-next-turn-admitted.json"), JSON.stringify(runs, null, 2));
        const notices = comments.filter(comment => /^(pi_session_file_missing|pi_session_file_invalid):/.test(comment.metadata?.authorizationReason ?? ""));
        expect(notices, "exactly one durable notice survives the next real admission").toHaveLength(missingFile || invalidFile ? 1 : 0);
      }
      try {
        await waitFor(`turn ${activeTurn} settled`, async () => {
          const [run] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id));
          return run?.status === "succeeded" ? run : null;
        });
      } catch (error) {
        if (replacedRunnerRoot && activeTurn === 2) {
          // Preserve both real incident observations on RED: the first failed
          // resume and the plain next message's controller-recovery result.
          await heartbeatService(db).waitForRunExecutionDrain(admitted.id, { timeoutMs: 15_000 });
          await api("POST", `/issues/${issueId}/comments`, { body: "Please continue this same conversation.", clientRequestId: randomUUID() }, 201);
          await vi.waitFor(async () => {
            const later = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
              .find(run => run.nativeIssueId === issueId && run.id !== admitted.id && !previousRuns.includes(run.id));
            expect(later).toBeDefined();
            expect(["succeeded", "failed", "timed_out"]).toContain(later!.status);
            stage("next message after failed replacement", { runId: later!.id, status: later!.status, error: later!.error });
          }, { timeout: 120_000, interval: 250 });
        }
        throw error;
      }
      await heartbeatService(db).waitForRunExecutionDrain(admitted.id, { timeoutMs: 15_000 });
      const reply = await waitFor(`turn ${activeTurn} final reply published`, async () =>
        (await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
          .find(row => row.createdByRunId === admitted.id && row.authorAgentId === agentId
            && row.body.startsWith(`TURN_${activeTurn}_`) && row.deletedAt === null) ?? null);
      const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.id));
      const [closed] = await db.select().from(issueRows).where(eq(issueRows.id, issueId));
      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, admitted.id));
      if (legacyPreSpawn && activeTurn === 2) {
        // Native PRP calls are durably recorded as execution events, not in
        // the legacy adapter's tool_invocations table.
        const tools = events.filter(event => event.eventType.startsWith("tool.execution."))
          .sort((a, b) => a.seq - b.seq).map(event => ({ seq: event.seq, eventType: event.eventType,
            ...(event.payload?.prpEvent as { payload: { name: string; status: string; executionId: string; output: string } }).payload }));
        const calls = tools.filter(event => event.eventType === "tool.execution.started");
        expect(calls.slice(0, 3).map(call => call.name), "fresh thread's FIRST calls reread its actual task/history/plan").toEqual([
          "get_task_context", "get_task_history", "read_document",
        ]);
        const completed = calls.slice(0, 3).map(call => tools.find(event => event.executionId === call.executionId && event.eventType === "tool.execution.completed"));
        expect(completed.every(call => call?.status === "completed"), "all cold reads must complete before the answer").toBe(true);
        expect(completed[0]!.output).toContain(issueId);
        expect(completed[1]!.output).toContain("TURN_1_PUBLISHED");
        expect(completed[2]!.output).toContain("Recovery acceptance plan");
        expect(calls[3]!.name).toBe("paperclip_finish");
        expect(completed.every(call => call!.seq < calls[3]!.seq), "read completions precede finish and final answer").toBe(true);
        await writeFile(join(root, "cold-first-tool-calls.json"), JSON.stringify(tools, null, 2));
      }
      const [taskSession] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, issueId));
      const conversation = taskSession?.sessionParamsJson?.__paperclipPiConversation;
      expect(conversation).toMatchObject({ id: settled!.nativeSessionId, generation: 1 });
      const pids = bundles.flatMap(bundle => {
        const info = bundle.transport.processInfo?.();
        return info?.pid ? [{ runnerPid: info.pid, piPid: piDescendant(info.pid) }] : [];
      }).filter(pair => pair.piPid !== null);
      // Warm is the ordinary acceptance journey: retain the same real Pi PID.
      // An explicit per_turn diagnostic can also observe saved-file recovery.
      const findSessionFiles = (directory: string): string[] => {
        if (!existsSync(directory)) return [];
        return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
          const path = join(directory, entry.name);
          return entry.isDirectory() ? findSessionFiles(path)
            : entry.isFile() && entry.name === `${settled!.nativeSessionId}.jsonl` ? [path] : [];
        });
      };
      const sessionFiles = [...new Set([...pids.map(pair => readSessionFile(pair.piPid!)), ...findSessionFiles(join(root, "runner-state"))])];
      expect(sessionFiles, "real Pi durably saved the conversation").not.toHaveLength(0);
      for (const [i, file] of sessionFiles.entries()) await writeFile(join(root, `pi-session-turn-${activeTurn}-${i}.jsonl`), readFileSync(file));
      const currentRequests = requests.slice(requestOffset);
      const row = { turn: activeTurn, inboundCommentId: inbound.id, runId: settled!.id,
        status: settled!.status, nativeSessionId: settled!.nativeSessionId, conversation, issueStatus: closed!.status,
        piNativeSessionId: JSON.parse(readFileSync(sessionFiles[0]!, "utf8").split("\n")[0]!).id,
        reply: reply.body, pids, sessionFiles, contextSnapshot: settled!.contextSnapshot,
        wakeups, startupReuseEvents: events.filter(event => event.eventType === "run.startup.reuse"),
        nativeProcessStartEvents: events.filter(event => event.eventType === "native.process_start_requested"),
        responsePublicationEvents: events.filter(event => event.eventType.startsWith("run.response_publication.")),
        assistantHistoryRecall: currentRequests[0]?.remembersPrivateFact ?? false,
        freshHistoryRecall: currentRequests[0]?.remembersFreshFact ?? false,
        latestInputContainsFact: JSON.stringify(currentRequests[0]?.lastMessage).includes(privateFact) };
      turnProofs.push(row);
      await writeFile(join(root, "turns.json"), JSON.stringify(turnProofs, null, 2));
      stage(`turn ${activeTurn} done and published`, row);
      expect(settled!.status).toBe("succeeded");
      expect(closed!.status).toBe("done");
      expect(settled!.nativeSessionId).toBeTruthy();
      if (lifecycleMode === "warm") expect(pids, "warm conversation owns exactly one real Pi child").toHaveLength(1);
      if (activeTurn === 1) {
        expect(reply.body).toBe("TURN_1_PUBLISHED");
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        expect(comments.some(comment => comment.body.includes(privateFact)), "fact remains Pi-only before the reopen").toBe(false);
      } else {
        expect(settled!.contextSnapshot?.wakeReason).toBe("issue_reopened_via_comment");
        // Soft assertions preserve all three regression observations on the
        // baseline, without weakening the test's final pass/fail result.
        expect.soft(row.assistantHistoryRecall, "missing history is fresh, ordinary history is restored").toBe(!missingFile && !invalidFile);
        // Before turn 2 the fact is still Pi-only. After turn 2 it has been
        // intentionally published, so ordinary Paperclip context may include
        // that public reply on turn 3; this is not a history-loss regression.
        if (activeTurn === 2) expect.soft(row.latestInputContainsFact, "first reopen does not replay the Pi-only fact").toBe(false);
        expect.soft(reply.body).toBe(missingFile && activeTurn === 3 ? `TURN_3_RECALLED_${freshFact}`
          : missingFile || invalidFile ? `TURN_${activeTurn}_HISTORY_LOST` : `TURN_${activeTurn}_RECALLED_${privateFact}`);
        if (missingFile && activeTurn === 3) expect(row.freshHistoryRecall, "the published answer recalls the fresh Pi-only fact").toBe(true);
        expect.soft(settled!.nativeSessionId, "all three reopened turns use the SAME normalized conversation").toBe(turnProofs[0]!.nativeSessionId);
        if (invalidFile) {
          const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
          const notices = comments.filter(comment => comment.body.includes("pi_session_file_invalid"));
          expect(notices, "one visible reason across the fresh turn and its follow-up").toHaveLength(1);
          expect(notices[0]!.presentation).toMatchObject({ kind: "system_notice", tone: "warning" });
          // The observer above concurrently replays the exact committed receipt
          // while its run is current, through the same authority checks as G-2.
          const aside = readdirSync(join(originalSessionFile!, "..")).filter(name => name.startsWith(originalSessionFile!.split("/").at(-1)! + ".invalid-"));
          expect(aside, "original saved file renamed aside with a timestamp").toHaveLength(1);
          const asideFile = join(originalSessionFile!, "..", aside[0]!);
          expect(readFileSync(asideFile)).toEqual(preservedBytes);
          expect(readFileSync(originalSessionFile!, "utf8")).not.toContain("{corrupt Pi history between turns}");
          if (activeTurn === 2) {
            if (lifecycleMode === "warm") expect(pids[0]!.runnerPid).not.toBe((turnProofs[0]!.pids as typeof pids)[0]!.runnerPid);
            expect(row.piNativeSessionId).not.toBe(turnProofs[0]!.piNativeSessionId);
            expect(events.filter(event => event.eventType === "provider.notice.recorded"
              && JSON.stringify(event.payload).includes("pi_session_file_invalid")), "one durable owner diagnostic").toHaveLength(1);
          } else {
            expect(pids).toEqual(turnProofs[1]!.pids);
            expect(row.piNativeSessionId).toBe(turnProofs[1]!.piNativeSessionId);
            expect(events.filter(event => event.eventType === "provider.notice.recorded"
              && JSON.stringify(event.payload).includes("pi_session_file_invalid"))).toHaveLength(0);
          }
          const alarms = ownerAlarm.mock.calls.filter(([detail]) => typeof detail === "object"
            && detail !== null && "code" in detail && detail.code === "pi_session_file_invalid");
          expect(alarms, "one scoped owner error across recovery, replay and later turns").toHaveLength(1);
          expect(alarms[0]![0]).toMatchObject({ companyId, agentId, issueId, code: "pi_session_file_invalid" });
          stage("invalid history safely replaced", { asideFile, notice: notices[0], nativeSessionId: settled!.nativeSessionId,
            sha256: createHash("sha256").update(readFileSync(asideFile)).digest("hex"), ownerAlarm: alarms[0] });
        } else if (lifecycleMode === "warm") {
          if (missingFile && activeTurn === 2) {
            expect(pids[0]!.runnerPid).not.toBe((turnProofs[0]!.pids as typeof pids)[0]!.runnerPid);
            expect(pids[0]!.piPid).not.toBe((turnProofs[0]!.pids as typeof pids)[0]!.piPid);
          } else {
            expect.soft(pids, "the next normal turn keeps the SAME physical runner/Pi").toEqual(turnProofs[missingFile ? 1 : 0]!.pids);
          }
          for (const layer of missingFile && activeTurn === 2 ? [] : ["runner", "provider_session"]) {
            expect.soft(events, `${layer} startupReuse must be reused`).toEqual(expect.arrayContaining([
              expect.objectContaining({ eventType: "run.startup.reuse", payload: expect.objectContaining({ layer, state: "reused" }) }),
            ]));
          }
        }
      }
      // A fresh HTTP read is the same durable comments surface the chat reloads.
      const comments = await api("GET", `/issues/${issueId}/comments`) as Array<typeof issueComments.$inferSelect>;
      await writeFile(join(root, `comments-turn-${activeTurn}.json`), JSON.stringify(comments, null, 2));
      const reloaded = await api("GET", `/issues/${issueId}/comments`) as Array<typeof issueComments.$inferSelect>;
      await writeFile(join(root, `comments-turn-${activeTurn}-reloaded.json`), JSON.stringify(reloaded, null, 2));
      expect(reloaded.map(comment => comment.id), "reload reads the same durable transcript").toEqual(comments.map(comment => comment.id));
      const notices = comments.filter(comment => /^(pi_session_file_missing|pi_session_file_invalid):/.test(comment.metadata?.authorizationReason ?? ""));
      expect(notices).toHaveLength((missingFile || invalidFile) && activeTurn >= 2 ? 1 : 0);
      if (notices.length) {
        if (missingFile) expect(notices[0]!.body).toBe("My earlier conversation could not be restored: the saved Pi conversation file is missing on this computer. Starting a new one.");
        else expect(notices[0]!.body).toContain("pi_session_file_invalid");
        expect(notices[0]!.presentation).toMatchObject({ kind: "system_notice", tone: "warning" });
        // Run-owned notices become historical at Done / next admission. This
        // transcript boundary must instead keep its audit link in the details.
        expect.soft(notices[0]!.createdByRunId, "reloaded recovery notice is not ephemeral run status").toBeNull();
        expect(notices[0]!.metadata?.sections).toEqual(expect.arrayContaining([
          expect.objectContaining({ rows: expect.arrayContaining([expect.objectContaining({ type: "run_link" })]) }),
        ]));
      }
      previousRuns.push(admitted.id);
    }
    expect(turnProofs).toHaveLength(3);
    if (missingFile || invalidFile) expect(replayedRecoveryNotices).toBeGreaterThan(0);
    if (replacedRunnerRoot) {
      const alarms = ownerAlarm.mock.calls.filter(([detail]) => typeof detail === "object"
        && detail !== null && "code" in detail && detail.code === "pi_session_file_missing");
      expect(alarms, "one scoped missing-history owner alarm across recovery and its next turn").toHaveLength(1);
      expect(alarms[0]![0]).toMatchObject({ companyId, agentId, issueId, code: "pi_session_file_missing" });
    }
    stage("all three observations retained", { companyId, agentId, issueId, replayedRecoveryNotices, turnProofs });
  } catch (error) {
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ stages, requests, turnProofs }, null, 2) + "\n");
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
    // Retire registry-owned residents before closing their test transports;
    // otherwise a later case inherits a stale warm-session registry entry.
    const { closeIdleWarmNativeSessionsForRestart } = await import("../services/native-runtime/native-session-executor.js");
    await closeIdleWarmNativeSessionsForRestart();
    for (const bundle of bundles) await bundle.transport.close().catch(error => console.error("Owned runner teardown", error));
    await app?.locals.paperclipShutdown?.();
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    if (modelServer) { modelServer.closeAllConnections(); await new Promise<void>(resolve => modelServer!.close(() => resolve())); }
    await stopRetainedPostgres?.();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    console.log(`[pi-full-server] evidence retained at ${root}`);
  }
}, 600_000);
