import { wiredHeartbeatFor } from "../services/heartbeat-registry.js";
import { nativeWorkspaceFinalizationWork } from "../services/native-runtime/native-workspace-finalization-work.js";
import { recordNativeWorkspaceFinalizationFailure } from "../services/native-runtime/native-workspace-finalizer.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";
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
  agentWakeupRequests, nativeRunFinalizations, completionContracts, chatCompletionDeliveries, issueRecoveryActions, activityLog,
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
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as heartbeatModule from "../services/heartbeat.js";
import { waitForPendingCommentSteers } from "../services/conversation-steering.js";
import * as commentSteering from "../services/conversation-steering.js";
import { readUnreadSteeredMessages } from "../services/native-runtime/unread-steered-messages.js";
import { readPersonStopHold } from "../services/acknowledged-native-stop.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDeferredWakesForIssue } from "../services/deferred-execution-notifications.js";
import { chatCompletionDeliveryService } from "../services/chat-completion-delivery.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { clearProcessHeartbeat, registerProcessHeartbeat } from "../services/heartbeat-registry.js";
import { withNativeWorkspaceFinalizationOwnership, NativeWorkspaceFinalizationBusyError } from "../services/native-runtime/native-workspace-finalization-ownership.js";
import { registerNativeResponsePresentationWork } from "../services/native-runtime/native-response-presentation-work.js";
import { registerNativeCleanupReleaseWake } from "../services/native-runtime/native-cleanup-release-wake.js";
import { settleOwnableKind } from "../services/recovery/ownership-invariant-report.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { recoveryService } from "../services/recovery/service.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { loadCapturedFixture, assertCapturedRoundTrip } from "./helpers/load-captured-fixture.js";
import { B6RealPiPeer } from "./helpers/b6-real-pi-peer.js";

// Keep reason: BRIEF-RED.md S-a..S-e and the recorded 11-17 S9 loss at
// 0d59da31. Explicitly requested route/native integration REDs, not live model proof.
// Only Pi's RPC peer is scripted, at the existing executor backend test seam.
// The comment route, wake admission, Pi driver, native executor, event persistence,
// answer publication and queue/Stop readers remain production code.
class RecordingPiPeer {
  preAttached = false;
  previousRunEvents: unknown[] = [];
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
  closing?: () => void;
  steerAckGate?: Promise<void>;
  dropSteer = false;
  steerError?: Error;
  holdClose() {
    let release!: () => void; this.closeGate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { this.closing = resolve; });
    return Object.assign(release, { entered });
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
  boundary(answer = true): void | Promise<void> {
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
  async close() { this.closing?.(); await this.closeGate; this.closed = this.exited = true; this.wake?.(); }
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
  first: RecordingPiPeer; outcomes: Map<string, Outcome>; contendAtFinalization?: boolean; deferCommitAtReturn?: boolean;
  deferredPhase?: "observed" | "applied"; attachGate?: Promise<void> }>();
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
  const backend = createRunnerdNativeSessionBackend(execution, { runnerInstanceId, transportFactory: () => {
    const facade = new PiFacadeTransport(driver, execution.binding.runId, execution.session.normalizedSessionId!);
    peer.facadeCalls = facade.calls; return facade;
  } });
  if (peer.preAttached) {
    const open = backend.openSession.bind(backend);
    backend.openSession = async input => {
      // A real retained facade has already emitted its startup source prefix
      // for the previous run. Drain that prefix, then use its REAL attachRun;
      // do not synthesize events, source sequences, cursors, or ingestion state.
      const session = await open({ ...input, identity: { ...input.identity, runId: randomUUID() } });
      const prior = await session.snapshot();
      const events = session.events()[Symbol.asyncIterator]();
      for (let n = 0; n < Number(prior.cursor); n++) {
        const next = await events.next();
        if (next.done) throw new Error("retained fixture lost startup prefix");
        peer.previousRunEvents.push(next.value);
      }
      await session.attachRun!({ identity: input.identity });
      return session;
    };
  }
  return backend;
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
  // Do not install a second appendEvent spy here: the INGEST rows wrap that
  // method themselves. Vitest reuses a spy, so capturing it and replacing its
  // implementation would recurse before the fresh session can start.
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
    }).then(async result => {
      if (owner.deferCommitAtReturn && first) {
        await db.update(nativeRunFinalizations).set({ phase: owner.deferredPhase ?? "observed", leaseOwner: "native-row-reconciler",
          leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, input.execution.binding.runId));
      }
      if (owner.contendAtFinalization && first) {
        // Apply the runtime's REAL ownership arbitration at this local backend
        // seam. Production remote workspace completion does this at runtime-
        // execution.ts:1097-1100. The competing physical lock is real Postgres;
        // the error flows through the real runtime/heartbeat busy return.
        const owned = await withNativeWorkspaceFinalizationOwnership({ db,
          companyId: input.execution.binding.companyId, runId: input.execution.binding.runId }, async () => undefined);
        if (!owned.acquired) throw new NativeWorkspaceFinalizationBusyError();
        throw new Error("completion row expected real finalization contention");
      }
      return result;
    });
    owner.executions.push(execution.then(result => owner.outcomes.set(input.execution.binding.runId, { result }),
      error => owner.outcomes.set(input.execution.binding.runId, { error: String(error) })));
    return execution;
  });
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); });

