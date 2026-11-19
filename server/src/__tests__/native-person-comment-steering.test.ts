import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues,
  agentWakeupRequests, nativeRunFinalizations, activityLog,
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
import { waitForPendingCommentSteers } from "../services/conversation-steering.js";
import * as commentSteering from "../services/conversation-steering.js";
import { readUnreadSteeredMessages } from "../services/native-runtime/unread-steered-messages.js";
import { readPersonStopHold } from "../services/acknowledged-native-stop.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDeferredWakesForIssue } from "../services/deferred-execution-notifications.js";
import { loadCapturedFixture, assertCapturedRoundTrip } from "./helpers/load-captured-fixture.js";
import { B6RealPiPeer } from "./helpers/b6-real-pi-peer.js";

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
  dropSteer = false;
  steerError?: Error;
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
      if (this.steerError) throw this.steerError;
      if (!this.dropSteer) this.pending.push(String(input?.message));
      data = { disposition: "queued" };
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
  first: RecordingPiPeer; outcomes: Map<string, Outcome>; attachGate?: Promise<void> }>();
const realExecute = executePaperclipNativeSession;
function backendFor(execution: Parameters<typeof realExecute>[0]["execution"], runnerInstanceId: string, peer: RecordingPiPeer) {
  const workspace = execution.workspace.cwd;
  if (!workspace) throw new Error("native steering fixture requires a workspace cwd");
  const driver = new PiRpcDriver({ model: execution.provider.kind === "pi_rpc" ? execution.provider.model : undefined,
    piRpcThinkingLevel: "off", runtimeDirectory: workspace, runnerInstanceId,
    ...(peer instanceof B6RealPiPeer ? { command: peer.command } : {}),
    environment: peer instanceof B6RealPiPeer ? peer.environment(join(workspace, "agent")) : { PI_CODING_AGENT_DIR: join(workspace, "agent") }, transportFactory: options => {
      if (peer instanceof B6RealPiPeer) return peer.attach(options);
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
    const first = owner.executions.length === 0;
    const execution = Promise.resolve(owner.attachGate).then(async () => {
      const peer = first ? owner.first : owner.first instanceof B6RealPiPeer
        ? await (async () => {
          const actual = new B6RealPiPeer(); actual.bodies = owner.bodies;
          actual.released = true; actual.finishing = true; await actual.start();
          return actual as unknown as RecordingPiPeer;
        })() : new RecordingPiPeer();
      owner.peers.push(peer);
      if (!first && !(peer instanceof B6RealPiPeer)) peer.onPrompt = message => setImmediate(() => {
        const envelope = JSON.parse(message);
        const prompt = String(envelope.task?.prompt ?? message);
        peer.boundary();
        const inputs = owner.bodies.filter(body => prompt.includes(body));
        if (inputs.length) peer.answer(inputs);
        peer.finish();
      });
      return realExecute({ ...input, useRunnerd: false, backend: backendFor(input.execution, input.runnerInstanceId, peer) });
    });
    owner.executions.push(execution.then(result => owner.outcomes.set(input.execution.binding.runId, { result }),
      error => owner.outcomes.set(input.execution.binding.runId, { error: String(error) })));
    return execution;
  });
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); });

