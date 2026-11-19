import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues,
  agentWakeupRequests, nativeRunFinalizations,
} from "@paperclipai/db";
import { PiRpcDriver } from "../../../packages/paperclip-runner/src/drivers/pi/pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "../../../packages/paperclip-runner/src/drivers/pi/pi-rpc-transport.js";
import { createRunnerdNativeSessionBackend } from "../../../packages/paperclip-runner/src/backends/codex-native-backend.js";
import { createPiRpcAppServerProxy } from "../../../packages/paperclip-runner/src/cli/pi-rpc-app-server-proxy.js";
import { FakeCodexTransport } from "../../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.test-support.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  executePaperclipNativeSession, getNativeSessionSteeringState,
} from "../services/native-runtime/native-session-executor.js";
import * as nativeExecutor from "../services/native-runtime/native-session-executor.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { readUnreadSteeredMessages } from "../services/native-runtime/unread-steered-messages.js";
import { readPersonStopHold } from "../services/acknowledged-native-stop.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDeferredWakesForIssue } from "../services/deferred-execution-notifications.js";

// Keep reason: BRIEF-RED.md S-a..S-e and the recorded 11-17 S9 loss at
// 0d59da31. Explicitly requested route/native integration REDs, not live model proof.
// Only Pi's RPC peer is scripted, at the existing executor backend test seam.
// The comment route, wake admission, Pi driver, native executor, event persistence,
// answer publication and queue/Stop readers remain production code.
class RecordingPiPeer {
  clock = Date.now();
  tick() { return ++this.clock; }
  closed = false;
  exited = false;
  pid = null;
  requests: Array<{ type: string; input?: PiRpcRecord; at: number }> = [];
  records: PiRpcRecord[] = [];
  pending: string[] = [];
  consumed: string[] = [];
  replies: string[] = [];
  wake?: () => void;
  active = false;
  closeGate?: Promise<void>;
  steerAckGate?: Promise<void>;
  holdClose() {
    let release!: () => void; this.closeGate = new Promise<void>(resolve => { release = resolve; });
    return release;
  }
  onPrompt?: (message: string) => void;
  facadeCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  sessionFile?: string;
  model = { provider: "paperclip", id: "neutral/vendor-model-not-in-bundled-catalog" };
  usage = { input: 11, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
    cost: { input: 0.00001, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00002 } };
  send(record: PiRpcRecord) { this.records.push(record); this.wake?.(); }
  user(text: string) {
    const message = { role: "user", content: [{ type: "text", text }], timestamp: this.tick() };
    this.send({ type: "message_start", message }); this.send({ type: "message_end", message });
  }
  assistant(content: unknown[], stopReason = "stop") {
    const message = { role: "assistant", content, api: "openai-completions", provider: this.model.provider,
      model: this.model.id, usage: this.usage, stopReason, timestamp: this.tick() };
    this.send({ type: "message_start", message: { ...message, content: [] } });
    for (const [contentIndex, part] of content.entries()) {
      const text = (part as { text?: string }).text;
      if (text !== undefined) for (const event of [
        { type: "text_start", contentIndex }, { type: "text_delta", contentIndex, delta: text },
        { type: "text_end", contentIndex, content: text },
      ]) this.send({ type: "message_update", usage: this.usage, assistantMessageEvent: event });
    }
    this.send({ type: "message_end", message });
    return message;
  }
  toolStart(id: string) { this.send({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: `echo ${id}` } }); }
  toolEnd(id: string) { this.send({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: `${id} done` }], details: {}, isError: false }, isError: false }); }
  async request(type: string, input?: PiRpcRecord) {
    this.requests.push({ type, input, at: Date.now() });
    let data: unknown;
    if (type === "get_state") data = { model: this.model, sessionId: "controlled-native-pi", sessionFile: this.sessionFile, thinkingLevel: "off",
      isStreaming: this.active, isCompacting: false, pendingMessageCount: this.pending.length };
    else if (type === "get_available_models") data = { models: [this.model] };
    else if (type === "set_model") data = this.model;
    else if (type === "get_available_thinking_levels") data = { levels: ["off"] };
    else if (type === "prompt") {
      data = { disposition: "started" }; this.active = true;
      this.send({ type: "agent_start" }); this.send({ type: "turn_start" }); this.user(String(input?.message));
      this.assistant([
        { type: "toolCall", id: "step-1", name: "bash", arguments: { command: "echo step-1" } },
        { type: "toolCall", id: "step-2", name: "bash", arguments: { command: "echo step-2" } },
      ], "toolUse");
      this.toolStart("step-1");
      this.onPrompt?.(String(input?.message));
    } else if (type === "steer") {
      this.pending.push(String(input?.message)); data = { disposition: "queued" };
      this.send({ type: "queue_update", steering: [...this.pending], followUp: [] });
      await this.steerAckGate;
    } else if (type === "abort") { this.finish(true); }
    else if (type === "get_messages") data = { messages: [] };
    return { type: "response", command: type, success: true, data };
  }
  boundary(answer = true) {
    this.toolEnd("step-1"); this.toolStart("step-2"); this.toolEnd("step-2");
    this.send({ type: "turn_end", toolResults: [] });
    const inputs = this.pending.splice(0);
    for (const text of inputs) {
      this.send({ type: "turn_start" }); this.user(text); this.consumed.push(text);
      if (!answer) {
        // This model iteration takes input and calls another tool without a
        // response. A later final belongs to the old work, not this instruction.
        this.assistant([{ type: "toolCall", id: "unrelated-work", name: "bash", arguments: { command: "echo old-work" } }], "toolUse");
        this.toolStart("unrelated-work"); this.toolEnd("unrelated-work");
      }
    }
    if (answer && inputs.length) this.answer(inputs);
  }
  answer(inputs: string[]) {
    this.replies.push(...inputs.map(text => `ANSWER:${text}`));
    const message = this.assistant([{ type: "text", text: this.replies.join("\n") }]);
    this.send({ type: "turn_end", message, toolResults: [] });
  }
  finish(aborted = false) {
    if (!this.active) return;
    if (!aborted && !this.replies.length) {
      const message = this.assistant([{ type: "text", text: "ORIGINAL_WORK_FINISHED" }]);
      this.send({ type: "turn_end", message, toolResults: [] });
    }
    this.active = false;
    this.send({ type: "agent_end", messages: [], willRetry: false });
    this.send({ type: "agent_settled", aborted });
  }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const record = this.records.shift();
      if (record) { yield record; continue; }
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { await this.closeGate; this.closed = this.exited = true; this.wake?.(); }
  async sendExtensionUiResponse() {}
}

