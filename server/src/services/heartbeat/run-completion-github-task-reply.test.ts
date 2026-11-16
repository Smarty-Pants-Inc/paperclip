import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, chatConversations, chatEndpoints, chatGitHubConfigurations, chatMessageLinks, chatPublications, companies,
  completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, toolApplications, toolConnections,
  type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import * as usageReceipts from "../usage-receipts.js";
import { issueService } from "../issues.js";
import { NativeRunCoordinatorStore } from "../native-runtime/native-run-coordinator-store.js";
import { finalizeNativeRun } from "../native-runtime/native-run-finalizer.js";
import { nativeResponsePresentationWork } from "../native-runtime/native-response-presentation-work.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatRunState, getAdapterSessionCodec } from "./run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "./workspaces.js";
import { createHeartbeatRunCompletion, type CompleteHeartbeatRunInput, type HeartbeatRunCompletionDependencies } from "./run-completion.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// #20789 half (i): the LIVE completion path must present a GitHub-woken
// reviewer's final reply on its ordinary review task. GitHub replies are
// authored through task-scoped tools, so the runner's final prose is an
// internal agent write on the task, never an external chat presentation.
type Dependencies = HeartbeatRunCompletionDependencies;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const lifecycleDeps = {
    ...state, ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
    recovery: { escalateStrandedAssignedIssue: vi.fn() },
    companySkills: { completeTestRunForIssue: vi.fn() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn(),
    getCurrentUserRedactionOptions: vi.fn<HeartbeatLifecycleDependencies["getCurrentUserRedactionOptions"]>(async () => ({ enabled: false })),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDeps);
  return {
    ...state, ...lifecycle,
    // The real presentation inputs: run comments, final runner message and the issue service.
    findRunIssueComment: lifecycle.findRunIssueComment,
    findLatestCompletedFinalAgentMessage: lifecycle.findLatestCompletedFinalAgentMessage,
    issuesSvc: { addComment: issueService(db).addComment },
    classifyAndPersistRunLiveness: vi.fn<Dependencies["classifyAndPersistRunLiveness"]>(async run => run),
    completeSkillTestRunForHeartbeatOutcome: vi.fn<Dependencies["completeSkillTestRunForHeartbeatOutcome"]>(async () => null),
    refreshContinuationSummaryForRun: vi.fn<Dependencies["refreshContinuationSummaryForRun"]>(async () => null),
    finalizeIssueCommentPolicy: vi.fn<Dependencies["finalizeIssueCommentPolicy"]>(async () => ({ outcome: "not_applicable", queuedRun: null })),
    handleIssueReviewPathDisposition: vi.fn<Dependencies["handleIssueReviewPathDisposition"]>(async () => undefined),
    handleRunLivenessContinuation: vi.fn<Dependencies["handleRunLivenessContinuation"]>(),
    handleSuccessfulRunHandoff: vi.fn<Dependencies["handleSuccessfulRunHandoff"]>(),
    updateRuntimeState: vi.fn<Dependencies["updateRuntimeState"]>(),
    scheduleBoundedRetryForRun: vi.fn<Dependencies["scheduleBoundedRetryForRun"]>(),
    scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<Dependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
    timerClaimWasFirstHeartbeat: vi.fn<Dependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    releaseIssueExecutionAndPromote: vi.fn<Dependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
    finalizeAgentStatus: vi.fn<Dependencies["finalizeAgentStatus"]>(async () => undefined),
    enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
    recovery: { reconcileLegacyContinuation: vi.fn<Dependencies["recovery"]["reconcileLegacyContinuation"]>(), reconcileResolvedDependencyWakeBackstop: vi.fn<Dependencies["recovery"]["reconcileResolvedDependencyWakeBackstop"]>() },
    getCurrentUserRedactionOptions: lifecycleDeps.getCurrentUserRedactionOptions,
    budgetHooks: {},
    runLogStore: { finalize: vi.fn<Dependencies["runLogStore"]["finalize"]>(async () => ({ bytes: 1, sha256: "log-hash", compressed: true })) },
    traceStore: { finalize: vi.fn<Dependencies["traceStore"]["finalize"]>() },
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean }>(),
  } satisfies Dependencies;
}

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported && !process.env.PAPERCLIP_TEST_DATABASE_URL)("live presentation of a chat-woken native task reply", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    vi.spyOn(usageReceipts, "indexPendingUsageReceipts").mockResolvedValue(new Map());
    vi.spyOn(usageReceipts, "recoverPendingRunUsageReceipts").mockResolvedValue([]);
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-github-task-reply");
      db = createDb(database.connectionString);
    }
    await db.execute(sql`set client_min_messages = warning`);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.restoreAllMocks(); });

  const reply = "Reviewed abc123: 5/5. The quantity fix is correct and the checks pass.";

  /** A Code Reviewer run woken through a chat channel on its ordinary review task. */
  async function reviewerRun(provider: "github" | "slack", finalizer: "before_live_completion" | "owns_terminal_projection" = "before_live_completion") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review fixture", issuePrefix: companyId.slice(0, 8) });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Code Reviewer", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Review PR #42", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Review the PR", criteria: [] },
      canonicalSha256: "fixture-review-contract", createdByActorType: "system", createdByActorId: "test" }).returning();
    // The chat origin: an endpoint bound to the task, and the inbound message that woke the run.
    const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID();
    const conversationId = randomUUID(), sourceCommentId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: `Chat channel ${endpointId}`, type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: `Chat connection ${endpointId}`,
      uid: `chat-${endpointId}`, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider,
      publicId: `chat-${endpointId}`, assignedAgentId: agentId, status: "active" });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId,
      externalConversationId: `external-${conversationId}`, externalLabel: "Review conversation" });
    await db.insert(issueComments).values({ id: sourceCommentId, companyId, issueId, authorUserId: "author", body: "Please review PR #42." });
    await db.insert(chatMessageLinks).values({ companyId, endpointId, conversationId,
      providerMessageId: `message-${sourceCommentId}`, direction: "inbound", commentId: sourceCommentId });
    if (provider === "github") await db.insert(chatGitHubConfigurations).values({ companyId, endpointId,
      configuration: {} as never, updatedByUserId: "author" });
    const contextSnapshot = { issueId, source: `chat:${provider}`, chatConversationId: conversationId, endpointId,
      wakeCommentId: sourceCommentId, wakeCommentIds: [sourceCommentId] };
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", startedAt: new Date(), contextSnapshot }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    // The runner commits an accepted done result and the native finalizer
    // projects it, as on fresh, before heartbeat's live completion.
    const result = { schema: "paperclip.run_result.v1" as const, reportedWorkDisposition: "done" as const, summary: "Reviewed the PR.",
      completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed",
      reportedWorkDisposition: "done" } as const;
    await new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: [] }).completeRun({ result, terminal, turnId: "review-turn" });
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 170, eventType: "item.completed",
      payload: { prpEvent: { runId, normalizedSessionId: sessionId, turnId: "review-turn", sourceEventId: "review-final",
        payload: { kind: "agentMessage", channel: "final", providerPhase: "final", text: reply } } } });
    // Either heartbeat's live completion follows the commit, or (workspace
    // copy-back deferred to its durable owner, controller restart, reconciler)
    // the durable finalizer owns the terminal projection and presents inline.
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded",
      projectRunStatus: finalizer === "owns_terminal_projection" });
    const deps = callbacks(db);
    const input: CompleteHeartbeatRunInput = {
      run, agent, issueId, issueRef: issue, signal: new AbortController().signal,
      output: { handle: { store: "local_file", logRef: "test-log" }, outputProgressState: { pending: { bytes: 0 } }, flushOutputProgress: vi.fn(async () => {}), stdoutExcerpt: "", stderrExcerpt: "" },
      session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null, taskKey: issueId, configuredModel: "test-model",
        sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }),
      },
      readFailureReportSecrets: () => [],
      adapterResult: { exitCode: 0, signal: null, timedOut: false, sessionId: null, usage: undefined, provider: "test", model: "test-model",
        resultJson: { nativeResult: result },
        nativeFinalization: { schema: "paperclip.native-finalization.v1", runtimeMode: "native", runId, companyId, issueId, result, terminal,
          turnId: "review-turn", sourceInstanceId: runnerId, normalizedSessionId: sessionId, providerSessionId: "provider-session",
          driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, workspaceFinalizeStatus: "succeeded" } as never },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null },
      configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false },
      providerTraceCapture: false, onProviderTraceFinalized: vi.fn(), issueContext: null, onLog: vi.fn(async () => {}),
    };
    const completion = createHeartbeatRunCompletion(db, deps);
    return { companyId, issueId, runId, agentId, endpointId, input, completion };
  }
  const runRow = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const replies = (issueId: string, runId: string) => db.select().from(issueComments)
    .where(and(eq(issueComments.issueId, issueId), eq(issueComments.createdByRunId, runId)));

  it("presents a GitHub reviewer's final reply on its review task on the live path", async () => {
    const f = await reviewerRun("github");
    await f.completion.completeRun(f.input);
    const comments = await replies(f.issueId, f.runId);
    // Exactly one task comment, written by the live path, as an internal agent write.
    expect(comments).toEqual([expect.objectContaining({ body: reply, authorAgentId: f.agentId,
      metadata: expect.objectContaining({ authorizationReason: "internal_agent_write" }) })]);
    const decision = (await runRow(f.runId)).resultJson?.presentationDecision as Record<string, unknown> | undefined;
    expect(decision).toMatchObject({ commentAction: "create", commentId: comments[0]!.id,
      reasonCodes: expect.arrayContaining(["resolved_response_materialized"]) });
    // GitHub's reply is the reviewer's own tool write; the task comment is not mirrored to GitHub.
    expect(await db.select().from(chatPublications).where(eq(chatPublications.endpointId, f.endpointId))).toEqual([]);
    // Nothing is left for the recoverer, so no refusal receipt can follow.
    expect(await nativeResponsePresentationWork(db).load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
  });

  // RED for #20789 (i): when heartbeat's live completion does not run, the
  // durable finalizer's terminal projection is the live presentation owner
  // (native-run-finalizer.ts repairCommittedNativeChatResponse after
  // projectCommittedRun). It must present the GitHub reviewer's reply
  // immediately, without waiting for the bounded recovery sweep.
  it("presents a GitHub reviewer's reply when the durable finalizer owns the terminal projection", async () => {
    const f = await reviewerRun("github", "owns_terminal_projection");
    const run = await runRow(f.runId);
    expect(run).toMatchObject({ status: "succeeded", nativePhase: "committed" });
    const comments = await replies(f.issueId, f.runId);
    expect(comments).toEqual([expect.objectContaining({ body: reply, authorAgentId: f.agentId,
      metadata: expect.objectContaining({ authorizationReason: "internal_agent_write" }) })]);
    expect(run.resultJson?.presentationDecision).toMatchObject({ commentAction: "create", commentId: comments[0]!.id });
    expect(run.resultJson?.responsePublication).toBeUndefined();
    expect(await db.select().from(chatPublications).where(eq(chatPublications.endpointId, f.endpointId))).toEqual([]);
    expect(await nativeResponsePresentationWork(db).load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
  });

  it("does not post a Slack reply locally from the durable finalizer's terminal projection", async () => {
    const f = await reviewerRun("slack", "owns_terminal_projection");
    expect(await replies(f.issueId, f.runId)).toEqual([]);
    expect(await db.select().from(chatPublications).where(eq(chatPublications.endpointId, f.endpointId))).toEqual([]);
  });

  it("keeps a Slack reply as the external chat presentation", async () => {
    const f = await reviewerRun("slack");
    await f.completion.completeRun(f.input);
    const comments = await replies(f.issueId, f.runId);
    expect(comments).toEqual([expect.objectContaining({ body: reply,
      metadata: expect.objectContaining({ authorizationReason: "allow_chat_run_presentation" }) })]);
    expect((await runRow(f.runId)).resultJson?.presentationDecision).toMatchObject({ commentAction: "create", commentId: comments[0]!.id,
      reasonCodes: expect.arrayContaining(["external_chat_final_precedence", "resolved_response_materialized"]) });
    expect(await db.select().from(chatPublications).where(eq(chatPublications.endpointId, f.endpointId)))
      .toEqual([expect.objectContaining({ commentId: comments[0]!.id })]);
  });
});
