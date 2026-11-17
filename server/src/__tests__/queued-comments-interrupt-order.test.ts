import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, companies, companyMemberships, createDb, environmentLeases, heartbeatRuns, issueComments, issues,
  issueRecoveryActions, nativeRunFinalizations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { providerResourceDispositionForTerminalRun } from "../services/runner-environment-lifecycle.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// S8 order (Paul note 6): after an Interrupt, a message the person wrote later
// never runs before the messages queued earlier; each is answered once.
describeEmbeddedPostgres("queued-comment Interrupt keeps the person's order", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-s8-order-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 30_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await tempDb?.cleanup(); });

  function app(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: "queue-owner", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  // A busy native chat turn with three messages queued behind it, one wake each.
  async function seedBusyChat() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Order", issuePrefix: "ORD", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat Runner", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, permissions: {},
      // Successors stay queued behind the occupying run; no provider launches.
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "queue-owner",
      status: "active", membershipRole: "operator" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment",
      triggerDetail: "order test", status: "running", runtimeMode: "native", startedAt: new Date(Date.now() - 600_000),
      createdAt: new Date(Date.now() - 600_000), contextSnapshot: { issueId }, nativeIssueId: issueId, responsibleUserId: "queue-owner",
      runnerProfileJson: { nativeResourceDisposition: "keep_running" } });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: "ORD-1", title: "Chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, executionRunId: runId,
      conversationAgentId: agentId, conversationUserId: "queue-owner", conversationState: "active" });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed" });
    const commentIds = [randomUUID(), randomUUID(), randomUUID()];
    const wakeIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of commentIds.entries()) {
      const at = new Date(Date.now() - 300_000 + index * 30_000);
      await db.insert(issueComments).values({ id, companyId, issueId, authorType: "user", authorUserId: "queue-owner",
        body: `M${index + 1}`, clientRequestId: randomUUID(), createdAt: at, updatedAt: at });
      await db.insert(agentWakeupRequests).values({ id: wakeIds[index], companyId, agentId, source: "on_demand",
        triggerDetail: "manual", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: "queue-owner", requestedAt: at,
        idempotencyKey: `conversation-comment:${id}`,
        payload: { issueId, commentId: id, _paperclipWakeContext: { issueId, commentId: id, wakeCommentId: id, wakeCommentIds: [id] } } });
    }
    return { companyId, agentId, issueId, runId, commentIds, wakeIds };
  }

  async function press(f: Awaited<ReturnType<typeof seedBusyChat>>, targetRunId = f.runId) {
    const client = app(f.companyId);
    const queue = await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries.map((entry: any) => entry.comment.body)).toEqual(["M1", "M2", "M3"]);
    const pressed = await request(client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: f.wakeIds[0], targetRunId, revision: queue.body.revision });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    await acknowledgeStop(f);
  }

  async function sendLater(f: Awaited<ReturnType<typeof seedBusyChat>>, body = "M4") {
    const id = randomUUID();
    await db.insert(issueComments).values({ id, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "queue-owner", body, clientRequestId: randomUUID() });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await deliverConversationComments(db, issue, heartbeatService(db).wakeup);
    const [wake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${id}`));
    return { id, wake };
  }

  const successors = async (f: { companyId: string; issueId: string; runId: string }) =>
    (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.id !== f.runId && run.contextSnapshot?.issueId === f.issueId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // U shape: the person's Stop of a warm box releases stop_and_retain,
  // never a keep_running handoff. The harness has no runner/provider, so it
  // writes the acknowledgement and pending release; only the bound provider
  // receipt below proves cleanup and permits admission.
  async function acknowledgeStop(f: { companyId: string; issueId: string; runId: string }) {
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stopped.status).toBe("cancelled");
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, resultJson: { ...stopped.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
        dispatched: true, intentAuditId: "s8", acknowledgementAuditId: "s8" } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(providerResourceDispositionForTerminalRun("keep_running", "cancelled", "cancelled")).toBe("stop_and_retain");
    await db.insert(environmentLeases).values({ id: randomUUID(), companyId: f.companyId, heartbeatRunId: f.runId,
      provider: "daytona", providerLeaseId: `s8-${f.runId}`, leasePolicy: "reuse_by_environment",
      status: "pending_cleanup", cleanupStatus: "pending", metadata: {} });
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
  }

  async function landStopReceipt(f: { runId: string }) {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease,
        { providerLeaseId: lease.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, lease.id));
  }

  async function finishTeardown(f: Awaited<ReturnType<typeof seedBusyChat>>, receipt = true) {
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, resultJson: { ...stopped.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
        dispatched: true, intentAuditId: "s8", acknowledgementAuditId: "s8" } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (receipt) await landStopReceipt(f);
  }

  it("answers M1, M2, M3, then the message written after the Interrupt, each once", async () => {
    const f = await seedBusyChat();
    await press(f);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stopped.status).toBe("cancelled");
    // The person writes M4 a few seconds after the press, while its teardown runs.
    const m4 = await sendLater(f);
    expect(m4.wake.status).toBe("deferred_issue_execution");
    expect(await successors(f)).toEqual([]);
    await finishTeardown(f, false);
    const service = heartbeatService(db);
    // A terminal coordinator and acknowledged Stop alone cannot admit a
    // successor on U: admission waits for this box's recorded stop receipt.
    await service.resumeQueuedCommentInterrupt(f.companyId, f.wakeIds[0]);
    expect(await successors(f)).toEqual([]);
    await landStopReceipt(f);
    await service.resumeQueuedCommentInterrupt(f.companyId, f.wakeIds[0]);
    const [first, ...early] = await successors(f);
    expect(early).toEqual([]);
    // The press sends everything that was waiting, in the order written.
    expect(first.contextSnapshot?.wakeCommentIds).toEqual(f.commentIds);
    await service.resumeQueuedCommentInterrupt(f.companyId, f.wakeIds[0]);
    expect(await successors(f)).toHaveLength(1);
    // The first successor ends: the release promotes M4, last and alone.
    await service.cancelRun(first.id);
    const runs = await successors(f);
    expect(runs).toHaveLength(2);
    expect(runs[1].contextSnapshot?.wakeCommentIds).toEqual([m4.id]);
    const answered = runs.flatMap(run => (run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []);
    expect(answered).toEqual([...f.commentIds, m4.id]);
    const deferred = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(deferred).toEqual([]);
  });

  it("admits a person's message at once when no Interrupt is pending", async () => {
    const f = await seedBusyChat();
    await heartbeatService(db).cancelRun(f.runId);
    await acknowledgeStop(f);
    await finishTeardown(f);
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.companyId, f.companyId));
    const m4 = await sendLater(f);
    expect(m4.wake.status).toBe("queued");
    expect((await successors(f)).map(run => run.contextSnapshot?.wakeCommentIds)).toEqual([[m4.id]]);
  });

  it("does not hold a later message behind a stale press", async () => {
    const f = await seedBusyChat();
    await press(f);
    await finishTeardown(f);
    // A later run on the issue ended: the press no longer targets the latest run.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      finishedAt: new Date(), contextSnapshot: { issueId: f.issueId } });
    const m4 = await sendLater(f);
    expect(m4.wake.status).toBe("queued");
  });

  it("does not hold a later message behind a press whose target was not stopped by it", async () => {
    const f = await seedBusyChat();
    await press(f);
    await finishTeardown(f);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ resultJson: { ...stopped.resultJson, queuedCommentInterruptQueueId: randomUUID() } })
      .where(eq(heartbeatRuns.id, f.runId));
    const m4 = await sendLater(f);
    expect(m4.wake.status).toBe("queued");
  });
});
