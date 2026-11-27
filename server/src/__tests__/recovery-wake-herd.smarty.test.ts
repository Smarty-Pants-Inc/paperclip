import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";

import { publishContinuousNativeReply } from "../services/native-runtime/native-continuous-reply.js";
import { FIRST_TURN_QUEUED_INPUT_SCHEMA } from "../services/native-runtime/first-turn-queued-input.js";
import { queuedCommentIdsFromWakePayload } from "../lib/queued-comment-context.js";
import { prepareHeartbeatSession } from "../services/heartbeat/session-preparation.js";
import { getAdapterSessionCodec } from "../services/heartbeat/run-state.js";
import { buildPaperclipWakePayload } from "../services/heartbeat/run-preparation.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { buildNativeModelEnvelope } from "@paperclipai/paperclip-runner";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { buildNativeSessionHandoff } from "../services/native-runtime/native-session-handoff.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("recovery wake herd", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-recovery-wake-herd-");
    db = createDb(temporary.connectionString);
    userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql`truncate table company_memberships, issue_recovery_actions, activity_log, agent_wakeup_requests, heartbeat_runs, issues, agents, companies cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seedCompany(maxConcurrentRuns = 1) {
    companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Herd", issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Ponytail", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns } }, permissions: {} });
    return agentId;
  }

  async function addAgent(maxConcurrentRuns = 1) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: `Worker ${agentId.slice(0, 4)}`, role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns } }, permissions: {} });
    return agentId;
  }

  async function task(agentId: string, status: "todo" | "in_progress" = "in_progress") {
    const [row] = await db.insert(issues).values({ companyId, title: "Continue the work", status, assigneeAgentId: agentId }).returning();
    return row!;
  }

  async function sourceRun(agentId: string, issueId: string, endedMinutesAgo: number) {
    const finishedAt = new Date(Date.now() - endedMinutesAgo * 60_000);
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "assignment",
      status: "failed", errorCode: "server_shutdown_interrupted", startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
      createdAt: new Date(finishedAt.getTime() - 120_000), contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    return row!;
  }

  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  // Keep reason: recovery before turn.start must preserve the person's input identity.
  it.each(["before-first-turn", "sealed-inputs", "foreign-agent", "foreign-issue", "foreign-company", "old-generation"])(
    "carries only unanswered recovery input through enqueue and first final (%s)", async kind => {
    const agentId = await seedCompany();
    const issue = await task(agentId);
    const sourceIssueId = kind === "foreign-issue" ? (await task(agentId)).id : issue.id;
    const source = await sourceRun(agentId, sourceIssueId, 1);
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issueComments).values(ids.map((id, index) => ({ id, companyId, issueId: issue.id,
      authorUserId: userId, body: `Person input ${index}`, createdAt: new Date(Date.now() - 10_000 + index) })));
    const sealed = kind === "sealed-inputs";
    const rejected = kind.startsWith("foreign-") || kind === "old-generation";
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: sourceIssueId, issueId: sourceIssueId,
      errorCode: "setup_failed", error: "environmentSyncIn timeout", executionStage: "preparing",
      contextSnapshot: { issueId: sourceIssueId, wakeCommentId: ids[0],
        ...(sealed ? { wakeCommentIds: [ids[1], ids[2], ids[0]], firstTurnQueuedInput: {
          schema: FIRST_TURN_QUEUED_INPUT_SCHEMA, runId: source.id, commentIds: [ids[3]],
          wakeupRequestIds: [], claimedAt: new Date().toISOString() } } : {}),
        ...(kind === "old-generation" ? { conversationSessionGeneration: 0 } : {}) },
      ...(sealed ? { resultJson: { continuousReplies: { prior: { questionCommentIds: [ids[1]] } },
        personStop: { returned: [ids[2]] } } } : {}),
      ...(kind === "foreign-agent" ? { agentId: await addAgent() } : {}),
    }).where(eq(heartbeatRuns.id, source.id));
    if (kind === "foreign-company") {
      const otherCompanyId = randomUUID();
      await db.insert(companies).values({ id: otherCompanyId, name: "Other scope", issuePrefix: otherCompanyId.slice(0, 8) });
      await db.update(heartbeatRuns).set({ companyId: otherCompanyId }).where(eq(heartbeatRuns.id, source.id));
    }
    if (kind === "old-generation") await db.update(issues).set({ conversationAgentId: agentId,
      conversationUserId: userId, conversationState: "active", conversationSessionGeneration: 1 }).where(eq(issues.id, issue.id));
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system",
      returnOwnerAgentId: agentId, cause: "fresh_continuation", fingerprint: `retry-input:${source.id}`,
      nextAction: "Continue saved work", resolvedAt: new Date(), evidence: { continuationDelivery: "pending",
        executionReconciliation: { runId: source.id, providerStopped: true, actionOutcome: "not_performed",
          outcomeEvidence: "Setup timed out before the first provider turn." } } }).returning();
    // Occupy the agent's slot: use real wake admission, but never launch a model.
    const blocker = await sourceRun(agentId, (await task(agentId)).id, 0);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, blocker.id));
    const heartbeat = heartbeatService(db);
    try {
      await deliverReconciledExecutions(db, heartbeat.wakeup);
      await deliverReconciledExecutions(db, heartbeat.wakeup);
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id));
      expect(retries).toHaveLength(1);
      const retry = retries[0]!;
      const expected = rejected ? [] : sealed ? [ids[0], ids[3]] : [ids[0]];
      expect(retry.contextSnapshot?.wakeCommentIds ?? []).toEqual(expected);
      expect(retry.contextSnapshot?.firstTurnQueuedInput).toBeUndefined();
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, retry.id));
      expect(queuedCommentIdsFromWakePayload(wake!.payload)).toEqual(expected);
      expect(retry.contextSnapshot?.recoveryActionId).toBe(action!.id);
      if (rejected) return;
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const prepared = await prepareHeartbeatSession(db, { run: retry, agent: agent!,
        task: { context: retry.contextSnapshot!, issueRef: issue, issueContext: null, taskProjectContext: null,
          workspaceProjectContext: null, wakeCommentId: String(retry.contextSnapshot!.wakeCommentId),
          acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null },
        session: { taskSession: null, taskSessionDecodedParams: null, explicitResumeSessionParams: null,
          explicitResumeSessionDisplayId: null, sessionCodec: getAdapterSessionCodec(agent!.adapterType) },
        config: { runtimeConfig: { provider: "pi_rpc", sessionContinuity: "continuous" }, agentIdentity: undefined,
          issueAssigneeOverrides: null, originalAiIssueOverrides: null, managedAiRuntime: undefined, aiBinding: undefined,
          requestedAiBinding: undefined, secretManifest: [], runtimeSkillEntries: [], routineEnvContext: { env: null } },
        workspace: { requestedExecutionWorkspaceMode: "shared_workspace", effectiveExecutionWorkspaceMode: "shared_workspace",
          projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, executionPolicy: {} as never,
          requestedReusableExecutionWorkspaceConfig: null, reusableExistingExecutionWorkspace: null },
        environment: { environmentResolution: { environmentId: null, source: "default" }, selectedEnvironmentId: null,
          selectedEnvironmentForConfig: null }, getLatestAgentConfigRevision: async () => ({
            id: agentId, changedKeys: [], createdAt: retry.createdAt }) });
      const handoff = await prepared.getFreshSessionHandoff!();
      const historyControl = await buildNativeSessionHandoff({ db, companyId, issueId: issue.id, agentId,
        before: retry.createdAt, throughCommentId: String(retry.contextSnapshot!.wakeCommentId) });
      expect(historyControl).toContain("Person input 0");
      const wakePayload = await buildPaperclipWakePayload({ db, companyId, agentId, runId: retry.id,
        contextSnapshot: retry.contextSnapshot! });
      const executionInput = buildNativeExecutionInput({ companyId, agentId, runId: retry.id, normalizedSessionId: null,
        provider: "pi_rpc", sessionContinuity: "continuous", issue, taskPrompt: "Continue", wakePayload,
        freshSessionHandoff: handoff, runtimeContext: nativeRuntimeContextFixture(),
        workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1",
          contract: { revision: "1", objective: "Answer", criteria: [{ id: "objective", requirement: "Answer" }] } } });
      const prompt = buildNativeModelEnvelope(executionInput).task.prompt;
      process.stdout.write(JSON.stringify({ proof: "retry-input-once", kind, messageId: ids[0],
        occurrences: prompt.split("Person input 0").length - 1 }) + "\n");
      expect(prompt.split("Person input 0").length - 1).toBe(1);
      expect(handoff ?? "").not.toContain("Person input 0");
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, agentId));
      const sessionId = randomUUID();
      await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issue.id,
        nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, retry.id));
      await db.update(issues).set({ executionRunId: retry.id }).where(eq(issues.id, issue.id));
      const event = { runId: retry.id, normalizedSessionId: sessionId, turnId: "retry-turn", itemId: "retry-final", sourceEventId: "retry-final",
        eventType: "item.completed" as const, payload: { kind: "agentMessage", channel: "final", text: "The recovered answer.", answers: [] } };
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: retry.id, seq: 1,
        eventType: event.eventType, payload: { prpEvent: event } });
      const publication = { db, cursor: 1, execution: { binding: { companyId, agentId, issueId: issue.id, runId: retry.id },
        provider: { kind: "pi_rpc" as const } }, event };
      await publishContinuousNativeReply(publication);
      await publishContinuousNativeReply(publication);
      expect((await readRun(retry.id)).resultJson?.continuousReplies).toMatchObject({
        "retry-final": { questionCommentIds: expected } });
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, retry.id))).toHaveLength(1);
      process.stdout.write(JSON.stringify({ proof: "retry-input-identity", kind, sourceRunId: source.id, retryRunId: retry.id,
        messageId: ids[0], expected, replies: (await readRun(retry.id)).resultJson?.continuousReplies }) + "\n");
    } finally { await heartbeat.drainActiveRunExecutions(); }
  }, 60_000);

  // The agent starts its queued recovery runs, which frees their turns in the queue.

});
