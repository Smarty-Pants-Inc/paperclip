import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, companyMemberships, agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { readPersistedNativeFailureEvidence } from "./native-provider-failure-evidence.js";
import { parseNativeExecutionInput, QUALIFIED_PI_RPC_PROFILE } from "../../vendor/paperclip-runner/index.js";
import { classifyContinuationFailure } from "../recovery/service.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";
import { recordTaskStopPending } from "../recovery/stop-pending.js";
import { heartbeatService, MAX_TURN_CONTINUATION_RETRY_REASON } from "../heartbeat.js";
import { canContinueRecoveryRunAutomatically, continuationCauseIsSystemOwnedSql } from "../continuation-cause.js";
import { ensureFreshContinuation, continueHeldExecutions } from "../fresh-continuation-fallback.js";
import { sql } from "drizzle-orm";

// KEEP: never-OK guard against automatically repeating a provider policy refusal.
// Inject at the real bound runner event port, not at a mocked classifier.
const POLICY_NOTE = "The model provider refused this request under its policies; it won't be retried automatically.";
const usagePolicyError = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your request was blocked by our usage policy."},"request_id":"fixture-request"}';

describe("Pi policy refusal: persistence, retry, unanswered message and Stop intent", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-policy-refusal-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Refusal regression", issuePrefix: "RFL" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "anthropic/fixture-model" } });
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function failTurn(message: string, code = "pi_provider_error", details: Record<string, unknown> = {}) {
    const issueId = randomUUID(), runId = randomUUID(), userId = `fixture-user-${randomUUID()}`;
    await db.insert(authUsers).values({id:userId,name:'Judge owner',email:`${userId}@example.invalid`,createdAt:new Date(),updatedAt:new Date()});
    await db.insert(companyMemberships).values({companyId,principalType:'user',principalId:userId,membershipRole:'owner'});
    const before = new Date(Date.now() - 900_000);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "A harmless chat message", status: "in_progress", workMode: "standard", assigneeAgentId: agentId,
      responsibleUserId:userId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, body: "Please summarize the saved notes.", authorType: "user", authorUserId: userId, createdAt: before }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      responsibleUserId:userId, invocationSource: "automation", triggerDetail: "system", createdAt: new Date(before.getTime() + 1_000), contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: comment.id } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "pi_rpc", model: "anthropic/fixture-model", profile: QUALIFIED_PI_RPC_PROFILE },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Please summarize the saved notes.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput }, interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    // Pi 1.5.2 message_end {message: {role:"assistant", stopReason:"error", errorMessage}}
    // -> TS driver turn.failed -> RPC turn/failed -> Rust provider_events PRP.
    // Rust reuses the Codex-compatible terminal normalizer, then relabels
    // the event to pi_rpc. Authority still comes from pinned execution identity.
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId, sourceEventId: "pi-terminal", sourceSeq: 2, sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { provider: "pi_rpc", providerTurnId: "fixture-pi-turn", status: "failed", error: { code, message, ...details } },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const, completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      // OUTPUT-side refusals can follow reasoning. Partial reasoning is not an
      // answer and must not suppress the truthful refusal note or permit retry.
      await options.controlPlane.appendEvent({ ...event, sourceEventId: "pi-reasoning", sourceSeq: 1,
        eventType: "item.completed", itemId: "pi-thought", emittedAt: new Date(Date.now() - 97_000).toISOString(),
        payload: { provider: "pi_rpc", kind: "reasoning", text: "Partial reasoning, not a final answer." } });
      await options.controlPlane.appendEvent(event);
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-provider-session", driverKind: execution.session.driverKind, driverVersion: "fixture", nativeEventCount: 2, highestContiguousSourceSeq: 2, usage: null };
    });
    const adapter = await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId,
      backend: { descriptor: async () => { throw new Error("No provider call"); }, openSession: async () => { throw new Error("No provider call"); } } });
    expect(() => parseNativeExecutionInput(execution)).not.toThrow();
    const [beforeFinalize] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const persistedFailure = await readPersistedNativeFailureEvidence(db, beforeFinalize, native.turnId, terminal);
    // Deliberately do not save adapter metadata: recovery after restart must
    // reclassify the accepted, hash-checked persisted runner event itself.
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    await db.update(heartbeatRuns).set({ finishedAt: before, updatedAt: before }).where(eq(heartbeatRuns.id, runId));
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).filter(w => w.payload?.issueId === issueId);
    const notes = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    return { issueId, runId, failedRun, decision, wakes, adapter, notes, persistedFailure };
  }

  it.each([
    [usagePolicyError, "pi_provider_error", {}],
    // Exact live texts: N23c already classified; 021eddf2 must not spawn 77f318d4.
    ["This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.", "pi_provider_error", {}],
    ["blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs", "pi_provider_error", {}],
    ["The request was declined.", "pi_provider_error", { stop_details: { category: "reasoning_extraction" } }],
    ["The model refused to complete the request", "pi_provider_error", {}],
    ["This request would violate our usage policy.", "pi_provider_error", {}],
    ["The request was declined.", "provider_policy_refusal", {}],
  ])("one true note and no retry for %s", async (message, code, details) => {
    const f = await failTurn(message, code, details);
    const at = Date.now();
    for (const offset of [0, 180_000, 360_000]) await settleUnansweredPersonMessage(db, { companyId, issueId: f.issueId, now: new Date(at + offset) });
    for (let pass = 0; pass < 2; pass++) await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId });
    const fresh = await ensureFreshContinuation(db, {companyId, runId:f.runId, trigger:"recovery_refused"});
    console.log("JUDGE_FRESH", JSON.stringify({message,runId:f.runId,fresh}));
    expect.soft(fresh).toMatchObject({kind:"person_owned",reason:"provider_policy_refusal"});
    await continueHeldExecutions(db);
    const hb = heartbeatService(db);
    await hb.scanSilentActiveRuns({companyId});
    await hb.reconcileTaskWatchdogs({companyId,runId:f.runId});
    const notes = await f.notes();
    console.log("REFUSAL_EVIDENCE", JSON.stringify({ runId: f.runId, errorCode: f.failedRun.errorCode, error: f.failedRun.error, adapterErrorCode: f.adapter.errorCode,
      decision: f.decision.reasonCode, wakes: f.wakes.map(w => ({ status: w.status, payload: w.payload })), notes: notes.map(n => ({ body: n.body, metadata: n.metadata })) }));
    expect.soft(f.failedRun).toMatchObject({ status: "failed", errorCode: "provider_policy_refusal", error: POLICY_NOTE });
    expect.soft(f.adapter.errorCode).toBe("provider_policy_refusal");
    expect.soft(f.persistedFailure.providerFailure?.errorCode).toBe("provider_policy_refusal");
    expect.soft(f.wakes).toHaveLength(0);
    const recoveryRun = { ...f.failedRun, retryOfRunId: randomUUID() };
    expect.soft(canContinueRecoveryRunAutomatically(recoveryRun)).toBe(false);
    const eligibility = await db.execute(sql`select ${continuationCauseIsSystemOwnedSql("source")} as eligible from ${heartbeatRuns} source where source.id = ${f.runId}`);
    expect.soft(eligibility[0]?.eligible).toBe(false);
    expect.soft((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter(w => w.payload?.issueId === f.issueId)).toHaveLength(0);
    expect.soft(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId)))
      .toEqual([{ id: f.runId }]);
    expect.soft(classifyContinuationFailure(f.failedRun)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect.soft(notes.map(n => n.body)).toEqual([POLICY_NOTE]);
    expect.soft(JSON.stringify(notes)).not.toMatch(/Sending it again|Send (?:the|a new) message|send it again/i);
    expect.soft(f.failedRun.resultJson?.nativeProviderFailure).toEqual({ provider: "pi_rpc", category: "policy_refusal" });
    // A failed policy response is NOT Stop intent, nor proof of process exit.
    // Exercise the shared card writer: it must preserve all execution claims.
    const [claimsBefore] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      await recordTaskStopPending(tx as unknown as typeof db, { companyId, issueId: f.issueId, runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []);
    });
    expect.soft(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(0);
    const [claimsAfter] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect.soft(claimsAfter).toMatchObject({ executionRunId: claimsBefore.executionRunId, checkoutRunId: claimsBefore.checkoutRunId });
  });


  it.each([
    "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.",
    "blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs"
  ].flatMap(message => [{message,lane:'transient'}, {message,lane:'cap'}]))("direct bounded successor refuses %j", async ({message,lane}) => {
    const f = await failTurn(message);
    const retry = await heartbeatService(db).scheduleBoundedRetry(f.runId,{delayMs:1000,...(lane==='cap'?{retryReason:MAX_TURN_CONTINUATION_RETRY_REASON,wakeReason:'max_turn_continuation',maxAttempts:2}:{})});
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,f.runId));
    console.log("JUDGE_BOUNDED_SUCCESSOR",JSON.stringify({message,lane,sourceRunId:f.runId,retry,rows}));
    expect.soft(retry.outcome).not.toBe("scheduled");
    expect(rows).toHaveLength(0);
  });

  it("keeps a normal 529 overloaded provider error retryable", async () => {
    const f = await failTurn('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    console.log("OVERLOAD_CONTROL", JSON.stringify({ runId: f.runId, errorCode: f.failedRun.errorCode, decision: f.decision.reasonCode, wakes: f.wakes.map(w => w.payload) }));
    expect(f.failedRun.errorCode).toBe("native_run_failed");
    expect(f.wakes).toHaveLength(1);
    // supersedes (mechanism only): exactly one automatic retry, through the cut lane, and no terminal refusal.
    expect(f.wakes[0].payload).toMatchObject({ retryReason: "native_mid_stream_cut", retryOfRunId: f.runId });
    expect(f.decision.reasonCode).not.toBe("provider_policy_refusal");
    expect(classifyContinuationFailure(f.failedRun).kind).not.toBe("non_retryable");
  });

  it("ordinary connection failure remains generic with one retry", async () => {
    const f = await failTurn('Connection refused');
    console.log('JUDGE_ORDINARY_CONTROL', JSON.stringify({runId:f.runId,errorCode:f.failedRun.errorCode,wakes:f.wakes,decision:f.decision}));
    expect(f.failedRun.errorCode).toBe('native_run_failed');
    expect(f.wakes).toHaveLength(1);
  });

  it.each([
    '400 invalid_request_error: Your API key was rejected because your account has not accepted the Terms of Service. See https://www.anthropic.com/legal/commercial-terms.',
    '400 invalid_request_error: Account blocked until Terms of Service are accepted. See https://www.anthropic.com/legal/commercial-terms.',
    '429 rate_limit_error: This request triggered rate limit restrictions.',
  ])('ordinary provider error is not policy refusal: %s', async message => {
    const f = await failTurn(message);
    console.log('JUDGE_RESIDUAL_DB',JSON.stringify({message,run:f.failedRun,decision:f.decision,wakes:f.wakes,notes:await f.notes()}));
    expect.soft(f.failedRun.errorCode).toBe('native_run_failed');
    expect(f.wakes).toHaveLength(1);
  });

  it("retains a real requested Stop even on a policy refusal", async () => {
    const f = await failTurn(usagePolicyError);
    await db.update(heartbeatRuns).set({ resultJson: { ...f.failedRun.resultJson, stopRequested: true } }).where(eq(heartbeatRuns.id, f.runId));
    await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      await recordTaskStopPending(tx as unknown as typeof db, { companyId, issueId: f.issueId, runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []);
    });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toMatchObject([{ cause: "execution_stop_pending" }]);
  });
});
