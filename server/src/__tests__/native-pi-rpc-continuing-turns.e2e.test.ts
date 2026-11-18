import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, agentWakeupRequests } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { prepareNativePiHomeProof } from "./helpers/native-pi-home-load-proof.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

// Explicit-only full-server regression for the Boat continuing-turn incident.
// Existing features first: doc/execution-semantics.md:2712-2714 documents a
// Board comment reopening completed work; doc/CLI.md:466 documents comment
// --reopen. Drive the real comment route (implicit human reopen), not a PATCH.
// Keep reason: recorded production catch; b17 failed turn 2 with
// native_restart_recovery_blocked/native_retry_source_superseded, then turn 3
// with native_session_recovery_failed: runner_remote_authority_archive_failed.
// Default: b13 deliberately creates a new conversation after Done. STRICT adds
// identity/history and physical warm-process continuity for I-2' images;
// it never weakens default checks. Healthy warm turns retain both processes
// (doc/execution-semantics.md:4828); reuse receipts are documented in
// doc/run-log-events.md:23-53. Logical session IDs alone do not prove warmth.
// Real HTTP, Postgres, runnerd, official provider pack, Pi and home fixture;
// only the credential-free loopback model is scripted. Not a Boat transport proof.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const strict = process.env.PAPERCLIP_PI_E2E_CONTINUING_STRICT === "1";
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";
const protocol = process.env.PAPERCLIP_PI_E2E_PROTOCOL ?? "messages";
type Bundle = ReturnType<typeof import("../vendor/paperclip-runner/index.js").createRunnerdCodexTransport>;
// Same physical evidence source as native-pi-rpc-full-server.e2e.test.ts:
// transport.processInfo() identifies runnerd; /proc descendants identify Pi.
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