// Same in-memory facade transport used by the Pi driver's input-proxy harness;
// unlike FakeCodexTransport, every command is handled by the real Pi proxy.
class PiFacadeTransport extends FakeCodexTransport {
  serial = 0;
  waiting = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  proxy: ReturnType<typeof createPiRpcAppServerProxy>;
  constructor(driver: PiRpcDriver, runId: string, normalizedSessionId: string) {
    super();
    this.proxy = createPiRpcAppServerProxy({ environment: { PAPERCLIP_RUN_ID: runId, PAPERCLIP_NORMALIZED_SESSION_ID: normalizedSessionId }, createDriver: () => driver,
      stdout: { write: frame => {
        const value = JSON.parse(frame);
        if (value.id != null) {
          const waiter = this.waiting.get(value.id); this.waiting.delete(value.id);
          if (value.error) waiter?.reject(new Error(value.error.message)); else waiter?.resolve(value.result ?? {});
        } else if (value.method) this.push(value.method, value.params ?? {});
        return true;
      }, once() {} } });
  }
  override async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    if (method === "thread/resume" && this.preparedResume) return this.preparedResume;
    if (method === "thread/turns/list") {
      const read = await this.request("thread/read", { threadId: params.threadId, includeTurns: true });
      return { data: (read.thread as { turns: unknown[] }).turns, nextCursor: null };
    }
    const id = ++this.serial;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => { this.waiting.set(id, { resolve, reject }); });
    this.proxy.acceptLine(JSON.stringify({ id, method, params })); return response;
  }
  preparedResume?: Record<string, unknown>;
  async prepareConversationResume(params: Record<string, unknown>) {
    this.preparedResume = await this.request("thread/resume", params);
  }
  override notify(method: string, params?: Record<string, unknown>) { this.proxy.acceptLine(JSON.stringify({ method, params })); }
  override async close() { await this.proxy.close(); await super.close(); }
}

let db: ReturnType<typeof createDb>;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let root: string;
type Outcome = { result?: Awaited<ReturnType<typeof executePaperclipNativeSession>>; error?: string };
const scheduled = new Map<string, { bodies: string[]; peers: RecordingPiPeer[]; executions: Promise<unknown>[];
  first: RecordingPiPeer; outcomes: Map<string, Outcome> }>();
