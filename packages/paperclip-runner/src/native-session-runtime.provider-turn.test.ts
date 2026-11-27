import { describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeExecutionInputV1, NativeExecutionInputV5 } from "./contracts/native-execution.js";
import { createRunnerdNativeSessionBackend } from "./backends/codex-native-backend.js";
import { collectUntilTerminal, FakeCodexTransport, WORKSPACE } from "./drivers/codex/codex-app-server-driver.test-support.js";
import { canonicalNativeRuntimeContextDigest, NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION, nativeRuntimePromptDigest } from "./contracts/runtime-context.js";
import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeSession, PersistedNativeSession } from "./contracts/native-session-backend.js";
import { executeNativeSession } from "./native-session-runtime.js";
import { providerTurnWaitDeadline, PROVIDER_TURN_WAIT_TIMEOUT_MARGIN_MS, type ProviderTurnWaitOptions } from "./native-provider-turn-wait.js";
import type { PrpEvent, PrpStructuredRunResult } from "./protocol/replay-contract.js";

const identity = {
  runId: "run-provider-turn",
  sessionId: "session-provider-turn",
  companyId: "company-provider-turn",
  issueId: "issue-provider-turn",
  agentId: "agent-provider-turn",
};

const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: { companyId: identity.companyId, runId: identity.runId, issueId: identity.issueId, agentId: identity.agentId,
    executionWorkspaceId: "workspace-provider-turn" },
  task: { identifier: "PAP-PROVIDER", title: "Wait for a background install", description: null,
    prompt: "# PAP-PROVIDER: Wait for a background install", workMode: "standard" },
  workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
  provider: { kind: "codex", model: null },
  completionContract: { id: "contract-provider-turn", sha256: "contract-provider-turn-sha", schemaVersion: "paperclip.completion-contract.v1",
    contract: { revision: "1", objective: "Install and test", criteria: [{ id: "objective", requirement: "Install and test" }] } },
  interactionResponses: [],
  credentialBindings: [],
};

const heldInput: NativeExecutionInputV1 = {
  ...input,
  session: { ...input.session, driverKind: "pi_rpc" },
  provider: { kind: "pi_rpc", model: "test/pi", conversationMode: true },
};

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Installed and tested after the background install finished.",
  completionClaim: { contractRevision: "1", objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
  evidence: [],
  verification: [{ commandOrCheck: "pnpm test", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const planReviewWait: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "yielded",
  summary: "Waiting for the plan review.",
  completionClaim: { contractRevision: "1", objectiveSatisfied: false,
    criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: ["interaction:plan"] }],
    remainingWork: [{ description: "Resume after the plan review.", blocksCompletion: true }] },
  evidence: [{ ref: "interaction:plan" }],
  verification: [],
  attentionRequests: [],
  artifacts: [{ kind: "issue_thread_interaction", ref: "interaction:plan" }],
  continuation: { kind: "response_wake", summary: "Resume from the plan review.", idempotencyKey: "interaction-response:plan" },
};

let sequence = 0;
const event = (turnId: string, eventType: PrpEvent["eventType"], payload: Record<string, unknown> = {}): PrpEvent => {
  sequence += 1;
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `runner-provider-turn:${identity.runId}:${sequence}`,
    sourceSeq: sequence,
    sourceInstanceId: "runner-provider-turn",
    sourceKind: "runner",
    runId: identity.runId,
    normalizedSessionId: identity.sessionId,
    turnId,
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: "2026-11-12T00:00:00.000Z",
    payload,
  };
};

const usage = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 6, outputTokens: 4 } } };
const turnOne = (awaiting: boolean) => [
  event("turn-1", "turn.started", { status: "inProgress" }),
  event("turn-1", "item.completed", usage),
  event("turn-1", "turn.completed", { status: "completed", error: null, ...(awaiting ? { awaitingProviderTurn: true } : {}) }),
];
const providerTurn = (turnId: string, options: { result?: boolean; awaiting?: boolean } = {}) => [
  event(turnId, "turn.started", { status: "inProgress", origin: "provider" }),
  event(turnId, "item.completed", usage),
  ...(options.result ? [event(turnId, "run.result.proposed", result as unknown as Record<string, unknown>)] : []),
  event(turnId, "turn.completed", { status: "completed", error: null, ...(options.awaiting ? { awaitingProviderTurn: true } : {}) }),
];

const restartFailure = { code: "provider_turn_lost_on_restore", recoverable: true };
const lostTerminal = { turnId: "turn-recovery", fingerprint: JSON.stringify({ terminalState: "failed", error: restartFailure, result: null }) };
const completedTerminal = (turnId: string) => ({ turnId, fingerprint: JSON.stringify({ terminalState: "completed", error: null, result: null }) });
const restartCheckpoint: PersistedNativeSession = {
  backendKind: "mock", driverKind: "codex_app_server", sessionId: identity.sessionId, identity,
  providerSessionId: "provider-session", cursor: "0", activeTurnId: null,
  terminalTurns: [lostTerminal], semanticResult: null, pendingRuntimeRequests: [], lineage: [],
};

interface RestartContinuation {
  output?: PrpEvent;
  onDisposition?: (push: (...values: Array<PrpEvent | "end">) => void) => void;
  recovery?: { checkpoint: PersistedNativeSession; snapshot: Partial<PersistedNativeSession>; replay?: PrpEvent[] };
}

