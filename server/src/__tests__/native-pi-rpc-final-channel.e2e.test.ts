import { createHash, randomUUID } from "node:crypto";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, createDb, heartbeatRuns, heartbeatRunEvents, agentWakeupRequests } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";


// Explicit-only, real process/user-flow qualification. No paid model, sandbox,
// backend, HTTP-route, database or runner doubles. Keep reason: the hq native Pi
// incidents escaped component tests at PATCH, launch selection and attempt gates.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
// off is an explicitly labelled diagnostic stand-in, never xhigh qualification.
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";
const protocol = "messages";

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

it.skipIf(!enabled)(`labels every final answer through the real Pi server path (thinking=${thinking})`, async () => {
  expect(["off", "xhigh"]).toContain(thinking);
  if (process.platform !== "linux") throw new Error("This real PID proof requires Linux");
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH)
    throw new Error("Set absolute PAPERCLIP_RUNNER_BINARY and PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH to qualified local artifacts");
  const root = await mkdtemp(join(tmpdir(), "native-pi-full-server-"));
  const stages: Array<{ at: string; stage: string; detail: unknown }> = [];
  const stage = (name: string, detail: unknown = {}) => {
    const row = { at: new Date().toISOString(), stage: name, detail };
    stages.push(row); console.log(`[pi-full-server] ${name} ${JSON.stringify(detail)}`);
  };
  const bundles: Bundle[] = [];
  let activeCase = 0;
  const proofs: any[] = [];
  const failures: string[] = [];
  const requests: Array<{ path: string; model: unknown; lastMessage: unknown; tools: string[] }> = [];
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let modelServer: Server | undefined, http: Server | undefined;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let companyId = "", agentId = "", issueId = "";
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const adapterEnv = {};
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
      let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const shape = ["plain", "finish-text", "text-finish"][Math.floor(activeCase / 3)]!;
        const answer = `FINAL_CHANNEL_${activeCase}_${shape}`;
        const latest = parsed.messages?.at(-1);
        const isToolResult = latest?.role === "user" && Array.isArray(latest.content) && latest.content.some((p: any) => p.type === "tool_result");
        requests.push({ path: req.url ?? "", model: parsed.model, lastMessage: latest, tools: (parsed.tools ?? []).map((t: any) => t.name) });
        let contract: any;
        for (const message of parsed.messages ?? []) {
          if (message.role !== "user") continue;
          for (const part of typeof message.content === "string" ? [{type:"text",text:message.content}] : message.content ?? []) {
            if (part.type !== "text") continue;
            try { const v = JSON.parse(part.text); if (v.completionContract) contract = v.completionContract;
              if (v.schema === "paperclip.native-continuation.v1" && v.completion) contract = {revision:v.completion.revision, criteria:v.completion.criterionIds.map((id:string)=>({id}))}; } catch {}
          }
        }
        const finish = shape !== "plain" && !isToolResult;
        res.writeHead(200, {"content-type":"text/event-stream"});
        const emit = (type: string, value: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
        emit("message_start", {message:{id:`channel-${requests.length}`,type:"message",role:"assistant",model:"faux",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:7,output_tokens:0}}});
        let index = 0;
        const textBlock = (text: string) => {
          emit("content_block_start", {index,content_block:{type:"text",text:""}});
          emit("content_block_delta", {index,delta:{type:"text_delta",text}});
          emit("content_block_stop", {index:index++});
        };
        if (finish) {
          if (shape === "text-finish") textBlock(answer);
          else textBlock(`WORKING_${activeCase}`);
          const input = {reportedWorkDisposition:"done",summary:answer,evidence:[{ref:"provider:pi_rpc:agent-message"}],verification:[],attentionRequests:[],artifacts:[],completionClaim:{contractRevision:contract.revision,objectiveSatisfied:true,criteria:contract.criteria.map((c:any)=>({criterionId:c.id,status:"satisfied",evidenceRefs:["provider:pi_rpc:agent-message"]})),remainingWork:[]}};
          emit("content_block_start", {index,content_block:{type:"tool_use",id:`finish-${activeCase}`,name:"paperclip_finish",input:{}}});
          emit("content_block_delta", {index,delta:{type:"input_json_delta",partial_json:JSON.stringify(input)}});
          emit("content_block_stop", {index});
        } else if (shape !== "text-finish") textBlock(answer);
        emit("message_delta", {delta:{stop_reason:finish?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:4}});
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
    const api = async (method: string, path: string, body?: unknown, expected = 200) => {
      const response = await fetch(`${apiUrl}/api${path}`, { method, headers: { "content-type": "application/json", origin: apiUrl }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
    const { heartbeatService } = await import("../services/heartbeat.js");
    for (activeCase = 0; activeCase < 9; activeCase++) {
      const shape = ["plain", "finish-text", "text-finish"][Math.floor(activeCase / 3)]!;
      const answer = `FINAL_CHANNEL_${activeCase}_${shape}`;
      const issue = await api("POST", `/companies/${companyId}/issues`, {title:answer,description:"Reply with the scripted final answer.",status:"todo",assigneeAgentId:agentId},201);
      issueId = issue.id;
      const admitted = await waitFor("case admitted", async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agentId))).find(r=>r.nativeIssueId===issueId) ?? null);
      const processes = await waitFor("real Pi descendant", async () => {
        for (const bundle of bundles) {
          const info = bundle.transport.processInfo?.();
          if (typeof info?.pid !== "number") continue;
          const piPid = piDescendant(info.pid);
          if (piPid) return { runnerPid: info.pid, piPid };
        }
        return null;
      });
      await waitFor("case terminal", async () => {
        const [run] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,admitted.id));
        return ["succeeded","failed","cancelled","timed_out"].includes(run!.status) ? run : null;
      });
      await heartbeatService(db!).waitForRunExecutionDrain(admitted.id,{timeoutMs:15000});
      const [run] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,admitted.id));
      const events = (await db!.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,admitted.id))).sort((a,b)=>a.seq-b.seq);
      const completed = events.flatMap(event=>{const p=(event.payload as any)?.prpEvent;return p?.eventType==="item.completed"&&p.payload?.kind==="agentMessage"?[{seq:event.seq,...p.payload}]:[];});
      const final = completed.at(-1);
      const proof = {case:activeCase,shape,answer,processes,run,completed,events}; proofs.push(proof);
      if (run?.status!=="succeeded" || final?.channel!=="final" || final?.text!==answer) failures.push(`${activeCase}/${shape}: ${run?.status}, outer channel=${final?.channel}, text=${final?.text}`);
      if (completed.some(item=>String(item.text).startsWith("WORKING_")&&item.channel!=="progress")) failures.push(`${activeCase}: intermediate text was not progress`);
      stage("case result",{case:activeCase,shape,status:run?.status,channel:final?.channel,text:final?.text});
      await writeFile(join(root,"channel-proof.json"),JSON.stringify({proofs,failures},null,2));
    }
    expect(failures).toEqual([]);
    stage("GREEN",{cases:9});
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
}, 900_000);