const realExecute = executePaperclipNativeSession;
function backendFor(execution: Parameters<typeof realExecute>[0]["execution"], runnerInstanceId: string, peer: RecordingPiPeer) {
  const workspace = execution.workspace.cwd;
  const driver = new PiRpcDriver({ model: execution.provider.kind === "pi_rpc" ? execution.provider.model : undefined,
    piRpcThinkingLevel: "off", runtimeDirectory: workspace, runnerInstanceId,
    environment: { PI_CODING_AGENT_DIR: join(workspace, "agent") }, transportFactory: options => {
      const args = options.args ?? [];
      peer.sessionFile = args[args.indexOf("--session") + 1];
      // The scripted Pi process owns its session file, just as real Pi does.
      // Keep a valid native header so the real driver's next-run recovery,
      // identity validation and session-file fencing are exercised unchanged.
      if (!existsSync(peer.sessionFile)) writeFileSync(peer.sessionFile, JSON.stringify({ type: "session", id: "controlled-native-pi",
        version: 3, timestamp: new Date().toISOString(), cwd: workspace }) + "\n", { mode: 0o600 });
      return peer as unknown as PiRpcTransport;
    } });
  return createRunnerdNativeSessionBackend(execution, { runnerInstanceId, transportFactory: () => {
    const facade = new PiFacadeTransport(driver, execution.binding.runId, execution.session.normalizedSessionId!);
    peer.facadeCalls = facade.calls; return facade;
  } });
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "steer-default-red-"));
  if (process.env.PAPERCLIP_STEER_RED_EVIDENCE) await mkdir(process.env.PAPERCLIP_STEER_RED_EVIDENCE, { recursive: true });
  vi.stubEnv("PAPERCLIP_HOME", join(root, "home"));
  vi.stubEnv("PAPERCLIP_CONFIG", join(root, "config.json"));
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
  database = await startEmbeddedPostgresTestDatabase("steer-default-red-db-"); db = createDb(database.connectionString);
  await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
  // Forward the scheduler's exact native input into the SAME product executor,
  // replacing only its provider backend at the documented test seam. No wake,
  // run admission, completion, answer or Stop outcome is mocked.
  vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementation(input => {
    if (input.backend) return realExecute(input);
    const owner = scheduled.get(input.execution.binding.companyId);
    if (!owner) throw new Error("unowned scheduled execution in steer RED");
    const first = owner.peers.length === 0;
    const peer = first ? owner.first : new RecordingPiPeer(); owner.peers.push(peer);
    if (!first) peer.onPrompt = message => setImmediate(() => {
      const envelope = JSON.parse(message);
      const prompt = String(envelope.task?.prompt ?? message);
      peer.boundary();
      const inputs = owner.bodies.filter(body => prompt.includes(body));
      if (inputs.length) peer.answer(inputs);
      peer.finish();
    });
    const execution = realExecute({ ...input, useRunnerd: false, backend: backendFor(input.execution, input.runnerInstanceId, peer) });
    owner.executions.push(execution.then(result => owner.outcomes.set(input.execution.binding.runId, { result }),
      error => owner.outcomes.set(input.execution.binding.runId, { error: String(error) })));
    return execution;
  });
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); });

