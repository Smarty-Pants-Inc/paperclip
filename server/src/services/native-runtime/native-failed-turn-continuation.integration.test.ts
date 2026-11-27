import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueComments, issueAttachments, assets, issues, nativeRunFinalizations, statusDecisions } from "@paperclipai/db";
import { buildNativeModelEnvelope, executeNativeSession, HarnessDriverBackend, type PersistedNativeSession, type NativeSession, type ControlPlanePort, type NativeExecutionInputV1, type PrpEvent, type PrpTerminalState } from "@paperclipai/paperclip-runner";
import { CodexAcpxDriver } from "../../../../packages/paperclip-runner/dist/drivers/acpx/codex-acpx-driver.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { readNativeContinuationSource } from "./native-continuation-delivery.js";
import { NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } from "./status-arbiter.js";
import { heartbeatService } from "../heartbeat.js";
import { requestTaskRetry } from "../task-retry.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { buildPaperclipWakePayload } from "../heartbeat/run-preparation.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeExecutionWithCheckpoint, nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

type FailureCode = "opencode_server_exited" | "opencode_empty_response";

/** Exercise real Runner checkpointing + HarnessDriverBackend + Pi driver recovery.
 * Only the ACP host transport is controlled; no model or credentials are used.
 */
function piRecoveryProbe(sessionId: string, submissions: string[]) {
  let recoveries = 0;
  const driver = new CodexAcpxDriver({ agent: "pi", runtimeDirectory: "/tmp", model: "fixture/model",
    permissionMode: "approve-reads", providerPolicy: { readOnly: true } }, {
    async readRecoveryWorkspace() { recoveries++; return { path: "/tmp", assertHeld() {}, async close() {} }; },
    async openHost(options) {
      const identity = {
        schema: "paperclip.runner.acpx-identity.v2" as const, normalizedSessionId: sessionId,
        acpxRecordId: "record-proof", backendSessionId: "saved-provider-conversation", agentSessionId: "saved-provider-conversation",
        profileDigest: `sha256:${"a".repeat(64)}`, workspaceDigest: `sha256:${"b".repeat(64)}`,
        requestedModel: "fixture/model", effectiveModel: "fixture/model", permissionMode: "approve-reads" as const,
        providerLifetimeFenceCandidates: [60_001, 60_002, 60_003] as const,
      };
      if (options.expectedIdentity) expect(options.expectedIdentity).toEqual(expect.objectContaining({
        backendSessionId: identity.backendSessionId, normalizedSessionId: sessionId,
      }));
      return {
        identity: () => identity,
        binding: () => ({ normalizedSessionId: sessionId, workspacePath: "/tmp", workspaceDigest: identity.workspaceDigest,
          runtimeRoot: "/tmp", commandDigest: `sha256:${"c".repeat(64)}`, profileDigest: identity.profileDigest,
          requestedModel: "fixture/model", effectiveModel: "fixture/model", permissionMode: "approve-reads" as const,
          profileSessionKey: "paperclip-proof" }),
        async status() { return { agentSessionId: "saved-provider-conversation", models: { currentModelId: "fixture/model", availableModelIds: ["fixture/model"] } }; },
        startTurn(turn) { submissions.push(turn.text); throw new Error("proof stops at provider submission"); },
        async interruptActiveTurn() {}, async close() {},
      };
    },
  });
  const backend = new HarnessDriverBackend(driver);
  const descriptor = backend.descriptor.bind(backend);
  // Runtime-context realization is outside this controlled transport probe.
  backend.descriptor = async () => ({ ...await descriptor(),
    runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } });
  return { backend, submissions, recoveries: () => recoveries };
}

function probeControlPlane(onCheckpoint?: (snapshot: PersistedNativeSession) => void): ControlPlanePort {
  return { async openRun() {}, async checkpointSession(snapshot) { onCheckpoint?.(snapshot); }, async completeRun() {},
    async appendEvent(event) { const seq = "sourceSeq" in event ? event.sourceSeq : 1;
      return { cursor: seq, highestContiguousSourceSeq: seq, disposition: "committed" }; },
    async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } };
}

