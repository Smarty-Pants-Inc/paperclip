import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, chatCompletionDeliveries as deliveries, companies, companyMemberships, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { chatCompletionDeliveryService } from "../services/chat-completion-delivery.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;

/**
 * Paul's V2 chat (2026-11-19, SMA-4). An automatic chat-completion-delivery
 * turn must never (A) show a failure, banner or recovery card when its
 * completion was already superseded, nor (B) start ahead of a message the
 * person is waiting on.
 */
describePostgres("automatic chat-completion turns on a person's chat", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const dispatched: Array<{ runId: string; context: Record<string, unknown> }> = [];
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;
  /** A turn on this chat blocks in the adapter until its gate resolves (a live turn). */
  const gates = new Map<string, Promise<void>>();

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("chat-completion-person-first-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    home = await mkdtemp(path.join(tmpdir(), "paperclip-chat-person-first-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        dispatched.push({ runId: input.runId, context: input.context as Record<string, unknown> });
        const gate = gates.get(String((input.context as Record<string, unknown>).issueId));
        if (gate) await gate;
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** A person's agent chat whose agent handed off one task. */
  async function seedChat() {
    const companyId = randomUUID(), agentId = randomUUID(), chatId = randomUUID(), userId = `person-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Paul", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Chat fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", adapterType, status: "idle", adapterConfig: {} });
    await db.insert(issues).values({ id: chatId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting", responsibleUserId: userId });
    // The earlier turn that created the delegated task (records the handoff).
    const [turn] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", invocationSource: "on_demand",
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 30_000),
      contextSnapshot: { issueId: chatId, conversationSessionGeneration: 0 } }).returning();
    const task = await issueService(db).create(companyId, { title: `Delegated ${randomUUID()}`, status: "todo",
      createdByAgentId: agentId, actorRunId: turn.id });
    return { companyId, agentId, chatId, userId, task };
  }
  const chatRuns = (f: { companyId: string; chatId: string }) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.chatId}`));
  const completionRuns = async (f: { companyId: string; chatId: string }) =>
    (await chatRuns(f)).filter(run => run.contextSnapshot?.wakeReason === "chat_task_completed");
  async function settle(f: { companyId: string }) {
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
  }
  async function presentation(f: { companyId: string; chatId: string }) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.chatId));
    return (await taskInterruptionPresentations(db, f.companyId, [issue])).get(f.chatId) ?? null;
  }
  /** A person's message held on the chat behind a turn, as the comment route saves it. */
  async function holdPersonMessage(f: { companyId: string; agentId: string; chatId: string; userId: string }) {
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chatId,
      authorUserId: f.userId, body: "MSG 1: please answer this first." }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: f.userId,
      payload: { issueId: f.chatId, commentId: comment.id, mutation: "comment",
        executionWait: { reason: "active_run", message: "Your message is saved." },
        _paperclipWakeContext: { issueId: f.chatId, taskId: f.chatId, commentId: comment.id, wakeCommentId: comment.id,
          wakeCommentIds: [comment.id], wakeReason: "issue_commented", source: "issue.comment" } },
    }).returning();
    return { commentId: comment.id, wakeId: wake.id };
  }

  it("A1: a superseded completion turn ends as a no-op: no failed run, banner or recovery card", async () => {
    const f = await seedChat();
    // The person started a new session: the completion's generation is stale.
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.chatId));
    const deliveryId = randomUUID();
    await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "chat_task_completed", allowRunCoalescing: false,
      idempotencyKey: `chat-completion:${deliveryId}:0`, requestedByActorType: "system", requestedByActorId: "chat_completion_delivery",
      payload: { issueId: f.chatId, chatCompletionDeliveryIds: [deliveryId] },
      contextSnapshot: { issueId: f.chatId, taskId: f.chatId, wakeReason: "chat_task_completed",
        chatCompletionDeliveryIds: [deliveryId], conversationSessionGeneration: 0 },
    });
    await settle(f);
    const [run] = await completionRuns(f);
    expect(run).toBeDefined();
    expect(dispatched.filter(turn => turn.runId === run.id)).toEqual([]);
    expect(run.status).not.toBe("failed");
    expect(run.errorCode).not.toBe("setup_failed");
    expect(["succeeded", "cancelled"]).toContain(run.status);
    const shown = await presentation(f);
    expect(shown?.state ?? "resolved").not.toBe("failed");
    expect(shown?.canRetry ?? false).toBe(false);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.chatId))).toEqual([]);
  }, 180_000);

  it("A control: a real setup failure on the chat still shows as a failed attempt", async () => {
    const f = await seedChat();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
      invocationSource: "on_demand", errorCode: "setup_failed", error: "Workspace preparation failed",
      startedAt: new Date(Date.now() - 2_000), finishedAt: new Date(Date.now() - 1_000),
      contextSnapshot: { issueId: f.chatId, conversationSessionGeneration: 0 } });
    const shown = await presentation(f);
    expect(shown).toMatchObject({ state: "failed", canRetry: true });
  }, 60_000);

  it("B1: a completion turn never starts ahead of the person's waiting message", async () => {
    const f = await seedChat();
    const held = await holdPersonMessage(f);
    await issueService(db).update(f.task.id, { status: "done" });
    const [delivery] = await db.select().from(deliveries).where(eq(deliveries.companyId, f.companyId));
    expect(delivery).toMatchObject({ status: "pending" });
    await chatCompletionDeliveryService(db, heartbeat).deliver(delivery.id);
    await heartbeat.drainActiveRunExecutions();
    // The automation did not start (or queue) ahead of the person's message.
    expect(await completionRuns(f)).toEqual([]);
    expect(dispatched.filter(turn => turn.context.issueId === f.chatId && turn.context.wakeReason === "chat_task_completed")).toEqual([]);
    // The completion is still owed, not burned: it retries after the person's turn.
    expect((await db.select().from(deliveries).where(eq(deliveries.id, delivery.id)))[0])
      .toMatchObject({ status: "pending", attempts: 0, targetRunId: null });
    // Once the person's message was taken, the completion is delivered.
    await db.update(agentWakeupRequests).set({ status: "coalesced", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, held.wakeId));
    await db.update(deliveries).set({ nextAttemptAt: new Date(0) }).where(eq(deliveries.id, delivery.id));
    await chatCompletionDeliveryService(db, heartbeat).deliver(delivery.id);
    await heartbeat.drainActiveRunExecutions();
    expect(await completionRuns(f)).toHaveLength(1);
  }, 180_000);

  it("B control: a held receipt whose message a turn already took does not hold the completion", async () => {
    const f = await seedChat();
    const held = await holdPersonMessage(f);
    // The person's turn took that message as its wake comment and succeeded.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded", invocationSource: "on_demand",
      startedAt: new Date(Date.now() + 1_000), finishedAt: new Date(Date.now() + 2_000),
      contextSnapshot: { issueId: f.chatId, wakeCommentIds: [held.commentId], conversationSessionGeneration: 0 } });
    await issueService(db).update(f.task.id, { status: "done" });
    const [delivery] = await db.select().from(deliveries).where(eq(deliveries.companyId, f.companyId));
    await chatCompletionDeliveryService(db, heartbeat).deliver(delivery.id);
    await heartbeat.drainActiveRunExecutions();
    expect(await completionRuns(f)).toHaveLength(1);
  }, 180_000);

  it("B control: a completion with no person message waiting still runs", async () => {
    const f = await seedChat();
    await issueService(db).update(f.task.id, { status: "done" });
    const [delivery] = await db.select().from(deliveries).where(eq(deliveries.companyId, f.companyId));
    await chatCompletionDeliveryService(db, heartbeat).deliver(delivery.id);
    await heartbeat.drainActiveRunExecutions();
    const runs = await completionRuns(f);
    expect(runs).toHaveLength(1);
    expect(dispatched.filter(turn => turn.runId === runs[0].id)).toHaveLength(1);
  }, 180_000);

  it("GAP1: on a chat, the person's deferred wake is promoted before an automation wake queued EARLIER", async () => {
    const f = await seedChat();
    let release!: () => void;
    gates.set(f.chatId, new Promise<void>(resolve => { release = resolve; }));
    // A live turn on the chat (the person's earlier message), running in the adapter.
    await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: f.userId,
      payload: { issueId: f.chatId }, contextSnapshot: { issueId: f.chatId, taskId: f.chatId, wakeReason: "issue_commented" } });
    const live = await (async () => { for (let i = 0; i < 400; i += 1) {
      const [run] = (await chatRuns(f)).filter(r => r.status === "running");
      if (run && dispatched.some(d => d.runId === run.id)) return run;
      await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error("no live turn"); })();
    // An automation (completion) wake deferred behind it FIRST, then the person's message.
    const deliveryId = randomUUID();
    const [automation] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "chat_task_completed", status: "deferred_issue_execution",
      requestedByActorType: "system", requestedByActorId: "chat_completion_delivery", requestedAt: new Date(Date.now() - 10_000),
      payload: { issueId: f.chatId, chatCompletionDeliveryIds: [deliveryId],
        _paperclipWakeContext: { issueId: f.chatId, taskId: f.chatId, wakeReason: "chat_task_completed",
          chatCompletionDeliveryIds: [deliveryId], conversationSessionGeneration: 0 } } }).returning();
    const held = await holdPersonMessage(f);
    gates.delete(f.chatId);
    release();
    await heartbeat.drainActiveRunExecutions();
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const runs = (await chatRuns(f)).filter(run => run.id !== live.id && run.createdAt >= live.createdAt).sort((a, b) => +a.createdAt - +b.createdAt);
    const snapshot = { live: live.id, wakes: wakes.map(w => ({ id: w.id, reason: w.reason, status: w.status, runId: w.runId })),
      runs: runs.map(r => ({ id: r.id, status: r.status, reason: r.contextSnapshot?.wakeReason, ids: r.contextSnapshot?.wakeCommentIds })) };
    expect(runs.length, JSON.stringify(snapshot)).toBeGreaterThan(0);
    expect(runs[0]!.contextSnapshot?.wakeCommentIds, `the person's message runs first: ${JSON.stringify(snapshot)}`).toEqual([held.commentId]);
    expect(wakes.find(w => w.id === automation.id)?.runId ?? null, JSON.stringify(snapshot)).not.toBe(runs[0]!.id);
  }, 180_000);
});