async function fixture(label: string, conversation = true, earlyBodies: string[] = []) {
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
  const peer = process.env.B6_REAL_PI === "1" && label.startsWith("B6")
    ? await (async () => { const actual = new B6RealPiPeer(); actual.initialTool = earlyBodies.length === 0; await actual.start(); return actual as unknown as RecordingPiPeer; })()
    : new RecordingPiPeer();
  const owner = { bodies: [] as string[], peers: [] as RecordingPiPeer[], executions: [] as Promise<unknown>[], first: peer, outcomes: new Map<string, Outcome>() };
  let attach!: () => void;
  if (earlyBodies.length) Object.assign(owner, { attachGate: new Promise<void>(resolve => { attach = resolve; }) });
  const early: Array<{ id: string; body: string }> = [];
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
  if (peer instanceof B6RealPiPeer) {
    peer.bodies = owner.bodies;
    peer.beforeBoundary = async () => {
      await vi.waitFor(async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const steered = (run.contextSnapshot?.steeredCommentIds ?? []) as string[];
        const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
        for (const id of steered) expect(events.some(event => {
          const prp = event.payload?.prpEvent as { itemId?: string; payload?: { kind?: string } } | undefined;
          return prp?.payload?.kind === "steering_acknowledgement" && prp.itemId?.endsWith(`:steer:${id}`);
        }), `native ACK receipt before controlled model release: ${id}`).toBe(true);
      }, { timeout: 15_000 });
    };
  }
  try {
    if (earlyBodies.length) await vi.waitFor(() => expect(owner.executions).toHaveLength(1), { timeout: 15000 });
    for (const body of earlyBodies) {
      const receipt = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() }).expect(201);
      early.push(receipt.body); owner.bodies.push(body);
    }
    attach?.();
    await vi.waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (["failed", "cancelled", "timed_out"].includes(run.status)) throw new Error(`native fixture failed: ${run.errorCode}: ${run.error}`);
      expect(await getNativeSessionSteeringState(runId)).toMatchObject({ disposition: "available" });
      expect(peer.requests.some(command => command.type === "prompt")).toBe(true);
    }, { timeout: 15_000 });
  } catch (error) {
    // Preserve the first failed boundary. A cleanup timeout must not overwrite
    // it or leave this provider/execution alive to poison the following row.
    if (process.env.PAPERCLIP_STEER_RED_EVIDENCE) await writeFile(join(process.env.PAPERCLIP_STEER_RED_EVIDENCE, `${label}-startup-failure.json`), JSON.stringify({
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      companyId, issueId, runId, commands: peer.requests, outcomes: [...owner.outcomes],
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)),
    }, null, 2));
    let cleanupError: unknown;
    peer.boundary(); peer.finish();
    try { await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: 15_000 }); }
    catch (failure) { cleanupError = failure; }
    finally { await peer.close(); await Promise.allSettled(owner.executions); scheduled.delete(companyId); }
    if (cleanupError) throw new AggregateError([error, cleanupError], "native fixture startup failed; cleanup also missed its drain deadline");
    throw error;
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
  return { companyId, agentId, issueId, runId, userId, initial, peer, app, running, post, commands, comments, wakes, queue, owner, early,
    async startDelivery() {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => workerErrors.push(error) });
      work = heartbeatService(db).registerDeferredReceiptWork(coordinator, () => true); await work.ready;
      await db.transaction(tx => notifyDeferredWakesForIssue(tx, { companyId, issueId }));
    },
    async assertSteeredOnce(messages: Array<{ id: string; body: string }>) {
      // The parallel reply-publication builder owns issue-comment writing.
      // Here prove Pi's actual transcript and the durable native answer receipts.
      await vi.waitFor(async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        for (const message of messages) {
          expect(run.contextSnapshot?.answeredSteeredCommentIds).toContain(message.id);
          expect(peer.consumed.filter(body => body === message.body)).toHaveLength(1);
          expect(peer.replies.filter(body => body === `ANSWER:${message.body}`)).toHaveLength(1);
          expect((await wakes()).filter(w => ["queued", "deferred_issue_execution"].includes(w.status) && JSON.stringify(w.payload).includes(message.id))).toEqual([]);
        }
      }, { timeout: 15000 });
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
      await waitForPendingCommentSteers();
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
        realPi: peer instanceof B6RealPiPeer ? { command: peer.command, version: "1.5.2", modelRequests: peer.modelRequests } : null,
        successorPeers: owner.peers.slice(1).map(peer => ({ commands: peer.requests, facadeCalls: peer.facadeCalls, consumed: peer.consumed, replies: peer.replies,
          realPi: peer instanceof B6RealPiPeer ? { command: peer.command, version: "1.5.2", modelRequests: peer.modelRequests } : null })), workerErrors,
        queues, activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
        issue: (await db.select().from(issues).where(eq(issues.id, issueId)))[0],
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
  it.runIf(Boolean(process.env.B6_CAPTURE_DIR))("B6 captured gate2 failing state round-trips through real PG", async () => {
    const dir = process.env.B6_CAPTURE_DIR!;
    await loadCapturedFixture(db, dir);
    const counts = await assertCapturedRoundTrip(db, dir);
    expect(counts.heartbeat_run_events).toBe(1178);
    const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, "7d477d98-3c41-4871-a2af-c46b00928e05"));
    expect(original.contextSnapshot?.steeredCommentIds).toContain("02ecd802-31f6-4c98-8de4-87a57a64d41e");
    expect(original.contextSnapshot?.steeredCommentIds).not.toContain("9d297e17-95f8-4e07-9dc6-3afd1126e8c6");
    const [pair] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, "24de96a7-a3bb-4ab7-8e42-ce400c766044"));
    expect(pair.runId).toBe("4b215a2e-ff44-4302-ac5a-2c1f36999b46");
    if (process.env.B6_CAPTURE_DEMO_RED) expect(pair.runId, "captured PAIR1 must reach the original run, not a successor").toBe(original.id);
  }, 90_000);

  // B6: same captured timing shape; real POST/PG/scheduler/native executor,
  // controlled Pi peer (not a real model/provider qualification).
  it("B6 STARTING M1 then rapid M2/M3 all enter the same run in order, no extra run", async () => {
    const f = await fixture("B6-starting", true, ["B6-M1"]);
    try {
      const messages = [...f.early, await f.post("B6-M2"), await f.post("B6-M3")];
      await vi.waitFor(() => expect(f.commands("steer").map(c => c.input?.message)).toEqual(messages.map(m => m.body)), { timeout: 5000 });
      // Transfer the original fallback wake in the SAME prepare transaction,
      // before provider read/answer or run-end cleanup can hide a missed consume.
      for (const early of f.early) expect((await f.wakes()).find(wake => JSON.stringify(wake.payload).includes(early.id)))
        .toMatchObject({ status: "completed", runId: f.runId });
      await waitForPendingCommentSteers(); f.peer.boundary();
      await vi.waitFor(() => expect(f.peer.consumed).toEqual(messages.map(m => m.body)));
      if (process.env.B6_DUPLICATE_PROBE === "1") {
        await vi.waitFor(async () => {
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
          for (const message of messages) expect(run.contextSnapshot?.answeredSteeredCommentIds).toContain(message.id);
        });
        await f.complete(); await f.startDelivery();
        await vi.waitFor(async () => expect((await f.wakes()).filter(w => ["queued", "deferred_issue_execution", "claimed"].includes(w.status))).toEqual([]), { timeout: 15000 });
        expect(f.owner.peers, "consumed fallback must never create a duplicate native run/answer").toHaveLength(1);
      } else {
        await f.assertSteeredOnce(messages); await f.complete(); await f.startDelivery();
      }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map(r => r.id)).toEqual([f.runId]);
    } finally { await f.close(); }
  }, 45_000);

  it("B6 a lone STARTING default drains on turn attach without another POST", async () => {
    const f = await fixture("B6-lone", true, ["B6-LONE"]);
    try {
      await vi.waitFor(() => expect(f.commands("steer").map(c => c.input?.message)).toEqual(["B6-LONE"]), { timeout: 5000 });
      await waitForPendingCommentSteers(); f.peer.boundary();
      await f.assertSteeredOnce(f.early); await f.complete();
    } finally { await f.close(); }
  }, 45_000);

  it("B6 explicit Queue stays waiting while a following default steers", async () => {
    const f = await fixture("B6-queue");
    try {
      const queued = (await request(f.app).post(`/api/issues/${f.issueId}/comments`).send({ body: "B6-EXPLICIT", deliveryIntent: "queue", clientRequestId: randomUUID() }).expect(201)).body;
      const message = await f.post("B6-DEFAULT");
      await waitForPendingCommentSteers();
      expect(f.commands("steer").map(c => c.input?.message)).toEqual([message.body]);
      expect((await f.wakes()).some(w => ["queued", "deferred_issue_execution"].includes(w.status) && JSON.stringify(w.payload).includes(queued.id))).toBe(true);
    } finally { await f.close(); }
  }, 45_000);

  it("B6 unavailable M1 drains ahead of M2 and persists the observed reason across phase changes", async () => {
    const f = await fixture("B6-reason");
    const unavailable = vi.spyOn(nativeExecutor, "getNativeSessionSteeringState").mockResolvedValue({ disposition: "temporarily_unavailable", activeTurnId: null });
    try {
      await vi.waitFor(async () => expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).some(e => e.eventType === "turn.started")).toBe(true));
      const first = await f.post("B6-DEFERRED");
      const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.update(heartbeatRuns).set({ nativePhase: "starting" }).where(eq(heartbeatRuns.id, f.runId));
      const view = (await request(f.app).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
      expect(view.find((c: any) => c.id === first.id).steeringUnavailableReason).toBe("steering unavailable");
      await db.update(heartbeatRuns).set({ nativePhase: before.nativePhase }).where(eq(heartbeatRuns.id, f.runId));
      unavailable.mockRestore();
      const second = await f.post("B6-FOLLOWING");
      await waitForPendingCommentSteers();
      expect(f.commands("steer").map(c => c.input?.message)).toEqual([first.body, second.body]);
      f.peer.boundary(); await f.assertSteeredOnce([first, second]); await f.complete();
    } finally { unavailable.mockRestore(); await f.close(); }
  }, 45_000);

  it("B6 finishing input takes one ordinary next run, never a late steer", async () => {
    const f = await fixture("B6-finishing");
    const release = f.peer.holdClose();
    try {
      f.peer.finish();
      await vi.waitFor(async () => expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).some(e => e.eventType === "turn.completed")).toBe(true));
      await vi.waitFor(async () => expect((await getNativeSessionSteeringState(f.runId)).disposition).not.toBe("available"));
      const message = await f.post("B6-LATE");
      expect(f.commands("steer")).toEqual([]);
      release(); await f.complete(); await f.startDelivery();
      await vi.waitFor(async () => { await f.assertAnsweredOnce([message]); }, { timeout: 15000 });
      expect(f.owner.peers).toHaveLength(2);
      expect(f.owner.peers[1].requests.filter(r => r.type === "prompt")).toHaveLength(1);
    } finally { release(); await f.close(); }
  }, 45_000);

  it("B6 turn attachment racing ordinary fallback admission cannot strand the lone message", async () => {
    const f = await fixture("B6-admission-race");
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "B6-RACING" }).returning();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const unavailable = vi.spyOn(nativeExecutor, "getNativeSessionSteeringState").mockResolvedValue({ disposition: "temporarily_unavailable", activeTurnId: null });
    const handling = commentSteering.trySteerPersonComment(db, message, { deliveryIntent: "steer", onRejected: async () => {
      entered = true; await gate;
      return heartbeatService(db).wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        idempotencyKey: `conversation-comment:${message.id}`, requestedByActorType: "user", requestedByActorId: f.userId,
        payload: { issueId: f.issueId, commentId: message.id },
        contextSnapshot: { issueId: f.issueId, wakeCommentId: message.id, wakeCommentIds: [message.id], source: "issue.comment" } });
    } });
    let draining: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      unavailable.mockRestore();
      draining = commentSteering.drainFallbackPersonComments(db, f.runId);
      release(); expect(await handling).toBe(true); await draining;
      await waitForPendingCommentSteers();
      expect(f.commands("steer").map(c => c.input?.message)).toEqual([message.body]);
      f.peer.boundary(); await f.assertSteeredOnce([message]); await f.complete();
    } finally { release(); unavailable.mockRestore(); await handling; await draining; await f.close(); }
  }, 45_000);

  it("B6 /new waiting remains a hard ordering boundary", async () => {
    const f = await fixture("B6-new");
    try {
      await f.post("/new"); await f.post("B6-AFTER-NEW");
      await waitForPendingCommentSteers(); expect(f.commands("steer")).toEqual([]);
    } finally { await f.close(); }
  }, 45_000);

  it("B6c admission rechecks attachment after a no-work turn-start drain", async () => {
    const f = await fixture("B6c-negative-drain");
    try {
      // Finish the initial observer before forcing the stale-probe crossing.
      await vi.waitFor(async () => expect((await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, f.runId))).some(event => event.eventType === "tool.execution.started")).toBe(true), { timeout: 15_000 });
      await commentSteering.drainFallbackPersonComments(db, f.runId);
      const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, body: "B6c-STALE-PROBE" }).returning();
      // The sender observed no attachment; it becomes available while its
      // ordinary admission commits, after turn-start's no-work observation.
      const probe = vi.spyOn(nativeExecutor, "getNativeSessionSteeringState")
        .mockResolvedValueOnce({ disposition: "temporarily_unavailable", activeTurnId: null });
      try {
        expect(await commentSteering.trySteerPersonComment(db, message, { deliveryIntent: "steer", onRejected: () =>
          heartbeatService(db).wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
            idempotencyKey: `conversation-comment:${message.id}`, requestedByActorType: "user", requestedByActorId: f.userId,
            payload: { issueId: f.issueId, commentId: message.id }, contextSnapshot: { issueId: f.issueId,
              wakeCommentId: message.id, wakeCommentIds: [message.id], source: "issue.comment" } }) })).toBe(true);
        await waitForPendingCommentSteers();
        expect(f.commands("steer").map(command => command.input?.message)).toEqual([message.body]);
        f.peer.boundary(); await f.assertSteeredOnce([message]); await f.complete();
      } finally { probe.mockRestore(); }
    } finally { await f.close(); }
  }, 45_000);

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21272
  it("B6d fallback attachment probe never holds the issue delivery lock", async () => {
    const f = await fixture("B6d-probe-lock");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const probing = new Promise<void>(resolve => { entered = resolve; });
    let draining: Promise<void> | undefined;
    let probe: { mockRestore: () => void } | undefined;
    try {
      await vi.waitFor(async () => expect((await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, f.runId))).some(event => event.eventType === "tool.execution.started")).toBe(true), { timeout: 15_000 });
      const state = await getNativeSessionSteeringState(f.runId);
      const unavailable = vi.spyOn(nativeExecutor, "getNativeSessionSteeringState")
        .mockResolvedValue({ disposition: "temporarily_unavailable", activeTurnId: null });
      let message: { id: string; body: string };
      try { message = await f.post("B6d-PROBE-LOCK"); } finally { unavailable.mockRestore(); }
      probe = vi.spyOn(nativeExecutor, "getNativeSessionSteeringState").mockImplementationOnce(async () => {
        entered(); await gate; return state;
      });
      draining = commentSteering.drainFallbackPersonComments(db, f.runId);
      await probing;
      const rows = await db.transaction(tx => tx.execute(sql`select pg_try_advisory_xact_lock(
        hashtextextended(${commentSteering.personCommentDeliveryLockKey(f.issueId)}, 0)) as acquired`));
      const acquired = rows[0]?.acquired;
      if (process.env.PAPERCLIP_STEER_RED_EVIDENCE) await writeFile(join(process.env.PAPERCLIP_STEER_RED_EVIDENCE, "B6d-probe-lock-observation.json"),
        JSON.stringify({ runId: f.runId, issueId: f.issueId, acquiredWhileProbeHeld: acquired }));
      release(); await draining;
      expect(acquired, "an unrelated Send must acquire the issue lock while Pi attachment I/O is held").toBe(true);
      await waitForPendingCommentSteers();
      expect(f.commands("steer").map(command => command.input?.message)).toEqual([message.body]);
      f.peer.boundary(); await f.assertSteeredOnce([message]); await f.complete();
    } finally { release(); probe?.mockRestore(); await draining; await f.close(); }
  }, 45_000);

  it("S-task: a person comment on a TASK enters its attached Pi turn, without a wake or a restart", async () => {
    const f = await fixture("B-task", false);
    try {
      const message = await f.post("TASK-M: change the next step, do not stop");
      expect(message).toMatchObject({ steeredIntoRunId: f.runId, steerDeliveredAt: null });
      await vi.waitFor(() => expect(f.commands("steer").map(command => command.input?.message)).toEqual([message.body]));
      expect(f.commands("abort")).toEqual([]);
      expect((await f.wakes()).filter(wake => JSON.stringify(wake.payload).includes(message.id))).toEqual([]);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      f.peer.boundary();
      await vi.waitFor(async () => {
        const thread = (await request(f.app).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
        expect(thread.find((comment: any) => comment.id === message.id)).toMatchObject({
          steeredIntoRunId: f.runId, steeringStatus: "delivered", steeringDeliveryEventSeq: expect.any(Number),
          steerDeliveredAt: expect.any(String),
        });
      });
      const thread = (await request(f.app).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
      const [carrying] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(carrying.contextSnapshot?.steeredDeliveredAts).toMatchObject({ [message.id]: expect.any(String) });
      expect(thread.find((comment: any) => comment.id === message.id).steerDeliveredAt)
        .toBe((carrying.contextSnapshot?.steeredDeliveredAts as Record<string, string>)[message.id]);
    } finally { await f.close(); }
  }, 45_000);

  it.each([[true, false], [true, true], [false, false], [false, true]] as const)(
    "B4 retry: conversation=%s concurrent=%s produces one saved comment and one native steer", async (conversation, concurrent) => {
      const f = await fixture(`B4-retry-${conversation}-${concurrent}`, conversation);
      let release!: () => void;
      f.peer.steerAckGate = new Promise<void>(resolve => { release = resolve; });
      try {
        const body = `RETRY-${conversation}-${concurrent}`, clientRequestId = randomUUID();
        const post = () => request(f.app).post(`/api/issues/${f.issueId}/comments`).send({ body, clientRequestId });
        const responses = concurrent ? await Promise.all([post(), post()]) : [await post(), await post()];
        for (const response of responses) expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(responses[0].body.id).toBe(responses[1].body.id);
        expect((await f.comments()).filter(comment => comment.clientRequestId === clientRequestId)).toHaveLength(1);
        release(); await waitForPendingCommentSteers();
        expect(f.commands("steer").map(command => command.input?.message)).toEqual([body]);
        expect((await f.wakes()).filter(wake => JSON.stringify(wake.payload).includes(responses[0].body.id))).toEqual([]);
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
        f.peer.boundary();
        await vi.waitFor(async () => {
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
          expect(run.contextSnapshot?.answeredSteeredCommentIds).toEqual([responses[0].body.id]);
        });
        expect(f.peer.consumed).toEqual([body]);
      } finally { release(); await f.close(); }
    }, 45_000,
  );

  // B4: fault only the provider receipt boundary. Timeout rows retain the real
  // native timeout implementation; shorten its deadline, not the dispatch path.
  it.each([true, false])("B4 timeout: Pi took M=%s; answer once, carry only unread input", async took => {
    const f = await fixture(`B4-timeout-${took}`);
    const realSteer = nativeExecutor.steerNativeSession;
    const fault = vi.spyOn(nativeExecutor, "steerNativeSession").mockImplementation(input => realSteer({ ...input, timeoutMs: 40 }));
    let release!: () => void;
    f.peer.steerAckGate = new Promise<void>(resolve => { release = resolve; });
    f.peer.dropSteer = !took;
    try {
      const message = await f.post(`TIMEOUT-${took}-M`);
      await waitForPendingCommentSteers();
      expect(f.commands("steer")).toHaveLength(1);
      const [pending] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect((pending.resultJson?.queuedSteeringAcknowledgements as any)[message.id].status).toBe("pending");
      f.peer.boundary();
      if (took) {
        // B5: RPC timed out; hold the ACK through terminal settlement/release.
        // Actual Pi read/text, not the still-pending ACK, must discharge M.
        await vi.waitFor(async () => {
          const [read] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
          expect(read.contextSnapshot?.answeredSteeredCommentIds).toContain(message.id);
        });
      }
      await f.complete();
      const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect((ended.resultJson?.restoredSteeredCommentIds as string[] | undefined) ?? []).toEqual(took ? [] : [message.id]);
      // Ordinary release may already have promoted and answered the successor;
      // count its actual native prompt below, not an intermediate wake shape.
      release();
      await f.startDelivery();
      if (took) {
        // Mid-run reply publication belongs to the parallel builder. This gate
        // checks the native answer/read/carry boundary, not that separate writer.
        expect(f.peer.replies.filter(reply => reply === `ANSWER:${message.body}`)).toHaveLength(1);
        expect((await f.wakes()).filter(w => !w.runId && JSON.stringify(w.payload).includes(message.id))).toEqual([]);
      } else await vi.waitFor(async () => { await f.assertAnsweredOnce([message]); }, { timeout: 15_000 });
      expect(f.peer.consumed.filter(body => body === message.body)).toHaveLength(took ? 1 : 0);
      const successors = f.owner.peers.slice(1).flatMap(peer => peer.requests.filter(r => r.type === "prompt"));
      expect(successors.filter(r => String(r.input?.message).includes(message.body))).toHaveLength(took ? 0 : 1);
    } finally { release(); fault.mockRestore(); await f.close(); }
  }, 60_000);

  it.each(["rpc-error", "generic-dispatch-error"] as const)("B4 dispatch %s: no 500 or unhandled rejection, one ordinary answer", async kind => {
    const f = await fixture(`B4-${kind}`);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const fault = kind === "generic-dispatch-error"
      ? vi.spyOn(nativeExecutor, "steerNativeSession").mockRejectedValueOnce(new Error("B4 generic dispatch fault")) : undefined;
    if (kind === "rpc-error") f.peer.steerError = new Error("B4 provider RPC refused input");
    try {
      const message = await f.post(`ERROR-${kind}-M`);
      await waitForPendingCommentSteers();
      if (kind === "rpc-error") {
        const thread = (await request(f.app).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
        expect(thread.find((comment: any) => comment.id === message.id)).toMatchObject({
          deliveryOutcome: "queued", steeringStatus: null, steeringUnavailableReason: expect.any(String),
        });
        expect((await f.queue()).entries.map((entry: any) => entry.comment.id)).toContain(message.id);
      }
      f.peer.boundary();
      await f.complete();
      await f.startDelivery();
      await vi.waitFor(async () => { await f.assertAnsweredOnce([message]); }, { timeout: 15_000 });
      expect(f.peer.consumed).not.toContain(message.body);
      expect(f.owner.peers.slice(1).flatMap(peer => peer.requests.filter(r => r.type === "prompt"))
        .filter(r => String(r.input?.message).includes(message.body))).toHaveLength(1);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally { fault?.mockRestore(); process.off("unhandledRejection", onUnhandled); await f.close(); }
  }, 60_000);

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
        expect(samples.at(-1), `POST ${index} must return the decision while Pi ACK is blocked`).toBeLessThan(1000);
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