// Seen on a staging deployment: an OpenCode turn
// failed (its server was killed, or it ended without an answer). The accepted
// result kept the task in_progress and the arbiter scheduled a retry, but the
// dispatcher refused that wake (`chat_control_recovery_proof_unresolved`), so
// the task sat for hours with no owner and no queued work.
describe("native failed-turn continuation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-failed-turn-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native failed turn", issuePrefix: "NFT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "OpenCode agent", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "openrouter/test-model" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function failTurn(issueId: string, code: FailureCode, context: Record<string, unknown> = {}, dispatchedFrom?: string, nativeProvider?: "pi_rpc" | "codex", beforeSubmit = false, unseenInput = false) {
    const runId = randomUUID();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // A dispatched continuation carries the dispatcher's own receipt for its intent.
    const [receipt] = dispatchedFrom ? await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "issue_status_changed", status: "claimed", requestedByActorType: "system",
      requestedByActorId: `native-status-wake-dispatch:${dispatchedFrom}`, payload: { issueId } }).returning() : [];
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "automation", triggerDetail: "system", wakeupRequestId: receipt?.id ?? null, contextSnapshot: { issueId, ...context } }).returning();
    if (receipt) await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receipt.id));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Review the PR.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
      interactionResponses: [], credentialBindings: [],
    };
    const nativeExecution = nativeProvider ? buildNativeExecutionInput({
      companyId, agentId, runId, issue, taskPrompt: issue.description ?? issue.title,
      provider: nativeProvider, model: "fixture/model", normalizedSessionId: native.normalizedSessionId,
      wakePayload: await buildPaperclipWakePayload({ db, companyId, agentId, runId, contextSnapshot: { issueId, ...context } }),
      workspace: { id: "retry-workspace", cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      runtimeContext: nativeRuntimeContextFixture(), completionContract: execution.completionContract,
    }) : execution;
    let savedCheckpoint: PersistedNativeSession | undefined;
    if (beforeSubmit) {
      const probe = piRecoveryProbe(nativeExecution.session.normalizedSessionId!, []);
      await expect(executeNativeSession({ input: nativeExecution, backend: probe.backend,
        controlPlane: probeControlPlane(snapshot => { savedCheckpoint = snapshot; }),
        prepareWakeAttachmentPrompt: async () => { throw new Error("attachment preparation failed before submission"); },
        runnerInstanceId: "pre-submit-proof", controlPlaneInstanceId: "pre-submit-control", timeoutMs: 5_000,
        requireSessionCloseBeforeReturn: true,
      })).rejects.toThrow("attachment preparation failed before submission");
      expect(savedCheckpoint?.activeTurnId).toBeNull();
      expect(probe.submissions).toHaveLength(0);
      expect(savedCheckpoint?.providerSessionId).toBe("saved-provider-conversation");
    }
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: nativeExecution,
      ...(savedCheckpoint ? { sessionCheckpoint: savedCheckpoint,
        nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local", nativeProvider) } : {}) } }).where(eq(heartbeatRuns.id, runId));
    // The person writes while this run is still running, after its immutable
    // input/coverage was saved and before the failure schedules its retry.
    const [unseenComment] = unseenInput ? await db.insert(issueComments).values({ companyId, issueId,
      authorUserId: "board-user", body: "Unseen direction: inspect the new requirement before finishing." }).returning() : [];
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "turn-terminal", sourceSeq: 1,
      sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: nativeProvider
        ? { status: "failed", error: { message: `${nativeProvider} stopped while the turn was running.` } }
        : code === "opencode_server_exited"
        ? { status: "failed", error: { code, message: "OpenCode stopped while the turn was running.", opencodeFailure: { kind: "server_exited", signal: "SIGKILL", connectionError: "ECONNREFUSED" } } }
        : { status: "failed", error: { code, message: "OpenCode ended without a final answer.", retryable: false } },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
    const openInput = { identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock" as const, sourceInstanceId: native.runnerInstanceId };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun(openInput);
      if (nativeProvider && !beforeSubmit) await options.controlPlane.appendEvent({ ...event,
        sourceEventId: "submitted-turn", sourceSeq: 1, eventType: "turn.started", payload: { status: "inProgress" } });
      await options.controlPlane.appendEvent({ ...event, sourceSeq: nativeProvider && !beforeSubmit ? 2 : 1 });
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-provider-session", driverKind: nativeExecution.session.driverKind, driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    await executePaperclipNativeSession({ db, execution: nativeExecution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(failedRun.status).toBe("failed");
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    return { runId, decision, execution: nativeExecution, failedRun, savedCheckpoint, unseenCommentId: unseenComment?.id };
  }

  const issueWakes = async (issueId: string) => (await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId);

  it.each(["opencode_server_exited", "opencode_empty_response"] as const)("continues the task once after %s, then hands it to Retry", async (code) => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Review a PR", status: "in_progress", workMode: "standard", assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const first = await failTurn(issueId, code);
    expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");

    const heartbeat = heartbeatService(db);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId })).toMatchObject({ dispatched: 1 });
    const wakes = await issueWakes(issueId);
    expect(wakes.filter(wake => wake.status === "skipped")).toEqual([]);
    const intent = wakes.find(wake => wake.requestedByActorId === "native-status-committer")!;
    expect(intent.payload).toMatchObject({ retryCause: "native_run_failed" });
    const [continuation] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(r => r.id !== first.runId && r.contextSnapshot?.issueId === issueId);
    expect(continuation?.contextSnapshot?.nativeStatusWakeIntentId).toBe(intent.id);
    expect(["queued", "running"]).toContain(continuation.status);
    // The continuation keeps the failed run as its conversation source.
    expect(await readNativeContinuationSource(db, { companyId, issueId, runId: continuation.id })).toBe(first.runId);
    // The fixture cannot launch a real runner; let the dispatched run settle.
    await heartbeat.drainActiveRunExecutions();
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.assigneeAgentId).toBe(agentId);

    // The continuation's own turn fails the same way: no second automatic
    // wake, and a board blocker whose Retry restarts the work.
    await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const before = (await issueWakes(issueId)).length;
    const second = await failTurn(issueId, code, { nativeStatusWakeIntentId: intent.id }, intent.id);
    expect(second.decision).toMatchObject({ reasonCode: "native_run_failed_continuation_exhausted", toStatus: "blocked" });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect((await issueWakes(issueId)).length).toBe(before + 1); // only the fixture dispatch receipt
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(blocked).toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board", action: NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } });
    // The visible Retry is accepted and starts a new run of the task.
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "board-user", actorSource: "session",
      idempotencyKey: randomUUID(), observedRunId: second.runId });
    expect(receipt).toMatchObject({ accepted: true, stale: false });
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const retried = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(r => r.contextSnapshot?.issueId === issueId && r.contextSnapshot?.taskRetryRequestId === receipt.requestId);
    expect(retried).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);

  it.each([
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: false },
    { nativeProvider: "codex" as const, beforeSubmit: false, unseenInput: false },
    { nativeProvider: "pi_rpc" as const, beforeSubmit: true, unseenInput: false },
    { nativeProvider: "pi_rpc" as const, beforeSubmit: false, unseenInput: true },
  ])("stock failed-run retry $nativeProvider beforeSubmit=$beforeSubmit unseenInput=$unseenInput", async ({ nativeProvider, beforeSubmit, unseenInput }) => {
    const issueId = randomUUID();
    const taskText = "RETRY_TASK_MUST_SURVIVE_FRESH_BOOTSTRAP: inspect and finish the assigned work.";
    await db.update(agents).set({ adapterConfig: { provider: nativeProvider, model: "fixture/model" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Continue the real failed run",
      description: taskText, status: "in_progress", workMode: "standard", assigneeAgentId: agentId,
      responsibleUserId: "board-user" }).returning();
    await db.insert(issueComments).values(Array.from({ length: 10 }, (_, i) => ({ companyId, issueId,
      authorAgentId: agentId, body: `Prior reply ${i}: ${"saved work ".repeat(300)}` })));
    const baseline = await buildExecutionContinuation({ db, companyId, issueId, agentId, context: {}, summary: null, exposeLowTrustRaw: false });
    const first = await failTurn(issueId, "opencode_empty_response", { executionContinuation: baseline }, undefined, nativeProvider, beforeSubmit, unseenInput);
    // Occupy the real agent's execution slot: dispatch the stock wake through PG,
    // but stop before a paid provider transport. All prompt builders stay real.
    const [blocker] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: {} }).returning();
    const heartbeat = heartbeatService(db);
    let retryRunId: string | undefined;
    try {
      expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
      expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId })).toMatchObject({ dispatched: 1 });
      const [retry] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .filter(run => run.id !== first.runId && run.contextSnapshot?.issueId === issueId);
      retryRunId = retry.id;
      expect(retry.status).toBe("queued");
      expect(await readNativeContinuationSource(db, { companyId, issueId, runId: retry.id })).toBe(first.runId);
      const context = { ...retry.contextSnapshot, executionContinuation: await buildExecutionContinuation({
        db, companyId, issueId, agentId, runId: retry.id, context: retry.contextSnapshot!, previousContextRunId: first.runId,
        summary: null, exposeLowTrustRaw: false }) };
      const wakePayload = await buildPaperclipWakePayload({ db, companyId, agentId, runId: retry.id, contextSnapshot: context });
      const sessionId = first.execution.session.normalizedSessionId!;
      const args = { companyId, agentId, runId: retry.id, issue, taskPrompt: taskText,
        provider: nativeProvider, model: "fixture/model", wakePayload,
        previousTurn: { runId: first.runId, task: issue, nativeExecutionInput: first.execution },
        workspace: { id: "retry-workspace", cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
        runtimeContext: nativeRuntimeContextFixture(), completionContract: first.execution.completionContract };
      const checkpoint = { backendKind: "runner", driverKind: first.execution.session.driverKind,
        sessionId: "saved-provider-conversation", providerSessionId: "saved-provider-conversation",
        identity: { runId: first.runId, sessionId, companyId, issueId, agentId } };
      const source = { ...first.failedRun, runnerProfileJson: { nativeExecutionInput: first.execution,
        nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local", nativeProvider), sessionCheckpoint: first.savedCheckpoint ?? checkpoint } };
      const buildExecution = (options: { normalizedSessionId: string; resumedSession: boolean }) => buildNativeExecutionInput({ ...args, ...options });
      const retained = buildNativeExecutionWithCheckpoint({ previousRun: source, normalizedSessionId: sessionId, buildExecution });
      expect(retained.normalizedSessionId).toBe(sessionId);
      expect(retained.checkpoint?.providerSessionId).toBe("saved-provider-conversation");
      const warm = buildNativeModelEnvelope(retained.execution, { resumedSession: true });
      const replacement = buildNativeModelEnvelope(retained.execution);
      expect(replacement.task.prompt).toContain(taskText);
      expect(Buffer.byteLength(JSON.stringify(replacement))).toBeGreaterThan(30_000);
      const measurements = { proof: beforeSubmit ? "F-before-submit" : unseenInput ? "D-unseen-person-delta" : "stock-retry-prompt", nativeProvider, failedRunId: first.runId, retryRunId: retry.id,
        sessionId, retainedSessionId: retained.normalizedSessionId, warmSchema: warm.schema,
        warmChars: JSON.stringify(warm).length, replacementChars: JSON.stringify(replacement).length,
        warmBytes: Buffer.byteLength(JSON.stringify(warm)), replacementBytes: Buffer.byteLength(JSON.stringify(replacement)),
        prompt: "events" in warm ? warm.events : null };
      process.stdout.write(JSON.stringify(measurements) + "\n");
      for (const failure of ["selection_reset", "missing_checkpoint", "unrebindable_checkpoint", "box_unavailable"] as const) {
        const unavailable = { ...source, ...(failure === "box_unavailable" ? { errorCode: "native_provider_state_incompatible" } : {}),
          runnerProfileJson: { ...source.runnerProfileJson,
            sessionCheckpoint: failure === "missing_checkpoint" ? null : failure === "unrebindable_checkpoint" ? { ...checkpoint, identity: {} } : checkpoint } };
        const fresh = buildNativeExecutionWithCheckpoint({ previousRun: failure === "selection_reset" ? null : unavailable, normalizedSessionId: sessionId, buildExecution });
        expect(fresh.checkpoint).toBeNull();
        expect(fresh.normalizedSessionId).not.toBe(sessionId);
        const envelope = buildNativeModelEnvelope(fresh.execution);
        expect(envelope.task.prompt).toContain(taskText);
        expect("continuationPrompt" in fresh.execution && fresh.execution.continuationPrompt).toBeFalsy();
        process.stdout.write(JSON.stringify({ proof: "stock-retry-fresh", nativeProvider, failure, retryRunId: retry.id,
          newSessionId: fresh.normalizedSessionId, chars: JSON.stringify(envelope).length,
          bytes: Buffer.byteLength(JSON.stringify(envelope)), taskPresent: envelope.task.prompt.includes(taskText) }) + "\n");
      }
      if (beforeSubmit) {
        // No recoverSession stub: both the native adapter and concrete Pi ACPX
        // driver's validation/workspace/identity recovery execute here.
        const sent: string[] = [];
        const probe = piRecoveryProbe(sessionId, sent);
        await expect(executeNativeSession({ input: retained.execution,
          // The concrete ACPX driver admits only same-session recovery. Tighten
          // the server's replacement permission; never replace in this row.
          persistedSession: { ...retained.checkpoint!, providerRecoveryPolicy: "same_session_only" },
          backend: probe.backend, controlPlane: probeControlPlane(), runnerInstanceId: "retry-proof",
          controlPlaneInstanceId: "retry-proof-control", timeoutMs: 5_000, requireSessionCloseBeforeReturn: true,
        })).rejects.toThrow("proof stops at provider submission");
        expect(probe.recoveries()).toBe(1);
        expect(sent).toHaveLength(1);
        process.stdout.write(JSON.stringify({ proof: "F-real-Pi-recovery", failedRunId: first.runId, retryRunId: retry.id,
          recoveries: probe.recoveries(), bytes: Buffer.byteLength(sent[0]), taskPresent: sent[0].includes(taskText) }) + "\n");
        expect(sent[0]).toContain(taskText);
        expect(JSON.parse(sent[0]).schema).toBe("paperclip.native-model-envelope.v3");
      }
      if (nativeProvider === "pi_rpc" && !beforeSubmit) for (const resumed of [false, true]) {
        const identity = { runId: retry.id, sessionId, companyId, issueId, agentId };
        const providerSessionId = resumed ? "saved-provider-conversation" : "replacement-provider";
        const sent: string[] = [];
        const replacementSession: NativeSession = {
          identity: () => identity,
          async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() {},
          async startTurn(turn) { sent.push(turn.message.text); throw new Error("proof stops after turn.start"); },
          async result() { return null; },
          async snapshot() { return { backendKind: "runner", sessionId: providerSessionId, providerSessionId,
            identity, cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }; },
          async close() {},
        };
        let replacementOpened = false;
        await expect(executeNativeSession({
          input: retained.execution, persistedSession: retained.checkpoint!,
          backend: {
            async descriptor() { return { kind: "runner", name: "retry-proof", version: "1", capabilities: await replacementSession.capabilities(),
              runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
            async openSession() { throw new Error("expected the replacement hook"); },
            async recoverSession() { return resumed ? { recovered: true, session: replacementSession }
              : { recovered: false, reason: "saved box cannot be resumed" }; },
            async openReplacementSession() { replacementOpened = true; return replacementSession; },
          },
          controlPlane: { async openRun() {}, async checkpointSession() {}, async completeRun() {},
            async appendEvent(event) { const seq = "sourceSeq" in event ? event.sourceSeq : 1;
              return { cursor: seq, highestContiguousSourceSeq: seq, disposition: "committed" }; },
            async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } },
          getFreshSessionHandoff: async () => "FULL_FRESH_HANDOVER",
          runnerInstanceId: "retry-proof", controlPlaneInstanceId: "retry-proof-control", timeoutMs: 5_000,
          requireSessionCloseBeforeReturn: true,
        })).rejects.toThrow("proof stops after turn.start");
        expect(replacementOpened).toBe(!resumed);
        expect(sent).toHaveLength(1);
        const actual = JSON.parse(sent[0]);
        if (resumed) {
          expect(actual).toEqual(warm);
          if (unseenInput) {
            expect(sent[0]).toContain("Unseen direction: inspect the new requirement before finishing.");
            expect(sent[0].match(/Unseen direction/g)).toHaveLength(1);
            expect(sent[0]).not.toContain(taskText);
            expect(sent[0]).not.toContain("Prior reply");
          }
        }
        else {
          expect(actual.schema).toBe("paperclip.native-model-envelope.v3");
          expect(actual.task.prompt).toContain(taskText);
          expect(actual.task.prompt).toContain("FULL_FRESH_HANDOVER");
        }
        process.stdout.write(JSON.stringify({ proof: resumed ? "runner-retained" : "runner-replacement", retryRunId: retry.id,
          previousProviderSessionId: "saved-provider-conversation", newProviderSessionId: providerSessionId,
          chars: sent[0].length, bytes: Buffer.byteLength(sent[0]),
          taskPresent: sent[0].includes(taskText), handoverPresent: sent[0].includes("FULL_FRESH_HANDOVER") }) + "\n");
      }
      if (nativeProvider === "pi_rpc" && !beforeSubmit) {
        const guardedWakes = [
          { ...wakePayload, nativeStatusRetry: null },
          { ...wakePayload, nativeStatusRetry: { cause: "native_run_failed", summary: "Retry", sourceRunId: randomUUID() } },
          { ...wakePayload, truncated: true }, { ...wakePayload, fallbackFetchNeeded: true },
          { ...wakePayload, attachmentOmissions: [{}] }, { ...wakePayload, extraContext: "New context" },
          { ...wakePayload, mcpAppContext: "New selection" }, { ...wakePayload, chatCompletionUpdates: [{}] },
          { ...wakePayload, executionContinuation: { ...context.executionContinuation, resumeDelta: undefined } },
          { ...wakePayload, executionContinuation: { ...context.executionContinuation,
            resumeDelta: { baseRunId: randomUUID(), messages: [] } } },
          { ...wakePayload, nativeStatusRetry: { ...(wakePayload as Record<string, unknown>).nativeStatusRetry as object, turnSubmitted: false } },
        ];
        for (const guarded of guardedWakes) {
          const input = buildNativeExecutionInput({ ...args, normalizedSessionId: sessionId, resumedSession: true, wakePayload: guarded });
          expect(JSON.stringify(buildNativeModelEnvelope(input, { resumedSession: true }))).toContain(taskText);
        }
        for (const overrides of [{ sessionContinuity: "paperclip" }, { resumedSession: false }, { previousTurn: null }, { issue: { ...issue, title: "Changed task" } }, { provider: "codex" as const, sessionContinuity: "continuous" }]) {
          const input = buildNativeExecutionInput({ ...args, normalizedSessionId: sessionId, resumedSession: true, ...overrides });
          expect(JSON.stringify(buildNativeModelEnvelope(input, { resumedSession: true }))).toContain(taskText);
        }
        process.stdout.write(JSON.stringify({ proof: "retry-guards", retryRunId: retry.id, fullTaskControls: guardedWakes.length + 5 }) + "\n");
      }
      // The standard task's person-comment delta stays byte-for-byte unchanged.
      // continued-session.test.ts also retains the exact bare-chat-body controls.
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "board-user", body: "Please continue exactly here." }).returning();
      for (const conversationMode of [false, true]) {
        const commentContext = { issueId, conversationMode, wakeReason: "issue_commented", wakeCommentId: comment.id,
          executionContinuation: await buildExecutionContinuation({ db, companyId, issueId, agentId,
            context: { wakeReason: "issue_commented", wakeCommentId: comment.id }, previousContextRunId: first.runId, summary: null, exposeLowTrustRaw: false }) };
        const personWake = await buildPaperclipWakePayload({ db, companyId, agentId, contextSnapshot: commentContext, retainFullCommentBodies: true });
        const person = buildNativeExecutionInput({ ...args, conversationMode, normalizedSessionId: sessionId, resumedSession: true, wakePayload: personWake });
        expect(person.continuationPrompt).toBe(nativeProvider === "codex" && conversationMode ? undefined
          : JSON.stringify({ messages: commentContext.executionContinuation!.resumeDelta!.messages }));
        process.stdout.write(JSON.stringify({ proof: "person-comment-control", nativeProvider, conversationMode, prompt: person.continuationPrompt }) + "\n");
      }
      if (nativeProvider === "pi_rpc" && !beforeSubmit) {
        expect(Buffer.byteLength(JSON.stringify(warm))).toBeLessThan(1_000);
        expect(warm.schema).toBe("paperclip.native-continuation.v1");
        expect("events" in warm && warm.events).toContain("automatic retry");
        expect("events" in warm && warm.events).toContain("Status: in_progress");
        expect("events" in warm && warm.events).toContain("pi_rpc stopped while the turn was running.");
        expect("events" in warm && warm.events).not.toContain("without opening a second provider session");
        expect(JSON.stringify(warm)).not.toContain(taskText);
      } else {
        expect(warm.schema).not.toBe("paperclip.native-continuation.v1");
        expect(JSON.stringify(warm)).toContain(taskText);
      }
      if (unseenInput) {
        // Delta messages deliberately omit file descriptors. Even when the
        // status wake has no commentIds, their attachments must fence compact
        // plain-text projection rather than silently disappearing.
        const [asset] = await db.insert(assets).values({ companyId, provider: "local_disk", objectKey: `retry-proof/${randomUUID()}`,
          contentType: "text/plain", byteSize: 1, sha256: "a".repeat(64), originalFilename: "new-direction.txt" }).returning();
        await db.insert(issueAttachments).values({ companyId, issueId, issueCommentId: first.unseenCommentId!, assetId: asset.id });
        const attachedWake = await buildPaperclipWakePayload({ db, companyId, agentId, runId: retry.id, contextSnapshot: context });
        const attached = buildNativeExecutionInput({ ...args, normalizedSessionId: sessionId, resumedSession: true, wakePayload: attachedWake });
        const envelope = buildNativeModelEnvelope(attached, { resumedSession: true });
        expect(attached.continuationPrompt).toBeFalsy();
        expect(JSON.stringify(envelope)).toContain(taskText);
        process.stdout.write(JSON.stringify({ proof: "D-attached-delta-full", retryRunId: retry.id,
          bytes: Buffer.byteLength(JSON.stringify(envelope)), taskPresent: true }) + "\n");
      }
    } finally {
      if (retryRunId) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, retryRunId));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
      await heartbeat.drainActiveRunExecutions();
      await db.update(agents).set({ adapterConfig: { provider: "opencode", model: "openrouter/test-model" }, runtimeConfig: {} }).where(eq(agents.id, agentId));
    }
  }, 120_000);

  it("does not treat a copied retry intent id as a used continuation", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Review another PR", status: "in_progress", workMode: "standard", assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    const first = await failTurn(issueId, "opencode_empty_response");
    expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
    const intent = (await issueWakes(issueId)).find(wake => wake.requestedByActorId === "native-status-committer")!;
    // A real intent id copied into a run that the dispatcher did not start.
    await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const copied = await failTurn(issueId, "opencode_empty_response", { nativeStatusWakeIntentId: intent.id });
    expect(copied.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
  }, 120_000);
});