function harness(options: { withoutInterrupt?: boolean; restart?: RestartContinuation } = {}) {
  const queue: Array<PrpEvent | "end"> = [];
  let wake: (() => void) | null = null;
  let activeProviderTurn: string | null = null;
  const observed = { activeTurnId: null as string | null, awaiting: false };
  const snapshotSequences: Array<number | undefined> = [];
  const push = (...values: Array<PrpEvent | "end">) => {
    for (const value of values) {
      if (value !== "end" && value.eventType === "turn.started") activeProviderTurn = value.turnId ?? null;
      if (value !== "end" && value.eventType.startsWith("turn.") && value.eventType !== "turn.started") activeProviderTurn = null;
      queue.push(value);
    }
    wake?.();
  };
  const interrupt = vi.fn(async (_input: { turnId?: string; reason?: string }) => {
    if (activeProviderTurn) push(event(activeProviderTurn, "turn.cancelled", { status: "cancelled", error: null }));
    else push(event("turn-1", "item.completed", { kind: "interrupt_acknowledgement", status: "provider_turn_wait_ended" }));
  });
  const capabilities = { resume: options.restart !== undefined, typedEvents: true, steering: false, interruption: true, structuredResult: true };
  const startTurn = vi.fn(async (_input: Parameters<NativeSession["startTurn"]>[0]) => {
    if (!options.restart) return { turnId: "turn-1" };
    if (options.restart.recovery) return { turnId: "turn-fresh" };
    if (startTurn.mock.calls.length === 1) {
      push(event("turn-continuation", "turn.started", { status: "inProgress" }),
        ...(options.restart.output ? [options.restart.output] : []), event("turn-continuation", "item.completed", usage),
        event("turn-continuation", "turn.completed", { status: "completed", error: null, awaitingProviderTurn: true }));
      return { turnId: "turn-continuation", borrowedDispositionMarker: true as const };
    }
    options.restart.onDisposition?.(push);
    return { turnId: "turn-disposition" };
  });
  const session: NativeSession = {
    identity: () => identity,
    async capabilities() { return capabilities; },
    async *events() {
      for (;;) {
        const next = queue.shift();
        if (next === "end") return;
        if (next) {
          if (next.eventType === "turn.started") Object.assign(observed, { activeTurnId: next.turnId ?? null, awaiting: false });
          else if (next.eventType.startsWith("turn.")) Object.assign(observed, { activeTurnId: null, awaiting: next.payload.awaitingProviderTurn === true });
          yield structuredClone(next);
          continue;
        }
        await new Promise<void>(resolve => { wake = resolve; });
        wake = null;
      }
    },
    startTurn,
    ...(options.withoutInterrupt ? {} : { interrupt }),
    async result() { return null; },
    async snapshot(snapshotOptions?: { sourceSeq?: number }) {
      snapshotSequences.push(snapshotOptions?.sourceSeq);
      const base: PersistedNativeSession = { backendKind: "mock", sessionId: identity.sessionId, identity,
        providerSessionId: "provider-session", cursor: String(sequence), activeTurnId: null, pendingRuntimeRequests: [], lineage: [] };
      if (!options.restart) return { ...base, activeTurnId: observed.activeTurnId, ...(observed.awaiting ? { awaitingProviderTurn: true } : {}) };
      if (options.restart.recovery) return { ...base, ...options.restart.recovery.snapshot };
      const starts = startTurn.mock.calls.length;
      return { ...base, semanticResult: null,
        terminalTurns: [lostTerminal, ...(starts >= 1 ? [completedTerminal("turn-continuation")] : []),
          ...(starts >= 2 ? [completedTerminal("turn-disposition")] : [])],
        ...(starts >= 1 ? { dispositionOnlyRecoveryConsumed: starts >= 2, dispositionOnlyRecoveryTurnId: starts >= 2 ? "turn-disposition" : null } : {}) };
    },
    async close() { push("end"); },
  };
  return { session, push, interrupt, startTurn, snapshotSequences };
}

async function run(options: {
  stream: PrpEvent[];
  executionInput?: NativeExecutionInputV1;
  after?: (control: ReturnType<typeof harness>, appended: PrpEvent[]) => Promise<void> | void;
  providerTurnWait?: ProviderTurnWaitOptions;
  turnTimeoutMs?: number;
  missingResult?: (input: { turnId: string | null; terminalEvent: PrpEvent }) => PrpStructuredRunResult | null;
  withoutInterrupt?: boolean;
  pipelinesDeltas?: boolean;
  restart?: RestartContinuation;
}) {
  const control = harness({ withoutInterrupt: options.withoutInterrupt, restart: options.restart });
  const appended: PrpEvent[] = [];
  const checkpoints: PersistedNativeSession[] = [];
  const checkpointedAfter: number[] = [];
  let queued: Array<() => void> = [];
  const flushStreamingEvents = vi.fn(() => {
    const flushed = queued;
    queued = [];
    for (const commit of flushed) commit();
  });
  let returned: Awaited<ReturnType<typeof executeNativeSession>> | null = null;
  const completeRun = vi.fn(async () => undefined);
  const resolveMissingResult = vi.fn(async (value: { turnId: string | null; terminalEvent: PrpEvent }) => options.missingResult?.(value) ?? null);
  control.push(...options.stream);
  const capabilities = { resume: options.restart !== undefined, typedEvents: true, steering: false, interruption: true, structuredResult: true };
  const started = Date.now();
  const execution = executeNativeSession({
    input: options.executionInput ?? input,
    backend: { async descriptor() { return { kind: "mock", name: "provider-turn", version: "1", capabilities }; },
      async openSession() { return control.session; },
      ...(options.restart ? { async recoverSession() { return { recovered: true, session: control.session }; } } : {}) },
    controlPlane: {
      ...(options.pipelinesDeltas ? { pipelinesStreamingEvents: true, flushStreamingEvents } : {}),
      async openRun() {}, async checkpointSession(value: PersistedNativeSession) { checkpoints.push(structuredClone(value)); checkpointedAfter.push(appended.length); },
      async appendEvent(value: PrpEvent) {
        appended.push(structuredClone(value));
        if (options.pipelinesDeltas && value.eventType === "item.delta") await new Promise<void>(resolve => queued.push(resolve));
        return { cursor: value.sourceSeq, highestContiguousSourceSeq: value.sourceSeq, disposition: "committed" };
      },
      async replayEvents(request: { sourceInstanceId: string; afterSourceSeq: number }) {
        const events = (options.restart?.recovery?.replay ?? [])
          .filter(value => value.sourceInstanceId === request.sourceInstanceId && value.sourceSeq > request.afterSourceSeq);
        return { events, highestContiguousSourceSeq: Math.max(0, ...events.map(value => value.sourceSeq)) };
      },
      completeRun,
    },
    runnerInstanceId: "runner-provider-turn", controlPlaneInstanceId: "control-provider-turn", timeoutMs: 30_000,
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    resolveMissingResult,
    providerTurnWait: options.providerTurnWait,
    ...(options.restart ? { persistedSession: options.restart.recovery?.checkpoint ?? restartCheckpoint, resumeInterruptedTurn: true } : {}),
  }).then((value) => { returned = value; return "finalized"; }, (error: unknown) => String(error instanceof Error ? error.message : error));
  await options.after?.(control, appended);
  const outcome = await execution;
  return { outcome, returned, appended, completeRun, resolveMissingResult, interrupt: control.interrupt, flushStreamingEvents,
    startTurn: control.startTurn, checkpoints, checkpointedAfter, snapshotSequences: control.snapshotSequences, elapsedMs: Date.now() - started };
}

const types = (events: PrpEvent[]) => events.map(value => value.eventType);
const waitFor = async (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 5_000, interval: 5 });

