/**
 * D-B5 — RFL's (eq) same-prior-checkpoint equality and (rt) real refreshTools trace.
 * Fix author: code-lead; candidate: D-B5.patch (not a prerequisite of these tests).
 * Keep: recorded warm-controller/durable-checkpoint policy mismatch, a recovery
 * failure path that does not require a provider process or an embedded database.
 *
 * (eq) done / yielded+response_wake / unfinished goal, each refreshTools=false/true.
 * The oracle is the REAL durable rebind, not a second policy implementation.
 * The REAL executePaperclipNativeSession writes the controller envelope through
 * onCheckpoint, then reads it on the next run through loadWarmNativeCheckpoint
 * (native-session-executor.ts:12640; loader :8969). Only the downstream provider
 * execution boundary and unrelated delivery/storage boundaries are doubled.
 * No exported helper added by D-B5 is imported or mocked.
 *
 * (rt) Fresh selection uses context.refreshTools===true (:953); its executor
 * caller uses the same expression (heartbeat/runtime-execution.ts:660).
 * heartbeat.ts:3573 and :3651 pass the SAME context object to both stages.
 * However, runtime-selection.ts:658-662 (persisted unused-bootstrap recovery)
 * omits refreshTools AND toolRefreshOnResume in its direct durable rebind call.
 * Therefore global equality is NOT true by construction. The rt row below
 * exposes that existing difference through both real callers; it deliberately
 * records the omission rather than demanding an unrelated runtime-selection fix
 * that D-B5.patch does not contain. Expected: rt green before/after D-B5; six eq
 * rows red before (undefined warm policy), green after D-B5 byte-for-byte.
 * Execution/colour verification belongs to the lead (this assignment is edit-only).
 * Source lines above refer to S1 74ccf170, before D-B1/D-B2/D-B4/D-B5.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  budgetReservations,
  completionContracts,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import {
  type NativeExecutionInput,
  type PersistedNativeSession,
} from "../../vendor/paperclip-runner/index.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { createAdapterExecutionControl } from "../adapter-execution-control.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { executeHeartbeatRuntime, type HeartbeatRuntimeExecutionInput } from "../heartbeat/runtime-execution.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "../heartbeat/runtime-selection.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import * as nativeExecutor from "./native-session-executor.js";
import * as nativeResume from "./native-session-resume.js";
import * as controllerRecovery from "./native-controller-recovery.js";
import { resolveHeartbeatNativeRuntimeMode } from "./runtime-mode.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({
  ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(),
  executeNativeSession: provider.execute,
}));
vi.mock("./native-run-wake-anchor.js", () => ({ readNativeRunWakeRequestedAtMs: async () => null }));
vi.mock("../usage-receipts.js", async original => ({
  ...await original<typeof import("../usage-receipts.js")>(),
  createRunUsageRecorder: async () => ({ capture: async () => {}, persistFailure: async () => {},
    complete: async () => ({ complete: true }) }),
}));
vi.mock("./native-runner-file-handoff.js", () => ({
  stageNativeRunnerWakeAttachments: async () => ({ attachments: [], cleanup: async () => {} }),
  renderNativeRunnerStagedAttachmentPrompt: () => "",
}));
vi.mock("./current-wake-comments.js", async original => ({
  ...await original<typeof import("./current-wake-comments.js")>(),
  resolveCurrentWakeCommentsBinding: async () => null,
  assertCurrentWakeCommentsRead: async () => {},
}));
vi.mock("../heartbeat/run-preparation.js", async original => ({
  ...await original<typeof import("../heartbeat/run-preparation.js")>(),
  buildPaperclipRuntimeMcpServers: async () => [],
  revokeHeartbeatRunGatewayTokens: async () => {},
}));

// Like native-session-executor.test.ts:8468's leaseDb: these are only the
// ownership/storage query results needed by the executor, not a DB rebind double.
// The durable rebind and every warm envelope/digest/identity check remain real.
function fixture(cwd: string) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  const sessionId = randomUUID(), workspaceId = randomUUID(), contractId = randomUUID();
  const priorRunId = randomUUID(), currentRunId = randomUUID();
  const issue = { id: issueId, companyId, identifier: "RFL-DB5", title: "Answer the follow-up",
    description: null, workMode: "standard", assigneeAgentId: agentId, status: "in_progress",
    executionRunId: currentRunId, checkoutRunId: null };
  const build = (runId: string) => buildNativeExecutionInput({
    companyId, agentId, runId, issue, taskPrompt: "Answer the follow-up",
    workspace: { id: workspaceId, cwd, repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: sessionId, provider: "codex",
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    completionContract: { id: contractId, sha256: `sha256:${"a".repeat(64)}`,
      schemaVersion: "paperclip.run-result.v1", contract: { revision: "1",
        objective: "Answer the follow-up", criteria: [{ id: "answer", requirement: "Answer the person" }] } },
    runtimeContext: nativeRuntimeContextFixture(),
  });
  const prior = build(priorRunId), current = build(currentRunId);
  const snapshot = (state: "done" | "yielded+response_wake" | "unfinished goal"): PersistedNativeSession => ({
    backendKind: "runner", driverKind: prior.session.driverKind,
    sessionId: "db5-driver-session", providerSessionId: "db5-provider-session", cursor: "17",
    identity: { runId: priorRunId, sessionId, companyId, issueId, agentId },
    semanticResult: { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      reportedWorkDisposition: state === "yielded+response_wake" ? "yielded" : "done",
      ...(state === "yielded+response_wake" ? { continuation: { kind: "response_wake" } } : {}),
    } as PersistedNativeSession["semanticResult"],
    terminal: null, activeTurnId: null, terminalTurns: [], pendingRuntimeRequests: [],
    ...(state === "unfinished goal" ? { goal: { status: "active", objective: "Still unfinished" } as PersistedNativeSession["goal"] } : {}),
  });
  const source = (checkpoint: PersistedNativeSession) => ({
    id: priorRunId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
    runnerInstanceId: randomUUID(), runtimeMode: "native", status: "succeeded", createdAt: new Date(0),
    processPid: null, processGroupId: null, processStartedAt: null,
    runnerProfileJson: { nativeExecutionInput: prior, sessionCheckpoint: checkpoint,
      nativeToolContractFingerprint: nativeResume.nativeToolContractFingerprintForTarget("local", prior.provider.kind) },
  });
  const run = { id: currentRunId, companyId, agentId, issueId, nativeIssueId: issueId,
    nativeSessionId: sessionId, runnerInstanceId: "db5-runner", runtimeMode: "native", status: "running",
    createdAt: new Date(), startedAt: new Date(), completionContractId: contractId,
    runtimeModeReason: null, runtimeModeResolvedAt: new Date(), driverKind: current.session.driverKind,
    processPid: null, processGroupId: null, processStartedAt: null, retryOfRunId: null,
    resultJson: {}, contextSnapshot: {}, runnerProfileJson: { nativeExecutionInput: current } };

  function dbFor(execution: NativeExecutionInput, extraRows = new Map<unknown, unknown[]>()) {
    const coordinator = { runId: execution.binding.runId, companyId, issueId, phase: "observed",
      attempt: 0, leaseOwner: null, leaseExpiresAt: null, resultId: null };
    const rows = (table: unknown) => extraRows.get(table) ?? (table === nativeRunFinalizations ? [coordinator]
      : table === heartbeatRuns ? [{ ...run, id: execution.binding.runId,
          runnerProfileJson: { nativeExecutionInput: execution },
          completionContractSha256: execution.completionContract.sha256 }]
      : table === issues ? [{ ...issue, executionRunId: execution.binding.runId }]
      : table === completionContracts ? [{ id: contractId, companyId, issueId,
          canonicalSha256: current.completionContract.sha256, schemaVersion: current.completionContract.schemaVersion,
          contractJson: current.completionContract.contract }]
      : table === budgetReservations ? [{ id: "db5-held-reservation" }] : []);
    const select = () => ({ from: (table: unknown) => {
      const result = Promise.resolve(rows(table));
      const query = { then: result.then.bind(result), where: () => query, limit: () => query,
        for: () => query, orderBy: () => query, leftJoin: () => query, innerJoin: () => query };
      return query;
    } });
    const update = () => ({ set: () => ({ where: () => Object.assign(Promise.resolve([]), {
      returning: async () => [{ runId: execution.binding.runId, nextEventSeq: 2 }],
    }) }) });
    const insert = () => ({ values: (values: unknown) => {
      const result = Promise.resolve([values]);
      const query = { then: result.then.bind(result), returning: async () => [values],
        onConflictDoNothing: () => query, onConflictDoUpdate: () => query };
      return query;
    } });
    const db = { select, update, insert, execute: async () => [],
      transaction: async (work: (tx: Db) => Promise<unknown>) => work(db as unknown as Db) };
    return db as unknown as Db;
  }
  return { prior, current, snapshot, source, run, issue, dbFor, companyId, agentId, issueId, sessionId };
}

type RuntimeOptions = Parameters<typeof import("../../vendor/paperclip-runner/index.js").executeNativeSession>[0];
const unusedBackend = {
  descriptor: async () => { throw new Error("provider descriptor must not be used by the boundary double"); },
  openSession: async () => { throw new Error("a provider process must not be opened"); },
};
function completed(execution: NativeExecutionInput) {
  return { result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: { runTerminalState: "succeeded" },
    turnId: "db5-turn", normalizedSessionId: execution.session.normalizedSessionId,
    providerSessionId: "db5-provider-session", driverKind: execution.session.driverKind,
    driverVersion: "test", nativeEventCount: 0, highestContiguousSourceSeq: 0, usage: null };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "paperclip-db5-policy-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  provider.execute.mockReset();
  // Same seam as native-session-executor.test.ts:534: synthetic query rows do
  // not pretend to establish controller/runner discovery or process absence.
  vi.spyOn(controllerRecovery, "resolveNativeControllerRecovery").mockResolvedValue({ kind: "no_prior_execution" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("D-B5 RFL warm/durable recovery policy equality", () => {
  const priors = ["done", "yielded+response_wake", "unfinished goal"] as const;
  const cases = priors.flatMap(prior => [false, true].map(refreshTools => ({ prior, refreshTools })));
  it.each(cases)("(eq) $prior / refreshTools=$refreshTools: warm file rebind equals durable rebind", async ({ prior, refreshTools }) => {
    const f = fixture(home);
    const checkpoint = f.snapshot(prior);
    const original = structuredClone(checkpoint);
    expect(checkpoint).not.toHaveProperty("providerRecoveryPolicy");
    const durable = nativeResume.rebindNativeSessionCheckpoint({ previousRun: f.source(checkpoint),
      currentExecution: f.current, refreshTools, toolRefreshOnResume: true });
    expect(durable).not.toBeNull();
    expect(durable?.providerRecoveryPolicy).toBeDefined();

    // Persist with production's own path, digest and envelope writer; don't
    // duplicate private nativeSessionCheckpointPath/configDigest algorithms.
    provider.execute.mockImplementationOnce(async (options: RuntimeOptions) => {
      await options.onCheckpoint?.(checkpoint);
      return completed(f.prior);
    });
    await nativeExecutor.executePaperclipNativeSession({ db: f.dbFor(f.prior), execution: f.prior,
      runnerInstanceId: "db5-runner", backend: unusedBackend, useRunnerd: false, onUsage: async () => {} });
    const directory = join(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "sessions");
    const files = (await readdir(directory)).filter(name => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const envelopePath = join(directory, files[0]!);
    const envelope = JSON.parse(await readFile(envelopePath, "utf8"));
    expect(envelope).toMatchObject({ schema: "paperclip.native-session-supervisor.v1", snapshot: original });
    expect(envelope.snapshot).not.toHaveProperty("providerRecoveryPolicy");

    let warm: PersistedNativeSession | null | undefined;
    provider.execute.mockImplementationOnce(async (options: RuntimeOptions) => {
      warm = options.persistedSession;
      return completed(f.current);
    });
    await nativeExecutor.executePaperclipNativeSession({ db: f.dbFor(f.current), execution: f.current,
      runnerInstanceId: "db5-runner", backend: unusedBackend, useRunnerd: false,
      refreshTools, toolRefreshOnResume: true, onUsage: async () => {} });
    expect(provider.execute).toHaveBeenCalledTimes(2);
    // Prove this was a cross-run FILE rebind, not undefined persistedSession,
    // an in-memory retained session, or the durable controlPlane fallback.
    expect(warm).toMatchObject({ identity: { ...checkpoint.identity, runId: f.current.binding.runId },
      sessionId: checkpoint.sessionId, providerSessionId: checkpoint.providerSessionId,
      semanticResult: null, terminal: null, activeTurnId: null, terminalTurns: [], pendingRuntimeRequests: [] });
    expect(checkpoint).toEqual(original);
    expect(JSON.parse(await readFile(envelopePath, "utf8")).snapshot).toEqual(original);
    // RED on S1: received undefined; durable supplies a defined policy. D-B5
    // supplies the same policy here, including governed wait only without refresh.
    expect(warm?.providerRecoveryPolicy).toBe(durable!.providerRecoveryPolicy);
    // D-B6 KEEP control (RFL 10:40Z, row 3): this executor call records no new box
    // (no sandboxLeaseAcquisition 'created' on a remote sandbox target), so the warm
    // rebind keeps the prior run's cursor. D-B6 resets it only on a known new box.
    expect(warm?.cursor, "no recorded new allocation: the prior cursor is kept").toBe(checkpoint.cursor);
  });
});

describe("D-B5 RFL refreshTools caller trace", () => {
  it("(rt) exposes persisted unused-bootstrap selection's omitted flag (:658) versus executor's true flag (:660)", async () => {
    const f = fixture(home);
    const context = { refreshTools: true };
    f.run.contextSnapshot = context;
    const source = f.source(f.snapshot("yielded+response_wake"));
    const db = f.dbFor(f.current);
    const agent = { id: f.agentId, companyId: f.companyId, adapterType: "paperclip_runner", status: "running",
      adapterConfig: { provider: "codex", model: null }, runtimeConfig: {}, name: "DB5 trace" };
    const resolution = resolveHeartbeatNativeRuntimeMode({ persisted: f.run, enabled: true,
      runtimeConfig: {}, adapterConfig: agent.adapterConfig, agent, issue: f.issue, target: null, workspaceId: null });
    expect(resolution.kind).toBe("native");
    const selectionInput = {
      run: f.run, agent, nativeRuntimeResolution: resolution,
      task: { issueRef: f.issue, issueContext: null, context, executionContinuation: null,
        safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: null, acceptedPlanContinuationWake: false },
      session: { persistedNativeExecutionInput: f.current, persistedRunnerProfile: { nativeToolRefreshOnResume: true },
        taskResumeSessionId: f.sessionId, isFailedChatRunRetry: false, getFreshSessionHandoff: undefined },
      workspace: { persistedExecutionWorkspace: { id: f.current.binding.executionWorkspaceId },
        executionWorkspace: { ...f.current.workspace }, executionTarget: null, activeEnvironmentLease: null,
        isDotRun: false, projectRepositoryPaths: [] },
      config: { nativeLifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 }, runtimeConfig: {},
        runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null, agentIdentity: undefined,
        issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined },
      recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null },
      issuesSvc: { addComment: vi.fn() }, runtimeEnv: {}, onAdapterEvent: vi.fn(),
      onNativeLifecycleSelected: vi.fn(), onProviderResourceDisposition: vi.fn(),
      onNativeOwnershipHeld: vi.fn(), stopControllerLease: vi.fn(),
    } as unknown as HeartbeatRuntimeSelectionInput;
    vi.spyOn(nativeResume, "findNativeSessionResumeRun").mockResolvedValue(
      source as NonNullable<Awaited<ReturnType<typeof nativeResume.findNativeSessionResumeRun>>>,
    );
    const selectionReached = new Error("observed real persisted-selection rebind");
    const rebind = nativeResume.rebindNativeSessionCheckpoint;
    let selectedInput: Parameters<typeof rebind>[0] | undefined;
    let selectedCheckpoint: ReturnType<typeof rebind>;
    vi.spyOn(nativeResume, "rebindNativeSessionCheckpoint").mockImplementationOnce(input => {
      selectedInput = input;
      selectedCheckpoint = rebind(input);
      // Stop after the real rebind. This row is about caller wiring, not the
      // subsequent DB admission transaction, skill staging, or provider work.
      throw selectionReached;
    });
    await expect(selectHeartbeatRuntime(db, selectionInput)).rejects.toBe(selectionReached);
    expect(selectedInput?.currentExecution).toBe(f.current);
    expect(selectedInput?.refreshTools).toBeUndefined();
    expect(selectedInput?.toolRefreshOnResume).toBeUndefined();
    expect(selectedCheckpoint!).toMatchObject({ providerRecoveryPolicy: "allow_replacement_after_governed_wait" });

    const executionControl = createAdapterExecutionControl();
    const detached = new nativeExecutor.NativeControllerDetachedForRestartError();
    let executorInput: Parameters<typeof nativeExecutor.executePaperclipNativeSession>[0] | undefined;
    vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementationOnce(async input => {
      executorInput = input;
      // A typed early exit bypasses unrelated workspace/result finalization.
      throw detached;
    });
    const noop = async () => {};
    const executionInput = {
      run: f.run, agent, options: {},
      task: { issueRef: f.issue, issueContext: null, context, issueId: f.issueId,
        taskKey: null, executionContinuation: null },
      runtime: { nativeRuntimeResolution: resolution, nativeExecution: f.current,
        nativeRunnerInstanceId: "db5-runner", adapter: {}, runtimeForAdapter: {},
        getNativeFreshSessionHandoff: undefined, getFreshSessionHandoff: undefined,
        toolRefreshOnResume: true, runOptions: {} },
      workspace: { persistedExecutionWorkspace: null, executionWorkspace: { ...f.current.workspace },
        executionTarget: null, nativeWorkspaceSync: null, workspaceOperationRecorder: {}, remoteExecution: null },
      config: { runtimeConfig: {}, resolvedConfig: {}, configuredTaskEnvironment: {}, adapterEnv: {},
        runtimeEnv: {}, useHostGitHub: false, githubSelection: { configured: false } },
      session: { runtimeSessionParamsForAdapter: null, configuredModel: null, sessionConfigMetadata: null,
        goalCheckpointSession: { current: null } },
      instructions: { instructionCopy: null, nativeInstructionWorkingCopy: () => undefined,
        collectStoppedInstructions: noop, releaseInstructionCopy: noop, nativeInstructionReservation: null },
      trace: { providerTraceCapture: null, nativeRunnerPreparationSpans: [], attestedQuestionResponseAtMs: null,
        attemptStartedAtMs: Date.now(), environmentAcquireStartedAtMs: Date.now(), environmentRealizeEndedAtMs: Date.now() },
      control: { executionControl, executionPhaseContext: { onExecutionPhase: executionControl.phases.enter },
        dispatchResolvedInteractionContinuationWithAtomicGate: async (dispatch: (mark: () => void) => Promise<unknown>) =>
          ({ dispatched: true, resultPromise: dispatch(() => {}) }) },
      output: { identityRedactor: createAgentIdentityRedactor(), appendIdentityRedactedLog: noop,
        onLog: noop, onAdapterEvent: noop, onAdapterMeta: noop },
      services: {}, effects: { onUsageCaptureReady: () => {}, onNativeDispatchStarted: () => {},
        onNativeSessionResumeScheduled: () => {} },
    } as unknown as HeartbeatRuntimeExecutionInput;
    await expect(executeHeartbeatRuntime(db, executionInput)).rejects.toBe(detached);
    executionControl.finish();
    expect(executorInput?.execution).toBe(f.current);
    expect(executorInput?.runContextSnapshot).toBe(selectionInput.task.context);
    expect(executorInput?.refreshTools).toBe(true);
    expect(executorInput?.refreshTools).not.toBe(selectedInput?.refreshTools);
    // Show why the missing flag matters for precisely this same prior state.
    const withExecutorFlag = rebind({ ...selectedInput!, refreshTools: executorInput!.refreshTools,
      toolRefreshOnResume: true });
    expect(withExecutorFlag).toMatchObject({ providerRecoveryPolicy: "allow_replacement_after_resume_failure" });
  });
});
