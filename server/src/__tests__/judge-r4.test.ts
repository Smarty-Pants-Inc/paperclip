import { spawnSync } from "node:child_process";
import { publishPending } from "./judge-r4-transport.js";
import { notifyChatRunMilestones } from "../services/chat-run-milestone-notifications.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { accessService } from "../services/access.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq, ne, sql } from "drizzle-orm";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from "./helpers/full-database-response-capture.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  approvals,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatGitHubReviews,
  chatIdentityLinks,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  completionContracts,
  closeRegisteredClients,
  createDb,
  subscribeDatabaseWork,
  heartbeatRuns,
  issueComments,
  issueAttachments,
  issueApprovals,
  issueThreadInteractions,
  issueQuestionResponseDeliveries,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  runIdentityContexts,
  statusDecisions,
  toolApplications,
  toolConnections,
  toolOauthStates,
  chatVoiceSessions, chatVoiceReplies, chatVoiceToolCalls,
  workspaceOperations,
} from "@paperclipai/db";
import { validatePrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";
import type {
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../vendor/paperclip-runner/index.js";

import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { finalizeNativeRun, recordNativeFinalizationFailure, recoverCommittedNativeReviewResponse } from "../services/native-runtime/native-run-finalizer.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { configureAgentLifecycle, createAgentLifecycle, processAgentLifecycle } from "../services/agent-lifecycle.js";
import { createOAuthStateStore } from "../services/tool-access/oauth/state.js";
import { approvalRecords } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { nativeReviewResponseWork } from "../services/native-runtime/native-review-response-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { nativeCompletionFeedback } from "../services/native-runtime/native-completion-feedback.js";
import { hasPublishedGitHubReview, readInheritedGitHubReviewWait } from "../services/chat-channels/github/review-wait.js";
import * as chatWaitAuthority from "../services/native-runtime/chat-attachment-reuse.js";
import * as publishedReviewAuthority from "../services/chat-channels/github/review-wait.js";
import { toolAccessService } from "../services/tool-access.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import {
  authorizeNativeChatReviewPresentation,
  hasMaterializedNativeReviewResponse,
} from "../services/native-runtime/native-chat-review-presentation.js";
import * as nativeChatReviewPresentation from "../services/native-runtime/native-chat-review-presentation.js";
import { resolveChatRunPresentationAuthorizationReason } from "../services/chat-run-publications.js";
import { resolveHeartbeatRunResponse } from "../services/heartbeat-run-summary.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import {
  authorizeChatConversationForBoundRun,
  isExternalChatWaitAuthorizationContention,
  resolveExternalChatResponseWaitAuthorization,
} from "../services/native-runtime/chat-attachment-reuse.js";
import { attestReviewedExternalChatRun, buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { voiceCredentialFingerprint } from "../services/voice/voice-session-store.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { questionResponseDeliveryValues } from "../services/question-response-delivery.js";
import { resolveExternalChatQuestionResponse } from "../services/native-runtime/external-chat-question-response.js";
import { listExternalReviewWaits } from "../services/native-runtime/external-review-wait.js";
import { materializeExternalChatQuestionResponseInput } from "../services/native-runtime/external-chat-question-response-input.js";
import * as nativeInteractionBridge from "../services/native-runtime/native-interaction-bridge.js";
import { defaultGitHubReviewPolicy, type AskUserQuestionsInteraction } from "@paperclipai/shared";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { subscribeAllCompanyLiveEvents } from "../services/live-events.js";

describe("native external-chat response wait", () => {
  const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
  let temporary: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
      return;
    }
    temporary = await startEmbeddedPostgresTestDatabase(
      "native-external-chat-wait-",
    );
    db = createDb(temporary.connectionString);
  }, 30_000);

  afterAll(async () => {
    await temporary?.cleanup();
    if (externalTestDatabaseUrl)
      await closeRegisteredClients(externalTestDatabaseUrl);
  });

  async function seedWaitTurn(
    provider:
      | "telegram"
      | "discord"
      | "github"
      | "microsoft-teams"
      | "slack" = "telegram",
    attentionRequests: PrpStructuredRunResult["attentionRequests"] = [],
    resultOverrides: Partial<PrpStructuredRunResult> = {},
    deferCompletion = false,
    contractOverride?: { objective: string; criteria: Array<{ id: string; requirement: string }> },
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const runnerInstanceId = randomUUID();
    const contractId = randomUUID();
    const endpointId = randomUUID();
    const resourceId = randomUUID();
    const conversationId = randomUUID();
    const principalId = randomUUID();
    const commentId = randomUUID();
    const deliveryId = randomUUID();
    const userId = `wait-user-${randomUUID()}`;
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const contractSha256 = `external-chat-wait-${randomUUID()}`;
    // Keep prefix uniqueness as strong as the company's primary key. A five-
    // digit random prefix can collide within this fixture-heavy suite.
    const issuePrefix = `W${companyId.replaceAll("-", "").toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "External chat wait",
      issuePrefix,
      issueCounter: 1,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Waiting chat agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      title: "Send the photo and wait",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "low",
      completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "external-chat-wait-v1",
        objective: "Send the requested photo and wait for the next message",
        criteria: [
          { id: "response", requirement: "Return the requested photo" },
        ],
        ...contractOverride,
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      contextSnapshot: {},
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `chat:telegram:${endpointId}`,
      name: "Telegram wait",
      type: "chat",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "Telegram wait",
      uid: `chat-telegram-${endpointId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
      enabled: true,
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider,
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      providerAccountId: "telegram-bot",
      allowDirectMessages: true,
      allowUnlinkedPeople: false,
    });
    await db.insert(chatEndpointResources).values({
      id: resourceId,
      companyId,
      endpointId,
      type: provider === "github" ? "repository" : "direct_message",
      providerResourceId:
        provider === "github" ? "paperclip/test-repository" : "telegram-user",
      label:
        provider === "github"
          ? "Paperclip test repository"
          : "Telegram direct message",
      availability: "available",
      enabled: true,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      companyId,
      endpointId,
      resourceId,
      issueId,
      externalConversationId: "telegram-user",
      externalThreadId: "telegram:telegram-user",
      sessionGeneration: 1,
      externalLabel: "Telegram direct message",
      isDirectMessage: provider !== "github",
      state: "active",
    });
    await db.insert(chatExternalPrincipals).values({
      id: principalId,
      companyId,
      provider,
      providerAccountId: "telegram-bot",
      externalId: "telegram-user",
      kind: "user",
    });
    await db.insert(chatIdentityLinks).values({
      companyId,
      endpointId,
      principalId,
      paperclipUserId: userId,
      status: "linked",
    });
    await db.insert(authUsers).values({ id: userId, name: "Review owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorType: "user",
      authorUserId: userId,
      body: "Send the photo, keep this task in progress, and wait.",
    });
    await db.insert(chatDeliveries).values({
      id: deliveryId,
      companyId,
      endpointId,
      conversationId,
      principalId,
      providerEventId: "telegram-wait-message",
      deduplicationKey: "telegram-wait-message",
      eventKind: "message",
      normalizedEvent: {},
      state: "processed",
      attempts: 1,
      processedAt: new Date(),
    });
    await db.insert(chatMessageLinks).values({
      companyId,
      endpointId,
      conversationId,
      deliveryId,
      commentId,
      providerMessageId: "telegram-user:1",
      direction: "inbound",
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          source: `chat:${provider}`,
          paperclipHarnessCheckedOut: true,
          issueId,
          wakeCommentId: commentId,
          wakeCommentIds: [commentId],
          paperclipWake: {
            reason: "External chat message received",
            externalChatProvider: provider,
            checkedOutByHarness: true,
            issue: { id: issueId, workMode: "standard" },
            commentIds: [commentId],
          },
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const port = new PaperclipControlPlanePort(db, {
      companyId,
      issueId,
      runId,
      agentId,
      sessionId,
      completionContractId: contractId,
      completionContractSha256: contractSha256,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: `wait-control-${runId}`,
    });
    await port.openRun({
      identity: { companyId, issueId, runId, agentId, sessionId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary:
        "The requested photo is prepared. I will wait for your next message.",
      completionClaim: {
        contractRevision: "external-chat-wait-v1",
        objectiveSatisfied: true,
        criteria: [
          {
            criterionId: "response",
            status: "satisfied",
            evidenceRefs: [],
          },
        ],
        remainingWork: [],
      },
      evidence: [],
      verification: [],
      attentionRequests,
      artifacts: [],
      continuation: {
        kind: "response_wake",
        summary: "Wait for the next authorized Telegram message.",
        idempotencyKey: `telegram-response-wait:${conversationId}`,
      },
      ...resultOverrides,
    };
    const terminal: PrpTerminalState = {
      schema: "paperclip.prp.terminal.v1",
      turnTerminalState: "completed",
      runTerminalState: "succeeded",
      reportedWorkDisposition: result.reportedWorkDisposition,
      workAssessmentId: randomUUID(),
      statusDecisionId: randomUUID(),
    };
    if (!deferCompletion) await port.completeRun({
      result,
      terminal,
      callerResultId: `wait-result-${runId}`,
    });
    await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        resultJson: {
          nativeResult: result as unknown as Record<string, unknown>,
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));

    return {
      port, result, terminal,
      agentId,
      companyId,
      conversationId,
      endpointId,
      deliveryId,
      issueId,
      resourceId,
      runId,
      userId,
      commentId,
      principalId,
      storeBinding: { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
        runnerSourceInstanceId: runnerInstanceId, completionContractId: contractId,
        completionContractSha256: contractSha256, completionContractRevision: "external-chat-wait-v1",
        completionContractCriterionIds: ["response"] },
    };
  }

  async function seedPriorCompletionReview(
    fixture: Awaited<ReturnType<typeof seedWaitTurn>>,
  ) {
    const [current] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    const [accepted] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, fixture.runId));
    const runId = randomUUID();
    const sessionId = randomUUID();
    const runnerInstanceId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: fixture.issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: current!.completionContractId,
      completionContractSha256: current!.completionContractSha256,
      contextSnapshot: {},
      createdAt: new Date(Date.now() - 60_000),
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, fixture.issueId));
    const port = new PaperclipControlPlanePort(db, {
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      agentId: fixture.agentId,
      runId,
      sessionId,
      completionContractId: current!.completionContractId!,
      completionContractSha256: current!.completionContractSha256!,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: `review-control-${runId}`,
    });
    await port.openRun({
      identity: {
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        agentId: fixture.agentId,
        runId,
        sessionId,
      },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result = {
      ...(accepted!.resultJson.result as PrpStructuredRunResult),
      reportedWorkDisposition: "needs_review" as const,
    };
    delete result.continuation;
    result.attentionRequests = [{ kind: "review", ownerClass: "human", summary: "Approve the prepared response before continuing." }];
    const terminal = {
      ...(accepted!.resultJson.terminal as PrpTerminalState),
      reportedWorkDisposition: "needs_review" as const,
    };
    await port.completeRun({
      result,
      terminal,
      callerResultId: `prior-review-${runId}`,
    });
    await finalizeNativeRun({
      db,
      runId,
      workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true,
    });
    const [gate] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.sourceRunId, runId));
    expect(gate).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: fixture.agentId,
      createdByUserId: null,
    });
    await db
      .update(issues)
      .set({ executionRunId: fixture.runId })
      .where(eq(issues.id, fixture.issueId));
    await db
      .update(heartbeatRuns)
      .set({ startedAt: new Date(gate!.createdAt.getTime() + 1) })
      .where(eq(heartbeatRuns.id, fixture.runId));
    return gate!;
  }

  async function seedRecoverableReviewResponse() {
    const fixture = await seedWaitTurn();
    const gate = await seedPriorCompletionReview(fixture);
    await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator!.phase).toBe("committed");
    const input = { companyId: fixture.companyId, issueId: fixture.issueId, runId: fixture.runId,
      decisionId: coordinator!.decisionId!, resultId: coordinator!.resultId!, assessmentId: coordinator!.assessmentId!, onlyWhenDue: true };
    return { ...fixture, gate, input };
  }


  const row = async (runId: string) => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0];
  const runRow = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId)))[0];
  const commentsFor = (runId: string) => db.select().from(issueComments).where(eq(issueComments.createdByRunId,runId));
  async function failure(f: Awaited<ReturnType<typeof seedRecoverableReviewResponse>>, permanent=false) {
    return recordNativeFinalizationFailure({db,runId:f.runId,error:new Error(permanent?'native_workspace_sync_out_unrecoverable':'native_workspace_sync_out_failed'),failureScope:'workspace',projectRunStatus:true,permanent});
  }
  async function materialized() {
    const f = await seedRecoverableReviewResponse();
    const original = await row(f.runId);
    await failure(f);
    const work=nativeReviewResponseWork(db);
    const [entry]=await work.load({companyId:f.companyId,runId:f.runId});
    expect(entry).toBeDefined();
    await Promise.all([work.check(entry),work.check(entry)]);
    const comments=await commentsFor(f.runId);
    expect(comments).toHaveLength(1);
    const pubs=await db.select().from(chatPublications).where(eq(chatPublications.commentId,comments[0].id));
    expect(pubs).toHaveLength(1);
    return {...f,original,comment:comments[0],publication:pubs[0]};
  }
  async function copybackSuccess(f: Awaited<ReturnType<typeof materialized>>) {
    await db.insert(workspaceOperations).values({companyId:f.companyId,issueId:f.issueId,heartbeatRunId:f.runId,phase:'workspace_finalize',status:'succeeded'});
  }
  const publicationRow=async (id:string)=>(await db.select().from(chatPublications).where(eq(chatPublications.id,id)))[0];
  async function auth(f: Awaited<ReturnType<typeof materialized>>) {
    return authorizeNativeChatReviewPresentation(db,{companyId:f.companyId,issueId:f.issueId,runId:f.runId,resultJson:(await runRow(f.runId)).resultJson!});
  }
  function restart(f: Awaited<ReturnType<typeof materialized>>, finalize=false) {
    const p=spawnSync(process.execPath,['--import',path.join(process.cwd(),'server/node_modules/tsx/dist/loader.mjs'),path.join(process.cwd(),'server/src/__tests__/judge-r4-child.ts')], {
      cwd:process.cwd(),env:{...process.env,JUDGE_DATABASE_URL:externalTestDatabaseUrl ?? temporary!.connectionString,
        JUDGE_INPUT:JSON.stringify({companyId:f.companyId,issueId:f.issueId,runId:f.runId,publicationId:f.publication.id,finalize})},
      encoding:'utf8',timeout:60000,
    });
    expect(p.status, p.stderr).toBe(0);
    const line=p.stdout.split('\n').find(l=>l.startsWith('JUDGE_CHILD_RESULT '));
    expect(line,p.stdout).toBeDefined();
    const result=JSON.parse(line!.slice('JUDGE_CHILD_RESULT '.length));
    console.log('JUDGE_RESTART',JSON.stringify(result));
    return result;
  }

  it('JUDGE R4: actual transport sends once during second failure and preserves original decision after success',async()=>{
    const f=await materialized();
    await failure(f);
    expect.soft(await auth(f)).toBe(true);
    const result=await publishPending(db,f.publication.id,true);
    const sentRow=await publicationRow(f.publication.id);
    console.log('JUDGE_SECOND_FAILURE_TRANSPORT',JSON.stringify({result,state:sentRow.state,decisionId:(await row(f.runId)).decisionId,originalDecisionId:f.original.decisionId}));
    expect.soft(result.errors).toEqual([]);
    expect.soft(result.sends).toHaveLength(1);
    expect.soft(sentRow.state).toBe('published');
    await copybackSuccess(f);
    await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    expect.soft((await row(f.runId)).decisionId).toBe(f.original.decisionId);
    expect.soft(await auth(f)).toBe(true);
    const restarted=restart(f);
    expect.soft(restarted.sends).toHaveLength(0);
    expect.soft(restarted.errors).toEqual([]);
    expect.soft(restarted.decisionId).toBe(f.original.decisionId);
    expect.soft(await commentsFor(f.runId)).toHaveLength(1);
    const links=await db.select().from(chatMessageLinks).where(eq(chatMessageLinks.publicationId,f.publication.id));
    expect.soft(links).toHaveLength(1);
  },120000);

  it('JUDGE R4: restart between second failure and success publishes original queued reply once',async()=>{
    const f=await materialized(); await failure(f); await copybackSuccess(f);
    const first=restart(f,true);
    expect.soft(first.errors).toEqual([]); expect.soft(first.sends).toHaveLength(1);
    expect.soft(first.allowed).toBe(true); expect.soft(first.decisionId).toBe(f.original.decisionId);
    const second=restart(f,true);
    expect.soft(second.sends).toHaveLength(0); expect.soft(second.errors).toEqual([]);
    expect.soft(second.decisionId).toBe(f.original.decisionId);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');
    expect.soft(await commentsFor(f.runId)).toHaveLength(1);
    const publications=await db.select().from(chatPublications).where(eq(chatPublications.commentId,f.comment.id));
    expect.soft(publications).toHaveLength(1);
  },120000);

  it('JUDGE R4: first retry succeeds after response materialization without changing saved reply identity',async()=>{
    const f=await materialized();
    await copybackSuccess(f);
    const before=await runRow(f.runId);
    await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    const after=await row(f.runId);
    const transport=await publishPending(db,f.publication.id);
    console.log('JUDGE_FIRST_RETRY_SUCCESS',JSON.stringify({beforePhase:before.resultJson?.finalizationPhase,originalDecisionId:f.original.decisionId,decisionId:after.decisionId,transport,publicationState:(await publicationRow(f.publication.id)).state}));
    expect.soft(after.decisionId).toBe(f.original.decisionId);
    expect.soft(await auth(f)).toBe(true);
    expect.soft(transport.errors).toEqual([]);
    expect.soft(transport.sends).toHaveLength(1);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');
  },120000);

  it('JUDGE R4: transport racing the committed retry claim must not cancel the saved reply',async()=>{
    const f=await materialized(); await failure(f); await copybackSuccess(f);
    let release!:()=>void; let entered!:()=>void;
    const released=new Promise<void>(r=>{release=r;});
    const claimed=new Promise<void>(r=>{entered=r;});
    let armed=true;
    const pausedDb=new Proxy(db,{get(target,key){
      if(key==='transaction') return async (...args: unknown[])=>{
        const result=await (target.transaction as Function).apply(target,args);
        if(armed && (await row(f.runId)).phase==='arbitrating') {armed=false;entered();await released;}
        return result;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const finishing=finalizeNativeRun({db:pausedDb,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    let transport:Awaited<ReturnType<typeof publishPending>>|undefined;
    let during:string|undefined;
    try {
      await claimed;
      expect((await row(f.runId)).phase).toBe('arbitrating');
      transport=await publishPending(db,f.publication.id);
      during=(await publicationRow(f.publication.id)).state;
    } finally {release();await finishing;}
    const after=await publishPending(db,f.publication.id);
    console.log('JUDGE_SUCCESS_CLAIM_RACE',JSON.stringify({transport,during,after,finalState:(await publicationRow(f.publication.id)).state,originalDecisionId:f.original.decisionId,decisionId:(await row(f.runId)).decisionId,authorizedAfter:await auth(f)}));
    expect.soft(during).not.toBe('cancelled');
    expect.soft((await row(f.runId)).decisionId).toBe(f.original.decisionId);
    expect.soft((transport?.sends.length??0)+after.sends.length).toBe(1);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');
  },120000);

  it.each(['exhausted','permanent'] as const)('JUDGE R4: %s copyback failure blocks saved-answer transport and stages a truthful note',async kind=>{
    const f=await materialized();
    if(kind==='exhausted'){await failure(f);await failure(f);}else await failure(f,true);
    const final=await row(f.runId);
    expect.soft(final.phase).toBe('terminal_failure');
    expect.soft(await auth(f)).toBe(false);
    const transport=await publishPending(db,f.publication.id);
    expect.soft(transport.errors).toEqual([]); expect.soft(transport.sends).toHaveLength(0);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('cancelled');
    const notes=await db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issueId),eq(issueComments.authorType,'system')));
    console.log('JUDGE_TERMINAL_FAILURE',JSON.stringify({kind,phase:final.phase,code:final.failureCode,runStatus:(await runRow(f.runId)).status,notes:notes.map(n=>({body:n.body,runId:n.createdByRunId}))}));
    if(kind==='exhausted') {
      const notice=notes.find(n=>n.body.includes('Workspace copy-back was lost'));
      expect.soft(notice).toBeDefined();
      expect.soft(notice?.body).toContain('is being stopped');
      expect.soft(notice?.body).toContain('3 failed attempts');
      if(notice) {
        const pubs=await db.select().from(chatPublications).where(eq(chatPublications.commentId,notice.id));
        console.log('JUDGE_FAILURE_NOTE_PUBLICATIONS',JSON.stringify(pubs.map(p=>({id:p.id,state:p.state}))));
        // A truthful saved comment must not itself become unsendable solely due to the originating run failure.
        for(const pub of pubs) {
          const delivered=await publishPending(db,pub.id);
          console.log('JUDGE_FAILURE_NOTE_TRANSPORT',JSON.stringify({delivered,state:(await publicationRow(pub.id)).state}));
          expect.soft(delivered.errors).toEqual([]);
          expect.soft(delivered.sends).toHaveLength(1);
          expect.soft((await publicationRow(pub.id)).state).toBe('published');
        }
      }
    } else {
      expect.soft((await runRow(f.runId)).error).toMatch(/workspace|export|copy.?back/i);
    }
    const {enqueueChatRunLifecycleMilestones}=await import('../services/chat-run-publications.js');
    await enqueueChatRunLifecycleMilestones(db,{scope:{companyId:f.companyId,issueId:f.issueId}});
    const milestone=await db.select().from(chatPublications).where(eq(chatPublications.idempotencyKey,`run:${f.runId}:failed:${f.endpointId}`));
    expect.soft(milestone).toHaveLength(1);
    if(milestone[0]) {
      const delivered=await publishPending(db,milestone[0].id);
      console.log('JUDGE_TERMINAL_PERSON_NOTICE',JSON.stringify({kind,delivered,state:(await publicationRow(milestone[0].id)).state}));
      expect.soft(delivered.errors).toEqual([]);
      expect.soft(delivered.sends).toHaveLength(1);
      expect.soft(delivered.sends[0]).toMatch(/stopped before completing/);
      expect.soft(delivered.sends[0]).not.toMatch(/files (?:are|were) saved/);
      expect.soft((await publicationRow(milestone[0].id)).state).toBe('published');
    }
  },120000);

});