describe("prepared recovery with the real server-side driver and durable checkpoints", () => {
  async function durableCheckpoint(value: PersistedNativeSession): Promise<PersistedNativeSession> {
    const directory = await mkdtemp(join(tmpdir(), "prepared-recovery-"));
    const path = join(directory, "checkpoint.json");
    try {
      await writeFile(path, JSON.stringify(value), { mode: 0o600, flush: true });
      return JSON.parse(await readFile(path, "utf8")) as PersistedNativeSession;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  function preparedTask(kind: "pi_rpc" | "codex"): NativeExecutionInputV5 {
    const digest = "0".repeat(64);
    const context = {
      prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
      instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest,
        rootPath: "/runtime/instructions", fileCount: 1, totalBytes: 1 } },
      skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null },
    };
    const requirement = input.completionContract.contract.criteria[0]!.requirement;
    const prompt = `${input.task.prompt}\n\n${requirement}`;
    return { ...input, schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null,
      task: { ...input.task, description: requirement, prompt }, workspace: { ...input.workspace, cwd: WORKSPACE },
      session: { ...input.session, driverKind: kind === "pi_rpc" ? "pi_rpc" : "codex_app_server" },
      provider: kind === "pi_rpc" ? { kind, model: "test/pi", sessionContinuity: "continuous" } : { kind, model: null, approvalPolicy: "never" },
      runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
      completionSources: { promptSha256: createHash("sha256").update(prompt).digest("hex"), contractRevision: "1",
        criteria: [{ id: "objective", source: { kind: "description", id: identity.issueId,
          revision: createHash("sha256").update(requirement).digest("hex") } }] } };
  }

  function history(transport: FakeCodexTransport, ids: string[]) {
    transport.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE,
      turns: ids.map(id => ({ id, status: "completed", error: null, items: [] })) } };
  }

  async function finish(session: NativeSession, transport: FakeCodexTransport, id: string, withResult = false) {
    if (withResult) transport.push("paperclip/runResult", { threadId: "thread-1", turnId: id, result });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id, status: "completed", error: null, items: [] } });
    return collectUntilTerminal(session.events());
  }

  it("R0: submits exactly one resultless continuous-Pi disposition repair across attempts 2 and 3", async () => {
    const executionInput = preparedTask("pi_rpc");
    const transports = [new FakeCodexTransport(), new FakeCodexTransport(), new FakeCodexTransport()];
    const pending = [...transports];
    const backend = createRunnerdNativeSessionBackend(executionInput, {
      retainedSystemInstructions: "Fixture instructions.", runnerInstanceId: "runner-provider-turn", transportFactory: () => pending.shift()!,
    });
    const original = await backend.openSession({ identity, workingDirectory: WORKSPACE });
    await original.startTurn({ message: { role: "user", text: "Do the task." } });
    transports[0]!.push("item/completed", { threadId: "thread-1", turnId: "turn-1",
      item: { id: "old-answer", type: "agentMessage", text: "The task is already done." } });
    const replay = await finish(original, transports[0]!, "turn-1");
    let checkpoint = await durableCheckpoint(await original.snapshot());
    expect(transports[0]!.calls.find(call => call.method === "turn/start")!.params.input)
      .toMatchObject([{ type: "text", text: "Do the task." }]);
    await original.close({ reason: "controller restart" });
    const checkpoints: PersistedNativeSession[] = [];
    const completeRun = vi.fn(async () => undefined);
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession(value) { checkpoint = await durableCheckpoint(value); checkpoints.push(checkpoint); },
      async appendEvent(value) { replay.push(structuredClone(value)); return { cursor: value.sourceSeq,
        highestContiguousSourceSeq: value.sourceSeq, disposition: "committed" }; },
      async replayEvents(request) { const events = replay.filter(value => value.sourceInstanceId === request.sourceInstanceId
        && value.sourceSeq > request.afterSourceSeq); return { events, highestContiguousSourceSeq: Math.max(0, ...events.map(value => value.sourceSeq)) }; },
      completeRun,
    };
    const accepted = ["turn-1"];
    const outcomes: string[] = [];
    for (const attempt of [2, 3]) {
      const transport = transports[attempt - 1]!;
      history(transport, accepted);
      const turnId = `repair-${attempt}`;
      transport.turnStartResponse = Promise.resolve({ turn: { id: turnId, status: "inProgress", items: [] } });
      let settled = false;
      const execution = executeNativeSession({ input: executionInput, backend, controlPlane: port,
        persistedSession: structuredClone(checkpoint), runnerInstanceId: "runner-provider-turn", controlPlaneInstanceId: "control-provider-turn",
        timeoutMs: 5_000, resumeInterruptedTurn: true,
      }).then(() => "finalized", error => String(error instanceof Error ? error.message : error)).finally(() => { settled = true; });
      const starts = () => transport.calls.filter(call => call.method === "turn/start");
      await waitFor(() => settled || starts().length > 0);
      if (starts().length) {
        expect(JSON.stringify(starts()[0]!.params)).toContain("Paperclip semantic-result recovery for a prior completed provider turn.");
        expect(JSON.stringify(starts()[0]!.params)).not.toContain(executionInput.task.prompt);
        transport.push("turn/completed", { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null, items: [] } });
        accepted.push(turnId);
      }
      outcomes.push(await execution);
      expect(outcomes.at(-1)).toContain("native_finalization_missing:");
    }
    const submissions = transports.slice(1).flatMap(transport => transport.calls.filter(call => call.method === "turn/start"));
    console.info("R0 durable proof", JSON.stringify({ submissions: submissions.length, outcomes,
      checkpoint: { consumed: checkpoint.dispositionOnlyRecoveryConsumed, turnId: checkpoint.dispositionOnlyRecoveryTurnId,
        terminalTurns: checkpoint.terminalTurns }, checkpoints: checkpoints.length, replayEvents: replay.length }));
    expect(submissions).toHaveLength(1);
    expect(checkpoint).toMatchObject({ dispositionOnlyRecoveryConsumed: true, dispositionOnlyRecoveryTurnId: "repair-2" });
    expect(completeRun).not.toHaveBeenCalled();
  });

  it.each(["pi_rpc", "codex"] as const)("Ra/Rc: ordinary prepared %s turns survive two resumes and finish normally", async kind => {
    const transports = [new FakeCodexTransport(), new FakeCodexTransport(), new FakeCodexTransport()];
    const pending = [...transports];
    const backend = createRunnerdNativeSessionBackend(preparedTask(kind), {
      retainedSystemInstructions: "Fixture instructions.", runnerInstanceId: "runner-provider-turn", transportFactory: () => pending.shift()!,
    });
    const first = await backend.openSession({ identity, workingDirectory: WORKSPACE });
    await first.startTurn({ message: { role: "user", text: "Initial task." } });
    await finish(first, transports[0]!, "turn-1");
    const before = await durableCheckpoint(await first.snapshot());
    expect(transports[0]!.calls.find(call => call.method === "turn/start")!.params.input)
      .toMatchObject([{ type: "text", text: "Initial task." }]);
    await first.close({ reason: "first resume" });
    history(transports[1]!, ["turn-1"]);
    const resumed = (await backend.recoverSession!(before, { signal: new AbortController().signal })).session!;
    transports[1]!.turnStartResponse = Promise.resolve({ turn: { id: "person-2", status: "inProgress", items: [] } });
    await expect(resumed.startTurn({ message: { role: "user", text: "A person's ordinary follow-up." } }))
      .resolves.toMatchObject({ turnId: "person-2" });
    await finish(resumed, transports[1]!, "person-2");
    const after = await durableCheckpoint(await resumed.snapshot());
    await resumed.close({ reason: "second resume" });
    history(transports[2]!, ["turn-1", "person-2"]);
    const again = (await backend.recoverSession!(after, { signal: new AbortController().signal })).session!;
    transports[2]!.turnStartResponse = Promise.resolve({ turn: { id: "person-3", status: "inProgress", items: [] } });
    await expect(again.startTurn({ message: { role: "user", text: "The next message is still accepted." } }))
      .resolves.toMatchObject({ turnId: "person-3" });
    expect(after.dispositionOnlyRecoveryConsumed).toBe(false);
    await finish(again, transports[2]!, "person-3", true);
    expect(await again.result()).toMatchObject({ result, turnId: "person-3" });
    console.info("Ra/Rc durable proof", JSON.stringify({ kind, afterOrdinaryTurnConsumed: after.dispositionOnlyRecoveryConsumed,
      finalTurn: (await again.result())?.turnId }));
    await again.close({ reason: "fixture complete" });
  });

  it("Rb: manual compaction works after a prepared continuous-Pi resume", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const pending = [first, second];
    const backend = createRunnerdNativeSessionBackend(preparedTask("pi_rpc"), {
      retainedSystemInstructions: "Fixture instructions.", runnerInstanceId: "runner-provider-turn", transportFactory: () => pending.shift()!,
    });
    const original = await backend.openSession({ identity, workingDirectory: WORKSPACE });
    await original.startTurn({ message: { role: "user", text: "Initial task." } });
    await finish(original, first, "turn-1");
    const checkpoint = await durableCheckpoint(await original.snapshot());
    await original.close({ reason: "resume for manual compaction" });
    history(second, ["turn-1"]);
    const resumed = (await backend.recoverSession!(checkpoint, { signal: new AbortController().signal })).session!;
    await expect(resumed.startTurn({ message: { role: "user", text: "" }, continuation: true, compact: true }))
      .resolves.toMatchObject({ turnId: "turn-compact" });
    await finish(resumed, second, "turn-compact");
    expect(second.calls.filter(call => call.method === "thread/compact/start")).toHaveLength(1);
    expect((await resumed.snapshot()).dispositionOnlyRecoveryConsumed).toBe(false);
    console.info("Rb durable proof", JSON.stringify({ compactRequests: 1, consumed: (await resumed.snapshot()).dispositionOnlyRecoveryConsumed }));
    await resumed.close({ reason: "fixture complete" });
  });
});