async function fixture(label: string, conversation = true, skipIssueComment: boolean | string[] = true, preAttached = false, stopDuringStarting = false) {
  const earlyBodies = Array.isArray(skipIssueComment) ? skipIssueComment : [];
  if (Array.isArray(skipIssueComment)) skipIssueComment = true;
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
  peer.preAttached = preAttached;
  let releaseAdmission = () => {};
  let admissionEntered: Promise<void> | undefined;
  let stopElapsedMs: number | undefined;
  if (stopDuringStarting) {
    if (!(peer instanceof B6RealPiPeer)) throw new Error("STARTING Stop requires B6_REAL_PI=1");
    admissionEntered = new Promise<void>(resolve => { peer.admissionEntered = resolve; });
    peer.admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
  }
  const owner = { contendAtFinalization: false, deferCommitAtReturn: false, deferredPhase: "observed" as "observed" | "applied", bodies: [] as string[], peers: [] as RecordingPiPeer[], executions: [] as Promise<unknown>[], first: peer, outcomes: new Map<string, Outcome>() };
  let attach!: () => void;
  if (earlyBodies.length) Object.assign(owner, { attachGate: new Promise<void>(resolve => { attach = resolve; }) });
  const early: Array<{ id: string; body: string }> = [];
  scheduled.set(companyId, owner);
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let work: ReturnType<ReturnType<typeof heartbeatService>["registerDeferredReceiptWork"]> | undefined;
  let unsubscribeCleanup: (() => void) | undefined;
  let presentation: ReturnType<typeof registerNativeResponsePresentationWork> | undefined;
  const workerErrors: unknown[] = [];
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false,
    memberships: [{ companyId, status: "active", membershipRole: "operator" }] }; next(); });
  app.use("/api", issueRoutes(db, {} as any, {})); app.use("/api", agentRoutes(db)); app.use(errorHandler);
  const heartbeat = heartbeatService(db);
  const admission = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
    requestedByActorType: "user", requestedByActorId: userId,
    payload: { issueId, commentId: initial, mutation: "comment" },
    contextSnapshot: { issueId, taskId: issueId, wakeCommentId: initial, wakeCommentIds: [initial], skipIssueComment } });
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
    if (stopDuringStarting) {
      await admissionEntered;
      const [starting] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(starting.status).toBe("running");
      // STARTING is the unpublished native handle, not the finalizer's
      // nativePhase (which can already be "observed" during provider setup).
      expect(await getNativeSessionSteeringState(runId)).toMatchObject({ disposition: "temporarily_unavailable" });
      expect(peer.requests.some(command => command.type === "prompt")).toBe(false);
      const stopAt = Date.now();
      const stopping = request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({}).then(response => response);
      try {
        await vi.waitFor(async () => {
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          expect(run.resultJson?.nativeCancellation).toMatchObject({ scope: "run", dispatchState: "pending" });
        }, { timeout: 5000 });
      } finally { releaseAdmission(); }
      const stopped = await stopping;
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: Math.max(1, 15_000 - (Date.now() - stopAt)) });
      stopElapsedMs = Date.now() - stopAt;
      expect(stopElapsedMs).toBeLessThan(15_000);
    } else await vi.waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (["failed", "cancelled", "timed_out"].includes(run.status)) throw new Error(`native fixture failed: ${run.errorCode}: ${run.error}`);
      expect(await getNativeSessionSteeringState(runId)).toMatchObject({ disposition: "available" });
      expect(peer.requests.some(command => command.type === "prompt")).toBe(true);
      // A sent prompt/allocated turn is not the fixture's busy-provider boundary.
      // Join real ingestion before a row mutates or finishes that active turn.
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      expect(events.some(event => event.eventType === "turn.started")).toBe(true);
      if (peer instanceof B6RealPiPeer) {
        expect(peer.modelRequests.length).toBeGreaterThan(0);
        if (peer.initialTool) expect(events.some(event => event.eventType === "tool.execution.started")).toBe(true);
      } else expect(events.some(event => event.eventType === "tool.execution.started")).toBe(true);
    }, { timeout: 15_000 });
  } catch (error) {
    // Preserve the first failed boundary. A cleanup timeout must not overwrite
    // it or leave this provider/execution alive to poison the following row.
    if (process.env.PAPERCLIP_STEER_RED_EVIDENCE) await writeFile(join(process.env.PAPERCLIP_STEER_RED_EVIDENCE, `${label}-startup-failure.json`), JSON.stringify({
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      companyId, issueId, runId, commands: peer.requests, outcomes: [...owner.outcomes],
      requestSettlements: peer instanceof B6RealPiPeer ? peer.requestSettlements : undefined,
      databaseActivity: await db.execute(sql`select clock_timestamp() as sampled_at, pid, state,
        query_start, xact_start, clock_timestamp() - query_start as query_age, wait_event_type, wait_event,
        pg_blocking_pids(pid) as blocking_pids, left(query, 400) as query
        from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)),
    }, null, 2));
    let cleanupError: unknown;
    releaseAdmission();
    peer.boundary(); peer.finish();
    try { await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: 15_000 }); }
    catch (failure) { cleanupError = failure; }
    finally { await peer.close(); await Promise.allSettled(owner.executions); scheduled.delete(companyId); }
    if (cleanupError) throw new AggregateError([error, cleanupError], "native fixture startup failed; cleanup also missed its drain deadline");
    throw error;
  }
  const running = owner.executions[0];
  const post = async (body: string, deliveryIntent?: "queue") => {
    const receipt = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, deliveryIntent, clientRequestId: randomUUID() });
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
  return { companyId, agentId, issueId, runId, userId, initial, peer, app, running, post, commands, comments, wakes, queue, owner, early, stopElapsedMs,
    async startDelivery(completions = false) {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => workerErrors.push(error) });
      if (completions) {
        unsubscribeCleanup = registerNativeCleanupReleaseWake(db, error => workerErrors.push(error));
        presentation = registerNativeResponsePresentationWork(db, coordinator, () => true); await presentation.ready;
        const service = chatCompletionDeliveryService(db, heartbeat);
        await coordinator.register(DELIVERY_QUEUES.chatCompletion, { retryMs: 1000,
          run: () => service.sweepPending(), hasPending: service.hasPending }).ready;
      }
      work = heartbeatService(db).registerDeferredReceiptWork(coordinator, () => true); await work.ready;
      await db.transaction(tx => notifyDeferredWakesForIssue(tx, { companyId, issueId }));
    },
    async stopDelivery() {
      await work?.stop(); await coordinator?.stop(); unsubscribeCleanup?.(); presentation?.stop();
      work = undefined; coordinator = undefined; unsubscribeCleanup = undefined;
    },
    async passDelivery() {
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
      await work?.stop(); await coordinator?.stop(); unsubscribeCleanup?.(); presentation?.stop();
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
        companyId, agentId, issueId, runId, stopElapsedMs, commands: peer.requests, previousRunEvents: peer.previousRunEvents,
        consumed: peer.consumed, replies: peer.replies, outcome: owner.outcomes.get(runId),
        requestSettlements: peer instanceof B6RealPiPeer ? peer.requestSettlements : undefined,
        realPi: peer instanceof B6RealPiPeer ? { command: peer.command, version: "1.5.2", modelRequests: peer.modelRequests } : null,
        successorPeers: owner.peers.slice(1).map(peer => ({ commands: peer.requests, facadeCalls: peer.facadeCalls, consumed: peer.consumed, replies: peer.replies,
          realPi: peer instanceof B6RealPiPeer ? { command: peer.command, version: "1.5.2", modelRequests: peer.modelRequests } : null })), workerErrors,
        queues, activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
        issue: (await db.select().from(issues).where(eq(issues.id, issueId)))[0],
        finalizations: await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId)),
        runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
        wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
        comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)),
        completionDeliveries: await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.companyId, companyId)),
        recoveryActions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId)),
        events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)),
      }, null, 2));
    },
  };
}

it.each([500, 8])("BOUND native: coalesce %i ms before end gets one real answering turn", async gap => {
  const f = await fixture(`personbound${gap}`);
  const hb = await wiredHeartbeatFor(db, "test:deferred-person-bound:native-row");
  try {
    f.owner.deferCommitAtReturn = true;
    const messages = [];
    for (const body of ["BOUND first question", "BOUND second question", "BOUND last question"])
      messages.push(await f.post(`${body} ${gap}`, "queue"));
    f.peer.boundary(); f.peer.answer(["Original work done"]);
    await f.complete();
    const [wake] = (await f.wakes()).filter(w => w.status === "deferred_issue_execution" && w.requestedByActorType === "user");
    expect(wake).toBeDefined();
    // Persist the missed post-commit handoff: the real source ended, its
    // coordinator committed, but no task lock is left to drive old recovery.
    const last = new Date(Date.now() - 13_000);
    await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, f.issueId));
    // The bound's quiet clock is the last COALESCE (requested_at / the coalesce marker),
    // never updated_at (rf-3 C1 on 7d1ee176): backdate those, not updatedAt.
    await db.update(agentWakeupRequests).set({ updatedAt: last, requestedAt: last,
      payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{_paperclipLastCoalescedAt}', to_jsonb(${last.toISOString()}::text))` })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(last.getTime() + gap) })
      .where(eq(heartbeatRuns.id, f.runId));
    await hb.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
    await vi.waitFor(() => f.assertAnsweredOnce(messages), { timeout: 15_000 });
    await hb.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs.filter(r => r.id !== f.runId)).toHaveLength(1);
    await hb.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
    await f.assertAnsweredOnce(messages);
    process.stdout.write(`BOUND native evidence ${JSON.stringify({ gap, sourceRunId: f.runId, wakeId: wake.id,
      successorRunId: runs.find(r => r.id !== f.runId)!.id, messages })}\n`);
  } finally { await f.close(); }
}, 45_000);

