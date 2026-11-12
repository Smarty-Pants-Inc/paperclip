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
import { prepareNativePiHomeProof, readNativePiHomeProof, assertNativePiHomeProof } from "./helpers/native-pi-home-load-proof.js";

// Explicit-only, real process/user-flow qualification. No paid model, sandbox,
// backend, HTTP-route, database or runner doubles. Keep reason: the hq native Pi
// incidents escaped component tests at PATCH, launch selection and attempt gates.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
// off is an explicitly labelled diagnostic stand-in, never xhigh qualification.
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";
const protocol = process.env.PAPERCLIP_PI_E2E_PROTOCOL ?? "responses";

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

it.skipIf(!enabled)(`runs native Pi through the full server twice on the same Pi PID (thinking=${thinking})`, async () => {
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
  const requests: Array<{ path: string; model: unknown; lastMessage: unknown; tools: string[] }> = [];
  const scriptedToolCall = process.env.PAPERCLIP_PI_E2E_TOOL_CALL === "1";
  const returnedTools: Array<Record<string, unknown>> = [];
  const packVerificationCommands: Array<Record<string, unknown>> = [];
  const bigOutputCases = (process.env.PAPERCLIP_PI_E2E_BIG_OUTPUT_BYTES ?? "300000,1500000").split(",").filter(Boolean).map(Number);
  const bigOutputProofs: Array<Record<string, unknown>> = [];
  const issuedBigCalls = new Set<string>();
  const strictCandidate = process.env.PAPERCLIP_PI_E2E_STRICT_CANDIDATE === "1";
  const expectFinishRed = process.env.PAPERCLIP_PI_E2E_EXPECT_FINISH_RED === "1";
  const includeFinish = process.env.PAPERCLIP_PI_E2E_FINISH !== "0";
  const nativeProbeProofs: Array<Record<string, unknown>> = [{ type: "fixture_adjustment", note: "Finish model tool args now match the ordinary final agent-message fallback summary/evidence. This removes a fixture-only native_event_replay_conflict; no product code or callback path is mocked." }];
  const snapshotFinishState = async (label: string) => {
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (["codex-provider-state.json", "runner-state.json"].includes(entry.name)) files.push(path);
      }
    };
    try { walk(join(root, "runner-state")); } catch { /* not launched yet */ }
    const states = files.map(path => {
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (path.endsWith("codex-provider-state.json")) return { path, pending: state.toolBridge?.pending, completed: state.toolBridge?.completed, settledResults: state.toolBridge?.settledResults };
      return { path, diagnostics: state.diagnostics, lifecycle: state.lifecycle };
    });
    const proof = { type: "finish_bridge_state", label, states };
    nativeProbeProofs.push(proof); stage(`finish bridge state ${label}`, proof);
    await writeFile(join(root, `finish-state-${label}.json`), JSON.stringify(proof, null, 2) + "\n");
    return states;
  };
  const issuedProbeCalls = new Set<string>();
  let pendingProbe: { callId: string; name: string; input: Record<string, unknown>; result?: any } | undefined;
  let pendingBigCase: { bytes: number; callId: string; command: string; expected: string; replyNumber: number } | undefined;
  let stopRetainedPostgres: (() => Promise<void>) | undefined;
  let replyCount = 0;
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
        if (protocol === "messages") {
          if (new URL(req.url ?? "", "http://127.0.0.1").pathname !== "/v1/messages") { res.writeHead(404).end(); return; }
          const parsed = JSON.parse(body), latest = parsed.messages?.at(-1);
          requests.push({ path: req.url, model: parsed.model, lastMessage: latest,
            tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? "") });
          const useListTool = scriptedToolCall && requests.length === 1;
          const bigCase = pendingBigCase;
          const useBigTool = !!bigCase && !issuedBigCalls.has(bigCase.callId);
          const probe = pendingProbe;
          const useProbeTool = !!probe && !issuedProbeCalls.has(probe.callId);
          const useTool = useListTool || useBigTool || useProbeTool;
          if (useProbeTool) issuedProbeCalls.add(probe!.callId);
          if (probe && !useProbeTool) {
            const result = Array.isArray(latest?.content) ? latest.content.find((part: Record<string, unknown>) => part.type === "tool_result" && part.tool_use_id === probe.callId) : undefined;
            expect(result, "native probe result must reach model").toBeDefined();
            probe.result = result;
            stage("native probe result reached model", { name: probe.name, callId: probe.callId, result });
          }
          if (useBigTool) issuedBigCalls.add(bigCase!.callId);
          if (bigCase && !useBigTool) {
            const result = Array.isArray(latest?.content) ? latest.content.find((part: Record<string, unknown>) => part.type === "tool_result" && part.tool_use_id === bigCase.callId) : undefined;
            expect(result, "native bash result must reach model before its answer").toBeDefined();
            expect(result.is_error).not.toBe(true);
            const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
            expect(text).toContain(bigCase.expected.slice(0, 20));
            expect(Buffer.byteLength(text), "model gets bounded native preview").toBeLessThan(55 * 1024);
            expect(text).toContain("Full output:");
            stage("big bash result reached model", { bytes: bigCase.bytes, callId: bigCase.callId, modelFacingBytes: Buffer.byteLength(text) });
          }
          const toolResult = Array.isArray(latest?.content) ? latest.content.find((part: Record<string, unknown>) => part.type === "tool_result" && part.tool_use_id === "call-list-agents-proof") : undefined;
          if (toolResult && returnedTools.length === 0) {
            const output = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
            returnedTools.push({ call_id: toolResult.tool_use_id, output });
            stage("list_agents result reached Pi and model", { callId: toolResult.tool_use_id, output });
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
          emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
          if (useTool) {
            const name = useProbeTool ? probe!.name : useBigTool ? "bash" : "list_agents";
            const callId = useProbeTool ? probe!.callId : useBigTool ? bigCase!.callId : "call-list-agents-proof";
            let input: Record<string, unknown> = useProbeTool ? probe!.input : useBigTool ? { command: bigCase!.command } : {};
            if (useProbeTool && name === "paperclip_finish") {
              let contract: any;
              for (const message of parsed.messages ?? []) {
                if (message.role !== "user") continue;
                const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
                for (const part of parts) {
                  if (part.type !== "text") continue;
                  try { const envelope = JSON.parse(part.text); if (envelope.completionContract) contract = envelope.completionContract; } catch { /* non-envelope history */ }
                }
              }
              expect(contract?.revision, "finish uses current real model envelope completion contract").toBeTruthy();
              input = { reportedWorkDisposition: "done", summary: `LOCAL_PI_FULL_SERVER_REPLY_${replyCount + 1}`, evidence: [{ ref: "provider:pi_rpc:agent-message" }], verification: [], attentionRequests: [], artifacts: [],
                completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
                  criteria: contract.criteria.map((criterion: any) => ({ criterionId: criterion.id, status: "satisfied", evidenceRefs: ["provider:pi_rpc:agent-message"] })), remainingWork: [] } };
              probe!.input = input;
            }
            emit("content_block_start", { index: 0, content_block: { type: "tool_use", id: callId, name, input: {} } });
            emit("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
            stage(useProbeTool ? "faux model called native probe" : useBigTool ? "faux model called big bash" : "faux model called list_agents", { nativeTools: requests[0]!.tools, protocol, callId, input, bytes: bigCase?.bytes });
          } else {
            const reply = `LOCAL_PI_FULL_SERVER_REPLY_${++replyCount}${bigCase ? `_LINES_${bigCase.bytes / 1000}` : ""}`;
            emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
            emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
            stage("faux model request", { turn: replyCount, model: parsed.model, protocol });
          }
          emit("content_block_stop", { index: 0 });
          emit("message_delta", { delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
          emit("message_stop", {}); res.end(); return;
        }
        if (protocol === "chat") {
          if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
          const parsed = JSON.parse(body), latest = parsed.messages?.at(-1);
          requests.push({ path: req.url, model: parsed.model, lastMessage: latest,
            tools: (parsed.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name ?? "") });
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const emit = (delta: Record<string, unknown>, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `local-${requests.length}`, object: "chat.completion.chunk", model: "faux", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
          if (scriptedToolCall && requests.length === 1) {
            emit({ role: "assistant", tool_calls: [{ index: 0, id: "call-list-agents-proof", type: "function", function: { name: "list_agents", arguments: "{}" } }] });
            emit({}, "tool_calls");
            stage("faux model called list_agents", { nativeTools: requests[0]!.tools, protocol });
          } else {
            if (latest?.role === "tool" && returnedTools.length === 0) {
              returnedTools.push({ call_id: latest.tool_call_id, output: latest.content });
              stage("list_agents result reached Pi and model", { callId: latest.tool_call_id, output: latest.content });
            }
            const reply = `LOCAL_PI_FULL_SERVER_REPLY_${++replyCount}`;
            emit({ role: "assistant", content: reply }); emit({}, "stop");
            stage("faux model request", { turn: replyCount, model: parsed.model, protocol });
          }
          res.write(`data: ${JSON.stringify({ id: `local-${requests.length}`, choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
          res.end("data: [DONE]\n\n"); return;
        }
        if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
        const parsed = JSON.parse(body);
        requests.push({ path: req.url, model: parsed.model, lastMessage: parsed.input?.at(-1), tools: (parsed.tools ?? []).map((tool: { name?: string }) => tool.name ?? "") });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
        if (scriptedToolCall && requests.length === 1) {
          const item = { id: "fc-list-agents", type: "function_call", status: "completed", call_id: "call-list-agents-proof", name: "list_agents", arguments: "{}" };
          const response = { id: "resp-tool-proof", object: "response", status: "completed", model: "faux", output: [item], usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } };
          emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
          emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
          emit("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: "{}" });
          emit("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: "{}" });
          emit("response.output_item.done", { output_index: 0, item });
          emit("response.completed", { response });
          stage("faux model called list_agents", { nativeTools: requests[0]!.tools });
          res.end(); return;
        }
        const toolResult = parsed.input?.find((item: Record<string, unknown>) => item.type === "function_call_output" && item.call_id === "call-list-agents-proof");
        if (toolResult && returnedTools.length === 0) {
          returnedTools.push(toolResult);
          stage("list_agents result reached Pi and model", { callId: toolResult.call_id, output: toolResult.output });
        }
        const reply = `LOCAL_PI_FULL_SERVER_REPLY_${++replyCount}`;
        stage("faux model request", { turn: requests.length, model: parsed.model });
        const message = { id: `msg-${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
        const response = { id: `resp-${requests.length}`, object: "response", status: "completed", model: "faux", output: [message], usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
        emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
        emit("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
        emit("response.content_part.added", { item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        emit("response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: reply });
        emit("response.output_text.done", { item_id: message.id, output_index: 0, content_index: 0, text: reply });
        emit("response.content_part.done", { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
        emit("response.output_item.done", { output_index: 0, item: message });
        emit("response.completed", { response });
        res.end();
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
          await closeRegisteredClients();
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
    const issue = await api("POST", `/companies/${companyId}/issues`, { title: "Reply through native Pi", description: "Reply with the local faux token.", status: "todo", assigneeAgentId: agentId }, 201);
    issueId = issue.id;
    const admitted = await waitFor("run admitted", async () => (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).find(run => run.runtimeMode === "native") ?? null);
    stage("run admitted", { runId: admitted.id, status: admitted.status, runtimeMode: admitted.runtimeMode });
    const pid = await waitFor("runnerd session up / Pi PID", async () => {
      for (const bundle of bundles) { const process = bundle.transport.processInfo?.(); if (process) { const pid = piDescendant(process.pid); if (pid) return { runnerPid: process.pid, piPid: pid }; } }
      return null;
    });
    stage("runnerd session up", { runnerPid: pid.runnerPid }); stage("Pi PID", { pid: pid.piPid });
    const readPiEnvironment = () => Object.fromEntries(readFileSync(`/proc/${pid.piPid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
    const launchEnvironment = readPiEnvironment();
    stage("AGENT_HOME proc at launch", { piPid: pid.piPid, agentHome: launchEnvironment.AGENT_HOME || "EMPTY", tmpdir: launchEnvironment.TMPDIR || "EMPTY" });
    const comment1 = await waitFor("reply text in comments", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find(row => row.authorAgentId === agentId && row.body.includes("LOCAL_PI_FULL_SERVER_REPLY_1")) ?? null;
    });
    stage("reply text in comments", { commentId: comment1.id, body: comment1.body });
    const { heartbeatService } = await import("../services/heartbeat.js");
    await heartbeatService(db).waitForRunExecutionDrain(admitted.id, { timeoutMs: 15_000 });
    await api("POST", `/issues/${issueId}/comments`, { body: "Second turn: reply with the next local faux token." }, 201);
    const comment2 = await waitFor("turn 2 reply text in comments", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find(row => row.authorAgentId === agentId && row.body.includes("LOCAL_PI_FULL_SERVER_REPLY_2")) ?? null;
    });
    const secondPid = piDescendant(pid.runnerPid);
    expect(secondPid).toBe(pid.piPid);
    expect(requests).toHaveLength(scriptedToolCall ? 3 : 2);
    expect(requests[0]!.tools).toEqual(expect.arrayContaining(["get_task_context", "list_agents", "search_api", "call_api"]));
    if (scriptedToolCall) {
      expect(returnedTools).toHaveLength(1);
      expect(String(returnedTools[0]!.output)).toContain(agentId);
    }
    expect(requests.every(request => request.model === "faux")).toBe(true);
    stage("turn 2 same PID", { piPid: secondPid, firstPiPid: pid.piPid, commentId: comment2.id, body: comment2.body });
    if (nativeHomeProof) {
      if (nativeHomeProof.includedSubagents) expect(requests[0]!.tools, "Pi actually advertised pi-subagents to the model").toContain("subagent");
      else expect(requests[0]!.tools, "pi-subagents exclusion is effective and explicit").not.toContain("subagent");
      await waitFor("native Pi home load receipt", async () => readNativePiHomeProof(nativeHomeProof.receiptPath));
      stage("native Pi extension proof passed", await assertNativePiHomeProof(nativeHomeProof, pid.piPid));
    }
    expect(protocol).toBe("messages");
    expect(nativeHomeProof?.includedSubagents).toBe(true);
    if (!nativeHomeProof?.includedToolCap) stage("SKIP tool-cap large-output persistence leg", {
      reason: "Private tool-cap/redact-secrets code is not distributed; supply PAPERCLIP_PI_E2E_HOME_FIXTURE to qualify this leg.",
      skippedBytes: bigOutputCases,
    });
    const drainLatest = async () => {
      const latest = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      await heartbeatService(db!).waitForRunExecutionDrain(latest.id, { timeoutMs: 15_000 });
      return latest;
    };
    await drainLatest();
    pendingProbe = { callId: "call-agent-home-echo", name: "bash", input: { command: "echo AGENT_HOME=$AGENT_HOME; pwd" } };
    await api("POST", `/issues/${issueId}/comments`, { body: "Run exactly this bash command, then briefly report its result: echo AGENT_HOME=$AGENT_HOME; pwd" }, 201);
    const echo = await waitFor("AGENT_HOME bash result", async () => pendingProbe?.result ?? null);
    const echoText = typeof echo.content === "string" ? echo.content : JSON.stringify(echo.content);
    expect(echo.is_error).not.toBe(true);
    const procEnvironment = readPiEnvironment();
    const runtimeContexts = readdirSync(join(root, "runner-state")).map(name => join(root, "runner-state", name, "runtime-context.json"));
    const runtimeContext = JSON.parse(readFileSync(runtimeContexts[0]!, "utf8"));
    const expectedAgentHome = runtimeContext.instructions.workingCopy.rootPath;
    const agentHomeProof = { piPid: pid.piPid, procValue: procEnvironment.AGENT_HOME || "EMPTY", expectedAgentHome, echo: echoText, cwd: workspace, tmpdir: procEnvironment.TMPDIR || "EMPTY" };
    nativeProbeProofs.push({ type: "agent_home", ...agentHomeProof }); stage("AGENT_HOME proc + model bash", agentHomeProof);
    pendingProbe = undefined;
    await drainLatest();
    if (strictCandidate) {
      expect(procEnvironment.AGENT_HOME).toBe(expectedAgentHome);
      expect(echoText).toContain(`AGENT_HOME=${expectedAgentHome}`);
    }
    for (const bytes of nativeHomeProof?.includedToolCap ? bigOutputCases : []) {
      expect([300000, 1500000]).toContain(bytes);
      const label = bytes === 300000 ? "L3_300K:" : "L3_1M5K:";
      const expected = (label + "x".repeat(991) + "\n").repeat(bytes / 1000);
      expect(Buffer.byteLength(expected)).toBe(bytes);
      const command = `python3 -c 'import sys; sys.stdout.write(("${label}" + "x" * 991 + "\\n") * ${bytes / 1000})'`;
      const callId = `call-big-bash-${bytes}`;
      const replyNumber = replyCount + 1;
      pendingBigCase = { bytes, callId, command, expected, replyNumber };
      const previous = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      await heartbeatService(db).waitForRunExecutionDrain(previous.id, { timeoutMs: 15_000 });
      stage("big output turn starting", { bytes, command, piPid: piDescendant(pid.runnerPid), callId });
      await api("POST", `/issues/${issueId}/comments`, { body: `Run exactly ONE bash command: ${command}. Then answer: how many lines were printed? Keep the answer short.` }, 201);
      const bigReply = await waitFor(`big output ${bytes} reply`, async () => {
        const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        return rows.find(row => row.authorAgentId === agentId && row.body.includes(`LOCAL_PI_FULL_SERVER_REPLY_${replyNumber}_LINES_${bytes / 1000}`)) ?? null;
      });
      expect(piDescendant(pid.runnerPid), "same native Pi after big output").toBe(pid.piPid);
      const native = readNativePiHomeProof(nativeHomeProof!.receiptPath)!;
      expect(native.sessionFile, "Pi's native persistent session path").toBeTruthy();
      const entries = readFileSync(native.sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const full = entries.find(entry => entry.customType === "tool-context-guard-full" && entry.data?.toolCallId === callId);
      expect(full, "tool-cap full custom entry persisted in Pi session").toBeDefined();
      expect(full.data.toolName).toBe("bash");
      const storedText = full.data.structuredContent?.output;
      expect(typeof storedText, "native bash retains its unabridged structured output in custom entry").toBe("string");
      // Stock Pi bash caps structured output at 1 MiB by design (pi-coding-agent dist/core/tools/bash.js
      // STRUCTURED_OUTPUT_MAX_BYTES; output-accumulator keeps the first and last 512 KiB plus an omitted marker;
      // docs/codemode.md:43) and writes the exact bytes to full_output_path. Below the cap the entry is exact.
      const PI_STRUCTURED_CAP = 1024 * 1024;
      if (Buffer.byteLength(expected) <= PI_STRUCTURED_CAP) {
        expect(storedText, "full exact bash output retained, not merely preview/spill").toBe(expected);
      } else {
        const half = PI_STRUCTURED_CAP / 2;
        expect(full.data.structuredContent?.truncated, "Pi marks the capped structured output truncated").toBe(true);
        expect(storedText.startsWith(expected.slice(0, half)), "capped output keeps the exact first 512 KiB").toBe(true);
        expect(storedText.endsWith(expected.slice(-half)), "capped output keeps the exact last 512 KiB").toBe(true);
        expect(storedText).toMatch(/\[\.\.\. \d+ bytes omitted \.\.\.\]/);
        const fullPath = full.data.structuredContent?.full_output_path;
        expect(typeof fullPath, "Pi records the exact full output path").toBe("string");
        expect(readFileSync(fullPath, "utf8"), "the exact full bash output is retained in Pi's full output file").toBe(expected);
      }
      const current = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      await heartbeatService(db).waitForRunExecutionDrain(current.id, { timeoutMs: 15_000 });
      pendingBigCase = undefined;
      const nextReplyNumber = replyCount + 1;
      await api("POST", `/issues/${issueId}/comments`, { body: "Next turn on the same session: answer with the next local faux token. No tool needed." }, 201);
      const nextReply = await waitFor(`post-big-output ${bytes} next turn`, async () => {
        const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        return rows.find(row => row.authorAgentId === agentId && row.body.includes(`LOCAL_PI_FULL_SERVER_REPLY_${nextReplyNumber}`)) ?? null;
      });
      const nextPid = piDescendant(pid.runnerPid);
      expect(nextPid, "same native Pi on successful NEXT turn").toBe(pid.piPid);
      const row = { bytes, command, callId, bigReplyId: bigReply.id, nextReplyId: nextReply.id, nextReply: nextReply.body,
        firstPiPid: pid.piPid, nextPid, sessionFile: native.sessionFile, customType: full.customType,
        fullTextBytes: Buffer.byteLength(storedText), fullTextSha256: createHash("sha256").update(storedText).digest("hex"),
        rpcRecordMax: native.rpcRecordMax, rpcRecordMaxByType: native.rpcRecordMaxByType };
      bigOutputProofs.push(row); stage("big output + next turn + full persistence passed", row);
    }
    if (includeFinish) {
      await drainLatest();
      pendingProbe = { callId: "call-native-finish-proof", name: "paperclip_finish", input: {} };
      await api("POST", `/issues/${issueId}/comments`, { body: "Finish this turn by calling paperclip_finish with the current completion contract, then end the turn." }, 201);
      const finishEnd = await waitFor("native paperclip_finish execution completed", async () => {
        const receipt = readNativePiHomeProof(nativeHomeProof!.receiptPath);
        return receipt?.toolExecutions?.find((event: any) => event.type === "tool_execution_end" && event.toolCallId === "call-native-finish-proof") ?? null;
      });
      const receipt = readNativePiHomeProof(nativeHomeProof!.receiptPath)!;
      const finishStart = receipt.toolExecutions.find((event: any) => event.type === "tool_execution_start" && event.toolCallId === "call-native-finish-proof");
      expect(finishStart).toBeDefined();
      const durationMs = finishEnd.monotonicMs - finishStart.monotonicMs;
      const finishProof = { type: "paperclip_finish", piPid: pid.piPid, durationMs, start: finishStart, end: finishEnd };
      nativeProbeProofs.push(finishProof); stage("native paperclip_finish latency", finishProof);
      await drainLatest();
      const states = await snapshotFinishState("after-finish");
      const providers = states.filter(state => state.path.endsWith("codex-provider-state.json"));
      expect(providers.length, "real provider persistence after finish").toBeGreaterThan(0);
      if (strictCandidate && !expectFinishRed) {
        expect(durationMs, "real finish callback reaches Pi in under 1 second").toBeLessThan(1000);
        expect(finishEnd.isError).not.toBe(true);
        expect(JSON.stringify(finishEnd)).not.toContain("Pi tool callback refused");
        for (const state of providers) {
          expect(state.pending, "finish persisted pending must be empty").toEqual({});
          expect(Object.hasOwn(state.completed ?? {}, "call-native-finish-proof") || Object.hasOwn(state.settledResults ?? {}, "call-native-finish-proof"), "finish call must be durably completed/settled").toBe(true);
        }
        expect(JSON.stringify(states), "no Rust semantic result persistence failure").not.toContain("semantic_tool.result command failed");
      }
      pendingProbe = undefined;
      for (let warm = 1; warm <= 2; warm++) {
        const nextReplyNumber = replyCount + 1;
        await api("POST", `/issues/${issueId}/comments`, { body: `Post-finish warm turn ${warm}: reply with the next local faux token.` }, 201);
        const reply = await waitFor(`post-finish warm turn ${warm}`, async () => {
          const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, issueId));
          return rows.find(row => row.authorAgentId === agentId && row.body.includes(`LOCAL_PI_FULL_SERVER_REPLY_${nextReplyNumber}`)) ?? null;
        });
        const warmPid = piDescendant(pid.runnerPid);
        expect(warmPid).toBe(pid.piPid);
        const row = { type: "post_finish_warm", warm, firstPiPid: pid.piPid, piPid: warmPid, replyId: reply.id, reply: reply.body };
        nativeProbeProofs.push(row); stage("post-finish warm turn same PID", row);
        await drainLatest();
        const warmRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        const latestWarm = warmRuns.sort((a, b) => new Date(a.startedAt!).getTime() - new Date(b.startedAt!).getTime()).at(-1)!;
        expect(latestWarm.status, "warm run.attach admitted and actual turn succeeded").toBe("succeeded");
        const attachProof = { type: "post_finish_attach", warm, runId: latestWarm.id, status: latestWarm.status, piPid: warmPid };
        nativeProbeProofs.push(attachProof); stage("post-finish warm run.attach succeeded", attachProof);
        await snapshotFinishState(`after-warm-${warm}`);
      }
    }
    const finalRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    // Keep reason: S11-parent succeeded with real model usage in the wire but
    // usageJson=0 after a display-only usage item erased the measured snapshot.
    for (const run of finalRuns.filter(run => run.status === "succeeded")) {
      const usage = run.usageJson;
      expect(Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0) + Number(usage?.cachedInputTokens ?? 0),
        `succeeded Pi run ${run.id} retains the scripted model's reported usage`).toBeGreaterThan(0);
    }
    expect(finalRuns.some(run => run.errorCode === "pi_rpc_transport_failed")).toBe(false);
    expect(finalRuns.every(run => run.status !== "failed" && run.status !== "timed_out")).toBe(true);
    const finalEvents = [];
    for (const run of finalRuns) finalEvents.push(...await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)));
    expect(JSON.stringify(finalEvents), "no transport failure anywhere in real persisted events").not.toContain("pi_rpc_transport_failed");
    expect(JSON.stringify(finalEvents), "no pending-call attach failure").not.toContain("durable_pending_tool_calls");
    const finalNative = readNativePiHomeProof(nativeHomeProof!.receiptPath)!;
    expect(JSON.stringify(finalNative.toolExecutions), "no native callback refusal").not.toContain("Pi tool callback refused");
    if (includeFinish) {
      const projected = finalEvents.flatMap(event => {
        const raw = (event.payload as any)?.prpEvent;
        return raw?.eventType?.startsWith("tool.execution.") && (raw.payload?.toolName ?? raw.payload?.name) === "paperclip_finish" ? [raw] : [];
      });
      const start = projected.find(event => event.eventType === "tool.execution.started");
      const end = projected.find(event => event.eventType === "tool.execution.completed");
      expect(start, "real durable PRP finish started").toBeDefined();
      expect(end, "real durable PRP finish completed").toBeDefined();
      expect(end.payload.status, "durable PRP finish succeeded").toBe("completed");
      expect(end.payload.output, "durable PRP finish not refused").not.toContain("Pi tool callback refused");
      const finishStates = nativeProbeProofs.filter(proof => proof.type === "finish_bridge_state");
      expect(JSON.stringify(finishStates), "no semantic_tool.result persistence failure after finish or either warm turn").not.toContain("semantic_tool.result command failed");
      for (const proof of finishStates) for (const state of proof.states as any[]) {
        if (state.path.endsWith("codex-provider-state.json")) expect(state.pending, "pending remains empty through both warm attaches").toEqual({});
      }
      const durationMs = Date.parse(end.emittedAt) - Date.parse(start.emittedAt);
      if (strictCandidate) expect(durationMs, "PRP started -> completed finish latency").toBeLessThan(1000);
      const row = { type: "durable_prp_finish", durationMs, start, end };
      nativeProbeProofs.push(row); stage("durable PRP finish started -> completed", row);
    }
    await assertNativePiHomeProof(nativeHomeProof!, pid.piPid);
    stage("GREEN", { companyId, agentId, issueId, requests: requests.length, bigOutputCases });
  } catch (error) {
    await snapshotFinishState("blocked");
    // Diagnostic replay only: use the ACTUAL captured native RPC line unchanged
    // against this SHA's production projector, not a synthetic oversize object.
    try {
      const path = nativeHomeProof!.receiptPath.replace(/\.json$/, ".largest-rpc-record.json");
      const line = readFileSync(path, "utf8");
      const record = JSON.parse(line);
      const { createPiEventProjector } = await import("../../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.js");
      let replayError: string | undefined;
      try { createPiEventProjector({ runId: "l3-captured-record", turnId: "l3-captured-record" }).project(record); }
      catch (failure) { replayError = failure instanceof Error ? failure.message : String(failure); }
      stage("captured native RPC production-projector replay", { path, bytes: Buffer.byteLength(line), type: record.type, customType: record.entry?.customType, replayError });
    } catch { /* no captured oversized native line at this failure */ }
    stage("BLOCKED", { error: error instanceof Error ? error.stack : String(error), companyId, agentId, issueId });
    throw error;
  } finally {
    await writeFile(join(root, "proof.json"), JSON.stringify({ stages, requests, returnedTools, bigOutputProofs, nativeProbeProofs }, null, 2) + "\n");
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
}, 600_000);
