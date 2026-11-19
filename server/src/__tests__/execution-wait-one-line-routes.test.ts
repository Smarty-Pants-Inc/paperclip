import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, createDb, environmentLeases,
  heartbeatRuns, issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recordNativeLocalProcessStop } from "../services/native-local-process-stop.js";
import { writeDeferredExecutionWait } from "../services/deferred-execution-wait.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { environmentService } from "../services/environments.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_NO_RUN_TEXT } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// catch: SUPERSEDE-WAITNOTE-UPSTREAM-HEADER-1119, S10-1 / E3.04.
// Actions use the real comment, Stop and pause routes; admission, not a fixture,
// produces every wake / executionWait. The initial historical execution and
// environment are explicitly planted preconditions, never the observed outcome.
const support = await getEmbeddedPostgresTestSupport();
const samples: unknown[] = [];
// RFL 01:31Z / rf-5: literals deliberately independent of production constants.
const REMOTE_WORDS = "Your message is saved. The run you stopped is still shutting down, so your message hasn't started yet.";
const REMOTE_EXPIRED_WORDS = "Your message is saved, but the run you stopped still hasn't shut down, so it can't start yet. You can delete it if you no longer need it.";
const reasons = ["remote_cleanup", "execution_recovery", "execution_active", "agent.not_invokable"] as const;
const words: Record<typeof reasons[number], string> = {
  remote_cleanup: REMOTE_WORDS,
  execution_recovery: "Waiting for execution recovery. Your message is saved.",
  execution_active: "Waiting for the current run. Your message is saved.",
  "agent.not_invokable": "Agent is not invokable in its current state",
};