// Native completion producer: create_task records the handoff; the control-plane
// result and real native finalizer/committer create its delivery. No hand-made
// delivery or deferred wake substitutes for either producer.
async function completionTask(f: Awaited<ReturnType<typeof fixture>>, label: string) {
  const workerId = randomUUID();
  await db.insert(agents).values({ id: workerId, companyId: f.companyId, name: `Worker ${label}`,
    status: "active", adapterType: "paperclip_runner", runtimeConfig: { heartbeat: { enabled: false } } });
  const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, issueId: f.issueId,
    agentId: f.agentId, runId: f.runId });
  let task: { id: string; identifier: string };
  try {
    const receipt = await authority.execute({ tool: "create_task", callId: label,
      arguments: { idempotencyKey: label, title: label, status: "backlog", assigneeActorId: workerId } }) as { task: typeof task };
    task = receipt.task;
  } finally { authority.close(); }
  f.owner.bodies.push(task.identifier);
  const contractId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
  const revision = CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim!.contractRevision;
  await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: task.id, revision: 1,
    schemaVersion: "paperclip.completion-contract.v1", policyVersion: "completion-promotion-row", risk: "low",
    completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal",
    contractJson: { revision, objective: label, criteria: [{ id: "objective", requirement: "Complete the task" }] },
    canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "completion-promotion-row" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: workerId, runtimeMode: "native",
    nativeIssueId: task.id, nativeSessionId: sessionId, runnerInstanceId, status: "running", startedAt: new Date(),
    completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: { issueId: task.id } });
  const port = new PaperclipControlPlanePort(db, { companyId: f.companyId, issueId: task.id, runId, agentId: workerId,
    sessionId, completionContractId: contractId, completionContractSha256: contractId,
    sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: "completion-promotion-row" });
  await port.openRun({ identity: { runId, sessionId, companyId: f.companyId, issueId: task.id, agentId: workerId },
    backendKind: "mock", sourceInstanceId: runnerInstanceId });
  return { ...task, async finish() {
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: `${runId}:result` });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0].status).toBe("done");
    const [delivery] = await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.taskId, task.id));
    expect(delivery, "the real native Done producer owes a durable completion").toBeDefined();
    return delivery;
  } };
}

