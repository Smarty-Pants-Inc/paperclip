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


  // Independent R5 boundary checks; keep reasons: durable authority/trust boundary,
  // plus recorded R4 lost-response incidents. No provider/credential/network I/O.
  async function withClaim(f: Awaited<ReturnType<typeof materialized>>, action: () => Promise<void>) {
    let release!:()=>void, entered!:()=>void;
    const released=new Promise<void>(r=>{release=r});
    const claimed=new Promise<void>(r=>{entered=r});
    let armed=true;
    const pausedDb=new Proxy(db,{get(target,key){
      if(key==='transaction') return async (...args:unknown[])=>{
        const result=await (target.transaction as Function).apply(target,args);
        if(armed && (await row(f.runId)).phase==='arbitrating'){armed=false;entered();await released;}
        return result;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const finishing=finalizeNativeRun({db:pausedDb,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([claimed,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new Error('claim barrier not reached')),15000)})]);
      await action();
    } finally {if(timer)clearTimeout(timer);release();await finishing;}
  }

  it.each(['active','expired','no-owner','no-holder','wrong-holder-token','old-boot'] as const)
  ('JUDGE R5 lease boundary: %s',async kind=>{
    const f=await materialized();await failure(f);await copybackSuccess(f);
    await withClaim(f,async()=>{
      const claim=await row(f.runId);
      expect(claim.phase).toBe('arbitrating');
      expect(claim.leaseOwner).toMatch(/^native-finalizer:/);
      expect(claim.leaseHolder?.token).toBe(claim.leaseOwner);
      const changed:Partial<typeof claim>={};
      if(kind==='expired') changed.leaseExpiresAt=new Date(0);
      if(kind==='no-owner') changed.leaseOwner=null;
      if(kind==='no-holder') changed.leaseHolder=null;
      if(kind==='wrong-holder-token') changed.leaseHolder={...claim.leaseHolder,token:`native-finalizer:${randomUUID()}`};
      if(kind==='old-boot') changed.leaseHolder={...claim.leaseHolder,bootId:randomUUID()};
      if(kind!=='active')await db.update(nativeRunFinalizations).set(changed).where(eq(nativeRunFinalizations.runId,f.runId));
      try {
        const allowed=await auth(f);
        const transport=await publishPending(db,f.publication.id,true);
        console.log('JUDGE_R5_LEASE',JSON.stringify({kind,allowed,transport,publicationState:(await publicationRow(f.publication.id)).state,leaseTokenMatches:kind!=='wrong-holder-token',holderChanged:kind==='old-boot'}));
        expect.soft(allowed).toBe(kind==='active');
        expect.soft(transport.errors).toEqual([]);
        expect.soft(transport.sends).toHaveLength(kind==='active'?1:0);
      }finally{
        await db.update(nativeRunFinalizations).set({leaseOwner:claim.leaseOwner,leaseExpiresAt:claim.leaseExpiresAt,leaseHolder:claim.leaseHolder}).where(eq(nativeRunFinalizations.runId,f.runId));
      }
    });
  },120000);

  async function sequenceFixture(failures:number) {
    const f=await seedRecoverableReviewResponse();const original=await row(f.runId);
    if(failures>0)await failure(f);
    const work=nativeReviewResponseWork(db);
    const [entry]=await work.load({companyId:f.companyId,runId:f.runId});
    expect(entry).toBeDefined();await Promise.all([work.check(entry),work.check(entry)]);
    const comments=await commentsFor(f.runId);expect(comments).toHaveLength(1);
    const pubs=await db.select().from(chatPublications).where(eq(chatPublications.commentId,comments[0].id));expect(pubs).toHaveLength(1);
    if(failures>1)await failure(f);
    return {...f,original,comment:comments[0],publication:pubs[0]};
  }
  const orders=[{failures:0,when:'before'},{failures:0,when:'after'},
    {failures:1,when:'before'},{failures:1,when:'during'},{failures:1,when:'after'},
    {failures:2,when:'before'},{failures:2,when:'during'},{failures:2,when:'after'}];
  it.each(orders)('JUDGE R5 exactly once: $failures failures transport $when',async({failures,when})=>{
    const f=await sequenceFixture(failures);let sends=0;
    const send=async()=>{const r=await publishPending(db,f.publication.id,true);expect(r.errors).toEqual([]);sends+=r.sends.length;};
    if(when==='before')await send();
    await copybackSuccess(f);
    if(when==='during')await withClaim(f,send);
    else await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});
    await send();await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:'succeeded',projectRunStatus:true});await send();
    const final=await row(f.runId),pub=await publicationRow(f.publication.id);
    const links=await db.select().from(chatMessageLinks).where(eq(chatMessageLinks.publicationId,f.publication.id));
    console.log('JUDGE_R5_ORDER',JSON.stringify({failures,when,sends,originalDecisionId:f.original.decisionId,decisionId:final.decisionId,state:pub.state,links:links.length}));
    expect.soft(sends).toBe(1);expect.soft(final.decisionId).toBe(f.original.decisionId);expect.soft(pub.state).toBe('published');
    expect.soft(links).toHaveLength(1);expect.soft(await commentsFor(f.runId)).toHaveLength(1);
  },120000);

  it.each([0,1,2])('JUDGE R5 fresh-process success after %i failures',async failures=>{
    const f=await sequenceFixture(failures);await copybackSuccess(f);
    const first=restart(f,true),second=restart(f,true);
    expect.soft(first.errors).toEqual([]);expect.soft(first.sends).toHaveLength(1);expect.soft(first.decisionId).toBe(f.original.decisionId);
    expect.soft(second.errors).toEqual([]);expect.soft(second.sends).toHaveLength(0);expect.soft(second.decisionId).toBe(f.original.decisionId);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');expect.soft(await commentsFor(f.runId)).toHaveLength(1);
  },120000);

  it.each(['run','decision','result','assessment','company','issue','other-failure','exhausted','gate-closed'] as const)
  ('JUDGE R5 retryable authority cannot be borrowed: %s',async kind=>{
    const f=await materialized();await failure(f);
    const run=await runRow(f.runId);const result=structuredClone(run.resultJson!);
    const marker=result.externalChatReviewPresentation as Record<string,unknown>;
    if(['run','decision','result','assessment'].includes(kind))marker[`${kind}Id`]=randomUUID();
    if(kind==='other-failure')result.failureCode='native_provider_failed';
    if(kind==='exhausted')result.failureCode='native_workspace_sync_out_retry_exhausted';
    if(kind==='gate-closed')await db.update(issueThreadInteractions).set({status:'accepted'}).where(eq(issueThreadInteractions.id,f.gate.id));
    const allowed=await authorizeNativeChatReviewPresentation(db,{companyId:kind==='company'?randomUUID():f.companyId,issueId:kind==='issue'?randomUUID():f.issueId,runId:f.runId,resultJson:result});
    console.log('JUDGE_R5_AUTHORITY',JSON.stringify({kind,allowed}));expect(allowed).toBe(false);
  },120000);

  it('JUDGE R5 real exited prior-boot finalizer cannot authorize with only an unexpired timestamp',async()=>{
    const f=await materialized();await failure(f);await copybackSuccess(f);
    const child=spawnSync(process.execPath,['--import',path.join(process.cwd(),'server/node_modules/tsx/dist/loader.mjs'),path.join(process.cwd(),'server/src/__tests__/judge-r5-claim-child.ts')],{
      cwd:process.cwd(),env:{...process.env,JUDGE_DATABASE_URL:externalTestDatabaseUrl??temporary!.connectionString,JUDGE_RUN_ID:f.runId},encoding:'utf8',timeout:60000,
    });
    expect(child.status,child.stderr).toBe(0);expect(child.stdout).toContain('JUDGE_CLAIM_CHILD ');
    const c=await row(f.runId);
    expect(c.phase).toBe('arbitrating');expect(c.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const {readNativeLeaseHolder,nativeLeaseHolderStamp}=await import('../services/native-runtime/native-token-lease-settlement.js');
    const {proveOwnerGone}=await import('../services/owner-proof.js');
    const holder=readNativeLeaseHolder(c.leaseHolder,c.leaseOwner);expect(holder).not.toBeNull();
    const proof=await proveOwnerGone(nativeLeaseHolderStamp(holder!,'native_finalizer_lease'));
    expect(proof.verdict).toBe('gone');
    const allowed=await auth(f),transport=await publishPending(db,f.publication.id,true);
    console.log('JUDGE_R5_DEAD_BOOT',JSON.stringify({childStatus:child.status,proof,phase:c.phase,expiryInFuture:c.leaseExpiresAt!.getTime()>Date.now(),allowed,transport,state:(await publicationRow(f.publication.id)).state}));
    expect.soft(allowed).toBe(false);expect.soft(transport.errors).toEqual([]);expect.soft(transport.sends).toHaveLength(0);
  },120000);

});