describe("the controller consumer with provider-started turn sequences", () => {
  it.each([
    ["delta", "item.delta", { kind: "agentMessage", text: "Provider output was shown." }],
    ["old-stub", "item.completed", { answers: [], byteSize: 66888, truncated: true }],
    ["tool-only", "tool.execution.completed", { output: "file written", operation: "execute" }],
    ["file-edit-only", "tool.execution.completed", { output: "", operation: "edit", fileChanges: [{ path: "answer.txt" }] }],
    ["native-file-edit", "item.completed", { kind: "fileChange", changes: [{ path: "answer.txt" }] }],
    ["over-frame-final", "item.completed", { kind: "agentMessage", channel: "detail", transcriptOverflow: true, truncated: true }],
  ] as const)("does not resubmit resultless output; only transcript overflow is a permanent failure (%s)", async (_name, eventType, payload) => {
    const outcome = await run({ stream: [
      event("turn-1", "turn.started", { status: "inProgress" }),
      event("turn-1", eventType, payload),
      event("turn-1", "turn.completed", { status: "completed", error: null }),
    ] });
    expect(outcome.outcome).toContain(_name === "over-frame-final"
      ? "native_provider_output_without_result:" : "native_finalization_missing:");
    expect(outcome.startTurn).toHaveBeenCalledTimes(1);
    expect(outcome.completeRun).not.toHaveBeenCalled();
  });

  it("refuses old saved stub output before held Pi original-input resubmission", async () => {
    const stub = event("old-turn", "item.completed", { answers: [], byteSize: 66888, truncated: true });
    const checkpoint = { ...restartCheckpoint, driverKind: "pi_rpc" as const, terminalTurns: [] };
    const outcome = await run({ stream: [], executionInput: heldInput, restart: { recovery: {
      checkpoint, snapshot: { ...checkpoint, dispositionOnlyRecoveryConsumed: false }, replay: [stub],
    } } });
    expect(outcome.outcome).toContain("native_provider_output_without_result:");
    expect(outcome.startTurn).not.toHaveBeenCalled();
  });

  it.each(["codex", "pi_rpc"] as const)("restores a saved final before the output fence (%s), never submitting again", async kind => {
    const final = event("old-turn", "item.completed", { kind: "agentMessage", channel: "final", text: "Already published.", answers: [] });
    const terminal = event("old-turn", "turn.completed", { status: "completed", error: null });
    const checkpoint = { ...restartCheckpoint, terminalTurns: [completedTerminal("old-turn")] };
    const outcome = await run({ stream: [], executionInput: { ...input,
      session: { ...input.session, driverKind: kind === "pi_rpc" ? "pi_rpc" : "codex_app_server" },
      provider: kind === "pi_rpc" ? { kind, model: "test/pi", conversationMode: true } : { kind, model: null } },
      restart: { recovery: { checkpoint, snapshot: checkpoint, replay: [final, terminal] } },
      missingResult: ({ terminalEvent }) => terminalEvent.sourceEventId === terminal.sourceEventId ? result : null });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.startTurn).not.toHaveBeenCalled();
    expect(outcome.completeRun).toHaveBeenCalledOnce();
    expect(outcome.resolveMissingResult).toHaveBeenCalledOnce();
  });

  it.each(["tool.execution.completed", "item.completed"] as const)("refuses saved tool/file-only output before held Pi original-input resubmission (%s)", async eventType => {
    const saved = event("old-turn", eventType, eventType === "item.completed"
      ? { kind: "fileChange", changes: [{ path: "answer.txt" }] } : { output: "", operation: "edit" });
    const checkpoint = { ...restartCheckpoint, driverKind: "pi_rpc" as const, terminalTurns: [] };
    const outcome = await run({ stream: [], executionInput: heldInput, restart: { recovery: {
      checkpoint, snapshot: { ...checkpoint, dispositionOnlyRecoveryConsumed: false }, replay: [saved],
    } } });
    expect(outcome.outcome).toContain("native_provider_output_without_result:");
    expect(outcome.startTurn).not.toHaveBeenCalled();
    expect(outcome.completeRun).not.toHaveBeenCalled();
  });

  it.each([undefined, "continuous"] as const)("allows stock disposition for a completed Pi task with saved output (continuity=%s)", async sessionContinuity => {
    const saved = event("old-turn", "item.completed", { kind: "agentMessage", text: "The task is already done." });
    const terminal = event("old-turn", "turn.completed", { status: "completed", error: null });
    const checkpoint = { ...restartCheckpoint, driverKind: "pi_rpc" as const, terminalTurns: [completedTerminal("old-turn")] };
    const outcome = await run({ stream: [event("turn-fresh", "turn.started"),
      event("turn-fresh", "run.result.proposed", result as unknown as Record<string, unknown>),
      event("turn-fresh", "turn.completed", { status: "completed", error: null })],
      executionInput: { ...heldInput, provider: { kind: "pi_rpc", model: "test/pi", ...(sessionContinuity ? { sessionContinuity } : {}) } },
      restart: { recovery: { checkpoint, snapshot: { ...checkpoint, dispositionOnlyRecoveryConsumed: false }, replay: [saved, terminal] } } });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.startTurn).toHaveBeenCalledOnce();
    const recovery = JSON.parse(outcome.startTurn.mock.calls[0]![0].message.text);
    expect(recovery.task.prompt).toBe([
      "Paperclip semantic-result recovery for a prior completed provider turn.",
      "The prior turn already performed the work and its user-facing final answer is recorded.",
      "Do not repeat implementation, tests, research, or the final answer.",
      "Use the existing session context to invoke exactly one paperclip_finish or paperclip_block with the accurate current disposition, then stop without additional user-facing prose.",
    ].join("\n"));
    expect(recovery.task.prompt).not.toContain(input.task.prompt);
    expect(outcome.completeRun).toHaveBeenCalledOnce();
  });

  it.each(["task", "conversation"] as const)("still refuses saved Pi output without a completed terminal (%s)", async mode => {
    const saved = event("old-turn", "item.completed", { kind: "agentMessage", text: "Work was interrupted." });
    const checkpoint = { ...restartCheckpoint, driverKind: "pi_rpc" as const, terminalTurns: [] };
    const outcome = await run({ stream: [], executionInput: { ...heldInput,
      provider: { kind: "pi_rpc", model: "test/pi", ...(mode === "conversation" ? { conversationMode: true as const } : {}) } },
      restart: { recovery: { checkpoint, snapshot: { ...checkpoint, dispositionOnlyRecoveryConsumed: false }, replay: [saved] } } });
    expect(outcome.outcome).toContain("native_provider_output_without_result:");
    expect(outcome.startTurn).not.toHaveBeenCalled();
    expect(outcome.completeRun).not.toHaveBeenCalled();
  });

  it("settles a completed Pi conversation without submitting disposition recovery", async () => {
    const saved = event("old-turn", "item.completed", { kind: "agentMessage", text: "Already answered." });
    const terminal = event("old-turn", "turn.completed", { status: "completed", error: null });
    const checkpoint = { ...restartCheckpoint, driverKind: "pi_rpc" as const, terminalTurns: [completedTerminal("old-turn")] };
    const outcome = await run({ stream: [], executionInput: heldInput,
      restart: { recovery: { checkpoint, snapshot: { ...checkpoint, dispositionOnlyRecoveryConsumed: false }, replay: [saved, terminal] } },
      missingResult: () => result });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.startTurn).not.toHaveBeenCalled();
    expect(outcome.completeRun).toHaveBeenCalledOnce();
  });

  it("allows stock disposition after a tool-only continuation without resending the task", async () => {
    const outcome = await run({ stream: [], restart: {
      output: event("turn-continuation", "tool.execution.completed",
        { output: "", operation: "edit", fileChanges: [{ path: "once.txt" }] }),
      onDisposition: push => push(event("turn-disposition", "turn.started"),
        event("turn-disposition", "run.result.proposed", result as unknown as Record<string, unknown>),
        event("turn-disposition", "turn.completed", { status: "completed", error: null })),
    }, providerTurnWait: { capMs: 20 } });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.startTurn).toHaveBeenCalledTimes(2);
    const disposition = JSON.parse(outcome.startTurn.mock.calls[1]![0].message.text);
    expect(disposition.task.prompt).toContain("Do not repeat completed work");
    expect(disposition.task.prompt).not.toContain(input.task.prompt);
    expect(outcome.completeRun).toHaveBeenCalledOnce();
  });

  it.each([70_000, 300_000])("settles a complete large answer without a recovery submission (%i)", async size => {
    const answer = "word ".repeat(size / 5);
    const final = event("turn-1", "item.completed", { kind: "agentMessage", channel: "final", text: answer, answers: [] });
    const outcome = await run({ stream: [event("turn-1", "turn.started"), final,
      event("turn-1", "turn.completed", { status: "completed", error: null })], missingResult: () => result });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.appended.find(value => value === final || value.sourceEventId === final.sourceEventId)?.payload.text).toBe(answer);
    expect(outcome.startTurn).toHaveBeenCalledTimes(1);
    expect(outcome.completeRun).toHaveBeenCalledTimes(1);
  });

  it("finalizes a no-result turn exactly as before when the Runner did not await", async () => {
    const outcome = await run({ stream: [...turnOne(false), ...providerTurn("provider-1", { result: true })] });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.completeRun).not.toHaveBeenCalled();
    expect(types(outcome.appended)).toEqual(["turn.started", "item.completed", "turn.completed"]);
    expect(outcome.interrupt).not.toHaveBeenCalled();
  });

  const ordinaryTurn = () => [
    event("turn-1", "turn.started", { status: "inProgress" }),
    event("turn-1", "item.completed", usage),
    event("turn-1", "run.result.proposed", result as unknown as Record<string, unknown>),
    event("turn-1", "turn.completed", { status: "completed", error: null }),
  ];
  const checkpointsAfter = (outcome: Awaited<ReturnType<typeof run>>, matches: (value: PrpEvent) => boolean) => {
    const index = outcome.appended.findIndex(matches);
    return outcome.checkpoints.filter((_value, at) => outcome.checkpointedAfter[at] === index + 1);
  };

  it("persists a checkpoint with the waiting shape right after the awaiting terminal", async () => {
    const outcome = await run({ stream: turnOne(true), providerTurnWait: { capMs: 100 } });
    expect(checkpointsAfter(outcome, value => value.payload.awaitingProviderTurn === true))
      .toEqual([expect.objectContaining({ activeTurnId: null, awaitingProviderTurn: true })]);
  });

  it("persists a checkpoint naming a provider-started turn active right after its start", async () => {
    const outcome = await run({ stream: [...turnOne(true), ...providerTurn("provider-1", { awaiting: true }), ...providerTurn("provider-2", { result: true })] });
    expect(outcome.outcome).toBe("finalized");
    for (const turnId of ["provider-1", "provider-2"]) {
      expect(checkpointsAfter(outcome, value => value.turnId === turnId && value.eventType === "turn.started"))
        .toEqual([expect.objectContaining({ activeTurnId: turnId })]);
    }
  });

  it("asks for the snapshot as of the awaiting terminal and the provider start it has just appended", async () => {
    const outcome = await run({ stream: [...turnOne(true), ...providerTurn("provider-1", { result: true })] });
    expect(outcome.outcome).toBe("finalized");
    const awaited = outcome.appended.find(value => value.payload.awaitingProviderTurn === true)!;
    const started = outcome.appended.find(value => value.payload.origin === "provider")!;
    expect(outcome.snapshotSequences.filter(value => value !== undefined)).toEqual([awaited.sourceSeq, started.sourceSeq]);
  });

  it("persists no checkpoint of either kind for a turn that does not await", async () => {
    const outcome = await run({ stream: ordinaryTurn() });
    expect(outcome.outcome).toBe("finalized");
    const checkpointsWithoutProviderTurns = 4;
    expect(outcome.checkpoints).toHaveLength(checkpointsWithoutProviderTurns);
    expect(outcome.checkpoints.filter(value => value.awaitingProviderTurn || value.activeTurnId?.startsWith("provider-"))).toEqual([]);
  });

  it("consumes the provider-started turn as the next turn of the same run and settles its result normally", async () => {
    const outcome = await run({ stream: [...turnOne(true), ...providerTurn("provider-1", { result: true })] });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.completeRun).toHaveBeenCalledOnce();
    expect(outcome.resolveMissingResult).not.toHaveBeenCalled();
    expect(outcome.appended.filter(value => value.payload.origin === "provider").map(value => value.turnId)).toEqual(["provider-1"]);
    expect(outcome.appended.filter(value => value.payload.kind === "usage").map(value => value.turnId)).toEqual(["turn-1", "provider-1"]);
    expect(outcome.interrupt).not.toHaveBeenCalled();
  });

  it("keeps waiting when a provider-started turn also ends awaiting, then settles the later turn's result", async () => {
    const outcome = await run({ stream: [...turnOne(true), ...providerTurn("provider-1", { awaiting: true }),
      ...providerTurn("provider-2", { result: true })] });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.appended.filter(value => value.payload.origin === "provider").map(value => value.turnId)).toEqual(["provider-1", "provider-2"]);
  });

  it("ends an idle wait at the cap by stopping the wait, then takes today's missing-result path with the awaited terminal", async () => {
    const outcome = await run({ stream: turnOne(true), providerTurnWait: { capMs: 100 } });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).toHaveBeenCalledOnce();
    expect(outcome.interrupt.mock.calls[0]![0]).toMatchObject({ turnId: "turn-1" });
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn-1", terminalEvent: expect.objectContaining({ eventType: "turn.completed", payload: expect.objectContaining({ awaitingProviderTurn: true }) }) }));
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(90);
  });

  it("does not restart the cap when a later provider-started turn also ends without a result", async () => {
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 300 },
      after: async (control) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        control.push(...providerTurn("provider-1", { awaiting: true }));
      },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.elapsedMs).toBeLessThan(450);
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({ turnId: "provider-1" }));
  });

  it.each(["cap", "comment"] as const)("lets a running provider-started turn finish after the %s and settles its result normally", async (trigger) => {
    let release!: () => void;
    const comment = new Promise<void>(resolve => { release = resolve; });
    const onWait = vi.fn(() => comment);
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: trigger === "cap" ? { capMs: 150 } : { capMs: 60_000, onWait },
      after: async (control) => {
        control.push(event("provider-1", "turn.started", { status: "inProgress", origin: "provider" }));
        if (trigger === "comment") { await waitFor(() => onWait.mock.calls.length === 1); release(); }
        await new Promise(resolve => setTimeout(resolve, 300));
        control.push(event("provider-1", "item.completed", usage), event("provider-1", "run.result.proposed", result as unknown as Record<string, unknown>),
          event("provider-1", "turn.completed", { status: "completed", error: null }));
      },
    });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.completeRun).toHaveBeenCalledOnce();
    expect(outcome.appended.some(value => value.eventType === "turn.cancelled")).toBe(false);
  });

  it.each(["cap", "comment"] as const)("takes today's path at once when a provider-started turn running past the %s ends awaiting again", async (trigger) => {
    let release!: () => void;
    const comment = new Promise<void>(resolve => { release = resolve; });
    const onWait = vi.fn(() => comment);
    let endedAt = 0;
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: trigger === "cap" ? { capMs: 150 } : { capMs: 60_000, onWait },
      after: async (control) => {
        control.push(event("provider-1", "turn.started", { status: "inProgress", origin: "provider" }));
        if (trigger === "comment") { await waitFor(() => onWait.mock.calls.length === 1); release(); }
        await new Promise(resolve => setTimeout(resolve, 300));
        endedAt = Date.now();
        control.push(event("provider-1", "item.completed", usage),
          event("provider-1", "turn.completed", { status: "completed", error: null, awaitingProviderTurn: true }));
      },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({ turnId: "provider-1" }));
    expect(Date.now() - endedAt).toBeLessThan(1_000);
  });

  it("settles a batched delta that arrived during the idle wait before the limit ends the turn", async () => {
    let delta!: PrpEvent;
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 150 }, withoutInterrupt: true, pipelinesDeltas: true,
      missingResult: () => result,
      after: async (control, appended) => {
        await waitFor(() => appended.some(value => value.payload.awaitingProviderTurn === true));
        delta = { ...event("turn-1", "item.delta", { kind: "agentMessage", text: "late chunk" }), itemId: "message-1", priority: 1 };
        control.push(delta);
      },
    });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.flushStreamingEvents).toHaveBeenCalled();
    expect(outcome.appended.filter(value => value.eventType === "item.delta")).toHaveLength(1);
    expect(outcome.returned).toMatchObject({ nativeEventCount: outcome.appended.length, highestContiguousSourceSeq: delta.sourceSeq });
  });

  it("never waits longer than the run's remaining timeout", async () => {
    const turnTimeoutMs = PROVIDER_TURN_WAIT_TIMEOUT_MARGIN_MS + 200;
    const outcome = await run({ stream: turnOne(true), turnTimeoutMs });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.outcome).not.toContain("timed out");
    expect(outcome.elapsedMs).toBeLessThan(2_000);
    expect(providerTurnWaitDeadline({ startedAtMs: 1_000, capMs: 600_000, overallDeadlineMs: null })).toBe(601_000);
    expect(providerTurnWaitDeadline({ startedAtMs: 1_000, capMs: 600_000, overallDeadlineMs: 60_000 }))
      .toBe(60_000 - PROVIDER_TURN_WAIT_TIMEOUT_MARGIN_MS);
  });

  it("resumes the cap from the wait start a previous controller recorded", async () => {
    const outcome = await run({ stream: turnOne(true), providerTurnWait: { startedAtMs: Date.now() - 599_900 } });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.elapsedMs).toBeLessThan(2_000);
  });

  it("ends the wait early when the control plane reports a new comment", async () => {
    let release!: () => void;
    const comment = new Promise<void>(resolve => { release = resolve; });
    const onWait = vi.fn(() => comment);
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 60_000, onWait },
      after: async () => { await waitFor(() => onWait.mock.calls.length === 1); release(); },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).toHaveBeenCalledOnce();
    expect(outcome.elapsedMs).toBeLessThan(5_000);
  });

  it("ends the wait at once when Stop interrupts the session", async () => {
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 60_000 },
      after: async (control, appended) => {
        await waitFor(() => appended.some(value => value.payload.awaitingProviderTurn === true));
        await control.session.interrupt!({ reason: "Stop" });
      },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).toHaveBeenCalledOnce();
    expect(outcome.elapsedMs).toBeLessThan(5_000);
  });

  it("tolerates the Runner's held run.terminal during the wait and after Core ends it", async () => {
    const heldTerminal = () => event("turn-1", "run.terminal", { schema: "paperclip.prp.terminal.v1", status: "succeeded",
      turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done", provider: "acpx" });
    const outcome = await run({
      stream: [...turnOne(true), heldTerminal()], providerTurnWait: { capMs: 150 },
      after: async (control) => {
        await waitFor(() => control.interrupt.mock.calls.length === 1);
        control.push(heldTerminal());
      },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.appended.filter(value => value.eventType === "run.terminal")).toHaveLength(1);
    expect(outcome.resolveMissingResult).toHaveBeenCalledOnce();
  });

  it.each([false, true])("settles a plan proposed in the provider-started turn as the plan review wait (cap passed during the turn: %s)", async (capPassed) => {
    let seen: PrpEvent[] = [];
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: capPassed ? 100 : 60_000 },
      missingResult: ({ terminalEvent }) => seen.some(value => value.eventType === "plan.proposed")
        && terminalEvent.eventType === "turn.completed" ? planReviewWait : null,
      after: async (control, appended) => {
        seen = appended;
        control.push(event("provider-1", "turn.started", { status: "inProgress", origin: "provider" }));
        await waitFor(() => appended.some(value => value.payload.origin === "provider"));
        if (capPassed) await new Promise(resolve => setTimeout(resolve, 250));
        control.push(
          event("provider-1", "plan.proposed", { schema: "paperclip.plan.proposed.v1", proposalId: "toolu_plan", status: "completed",
            markdown: "# Plan\n\n1. Install.\n2. Test.", source: "claude_exit_plan_mode" }),
          event("provider-1", "item.completed", usage),
          event("provider-1", "turn.completed", { status: "completed", error: null }),
          event("provider-1", "run.terminal", { schema: "paperclip.prp.terminal.v1", status: "succeeded", turnTerminalState: "completed",
            runTerminalState: "succeeded", reportedWorkDisposition: "done", provider: "acpx" }),
        );
      },
    });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.appended.filter(value => value.eventType === "plan.proposed")).toEqual([expect.objectContaining({ turnId: "provider-1", payload: expect.objectContaining({ status: "completed" }) })]);
    expect(outcome.resolveMissingResult).toHaveBeenCalledOnce();
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "provider-1", terminalEvent: expect.objectContaining({ eventType: "turn.completed", turnId: "provider-1" }) }));
    expect(outcome.resolveMissingResult.mock.calls[0]![0].terminalEvent.payload).not.toHaveProperty("awaitingProviderTurn");
    expect((outcome.completeRun.mock.calls[0] as unknown[])[0]).toMatchObject({ result: planReviewWait, turnId: "provider-1",
      terminal: { runTerminalState: "succeeded", reportedWorkDisposition: "yielded" } });
  });

  const dispositionRequests = (startTurn: ReturnType<typeof harness>["startTurn"]) =>
    startTurn.mock.calls.filter(([value]) => value.message.text.includes("Paperclip semantic-result recovery")).length;
  const dispositionTurn = () => [
    event("turn-disposition", "turn.started", { status: "inProgress" }),
    event("turn-disposition", "run.result.proposed", result as unknown as Record<string, unknown>),
    event("turn-disposition", "turn.completed", { status: "completed", error: null }),
  ];

  const ids = (events: PrpEvent[]) => events.map(value => value.sourceEventId);
  const appendedOf = (appended: PrpEvent[], events: PrpEvent[]) =>
    ids(appended).filter(id => ids(events).includes(id));

  it("keeps reading the follow-up turn that a forced end of an idle wait starts and settles its result", async () => {
    const turn = dispositionTurn();
    const outcome = await run({
      stream: [], providerTurnWait: { capMs: 100 }, withoutInterrupt: true,
      restart: { onDisposition: push => push(...turn) },
    });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.returned).toMatchObject({ result, turnId: "turn-disposition" });
    expect(outcome.resolveMissingResult).not.toHaveBeenCalled();
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.startTurn).toHaveBeenCalledTimes(2);
    expect(dispositionRequests(outcome.startTurn)).toBe(1);
    expect(appendedOf(outcome.appended, turn)).toEqual(ids(turn));
  });

  it("appends exactly once an event that reaches the outstanding read after the forced end was taken", async () => {
    const turn = dispositionTurn();
    const outcome = await run({
      stream: [], providerTurnWait: { capMs: 100 }, withoutInterrupt: true, restart: {},
      after: async (control) => {
        await waitFor(() => control.startTurn.mock.calls.length === 2);
        const [first, ...rest] = turn;
        await new Promise(resolve => setTimeout(resolve, 50));
        control.push(first!);
        await new Promise(resolve => setTimeout(resolve, 50));
        control.push(...rest);
      },
    });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.appended.filter(value => value.sourceEventId === turn[0]!.sourceEventId)).toHaveLength(1);
    expect(appendedOf(outcome.appended, turn)).toEqual(ids(turn));
    expect(dispositionRequests(outcome.startTurn)).toBe(1);
  });

  it.each([true, false])("keeps waiting after a controller restart while the checkpoint still names the awaited turn as active (provider turn arrives: %s)", async (arrives) => {
    const recovery = {
      checkpoint: { ...restartCheckpoint, activeTurnId: "turn-1", terminalTurns: [] },
      snapshot: { terminalTurns: [completedTerminal("turn-1")], semanticResult: null, awaitingProviderTurn: true },
    };
    const stream = [event("turn-1", "turn.completed", { status: "completed", error: null, awaitingProviderTurn: true })];
    const turn = providerTurn("provider-1", { result: true });
    const outcome = await run({
      stream, restart: { recovery }, turnTimeoutMs: 10_000,
      providerTurnWait: { startedAtMs: Date.now() - (arrives ? 599_000 : 599_700) },
      after: async (control) => {
        if (!arrives) return;
        await new Promise(resolve => setTimeout(resolve, 200));
        control.push(...turn);
      },
    });
    expect(outcome.startTurn).not.toHaveBeenCalled();
    if (arrives) {
      expect(outcome.outcome).toBe("finalized");
      expect(outcome.returned).toMatchObject({ result, turnId: "provider-1" });
      expect(outcome.interrupt).not.toHaveBeenCalled();
      expect(appendedOf(outcome.appended, turn)).toEqual(ids(turn));
    } else {
      expect(outcome.outcome).toContain("native_finalization_missing");
      expect(outcome.interrupt).toHaveBeenCalledOnce();
      expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({ turnId: "turn-1",
        terminalEvent: expect.objectContaining({ eventType: "turn.completed", payload: expect.objectContaining({ awaitingProviderTurn: true }) }) }));
      expect(outcome.elapsedMs).toBeLessThan(5_000);
    }
  });

  const awaitingSnapshot = { terminalTurns: [completedTerminal("turn-1")], semanticResult: null, awaitingProviderTurn: true };
  const afterTerminalRecovery = (options: { flag?: boolean; replay?: PrpEvent[] } = {}) => ({
    checkpoint: { ...restartCheckpoint, terminalTurns: [completedTerminal("turn-1")], ...(options.flag === false ? {} : { awaitingProviderTurn: true }) },
    snapshot: options.flag === false ? { terminalTurns: [completedTerminal("turn-1")], semanticResult: null } : awaitingSnapshot,
    replay: options.replay ?? turnOne(true),
  });

  it.each([true, false])("keeps waiting after a controller restart saved after the awaiting terminal (provider turn arrives: %s)", async (arrives) => {
    const turn = providerTurn("provider-1", { result: true });
    const recovery = afterTerminalRecovery();
    const outcome = await run({
      stream: [], restart: { recovery }, turnTimeoutMs: 10_000,
      providerTurnWait: { startedAtMs: Date.now() - (arrives ? 599_000 : 599_700) },
      after: async (control) => {
        if (!arrives) return;
        await new Promise(resolve => setTimeout(resolve, 200));
        control.push(...turn);
      },
    });
    expect(outcome.startTurn).not.toHaveBeenCalled();
    expect(appendedOf(outcome.appended, recovery.replay)).toEqual([]);
    if (arrives) {
      expect(outcome.outcome).toBe("finalized");
      expect(outcome.returned).toMatchObject({ result, turnId: "provider-1" });
      expect(outcome.interrupt).not.toHaveBeenCalled();
      expect(appendedOf(outcome.appended, turn)).toEqual(ids(turn));
    } else {
      expect(outcome.outcome).toContain("native_finalization_missing");
      expect(outcome.interrupt).toHaveBeenCalledOnce();
      expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({ turnId: "turn-1",
        terminalEvent: expect.objectContaining({ eventType: "turn.completed", payload: expect.objectContaining({ awaitingProviderTurn: true }) }) }));
      expect(outcome.elapsedMs).toBeLessThan(5_000);
    }
  });

  it.each([false, true])("ends a resumed wait at once through the no-result path when its limit passed before the restart (without interrupt: %s)", async (withoutInterrupt) => {
    const outcome = await run({
      stream: [], restart: { recovery: afterTerminalRecovery() }, turnTimeoutMs: 10_000, withoutInterrupt,
      providerTurnWait: { startedAtMs: Date.now() - 700_000 },
    });
    expect(outcome.startTurn).not.toHaveBeenCalled();
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).toHaveBeenCalledTimes(withoutInterrupt ? 0 : 1);
    expect(outcome.resolveMissingResult).toHaveBeenCalledOnce();
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({ turnId: "turn-1",
      terminalEvent: expect.objectContaining({ payload: expect.objectContaining({ awaitingProviderTurn: true }) }) }));
    expect(outcome.elapsedMs).toBeLessThan(1_000);
  });

  it.each([
    { label: "the replayed terminal has no marker", recovery: afterTerminalRecovery({ replay: turnOne(false) }) },
    { label: "replay has no terminal", recovery: afterTerminalRecovery({ replay: [] }) },
    { label: "the recovered session has no awaiting flag", recovery: afterTerminalRecovery({ flag: false }) },
  ])("sends the disposition-only recovery prompt after a restart as before when $label", async ({ recovery }) => {
    const fresh = [
      event("turn-fresh", "turn.started", { status: "inProgress" }),
      event("turn-fresh", "run.result.proposed", result as unknown as Record<string, unknown>),
      event("turn-fresh", "turn.completed", { status: "completed", error: null }),
    ];
    const outcome = await run({
      stream: [], restart: { recovery }, turnTimeoutMs: 10_000, providerTurnWait: { startedAtMs: Date.now() - 599_000 },
      after: async (control) => {
        await waitFor(() => control.startTurn.mock.calls.length === 1);
        control.push(...fresh);
      },
    });
    expect(outcome.startTurn).toHaveBeenCalledOnce();
    expect(dispositionRequests(outcome.startTurn)).toBe(1);
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.returned).toMatchObject({ result, turnId: "turn-fresh" });
    expect(outcome.interrupt).not.toHaveBeenCalled();
  });

  it("resumes the wait again after a second restart during a resumed wait", async () => {
    const startedAtMs = Date.now() - 599_000;
    const first = await run({
      stream: [], restart: { recovery: afterTerminalRecovery() }, turnTimeoutMs: 10_000, providerTurnWait: { startedAtMs },
    });
    expect(first.startTurn).not.toHaveBeenCalled();
    expect(first.checkpoints.length).toBeGreaterThan(0);
    const persisted = first.checkpoints.at(-1)!;
    expect(persisted).toMatchObject({ activeTurnId: null, awaitingProviderTurn: true });
    expect(persisted.dispositionOnlyRecoveryConsumed).toBeFalsy();
    const turn = providerTurn("provider-1", { result: true });
    const second = await run({
      stream: [], restart: { recovery: { ...afterTerminalRecovery(), checkpoint: persisted } }, turnTimeoutMs: 10_000,
      providerTurnWait: { startedAtMs: Date.now() - 599_000 },
      after: async (control) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        control.push(...turn);
      },
    });
    expect(second.startTurn).not.toHaveBeenCalled();
    expect(second.outcome).toBe("finalized");
    expect(second.returned).toMatchObject({ result, turnId: "provider-1" });
  });

  it.each([true, false])("resumes a restored wait whose disposition marker is consumed instead of settling on that turn's earlier terminal (provider turn arrives: %s)", async (arrives) => {
    const awaitedTurn = [
      event("turn-disposition", "turn.started", { status: "inProgress" }),
      event("turn-disposition", "item.completed", usage),
      event("turn-disposition", "turn.completed", { status: "completed", error: null, awaitingProviderTurn: true }),
    ];
    const terminalTurns = [completedTerminal("turn-1"), completedTerminal("turn-disposition")];
    const waiting = { terminalTurns, semanticResult: null, awaitingProviderTurn: true, dispositionOnlyRecoveryConsumed: true, dispositionOnlyRecoveryTurnId: "turn-disposition" };
    const recovery = { checkpoint: { ...restartCheckpoint, ...waiting }, snapshot: waiting, replay: [...turnOne(false), ...awaitedTurn] };
    const turn = providerTurn("provider-1", { result: true });
    const outcome = await run({
      stream: [], restart: { recovery }, turnTimeoutMs: 10_000,
      providerTurnWait: { startedAtMs: Date.now() - (arrives ? 599_000 : 599_700) },
      after: async (control) => {
        if (!arrives) return;
        await new Promise(resolve => setTimeout(resolve, 200));
        control.push(...turn);
      },
    });
    expect(outcome.startTurn).not.toHaveBeenCalled();
    if (arrives) {
      expect(outcome.outcome).toBe("finalized");
      expect(outcome.returned).toMatchObject({ result, turnId: "provider-1" });
      expect(outcome.resolveMissingResult).not.toHaveBeenCalled();
      expect(outcome.interrupt).not.toHaveBeenCalled();
      expect(appendedOf(outcome.appended, turn)).toEqual(ids(turn));
    } else {
      expect(outcome.outcome).toContain("native_finalization_missing");
      expect(outcome.interrupt).toHaveBeenCalledOnce();
      expect(outcome.resolveMissingResult).toHaveBeenCalledOnce();
      expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({ turnId: "turn-disposition",
        terminalEvent: expect.objectContaining({ eventType: "turn.completed", payload: expect.objectContaining({ awaitingProviderTurn: true }) }) }));
    }
  });

  it("fails the run as today when the Runner's stream ends during the wait", async () => {
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 60_000 },
      after: async (control, appended) => {
        await waitFor(() => appended.some(value => value.payload.awaitingProviderTurn === true));
        control.push("end");
      },
    });
    expect(outcome.outcome).toContain("native event stream closed before a turn terminal fact");
    expect(outcome.elapsedMs).toBeLessThan(5_000);
  });
});
