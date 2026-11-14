// Keep reason: real production re-wake loop; admission, durable lineage, and user-notice safety.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations,
  chatConversations, chatDeliveries, chatEndpoints, chatMessageLinks, toolApplications, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../__tests__/helpers/truncate-with-deadlock-retry.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { continueHeldExecutions, ensureFreshContinuation, freshContinuationChain, resetBacklogContinuationPacingForTests } from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { settleUnansweredPersonMessagesForTask } from "./recovery/unanswered-person-message.js";

import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "./principal-access-compatibility.js";
import { issueService } from "./issues.js";
import { buildHostServices } from "./plugin-host-services.js";
import { createPluginEventBus } from "./plugin-event-bus.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("fresh-continuation input origin", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
  const evidence: Record<string, unknown> = {};
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("rfl-fallbackcap-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Review user", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "RFL isolated PG acceptance", issuePrefix: "RFL", requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);
  afterEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await heartbeatService(db).drainActiveRunExecutions();
    await truncateTablesWithDeadlockRetry(db, "truncate table issue_recovery_actions, native_run_finalizations, tool_invocations, issue_approvals, approvals, issue_thread_interactions, activity_log, agent_wakeup_requests, environment_leases, execution_workspaces, heartbeat_runs, issues cascade");
    writeFileSync(`${process.env.TASK_OUT}/input-origin-observations.json`, JSON.stringify(evidence, null, 2));
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(chat = false) {
    const issueId = randomUUID(), runId = randomUUID();
    const stopped = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Real-shaped refused conversation", status: "blocked", assigneeAgentId: agentId,
      responsibleUserId: userId, statusVersion: 4, blockedTransitionAt: stopped,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", nativePhase: "terminal_failure", status: "failed", invocationSource: "assignment",
      errorCode: "native_session_interrupted", error: "temporary_runner_transport_unavailable", responsibleUserId: userId,
      startedAt: new Date(stopped.getTime() - 600_000), finishedAt: stopped, createdAt: new Date(stopped.getTime() - 660_000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Please help with this task.", createdAt: new Date(stopped.getTime() - 670_000) }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: message!.id } })
      .where(eq(heartbeatRuns.id, runId));
    await hold(runId, issueId, 4);
    return { issueId, runId, messageId: message!.id };
  }
  async function hold(runId: string, issueId: string, statusVersion: number) {
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active", ownerType: "board",
      returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${runId}`,
      nextAction: "Inspect the original failure and reconcile the previous execution before continuing.",
      evidence: { runId, nativeFailureBlock: { runId, statusVersion } } });
  }
  async function occupySlot() {
    const [task] = await db.insert(issues).values({ companyId, title: "Slot occupied by ordinary work", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: task!.id, status: "running", contextSnapshot: { issueId: task!.id } });
  }
  async function sweep() {
    await settleUnrecoverableExecutions(db);
    await continueHeldExecutions(db);
    await deliverReconciledExecutions(db, heartbeatService(db).wakeup);
  }
  async function children(runId: string) { return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId)); }
  async function fail(run: typeof heartbeatRuns.$inferSelect, error = "temporary_runner_transport_unavailable") {
    const [task] = await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null, blockedTransitionAt: new Date() })
      .where(eq(issues.id, run.issueId!)).returning();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: task!.id, nativePhase: "terminal_failure",
      startedAt: new Date(Date.now() - 5_000), finishedAt: new Date(), errorCode: "native_continuation_requires_reconciliation", error }).where(eq(heartbeatRuns.id, run.id));
    await hold(run.id, task!.id, Number(task!.statusVersion));
    // Match the real lifecycle's terminal wake receipt: failed runs do not retain a queued wake.
    if (run.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, run.wakeupRequestId));
  }
  async function noticeSweep(issueId: string) {
    return settleUnansweredPersonMessagesForTask(db, { companyId, issueId, now: new Date(Date.now() + 30_000) });
  }
  async function cappedChat() {
    const f = await seed(true);
    await occupySlot();
    await sweep();
    const first = (await children(f.runId))[0]!;
    expect(first).toBeDefined();
    await fail(first); await sweep();
    const second = (await children(first.id))[0]!;
    expect(second).toBeDefined();
    await fail(second); await sweep();
    expect(await children(second.id)).toHaveLength(0);
    return { ...f, first, second };
  }

  it.each(["board_key_run", "board_key_no_run", "session"] as const)("%s comment captures its actual input origin through the real route", async origin => {
    const f = await cappedChat();
    const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(child.status).toBe(0);
    await db.update(heartbeatRuns).set({ processPid: Number(child.stdout.trim()) }).where(eq(heartbeatRuns.id, f.second.id));
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" }).onConflictDoNothing();
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: userId, membershipRole: "operator", grantedByUserId: null });
    const [agentExecution] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
    const app = express(); app.use(express.json());
    // Begin AFTER authentication with precisely the board-key actor shape produced by auth.ts.
    // No credential creation, secret or live authentication is involved in this test.
    app.use((req, _res, next) => { req.actor = { type: "board", source: origin === "session" ? "session" : "board_key", userId, companyIds: [companyId], ...(origin === "board_key_run" ? { runId: agentExecution!.id } : {}) }; next(); });
    app.use("/api", issueRoutes(db, {} as import("../storage/types.js").StorageService)); app.use(errorHandler);
    const response = await request(app).post(`/api/issues/${f.issueId}/comments`).send({ body: "An agent using board attribution tries again", clientRequestId: randomUUID() });
    evidence[origin] = { status: response.status, comment: { id: response.body.id, authorType: response.body.authorType,
      authorUserId: response.body.authorUserId, createdByRunId: response.body.createdByRunId }, agentExecution: agentExecution!.id };
    expect(response.status).toBe(201);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId), eq(heartbeatRuns.status, "queued")));
    expect(runs).toHaveLength(1);
    const chain = await freshContinuationChain(db, { companyId, issueId: f.issueId, runId: runs[0]!.id });
    evidence[origin] = { ...(evidence[origin] as object), context: runs[0]!.contextSnapshot, chain };
    expect(chain).toEqual(origin === "session" ? { rootRunId: runs[0]!.id, attempts: 0 } : { rootRunId: f.runId, attempts: 2 });
    expect(runs[0]!.contextSnapshot?.previousRunId).toBe(f.second.id);
    if (origin === "board_key_run") expect(response.body.metadata?.inputOrigin).toEqual({ kind: "board_key", userId, sourceRunId: agentExecution!.id });
    if (origin === "session") {
      expect(response.body.metadata?.inputOrigin).toEqual({ kind: "human_session", userId });
      await fail(runs[0]!);
      expect(await ensureFreshContinuation(db, { companyId, runId: runs[0]!.id, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    }
  }, 60_000);

  async function stopProof(runId: string) {
    const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(child.status).toBe(0);
    await db.update(heartbeatRuns).set({ processPid: Number(child.stdout.trim()) }).where(eq(heartbeatRuns.id, runId));
  }

  it("automation cannot reset an exhausted person budget merely by naming an active human in plugin createComment", async () => {
    const f = await cappedChat();
    await stopProof(f.second.id);
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" }).onConflictDoNothing();
    const services = buildHostServices(db, randomUUID(), "rfl.automation", createPluginEventBus(), undefined, { heartbeatRuntimeEnv: {} });
    try {
      // No human event, login, UI callback or user-authorized input: the worker supplies only the member id.
      const comment = await services.issues.createComment({ companyId, issueId: f.issueId, body: "An automatic plugin decided to try again", actorUserId: userId });
      const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        sql`${agentWakeupRequests.payload}->>'commentId' = ${comment.id}`));
      expect(wake?.runId).toBeTruthy();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));
      const chain = await freshContinuationChain(db, { companyId, issueId: f.issueId, runId: run!.id });
      await fail(run!);
      const fallback = await ensureFreshContinuation(db, { companyId, runId: run!.id, trigger: "recovery_refused" });
      evidence.pluginHumanAttribution = { comment: { id: comment.id, authorType: comment.authorType, authorUserId: comment.authorUserId, createdByRunId: comment.createdByRunId },
        wake: { source: wake!.source, reason: wake!.reason, actorType: wake!.requestedByActorType, runId: wake!.runId }, context: run!.contextSnapshot, chain, fallback };
      expect(chain, "A plugin-supplied member id is not a new PERSON turn").toEqual({ rootRunId: f.runId, attempts: 2 });
      expect(fallback).toMatchObject({ kind: "not_applicable", reason: "fresh_continuation_chain_exhausted" });
    } finally { services.dispose(); }
  }, 60_000);

  it("a copied marker on a user-labelled automation wake does not override an agent-created comment", async () => {
    const f = await cappedChat();
    const id = randomUUID();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId,
      createdByRunId: f.runId, body: "automation posting through board attribution" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: userId, runId: id, status: "failed" }).returning();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId: f.issueId, status: "failed", retryOfRunId: f.second.id,
      wakeupRequestId: wake!.id, contextSnapshot: { issueId: f.issueId, previousRunId: f.second.id, wakeReason: "issue_commented", wakeCommentId: comment!.id,
        explicitUserContinuation: { previousRunId: f.second.id, commentId: comment!.id } } });
    const chain = await freshContinuationChain(db, { companyId, issueId: f.issueId, runId: id });
    evidence.copiedMarkerUserAutomation = chain;
    expect(chain).toEqual({ rootRunId: f.runId, attempts: 2 });
  }, 60_000);

  it.each([false, true])("a relay requires its server-recorded inbound input event (recorded: %s)", async recorded => {
    const f = await cappedChat();
    await stopProof(f.second.id);
    const [application] = await db.insert(toolApplications).values({ companyId, applicationKey: randomUUID(), name: `Relay ${randomUUID()}`, type: "chat", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Chat", uid: randomUUID(), connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId: connection!.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agentId, status: "active" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId, endpointId: endpoint!.id, issueId: f.issueId, externalConversationId: randomUUID(), externalLabel: "A saved human thread" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId, body: "A saved external human input" }).returning();
    const [delivery] = recorded ? await db.insert(chatDeliveries).values({ companyId, endpointId: endpoint!.id, conversationId: conversation!.id,
      providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "message", normalizedEvent: { senderUserId: userId, messageId: randomUUID() }, state: "processed" }).returning() : [];
    await db.insert(chatMessageLinks).values({ companyId, endpointId: endpoint!.id, conversationId: conversation!.id,
      ...(delivery ? { deliveryId: delivery.id } : {}), commentId: comment!.id, providerMessageId: randomUUID(), direction: "inbound" });
    const admitted = await heartbeatService(db).wakeup(agentId, { source: "automation", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: f.issueId, commentId: comment!.id },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: comment!.id } });
    expect(admitted).toBeTruthy();
    const chain = await freshContinuationChain(db, { companyId, issueId: f.issueId, runId: admitted!.id });
    expect(chain).toEqual(recorded ? { rootRunId: admitted!.id, attempts: 0 } : { rootRunId: f.runId, attempts: 2 });
    const [saved] = await db.select().from(issueComments).where(eq(issueComments.id, comment!.id));
    if (recorded) expect(saved!.metadata?.inputOrigin).toEqual({ kind: "human_relay", userId, admittedRunId: admitted!.id });
    evidence[`relay-${recorded}`] = { chain, origin: saved!.metadata?.inputOrigin };
  }, 60_000);

  it("caller-supplied input-origin metadata cannot create reset authority", async () => {
    const f = await seed(true);
    await expect(issueService(db).addComment(f.issueId, "A copied provenance marker", { userId }, {
      metadata: { version: 1, sections: [], inputOrigin: { kind: "human_session", userId } },
    })).rejects.toThrow("Comment input origin is server-owned");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
  });
});
