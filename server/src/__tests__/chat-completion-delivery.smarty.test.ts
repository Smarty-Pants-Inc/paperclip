const heldCompletion = vi.hoisted(() => ({ refused: false, sent: [] as string[] }));
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>(),
  getNativeSessionSteeringState: async () => ({ disposition: "available", activeTurnId: "held-turn" }),
  steerNativeSession: async (input: { correlationId: string }) => { if (heldCompletion.refused) throw new Error("steer refused"); heldCompletion.sent.push(input.correlationId); return { turnId: "held-turn" }; },
}));

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { drainContinuousPersonMessages } from "../services/native-runtime/native-continuous-drain.js";
import { agents, agentWakeupRequests, chatCompletionDeliveries as deliveries, authUsers, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

import { issueService } from "../services/issues.js";

import { instanceSettingsService } from "../services/instance-settings.js";
import { chatCompletionDeliveryService, deliverIntoLiveTurn, offerHeldChatCompletions, prepareChatCompletionTurn } from "../services/chat-completion-delivery.js";

import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";

import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { publishContinuousNativeReply } from "../services/native-runtime/native-continuous-reply.js";
import { prepareConversationTurn } from "../services/agent-conversations.js";
import type { NativeRestartRecoveryClaim } from "../services/native-runtime/native-restart-recovery.js";

(support.supported ? describe : describe.skip)("chat completion delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("chat-completion-"); db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });
  beforeEach(async () => { await db.update(deliveries).set({ status: "exhausted" }); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Completion", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: sourceId, companyId, title: "Chat", status: "in_progress", conversationAgentId: agentId,
      conversationUserId: "operator", conversationState: "waiting", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: sourceId, conversationSessionGeneration: 0 } });
    const create = () => issueService(db).create(companyId, { title: `Write note ${randomUUID()}`, status: "todo", createdByAgentId: agentId, actorRunId: runId });
    const task = await create();
    const finish = (taskId = task.id) => issueService(db).update(taskId, { status: "done" });
    const rows = () => db.select().from(deliveries).where(eq(deliveries.companyId, companyId)).orderBy(asc(deliveries.createdAt), asc(deliveries.id));
    const due = () => db.update(deliveries).set({ nextAttemptAt: new Date(0) }).where(eq(deliveries.companyId, companyId));
    const wakeup = vi.fn(async (_agentId: string, options: any) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", contextSnapshot: options.contextSnapshot }).returning();
      await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", status: "queued", idempotencyKey: options.idempotencyKey, runId: run.id });
      return run;
    });
    const service = chatCompletionDeliveryService(db, { wakeup } as any);
    const run = async () => {
      const [delivery] = await rows();
      await service.deliver(delivery.id);
      const [current] = await rows();
      const [r] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.targetRunId!));
      return prepareChatCompletionTurn(db, r);
    };
    return { companyId, agentId, sourceId, runId, task, create, finish, rows, due, wakeup, service, run };
  }
  // catch: a held completion report repeated after release
  it.each(["continuous", "legacy", "paperclip", "refused"])("reports a held completion once, without a hold-end successor (%s)", async mode => {
    const f = await seed(), sessionId = randomUUID(); heldCompletion.refused = mode === "refused";
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: mode === "paperclip" ? "paperclip" : "continuous" } }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ executionRunId: f.runId, conversationState: "active" }).where(eq(issues.id, f.sourceId));
    await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.sourceId, nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, f.runId));
    await f.finish(); const [delivery] = await f.rows();
    f.wakeup.mockImplementation(async (_agentId, options) => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        reason: "issue_execution_deferred", status: "deferred_issue_execution", idempotencyKey: options.idempotencyKey,
        payload: { ...options.payload, _paperclipWakeContext: options.contextSnapshot } });
      return null as never;
    });
    const report = `Finished: [${f.task.identifier}](/issues/${f.task.identifier}).`;
    const event = { eventType: "item.completed" as const, runId: f.runId, normalizedSessionId: sessionId,
      sourceEventId: "completion-final", itemId: "held:completion", payload: { kind: "agentMessage", channel: "final", text: report } };
    const publication = { db, cursor: 171, execution: { binding: { companyId: f.companyId, issueId: f.sourceId, runId: f.runId, agentId: f.agentId }, provider: { kind: "pi_rpc" as const } }, event };
    const unrelated = { ...event, sourceEventId: "person-final", itemId: "held:person", payload: { ...event.payload, text: "Your unrelated question is answered.", ...(mode === "legacy" ? {} : { answers: [] }) } };
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId, agentId: f.agentId, seq: 170, eventType: event.eventType, payload: { prpEvent: unrelated } });
    await publishContinuousNativeReply({ ...publication, event: unrelated, cursor: 170 });
    await f.service.deliver(delivery.id);
    await publishContinuousNativeReply({ ...publication, event: { ...unrelated, itemId: "held:another-person" } });
    if (mode === "paperclip") await issueService(db).addComment(f.sourceId, report, { agentId: f.agentId, runId: f.runId });
    else if (mode !== "legacy") {
      const answer = { ...publication, cursor: 172, event: { ...event, payload: { ...event.payload, answers: [delivery.id, "not-a-delivery"] } } };
      await publishContinuousNativeReply(answer); await publishContinuousNativeReply(answer);
    }
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: async () => "operator",
        getRoutineEnv: async () => ({ routineId: null, env: {}, responsibleUserId: null }), resolveSessionBeforeForWakeup: async () => sessionId }),
      recovery: { escalateStrandedAssignedIssue: vi.fn(), escalateStrandedRecoveryIssueInPlace: vi.fn() } as never,
    });
    const released = await release({ companyId: f.companyId, runId: f.runId, now: new Date(), suppressImmediateRecovery: true });
    if (released.outcome.kind === "promoted") {
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, released.outcome.run.id));
      await prepareChatCompletionTurn(db, successor);
      if (mode === "legacy") {
        await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.sourceId, nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, successor.id));
        await publishContinuousNativeReply({ ...publication, event: { ...event, runId: successor.id }, execution: { ...publication.execution, binding: { ...publication.execution.binding, runId: successor.id } } });
      } else await issueService(db).addComment(f.sourceId, report, { agentId: f.agentId, runId: successor.id }, { completionReply: true });
    }
    await f.due(); await f.service.sweepPending();
    const reports = (await db.select().from(issueComments).where(eq(issueComments.issueId, f.sourceId))).filter(c => c.body === report);
    console.info("held-completion-row", { mode, heldRunId: f.runId, sessionId, reportRunIds: reports.map(c => c.createdByRunId), outbox: await f.rows() });
    expect(reports.map(c => c.createdByRunId)).toEqual(mode === "continuous" ? [f.runId] : mode === "legacy" ? [expect.any(String)] : [f.runId, expect.any(String)]);
    if (mode === "legacy") {
      expect(reports[0].createdByRunId).not.toBe(f.runId);
      expect(await f.rows()).toMatchObject([{ status: "delivered", targetRunId: reports[0].createdByRunId, responseCommentId: reports[0].id, attempts: 0 }]);
    }
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    if (mode === "continuous") {
      expect(wake).toMatchObject({ status: "coalesced", runId: f.runId });
      expect(await f.rows()).toMatchObject([{ status: "delivered", targetRunId: f.runId, responseCommentId: reports[0].id, attempts: 0 }]);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toMatchObject([{ id: f.runId, nativeSessionId: sessionId }]);
    }
    heldCompletion.refused = false;
  });
  async function heldFixture() {
    const f = await seed(), sessionId = randomUUID();
    heldCompletion.refused = false; heldCompletion.sent = [];
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ executionRunId: f.runId, conversationState: "active" }).where(eq(issues.id, f.sourceId));
    await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.sourceId, nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, f.runId));
    f.wakeup.mockImplementation(async (_agentId, options) => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        reason: "issue_execution_deferred", status: "deferred_issue_execution", idempotencyKey: options.idempotencyKey,
        payload: { ...options.payload, _paperclipWakeContext: options.contextSnapshot } });
      return null as never;
    });
    const event = { eventType: "item.completed" as const, runId: f.runId, normalizedSessionId: sessionId,
      sourceEventId: "first-final-about-A", itemId: "first-final-about-A",
      payload: { kind: "agentMessage", channel: "final", text: "A is complete.", answers: [] as string[] } };
    const publication = { db, cursor: 171, execution: { binding: { companyId: f.companyId, issueId: f.sourceId,
      runId: f.runId, agentId: f.agentId }, provider: { kind: "pi_rpc" as const } }, event };
    return { ...f, publication };
  }
  // catch: an earlier frozen final incorrectly acknowledging a later completion report
  it.each(["answer", "stop"])("keeps B owed when B is steered after A's frozen final is persisted but before publication (%s)", async outcome => {
    const f = await heldFixture(), b = await f.create();
    await f.finish();
    const [a] = await f.rows();
    const [run] = await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.sourceId, conversationSessionGeneration: 0,
      wakeReason: "chat_task_completed", chatCompletionDeliveryIds: [a.id] } }).where(eq(heartbeatRuns.id, f.runId)).returning();
    await prepareChatCompletionTurn(db, run);
    f.publication.event.payload.answers = [a.id];
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId, agentId: f.agentId, seq: 171,
      eventType: "item.completed", payload: { prpEvent: f.publication.event } });
    await f.finish(b.id);
    const late = (await f.rows()).find(row => row.taskId === b.id)!;
    await f.service.deliver(late.id);
    expect((await f.rows()).find(row => row.id === late.id)).toMatchObject({ status: "queued", targetRunId: f.runId });
    await publishContinuousNativeReply(f.publication);
    const rows = await f.rows();
    console.info("frozen-first-final-row", { runId: f.runId, rows });
    expect(rows.find(row => row.id === a.id)).toMatchObject({ status: "delivered", responseCommentId: expect.any(String) });
    expect(rows.find(row => row.id === late.id)).toMatchObject({ status: "queued", targetRunId: f.runId, responseCommentId: null });
    // A replay cannot consume B either. B's own attributed final settles it.
    await publishContinuousNativeReply(f.publication);
    if (outcome === "stop") {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: { personStop: true } }).where(eq(heartbeatRuns.id, f.runId));
      await f.due(); await f.service.deliver(late.id);
      expect((await f.rows()).find(row => row.id === late.id)).toMatchObject({ status: "pending", attempts: 1, targetRunId: null, responseCommentId: null });
      const [retryWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `chat-completion:${late.id}:1`));
      expect(retryWake).toMatchObject({ status: "deferred_issue_execution" });
      console.info("unreported-B-survives-stop", { runId: f.runId, delivery: (await f.rows()).find(row => row.id === late.id), retryWakeId: retryWake.id });
      return;
    }
    await publishContinuousNativeReply({ ...f.publication, cursor: 172, event: { ...f.publication.event,
      itemId: "B-final", sourceEventId: "B-final", payload: { ...f.publication.event.payload, text: "B is complete.", answers: [late.id] } } });
    expect((await f.rows()).find(row => row.id === late.id)).toMatchObject({ status: "delivered", responseCommentId: expect.any(String) });
  });
  // catch: a completion report overtaking an older person message
  it.each(["release", "worker"])("keeps an older person wake ahead of a completion through the %s door", async door => {
    vi.stubEnv("PAPERCLIP_AGENT_CHAT_STEERING", "true");
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const f = await heldFixture();
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId, agentId: f.agentId, seq: 170,
      eventType: "item.completed", payload: { prpEvent: f.publication.event } });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.sourceId,
      authorType: "user", authorUserId: "operator", body: "Please answer me first." }).returning();
    const [person] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "issue", status: "deferred_issue_execution", reason: "issue_commented", requestedAt: new Date(Date.now() - 60_000),
      requestedByActorType: "user", requestedByActorId: "operator",
      payload: { issueId: f.sourceId, _paperclipWakeContext: { wakeCommentIds: [comment.id] } } }).returning();
    await f.finish(); await f.due(); const [delivery] = await f.rows();
    const key = `chat-completion:${delivery.id}:${delivery.attempts}`;
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "chat_task_completed", status: "deferred_issue_execution", idempotencyKey: key,
      payload: { issueId: f.sourceId, _paperclipWakeContext: { wakeReason: "chat_task_completed",
        conversationSessionGeneration: 0, chatCompletionDeliveryIds: [delivery.id] } } });
    const scope = { companyId: f.companyId, issueId: f.sourceId, agentId: f.agentId, runId: f.runId };
    const offer = () => door === "release" ? offerHeldChatCompletions(db, scope) : deliverIntoLiveTurn(db, delivery, key, f.runId);
    expect(await offer()).toBe(false);
    expect(await f.rows()).toMatchObject([{ status: "pending", targetRunId: null }]);
    const [first] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"))).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
    expect(first.id).toBe(person.id);
    console.info("person-before-report-row", { door, firstWakeId: first.id, delivery: (await f.rows())[0] });
    expect(heldCompletion.sent).toEqual([]);
    // Use the actual person-message drain and board ACK transaction, not a
    // hand-edited receipt. The provider sees the person before the report.
    await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
    expect(heldCompletion.sent).toEqual([comment.id]);
    const [personRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(personRun.resultJson?.queuedSteeringAcknowledgements).toMatchObject({ [comment.id]: { status: "acknowledged" } });
    expect(await offer()).toBe(true);
    expect(heldCompletion.sent).toEqual([comment.id, delivery.id]);
    expect(await f.rows()).toMatchObject([{ status: "queued", targetRunId: f.runId }]);
    console.info("person-first-provider-order", { door, runId: f.runId, sent: heldCompletion.sent });
  });
  async function frozenHeldCompletion() {
    const f = await seed();
    await f.finish();
    const prepared = await f.run(), sessionId = randomUUID();
    const execution = buildNativeExecutionInput({ companyId: f.companyId, agentId: f.agentId, runId: prepared.id,
      issue: { id: f.sourceId, title: "Held completion", description: null, identifier: null, workMode: "standard" },
      provider: "pi_rpc", taskPrompt: "Report the frozen completed task.", normalizedSessionId: sessionId,
      runtimeContext: nativeRuntimeContextFixture(),
      workspace: { id: prepared.id, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Reply", criteria: [{ id: "reply", requirement: "Report completed work" }] } } });
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } })
      .where(eq(agents.id, f.agentId));
    await db.update(issues).set({ conversationState: "active", executionRunId: prepared.id }).where(eq(issues.id, f.sourceId));
    await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.sourceId,
      nativeSessionId: sessionId, runnerInstanceId: randomUUID(), runnerProfileJson: { nativeExecutionInput: execution } })
      .where(eq(heartbeatRuns.id, prepared.id));
    const event = { eventType: "item.completed" as const, runId: prepared.id, normalizedSessionId: sessionId,
      sourceEventId: randomUUID(), itemId: "completion-final", payload: { kind: "agentMessage", channel: "final", text: "The delegated task is complete." } };
    expect(await publishContinuousNativeReply({ db, cursor: 1, execution, event })).toBe(true);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, prepared.id));
    expect(run).toMatchObject({ status: "running", finishedAt: null, resultJson: { continuousReplies: {
      "completion-final": { commentId: expect.any(String) } } } });
    expect(await f.rows()).toMatchObject([{ status: "delivered", targetRunId: run.id, responseCommentId: expect.any(String) }]);
    const claim = (kind: "reattach_remote_runner" | "reattach_existing_runner"): NativeRestartRecoveryClaim => ({
      kind, runId: run.id, leaseOwner: "server-restart-owner", controllerGeneration: 2, providerAttempt: 1,
      restartKind: "graceful", recoveryRequestId: null,
      ...(kind === "reattach_remote_runner" ? { remote: { providerLeaseId: "original-allocation", remoteCwd: "/workspace" } }
        : { process: { pid: 12345, processGroupId: null, startedAt: new Date().toISOString() } }),
    } as NativeRestartRecoveryClaim);
    return { ...f, run, claim, execution };
  }
  it.each([
    { kind: "reattach_remote_runner" as const, laterPending: false },
    { kind: "reattach_existing_runner" as const, laterPending: false },
    { kind: "reattach_remote_runner" as const, laterPending: true },
    { kind: "reattach_existing_runner" as const, laterPending: true },
  ])("reuses a held completion acknowledged by native-continuous-reply on same-run $kind (later pending: $laterPending)", async ({ kind, laterPending }) => {
      const f = await frozenHeldCompletion();
      // A later completion belongs to a new turn, never this reattachment.
      if (laterPending) { const later = await f.create(); await f.finish(later.id); }
      const before = await f.rows();
      const resumed = await prepareChatCompletionTurn(db, f.run, f.claim(kind));
      await prepareConversationTurn(db, resumed);
      expect(resumed).toEqual(f.run);
      expect(await f.rows()).toEqual(before);
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      expect(current).toMatchObject({ status: "running", error: null, finishedAt: null, runnerProfileJson: f.run.runnerProfileJson,
        resultJson: f.run.resultJson, contextSnapshot: { chatCompletionDeliveryIds: f.run.contextSnapshot!.chatCompletionDeliveryIds,
          chatCompletionUpdates: f.run.contextSnapshot!.chatCompletionUpdates } });
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.run.id))).toHaveLength(1);
    });
  it.each(["bootstrap", "no_claim", "other_run", "no_frozen_input", "foreign_binding", "no_updates", "context_claim"] as const)(
    "does not bypass a genuine completion freeze without admitted same-run recovery proof (%s)", async mode => {
      const f = await frozenHeldCompletion();
      let claim: NativeRestartRecoveryClaim | undefined = f.claim("reattach_remote_runner");
      const run = { ...f.run };
      if (mode === "bootstrap") claim = { ...claim, kind: "bootstrap_incomplete" };
      if (mode === "no_claim") claim = undefined;
      if (mode === "other_run") claim = { ...f.claim("reattach_remote_runner"), runId: randomUUID() };
      if (mode === "no_frozen_input") run.runnerProfileJson = {};
      if (mode === "foreign_binding") run.runnerProfileJson = { nativeExecutionInput: { ...f.execution,
        binding: { ...f.execution.binding, runId: randomUUID() } } };
      if (mode === "no_updates") run.contextSnapshot = { ...run.contextSnapshot, chatCompletionUpdates: [] };
      if (mode === "context_claim") { run.contextSnapshot = { ...run.contextSnapshot, nativeRestartRecovery: claim }; claim = undefined; }
      await expect(prepareChatCompletionTurn(db, run, claim)).rejects.toThrow("chat_completion_superseded");
      expect((await f.rows())[0].status).toBe("delivered");
    });
  it("still rejects a genuine bootstrap completion wake with no pending completion", async () => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: f.sourceId,
      contextSnapshot: { issueId: f.sourceId, wakeReason: "chat_task_completed", conversationSessionGeneration: 0 } }).returning();
    const claim: NativeRestartRecoveryClaim = { kind: "bootstrap_incomplete", runId: run.id,
      leaseOwner: "server-bootstrap-owner", controllerGeneration: 1, providerAttempt: 1,
      restartKind: "graceful", recoveryRequestId: null };
    await expect(prepareChatCompletionTurn(db, run, claim)).rejects.toThrow("chat_completion_superseded");
    expect(await f.rows()).toEqual([]);
  });
  it("still rejects a changed conversation generation after reusing admitted completion input", async () => {
    const f = await frozenHeldCompletion();
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.sourceId));
    const resumed = await prepareChatCompletionTurn(db, f.run, f.claim("reattach_remote_runner"));
    await expect(prepareConversationTurn(db, resumed)).rejects.toThrow("Conversation session changed");
  });
  /** The person's own message woke a turn that read the task done and linked it in its reply. */

});