describe.skipIf(!support.supported)("SUPERSEDE-WAITNOTE-UPSTREAM-HEADER-1119 real routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("m10-one-line-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { vi.useRealTimers(); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => {
    if (process.env.M10_CAPTURE_DIR) {
      await mkdir(process.env.M10_CAPTURE_DIR, { recursive: true });
      await writeFile(path.join(process.env.M10_CAPTURE_DIR, "real-route-rows.json"), JSON.stringify(samples, null, 2) + "\n");
    }
    await db?.$client.end(); await database?.cleanup();
  });

  function api(companyId: string) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "session", userId: "m10-person",
      companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any, {})); app.use("/api", agentRoutes(db));
    app.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => { console.error("M10 unexpected route error", error); next(error); });
    app.use(errorHandler);
    return app;
  }

  async function plantedHistory(chat: boolean, legacy = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceId = randomUUID();
    // planted execution identity: a foreground child actually exits. No signal
    // is sent to an unowned process; the real stop-evidence producer observes it.
    const exited = spawnSync(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
    expect(exited.status).toBe(0);
    await db.insert(companies).values({ id: companyId, name: "M10 route fixture", issuePrefix: "WAIT", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "m10-person", status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "M10 saved input", status: "in_progress", assigneeAgentId: agentId,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: "m10-person", conversationState: "active" } : {}) });
    // planted: the prior execution has started, but owns no host process.
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: legacy ? "legacy" : "native", status: "running", startedAt: new Date(Date.now() - 60_000),
      processPid: exited.pid, processGroupId: exited.pid, processStartedAt: new Date(),
      contextSnapshot: { issueId }, ...(legacy ? { runnerProfileJson: { adapterDispatch: { adapterType: "pi_local" } } } : {}) });
    await db.update(issues).set({ executionRunId: sourceId }).where(eq(issues.id, issueId));
    if (!legacy) await db.insert(nativeRunFinalizations).values({ runId: sourceId, companyId, issueId, phase: "session_running" });
    // planted: the agent's other task occupies its only slot. No test dispatches
    // a provider or signals a process. The queued-run row below exercises the
    // real admission producer for this exact busy-agent shape.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    return { companyId, agentId, issueId, sourceId, legacy, chat, client: api(companyId) };
  }

  async function send(f: Awaited<ReturnType<typeof plantedHistory>>) {
    const sent = await request(f.client).post(`/api/issues/${f.issueId}/comments`).send({ body: "Use this new direction, please.", clientRequestId: randomUUID() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    let wake: typeof agentWakeupRequests.$inferSelect | undefined;
    await vi.waitFor(async () => {
      wake = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
        .find(row => JSON.stringify(row.payload).includes(sent.body.id));
      expect(wake).toBeTruthy();
    }, { timeout: 5_000, interval: 25 });
    return { message: sent.body, wake: wake! };
  }

  async function stop(f: Awaited<ReturnType<typeof plantedHistory>>) {
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceId));
    const response = await request(f.client).post(`/api/heartbeat-runs/${f.sourceId}/cancel`).send(f.legacy ? {} : { cancellationRequestId: randomUUID() });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    if (!f.legacy) expect(await db.transaction(tx => recordNativeLocalProcessStop(tx as unknown as typeof db, source!))).toBe(true);
    expect((await request(f.client).get(`/api/heartbeat-runs/${f.sourceId}`).expect(200)).body.status).toBe("cancelled");
  }

  async function recoverableSource(f: Awaited<ReturnType<typeof plantedHistory>>) {
    // The real recovery-action producer owns this gate; do not plant its row.
    const service = issueRecoveryActionService(db);
    const action = await service.upsertSourceScoped({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", fingerprint: f.sourceId,
      ownerType: "system", evidence: { runId: f.sourceId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } }, nextAction: "Waiting for stopped execution cleanup." });
    await service.resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: f.issueId, actionId: action.id,
      status: "resolved", outcome: "blocked" });
  }

  for (const chat of [false, true]) for (const reason of reasons) {
    it(`${chat ? "chat" : "task"}: ${reason}, real GET at +10s/+2m/+599999ms/+10m/+11m has one bounded wait and no no-run notice`, async () => {
      const f = await plantedHistory(chat, reason === "execution_recovery");
      await stop(f);
      if (reason === "remote_cleanup" || reason === "execution_recovery" || reason === "agent.not_invokable") {
        // planted: a remote environment which has not supplied a stop receipt.
        await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceId,
          provider: "daytona", providerLeaseId: `planted-${randomUUID()}`, status: "pending_cleanup", leasePolicy: "ephemeral" });
      }
      if (reason === "remote_cleanup" || reason === "execution_active" || reason === "agent.not_invokable") await recoverableSource(f);
      if (reason === "execution_active") {
        // planted: an earlier queued turn on this task, not carrying M. M's
        // admission must defer, rather than invent a run for the new input.
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
          runtimeMode: "native", status: "queued", contextSnapshot: { issueId: f.issueId } });
      }
      const issueBeforeSend = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
      let { message, wake } = await send(f);
      const issueAfterSend = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
      if (reason === "agent.not_invokable") {
        // Pause WHILE this real saved wake is waiting, then let its actual
        // admission producer persist the new gate on that same receipt.
        await request(f.client).post(`/api/agents/${f.agentId}/pause`).send({}).expect(200);
        const [paused] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        const gate = await evaluateAgentInvokabilityFromDb(db, paused);
        if (gate.invokable) throw new Error("Real pause did not close admission");
        // The production admission writer stores the actual gate's words;
        // neither the wait condition nor its text is a hand-written fixture.
        expect(await writeDeferredExecutionWait(db, { companyId: f.companyId, requestId: wake.id }, {
          reason: "agent.not_invokable", message: gate.message,
        })).toBe(true);
        wake = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0];
      }
      expect(wake.status).toBe("deferred_issue_execution");
      expect(wake.runId).toBeNull();
      expect(wake.payload?.executionWait).toMatchObject({ reason });
      const t0 = wake.requestedAt.getTime();
      vi.useFakeTimers({ toFake: ["Date"] });
      // Establish the sweep's durable bound at the same T0 as submission.
      await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(t0) });
      for (const elapsed of [10_000, 120_000, 599_999, 600_000, 660_000]) {
        vi.setSystemTime(t0 + elapsed);
        await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
        const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
        const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
        samples.push({ producer: reason === "agent.not_invokable" ? "POST /issues/:id/comments; POST /agents/:id/pause; evaluateAgentInvokabilityFromDb -> writeDeferredExecutionWait" : "POST /issues/:id/comments -> heartbeat enqueueWakeup", surface: chat ? "chat" : "task", reason,
          elapsed, readAt: new Date().toISOString(), expectedLine: reason === "remote_cleanup" && elapsed >= 600_000 ? REMOTE_EXPIRED_WORDS : words[reason],
          issueBeforeSend, issueAfterSend, messageId: message.id, queue, comments });
        expect.soft(queue.executionWait).toEqual({ reason, message: reason === "remote_cleanup" && elapsed >= 600_000 ? REMOTE_EXPIRED_WORDS : words[reason] });
        expect.soft(queue.entries.map((entry: any) => entry.comment.id)).toContain(message.id);
        expect.soft(comments.filter((row: any) => row.authorType === "system" && row.metadata?.recoveryResponsibility !== "system")).toEqual([]);
      }
    });
  }

  async function savedBehindCleanup(chat: boolean) {
    const f = await plantedHistory(chat);
    await stop(f);
    // planted missing remote provider response. Admission below, not this
    // precondition, produces the observed deferred receipt on each surface.
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceId,
      issueId: f.issueId, provider: "daytona", providerLeaseId: `planted-${randomUUID()}`,
      status: "pending_cleanup", leasePolicy: "ephemeral" }).returning();
    await recoverableSource(f);
    const issueBeforeSend = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
    const sent = await send(f);
    expect(sent.wake).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: { executionWait: { reason: "remote_cleanup" } } });
    const issueAfterSend = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
    return { ...f, ...sent, lease, issueBeforeSend, issueAfterSend };
  }

  async function finishCleanup(f: Awaited<ReturnType<typeof savedBehindCleanup>>) {
    // planted remote provider stop response; REAL receipt normalizer and lease
    // settlement producer persist it and notify deferred admission. No remote
    // provider or host process is contacted, and no lease outcome is hand-written.
    const receipt = remoteTerminationReceipt(f.lease, { providerLeaseId: f.lease.providerLeaseId, state: "destroyed" });
    expect(receipt).toBeTruthy();
    const released = await environmentService(db).releaseLease(f.lease.id, "released", {
      cleanupStatus: "success", remoteExecutionTermination: receipt,
    });
    expect(released?.cleanupStatus).toBe("success");
    const heartbeat = heartbeatService(db);
    const source = (await heartbeat.getRun(f.sourceId))!;
    // Actual cleanup-consumer producer, twice: the same saved input is adopted once.
    await heartbeat.resumeRemoteStopComments(source);
    await heartbeat.resumeRemoteStopComments(source);
  }

  async function readSaved(f: Awaited<ReturnType<typeof savedBehindCleanup>>, reason: string, elapsed: number) {
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
    const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
    const row = { producer: "POST comments -> admission; remoteTerminationReceipt -> environmentService.releaseLease -> heartbeatService.resumeRemoteStopComments",
      surface: f.chat ? "chat" : "task", reason, elapsed, readAt: new Date().toISOString(), messageId: f.message.id,
      issueBeforeSend: f.issueBeforeSend, issueAfterSend: f.issueAfterSend, queue, comments };
    expect(comments.filter((c: any) => c.authorType === "system" && c.metadata?.recoveryResponsibility !== "system")).toEqual([]);
    return row;
  }

  for (const chat of [false, true]) {
    it(`${chat ? "chat" : "task"}: cleanup inside bound retires the first line and admits M once`, async () => {
      const f = await savedBehindCleanup(chat);
      const t0 = f.wake.requestedAt.getTime(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t0 + 10_000);
      const before = await readSaved(f, "remote_cleanup", 10_000);
      expect(before.queue.executionWait).toEqual({ reason: "remote_cleanup", message: REMOTE_WORDS });
      samples.push({ ...before, expectedLine: REMOTE_WORDS });
      vi.setSystemTime(t0 + 120_000);
      await finishCleanup(f);
      const after = await readSaved(f, "cleanup_finished", 120_000);
      expect(after.queue.executionWait).toBeFalsy();
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter(run => JSON.stringify(run.contextSnapshot).includes(f.message.id));
      expect(runs).toHaveLength(1);
      const run = (await request(f.client).get(`/api/heartbeat-runs/${runs[0].id}`).expect(200)).body;
      expect(run.status).toBe("queued"); // Real admission, not a claim of provider execution.
      samples.push({ ...after, run, admittedRunCount: runs.length });
    });

    for (const deleteRoute of ["queued-panel", "comment"] as const) {
      it(`${chat ? "chat" : "task"}: at bound REAL ${deleteRoute} Delete removes M from queue and wake forever`, async () => {
        const f = await savedBehindCleanup(chat);
        const t0 = f.wake.requestedAt.getTime(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t0 + 600_000);
        const before = await readSaved(f, "remote_cleanup", 600_000);
        expect(before.queue.executionWait).toEqual({ reason: "remote_cleanup", message: REMOTE_EXPIRED_WORDS });
        const deletion = deleteRoute === "queued-panel"
          ? `/api/issues/${f.issueId}/queued-comments/${f.message.id}` : `/api/issues/${f.issueId}/comments/${f.message.id}`;
        const response = await request(f.client).delete(deletion).send(deleteRoute === "queued-panel"
          ? { queueId: before.queue.queueId, revision: before.queue.revision } : {});
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const after = await readSaved(f, "message_deleted", 600_000);
        expect(after.queue.entries).toEqual([]);
        expect(after.queue.executionWait).toBeFalsy();
        expect(after.comments.some((c: any) => c.id === f.message.id)).toBe(false);
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
        expect(wake.status).toBe("cancelled");
        expect(wake.runId).toBeNull();
        expect(JSON.stringify(wake.payload)).not.toContain(f.message.id);
        // There is NO wake input left for M, active or cancelled. Cleanup's
        // actual consumer must never resurrect the deleted message.
        expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
          sql`${agentWakeupRequests.status} in ('queued','deferred_issue_execution','claimed')`,
          sql`${agentWakeupRequests.payload}::text like ${`%${f.message.id}%`}`))).toEqual([]);
        vi.setSystemTime(t0 + 660_000); await finishCleanup(f);
        const later = await readSaved(f, "message_deleted", 660_000);
        expect(later.queue.entries).toEqual([]);
        expect(later.queue.executionWait).toBeFalsy();
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
          .filter(run => JSON.stringify(run.contextSnapshot).includes(f.message.id))).toEqual([]);
        samples.push({ ...after, deleteRoute, deletion, beforeQueue: before.queue, beforeComments: before.comments, laterQueue: later.queue,
          wakeStatus: wake.status, wakePayload: wake.payload, laterAdmittedRunCount: 0 });
      });
    }
  }

  it("deferral ends with no run: real cancellation producer cancels the wake, then the notice fires exactly once", async () => {
    const f = await plantedHistory(false, true); await stop(f);
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceId,
      provider: "daytona", providerLeaseId: `planted-${randomUUID()}`, status: "pending_cleanup", leasePolicy: "ephemeral" });
    const { message, wake } = await send(f);
    expect(wake.payload?.executionWait).toMatchObject({ reason: "execution_recovery" });
    const t0 = Date.now(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t0 + 660_000);
    await heartbeatService(db).cancelInvocationsForAgents([f.agentId], "M10 cancellation ends the saved wake");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("cancelled");
    for (let repeat = 0; repeat < 2; repeat++) {
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
      const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
      const notices = comments.filter((row: any) => row.authorType === "system" && row.metadata?.recoveryResponsibility !== "system");
      expect(notices.map((row: any) => row.body)).toEqual([UNANSWERED_MESSAGE_NO_RUN_TEXT]);
      samples.push({ producer: "heartbeatService.cancelInvocationsForAgents -> cancelPendingWakeupsForAgents", surface: "task", reason: "deferral_ended",
        messageId: message.id, elapsed: 660_000, repeat, comments });
    }
  });

  it.each([false, true])("queued run (chat=%s): real comment admission behind a planted busy agent exposes upstream's header, never a waiting/no-run note", async (chat) => {
    const f = await plantedHistory(chat);
    // The planted historical run has no message to answer. Its successful
    // precondition is not this row's outcome; the new run below is real admission.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.sourceId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.sourceId));
    const { message, wake } = await send(f);
    expect(wake.runId).toBeTruthy();
    const t0 = Date.now(); vi.useFakeTimers({ toFake: ["Date"] });
    await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(t0) });
    for (const elapsed of [10_000, 120_000, 600_000, 660_000]) {
      vi.setSystemTime(t0 + elapsed);
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
      const run = (await request(f.client).get(`/api/heartbeat-runs/${wake.runId}`).expect(200)).body;
      const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
      const comments = (await request(f.client).get(`/api/issues/${f.issueId}/comments`).expect(200)).body;
      samples.push({ producer: "POST /issues/:id/comments -> heartbeat enqueueWakeup", surface: chat ? "chat" : "task", reason: "queued_run", elapsed,
        readAt: new Date().toISOString(), messageId: message.id, run, queue, comments });
      expect(run.status).toBe("queued");
      expect.soft(comments.filter((row: any) => row.authorType === "system" && row.metadata?.recoveryResponsibility !== "system")).toEqual([]);
    }
  });
});
