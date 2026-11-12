import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  createDb,
  heartbeatRuns,
  issueComments,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// These are deliberately explicit-only, full-server user-flow qualifications.
// They use a real app, embedded Postgres, native Pi, source-built runnerd, and
// the loopback faux model; the only scripted component is model output.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const protocol = "messages" as const;
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";

type Bundle = ReturnType<typeof import("../vendor/paperclip-runner/index.js").createRunnerdCodexTransport>;
type ProofCase = {
  kind: "mention-driver" | "mention-answer" | "blocker" | "steer" | "steer-manager-hold";
  marker: string;
  issueId?: string;
  childId?: string;
  dependencyId?: string;
  parentId?: string;
  managerIssueId?: string;
  managerMarker?: string;
  workerMarker?: string;
  answer?: string;
  blockerLine?: string;
  oldMarker?: string;
  newMarker?: string;
  steerText?: string;
  firstRequestSeen?: () => void;
  managerRequestSeen?: () => void;
  releaseWorker?: () => void;
  releaseManager?: () => void;
  workerRelease?: Promise<void>;
  managerRelease?: Promise<void>;
  workerDependencyCallId?: string;
  workerCommentCallId?: string;
  workerBlockCallId?: string;
  managerSearchCallId?: string;
  managerReadCallId?: string;
  managerReplyCallId?: string;
  answerCallId?: string;
  mentionSearchCallId?: string;
  mentionPostCallId?: string;
  steerOldReported?: boolean;
  steerNewReported?: boolean;
  steerAccepted?: boolean;
};
type ModelRequest = { tools: string[]; marker: string; hasSteerText: boolean; request: number };

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let app: Awaited<ReturnType<typeof import("../app.js").createApp>> | undefined;
let http: Server | undefined;
let modelServer: Server | undefined;
let stopRetainedPostgres: (() => Promise<void>) | undefined;
let unsubscribe: (() => void) | undefined;
let companyId = "";
let agentAId = "";
let agentBId = "";
let apiUrl = "";
let workspace = "";
let root = "";
let boardBinding: Record<string, unknown> = {};
const bundles: Bundle[] = [];
const cases: ProofCase[] = [];
const modelRequests: ModelRequest[] = [];
const proofStages: Array<{ at: string; stage: string; details?: unknown }> = [];
let modelRequestCount = 0;
let toolCallCount = 0;
let notifyChanged: (() => void) | undefined;