async function fixture(label: string, conversation = true) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
  const workspace = join(root, label); await mkdir(workspace);
  await writeFile(join(workspace, "AGENTS.md"), "Answer each incoming person message exactly once.\n");
  await db.insert(companies).values({ id: companyId, name: `Steer ${label}`, defaultResponsibleUserId: userId, issuePrefix: `S${label.replace(/\W/g, "").toUpperCase()}` });
  await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Native Pi", status: "active", adapterType: "paperclip_runner",
    adapterConfig: { provider: "pi_rpc", cwd: workspace, model: "paperclip/neutral/vendor-model-not-in-bundled-catalog", piRpcThinkingLevel: "off", lifecycleMode: "per_turn" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
  await db.insert(issues).values({ id: issueId, companyId, title: `Steer ${label}`, status: "in_progress", assigneeAgentId: agentId,
    executionWorkspaceSettings: { mode: "shared_workspace" },
    ...(conversation ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" as const } : {}) });
  const initial = randomUUID();
  await db.insert(issueComments).values({ id: initial, companyId, issueId, authorType: "user", authorUserId: userId, body: "Do the original two-step work." });
  const peer = new RecordingPiPeer();
  const owner = { bodies: [] as string[], peers: [] as RecordingPiPeer[], executions: [] as Promise<unknown>[], first: peer, outcomes: new Map<string, Outcome>() };
  scheduled.set(companyId, owner);
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let work: ReturnType<ReturnType<typeof heartbeatService>["registerDeferredReceiptWork"]> | undefined;
  const workerErrors: unknown[] = [];
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false,
    memberships: [{ companyId, status: "active", membershipRole: "operator" }] }; next(); });
  app.use("/api", issueRoutes(db, {} as any, {})); app.use("/api", agentRoutes(db)); app.use(errorHandler);
  const heartbeat = heartbeatService(db);
  const admission = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
    requestedByActorType: "user", requestedByActorId: userId,
    payload: { issueId, commentId: initial, mutation: "comment" },
    contextSnapshot: { issueId, taskId: issueId, wakeCommentId: initial, wakeCommentIds: [initial], skipIssueComment: true } });
  expect(admission, "initial native run must be admitted by the real heartbeat scheduler").not.toBeNull();
  const runId = admission!.id;
  try {
    await vi.waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (["failed", "cancelled", "timed_out"].includes(run.status)) throw new Error(`native fixture failed: ${run.errorCode}: ${run.error}`);
      expect(await getNativeSessionSteeringState(runId)).toMatchObject({ disposition: "available" });
      expect(peer.requests.some(command => command.type === "prompt")).toBe(true);
    }, { timeout: 15_000 });
  } catch (error) {
    peer.boundary(); peer.finish(); await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: 15_000 });
    await peer.close(); scheduled.delete(companyId); throw error;
  }
  const running = owner.executions[0];
  const post = async (body: string) => {
    const receipt = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    owner.bodies.push(body); return receipt.body as { id: string; body: string };
  };
  const commands = (type: string) => peer.requests.filter(command => command.type === type);
  const comments = () => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  const wakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  const queues: unknown[] = [];
  const queue = async () => {
    const view = (await request(app).get(`/api/issues/${issueId}/queued-comments`).expect(200)).body;
    queues.push(view); return view;
  };
  return { companyId, agentId, issueId, runId, userId, initial, peer, app, running, post, commands, comments, wakes, queue, owner,
    async startDelivery() {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => workerErrors.push(error) });
      work = heartbeatService(db).registerDeferredReceiptWork(coordinator, () => true); await work.ready;
      await db.transaction(tx => notifyDeferredWakesForIssue(tx, { companyId, issueId }));
    },
    async assertAnsweredOnce(messages: Array<{ id: string; body: string }>) {
      const rows = await comments();
      const text = rows.filter(row => row.authorAgentId === agentId).map(row => row.body).join("\n");
      for (const message of messages) {
        expect(text.split(`ANSWER:${message.body}`).length - 1, `one published answer for ${message.body}`).toBe(1);
        const waiting = (await wakes()).filter(wake => ["queued", "deferred_issue_execution"].includes(wake.status)
          && JSON.stringify(wake.payload).includes(message.id));
        expect(waiting, `0 waiting wakes for ${message.id}`).toEqual([]);
      }
      expect(text).not.toMatch(/wasn't answered|was not answered/i);
      expect(workerErrors).toEqual([]);
    },
    async complete() {
      peer.finish(); await running;
      expect(owner.outcomes.get(runId)?.error, "native execution must finish, not a fixture error").toBeUndefined();
      await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: 15_000 });
      await heartbeat.drainActiveRunExecutions();
      return owner.outcomes.get(runId)!.result!;
    },
    async close() {
      await work?.stop(); await coordinator?.stop();
      // Teardown must not promote the very deferred input a RED just exposed.
      // Pause admission only AFTER all row assertions, then drain the genuine
      // execution; force-exit the scripted provider if a TASK awaits finish.
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      peer.boundary(); peer.finish();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([running, new Promise(resolve => { deadline = setTimeout(resolve, 1000); })]); }
      finally { if (deadline) clearTimeout(deadline); }
      if (!owner.outcomes.has(runId)) peer.send({ type: "process_exit", code: 0, signal: null });
      await running;
      await peer.close();
      await heartbeat.drainActiveRunExecutions();
      await Promise.all(owner.executions);
      for (const scheduledPeer of owner.peers) await scheduledPeer.close();
      scheduled.delete(companyId);
      if (process.env.PAPERCLIP_STEER_RED_EVIDENCE) await writeFile(join(process.env.PAPERCLIP_STEER_RED_EVIDENCE, `${label}.json`), JSON.stringify({
        companyId, agentId, issueId, runId, commands: peer.requests, consumed: peer.consumed, replies: peer.replies, outcome: owner.outcomes.get(runId),
        successorPeers: owner.peers.slice(1).map(peer => ({ commands: peer.requests, facadeCalls: peer.facadeCalls, consumed: peer.consumed, replies: peer.replies })), workerErrors,
        queues, issue: (await db.select().from(issues).where(eq(issues.id, issueId)))[0],
        finalizations: await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId)),
        runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
        wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
        comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)),
        events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)),
      }, null, 2));
    },
  };
}

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21272
// B3's explicitly commissioned native integration rows; controlled Pi peer,
// real attachment, scheduler, comment POST, drivers and durable event ingestion.
describe("person comment default steering eligibility and asynchronous receipt", () => {
  it("S-task: a person comment on a TASK enters its attached Pi turn, without a wake or a restart", async () => {
    const f = await fixture("B-task", false);
    try {
      const message = await f.post("TASK-M: change the next step, do not stop");
      expect(message).toMatchObject({ steeredIntoRunId: f.runId });
      await vi.waitFor(() => expect(f.commands("steer").map(command => command.input?.message)).toEqual([message.body]));
      expect(f.commands("abort")).toEqual([]);
      expect((await f.wakes()).filter(wake => JSON.stringify(wake.payload).includes(message.id))).toEqual([]);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      f.peer.boundary();
      await vi.waitFor(async () => {
        const thread = (await request(f.app).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
        expect(thread.find((comment: any) => comment.id === message.id)).toMatchObject({
          steeredIntoRunId: f.runId, steeringStatus: "delivered", steeringDeliveryEventSeq: expect.any(Number),
        });
      });
    } finally { await f.close(); }
  }, 45_000);

  it("S-h2: 20 native POSTs return custody before Pi ACK or delivery, p95 under 1 second", async () => {
    const f = await fixture("B-latency");
    let release!: () => void;
    f.peer.steerAckGate = new Promise<void>(resolve => { release = resolve; });
    const samples: number[] = [], messages: Array<{ id: string; body: string }> = [];
    try {
      for (let index = 0; index < 20; index++) {
        const started = performance.now();
        const response = await request(f.app).post(`/api/issues/${f.issueId}/comments`)
          .send({ body: `LATENCY-${index}`, clientRequestId: randomUUID() });
        samples.push(performance.now() - started);
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(response.body).toMatchObject({ steeredIntoRunId: f.runId, steeringStatus: "accepted", steeringDeliveryEventSeq: null });
        messages.push(response.body);
        expect(f.peer.consumed).toEqual([]);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      expect(sorted[18], "nearest-rank p95 (19th of 20)").toBeLessThan(1000);
      // Every POST returned with the provider ACK still blocked. No delivery
      // event has occurred; acceptance must not be labelled delivered.
      expect((await f.wakes()).filter(wake => messages.some(message => JSON.stringify(wake.payload).includes(message.id)))).toEqual([]);
      release();
      await vi.waitFor(() => expect(f.commands("steer").map(command => command.input?.message)).toEqual(messages.map(message => message.body)), { timeout: 10_000 });
      f.peer.boundary();
      await vi.waitFor(async () => {
        const thread = (await request(f.app).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
        for (const message of messages) expect(thread.find((comment: any) => comment.id === message.id)).toMatchObject({
          steeredIntoRunId: f.runId, steeringStatus: "delivered", steeringDeliveryEventSeq: expect.any(Number),
        });
      }, { timeout: 10_000 });
      expect(f.commands("abort")).toEqual([]);
      expect(f.commands("prompt")).toHaveLength(1);
    } finally {
      release();
      if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, "native-post-latency.json"), JSON.stringify({
        samplesMs: samples, count: samples.length, p95Ms: [...samples].sort((a, b) => a - b)[18] ?? null,
        minMs: Math.min(...samples), maxMs: Math.max(...samples), messages,
        fixture: "real native attachment/executor, real routes/drivers/event ingestion; controlled Pi RPC peer with blocked steer ACK",
      }, null, 2));
      await f.close();
    }
  }, 60_000);
});