it.skipIf(!enabled)(`Done/comment continuing turns and a fresh turn after failure (strict=${strict}, thinking=${thinking})`, async () => {
  expect(thinking).toBe("xhigh"); expect(protocol).toBe("messages");
  expect(process.env.TMPDIR, "dedicated test tmpdir is required").toBeTruthy();
  if (process.platform !== "linux") throw new Error("Native full-server proof requires Linux");
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH)
    throw new Error("Set qualified PAPERCLIP_RUNNER_BINARY and PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH");
  const root = await mkdtemp(join(process.env.PAPERCLIP_PI_E2E_EVIDENCE ?? tmpdir(), "native-pi-continuing-turns-"));
  const privateFact = `PI_PRIVATE_MEMORY_${randomUUID()}`;
  const stages: Array<{ at: string; stage: string; detail: unknown }> = [];
  const stage = (name: string, detail: unknown = {}) => {
    const row = { at: new Date().toISOString(), stage: name, detail };
    stages.push(row); console.log(`[pi-full-server] ${name} ${JSON.stringify(detail)}`);
  };
  const bundles: Bundle[] = [];
  const requests: Array<{ path: string; model: unknown; lastMessage: unknown; messages: unknown[]; remembersPrivateFact: boolean; tools: string[] }> = [];
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let helloProbeRequests = 0;
  let turn = 1;
  const completedFinish = new Set<number>();
  let seededPrivateFact = false;
  const allowedFailedRuns = new Set<string>();
  const seenRuns = new Set<string>();
  const seenReplies = new Set<string>();
  const turnProofs: Array<Record<string, unknown>> = [];
  let modelServer: Server | undefined, http: Server | undefined;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let companyId = "", agentId = "", issueId = "";
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const homeFixture = process.env.PAPERCLIP_PI_E2E_HOME_FIXTURE;
  expect(homeFixture, "use the same qualified home fixture as the image gate").toBeTruthy();
  const nativeHomeProof = await prepareNativePiHomeProof(root, homeFixture!);
  const adapterEnv = { PI_CODING_AGENT_DIR: nativeHomeProof.agentDir, PI_LANGFUSE_DEBUG: "true", TMPDIR: process.env.TMPDIR! };
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
        const failure = runs.find(run => !allowedFailedRuns.has(run.id) && (run.status === "failed" || run.status === "timed_out"));
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
        try {
          if (new URL(req.url ?? "", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
          const parsed = JSON.parse(body);
          if (respondToNativePiHello(parsed, res, "messages")) {
            helloProbeRequests++; stage("faux model answered setup hello", { helloProbeRequests }); return;
          }
          // The random fact exists only in the first assistant bash arguments,
          // never a task/comment/instruction, tool output or published reply.
          const remembersPrivateFact = (parsed.messages ?? []).some((message: { role: string; content: unknown }) =>
            message.role === "assistant" && JSON.stringify(message.content).includes(privateFact));
          requests.push({ path: req.url!, model: parsed.model, lastMessage: parsed.messages?.at(-1),
            messages: parsed.messages ?? [], remembersPrivateFact,
            tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? "") });
          if (turn === 4) {
            stage("injected non-retryable model failure", { turn });
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "H37C_INJECTED_MODEL_FAILURE" } }));
            return;
          }
          const useSeed = turn === 1 && !seededPrivateFact;
          const useFinish = !useSeed && !completedFinish.has(turn);
          const remembers = remembersPrivateFact ? "RECALL_OK" : "HISTORY_ABSENT";
          const reply = `CONTINUING_TURN_${turn}_${turn === 1 ? "SEEDED" : remembers}`;
          let input: Record<string, unknown> = {}, name = "", callId = "";
          if (useSeed) {
            seededPrivateFact = true; name = "bash"; callId = "call-private-memory-seed";
            input = { command: `: # ${privateFact}` };
          } else if (useFinish) {
            let contract: any;
            for (const message of parsed.messages ?? []) {
              if (message.role !== "user") continue;
              const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
              for (const part of parts) {
                if (part.type !== "text") continue;
                try { const envelope = JSON.parse(part.text); if (envelope.completionContract) contract = envelope.completionContract; } catch { /* ordinary text */ }
              }
            }
            if (!contract?.revision) throw new Error("No real completion contract in model envelope");
            completedFinish.add(turn); name = "paperclip_finish"; callId = `call-finish-turn-${turn}`;
            // Match the ordinary final-message fallback; otherwise a fixture-only
            // replay conflict can obscure the actual continuing-turn regression.
            input = { reportedWorkDisposition: "done", summary: reply, evidence: [{ ref: "provider:pi_rpc:agent-message" }],
              verification: [], attentionRequests: [], artifacts: [], completionClaim: {
                contractRevision: contract.revision, objectiveSatisfied: true,
                criteria: contract.criteria.map((criterion: any) => ({ criterionId: criterion.id, status: "satisfied", evidenceRefs: ["provider:pi_rpc:agent-message"] })), remainingWork: [],
              } };
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
          emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
          if (useSeed || useFinish) {
            emit("content_block_start", { index: 0, content_block: { type: "tool_use", id: callId, name, input: {} } });
            emit("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
          } else {
            emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
            emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
          }
          emit("content_block_stop", { index: 0 });
          emit("message_delta", { delta: { stop_reason: useSeed || useFinish ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
          emit("message_stop", {}); res.end();
          stage("faux model request", { turn, useSeed, useFinish, remembersPrivateFact });
        } catch (error) {
          stage("faux model fixture error", { error: String(error) });
          if (!res.headersSent) res.writeHead(500); res.end(String(error));
        }
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
    const { heartbeatService } = await import("../services/heartbeat.js");
    const heartbeat = heartbeatService(db);
    const issue = await api("POST", `/companies/${companyId}/issues`, {
      title: "Native Pi continuing turns", description: "Finish the requested turn and close this task using paperclip_finish.",
      status: "todo", assigneeAgentId: agentId,
    }, 201);
    issueId = issue.id;
    const forbidden = ["native_session_recovery_failed", "native_restart_recovery_blocked", "native_retry_source_superseded"];
    const assertNoRecovery = async () => {
      for (const run of await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))) {
        const events = await db!.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
        const evidence = JSON.stringify({ run, events });
        for (const code of forbidden) expect(evidence, `run ${run.id} must not enter ${code}`).not.toContain(code);
      }
    };
    const runRows = () => db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const successfulTurn = async (number: number, requestStart: number, expectReopened: boolean) => {
      const admitted = await waitFor(`turn ${number} admitted`, async () => (await runRows()).find(run => !seenRuns.has(run.id)) ?? null);
      seenRuns.add(admitted.id);
      expect(admitted.issueId).toBe(issueId);
      await waitFor(`turn ${number} succeeds and publishes`, async () => {
        const current = (await runRows()).find(run => run.id === admitted.id)!;
        const comments = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        return current.status === "succeeded" && comments.some(row => row.authorAgentId === agentId && row.body.includes(`CONTINUING_TURN_${number}_`)) ? current : null;
      });
      await heartbeat.waitForRunExecutionDrain(admitted.id, { timeoutMs: 15_000 });
      const settled = (await runRows()).find(run => run.id === admitted.id)!;
      expect(settled.status).toBe("succeeded"); expect(settled.runtimeMode).toBe("native");
      expect(settled.nativeSessionId).toBeTruthy();
      expect((await runRows()).filter(run => !seenRuns.has(run.id)), "no hidden extra/retry run").toEqual([]);
      const comments = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      const replies = comments.filter(row => row.authorAgentId === agentId && !seenReplies.has(row.id));
      expect(replies, `exactly one published agent reply for turn ${number}`).toHaveLength(1);
      expect(replies[0]!.body).toContain(`CONTINUING_TURN_${number}_`);
      seenReplies.add(replies[0]!.id);
      expect(JSON.stringify(comments), "Pi-only fact must never enter the Paperclip thread").not.toContain(privateFact);
      expect((await api("GET", `/issues/${issueId}`)).status, `answer ${number} closes the issue`).toBe("done");
      const wakes = await db!.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      const wake = wakes.find(row => row.id === settled.wakeupRequestId || row.runId === settled.id);
      if (expectReopened) expect(wake?.reason, `turn ${number} uses the real Done -> comment reopen wake`).toBe("issue_reopened_via_comment");
      const modelRequests = requests.slice(requestStart);
      expect(modelRequests.length, "real model work happened").toBeGreaterThan(0);
      // Observe the current transport, not just the first retained bundle: a
      // replacement runner must not pass because the old warm Pi is still alive.
      // Turns 4/5 deliberately exercise failure/recovery and are exempt.
      const runnerPid = strict && number <= 3 ? bundles.at(-1)?.transport.processInfo?.()?.pid ?? null : null;
      const piPid = runnerPid ? piDescendant(runnerPid) : null;
      const proof = { turn: number, runId: settled.id, status: settled.status, nativeSessionId: settled.nativeSessionId,
        runnerPid, piPid,
        wakeReason: wake?.reason, replyId: replies[0]!.id, reply: replies[0]!.body,
        remembersPrivateFact: modelRequests[0]!.remembersPrivateFact, strict };
      turnProofs.push(proof); stage("continuing turn passed", proof);
      await assertNoRecovery();
      return proof;
    };
    const first = await successfulTurn(1, 0, false);
    for (turn = 2; turn <= 3; turn++) {
      const requestStart = requests.length;
      await api("POST", `/issues/${issueId}/comments`, { body: `Turn ${turn}: recall the private fact from your Pi history, reply with the recall verdict only (not the fact), then finish done.` }, 201);
      await successfulTurn(turn, requestStart, true);
    }
    // Record all three default assertions before strict-only assertions, so a
    // strict RED still retains the complete ordinary-turn evidence.
    stage("THREE_TURNS_GREEN", { strict, turnProofs });
    if (strict) {
      expect(first.runnerPid, "STRICT: turn 1 has a real runnerd PID").toBeGreaterThan(0);
      expect(first.piPid, "STRICT: turn 1 has a real Pi descendant PID").toBeGreaterThan(0);
      for (const proof of turnProofs.slice(1)) {
        expect(proof.runnerPid, `STRICT: turn ${proof.turn} reuses the same runnerd process`).toBe(first.runnerPid);
        expect(proof.piPid, `STRICT: turn ${proof.turn} reuses the same Pi process`).toBe(first.piPid);
        const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, String(proof.runId)));
        // native.process_start_requested is an execution-attempt fence, emitted
        // even on warm run.attach (provider-attempt-outcome.ts:47-51), NOT a
        // physical launch receipt. Keep it in the evidence; prohibit actual
        // runner launch, checkpoint restore and provider resume instead.
        for (const operation of ["process_start_requested", "runner.process.launch", "session.checkpoint.restore", "provider.session.resume"]) {
          const operations = events.flatMap(event => [event.eventType, event.payload?.span,
            event.payload?.code, (event.payload?.prpEvent as { eventType?: string } | undefined)?.eventType]);
          expect(operations, `STRICT: turn ${proof.turn} must not perform ${operation}`).not.toContain(operation);
        }
        for (const layer of ["runner", "provider_session"]) {
          const receipts = events.filter(event => event.eventType === "run.startup.reuse" && event.payload?.layer === layer);
          expect(receipts.length, `STRICT: turn ${proof.turn} has ${layer} startup reuse evidence`).toBeGreaterThan(0);
          for (const receipt of receipts) expect(receipt.payload).toMatchObject({
            schema: "paperclip.startup-reuse.v1", layer, state: "reused", reason: "verified_reuse",
          });
        }
        stage("STRICT warm reuse passed", { turn: proof.turn, runId: proof.runId, runnerPid: proof.runnerPid,
          piPid: proof.piPid, startupReuse: events.filter(event => event.eventType === "run.startup.reuse").map(event => event.payload),
          nativeDispatchRequests: events.filter(event => event.eventType === "native.process_start_requested").length });
        expect(proof.nativeSessionId, "STRICT: same logical native conversation across Done/reopen").toBe(first.nativeSessionId);
        expect(proof.remembersPrivateFact, "STRICT: Pi retained the first assistant-only fact").toBe(true);
        expect(proof.reply).toContain("RECALL_OK");
      }
    }
    // Same issue, no hand-repair, Retry endpoint, session reset or DB writes:
    // force a genuine provider failure, then immediately send one user comment.
    turn = 4;
    await api("POST", `/issues/${issueId}/comments`, { body: "Exercise a failed model turn on this same task." }, 201);
    const failed = await waitFor("deliberately failed run", async () => {
      const row = (await runRows()).find(run => !seenRuns.has(run.id));
      if (!row || row.status !== "failed") return null;
      allowedFailedRuns.add(row.id); return row;
    });
    seenRuns.add(failed.id);
    await heartbeat.waitForRunExecutionDrain(failed.id, { timeoutMs: 15_000 });
    expect(JSON.stringify(failed)).toContain("H37C_INJECTED_MODEL_FAILURE");
    expect(failed.issueId).toBe(issueId);
    await assertNoRecovery();
    const commentsAfterFailure = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    // Recovery notices, if any, belong to the failed run, not the next reply.
    for (const row of commentsAfterFailure.filter(row => row.authorAgentId === agentId)) seenReplies.add(row.id);
    const requestStart = requests.length;
    turn = 5;
    await api("POST", `/issues/${issueId}/comments`, { body: "The previous model request failed. Answer this fresh comment successfully and finish done." }, 201);
    await successfulTurn(5, requestStart, false);
    expect(await runRows()).toHaveLength(5);
    stage("GREEN", { strict, companyId, agentId, issueId, failedRunId: failed.id, turnProofs });
  } catch (error) {
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ strict, stages, turnProofs, requests }, null, 2) + "\n");
    await writeFile(join(root, "remote-pack-verification.json"), JSON.stringify(packVerificationCommands, null, 2) + "\n");
    if (db && agentId) {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      await writeFile(join(root, "runs.json"), JSON.stringify(runs, null, 2));
      for (const run of runs) await writeFile(join(root, `events-${run.id}.json`), JSON.stringify(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)), null, 2));
    }
    if (db && issueId) {
      await writeFile(join(root, "comments.json"), JSON.stringify(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)), null, 2));
      await writeFile(join(root, "wakeups.json"), JSON.stringify(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)), null, 2));
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