function stage(name: string, details?: unknown) {
  const item = { at: new Date().toISOString(), stage: name, ...(details === undefined ? {} : { details }) };
  proofStages.push(item);
  console.log(`[rung4-full-server] ${name}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function toolNames(parsed: any): string[] {
  return (parsed.tools ?? []).map((tool: any) => tool?.name ?? "").filter(Boolean);
}

function findToolResult(messages: any[], callId: string | undefined): unknown {
  if (!callId) return undefined;
  for (const message of messages ?? []) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === "tool_result" && part.tool_use_id === callId) return part.content;
    }
  }
  return undefined;
}

function parseJsonValues(value: unknown, found: unknown[] = []): unknown[] {
  if (typeof value === "string") {
    try { parseJsonValues(JSON.parse(value), found); } catch { /* not JSON */ }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) parseJsonValues(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    found.push(value);
    for (const child of Object.values(value as Record<string, unknown>)) parseJsonValues(child, found);
  }
  return found;
}

function operationId(result: unknown, method: string, suffix: string): string | undefined {
  for (const value of parseJsonValues(result)) {
    const id = (value as any)?.operationId;
    if (typeof id === "string" && id.startsWith(`${method} /api/`) && id.includes(suffix)) return id;
  }
  return undefined;
}

function pathParamsFor(operation: string, issueId: string): Record<string, string> {
  return Object.fromEntries([...operation.matchAll(/\{([^}]+)\}/g)].map((match) => [match[1]!, issueId]));
}

function findBlockerLine(result: unknown): string | undefined {
  for (const value of parseJsonValues(result)) {
    const body = (value as any)?.body;
    if (typeof body === "string" && body.startsWith("BLOCKER:")) return body;
  }
  if (typeof result === "string") {
    const match = result.match(/BLOCKER:[^\r\n]+/);
    return match?.[0];
  }
  return undefined;
}

function completeMentions(result: unknown): boolean {
  return result !== undefined && result !== null;
}

async function api(method: string, path: string, body?: unknown, expected = 200, token?: { value: string; runId: string }) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: apiUrl };
  if (token) {
    headers.authorization = `Bearer ${token.value}`;
    headers["x-paperclip-run-id"] = token.runId;
  }
  const response = await fetch(`${apiUrl}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(response.status, `${method} ${path}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : {};
}

async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { notifyChanged = undefined; resolve(); }, 200);
      notifyChanged = () => { clearTimeout(timer); notifyChanged = undefined; resolve(); };
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForRequest(test: (request: ModelRequest) => boolean, label: string, timeoutMs = 120_000) {
  return waitFor(label, async () => modelRequests.find(test) ?? null, timeoutMs);
}

async function respondMessages(res: import("node:http").ServerResponse, input: { tool?: { name: string; arguments: Record<string, unknown> }; text?: string }) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  const requestNo = modelRequestCount;
  emit("message_start", { message: { id: `r4-message-${requestNo}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
  if (input.tool) {
    const callId = `r4-tool-${++toolCallCount}`;
    emit("content_block_start", { index: 0, content_block: { type: "tool_use", id: callId, name: input.tool.name, input: {} } });
    emit("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input.tool.arguments) } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } });
    emit("message_stop", {});
    res.end();
    return callId;
  }
  const text = input.text ?? "R4 faux-model turn complete.";
  emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  emit("content_block_stop", { index: 0 });
  emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
  emit("message_stop", {});
  res.end();
  return undefined;
}

function searchTool(query: string) {
  return { name: "search_api", arguments: { query } };
}

function findCase(transcript: string): ProofCase | undefined {
  return [...cases].reverse().find(item => transcript.includes(item.marker) || (!!item.managerMarker && transcript.includes(item.managerMarker)));
}

async function scriptModel(parsed: any, res: import("node:http").ServerResponse) {
  const transcript = JSON.stringify({ system: parsed.system, messages: parsed.messages ?? [] });
  const state = findCase(transcript);
  const requestNo = ++modelRequestCount;
  const tools = toolNames(parsed);
  const marker = state?.marker ?? "unmatched";
  const hasSteerText = !!state?.steerText && transcript.includes(state.steerText);
  modelRequests.push({ tools, marker, hasSteerText, request: requestNo });
  stage("loopback faux model request", { request: requestNo, tools, marker, hasSteerText });
  expect(state, "each real Pi turn must map to one scripted proof case").toBeDefined();
  if (!state) return respondMessages(res, { text: "Unexpected unscoped faux model request." });

  const nextTool = async (name: string, args: Record<string, unknown>) => respondMessages(res, { tool: { name, arguments: args } });

  if (state.kind === "mention-answer") {
    const answerResult = findToolResult(parsed.messages, state.answerCallId);
    if (!completeMentions(answerResult)) {
      state.answerCallId = await nextTool("report_progress", { idempotencyKey: `r4-mention-answer-${randomUUID()}`, body: state.answer! });
      return;
    }
    await respondMessages(res, { text: "B answered after explicit assignment." });
    return;
  }

  if (state.kind === "mention-driver") {
    const searchResult = findToolResult(parsed.messages, state.mentionSearchCallId);
    const postResult = findToolResult(parsed.messages, state.mentionPostCallId);
    if (!completeMentions(searchResult)) {
      state.mentionSearchCallId = await nextTool("search_api", { query: "POST issue comments", limit: 10 });
      return;
    }
    if (!completeMentions(postResult)) {
      const op = operationId(searchResult, "POST", "/comments");
      expect(op, "search_api must discover issue comment creation").toBeTruthy();
      state.mentionPostCallId = await nextTool("call_api", {
        operationId: op ?? "POST /api/issues/{issueId}/comments",
        pathParams: pathParamsFor(op ?? "POST /api/issues/{issueId}/comments", state.issueId!),
        body: { body: `[@B](agent://${agentBId})` },
      });
      return;
    }
    await respondMessages(res, { text: "The mention-only probe comment is posted." });
    return;
  }

  if (state.kind === "blocker" && transcript.includes(state.workerMarker!)) {
    const dependencyResult = findToolResult(parsed.messages, state.workerDependencyCallId);
    const commentResult = findToolResult(parsed.messages, state.workerCommentCallId);
    const blockResult = findToolResult(parsed.messages, state.workerBlockCallId);
    if (!completeMentions(dependencyResult)) {
      state.workerDependencyCallId = await nextTool("set_dependencies", {
        idempotencyKey: `r4-blocker-dependencies-${randomUUID()}`,
        blockedByTaskIds: [state.dependencyId!],
      });
      return;
    }
    if (!completeMentions(commentResult)) {
      state.workerCommentCallId = await nextTool("report_progress", {
        idempotencyKey: `r4-blocker-comment-${randomUUID()}`,
        body: state.blockerLine,
      });
      return;
    }
    if (!completeMentions(blockResult)) {
      state.workerBlockCallId = await nextTool("paperclip_block", {
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "blocked",
        summary: "The child issue is blocked on its unresolved dependency.",
        completionClaim: {
          contractRevision: "1", objectiveSatisfied: false,
          criteria: [{ criterionId: "objective", status: "not_satisfied", evidenceRefs: [] }],
          remainingWork: [{ description: "Resolve the dependency", blocksCompletion: true }],
        },
        evidence: [], verification: [], attentionRequests: [], artifacts: [],
        blocker: {
          reasonCode: "dependency_missing", owner: { kind: "external", name: "Unresolved dependency" },
          unblockAction: "Resolve the dependency and resume the child issue.", scope: "current_track",
        },
      });
      return;
    }
    await respondMessages(res, { text: "The child issue is blocked on its unresolved dependency." });
    return;
  }

  if (state.kind === "blocker" && transcript.includes(state.managerMarker!)) {
    const searchResult = findToolResult(parsed.messages, state.managerSearchCallId);
    const readResult = findToolResult(parsed.messages, state.managerReadCallId);
    const replyResult = findToolResult(parsed.messages, state.managerReplyCallId);
    if (!completeMentions(searchResult)) {
      state.managerSearchCallId = await nextTool("search_api", { query: "GET issue comments", limit: 10 });
      return;
    }
    if (!completeMentions(readResult)) {
      const op = operationId(searchResult, "GET", "/comments");
      expect(op, "search_api must discover issue comments read").toBeTruthy();
      state.managerReadCallId = await nextTool("call_api", {
        operationId: op ?? "GET /api/issues/{issueId}/comments",
        pathParams: pathParamsFor(op ?? "GET /api/issues/{issueId}/comments", state.childId!),
      });
      return;
    }
    if (!completeMentions(replyResult)) {
      const quote = findBlockerLine(readResult);
      expect(quote, "manager must quote the actual worker comment returned by GET child comments").toBe(state.blockerLine);
      state.managerReplyCallId = await nextTool("report_progress", { idempotencyKey: `r4-blocker-manager-${randomUUID()}`, body: quote ?? "BLOCKER: child comment missing" });
      return;
    }
    await respondMessages(res, { text: "The exact child blocker comment was quoted on the parent." });
    return;
  }

  if (state.kind === "steer-manager-hold") {
    state.managerRequestSeen?.();
    await state.managerRelease;
    await respondMessages(res, { text: "The direct manager is ready to steer the active worker." });
    return;
  }

  if (state.kind === "steer") {
    if (!state.steerOldReported) {
      state.firstRequestSeen?.();
      await state.workerRelease;
      state.steerOldReported = true;
      await nextTool("report_progress", { idempotencyKey: `r4-steer-old-${randomUUID()}`, body: `${state.oldMarker} | before manager steer` });
      return;
    }
    if (!state.steerNewReported) {
      if (!state.steerAccepted) {
        await respondMessages(res, { text: "The manager steer was not accepted; closing the fixture run after test failure." });
        return;
      }
      expect(hasSteerText, "new model turn must receive the actual direct-manager steer text").toBe(true);
      if (!hasSteerText) {
        await respondMessages(res, { text: "The manager steer did not reach this Pi turn." });
        return;
      }
      state.steerNewReported = true;
      await nextTool("report_progress", { idempotencyKey: `r4-steer-new-${randomUUID()}`, body: `${state.newMarker} | adopted manager steer in same run` });
      return;
    }
    await respondMessages(res, { text: "The new marker was posted from the same active run." });
  }
}

async function setup() {
  if (!enabled) return;
  expect(["off", "xhigh"]).toContain(thinking);
  expect(process.platform).toBe("linux");
  expect(process.env.PAPERCLIP_RUNNER_BINARY).toBeTruthy();
  expect(process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH).toBeTruthy();
  root = await mkdtemp(join(tmpdir(), "rung4-agents-talk-full-server-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);

  const fixture = process.env.PAPERCLIP_PI_E2E_HOME_FIXTURE;
  const adapterEnv: Record<string, string> = { TMPDIR: process.env.TMPDIR ?? root };
  if (fixture) {
    const copiedFixture = join(root, "pi-home-fixture");
    await cp(fixture, copiedFixture, { recursive: true });
    const settingsPath = join(copiedFixture, "agent", "settings.json");
    const settings = await readFile(settingsPath, "utf8");
    const rewritten = settings.replaceAll(fixture, copiedFixture);
    await writeFile(settingsPath, rewritten);
    adapterEnv.PI_CODING_AGENT_DIR = join(copiedFixture, "agent");
    adapterEnv.PI_LANGFUSE_DEBUG = "true";
    for (const key of Object.keys(process.env)) if (key.startsWith("LANGFUSE_")) vi.stubEnv(key, undefined);
  } else {
    const agentHome = join(root, "pi-agent-home");
    await mkdir(agentHome);
    await writeFile(join(agentHome, "settings.json"), JSON.stringify({ packages: [] }, null, 2) + "\n");
    adapterEnv.PI_CODING_AGENT_DIR = agentHome;
  }

  vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home"));
  vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
  vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_HTTPS", "off");
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("OTEL_SDK_DISABLED", "true");

  const [{ createApp }, { createStorageService }, { createLocalDiskStorageProvider }, runner, { setupRunnerPrpWebSocketServer }, { subscribeCompanyLiveEvents }] = await Promise.all([
    import("../app.js"), import("../storage/service.js"), import("../storage/local-disk-provider.js"),
    import("../vendor/paperclip-runner/index.js"), import("../realtime/runner-prp-ws.js"), import("../services/live-events.js"),
  ]);
  const realFactory = runner.createRunnerdCodexTransport;
  vi.spyOn(runner, "createRunnerdCodexTransport").mockImplementation(options => {
    expect(options?.provider).toBe("pi_rpc");
    expect(options?.piRpcThinkingLevel).toBe(thinking);
    const bundle = realFactory(options);
    bundles.push(bundle);
    return bundle;
  });

  modelServer = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      void scriptModel(JSON.parse(body), res).catch(error => {
        stage("faux model script failure", { message: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("R4 faux model script failed.");
      });
    });
  });
  await new Promise<void>(resolve => modelServer!.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  if (!modelAddress || typeof modelAddress === "string") throw new Error("No faux model listener");
  const baseUrl = `http://127.0.0.1:${modelAddress.port}`;
  stage("loopback faux model up", { protocol, thinking });

  temporary = await startEmbeddedPostgresTestDatabase("rung4-agents-talk-db-");
  db = createDb(temporary.connectionString);
  const pgPort = new URL(temporary.connectionString).port;
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
      if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== pgPort) continue;
      const dataDir = args[args.indexOf("-D") + 1]!;
      const pgCtl = args[0].replace(/postgres$/, "pg_ctl");
      stopRetainedPostgres = async () => {
        const { closeRegisteredClients } = await import("@paperclipai/db");
        await closeRegisteredClients(temporary!.connectionString);
        const result = await runChildProcess(`r4-pg-stop-${entry}`, pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
          cwd: root, env: {}, timeoutSec: 30, graceSec: 1, onLog: async () => {},
        });
        expect(result.exitCode, "owned embedded Postgres shutdown").toBe(0);
      };
      break;
    } catch { /* not our postgres */ }
  }
  expect(stopRetainedPostgres, "identify the owned embedded Postgres process").toBeDefined();

  app = await createApp(db, {
    uiMode: "none", serverPort: 0, storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
    deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
    authReady: true, companyDeletionEnabled: false, instanceId: `local-r4-${randomUUID()}`,
    localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [], decisionServiceOptions: { wakeOriginAgent: async () => undefined },
  });
  await app.locals.bundledPluginsStartup;
  http = createServer(app);
  await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No full server listener");
  apiUrl = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("PAPERCLIP_API_URL", apiUrl);
  setupRunnerPrpWebSocketServer(http, { apiUrl });
  stage("full Paperclip server up");

  const company = await api("POST", "/companies", { name: "Rung 4 agent communication proof" }, 201);
  companyId = company.id;
  await api("PATCH", `/companies/${companyId}`, { requireBoardApprovalForNewAgents: false });
  await db.insert(authUsers).values({ id: "local-board", name: "R4 proof operator", email: "r4-proof@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  unsubscribe = subscribeCompanyLiveEvents(companyId, () => notifyChanged?.());

  const connection = await api("POST", `/companies/${companyId}/ai-connections`, {
    provider: "anthropic", method: "api_key", name: "R4 loopback faux only", ownership: "personal", routing: {
      kind: "local", protocol, baseUrl, auth: "none", models: [{ id: "faux", label: "R4 local faux", thinkingLevels: [thinking] }],
    },
  }, 201);
  boardBinding = { mode: "delegated", provider: "anthropic", method: "api_key", connectionId: connection.connectionId, grantId: connection.grantId };
  stage("loopback-only AI connection created");

  const createAgent = async (name: string, reportsTo?: string) => {
    const agent = await api("POST", `/companies/${companyId}/agents`, {
      name, role: "engineer", ...(reportsTo ? { reportsTo } : {}), adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", cwd: workspace, model: "paperclip/faux", env: adapterEnv },
      runtimeConfig: { aiConnection: boardBinding, heartbeat: { enabled: false, wakeOnDemand: true } },
    }, 201);
    await db!.update(agents).set({ lifecycleState: "ready", status: "idle", lifecycleHolds: [], lifecycleOperation: null,
      lifecycleError: null, lifecycleVersion: agent.lifecycleVersion + 1 }).where(eq(agents.id, agent.id));
    const patched = await api("PATCH", `/agents/${agent.id}`, {
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", cwd: workspace, model: "paperclip/faux",
        lifecycleMode: "warm", piRpcThinkingLevel: thinking, env: adapterEnv },
      runtimeConfig: { aiConnection: boardBinding, heartbeat: { enabled: false, wakeOnDemand: true } },
    });
    expect(patched.adapterConfig).toMatchObject({ provider: "pi_rpc", lifecycleMode: "warm", piRpcThinkingLevel: thinking, model: "paperclip/faux" });
    expect(patched.lifecycleState).toBe("ready");
    return agent;
  };
  const manager = await createAgent("R4 Manager B");
  agentBId = manager.id;
  const worker = await createAgent("R4 Worker A", agentBId);
  agentAId = worker.id;
  expect((await db.select({ reportsTo: agents.reportsTo }).from(agents).where(eq(agents.id, agentAId)))[0]?.reportsTo).toBe(agentBId);
  stage("company and direct-report agents ready", { companyId, agentAId, agentBId, reportsTo: agentBId });
}

async function stopAndWriteEvidence() {
  for (const item of cases) {
    item.releaseWorker?.();
    item.releaseManager?.();
  }
  if (db && agentAId) {
    const { heartbeatService } = await import("../services/heartbeat.js");
    for (const agentId of [agentAId, agentBId]) {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      for (const run of runs) await heartbeatService(db).waitForRunExecutionDrain(run.id, { timeoutMs: 15_000 }).catch(error => stage("owned run drain", { id: run.id, error: String(error) }));
    }
  }
  for (const bundle of bundles) await bundle.transport.close().catch(error => stage("runner teardown warning", { error: String(error) }));
  if (root) {
    if (db) {
      const rowsA = agentAId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentAId)) : [];
      const rowsB = agentBId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentBId)) : [];
      const safeRun = (run: typeof rowsA[number]) => ({ id: run.id, agentId: run.agentId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
        error: run.error, exitCode: run.exitCode, signal: run.signal, errorCode: run.errorCode, nativeIssueId: run.nativeIssueId,
        runtimeMode: run.runtimeMode, nativePhase: run.nativePhase, processPid: run.processPid, stdoutExcerpt: run.stdoutExcerpt,
        stderrExcerpt: run.stderrExcerpt, logRef: run.logRef, logBytes: run.logBytes });
      await writeFile(join(root, "proof.json"), JSON.stringify({ stages: proofStages, modelRequests, cases: cases.map(item => ({ ...item, workerRelease: undefined, managerRelease: undefined, releaseWorker: undefined, releaseManager: undefined, firstRequestSeen: undefined, managerRequestSeen: undefined })), runs: [...rowsA, ...rowsB].map(safeRun) }, null, 2) + "\n");
      const commentsA = agentAId ? await db.select().from(issueComments).where(eq(issueComments.authorAgentId, agentAId)) : [];
      const commentsB = agentBId ? await db.select().from(issueComments).where(eq(issueComments.authorAgentId, agentBId)) : [];
      await writeFile(join(root, "agent-comments.json"), JSON.stringify([...commentsA, ...commentsB], null, 2) + "\n");
      const wakeupsA = agentAId ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentAId)) : [];
      const wakeupsB = agentBId ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentBId)) : [];
      await writeFile(join(root, "wakeups.json"), JSON.stringify([...wakeupsA, ...wakeupsB], null, 2) + "\n");
    }
    stage("evidence retained", { root });
  }
  unsubscribe?.();
  await app?.locals.paperclipShutdown?.();
  if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
  if (modelServer) { modelServer.closeAllConnections(); await new Promise<void>(resolve => modelServer!.close(() => resolve())); }
  await stopRetainedPostgres?.();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
}