// rf-3 11a/11b: native scheduler/executor, native completion producer, outbox,
// real ownership-registry settlement and shared release drain. The Pi peer is
// scripted; busy/lease contention is injected at the existing backend seam.
describe("native completion promotion (rf3-ibpair)", () => {
  const completionWakes = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.wakes())
    .filter(wake => Array.isArray(wake.payload?.chatCompletionDeliveryIds));
  async function assertReported(f: Awaited<ReturnType<typeof fixture>>, task: { id: string; identifier: string }) {
    await vi.waitFor(async () => {
      const [delivery] = await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.taskId, task.id));
      expect(delivery).toMatchObject({ status: "delivered", responseCommentId: expect.any(String) });
      const comments = await f.comments();
      const reports = comments.filter(comment => comment.authorType === "agent" && comment.body.includes(`ANSWER:${task.identifier}`));
      expect(reports).toHaveLength(1);
      const reply = comments.find(comment => comment.authorType === "agent" && comment.createdByRunId === f.runId);
      expect(reply, "the owner's reply must be visible before the report").toBeDefined();
      expect(reply!.createdAt.getTime()).toBeLessThanOrEqual(reports[0].createdAt.getTime());
    }, { timeout: 15_000 });
    await heartbeatService(db).drainActiveRunExecutions();
  }
  async function settleOwner(f: Awaited<ReturnType<typeof fixture>>) {
    // The real ownership-registry entry (not heartbeat's directly wired sweep)
    // must retain the release callback when it wins the guarded lock clear.
    return settleOwnableKind(db, "issue_execution_lock", { runIds: [f.runId] });
  }
  async function finishAcrossAdmissionWindow(f: Awaited<ReturnType<typeof fixture>>, heldKind: "completion" | "person" = "completion") {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let acquired = false;
    const physicalOwner = withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId },
      async () => { acquired = true; await gate; });
    try {
      await vi.waitFor(() => expect(acquired).toBe(true));
      f.owner.contendAtFinalization = true;
      f.peer.finish(); await f.running;
      await heartbeatService(db).waitForRunExecutionDrain(f.runId, { timeoutMs: 15_000 });
      expect(f.owner.outcomes.get(f.runId)?.error).toContain("native_workspace_finalization_busy");
      expect((await f.wakes()).some(wake => wake.status === "deferred_issue_execution" &&
        (heldKind === "completion" ? Array.isArray(wake.payload?.chatCompletionDeliveryIds)
          : wake.idempotencyKey?.startsWith("conversation-comment:")))).toBe(true);
    } finally { release(); await physicalOwner; }
    // The durable finalization owner finishes WITHOUT re-entering completeRun.
    // Then the real ownership-registry settlement must hand the e39 receipt
    // to the existing release drain, without a new person message.
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    // The durable owner also settles its environment (the production
    // settleRecoveredNativeWorkspace tail), not just its result row. Busy
    // ownership deliberately made the live heartbeat retain this lease.
    await heartbeatService(db).releaseEnvironmentLeasesForRun({ runId: f.runId, companyId: f.companyId,
      agentId: f.agentId, status: "succeeded" });
  }
  async function answerNewer(f: Awaited<ReturnType<typeof fixture>>, body: string) {
    const message = await f.post(body);
    await vi.waitFor(() => expect(f.commands("steer").some(command => command.input?.message === body)).toBe(true));
    f.peer.boundary();
    await vi.waitFor(() => expect(f.peer.replies).toContain(`ANSWER:${message.body}`));
  }
  async function held(f: Awaited<ReturnType<typeof fixture>>, task: Awaited<ReturnType<typeof completionTask>>) {
    const delivery = await task.finish();
    await chatCompletionDeliveryService(db, heartbeatService(db)).deliver(delivery.id);
    await vi.waitFor(async () => expect(await completionWakes(f)).toHaveLength(1), { timeout: 5000 });
    const [wake] = await completionWakes(f);
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { issueId: f.issueId, chatCompletionDeliveryIds: [delivery.id],
        _paperclipWakeContext: { wakeReason: "chat_task_completed" }, interactionOrigin: expect.any(Object) } });
    expect(wake.payload?.executionWait).toBeUndefined();
    return { delivery, wake };
  }
  it("p-deferred: last-second person Queue leaves a REAL busy-deferred wake; busy return delivers and answers it ONCE", async () => {
    const f = await fixture("wire-person-deferred", true, false);
    try {
      const message = await f.post("P-DEFERRED: answer this last-second person question", "queue");
      await waitForPendingCommentSteers();
      const personWakes = () => f.wakes().then(rows => rows.filter(w => w.idempotencyKey === `conversation-comment:${message.id}`));
      await vi.waitFor(async () => expect(await personWakes()).toHaveLength(1), { timeout: 5000 });
      expect((await personWakes())[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(f.peer.consumed).not.toContain(message.body);
      expect(f.commands("steer")).toEqual([]);
      expect(f.owner.peers).toHaveLength(1);
      const started = Date.now();
      await finishAcrossAdmissionWindow(f, "person");
      await settleOwner(f);
      await vi.waitFor(async () => { await f.assertAnsweredOnce([message]); }, { timeout: 30_000 });
      await heartbeatService(db).drainActiveRunExecutions();
      expect(Date.now() - started).toBeLessThan(30_000);
      const successors = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter(run => run.id !== f.runId);
      expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot?.wakeCommentIds).toContain(message.id);
      expect(f.owner.peers.slice(1).flatMap(peer => peer.requests.filter(r => r.type === "prompt"))
        .filter(r => String(r.input?.message).includes(message.body))).toHaveLength(1);
      await settleOwner(f);
      await f.startDelivery(); await f.passDelivery();
      await new Promise(resolve => setTimeout(resolve, 100));
      await f.assertAnsweredOnce([message]);
      console.info("P-DEFERRED persisted proof", JSON.stringify({ elapsedMs: Date.now() - started, messageId: message.id,
        wake: (await personWakes())[0], successor: successors[0].id, successorContext: successors[0].contextSnapshot }));
    } finally { await f.close(); }
  }, 60_000);

  it.each(["exhausted-1", "exhausted-2", "exhausted-3", "overdue-live", "overdue-restart"] as const)("FAILEDRUN route %s: saved result fails copy-back; deferred person gets ONE successor and answer", async mode => {
    const f = await fixture(`failedrun-${mode}`, true, false);
    let release!: () => void;
    let owned: Promise<unknown> | undefined;
    try {
      const message = await f.post(`FAILEDRUN-${mode}: answer my last-second question`, "queue");
      await waitForPendingCommentSteers();
      expect((await f.wakes()).filter(w => w.status === "deferred_issue_execution")).toHaveLength(1);
      let entered = false;
      const held = new Promise<void>(resolve => { release = resolve; });
      owned = withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId },
        async () => { entered = true; await held; });
      await vi.waitFor(() => expect(entered).toBe(true));
      f.owner.contendAtFinalization = true;
      f.peer.finish(); await f.running;
      await heartbeatService(db).waitForRunExecutionDrain(f.runId, { timeoutMs: 15_000 });
      expect(f.owner.outcomes.get(f.runId)?.error).toContain("native_workspace_finalization_busy");
      release(); await owned;
      const heartbeat = heartbeatService(db);
      const worker = () => nativeWorkspaceFinalizationWork(db, {
        // Only the external failed export result is injected. Native ownership,
        // finalizer, saved-result retry policy, wake admission/executor and answer
        // publication below are real and use embedded Postgres.
        attempt: async () => ({ kind: "failed", operation: { stderrExcerpt: "plugin_workspace_inspection_failed" } }),
        onWorkspaceSettled: async input => {
          await heartbeat.releaseEnvironmentLeasesForRun({ ...input, status: "failed" });
          await heartbeat.releaseIssueExecutionAndPromote({ id: input.runId, companyId: input.companyId }, { resumeStrandedQueue: true });
        },
      });
      await recordNativeWorkspaceFinalizationFailure(db, f.runId, { stderrExcerpt: "workspace_sync_out_failed" });
      const overdue = mode.startsWith("overdue");
      if (overdue) {
        await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() - 11 * 60_000) })
          .where(eq(nativeRunFinalizations.runId, f.runId));
        // Reconstruct the same worker after a controller restart, or use the
        // existing live worker. The deadline is exclusively durable DB state.
        if (mode === "overdue-restart") await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId], { skipDelegatedWork: true });
        const resumed = worker();
        const [entry] = await resumed.load({ companyId: f.companyId, runId: f.runId });
        if (entry) await resumed.check(entry);
        await heartbeat.releaseEnvironmentLeasesForRun({ runId: f.runId, companyId: f.companyId, agentId: f.agentId, status: "failed" });
        await heartbeat.releaseIssueExecutionAndPromote({ id: f.runId, companyId: f.companyId }, { resumeStrandedQueue: true });
      } else for (let retry = 0; retry < 2; retry++) {
        await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() - 1) })
          .where(eq(nativeRunFinalizations.runId, f.runId));
        const resumed = worker();
        const [entry] = await resumed.load({ companyId: f.companyId, runId: f.runId });
        expect(entry).toBeDefined(); await resumed.check(entry);
      }
      const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(ended).toMatchObject({ status: "failed", finishedAt: expect.any(Date), errorCode: "native_workspace_sync_out_retry_exhausted" });
      await vi.waitFor(async () => { await f.assertAnsweredOnce([message]); }, { timeout: 30_000 });
      await heartbeat.drainActiveRunExecutions();
      const successors = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.runId);
      expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot?.wakeCommentIds).toContain(message.id);
      expect(successors[0].status).toBe("succeeded");
      // Replaying both failure recording and release cannot mint another run.
      await recordNativeWorkspaceFinalizationFailure(db, f.runId, { stderrExcerpt: "workspace_sync_out_failed" });
      await heartbeat.releaseIssueExecutionAndPromote(ended, { resumeStrandedQueue: true });
      await heartbeat.drainActiveRunExecutions(); await f.assertAnsweredOnce([message]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.runId)).toHaveLength(1);
      console.info("FAILEDRUN route proof", JSON.stringify({ mode, source: f.runId, successor: successors[0].id,
        status: successors[0].status, messageId: message.id, comments: await f.comments() }));
    } finally { release?.(); await owned; await f.close(); }
  }, 60_000);

  it.each(["observed", "applied"] as const)("P2: normal end with %s finalization; standalone commit answers deferred person batch ONCE", async phase => {
    const f = await fixture(`P2-normal-${phase}`, true, false);
    try {
      const messages = [await f.post("P2-M1: answer my first last-second question", "queue"),
        await f.post("P2-M2: answer my second last-second question", "queue")];
      await waitForPendingCommentSteers();
      const deferred = (await f.wakes()).filter(w => w.status === "deferred_issue_execution");
      expect(deferred).toHaveLength(1);
      expect(JSON.stringify(deferred[0].payload)).toContain(messages[0].id);
      expect(JSON.stringify(deferred[0].payload)).toContain(messages[1].id);
      expect(f.commands("steer")).toEqual([]);
      f.owner.deferCommitAtReturn = true;
      f.owner.deferredPhase = phase;
      await f.complete();
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe(phase);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("succeeded");
      expect((await f.wakes()).find(w => w.id === deferred[0].id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      // P2-live: another cleanup already cleared ownership, so there is NO
      // issue_execution_lock record left for the registry to settle/drain.
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null,
        executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
      const started = Date.now();
      // No registry settlement, recovery sweep, delivery worker, or new input:
      // this finalizer is the ONLY owner of the post-commit continuation.
      await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("committed");
      await vi.waitFor(async () => { await f.assertAnsweredOnce(messages); }, { timeout: 30_000 });
      await heartbeatService(db).drainActiveRunExecutions();
      const elapsedMs = Date.now() - started;
      expect(elapsedMs).toBeLessThan(30_000);
      const successors = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))
        .then(rows => rows.filter(run => run.id !== f.runId));
      expect(await successors()).toHaveLength(1);
      for (const message of messages) expect((await successors())[0].contextSnapshot?.wakeCommentIds).toContain(message.id);
      // Replayed commit AND the settlement's own drain must remain idempotent.
      await Promise.all([finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true }), settleOwner(f)]);
      await settleOwner(f);
      await heartbeatService(db).drainActiveRunExecutions();
      await f.assertAnsweredOnce(messages);
      expect(await successors()).toHaveLength(1);
      const proof = { phase, elapsedMs, originalRun: f.runId, issueLockBeforeCommit: null,
        messageIds: messages.map(m => m.id), successorRuns: (await successors()).map(r => r.id),
        wakes: await f.wakes(), comments: await f.comments() };
      console.info("P2 persisted proof", JSON.stringify(proof));
      if (process.env.PAPERCLIP_STEER_RED_EVIDENCE) await writeFile(
        join(process.env.PAPERCLIP_STEER_RED_EVIDENCE, `P2-proof-${phase}.json`), JSON.stringify(proof, null, 2));
    } finally { await f.close(); }
  }, 60_000);

  it("P2-wired: the finalizer's post-commit drain promotes on the registered process heartbeat, not a bare one", async () => {
    const f = await fixture("P2-wired", true, false);
    const realHeartbeatService = heartbeatModule.heartbeatService;
    // The process heartbeat (index.ts registers the one built WITH the plugin
    // worker manager). Mark it so the drain's instance is observable.
    const processDrains: string[] = [];
    const processHeartbeat = realHeartbeatService(db);
    registerProcessHeartbeat(db, { ...processHeartbeat,
      releaseIssueExecutionAndPromote: async (...args: Parameters<typeof processHeartbeat.releaseIssueExecutionAndPromote>) => {
        processDrains.push(args[0].id);
        return processHeartbeat.releaseIssueExecutionAndPromote(...args);
      } });
    const bareDrains: string[] = [];
    const spy = vi.spyOn(heartbeatModule, "heartbeatService").mockImplementation((...args) => {
      const service = realHeartbeatService(...args);
      return { ...service, releaseIssueExecutionAndPromote: async (...releaseArgs: Parameters<typeof service.releaseIssueExecutionAndPromote>) => {
        bareDrains.push(releaseArgs[0].id);
        return service.releaseIssueExecutionAndPromote(...releaseArgs);
      } };
    });
    try {
      const message = await f.post("P2-WIRED: answer on the wired heartbeat", "queue");
      await waitForPendingCommentSteers();
      f.owner.deferCommitAtReturn = true;
      await f.complete();
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null,
        executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
      await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      await vi.waitFor(async () => { await f.assertAnsweredOnce([message]); }, { timeout: 30_000 });
      await realHeartbeatService(db).drainActiveRunExecutions();
      console.info("P2-wired proof", JSON.stringify({ runId: f.runId, processDrains, bareFinalizerDrains: bareDrains.filter(id => id === f.runId) }));
      expect(processDrains).toContain(f.runId);
      expect(bareDrains).not.toContain(f.runId);
    } finally { spy.mockRestore(); clearProcessHeartbeat(db); await f.close(); }
  }, 60_000);

  it("P2-double: registry settlement drains before the committed finalizer's drain; ONE successor", async () => {
    const f = await fixture("P2-double", true, false);
    let resume!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const atDrain = new Promise<void>(resolve => { reached = resolve; });
    let finalizing: Promise<unknown> | undefined;
    let restoreSpy = () => {};
    const realHeartbeatService = heartbeatModule.heartbeatService;
    try {
      const message = await f.post("P2-DOUBLE: one answer despite both drains", "queue");
      await waitForPendingCommentSteers();
      f.owner.deferCommitAtReturn = true;
      await f.complete();
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      // Gate ONLY scheduling order, not a release result. The registry's sweep
      // and both release transactions below are the real product code.
      let finalizerDrainCalls = 0;
      const spy = vi.spyOn(heartbeatModule, "heartbeatService").mockImplementation((...args) => {
        const service = realHeartbeatService(...args);
        return { ...service, releaseIssueExecutionAndPromote: async (...releaseArgs: Parameters<typeof service.releaseIssueExecutionAndPromote>) => {
          if (releaseArgs[0].id === f.runId) { finalizerDrainCalls++; reached(); await gate; }
          return service.releaseIssueExecutionAndPromote(...releaseArgs);
        } };
      });
      restoreSpy = () => spy.mockRestore();
      finalizing = finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      await vi.waitFor(() => expect(finalizerDrainCalls).toBe(1), { timeout: 5000 });
      await atDrain;
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(f.runId);
      await settleOwner(f); // wins the guarded clear AND invokes its wired drain
      await vi.waitFor(async () => { await f.assertAnsweredOnce([message]); }, { timeout: 30_000 });
      resume(); await finalizing;
      await heartbeatService(db).drainActiveRunExecutions();
      await f.assertAnsweredOnce([message]);
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter(r => r.id !== f.runId);
      expect(runs).toHaveLength(1);
      const proof = { finalizerDrainCalls, registrySettledFirst: true, successorRuns: runs.map(r => r.id) };
      console.info("P2 double persisted proof", JSON.stringify(proof));
      if (process.env.PAPERCLIP_STEER_RED_EVIDENCE) await writeFile(
        join(process.env.PAPERCLIP_STEER_RED_EVIDENCE, "P2-proof-double.json"), JSON.stringify(proof, null, 2));
    } finally { resume(); await finalizing; restoreSpy(); await f.close(); }
  }, 60_000);

  it.each(["completion", "system"] as const)("P2 pre-boot %s wake: standalone commit does NOT promote historical work", async kind => {
    const f = await fixture(`P2-preboot-${kind}`, true, false);
    try {
      const task = kind === "completion" ? await completionTask(f, "P2 old completed daily task") : null;
      const wake = task ? (await held(f, task)).wake : (await db.insert(agentWakeupRequests).values({
        companyId: f.companyId, agentId: f.agentId, source: "automation", triggerDetail: "system",
        reason: "automation_no_new_person", requestedByActorType: "system", status: "deferred_issue_execution",
        payload: { issueId: f.issueId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "automation_no_new_person" } },
      }).returning())[0];
      await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 3 * 60 * 60_000) })
        .where(eq(agentWakeupRequests.id, wake.id));
      f.owner.deferCommitAtReturn = true;
      await f.complete();
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null,
        executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
      for (let pass = 0; pass < 2; pass++) {
        await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
        await settleOwner(f);
      }
      await heartbeatService(db).drainActiveRunExecutions();
      expect(f.owner.peers).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .toHaveLength(task ? 2 : 1); // completion producer's worker is not a chat successor
      expect((await f.wakes()).find(w => w.id === wake.id)).toMatchObject({
        status: task ? "cancelled" : "deferred_issue_execution", runId: null });
      const notes = (await f.comments()).filter(c => c.authorType === "system");
      if (task) expect(notes.filter(c => c.body.includes(task.identifier))).toHaveLength(1);
      else expect(notes).toEqual([]);
    } finally { await f.close(); }
  }, 60_000);

  it("normal-end control: the existing native end drain still reports a mid-reply completion once", async () => {
    const f = await fixture("rf3-normal-end", true, false);
    try {
      const task = await completionTask(f, "Normal native owner end already worked");
      await held(f, task);
      await f.complete();
      await assertReported(f, task);
      expect((await completionWakes(f)).filter(wake => wake.runId)).toHaveLength(1);
    } finally { await f.close(); }
  }, 60_000);

  it.each([1, 5])("11a / no-live-run: %s real mid-reply completions wait for the native reply, then report in ONE run", async count => {
    const f = await fixture(`rf3-11a-${count}`, true, false);
    try {
      const tasks = [];
      for (let index = 0; index < count; index++) tasks.push(await completionTask(f, `A short task ${index} finished during Paul's reply`));
      await f.startDelivery(true);
      const { wake } = await held(f, tasks[0]);
      for (const task of tasks.slice(1)) await task.finish();
      await f.passDelivery();
      await settleOwner(f);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((await completionWakes(f))[0]).toMatchObject({ id: wake.id, status: "deferred_issue_execution", runId: null });
      expect(f.owner.peers).toHaveLength(1);
      const settledAt = Date.now();
      await finishAcrossAdmissionWindow(f);
      await settleOwner(f);
      for (const task of tasks) await assertReported(f, task);
      const delivered = await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.companyId, f.companyId));
      expect(new Set(delivered.map(row => row.targetRunId)).size).toBe(1);
      console.info("11a completion latency", JSON.stringify({ count, elapsedMs: Date.now() - settledAt }));
      await f.passDelivery();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((await completionWakes(f)).filter(wake => wake.runId)).toHaveLength(1);
    } finally { await f.close(); }
  }, 60_000);

  it.each([false, true])("11c: finalizer lease/reconciliation path preBoot=%s retires or reports after commit", async preBoot => {
    const f = await fixture(`rf3-11c-${preBoot}`, true, false);
    try {
      const task = await completionTask(f, "A completion waiting for native reconciliation");
      const { wake } = await held(f, task);
      if (preBoot) await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 3 * 60 * 60_000) })
        .where(eq(agentWakeupRequests.id, wake.id));
      await f.startDelivery(true);
      f.owner.deferCommitAtReturn = true;
      await f.complete();
      const [pending] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(pending).toMatchObject({ phase: "observed", leaseOwner: "native-row-reconciler" });
      expect((await completionWakes(f))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      // A reconciler between leases still owns the persisted result. The real
      // registry must not clear its handoff and strand the queue before commit.
      await settleOwner(f);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(f.runId);
      expect((await completionWakes(f))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await reconcileNativeFinalizations(db, [f.runId], {
        onWorkspaceSettled: input => heartbeatService(db).releaseEnvironmentLeasesForRun({
          runId: input.runId, companyId: input.companyId, agentId: input.agentId, status: "succeeded" }),
      });
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("committed");
      await settleOwner(f);
      if (preBoot) await vi.waitFor(async () => {
        expect((await completionWakes(f))[0]).toMatchObject({ status: "cancelled", runId: null });
        expect((await f.comments()).filter(row => row.authorType === "system" && row.body.includes(task.identifier))).toHaveLength(1);
      }, { timeout: 15_000 });
      else await assertReported(f, task);
      expect(f.owner.peers).toHaveLength(preBoot ? 1 : 2);
    } finally { await f.close(); }
  }, 60_000);

  it.each([
    { stale: false, orphaned: false }, { stale: true, orphaned: false },
    { stale: false, orphaned: true }, { stale: true, orphaned: true },
  ])("boot: old e39 stale=$stale orphaned=$orphaned is safe over two passes", async ({ stale, orphaned }) => {
    const f = await fixture(`rf3-boot-${stale}-${orphaned}`, true, false);
    try {
      const task = await completionTask(f, "Old finished task for the boot row");
      if (stale) await answerNewer(f, "A newer question that has since been answered");
      const { wake, delivery } = await held(f, task);
      await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 3 * 60 * 60_000) })
        .where(eq(agentWakeupRequests.id, wake.id));
      await finishAcrossAdmissionWindow(f);
      if (orphaned) {
        // Reproduce a wake ALREADY stranded by the pre-fix bare settlement
        // entry. Future wiring cannot recover a lock an older server cleared.
        await recoveryService(db, { enqueueWakeup: async () => null })
          .sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
        expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
        expect((await completionWakes(f))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
      }
      // Reconstruct through the real registry settlement, not a test-only
      // heartbeat recovery factory with extra release dependencies.
      await f.startDelivery(true);
      await settleOwner(f);
      {
        await vi.waitFor(async () => {
          expect((await completionWakes(f))[0]).toMatchObject({ id: wake.id, status: "cancelled", runId: null });
          expect((await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.id, delivery.id)))[0].status)
            .toBe("superseded");
          const notes = (await f.comments()).filter(comment => comment.authorType === "system" && comment.body.includes(task.identifier));
          expect(notes).toHaveLength(1); expect(notes[0].body).toContain("Finished earlier");
        }, { timeout: 15_000 });
      }
      await f.stopDelivery(); await f.startDelivery(true); await settleOwner(f); await f.passDelivery();
      await new Promise(resolve => setTimeout(resolve, 200));
      expect((await f.comments()).filter(comment => comment.authorType === "system" && comment.body.includes(task.identifier)))
        .toHaveLength(1);
      expect(f.owner.peers).toHaveLength(1);
    } finally { await f.close(); }
  }, 60_000);

  it.each([false, true])("11b: an old e39 head preBoot=%s becomes ONE naming note, then the new report delivers", async preBoot => {
    const f = await fixture(`rf3-11b-${preBoot}`, true, false);
    try {
      const oldTask = await completionTask(f, "Old finished task whose report was delayed");
      const newTask = await completionTask(f, "New finished task that must still be reported");
      await answerNewer(f, "We have since moved on to a different question");
      const { wake } = await held(f, oldTask);
      const initialComment = (await f.comments()).find(comment => comment.id === f.initial)!;
      // Distinguish post-boot newer-answered-person staleness from the pre-boot
      // gate: either historical head must retire without a late agent turn.
      await db.update(agentWakeupRequests).set({ requestedAt: preBoot
        ? new Date(Date.now() - 3 * 60 * 60_000) : new Date(initialComment.createdAt.getTime() + 1) })
        .where(eq(agentWakeupRequests.id, wake.id));
      await finishAcrossAdmissionWindow(f);
      const newDelivery = await newTask.finish();
      await chatCompletionDeliveryService(db, heartbeatService(db)).deliver(newDelivery.id);
      expect((await completionWakes(f)).filter(wake => wake.runId)).toHaveLength(0);
      await f.startDelivery(true);
      await settleOwner(f);
      await assertReported(f, newTask);
      const notes = (await f.comments()).filter(comment => comment.authorType === "system" && comment.body.includes(oldTask.identifier));
      expect(notes).toHaveLength(1); expect(notes[0].body).toContain("Finished earlier");
      expect((await completionWakes(f)).find(row => row.id === wake.id)).toMatchObject({ status: "cancelled", runId: null });
      const replies = (await f.comments()).filter(comment => comment.authorType === "agent" && comment.body.includes(`ANSWER:${oldTask.identifier}`));
      expect(replies).toHaveLength(0);
      await f.passDelivery(); await new Promise(resolve => setTimeout(resolve, 100));
      expect(f.owner.peers).toHaveLength(2);
    } finally { await f.close(); }
  }, 60_000);
});

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21272
// B3's explicitly commissioned native integration rows; controlled Pi peer,
// real attachment, scheduler, comment POST, drivers and durable event ingestion.
describe("person comment default steering eligibility and asynchronous receipt", () => {
  // The finished native consumer, not elapsed time or another Send, owns this
  // closure proof. Three in-turn reads/answers must survive the release drain.
  it.each([
    { label: "fresh", retained: false, concurrent: false },
    { label: "retained", retained: true, concurrent: false },
    { label: "concurrent", retained: true, concurrent: true },
    { label: "previous-boot", retained: true, concurrent: false },
    { label: "live-boot", retained: true, concurrent: false },
    { label: "unknown-boot", retained: true, concurrent: false },
  ])("INGEST: successful three-steer turn releases its last-second deferred person exactly once ($label)", async ({ label, retained, concurrent }) => {
    let port: PaperclipControlPlanePort | undefined;
    const append = PaperclipControlPlanePort.prototype.appendEvent;
    const observe = vi.spyOn(PaperclipControlPlanePort.prototype, "appendEvent").mockImplementation(function (this: PaperclipControlPlanePort, ...args) {
      port ??= this;
      return append.apply(this, args);
    });
    const restart = ["previous-boot", "live-boot", "unknown-boot"].includes(label);
    // Recreate exactly the old successful return: no joined-consumer callback.
    // All stream, run, lock and wake rows are still written by production code.
    const oldSuccess = restart ? vi.spyOn(PaperclipControlPlanePort.prototype, "settleEventIngestion").mockResolvedValueOnce(undefined) : undefined;
    const f = await fixture(`ingest-success-${label}`, true, false, retained).catch(error => {
      oldSuccess?.mockRestore(); observe.mockRestore(); throw error;
    });
    try {
      const steered = [];
      for (let n = 1; n <= 3; n++) steered.push(await f.post(`INGEST-STEER-${n}`));
      await waitForPendingCommentSteers();
      expect(f.commands("steer")).toHaveLength(3);
      f.peer.boundary();
      await vi.waitFor(async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        expect(run.contextSnapshot?.answeredSteeredCommentIds).toEqual(steered.map(m => m.id));
      }, { timeout: 15_000 });
      const before = (await f.comments()).filter(c => steered.some(m => m.id === c.id));
      expect(before.every(c => c.steerDeliveredAt !== null)).toBe(true);
      const [beforeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const acks = beforeRun.resultJson?.queuedSteeringAcknowledgements as Record<string, { status: string }>;
      for (const message of steered) expect(acks[message.id].status).toBe("acknowledged");
      const last = await f.post("INGEST-LAST-SECOND", "queue");
      expect((await f.wakes()).filter(w => w.status === "deferred_issue_execution")).toHaveLength(1);
      await f.complete();
      oldSuccess?.mockRestore();
      if (restart) {
        const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        expect(held.resultJson?.steeringIngestionReleaseHeld).toBe(true);
        expect(held.resultJson?.nativeSteeringIngestion).toMatchObject({ state: "open", highestContiguousSourceSeq: 0 });
        if (label !== "live-boot") {
          const prior = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
          expect(prior.status).toBe(0);
          await db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), controllerPid: prior.pid,
            controllerHostHash: label === "unknown-boot" ? "another-pid-space" : currentProcessSpaceHash(),
            controllerProcessStartedAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
        }
        await heartbeatService(db).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
        if (label !== "previous-boot") {
          const [stillHeld] = await db.select().from(issues).where(eq(issues.id, f.issueId));
          expect(stillHeld.executionRunId, "a live or unprovable consumer cannot be bypassed").toBe(f.runId);
          expect(f.owner.peers).toHaveLength(1);
          // End this negative row through the true joined consumer, not age.
          await port!.settleEventIngestion();
        }
        await heartbeatService(db).drainActiveRunExecutions();
      }
      if (concurrent) {
        // The actual ingestion owner receives concurrent stopped/joined
        // notifications. At base this explicitly resumes the held release;
        // after the fix these duplicate the success callback. Neither may
        // create another successor or restore any answered steering input.
        expect(port).toBeDefined();
        await Promise.all(Array.from({ length: 8 }, () => port!.settleEventIngestion()));
        await heartbeatService(db).drainActiveRunExecutions();
      }
      const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      console.info("INGEST finished row", JSON.stringify({ runId: f.runId, status: ended.status,
        ingestion: ended.resultJson?.nativeSteeringIngestion, held: ended.resultJson?.steeringIngestionReleaseHeld,
        executionRunId: issue.executionRunId, checkoutRunId: issue.checkoutRunId,
        steeredCommentIds: ended.contextSnapshot?.steeredCommentIds, wakes: await f.wakes() }));
      expect(ended.status).toBe("succeeded");
      const ingestion = ended.resultJson?.nativeSteeringIngestion as Record<string, unknown>;
      expect(ingestion.terminalSourceSeq).toEqual(expect.any(Number));
      expect(ingestion.highestContiguousSourceSeq).toBe(retained ? 0 : ingestion.terminalSourceSeq);
      expect(issue.executionRunId, "finished successful run must not retain issue custody").not.toBe(f.runId);
      expect(issue.checkoutRunId).not.toBe(f.runId);
      await vi.waitFor(async () => { await f.assertAnsweredOnce([...steered, last]); }, { timeout: 15_000 });
      expect(ended.resultJson?.queuedSteeringAcknowledgements).toEqual(acks);
      expect(ended.contextSnapshot?.answeredSteeredCommentIds).toEqual(steered.map(m => m.id));
      expect(ended.contextSnapshot?.steeredDeliveredAts).toEqual(beforeRun.contextSnapshot?.steeredDeliveredAts);
      expect(f.owner.peers).toHaveLength(2);
      const prompts = f.owner.peers.slice(1).flatMap(p => p.requests.filter(r => r.type === "prompt"));
      expect(prompts).toHaveLength(1);
      expect(String(prompts[0].input?.message)).toContain(last.body);
      for (const message of steered) {
        expect(f.peer.replies.filter(reply => reply === `ANSWER:${message.body}`)).toHaveLength(1);
        expect(String(prompts[0].input?.message)).not.toContain(message.body);
      }
      const after = (await f.comments()).filter(c => steered.some(m => m.id === c.id));
      expect(after.map(c => [c.id, c.steerDeliveredAt])).toEqual(before.map(c => [c.id, c.steerDeliveredAt]));
    } finally { oldSuccess?.mockRestore(); observe.mockRestore(); await f.close(); }
  }, 60_000);
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
  it.runIf(process.env.B6_REAL_PI === "1")("B6P2 STARTING plus Stop drains within 15 seconds and Stop holds unread input", async () => {
    const f = await fixture("B6P2-starting-stop", true, ["B6P2-UNREAD"], false, true);
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.status).toBe("cancelled");
      expect(f.stopElapsedMs).toBeLessThan(15_000);
      expect(f.commands("prompt")).toEqual([]);
      expect(await readPersonStopHold(db, { companyId: f.companyId, issueId: f.issueId,
        agentId: f.agentId, messageId: f.early[0].id })).toMatchObject({ stoppedRunId: f.runId });
      const queued = await f.queue();
      expect(queued.executionWait).toMatchObject({ reason: "stopped_by_person" });
      expect(queued.entries.map((entry: any) => entry.comment.id)).toContain(f.early[0].id);
      expect(f.owner.peers).toHaveLength(1);
      expect(f.peer.consumed).toEqual([]);
    } finally { await f.close(); }
  }, 45_000);

  it("B6 STARTING M1 then rapid M2/M3 all enter the same run in order, no extra run", async () => {
    const f = await fixture("B6-starting", true, ["B6-M1"]);
    try {
      const messages = [...f.early, await f.post("B6-M2"), await f.post("B6-M3")];
      await vi.waitFor(() => expect(f.commands("steer").map(c => c.input?.message)).toEqual(messages.map(m => m.body)), { timeout: 5000 });
      // Transfer the original fallback wake in the SAME prepare transaction,
      // before provider read/answer or run-end cleanup can hide a missed consume.
      for (const early of f.early) expect((await f.wakes()).find(wake => JSON.stringify(wake.payload).includes(early.id)))
        .toMatchObject({ status: "completed", runId: f.runId });
      await waitForPendingCommentSteers(); await f.peer.boundary();
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
      await waitForPendingCommentSteers(); await f.peer.boundary();
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
      await f.peer.boundary(); await f.assertSteeredOnce([first, second]); await f.complete();
    } finally { unavailable.mockRestore(); await f.close(); }
  }, 45_000);

  it("B6 finishing input takes one ordinary next run, never a late steer", async () => {
    const f = await fixture("B6-finishing");
    const release = f.peer.holdClose();
    try {
      f.peer.finish();
      // Join the held teardown boundary, not a 1s race against provider/event ingestion.
      // No late POST is allowed until this run has actually entered finishing.
      await release.entered;
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
      await f.peer.boundary(); await f.assertSteeredOnce([message]); await f.complete();
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
        await f.peer.boundary(); await f.assertSteeredOnce([message]); await f.complete();
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
      await f.peer.boundary(); await f.assertSteeredOnce([message]); await f.complete();
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
      await f.peer.boundary();
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
        await f.peer.boundary();
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
      await f.peer.boundary();
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
      await f.peer.boundary();
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
      await f.peer.boundary();
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