describe("rung 4 agent talk: full-server Pi RPC proofs", () => {
  beforeAll(async () => setup(), 180_000);
  afterAll(async () => stopAndWriteEvidence(), 120_000);

  it.skipIf(!enabled)("mention alone does not wake B; explicit assignment starts B and gets an answer", async () => {
    const nonce = `r4-mention-${randomUUID()}`;
    const marker = `R4_MENTION_DRIVER_${nonce}`;
    const answer = `ANSWER ${nonce}`;
    const answerMarker = `R4_MENTION_ANSWER_${nonce}`;
    const driverState: ProofCase = { kind: "mention-driver", marker, answer, issueId: "" };
    const answerState: ProofCase = { kind: "mention-answer", marker: answerMarker, answer };
    cases.push(driverState, answerState);
    const target = await api("POST", `/companies/${companyId}/issues`, {
      title: `R4 mention-only target ${nonce}`, description: `${answerMarker}. Held in backlog until explicit assignment to B. After assignment, post exactly ${answer}.`,
      status: "backlog", priority: "low", assigneeAgentId: agentAId,
    }, 201);
    driverState.issueId = target.id;
    answerState.issueId = target.id;
    const driver = await api("POST", `/companies/${companyId}/issues`, {
      title: `R4 mention driver ${nonce}`,
      description: `${marker}. Post exactly one issue comment on target issue ${target.id}: [@B](agent://${agentBId}). Do not assign the target; then finish this driver turn.`, 
      status: "todo", priority: "low", assigneeAgentId: agentAId,
    }, 201);
    stage("mention probe created", { targetId: target.id, driverId: driver.id });
    const mention = await waitFor("A's exact mention-only comment", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, target.id));
      return rows.find(row => row.authorAgentId === agentAId && row.body === `[@B](agent://${agentBId})`) ?? null;
    });
    expect(mention.authorAgentId).toBe(agentAId);
    const bRunsBefore = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentBId));
    const relevantBefore = bRunsBefore.filter(run => run.nativeIssueId === target.id || (run.contextSnapshot as any)?.issueId === target.id);
    expect(relevantBefore, "mention-only comment must not create B run for this issue").toEqual([]);
    stage("mention-only wake absence verified", { issueId: target.id, commentId: mention.id });

    await api("PATCH", `/issues/${target.id}`, { assigneeAgentId: agentBId, status: "todo" });
    const bComment = await waitFor("B's assignment answer", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, target.id));
      return rows.find(row => row.authorAgentId === agentBId && row.body === answer) ?? null;
    });
    const bRun = await waitFor("B issue_assigned run", async () => {
      const runs = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentBId));
      return runs.find(run => run.nativeIssueId === target.id && (run.contextSnapshot as any)?.wakeReason === "issue_assigned") ?? null;
    });
    expect(bRun.startedAt).toBeTruthy();
    expect(bComment.authorAgentId).toBe(agentBId);
    expect(bComment.createdByRunId).toBe(bRun.id);
    stage("mention plus assignment proof passed", { issueId: target.id, bRunId: bRun.id, wakeReason: (bRun.contextSnapshot as any)?.wakeReason, commentId: bComment.id });
  }, 240_000);

  it.skipIf(!enabled)("blocked child relays to B, whose run reads and quotes A's exact child comment", async () => {
    const nonce = `r4-blocker-${randomUUID()}`;
    const managerMarker = `R4_BLOCKER_PARENT_${nonce}`;
    const workerMarker = `R4_BLOCKER_CHILD_${nonce}`;
    const blockerLine = `BLOCKER: ${nonce} — blocked on unresolved dependency; read this child comment before replying.`;
    const state: ProofCase = { kind: "blocker", marker: workerMarker, workerMarker, managerMarker, blockerLine };
    cases.push(state);
    const parent = await api("POST", `/companies/${companyId}/issues`, {
      title: `R4 blocker parent ${nonce}`,
      description: `${managerMarker}. When a blocked child relay arrives, read the child issue's actual comments and quote the full BLOCKER line here with report_progress.`,
      status: "backlog", priority: "low", assigneeAgentId: agentBId, allowDuplicate: true,
    }, 201);
    state.parentId = parent.id;
    const dependency = await api("POST", `/companies/${companyId}/issues`, {
      title: `R4 unresolved dependency ${nonce}`, description: "Leave in backlog as an unresolved blocker.",
      status: "backlog", priority: "low", allowDuplicate: true,
    }, 201);
    state.dependencyId = dependency.id;
    const child = await api("POST", `/companies/${companyId}/issues`, {
      title: `R4 blocked child ${nonce}`,
      description: `${workerMarker}. An unresolved external dependency prevents completion. Transition this active issue to blocked with its dependency ID ${dependency.id}; attach exactly this comment: ${blockerLine}`,
      status: "todo", priority: "low", assigneeAgentId: agentAId, parentId: parent.id, allowDuplicate: true,
      executionPolicy: { authorizationPolicy: { trustPreset: "standard" } },
    }, 201);
    state.childId = child.id;
    expect((await db!.select({ reportsTo: agents.reportsTo }).from(agents).where(eq(agents.id, agentAId)))[0]?.reportsTo).toBe(agentBId);
    await waitFor("A's blocked-child status change", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, child.id));
      return rows.find(row => row.authorAgentId === agentAId && row.body === blockerLine) ?? null;
    });
    const childAfter = await waitFor("blocked-child status finalization", async () => {
      const current = await api("GET", `/issues/${child.id}`);
      return current.status === "blocked" ? current : null;
    });
    const { issueService } = await import("../services/issues.js");
    expect((await issueService(db!).getDependencyReadiness(child.id)).blockerIssueIds).toContain(dependency.id);
    const relayAndReply = await waitFor("system relay, B's issue_commented run, and exact quote", async () => {
      const [parentComments, runs] = await Promise.all([
        db!.select().from(issueComments).where(eq(issueComments.issueId, parent.id)),
        db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentBId)),
      ]);
      const relay = parentComments.find(comment => comment.authorType === "system" && comment.body.includes(child.identifier) && comment.body.includes("transitioned to `blocked`"));
      const run = runs.find(candidate => candidate.nativeIssueId === parent.id && (candidate.contextSnapshot as any)?.wakeReason === "issue_commented"
        && (candidate.contextSnapshot as any)?.childIssueId === child.id && (candidate.contextSnapshot as any)?.childStatus === "blocked");
      const reply = parentComments.find(comment => comment.authorAgentId === agentBId && comment.body === blockerLine);
      return relay && run?.startedAt && reply ? { relay, run, reply } : null;
    });
    expect(relayAndReply.reply.createdByRunId).toBe(relayAndReply.run.id);
    stage("blocked-child relay proof passed", { parentId: parent.id, childId: child.id, dependencyId: dependency.id,
      relayId: relayAndReply.relay.id, managerRunId: relayAndReply.run.id, wakeReason: (relayAndReply.run.contextSnapshot as any)?.wakeReason,
      childStatus: (relayAndReply.run.contextSnapshot as any)?.childStatus, managerReplyId: relayAndReply.reply.id,
      quotedExactChildComment: relayAndReply.reply.body });
  }, 240_000);

  it.skipIf(!enabled)("B steers the same active pi_rpc run; A adopts the marker without a successor run", async () => {
    const nonce = `r4-steer-${randomUUID()}`;
    const marker = `R4_STEER_WORKER_${nonce}`;
    const oldMarker = `old-marker-${nonce}`;
    const newMarker = nonce;
    const steerText = `switch marker to ${newMarker}`;
    const workerLatch = deferred();
    const managerLatch = deferred();
    const workerSeen = deferred();
    const managerSeen = deferred();
    const state: ProofCase = {
      kind: "steer", marker, oldMarker, newMarker, steerText,
      firstRequestSeen: workerSeen.resolve, releaseWorker: workerLatch.resolve, workerRelease: workerLatch.promise,
    };
    const managerState: ProofCase = {
      kind: "steer-manager-hold", marker: `R4_STEER_MANAGER_${nonce}`,
      managerRequestSeen: managerSeen.resolve, releaseManager: managerLatch.resolve, managerRelease: managerLatch.promise,
    };
    cases.push(state, managerState);
    const workerIssue = await api("POST", `/companies/${companyId}/issues`, {
      title: `R4 steer worker ${nonce}`,
      description: `${marker}. Start immediately and remain in this one run. Before the manager instruction, report one progress line with the old marker. When the manager steers the prefix, report a new progress line with the exact new prefix and continue in the same run. The new marker is supplied only by the manager comment.`,
      status: "todo", priority: "low", assigneeAgentId: agentAId,
    }, 201);
    state.issueId = workerIssue.id;
    const managerIssue = await api("POST", `/companies/${companyId}/issues`, {
      title: `R4 steer manager control ${nonce}`,
      description: `${managerState.marker}. Hold this manager run open for the R4 direct-manager steering check.`,
      status: "todo", priority: "low", assigneeAgentId: agentBId,
    }, 201);
    managerState.managerIssueId = managerIssue.id;
    await Promise.all([
      waitForRequest(request => request.marker === marker, "worker's deliberately slow Pi model request"),
      waitForRequest(request => request.marker === managerState.marker, "manager's live Pi run for authenticated steer"),
    ]);
    await Promise.all([workerSeen.promise, managerSeen.promise]);
    const workerRun = await waitFor("active native worker run", async () => {
      const rows = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentAId));
      return rows.find(run => run.nativeIssueId === workerIssue.id && run.status === "running" && run.runtimeMode === "native") ?? null;
    });
    const managerRun = await waitFor("active native manager run", async () => {
      const rows = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentBId));
      return rows.find(run => run.nativeIssueId === managerIssue.id && run.status === "running" && run.runtimeMode === "native") ?? null;
    });
    expect(workerRun.id).not.toBe(managerRun.id);
    const managerToken = createLocalAgentJwt(agentBId, companyId, "paperclip_runner", managerRun.id, null);
    expect(managerToken, "mint manager's test-only signed identity for its active native run").toBeTruthy();
    const token = { value: managerToken!, runId: managerRun.id };
    stage("worker run active immediately before manager steer", { workerRunId: workerRun.id, workerStatus: workerRun.status,
      workerStartedAt: workerRun.startedAt, managerRunId: managerRun.id, workerIssueId: workerIssue.id });

    const queuedComment = await api("POST", `/issues/${workerIssue.id}/comments`, { body: steerText }, 201, token);
    expect(queuedComment.authorAgentId).toBe(agentBId);
    stage("manager steer comment posted", { workerRunId: workerRun.id, commentId: queuedComment.id });
    const queue = await waitFor("manager comment appears in the active run's deferred queue", async () => {
      const current = await api("GET", `/issues/${workerIssue.id}/queued-comments`, undefined, 200, token);
      return current.state === "deferred" && current.targetRunId === workerRun.id
        && current.steeringDisposition !== "temporarily_unavailable" ? current : null;
    });
    expect(queue).toMatchObject({ state: "deferred", targetRunId: workerRun.id, protocol: "paperclip_runner_v1", steeringDisposition: "available" });
    const queueEntry = (queue.entries ?? []).find((entry: any) => entry.comment?.id === queuedComment.id);
    expect(queueEntry).toBeTruthy();
    const accepted = await api("POST", `/issues/${workerIssue.id}/queued-comments/${queuedComment.id}/steer`, {
      queueId: queue.queueId, revision: queue.revision, targetRunId: workerRun.id,
    }, 200, token);
    // A successful steer consumes the queue entry, so the endpoint returns the current empty queue snapshot.
    expect(accepted).toMatchObject({ state: null, queueId: null, targetRunId: null, protocol: "paperclip_runner_v1" });
    state.steerAccepted = true;
    const acknowledged = await waitFor("persisted same-turn steer acknowledgement", async () => {
      const [row] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, workerRun.id));
      const ack = (row?.resultJson as any)?.queuedSteeringAcknowledgements?.[queuedComment.id];
      return ack?.status === "acknowledged" && ack.queueId === queue.queueId && ack.turnId ? { row, ack } : null;
    });
    expect(acknowledged.row.status).toBe("running");
    const [sameActive] = await db!.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, workerRun.id), eq(heartbeatRuns.status, "running")));
    expect(sameActive?.id).toBe(workerRun.id);
    stage("direct-manager steer accepted and acknowledged", { issueId: workerIssue.id, workerRunId: workerRun.id,
      managerRunId: managerRun.id, commentId: queuedComment.id, queueId: queue.queueId, revision: queue.revision,
      acknowledgementTurnId: acknowledged.ack.turnId, sameRunStillRunning: true });

    state.releaseWorker?.();
    const newOutput = await waitFor("A's new-marker output from the original run", async () => {
      const rows = await db!.select().from(issueComments).where(eq(issueComments.issueId, workerIssue.id));
      return rows.find(row => row.authorAgentId === agentAId && row.createdByRunId === workerRun.id && row.body.startsWith(`${newMarker} |`)) ?? null;
    });
    expect(state.steerNewReported).toBe(true);
    expect(modelRequests.filter(request => request.marker === marker).some(request => request.hasSteerText)).toBe(true);
    const finished = await waitFor("target run completion", async () => {
      const [row] = await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, workerRun.id));
      return row && ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(row.status) ? row : null;
    });
    expect(finished.status).toBe("succeeded");
    const issueRuns = (await db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentAId)))
      .filter(run => run.nativeIssueId === workerIssue.id);
    expect(issueRuns.map(run => run.id)).toEqual([workerRun.id]);
    expect(newOutput.createdByRunId).toBe(workerRun.id);
    stage("same-run manager-steer proof passed", { issueId: workerIssue.id, runId: workerRun.id, finalStatus: finished.status,
      outputCommentId: newOutput.id, outputBody: newOutput.body, createdByRunId: newOutput.createdByRunId,
      issueRunIds: issueRuns.map(run => run.id), successorRunIds: [] });
    state.releaseWorker?.();
    managerState.releaseManager?.();
  }, 240_000);
});
